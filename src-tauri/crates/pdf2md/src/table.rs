//! Table reconstruction.
//!
//! Model: a table is a RULED BAND whose interior is a GRID of cells.
//!
//! - The vertical extent comes from the horizontal rules (row borders) and,
//!   when the table draws cell borders, from the vertical rule segments — each
//!   segment spans exactly one row, so its endpoints are row boundaries too.
//! - Inside a band bounded by row borders on both sides, every baseline group
//!   is one row (a booktabs table has no rules between its data rows: the line
//!   grid is the row grid). A row holding a single cell is a WRAPPED CELL of
//!   its neighbour rather than a row of its own.
//! - Columns are the band's vertical GUTTERS: an x-interval every row is free
//!   of text in. A header cell may span several columns and cover one gutter,
//!   and a cell whose content is centered may spill into it, so a few blocking
//!   rows are tolerated; the boundary itself is pinned to the widest stretch
//!   no row splits a word space on, and never lands on the wrong side of a
//!   column's text. A paragraph that happens to sit between two rules has no
//!   such gutter — every line runs the full measure — so it is not a table and
//!   stays plain text.
//! - Cell text is rebuilt from the GLYPHS behind each cell's words, through the
//!   same pipeline the body text uses: the word layer keeps only flat strings,
//!   so scripts ("2.3·10^19", "O(n²·d)") were flattened to "1019", "O(n2·d)".
//!
//! That last point is what keeps the two producers apart: `structure` renders
//! a table block for regions that pass this test and drops the lines inside
//! `Table::bbox` from the flow, so a region is either a table or text, never
//! both.

use crate::content::{Glyph, PageItems, Rule};
use crate::geom::Rect;
use crate::layout::Line;

pub struct Table {
    pub bbox: Rect,
    /// Rows of cells; first row is the header.
    pub rows: Vec<Vec<Cell>>,
}

/// Minimum gutter width as a multiple of the body size: narrower than this and
/// the "gap" is an inter-word space, not a column separator.
const GUTTER_MIN_BODY: f64 = 1.0;
/// y values closer than this are the same border (all borders are strokes).
const Y_MERGE: f64 = 3.0;

struct Row<'a> {
    lines: Vec<&'a Line>,
}

/// A word placed in a cell, with the geometry the cell's text needs.
struct Piece {
    text: String,
    x0: f64,
    x1: f64,
    top: f64,
    bottom: f64,
    size: f64,
    /// Baseline of the line the word came from: the cell's words are grouped
    /// into visual lines by it.
    baseline: f64,
    /// Whether the word's source line is TeX-set math (feeds the glyph
    /// renderer's text/math split).
    is_math: bool,
}

/// One cell: its words, plus the glyph-level rendering behind them.
#[derive(Default)]
pub struct Cell {
    parts: Vec<Piece>,
}

impl Cell {
    fn is_empty(&self) -> bool {
        self.parts.iter().all(|p| p.text.trim().is_empty())
    }

    /// Joins the cell's words in reading order (the flat word-layer text: what
    /// `md` renders from the glyphs, minus the glyph-level facts).
    pub fn plain(&self) -> String {
        let mut out = String::new();
        let mut prev: Option<&Piece> = None;
        for p in &self.parts {
            if p.text.trim().is_empty() {
                continue;
            }
            if let Some(pv) = prev {
                let same_line = (pv.top - p.top).abs() < 0.6 && p.x0 >= pv.x0;
                let gap = p.x0 - pv.x1;
                if !same_line || gap > (p.size * 0.22).max(1.2) {
                    out.push(' ');
                }
            }
            out.push_str(&p.text);
            prev = Some(p);
        }
        out.trim().to_string()
    }

    /// Renders the cell as markdown through the document's glyph pipeline.
    ///
    /// Cell text taken from the WORD layer loses every glyph-level fact: the
    /// exponent of "2.3·10^19" (raised 7pt TeX glyphs) flattened to "1019"
    /// ("1018", "1020" …), `O(n²·d)` to "O(n2·d)", and a raised script sorted
    /// before its base ("6 ×10" for ×10⁶). Rebuilding the run from the glyphs
    /// behind the cell's words — the pipeline the body text uses — keeps
    /// scripts, math symbols and the extractor's own spacing.
    pub fn md(&self, items: &PageItems, page_rules: &[&Rule], warnings: &mut Vec<String>) -> String {
        let mut out = String::new();
        for line in self.visual_lines() {
            let glyphs = glyphs_of(&line, items);
            let text = if is_tex_run(&glyphs, items) && has_script(&glyphs) {
                crate::structure::line_text_md_glyphs(
                    &glyphs,
                    items,
                    page_rules,
                    warnings,
                    &[],
                    true,
                    &[],
                )
            } else {
                // A run that is not TeX-set is plain text: rendering it through
                // the math split would cut it into `$…$` fragments around every
                // symbol ("2110 $\pm$ 50" for the GAN table's 2110±50).
                plain_line(&line)
            };
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(text);
        }
        out
    }

