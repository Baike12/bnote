//! Table-of-contents pages: detect "title …… page-number" rows and emit them
//! as one nested markdown list per TOC region.
//!
//! Why a first-class model (root cause, not a patch): a TOC row is laid out
//! as title text at the left and the page number right-aligned FAR away. The
//! generic line builder splits that row at the gap (most TOCs have no glyph
//! connecting them), and the fragments were then misjudged independently by
//! the per-line heuristics — the title became a numbered heading, the bare
//! page number became a bold "heading", and a title containing math split
//! again into a display formula that swallowed the page number. Fixing any
//! one of those heuristics would just move the breakage: the model was
//! missing. Here TOC rows are recognized on VISUAL ROWS (lines sharing a
//! baseline), a page region qualifies only as a consecutive run of entry
//! rows, and the consumed lines are removed from the text flow before
//! heading/list/math classification ever sees them — so no other entry point
//! can reproduce the same misjudgement.

use crate::content::{PageItems, Rule};
use crate::layout::{Line, Word};
use crate::structure::{line_rules, line_text_md};

/// One TOC entry: markdown list level (1-based), readable title text (inline
/// math kept as `$...$`), and the page number when the row carried one.
#[derive(Debug, Clone, PartialEq)]
pub struct TocEntry {
    pub level: usize,
    pub text: String,
    pub page: Option<String>,
}

/// A detected TOC region on one page.
#[derive(Debug, Clone)]
pub struct PageToc {
    /// Top y of the first entry row (stream ordering).
    pub top: f64,
    /// Bottom y of the last entry row.
    pub bottom: f64,
    /// Horizontal center of the entries (column assignment).
    pub x_center: f64,
    /// Flow-line indices consumed by the entries. The caller removes them
    /// from the page's text flow so the generic per-line heuristics never
    /// judge TOC fragments.
    pub line_ids: Vec<usize>,
    pub entries: Vec<TocEntry>,
}

/// Minimum consecutive entry rows for a TOC region. Below this, right-aligned
/// stray numbers are left to the generic pipeline (conservative: prose and
/// data tables must never be eaten).
const MIN_RUN: usize = 3;
/// Runs shorter than HEADER_RUN need a "Contents"-style header on the page.
const HEADER_RUN: usize = 4;

