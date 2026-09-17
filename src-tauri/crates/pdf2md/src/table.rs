//! Table reconstruction.
//!
//! Ruled/booktabs tables: horizontal rules give row boundaries; column
//! boundaries come from word x-positions that repeat across rows (works for
//! both full grids and academic three-rule tables).

use crate::content::Rule;
use crate::geom::Rect;
use crate::layout::Line;

pub struct Table {
    pub bbox: Rect,
    /// Rows of cells; first row is the header.
    pub rows: Vec<Vec<String>>,
}

/// Detects a table: ≥2 horizontal rules delimiting ≥2 text rows with ≥2
/// columns of repeating x-positions. Returns the table and the rules it claims.
pub fn detect(lines: &[Line], rules: &[&Rule], body_size: f64) -> Option<(Table, Vec<usize>)> {
    let mut hrules: Vec<usize> = rules
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            let rr = r.rect;
            rr.height() <= 2.5 && rr.width() > body_size * 4.0
        })
        .map(|(i, _)| i)
        .collect();
    if hrules.len() < 2 {
        return None;
    }
    hrules.sort_by(|&a, &b| rules[a].rect.y0.partial_cmp(&rules[b].rect.y0).unwrap());

    // Try each pair of consecutive rule groups (rules at nearly same y merge)
    let mut rule_ys: Vec<(f64, Vec<usize>)> = Vec::new();
    for &ri in &hrules {
        let y = (rules[ri].rect.y0 + rules[ri].rect.y1) / 2.0;
        match rule_ys.last_mut() {
            Some((gy, v)) if (*gy - y).abs() < 3.0 => v.push(ri),
            _ => rule_ys.push((y, vec![ri])),
        }
    }
    if rule_ys.len() < 2 {
        return None;
    }

    for start in 0..rule_ys.len() - 1 {
        for end in ((start + 1)..rule_ys.len()).rev() {
            let top = rule_ys[start].0;
            let bottom = rule_ys[end].0;
            if bottom - top < body_size * 1.8 {
                continue;
            }
            let claimed: Vec<usize> =
                rule_ys[start..=end].iter().flat_map(|(_, v)| v.clone()).collect();
            if let Some(t) = build_table(lines, rules, top, bottom, body_size) {
                return Some((t, claimed));
            }
        }
    }
    None
}

fn build_table(
    lines: &[Line],
    rules: &[&Rule],
    top: f64,
    bottom: f64,
    body_size: f64,
) -> Option<Table> {

    // lines inside the band
    let inner: Vec<&Line> = lines
        .iter()
        .filter(|l| l.baseline > top - body_size * 0.2 && l.baseline < bottom + body_size * 0.1)
        .collect();
    if inner.len() < 2 {
        return None;
    }
    let x0 = inner.iter().map(|l| l.x0).fold(f64::MAX, f64::min);
    let x1 = inner.iter().map(|l| l.x1).fold(f64::MIN, f64::max);

    // group inner lines into rows separated by rules strictly inside the band
    let mut inner_rules: Vec<f64> = rules
        .iter()
        .map(|r| (r.rect.y0 + r.rect.y1) / 2.0)
        .filter(|&y| y > top + 2.0 && y < bottom - 2.0)
        .collect();
    inner_rules.sort_by(|a, b| a.partial_cmp(b).unwrap());
    inner_rules.dedup_by(|a, b| (*a - *b).abs() < 3.0);

    // Build rows: group lines between boundaries
    let mut boundaries: Vec<f64> = vec![top - body_size];
    boundaries.extend(inner_rules.iter());
    boundaries.push(bottom + body_size);

    struct Row<'a> {
        lines: Vec<&'a Line>,
    }
    let mut rows: Vec<Row<'_>> = Vec::new();
    for w in boundaries.windows(2) {
        let (a, b) = (w[0], w[1]);
        let row_lines: Vec<&Line> = inner
            .iter()
            .cloned()
            .filter(|l| l.baseline > a && l.baseline < b)
            .collect();
        if !row_lines.is_empty() {
            rows.push(Row { lines: row_lines });
        }
    }
    if rows.len() < 2 {
        return None;
    }

    // Columns: cluster x0 positions across rows (tolerance ~ 5pt)
    let mut xstarts: Vec<f64> = Vec::new();
    for r in &rows {
        for l in &r.lines {
            for w in &l.words {
                xstarts.push(w.x0);
            }
        }
    }
    xstarts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut col_x: Vec<f64> = Vec::new();
    for &x in &xstarts {
        match col_x.last() {
            Some(&c) if (c - x).abs() < 6.0 => {}
            _ => col_x.push(x),
        }
    }
    // merge clusters that are closer than 12pt after initial pass
    let mut merged_cols: Vec<f64> = Vec::new();
    for &c in &col_x {
        match merged_cols.last() {
            Some(&m) if (c - m).abs() < 14.0 => {}
            _ => merged_cols.push(c),
        }
    }
    if merged_cols.len() < 2 {
        return None;
    }

    // Assign words to columns
    let table_rows: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            let mut cells: Vec<Vec<&str>> = vec![Vec::new(); merged_cols.len()];
            // per line assign, joining multi-line cells with space
            for l in &r.lines {
                for w in &l.words {
                    // nearest column whose x <= word.x0 + 6
                    let ci = merged_cols
                        .iter()
                        .enumerate()
                        .filter(|(_, &cx)| cx <= w.x0 + 6.0)
                        .map(|(i, _)| i)
                        .last()
                        .unwrap_or(0);
                    cells[ci].push(&w.text);
                }
            }
            cells
                .into_iter()
                .map(|parts| parts.join("").trim().to_string())
                .collect()
        })
        .collect();

    // drop tables where most cells are empty
    let filled = table_rows.iter().flatten().filter(|c| !c.is_empty()).count();
    let total = table_rows.len() * merged_cols.len();
    if filled * 2 < total {
        return None;
    }

    let bbox = Rect { x0, y0: top - body_size * 0.5, x1, y1: bottom + body_size * 0.5 };
    Some(Table { bbox, rows: table_rows })
}

/// Escapes pipe characters for GFM cells.
pub fn cell_to_md(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}