    /// The cell's words grouped into visual lines.
    ///
    /// One group per source line (a word carries its line's baseline), then
    /// groups that sit SIDE BY SIDE on one visual line merge: a raised script
    /// is its own layout line, right after its base in x, while the lines of a
    /// wrapped cell stack on the same x and stay apart.
    fn visual_lines(&self) -> Vec<Vec<&Piece>> {
        let mut parts: Vec<&Piece> = self.parts.iter().filter(|p| !p.text.trim().is_empty()).collect();
        parts.sort_by(|a, b| a.baseline.partial_cmp(&b.baseline).unwrap());
        let mut groups: Vec<Vec<&Piece>> = Vec::new();
        for p in parts {
            match groups.last_mut() {
                Some(g) if (g[0].baseline - p.baseline).abs() < 0.6 => g.push(p),
                _ => groups.push(vec![p]),
            }
        }
        let mut merged: Vec<Vec<&Piece>> = Vec::new();
        for g in groups {
            match merged.iter_mut().find(|m| side_by_side(m, &g)) {
                Some(m) => m.extend(g),
                None => merged.push(g),
            }
        }
        for m in merged.iter_mut() {
            m.sort_by(|a, b| a.x0.partial_cmp(&b.x0).unwrap());
        }
        merged.sort_by(|a, b| {
            let ta = a.iter().map(|p| p.top).fold(f64::MAX, f64::min);
            let tb = b.iter().map(|p| p.top).fold(f64::MAX, f64::min);
            ta.partial_cmp(&tb).unwrap()
        });
        merged
    }
}

/// True when the run is TeX-set: every glyph comes from a TeX font (cmr, cmmi,
/// cmsy, cmex). A run mixing text-font glyphs is prose with symbols in it and
/// keeps the word-layer text (`2110±50` must not become `2110 $\pm$ 50`).
fn is_tex_run(glyphs: &[&Glyph], items: &PageItems) -> bool {
    !glyphs.is_empty()
        && glyphs.iter().all(|g| {
            g.text.trim().is_empty()
                || items
                    .fonts
                    .get(g.font)
                    .map(|f| f.tex != crate::font::TexKind::None)
                    .unwrap_or(false)
        })
}

/// True when the run carries a SCRIPT — a piece set at a smaller size than the
/// run's body (the exponent of 10^19, the `n^{2}` of `O(n²·d)`, `d_{model}`).
/// That is exactly the glyph-level fact the word layer flattens, so only such a
/// cell is rebuilt from glyphs; a plain cell keeps the word-layer text.
fn has_script(glyphs: &[&Glyph]) -> bool {
    let body = glyphs.iter().map(|g| g.size).fold(0.0f64, f64::max);
    body > 0.1 && glyphs.iter().any(|g| g.size < body * 0.85)
}

/// Joins one visual line's words by the glyph gaps: a space where the gap says
/// one, so a token the extractor split stays glued.
fn plain_line(line: &[&Piece]) -> String {
    let mut out = String::new();
    let mut prev: Option<&Piece> = None;
    for p in line {
        if p.text.trim().is_empty() {
            continue;
        }
        if let Some(pv) = prev {
            let gap = p.x0 - pv.x1;
            if (pv.baseline - p.baseline).abs() >= 0.6 || gap > (p.size * 0.22).max(1.2) {
                out.push(' ');
            }
        }
        out.push_str(&p.text);
        prev = Some(p);
    }
    out
}

/// Two runs sit side by side on one visual line when they leave each other's x
/// alone (they partition the line) and share the line's vertical band.
fn side_by_side(a: &[&Piece], b: &[&Piece]) -> bool {
    let ax = (a.iter().map(|p| p.x0).fold(f64::MAX, f64::min), a.iter().map(|p| p.x1).fold(f64::MIN, f64::max));
    let bx = (b.iter().map(|p| p.x0).fold(f64::MAX, f64::min), b.iter().map(|p| p.x1).fold(f64::MIN, f64::max));
    if ax.0 < bx.1 && bx.0 < ax.1 {
        return false;
    }
    a.iter().any(|p| b.iter().any(|q| spans_overlap(p, q)))
}

fn spans_overlap(a: &Piece, b: &Piece) -> bool {
    a.bottom > b.top && b.bottom > a.top
}

/// The glyphs behind a cell line: every glyph belonging to one of the line's
/// words — its x-extent and its baseline. A word's box holds exactly its own
/// glyphs (baseline + x extent), so a tight row pitch cannot pull in the line
/// below, and a raised script stays with the word it is set in.
fn glyphs_of<'a>(line: &[&Piece], items: &'a PageItems) -> Vec<&'a Glyph> {
    let mut gs: Vec<&Glyph> = items
        .glyphs
        .iter()
        .filter(|g| {
            line.iter().any(|p| {
                g.x >= p.x0 - 0.1 && g.x <= p.x1 + 0.1 && g.y >= p.top - 0.1 && g.y <= p.bottom + 0.1
            })
        })
        .collect();
    gs.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap().then(a.y.partial_cmp(&b.y).unwrap()));
    gs
}