/// Detects a TOC region among the page's flow lines. Returns `None` when the
/// page shows no convincing TOC pattern (then nothing is consumed).
pub fn detect_page_toc(
    lines: &[Line],
    items: &PageItems,
    page_rules: &[&Rule],
    warnings: &mut Vec<String>,
) -> Option<PageToc> {
    if lines.len() < MIN_RUN * 2 {
        return None;
    }
    let rows = build_rows(lines);
    let drafts: Vec<Option<EntryDraft>> =
        rows.iter().map(|row| entry_draft(row, lines)).collect();

    // Longest valid run of consecutive entry rows.
    let mut best: Option<(usize, usize)> = None; // (row range start, end) exclusive
    let mut i = 0;
    while i < drafts.len() {
        if drafts[i].is_some() {
            let start = i;
            while i < drafts.len() && drafts[i].is_some() {
                i += 1;
            }
            let len = i - start;
            if len >= MIN_RUN && (len >= HEADER_RUN || has_contents_header(lines)) {
                if run_valid(&drafts[start..i]) {
                    if best.map(|(s, e)| len > e - s).unwrap_or(true) {
                        best = Some((start, i));
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    let (start, end) = best?;

    // Build the entry texts first (numbering-based levels read them).
    let mut texts: Vec<String> = Vec::with_capacity(end - start);
    for (k, row) in rows[start..end].iter().enumerate() {
        let draft = drafts[start + k].as_ref().unwrap();
        let text = entry_title_text(row, lines, items, page_rules, draft, warnings);
        if text.is_empty() {
            return None; // an unreadable "entry" is not a TOC
        }
        texts.push(text);
    }

    let size = run_row_size(&rows[start..end], lines);
    let title_refs: Vec<&str> = texts.iter().map(|t| t.as_str()).collect();
    let levels = assign_levels(&title_refs, &rows[start..end], lines, size);

    let mut entries = Vec::with_capacity(end - start);
    let mut line_ids = Vec::new();
    let mut top = f64::MAX;
    let mut bottom = f64::MIN;
    let mut x_min = f64::MAX;
    let mut x_max = f64::MIN;
    for (k, row) in rows[start..end].iter().enumerate() {
        entries.push(TocEntry {
            level: levels[k],
            text: texts[k].clone(),
            page: Some(drafts[start + k].as_ref().unwrap().number.clone()),
        });
        line_ids.extend(row.iter().copied());
        for &li in row {
            top = top.min(lines[li].top);
            bottom = bottom.max(lines[li].bottom);
            x_min = x_min.min(lines[li].x0);
            x_max = x_max.max(lines[li].x1);
        }
    }
    Some(PageToc {
        top,
        bottom,
        x_center: (x_min + x_max) / 2.0,
        line_ids,
        entries,
    })
}

/// Groups lines into visual rows: consecutive (baseline-sorted) lines whose
/// baseline sits within a fraction of the font size of the row's first
/// member. TOC rows carry title and page number on one baseline, but the
/// title line's baseline can be dragged a few points off by attached
/// decoration glyphs (an arXiv side stamp), hence the tolerance. Consecutive
/// TOC entries sit ≥1.1×size apart, far outside the tolerance.
fn build_rows(lines: &[Line]) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..lines.len()).collect();
    order.sort_by(|&a, &b| {
        lines[a]
            .baseline
            .partial_cmp(&lines[b].baseline)
            .unwrap()
            .then(lines[a].x0.partial_cmp(&lines[b].x0).unwrap())
    });
    let mut rows: Vec<Vec<usize>> = Vec::new();
    for &li in &order {
        let l = &lines[li];
        let mut joined = false;
        if let Some(row) = rows.last_mut() {
            let first = &lines[row[0]];
            let tol = ((first.size.min(l.size)) * 0.7).clamp(3.0, 9.0);
            if (l.baseline - first.baseline).abs() <= tol {
                row.push(li);
                joined = true;
            }
        }
        if !joined {
            rows.push(vec![li]);
        }
    }
    rows
}

#[derive(Debug, Clone)]
struct EntryDraft {
    /// Page number text plus the x-range of its glyphs (for removal from the
    /// title line before text extraction).
    number: String,
    number_x0: f64,
    number_x1: f64,
}

/// Pure page number: 1–4 arabic digits or a short roman numeral. Decimals,
/// equation tags "(1)" and negatives are all rejected.
fn is_plain_number(t: &str) -> bool {
    let t = t.trim();
    if t.is_empty() {
        return false;
    }
    if t.chars().all(|c| c.is_ascii_digit()) && t.len() <= 4 {
        return true;
    }
    t.chars().all(|c| "ivxlcdmIVXLCDM".contains(c)) && t.len() <= 7
}

/// A word consisting only of leader-dot material.
fn is_leader(t: &str) -> bool {
    let t = t.trim();
    !t.is_empty() && t.chars().all(|c| matches!(c, '.' | '·' | '…' | '‥' | '⋯'))
}

struct RowWord<'a> {
    word: &'a Word,
}

/// Recognizes one visual row as a TOC entry: a title on the left and a pure
/// page number on the right, separated by a large gap or a leader-dot run.
fn entry_draft(row: &[usize], lines: &[Line]) -> Option<EntryDraft> {
    let mut words: Vec<RowWord> = Vec::new();
    for &li in row {
        for w in &lines[li].words {
            words.push(RowWord { word: w });
        }
    }
    // words within a line are x-ordered; sort the merged list by x0.
    words.sort_by(|a, b| a.word.x0.partial_cmp(&b.word.x0).unwrap());
    let last = words.last()?.word;
    let num_text = last.text.trim();
    if !is_plain_number(num_text) {
        return None;
    }
    let size = row
        .iter()
        .map(|&li| lines[li].size)
        .fold(0.0f64, f64::max)
        .max(6.0);
    // A long title may legitimately reach within ~1.3×size of its
    // right-aligned page number ("… over a trivial log point  63"); sentence
    // spacing in prose stays below ~0.6×size. The old 2.0 gate dropped the
    // longest entry of the cartier TOC to the heading heuristic.
    let sep = 1.3 * size;

    // Walk backwards over leader words to the first real word.
    let mut idx = words.len() - 1;
    let mut dots = false;
    while idx > 0 {
        let prev = words[idx - 1].word;
        if is_leader(&prev.text) && prev.x1 <= last.x0 + 1.0 {
            dots = true;
            idx -= 1;
        } else {
            break;
        }
    }
    if idx == 0 {
        return None; // nothing but dots before the number
    }
    let prev = words[idx - 1].word;
    if prev.text.trim().is_empty() {
        return None;
    }
    if !dots && last.x0 - prev.x1 < sep {
        return None; // number adjacent to text: prose, not a TOC row
    }
    // Two-column ambiguity guard: another page number ISOLATED on its left
    // (big gap or leader dots before it) means two entries share the visual
    // row (a two-column TOC) — the row cannot be assembled reliably, so it is
    // rejected whole. A number glued to its neighbours ("Section 3 Operators")
    // is part of the title and stays.
    for k in 0..idx {
        let w = words[k].word;
        if !is_plain_number(w.text.trim()) {
            continue;
        }
        let left_isolated = if k == 0 {
            false // a leading number is the entry's own label
        } else {
            let before = words[k - 1].word;
            is_leader(&before.text) || w.x0 - before.x1 >= sep
        };
        if left_isolated {
            return None;
        }
    }
    // The title must contain something readable.
    if !words[..idx].iter().any(|w| w.word.text.chars().any(|c| c.is_alphanumeric())) {
        return None;
    }
    Some(EntryDraft {
        number: num_text.to_string(),
        number_x0: last.x0,
        number_x1: last.x1,
    })
}

/// Run-level sanity: the page numbers must right-align consistently and be
/// non-decreasing (roman numerals are skipped for the order check). This is
/// what separates a TOC from an integer-valued data table.
fn run_valid(drafts: &[Option<EntryDraft>]) -> bool {
    let nums: Vec<&EntryDraft> = drafts.iter().filter_map(|d| d.as_ref()).collect();
    let x1s: Vec<f64> = nums.iter().map(|d| d.number_x1).collect();
    let spread = x1s.iter().copied().fold(f64::MIN, f64::max)
        - x1s.iter().copied().fold(f64::MAX, f64::min);
    if spread > 8.0 {
        return false;
    }
    let mut prev: Option<u64> = None;
    for d in &nums {
        if let Ok(v) = d.number.parse::<u64>() {
            if let Some(p) = prev {
                if v < p {
                    return false;
                }
            }
            prev = Some(v);
        }
    }
    true
}

/// Representative font size of the run's rows (median member line size).
fn run_row_size(rows: &[Vec<usize>], lines: &[Line]) -> f64 {
    let mut sizes: Vec<f64> = rows
        .iter()
        .flat_map(|row| row.iter().map(|&li| lines[li].size))
        .collect();
    sizes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    sizes.get(sizes.len() / 2).copied().unwrap_or(10.0)
}

/// "2.1 Data" → 2, "6 The" → 1, "A. Related" → 1, "Introduction" → None.
/// The label must be followed by whitespace or end of string, so numbers
/// inside words never parse.
fn numbering_depth(title: &str) -> Option<usize> {
    let mut chars = title.trim_start().chars().peekable();
    if chars.peek() == Some(&'(') {
        chars.next();
    }
    let mut depth = 0usize;
    loop {
        match chars.peek() {
            Some(c) if c.is_ascii_digit() => {
                while chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                    chars.next();
                }
                depth += 1;
            }
            // "A." / "IV." — an uppercase letter run as the label component.
            // A run that flows into lowercase ("Introduction") is a word, not
            // a label: the whole parse fails.
            Some(c) if c.is_ascii_uppercase() && depth == 0 => {
                while chars.peek().map(|c| c.is_ascii_uppercase()).unwrap_or(false) {
                    chars.next();
                }
                if chars.peek().map(|c| c.is_ascii_lowercase()).unwrap_or(false) {
                    return None;
                }
                depth += 1;
            }
            _ => break,
        }
        match chars.peek() {
            Some('.') | Some(')') => {
                chars.next();
                match chars.peek() {
                    Some(c) if c.is_whitespace() => break,
                    Some(c) if c.is_ascii_digit() => continue,
                    _ => break,
                }
            }
            Some(c) if c.is_whitespace() => break,
            _ => break,
        }
    }
    if depth == 0 {
        None
    } else {
        Some(depth)
    }
}

/// Level assignment for one run. Numbering depth is the semantic source when
/// at least 80% of the entries carry a label; otherwise the left indent
/// clusters decide (each distinct indent level ranks one nesting step).
fn assign_levels(
    titles: &[&str],
    rows: &[Vec<usize>],
    lines: &[Line],
    size: f64,
) -> Vec<usize> {
    let depths: Vec<Option<usize>> = titles.iter().map(|t| numbering_depth(t)).collect();
    let parsed = depths.iter().filter(|d| d.is_some()).count();
    if parsed * 5 >= titles.len() * 4 {
        return depths
            .iter()
            .map(|d| d.unwrap_or(1).clamp(1, 6))
            .collect();
    }
    // Indent clusters: sort title start x, cut a new cluster when the step
    // exceeds half a font size, rank clusters left to right.
    let x0s: Vec<f64> = rows.iter().map(|row| row_title_x0(row, lines)).collect();
    let mut order: Vec<usize> = (0..x0s.len()).collect();
    order.sort_by(|&a, &b| x0s[a].partial_cmp(&x0s[b]).unwrap());
    let tol = (size * 0.5).max(3.0);
    let mut cluster_of = vec![0usize; x0s.len()];
    let mut clusters: Vec<f64> = Vec::new(); // last x0 absorbed per cluster
    for &i in &order {
        match clusters.last_mut() {
            Some(last) if x0s[i] - *last <= tol => {
                *last = x0s[i];
                cluster_of[i] = clusters.len() - 1;
            }
            _ => {
                clusters.push(x0s[i]);
                cluster_of[i] = clusters.len() - 1;
            }
        }
    }
    cluster_of.iter().map(|&c| (c + 1).min(6)).collect()
}

/// Left edge of a row's readable title (first word with letters/digits).
fn row_title_x0(row: &[usize], lines: &[Line]) -> f64 {
    row.iter()
        .flat_map(|&li| lines[li].words.iter())
        .filter(|w| w.text.chars().any(|c| c.is_alphanumeric()))
        .map(|w| w.x0)
        .fold(f64::MAX, f64::min)
}

/// Builds the readable title text of one entry row: per-line markdown with
/// inline `$...$` math, page-number glyphs and decoration glyphs (empty text,
/// no LaTeX — e.g. an arXiv side stamp) removed first.
fn entry_title_text(
    row: &[usize],
    lines: &[Line],
    items: &PageItems,
    page_rules: &[&Rule],
    number: &EntryDraft,
    warnings: &mut Vec<String>,
) -> String {
    let mut members: Vec<usize> = row.to_vec();
    members.sort_by(|&a, &b| lines[a].x0.partial_cmp(&lines[b].x0).unwrap());
    let mut parts: Vec<String> = Vec::new();
    for li in members {
        let mut l = lines[li].clone();
        // drop the page-number glyphs
        l.glyph_ids.retain(|&i| {
            let g = &items.glyphs[i];
            !(g.x >= number.number_x0 - 1.0 && g.x <= number.number_x1 + 1.0)
        });
        // drop decoration glyphs: no readable text and no LaTeX
        l.glyph_ids.retain(|&i| {
            let g = &items.glyphs[i];
            !g.text.trim().is_empty()
                || g.latex.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
        });
        if l.glyph_ids.is_empty() {
            continue;
        }
        let band = line_rules(page_rules, &l);
        let t = line_text_md(&l, items, page_rules, warnings, &band);
        let t = t.trim();
        if !t.is_empty() {
            parts.push(t.to_string());
        }
    }
    // collapse whitespace runs
    let mut text: String = parts.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
    // strip trailing leader-dot material ("Preliminaries...." → "Preliminaries")
    while text.ends_with('.') || text.ends_with('·') || text.ends_with('…') {
        text.pop();
        text = text.trim_end().to_string();
    }
    text
}

fn has_contents_header(lines: &[Line]) -> bool {
    lines.iter().any(|l| {
        let t: String = l
            .text()
            .to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        matches!(
            t.as_str(),
            "contents" | "tableofcontents" | "目录" | "目次" | "索引" | "index"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Glyph;
    use crate::font::FontInfo;

    /// One glyph per word; `latex` marks a math glyph (e.g. a math-font run
    /// inside a TOC title).
    fn line_at(
        items: &mut PageItems,
        y: f64,
        size: f64,
        parts: &[(f64, &str, Option<&str>)],
    ) -> Line {
        let mut words = Vec::new();
        let mut glyph_ids = Vec::new();
        for (x, text, latex) in parts {
            let gi = items.glyphs.len();
            let wx = text.chars().count() as f64 * size * 0.5;
            items.glyphs.push(Glyph {
                x: *x,
                y,
                wx,
                size,
                code: 0,
                text: (*text).into(),
                latex: latex.map(Into::into),
                font: 0,
            });
            glyph_ids.push(gi);
            words.push(Word {
                x0: *x,
                y0: y - size * 0.78,
                x1: x + wx,
                y1: y + size * 0.24,
                text: (*text).into(),
                latex: latex.map(Into::into),
                size,
                is_math: latex.is_some(),
                is_bold: false,
                is_italic: false,
                is_mono: false,
            });
        }
        let x0 = parts.first().map(|p| p.0).unwrap_or(0.0);
        let x1 = parts
            .iter()
            .map(|(x, t, _)| x + t.chars().count() as f64 * size * 0.5)
            .fold(f64::MIN, f64::max);
        Line {
            words,
            x0,
            x1,
            baseline: y,
            top: y - size * 0.78,
            bottom: y + size * 0.24,
            limit_spans: Vec::new(),
            size,
            is_math: false,
            is_bold: false,
            is_italic: false,
            is_mono: false,
            indent: x0,
            glyph_ids,
        }
    }

    fn items() -> PageItems {
        let mut items = PageItems::default();
        items.fonts.push(FontInfo::new());
        items
    }

    /// A cartier-shaped page: titles at x≈57, page numbers right-aligned at
    /// x1≈553, ~26pt row pitch, a "Contents" header and body lines.
    fn cartier_page(items: &mut PageItems) -> Vec<Line> {
        let mut lines = Vec::new();
        lines.push(line_at(items, 416.3, 17.0, &[(268.2, "Contents", None)]));
        let entries: [(&str, &str, f64); 4] = [
            ("1 Introduction", "1", 442.7),
            ("2 Notations and conventions", "6", 469.1),
            ("3 Preliminaries", "6", 495.8),
            ("4 The p-curvature map", "8", 521.5),
        ];
        for (title, num, y) in entries {
            let words: Vec<(f64, &str, Option<&str>)> = title
                .split(' ')
                .scan(57.6, |cx, w| {
                    let out = (*cx, w, None);
                    *cx += w.len() as f64 * 6.0 + 4.5;
                    Some(out)
                })
                .collect();
            lines.push(line_at(items, y, 12.0, &words));
            lines.push(line_at(items, y, 12.0, &[(547.7, num, None)]));
        }
        // a body line below the TOC region
        lines.push(line_at(
            items,
            570.0,
            12.0,
            &[(57.6, "This", None), (92.0, "is", None), (110.0, "body", None)],
        ));
        lines
    }

    #[test]
    fn cartier_shape_detected_with_page_numbers() {
        let mut items = items();
        let lines = cartier_page(&mut items);
        let mut warnings = Vec::new();
        let toc = detect_page_toc(&lines, &items, &[], &mut warnings)
            .expect("the TOC page must be detected");
        assert_eq!(toc.entries.len(), 4, "one entry per row");
        let pages: Vec<&str> = toc.entries.iter().filter_map(|e| e.page.as_deref()).collect();
        assert_eq!(pages, vec!["1", "6", "6", "8"], "page numbers survive");
        assert_eq!(toc.entries[0].text, "1 Introduction");
        assert_eq!(toc.entries[3].text, "4 The p-curvature map");
        assert!(toc.entries.iter().all(|e| e.level == 1), "single-level list");
        // consumed lines: 4 title lines + 4 number lines, not the header/body
        assert_eq!(toc.line_ids.len(), 8);
    }

    #[test]
    fn prose_is_not_a_toc() {
        let mut items = items();
        // body lines whose last word is a number adjacent to text (normal
        // sentence spacing) — no big gap, no leader dots.
        let mut lines = Vec::new();
        for k in 0..5 {
            let y = 100.0 + 14.0 * k as f64;
            lines.push(line_at(
                &mut items,
                y,
                12.0,
                &[
                    (57.6, "value", None),
                    (100.0, "is", None),
                    (120.0, &(5 + k).to_string(), None),
                ],
            ));
        }
        let mut warnings = Vec::new();
        assert!(detect_page_toc(&lines, &items, &[], &mut warnings).is_none());
    }

    #[test]
    fn math_title_stays_complete_and_number_extracted() {
        let mut items = items();
        let mut lines = Vec::new();
        // chapter-6-like row: "6 The formal schemes" baseline 570, math run
        // (own baseline 574.7) and the page number glued to its right end.
        lines.push(line_at(&mut items, 416.3, 17.0, &[(268.2, "Contents", None)]));
        // row 1
        {
            let title = "5 Logarithmic scheme-theoretic image";
            let words: Vec<(f64, &str, Option<&str>)> = title
                .split(' ')
                .scan(57.6, |cx, w| {
                    let out = (*cx, w, None);
                    *cx += w.len() as f64 * 6.0 + 4.5;
                    Some(out)
                })
                .collect();
            lines.push(line_at(&mut items, 548.3, 12.0, &words));
            lines.push(line_at(&mut items, 548.3, 12.0, &[(541.0, "9", None)]));
        }
        // row 2: text line + math line with trailing page number
        lines.push(line_at(
            &mut items,
            570.3,
            12.0,
            &[(57.6, "6", None), (74.8, "The", None), (100.0, "formal", None), (140.0, "schemes", None)],
        ));
        lines.push(line_at(
            &mut items,
            574.7,
            12.0,
            &[
                (196.95, "Q", Some("Q")),
                (218.0, "and", None),
                (244.33, "R", Some("R")),
                (540.94, "16", None),
            ],
        ));
        // row 3
        {
            let title = "7 Q and R stratifications";
            let words: Vec<(f64, &str, Option<&str>)> = title
                .split(' ')
                .scan(57.6, |cx, w| {
                    let out = (*cx, w, None);
                    *cx += w.len() as f64 * 6.0 + 4.5;
                    Some(out)
                })
                .collect();
            lines.push(line_at(&mut items, 601.1, 12.0, &words));
            lines.push(line_at(&mut items, 601.1, 12.0, &[(541.0, "24", None)]));
        }
        let mut warnings = Vec::new();
        let toc = detect_page_toc(&lines, &items, &[], &mut warnings)
            .expect("TOC with a math-bearing title must be detected");
        assert_eq!(toc.entries.len(), 3);
        let mid = &toc.entries[1];
        assert!(mid.text.starts_with("6 The formal schemes"), "got {:?}", mid.text);
        assert!(mid.text.contains("$"), "math must stay inline: {:?}", mid.text);
        assert!(!mid.text.contains("24"), "page number must not leak into the title");
        assert_eq!(mid.page.as_deref(), Some("16"));
    }

    #[test]
    fn levels_follow_numbering_depth() {
        let mut items = items();
        let mut lines = Vec::new();
        lines.push(line_at(&mut items, 416.3, 17.0, &[(268.2, "Contents", None)]));
        let entries = [("1 Intro", "1"), ("1.1 Motivation", "2"), ("1.2 Plan", "3"), ("2 Setup", "4")];
        let mut y = 448.0;
        for (title, num) in entries {
            let words: Vec<(f64, &str, Option<&str>)> = title
                .split(' ')
                .scan(57.6, |cx, w| {
                    let out = (*cx, w, None);
                    *cx += w.len() as f64 * 6.0 + 4.5;
                    Some(out)
                })
                .collect();
            lines.push(line_at(&mut items, y, 12.0, &words));
            lines.push(line_at(&mut items, y, 12.0, &[(547.7, num, None)]));
            y += 26.0;
        }
        let mut warnings = Vec::new();
        let toc = detect_page_toc(&lines, &items, &[], &mut warnings).unwrap();
        let levels: Vec<usize> = toc.entries.iter().map(|e| e.level).collect();
        assert_eq!(levels, vec![1, 2, 2, 1]);
    }

    #[test]
    fn levels_follow_indent_without_numbering() {
        let mut items = items();
        let mut lines = Vec::new();
        lines.push(line_at(&mut items, 416.3, 17.0, &[(268.2, "Contents", None)]));
        // unnumbered entries, sub-levels indented by 18pt
        let entries = [
            ("Introduction", 57.6),
            ("Notations", 57.6),
            ("Basic definitions", 75.6),
            ("Preliminaries", 57.6),
            ("Conventions", 75.6),
        ];
        let mut y = 448.0;
        for (title, x) in entries {
            let words: Vec<(f64, &str, Option<&str>)> = title
                .split(' ')
                .scan(x, |cx, w| {
                    let out = (*cx, w, None);
                    *cx += w.len() as f64 * 6.0 + 4.5;
                    Some(out)
                })
                .collect();
            lines.push(line_at(&mut items, y, 12.0, &words));
            lines.push(line_at(&mut items, y, 12.0, &[(547.7, &(y as u64).to_string(), None)]));
            y += 26.0;
        }
        let mut warnings = Vec::new();
        let toc = detect_page_toc(&lines, &items, &[], &mut warnings).unwrap();
        let levels: Vec<usize> = toc.entries.iter().map(|e| e.level).collect();
        assert_eq!(levels, vec![1, 1, 2, 1, 2]);
    }

    #[test]
    fn two_number_row_is_rejected() {
        let mut items = items();
        let mut lines = Vec::new();
        lines.push(line_at(&mut items, 416.3, 17.0, &[(268.2, "Contents", None)]));
        // two-column TOC row: two far-separated numbers on one baseline
        lines.push(line_at(
            &mut items,
            448.0,
            12.0,
            &[
                (57.6, "1", None),
                (70.0, "Intro", None),
                (250.0, "2", None),
                (280.0, "Setup", None),
                (547.7, "9", None),
            ],
        ));
        // plus two normal entries — the ambiguous row must break the run
        for (title, y, num) in [("3 Foo", 474.0, "10"), ("4 Bar", 500.0, "11")] {
            let words: Vec<(f64, &str, Option<&str>)> = title
                .split(' ')
                .scan(57.6, |cx, w| {
                    let out = (*cx, w, None);
                    *cx += w.len() as f64 * 6.0 + 4.5;
                    Some(out)
                })
                .collect();
            lines.push(line_at(&mut items, y, 12.0, &words));
            lines.push(line_at(&mut items, y, 12.0, &[(547.7, num, None)]));
        }
        let mut warnings = Vec::new();
        // run of 3 consecutive entry rows? the two-number row is rejected →
        // run length 2 (< MIN_RUN) → nothing detected.
        assert!(detect_page_toc(&lines, &items, &[], &mut warnings).is_none());
    }

    #[test]
    fn descending_numbers_rejected() {
        let mut items = items();
        let mut lines = Vec::new();
        lines.push(line_at(&mut items, 416.3, 17.0, &[(268.2, "Contents", None)]));
        for (title, y, num) in [("1 Foo", 448.0, "30"), ("2 Bar", 474.0, "20"), ("3 Baz", 500.0, "10")] {
            let words: Vec<(f64, &str, Option<&str>)> = title
                .split(' ')
                .scan(57.6, |cx, w| {
                    let out = (*cx, w, None);
                    *cx += w.len() as f64 * 6.0 + 4.5;
                    Some(out)
                })
                .collect();
            lines.push(line_at(&mut items, y, 12.0, &words));
            lines.push(line_at(&mut items, y, 12.0, &[(547.7, num, None)]));
        }
        let mut warnings = Vec::new();
        assert!(detect_page_toc(&lines, &items, &[], &mut warnings).is_none());
    }

    #[test]
    fn numbering_depth_cases() {
        assert_eq!(numbering_depth("2.1 Data"), Some(2));
        assert_eq!(numbering_depth("6 The formal schemes"), Some(1));
        assert_eq!(numbering_depth("A. Related"), Some(1));
        assert_eq!(numbering_depth("Introduction"), None);
        assert_eq!(numbering_depth("3.2.1 Details"), Some(3));
    }

    /// Fixture-backed regression: page 1 of the cartier paper is a real TOC
    /// page (9 entries, math in titles 6/7, an arXiv side stamp polluting
    /// line geometry). Locked end-to-end from PDF bytes.
    #[test]
    fn cartier_fixture_page1_yields_nested_toc() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tests/data/pdf/2609.27549-cartier-toc.pdf"
        );
        let doc = lopdf::Document::load(path).expect("load fixture");
        let page_id = doc.get_pages().into_iter().min_by_key(|(n, _)| *n).unwrap().1;
        let mut cache = std::collections::HashMap::new();
        let items = crate::content::Interp::new(&doc, &mut cache).run_page(page_id).unwrap();
        let lines = crate::layout::build_lines(&items);
        let rule_refs: Vec<&crate::content::Rule> = items.rules.iter().collect();
        let mut warnings = Vec::new();
        let toc = detect_page_toc(&lines, &items, &rule_refs, &mut warnings);
        let toc = match toc {
            Some(t) => t,
            None => panic!("cartier page 1 must be detected as a TOC"),
        };
        assert_eq!(toc.entries.len(), 9, "9 chapter entries, got {:?}", toc.entries);
        let pages: Vec<&str> = toc.entries.iter().filter_map(|e| e.page.as_deref()).collect();
        assert_eq!(pages, vec!["1", "6", "6", "8", "9", "16", "24", "38", "63"]);
        assert!(toc.entries[5].text.contains("The formal schemes"), "got {:?}", toc.entries[5].text);
        assert!(toc.entries[5].text.contains('$'), "math must stay in title 6");
        assert!(toc.entries[6].text.contains("stratifications"), "got {:?}", toc.entries[6].text);
        assert_eq!(toc.entries[5].page.as_deref(), Some("16"));
    }
}