/// Detects a table: a band between horizontal rules whose text forms a grid.
/// Returns the table and the rules it claims.
///
/// Candidate bands are tried widest first (a table is usually the largest
/// ruled region on the page) and each one must pass the grid test: the widest
/// band that does is the table. A ruled band holding text but no grid — a
/// paragraph between a heading rule and a footnote rule, an algorithm listing
/// — is not a table and stays plain text.
pub fn detect(lines: &[Line], rules: &[&Rule], body: f64) -> Option<(Table, Vec<usize>)> {
    // A table rule lives in the whitespace BETWEEN text rows. Fraction/radical
    // bars inside math lines cut straight through glyph boxes — with stroke
    // lines now promoted to rules, those must never be taken as row borders.
    let cuts_through_text = |r: &Rule| {
        lines.iter().any(|l| {
            let mut b = l.bbox();
            let dy = b.height() * 0.25;
            b.y0 += dy;
            b.y1 -= dy;
            b.overlaps(&r.rect)
        })
    };
    let mut hrules: Vec<usize> = rules
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            let rr = r.rect;
            rr.height() <= 2.5 && rr.width() > body * 4.0 && !cuts_through_text(r)
        })
        .map(|(i, _)| i)
        .collect();
    if hrules.is_empty() {
        return None;
    }
    hrules.sort_by(|&a, &b| rules[a].rect.y0.partial_cmp(&rules[b].rect.y0).unwrap());
    let h_ys = merge_ys(
        hrules.iter().map(|&i| (rules[i].rect.y0 + rules[i].rect.y1) / 2.0).collect(),
    );
    let h_x0 = hrules.iter().map(|&i| rules[i].rect.x0).fold(f64::MAX, f64::min);
    let h_x1 = hrules.iter().map(|&i| rules[i].rect.x1).fold(f64::MIN, f64::max);

    // Cell borders: thin vertical strokes, chained to the band's rules (a
    // table may draw a single header rule and get its whole row grid from
    // cell borders). Each stroke spans one grid row, so both of its endpoints
    // are row boundaries.
    let cell_borders: Vec<(usize, Rect)> = rules
        .iter()
        .enumerate()
        .map(|(i, r)| (i, r.rect))
        .filter(|(_, rr)| {
            rr.width() <= 2.5
                && rr.height() > body * 0.6
                && rr.x1 >= h_x0 - body
                && rr.x0 <= h_x1 + body
        })
        .collect();

    // Candidate bands, widest first. A table whose rows are delimited only by
    // cell borders has a single rule: its band starts degenerate and is grown
    // by the chained cell borders inside `build_band`.
    let mut bands: Vec<(f64, f64)> = Vec::new();
    for start in 0..h_ys.len().saturating_sub(1) {
        for end in ((start + 1)..h_ys.len()).rev() {
            bands.push((h_ys[start], h_ys[end]));
        }
    }
    if h_ys.len() == 1 {
        bands.push((h_ys[0], h_ys[0]));
    }
    for (top, bottom) in bands {
        if let Some(t) = build_band(lines, &hrules, &cell_borders, top, bottom, (h_x0, h_x1), body) {
            return Some(t);
        }
    }
    None
}

/// Builds the table of one candidate band, or None if the band's text is not
/// a grid.
#[allow(clippy::too_many_arguments)]
fn build_band(
    lines: &[Line],
    hrules: &[usize],
    cell_borders: &[(usize, Rect)],
    band_top: f64,
    band_bottom: f64,
    hx: (f64, f64),
    body: f64,
) -> Option<(Table, Vec<usize>)> {
    let (h_x0, h_x1) = hx;
    let mut ys: Vec<f64> = vec![band_top, band_bottom];
    let mut taken = vec![false; cell_borders.len()];
    let mut claimed: Vec<usize> = hrules.to_vec();
    {
        let (mut lo, mut hi) = (band_top, band_bottom);
        loop {
            let mut grew = false;
            for (i, (ri, rr)) in cell_borders.iter().enumerate() {
                if taken[i] || rr.y1 < lo - Y_MERGE || rr.y0 > hi + Y_MERGE {
                    continue;
                }
                taken[i] = true;
                claimed.push(*ri);
                ys.push(rr.y0);
                ys.push(rr.y1);
                lo = lo.min(rr.y0);
                hi = hi.max(rr.y1);
                grew = true;
            }
            if !grew {
                break;
            }
        }
    }
    let ys = merge_ys(ys);
    if ys.len() < 2 {
        return None;
    }
    let v_ys: Vec<f64> = cell_borders
        .iter()
        .enumerate()
        .filter(|(i, _)| taken[*i])
        .flat_map(|(_, (_, r))| [r.y0, r.y1])
        .collect();
    let is_v = |y: f64| v_ys.iter().any(|v| (v - y).abs() < Y_MERGE);

    // Bands holding text become rows; a band not closed by cell borders on
    // both sides is sub-divided by its baselines (booktabs row grid).
    let mut rows: Vec<Row> = Vec::new();
    for w in ys.windows(2) {
        let (a, b) = (w[0], w[1]);
        let band: Vec<&Line> = lines.iter().filter(|l| l.baseline > a && l.baseline < b).collect();
        if band.is_empty() {
            continue;
        }
        if is_v(a) && is_v(b) {
            rows.push(Row { lines: band });
        } else {
            let mut groups: Vec<Vec<&Line>> = Vec::new();
            for l in band {
                match groups.last_mut() {
                    Some(g) if (g[0].baseline - l.baseline).abs() < 0.6 => g.push(l),
                    _ => groups.push(vec![l]),
                }
            }
            for g in groups {
                rows.push(Row { lines: g });
            }
        }
    }
    if rows.len() < 2 {
        return None;
    }

    // Rows whose text spills into a gutter (a centered value, a spanning
    // header) and rows that merely word-space inside it must be told apart by
    // the placement below, so the run test tolerates a few blocking rows —
    // a quarter of the band, capped. A band whose columns are not separated by
    // any gutter is text between two rules, not a table.
    let max_block = if rows.len() >= 4 { (rows.len() / 4).clamp(1, 3) } else { 0 };
    let bounds = column_bounds(&rows, body, max_block);
    if bounds.is_empty() {
        return None;
    }
    let ncols = bounds.len() + 1;
    let col_of = |x: f64| bounds.iter().filter(|b| **b < x).count();

    // Cells: a row's words, in reading order, assigned to the gutter intervals.
    // Each piece keeps the glyph-level facts its line carries (math-ness) so
    // the cell can be rebuilt from the glyphs at render time.
    let mut grid: Vec<Vec<Cell>> = Vec::with_capacity(rows.len());
    for r in &rows {
        let mut cells: Vec<Cell> = (0..ncols).map(|_| Cell::default()).collect();
        let mut words: Vec<(&crate::layout::Word, f64, f64, bool)> = r
            .lines
            .iter()
            .flat_map(|l| l.words.iter().map(move |w| (w, l.size, l.baseline, l.is_math)))
            .collect();
        words.sort_by(|a, b| {
            a.0.y0.partial_cmp(&b.0.y0).unwrap().then(a.0.x0.partial_cmp(&b.0.x0).unwrap())
        });
        for (w, size, baseline, is_math) in words {
            if w.text.trim().is_empty() {
                continue;
            }
            cells[col_of(w.x0)].parts.push(Piece {
                text: w.text.clone(),
                x0: w.x0,
                x1: w.x1,
                top: w.y0,
                bottom: w.y1,
                size,
                baseline,
                is_math,
            });
        }
        grid.push(cells);
    }

    // A row holding a single cell cannot be a row of a multi-column grid: it
    // is the wrapped continuation of the cell above/below it (a two-line
    // header cell), so it folds into that neighbour.
    let occ = |c: &[Cell]| -> Vec<usize> {
        c.iter().enumerate().filter(|(_, x)| !x.is_empty()).map(|(i, _)| i).collect()
    };
    let mut merged: Vec<Vec<Cell>> = Vec::new();
    for cells in grid {
        let foldable = merged.last().map_or(false, |prev| {
            let a = occ(prev);
            let b = occ(&cells);
            let subset = |x: &[usize], y: &[usize]| x.iter().all(|i| y.contains(i));
            (b.len() == 1 && a.len() > 1 && subset(&b, &a)) || (a.len() == 1 && b.len() > 1 && subset(&a, &b))
        });
        if foldable {
            let prev = merged.last_mut().unwrap();
            for (i, c) in cells.into_iter().enumerate() {
                if !c.is_empty() {
                    prev[i].parts.extend(c.parts);
                }
            }
        } else {
            merged.push(cells);
        }
    }

    // Columns nobody fills are the grid's outer margins, not columns.
    let filled_col = |c: usize| merged.iter().any(|row| !row[c].is_empty());
    let keep: Vec<usize> = (0..ncols).filter(|&c| filled_col(c)).collect();
    if keep.len() < 2 {
        return None;
    }
    let keep_mask: Vec<bool> = (0..ncols).map(|c| keep.contains(&c)).collect();
    let mut rows_out: Vec<Vec<Cell>> = Vec::new();
    for row in merged {
        let mut cells: Vec<Cell> = Vec::with_capacity(keep.len());
        let mut any = false;
        for (c, cell) in row.into_iter().enumerate() {
            if keep_mask[c] {
                any |= !cell.is_empty();
                cells.push(cell);
            }
        }
        if any {
            rows_out.push(cells);
        }
    }
    if rows_out.len() < 2 {
        return None;
    }

    // Grid sanity: most cells carry content (a ruled band with empty "cells"
    // is page decoration, not a table) and ≥2 rows span more than one column
    // (single-cell rows are text lines, not table rows).
    let filled = rows_out.iter().flatten().filter(|c| !c.is_empty()).count();
    let wide = rows_out.iter().filter(|r| r.iter().filter(|c| !c.is_empty()).count() > 1).count();
    if wide < 2 || filled * 3 < rows_out.len() * keep.len() {
        return None;
    }

    let bbox = Rect { x0: h_x0, y0: ys[0], x1: h_x1, y1: ys[ys.len() - 1] };
    Some((Table { bbox, rows: rows_out }, claimed))
}

fn merge_ys(mut ys: Vec<f64>) -> Vec<f64> {
    ys.retain(|y| y.is_finite());
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut out: Vec<f64> = Vec::with_capacity(ys.len());
    for y in ys {
        match out.last() {
            Some(&m) if (y - m).abs() < Y_MERGE => {}
            _ => out.push(y),
        }
    }
    out
}

/// Column boundaries: the midpoints of the band's vertical GUTTERS.
///
/// A gutter is an x-interval most rows are free of text in, because a header
/// cell may span several columns and a cell whose value is centered may spill
/// into the gutter — both cover a boundary the rows below it keep. The
/// boundary is never placed inside a WORD SPACE of a row (that is one cell's
/// text, and splitting it there cut "3.3 · 10^18" into two cells); a row whose
/// word covers the boundary is a cell overflowing its column and is what the
/// tolerance counts. Within a run of free x, the widest stretch no row splits
/// a word space on wins.
fn column_bounds(rows: &[Row], body: f64, max_block: usize) -> Vec<f64> {
    let n = rows.len();
    let min_w = body * GUTTER_MIN_BODY;
    let mut edges: Vec<f64> = Vec::new();
    for r in rows {
        for l in &r.lines {
            for w in &l.words {
                if w.text.trim().is_empty() {
                    continue;
                }
                edges.push(w.x0);
                edges.push(w.x1);
            }
        }
    }
    if edges.len() < 2 {
        return Vec::new();
    }
    edges.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // A gutter is INTERIOR: the band's outer margins are free in every row
    // too, and taking them for column separators split one column in two.
    let (min_x, max_x) = (edges[0], edges[edges.len() - 1]);
    let cover = |x: f64| -> usize {
        rows.iter()
            .filter(|r| {
                r.lines.iter().any(|l| {
                    l.words.iter().any(|w| !w.text.trim().is_empty() && w.x0 <= x && x <= w.x1)
                })
            })
            .count()
    };
    // Elementary intervals between consecutive word edges.
    let mut seg: Vec<(f64, f64, usize)> = Vec::new();
    for w in edges.windows(2) {
        let (a, b) = (w[0], w[1]);
        if b - a < 1e-6 {
            continue;
        }
        seg.push((a, b, n - cover((a + b) / 2.0)));
    }
    let mut out: Vec<f64> = Vec::new();
    let mut i = 0;
    while i < seg.len() {
        if seg[i].2 + max_block < n {
            i += 1;
            continue;
        }
        let start = i;
        while i < seg.len() && seg[i].2 + max_block >= n {
            i += 1;
        }
        let run = &seg[start..i];
        let width: f64 = run.iter().map(|(a, b, _)| b - a).sum();
        if width < min_w {
            continue;
        }
        // The gutter inside a run is the widest stretch EVERY row keeps free:
        // there the boundary is unambiguous.
        let best = run.iter().map(|(_, _, f)| *f).max().unwrap();
        let (mut free_lo, mut free_hi, mut s): (f64, f64, Option<f64>) = (0.0, 0.0, None);
        for &(a, b, f) in run {
            if f != best {
                s = None;
                continue;
            }
            let st = *s.get_or_insert(a);
            if b - st > free_hi - free_lo {
                free_lo = st;
                free_hi = b;
            }
        }
        // …but a row whose value is centered spills its words into that stretch
        // and breaks it into pieces under a body size (Attention Table 2's
        // FLOPs gutter: 2.5pt of free x between "3.3 ·" and "10^18"). When the
        // free stretch is too narrow to be a separator, the boundary goes to
        // the widest place no row SPLITS a word space on instead — a row's word
        // covering it is a value overflowing its column, which belongs left.
        let (blo, bhi) = if free_hi - free_lo >= min_w {
            (free_lo, free_hi)
        } else {
            let (mut open_since, mut best_lo, mut best_hi): (Option<f64>, f64, f64) =
                (None, 0.0, 0.0);
            for &(a, b, _) in run {
                let x = (a + b) / 2.0;
                if !rows.iter().all(|r| row_clean(r, x, min_w)) {
                    open_since = None;
                    continue;
                }
                let lo = *open_since.get_or_insert(a);
                if b - lo > best_hi - best_lo {
                    best_lo = lo;
                    best_hi = b;
                }
            }
            (best_lo, best_hi)
        };
        if (bhi - blo) <= 0.0 || blo <= min_x + 0.5 || bhi >= max_x - 0.5 {
            continue;
        }
        out.push((blo + bhi) / 2.0);
    }
    out
}

/// True when a boundary at `x` may cross this row: the row's text either
/// covers `x` (a word that overflows its column, so the boundary cuts no word
/// space) or leaves a gap of at least `min_w` there (a real cell separator).
fn row_clean(row: &Row, x: f64, min_w: f64) -> bool {
    let (mut left, mut right) = (f64::NEG_INFINITY, f64::INFINITY);
    for l in &row.lines {
        for w in &l.words {
            if w.text.trim().is_empty() {
                continue;
            }
            if w.x0 <= x && x <= w.x1 {
                return true;
            }
            if w.x1 < x {
                left = left.max(w.x1);
            } else {
                right = right.min(w.x0);
            }
        }
    }
    right - left >= min_w
}

/// Escapes pipe characters for GFM cells.
pub fn cell_to_md(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{Glyph, PageItems, Rule};
    use crate::font::FontInfo;
    use crate::layout::Word;

    const BODY: f64 = 10.0;

    /// A horizontal rule (zero height, so it stays a row border).
    fn hrule(x0: f64, x1: f64, y: f64) -> Rule {
        Rule { rect: Rect { x0, y0: y, x1, y1: y }, color: (0.0, 0.0, 0.0) }
    }

    /// A vertical cell border of one row's height.
    fn vrule(x: f64, y0: f64, y1: f64) -> Rule {
        Rule { rect: Rect { x0: x, y0, x1: x, y1 }, color: (0.0, 0.0, 0.0) }
    }

    /// One visual line: the words plus the glyphs behind them, so a text run
    /// can be rendered by the same pipeline the real converter uses.
    fn line(glyphs: &mut Vec<Glyph>, baseline: f64, ws: &[(&str, f64, f64)]) -> Line {
        let mut l = Line { baseline, size: BODY, ..Default::default() };
        let (mut x0, mut x1) = (f64::MAX, f64::MIN);
        for (t, a, b) in ws {
            glyphs.push(Glyph {
                x: *a,
                y: baseline,
                wx: b - a,
                size: BODY,
                code: 0,
                text: (*t).to_string(),
                latex: None,
                font: 0,
            });
            l.glyph_ids.push(glyphs.len() - 1);
            l.words.push(Word {
                x0: *a,
                y0: baseline - BODY * 0.75,
                x1: *b,
                y1: baseline + BODY * 0.25,
                text: (*t).to_string(),
                latex: None,
                size: BODY,
                is_math: false,
                is_bold: false,
                is_italic: false,
                is_mono: false,
            });
            x0 = x0.min(*a);
            x1 = x1.max(*b);
        }
        l.x0 = x0;
        l.x1 = x1;
        l.top = baseline - BODY * 0.75;
        l.bottom = baseline + BODY * 0.25;
        l
    }

    /// A page's items for the renderer: the glyphs the test lines were built
    /// from plus the band's rules.
    fn items_of(glyphs: Vec<Glyph>, rules: Vec<Rule>) -> PageItems {
        PageItems {
            glyphs,
            rules,
            paths: Vec::new(),
            images: Vec::new(),
            rotated: Vec::new(),
            page_width: 400.0,
            page_height: 200.0,
            fonts: vec![FontInfo::new()],
        }
    }

    /// Renders a detected table the way `structure` renders it.
    fn rows_md(t: &Table, items: &PageItems) -> Vec<Vec<String>> {
        let rules: Vec<&Rule> = items.rules.iter().collect();
        let mut warnings = Vec::new();
        t.rows
            .iter()
            .map(|r| r.iter().map(|c| c.md(items, &rules, &mut warnings)).collect())
            .collect()
    }

    /// A paragraph: every line runs the full measure with no room for a
    /// vertical gutter. Two page-wide rules bracket it — exactly the shape
    /// that used to be turned into a 20-column table of word fragments and
    /// then printed a second time as text.
    #[test]
    fn ruled_paragraph_is_not_a_table() {
        let rules: Vec<Rule> = vec![hrule(0.0, 400.0, 5.0), hrule(0.0, 400.0, 120.0)];
        let mut glyphs = Vec::new();
        let mut lines = Vec::new();
        let mut y = 20.0;
        while y < 110.0 {
            lines.push(line(
                &mut glyphs,
                y,
                &[
                    ("the", 0.0, 24.0),
                    ("quick", 26.0, 56.0),
                    ("brown", 58.0, 92.0),
                    ("fox", 94.0, 116.0),
                    ("jumps", 118.0, 156.0),
                    ("over", 158.0, 186.0),
                    ("lazy", 188.0, 214.0),
                    ("dogs", 216.0, 248.0),
                ],
            ));
            y += 11.0;
        }
        let refs: Vec<&Rule> = rules.iter().collect();
        assert!(detect(&lines, &refs, BODY).is_none(), "paragraph read as a table");
    }

    /// One visual line with explicit glyph geometry: each entry is ONE word
    /// rendered as one glyph — `(text, x0, x1, dy, size, latex)` with `dy` the
    /// baseline offset (positive = raised, a superscript).
    #[allow(clippy::type_complexity)]
    fn script_line(
        glyphs: &mut Vec<Glyph>,
        baseline: f64,
        ws: &[(&str, f64, f64, f64, f64, Option<&str>)],
    ) -> Line {
        let mut l = Line { baseline, size: BODY, ..Default::default() };
        let (mut x0, mut x1) = (f64::MAX, f64::MIN);
        for (t, a, b, dy, size, latex) in ws {
            glyphs.push(Glyph {
                x: *a,
                y: baseline - dy,
                wx: b - a,
                size: *size,
                code: 0,
                text: (*t).to_string(),
                latex: latex.map(|s| s.to_string()),
                font: 0,
            });
            l.glyph_ids.push(glyphs.len() - 1);
            let (top, bottom) = (baseline - dy - size * 0.75, baseline - dy + size * 0.25);
            l.words.push(Word {
                x0: *a,
                y0: top,
                x1: *b,
                y1: bottom,
                text: (*t).to_string(),
                latex: latex.map(|s| s.to_string()),
                size: *size,
                is_math: latex.is_some(),
                is_bold: false,
                is_italic: false,
                is_mono: false,
            });
            x0 = x0.min(*a);
            x1 = x1.max(*b);
        }
        l.x0 = x0;
        l.x1 = x1;
        l.top = l.words.iter().map(|w| w.y0).fold(f64::MAX, f64::min);
        l.bottom = l.words.iter().map(|w| w.y1).fold(f64::MIN, f64::max);
        // A line whose glyphs carry LaTeX is TeX-set: the same signal the
        // layout layer derives for a real row.
        l.is_math = l.words.iter().any(|w| w.latex.is_some())
            || l.words.iter().any(|w| w.size < BODY * 0.92);
        l
    }

    /// A booktabs table: three rules, a header whose second line is a wrapped
    /// cell, four data rows on the line grid. Columns come from the gutters,
    /// rows from the baseline grid, and the wrapped "Operations" folds into
    /// the header cell it continues.
    #[test]
    fn booktabs_rows_and_wrapped_header_cell() {
        let rules: Vec<Rule> =
            vec![hrule(0.0, 400.0, 5.0), hrule(0.0, 400.0, 28.0), hrule(0.0, 400.0, 75.0)];
        let mut glyphs = Vec::new();
        let mut lines = vec![
            line(&mut glyphs, 15.0, &[("Layer", 0.0, 30.0), ("Type", 34.0, 60.0)]),
            line(
                &mut glyphs,
                15.0,
                &[
                    ("Complexity", 110.0, 162.0),
                    ("per", 166.0, 184.0),
                    ("Layer", 188.0, 218.0),
                    ("Sequential", 240.0, 292.0),
                    ("Maximum", 320.0, 366.0),
                    ("Path", 370.0, 396.0),
                    ("Length", 402.0, 440.0),
                ],
            ),
            line(&mut glyphs, 22.0, &[("Operations", 240.0, 294.0)]),
        ];
        for (i, y) in [36.0, 47.0, 58.0, 69.0].iter().enumerate() {
            let n = i as f64;
            lines.push(line(
                &mut glyphs,
                *y,
                &[
                    ("Row", 0.0, 26.0),
                    ("c", 110.0, 118.0),
                    ("s", 240.0, 248.0),
                    ("values", 400.0, 432.0),
                ],
            ));
            let _ = n;
        }
        let refs: Vec<&Rule> = rules.iter().collect();
        let (t, _) = detect(&lines, &refs, BODY).expect("table not detected");
        let items = items_of(glyphs, rules.clone());
        let rows = rows_md(&t, &items);
        eprintln!("BOOKTABS rows={rows:#?}");
        for (ri, r) in t.rows.iter().enumerate() {
            for (ci, c) in r.iter().enumerate() {
                let ps: Vec<String> = c.parts.iter().map(|p| format!("{}@{:.0}..{:.0} y{:.1} b{:.1}", p.text, p.x0, p.x1, p.top, p.baseline)).collect();
                eprintln!("  r{ri}c{ci}: {}", ps.join(" | "));
            }
        }
        assert_eq!(rows.len(), 5, "header + 4 data rows: {rows:?}");
        assert_eq!(
            rows[0],
            vec!["Layer Type", "Complexity per Layer", "Sequential Operations", "Maximum Path Length"]
        );
        for r in &rows[1..] {
            assert_eq!(r.len(), 4);
            assert_eq!(r[0], "Row");
            assert_eq!(r[3], "values");
        }
    }

    /// A table drawn with cell borders and a single header rule (the GAN
    /// "Parzen window" table): the vertical strokes span one row each, so the
    /// row grid comes from their endpoints.
    #[test]
    fn cell_borders_give_the_row_grid() {
        let rules: Vec<Rule> =
            vec![hrule(0.0, 300.0, 14.0), vrule(100.0, 4.0, 13.0), vrule(100.0, 15.0, 25.0), vrule(100.0, 26.0, 36.0), vrule(200.0, 4.0, 13.0), vrule(200.0, 15.0, 25.0), vrule(200.0, 26.0, 36.0)];
        let mut glyphs = Vec::new();
        let mut lines = vec![line(
            &mut glyphs,
            9.0,
            &[("Model", 20.0, 56.0), ("MNIST", 110.0, 150.0), ("TFD", 210.0, 240.0)],
        )];
        for (i, y) in [20.0, 31.0].iter().enumerate() {
            let label = if i == 0 { "DBN" } else { "GSN" };
            lines.push(line(
                &mut glyphs,
                *y,
                &[(label, 20.0, 46.0), ("138", 110.0, 134.0), ("1909", 210.0, 240.0)],
            ));
        }
        let refs: Vec<&Rule> = rules.iter().collect();
        let (t, _) = detect(&lines, &refs, BODY).expect("table not detected");
        let items = items_of(glyphs, rules.clone());
        let rows = rows_md(&t, &items);
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(rows[1], vec!["DBN", "138", "1909"]);
        assert_eq!(rows[2], vec!["GSN", "138", "1909"]);
    }

    /// Cell text is rebuilt from the cell's glyphs, so a TeX script survives:
    /// in the word layer "10" plus a raised 7pt "19" is the flat string "1019"
    /// (Attention Table 2 printed "1018"/"1019"/"1020" for 10^18/10^19/10^20,
    /// and "O(n2·d)" for O(n²·d)).
    #[test]
    fn cell_scripts_survive_the_glyph_render() {
        let rules: Vec<Rule> = vec![hrule(0.0, 300.0, 5.0), hrule(0.0, 300.0, 45.0)];
        let mut glyphs: Vec<Glyph> = Vec::new();
        let mut cmr = FontInfo::new();
        cmr.tex = crate::font::TexKind::Cmr;
        cmr.space_width = 150.0;
        let mut cmmi = FontInfo::new();
        cmmi.is_math = true;
        cmmi.tex = crate::font::TexKind::Cmmi;
        let lines = vec![
            line(&mut glyphs, 16.0, &[("Model", 0.0, 30.0), ("Cost", 120.0, 150.0)]),
            // "2.3·10" at body size, the exponent "19" raised by 3.6pt at 7pt.
            script_line(
                &mut glyphs,
                27.0,
                &[
                    ("2.3", 0.0, 16.0, 0.0, BODY, None),
                    ("·", 17.0, 20.0, 0.0, BODY, Some("\\cdot")),
                    ("10", 22.0, 31.0, 0.0, BODY, None),
                    ("19", 31.5, 40.0, 3.6, 7.0, None),
                    ("4.9", 120.0, 132.0, 0.0, BODY, None),
                ],
            ),
            line(&mut glyphs, 38.0, &[("GNMT", 0.0, 26.0), ("4.92", 120.0, 140.0)]),
        ];
        let mut items = items_of(glyphs, rules.clone());
        items.fonts = vec![cmr, cmmi];
        let refs: Vec<&Rule> = rules.iter().collect();
        let (t, _) = detect(&lines, &refs, BODY).expect("table not detected");
        let rows = rows_md(&t, &items);
        let flat: Vec<&String> = rows.iter().flatten().collect();
        assert!(
            flat.iter().any(|c| c.contains("^{19}")),
            "superscript lost in the cell render: {rows:?}"
        );
        assert!(flat.iter().any(|c| c.contains("GNMT")), "{rows:?}");
        assert!(flat.iter().any(|c| c.contains("4.92")), "{rows:?}");
    }

    /// The Attention Table 2 gutter: a spanning header covers the gutter, one
    /// data row's value is centered (its word spills into the gutter) and
    /// another row's mantissa leaves only a word space there. The gutter used
    /// to be dropped — the widest stretch free of EVERY row was under a body
    /// size — and the two FLOPs columns merged into one. The boundary must
    /// land past the centered value's exponent, so no value is cut in two.
    #[test]
    fn centered_value_over_the_gutter_keeps_columns_apart() {
        let rules: Vec<Rule> = vec![hrule(0.0, 480.0, 5.0), hrule(0.0, 480.0, 200.0)];
        let mut glyphs: Vec<Glyph> = Vec::new();
        let aligned = |g: &mut Vec<Glyph>, y: f64, m: &str| {
            line(
                g,
                y,
                &[
                    (m, 0.0, 20.0),
                    ("2.3·", 383.0, 401.0),
                    ("1019", 403.0, 421.0),
                    ("1.4·", 435.0, 453.0),
                    ("1020", 455.0, 473.0),
                ],
            )
        };
        let mut lines = vec![
            // Header: "Cost" spans both FLOPs columns (a spanning cell).
            line(&mut glyphs, 20.0, &[("Model", 0.0, 40.0), ("Cost", 380.0, 475.0)]),
        ];
        for (i, y) in [31.0, 42.0, 75.0, 86.0, 97.0, 108.0, 119.0, 130.0, 141.0].iter().enumerate() {
            lines.push(aligned(&mut glyphs, *y, &format!("m{i}")));
        }
        // Centered rows: the value spills into the gutter, its exponent past
        // the word space the boundary must not land in.
        lines.push(line(&mut glyphs, 53.0, &[("m9", 0.0, 20.0), ("3.3", 407.0, 422.0), ("·", 424.5, 427.7), ("1018", 430.0, 451.0)]));
        lines.push(line(&mut glyphs, 64.0, &[("m10", 0.0, 20.0), ("2.3·", 410.0, 428.0), ("1019", 430.0, 448.0)]));
        lines.sort_by(|a, b| a.baseline.partial_cmp(&b.baseline).unwrap());
        let items = items_of(glyphs, rules.clone());
        let refs: Vec<&Rule> = rules.iter().collect();
        let (t, _) = detect(&lines, &refs, BODY).expect("table not detected");
        let rows = rows_md(&t, &items);
        assert_eq!(rows[0].len(), 3, "header spans two FLOPs columns: {:?}", rows[0]);
        for r in &rows[1..] {
            assert_eq!(r.len(), 3, "row {r:?}");
        }
        // The aligned rows separate their two FLOPs values.
        let aligned = rows.iter().find(|r| r[1].starts_with("2.3")).expect("aligned row");
        assert!(aligned[1].contains("1019"), "{aligned:?}");
        assert!(aligned[2].contains("1.4") && aligned[2].contains("1020"), "{aligned:?}");
        // The centered value spills past the boundary but stays whole in the
        // left column: its exponent must not be cut off into the right one.
        let centered = rows.iter().find(|r| r[1].contains("3.3")).expect("centered row");
        assert!(centered[1].contains("1018"), "centered value split: {centered:?}");
        assert!(
            t.rows.iter().flatten().any(|c| c.plain().contains("1018")),
            "plain cell text lost the centered value"
        );
        assert_eq!(centered[2], "", "{centered:?}");
        let shifted = rows.iter().find(|r| r[1].contains("2.3·") && r[1].contains("1019") && r[2].is_empty());
        assert!(shifted.is_some(), "shifted row lost its value: {rows:?}");
    }

    /// The region a table was built from must not be printed a second time by
    /// the flow: `assemble_page` drops the lines inside the table's bbox.
    #[test]
    fn table_region_is_not_printed_twice() {
        let rules: Vec<Rule> = vec![hrule(0.0, 300.0, 5.0), hrule(0.0, 300.0, 45.0)];
        let mut glyphs = Vec::new();
        let lines = vec![
            line(&mut glyphs, 16.0, &[("Layer Type", 0.0, 60.0), ("Size", 120.0, 150.0)]),
            line(&mut glyphs, 27.0, &[("conv", 0.0, 30.0), ("small", 120.0, 152.0)]),
            line(&mut glyphs, 38.0, &[("attn", 0.0, 30.0), ("large", 120.0, 152.0)]),
        ];
        let refs: Vec<&Rule> = rules.iter().collect();
        let (t, _) = detect(&lines, &refs, BODY).expect("table not detected");

        let items = PageItems {
            glyphs,
            rules: rules.clone(),
            paths: Vec::new(),
            images: Vec::new(),
            rotated: Vec::new(),
            page_width: 400.0,
            page_height: 200.0,
            fonts: vec![FontInfo::new()],
        };
        let mut ctx =
            crate::structure::AssembleCtx { items: &items, body: BODY, rules: refs.clone(), warnings: Vec::new() };
        let blocks = crate::structure::assemble_page(
            vec![lines.clone()],
            &mut ctx,
            Vec::new(),
            vec![t],
            400.0,
            None,
        );
        let tables = blocks.iter().filter(|b| matches!(b, crate::structure::Block::TableBlock { .. })).count();
        assert_eq!(tables, 1, "table block missing: {:?}", blocks.len());
        let leaked: Vec<&String> = blocks
            .iter()
            .filter_map(|b| match b {
                crate::structure::Block::Paragraph(t) => Some(t),
                _ => None,
            })
            .filter(|t| t.contains("Layer Type") || t.contains("conv"))
            .collect();
        assert!(leaked.is_empty(), "table cells printed again as text: {leaked:?}");
    }
}
