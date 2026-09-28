//! Structure assembly: ordered lines + figures + tables → markdown blocks.

use crate::content::{Glyph, PageItems, Rule};
use crate::font::FontInfo;
use crate::graphics::ExtractedFigure;
use crate::layout::{is_cjk_char, Line};
use crate::math;
use crate::table::Table;
use crate::geom::Rect;

#[derive(Debug, Clone)]
pub enum Block {
    Heading { level: usize, text: String },
    Paragraph(String),
    MathBlock(String),
    ListItem { ordered: Option<u64>, text: String },
    TableBlock { rows: Vec<Vec<String>> },
    Figure { asset: String, alt: String },
    /// One entry of a detected table of contents (level is 1-based nesting).
    TocEntry { level: usize, text: String, page: Option<String> },
}

const BULLETS: [char; 14] = ['•', '‣', '▪', '◦', '●', '○', '·', '∙', '–', '—', '-', '*', '■', '□'];
const KNOWN_HEADINGS: [&str; 9] = [
    "abstract", "references", "acknowledgments", "acknowledgements", "appendix",
    "introduction", "conclusion", "conclusions", "related work",
];

pub struct AssembleCtx<'a> {
    pub items: &'a PageItems,
    pub body: f64,
    pub rules: Vec<&'a Rule>,
    /// Collected "cannot fully reconstruct" notes (drained by the caller).
    pub warnings: Vec<String>,
}

/// Assembles one page's blocks from column-ordered lines plus figures/tables.
/// `page_toc` (when detected) is inserted into the stream at its y position;
/// its lines were already removed from `columns` by the caller.
pub fn assemble_page(
    columns: Vec<Vec<Line>>,
    ctx: &mut AssembleCtx,
    figures: Vec<ExtractedFigure>,
    tables: Vec<Table>,
    page_width: f64,
    page_toc: Option<&crate::toc::PageToc>,
) -> Vec<Block> {
    // column x-ranges — from lines with actual CONTENT: the arXiv stamp on
    // p1 (empty 20pt glyphs at x=32) widened the column so the intro
    // paragraph's first line no longer counted as "spanning the column" and
    // slipped through the numbered-heading gate.
    let col_ranges: Vec<(f64, f64)> = columns
        .iter()
        .map(|ls| {
            let content = ls.iter().filter(|l| {
                !l.text().trim().is_empty()
                    || l.glyph_ids
                        .iter()
                        .any(|&i| ctx.items.glyphs.get(i).map(|g| !g.text.is_empty()).unwrap_or(false))
            });
            let x0 = content.clone().map(|l| l.x0).fold(f64::MAX, f64::min);
            let x1 = content.map(|l| l.x1).fold(f64::MIN, f64::max);
            (x0, x1)
        })
        .collect();

    // assign figures/tables to columns (or the first when spanning)
    let mut per_col_fig: Vec<Vec<&ExtractedFigure>> = vec![Vec::new(); columns.len()];
    let mut per_col_tab: Vec<Vec<&Table>> = vec![Vec::new(); columns.len()];
    let mut per_col_unused: Vec<Vec<Line>> = vec![Vec::new(); columns.len()];

    for f in &figures {
        let cx = (f.bbox.x0 + f.bbox.x1) / 2.0;
        let width = f.bbox.width();
        let full = width > page_width * 0.6;
        let ci = if full {
            0
        } else {
            col_ranges
                .iter()
                .position(|(a, b)| cx >= *a - 10.0 && cx <= *b + 10.0)
                .unwrap_or(0)
        };
        per_col_fig[ci].push(f);
    }
    for t in &tables {
        let cx = (t.bbox.x0 + t.bbox.x1) / 2.0;
        let width = t.bbox.width();
        let full = width > page_width * 0.6;
        let ci = if full { 0 } else {
            col_ranges
                .iter()
                .position(|(a, b)| cx >= *a - 10.0 && cx <= *b + 10.0)
                .unwrap_or(0)
        };
        per_col_tab[ci].push(t);
    }

    // Lines already carry their column via `columns`; but the tables own the
    // lines inside their bbox: those lines ARE the table's cells, and the
    // TableBlock above already renders them. Leaving them in the flow printed
    // the same region twice — once as a table, once as the (garbled) text the
    // table was built from.
    let ctx_body = ctx.body;
    let in_table = |l: &Line| -> bool {
        let margin = ctx_body * 0.3;
        tables.iter().any(|t| {
            let b = &t.bbox;
            l.baseline >= b.y0 - margin
                && l.baseline <= b.y1 + margin
                && l.x1 > b.x0 - 1.0
                && l.x0 < b.x1 + 1.0
        })
    };

    let mut blocks: Vec<Block> = Vec::new();
    let toc_col = page_toc.as_ref().map(|t| {
        col_ranges
            .iter()
            .position(|(a, b)| t.x_center >= *a - 10.0 && t.x_center <= *b + 10.0)
            .unwrap_or(0)
    });
    for ci in 0..columns.len() {
        // merge lines + foreign elements into one y-ordered stream
        let mut stream: Vec<StreamEl> = Vec::new();
        for l in columns[ci].iter().cloned() {
            if in_table(&l) {
                continue;
            }
            stream.push(StreamEl::Line(l));
        }
        for f in &per_col_fig[ci] {
            stream.push(StreamEl::Figure(f));
        }
        for t in &per_col_tab[ci] {
            stream.push(StreamEl::Table(t));
        }
        if page_toc.is_some() && toc_col == Some(ci) {
            stream.push(StreamEl::Toc(page_toc.unwrap().clone()));
        }
        // full-page figures assigned to col 0 keep y order; sort by top y
        stream.sort_by(|a, b| el_top(a).partial_cmp(&el_top(b)).unwrap());

        let col_x0 = col_ranges[ci].0;
        let col_x1 = col_ranges[ci].1;
        blocks.extend(render_stream(stream, ctx, col_x0, col_x1));
        per_col_unused[ci] = Vec::new();
    }
    blocks
}

enum StreamEl<'a> {
    Line(Line),
    /// Same-row annotation of the math region before it (an equation number).
    Annotation(Line),
    Figure(&'a ExtractedFigure),
    Table(&'a Table),
    /// A detected table-of-contents region (one nested list).
    Toc(crate::toc::PageToc),
}

fn el_top(el: &StreamEl) -> f64 {
    match el {
        StreamEl::Line(l) | StreamEl::Annotation(l) => l.top,
        // Row top, not the box top: side-by-side subfigures share a row, and
        // a hair-splitting y0 sort would put the right one before the left.
        StreamEl::Figure(f) => f.row_top,
        StreamEl::Table(t) => t.bbox.y0,
        StreamEl::Toc(t) => t.top,
    }
}

fn line_is_mathy(line: &Line, items: &PageItems) -> bool {
    let glyphs: Vec<&Glyph> = line.glyph_ids.iter().map(|&i| &items.glyphs[i]).collect();
    !glyphs.is_empty()
        && (line.is_math || math::looks_like_display_math(&glyphs, &items.fonts, false))
}

/// LaTeX big operators: an operator that takes limits and is set large in a
/// display formula (the C∫∑∏ of a multi-line integral or sum).
const BIG_OPS: [&str; 10] = [
    "\\int", "\\oint", "\\iint", "\\iiint", "\\sum", "\\prod", "\\coprod",
    "\\bigcup", "\\bigcap", "\\bigoplus",
];

/// True when the line holds nothing but a big operator and its script-sized
/// pieces — an operator alone, which is never a formula by itself (its
/// integrand/limits are the lines around it).
fn bare_big_op(line: &Line, items: &PageItems) -> bool {
    if line.glyph_ids.is_empty() {
        return false;
    }
    let body = line.size;
    let mut op = false;
    for &i in &line.glyph_ids {
        let Some(g) = items.glyphs.get(i) else { return false };
        let is_op = g.latex.as_deref().map(|l| BIG_OPS.contains(&l)).unwrap_or(false);
        if is_op {
            op = true;
        } else if g.size >= body * 0.9 {
            return false;
        }
    }
    op
}

/// Merges vertically-adjacent mathy lines into single StreamEl::Line blobs
/// (a synthetic Line whose glyph_ids cover the whole region).
fn merge_math_regions<'a>(
    stream: Vec<StreamEl<'a>>,
    items: &PageItems,
    page_rules: &[&Rule],
) -> Vec<StreamEl<'a>> {
    let mut out: Vec<StreamEl> = Vec::new();
    let mut i = 0;
    while i < stream.len() {
        let line = match &stream[i] {
            StreamEl::Line(l) => l.clone(),
            other => {
                out.push(match other {
                    StreamEl::Figure(f) => StreamEl::Figure(f),
                    StreamEl::Table(t) => StreamEl::Table(t),
                    StreamEl::Line(l) => StreamEl::Line(l.clone()),
                    StreamEl::Annotation(l) => StreamEl::Annotation(l.clone()),
                    StreamEl::Toc(t) => StreamEl::Toc(t.clone()),
                });
                i += 1;
                continue;
            }
        };
        if !line_is_mathy(&line, items) {
            out.push(StreamEl::Line(line));
            i += 1;
            continue;
        }
        // start a region
        let mut region = line.clone();
        let mut last = line.clone();
        let mut j = i + 1;
        let mut deferred: Vec<Line> = Vec::new();
        while j < stream.len() {
            let next = match &stream[j] {
                StreamEl::Line(l) => l,
                _ => break,
            };
            // Only a vertical STACK (fraction/radical/limit pieces) merges:
            // its baselines sit within ~0.9×size of each other. Successive
            // display formulas sit on the LINE GRID, ≥1.1×size apart (the GAN
            // derivations are exactly 1.096×size) — merging across that used
            // to interleave them character by character in reconstruct.
            // An exception: a line that holds nothing but a big operator is
            // the operator of the formula BELOW it, never a formula of its own.
            // The reduced-volume integral of ricci p14 sets its ∫ 1.35×size
            // above the integrand; the stack rule left the operator alone as
            // `$$\int$$` and the integrand as a second block.
            let baseline_gap = next.baseline - last.baseline;
            if baseline_gap > 0.95 * next.size.max(last.size)
                && !(bare_big_op(&region, items) && baseline_gap < 2.0 * next.size.max(last.size))
            {
                break;
            }
            if !line_is_mathy(next, items) {
                // A non-mathy line whose baseline lies INSIDE the region's
                // span shares the visual row with the formula — an equation
                // number "(1)" or a same-row annotation. It used to cut the
                // formula into two blocks in reversed order; now it waits
                // until the region completes and is emitted after it.
                if next.baseline >= region.top && next.baseline <= region.bottom {
                    deferred.push(next.clone());
                    j += 1;
                    continue;
                }
                break;
            }
            // An aligned derivation continues with "=" on its own line; those
            // lines are separate formulas. Without a fraction bar between the
            // two baselines, merging them interleaves them character by
            // character in reconstruct.
            let starts_with_rel = next
                .glyph_ids
                .first()
                .and_then(|&i| items.glyphs.get(i))
                .map(|g| g.text.trim_start().starts_with('='))
                .unwrap_or(false);
            let bar_between = page_rules.iter().any(|r| {
                let rr = r.rect;
                rr.width() > 1.5
                    && rr.height() <= 3.5
                    && rr.y0 > last.baseline
                    && rr.y1 < next.baseline
                    && rr.x1 > last.x0.min(next.x0)
                    && rr.x0 < last.x1.max(next.x1)
            });
            if starts_with_rel && !bar_between {
                break;
            }
            region.glyph_ids.extend(next.glyph_ids.iter().cloned());
            region.x0 = region.x0.min(next.x0);
            region.x1 = region.x1.max(next.x1);
            region.top = region.top.min(next.top);
            region.bottom = region.bottom.max(next.bottom);
            if !next.limit_spans.is_empty() {
                region.limit_spans.extend(next.limit_spans.iter().copied());
            }
            last = next.clone();
            j += 1;
        }
        region.limit_spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        out.push(StreamEl::Line(region));
        for d in deferred {
            out.push(StreamEl::Annotation(d));
        }
        i = j;
    }
    out
}

fn render_stream(stream: Vec<StreamEl>, ctx: &mut AssembleCtx, col_x0: f64, col_x1: f64) -> Vec<Block> {
    // Split the context up front: rule refs and items are shared borrows with
    // the 'a lifetime, warnings is the one mutable field — this keeps the two
    // borrow domains separate in the body below.
    let items: &PageItems = ctx.items;
    let body: f64 = ctx.body;
    let page_rules: Vec<&Rule> = ctx.rules.clone();
    let warnings: &mut Vec<String> = &mut ctx.warnings;
    let mut blocks: Vec<Block> = Vec::new();
    let col_width = (col_x1 - col_x0).max(1.0);
    let mut para: Vec<String> = Vec::new();
    let mut para_prev_bottom: Option<f64> = None;
    let mut para_prev_x0: Option<f64> = None;

    macro_rules! flush {
        () => {
            if !para.is_empty() {
                let text = join_paragraph(&para);
                if !text.trim().is_empty() {
                    blocks.push(Block::Paragraph(text));
                }
                para.clear();
            }
            para_prev_bottom = None;
            para_prev_x0 = None;
        };
    }

    // Pre-pass: merge consecutive mathy lines into display-math regions so
    // fractions/roots spanning several baselines reconstruct as one formula.
    let stream = merge_math_regions(stream, items, &page_rules);

    // Barrier rules (footnote separators, horizontal rules): a wide rule that
    // starts at the line's left edge and sits between two lines ends the
    // paragraph — the footnote block below it must not fuse with the body
    // text above it.
    let barriers: Vec<&Rule> = page_rules
        .iter()
        .copied()
        .filter(|r| r.rect.width() > body * 3.0)
        .collect();
    let rule_between = |prev_bottom: f64, line: &Line| {
        barriers.iter().any(|r| {
            r.rect.y0 > prev_bottom - 1.0
                && r.rect.y1 < line.top + 1.0
                && r.rect.x0 <= line.x0 + body
                && r.rect.x1 > line.x0
        })
    };

    for el in stream {
        match el {
            StreamEl::Annotation(l) => {
                // An equation number belongs to the formula: attach it as a
                // KaTeX \tag so it neither floats away nor starts the next
                // paragraph.
                let text = l.text().trim().to_string();
                if let Some(tag) = eq_tag(&text) {
                    if let Some(Block::MathBlock(latex)) = blocks.last_mut() {
                        latex.push_str(&format!(" \\tag{{{}}}", tag));
                        continue;
                    }
                }
                flush!();
                if !text.is_empty() {
                    blocks.push(Block::Paragraph(escape_md(&text)));
                }
                para_prev_bottom = Some(l.bottom);
            }
            StreamEl::Figure(f) => {
                flush!();
                blocks.push(Block::Figure {
                    asset: f.asset.clone(),
                    alt: if f.alt.is_empty() { "figure".into() } else { f.alt.clone() },
                });
            }
            StreamEl::Table(t) => {
                flush!();
                // Cells render from their glyphs (see `table::Cell::md`): the
                // word layer alone flattened "2.3·10^19" to "2.3· 1019".
                let rows: Vec<Vec<String>> = t
                    .rows
                    .iter()
                    .map(|r| r.iter().map(|c| c.md(items, &page_rules, warnings)).collect())
                    .collect();
                blocks.push(Block::TableBlock { rows });
            }
            StreamEl::Toc(t) => {
                flush!();
                for e in &t.entries {
                    blocks.push(Block::TocEntry {
                        level: e.level,
                        text: e.text.clone(),
                        page: e.page.clone(),
                    });
                }
                para_prev_bottom = Some(t.bottom);
            }
            StreamEl::Line(line) => {
                let text_raw = line.text();
                let compact = text_raw.trim();
                // A region whose glyphs are all pieces (cmex fragments) has no
                // text but still carries LaTeX — dropping it here used to
                // swallow whole formulas (GAN Algorithm 1's generator update).
                let has_latex = line
                    .glyph_ids
                    .iter()
                    .filter_map(|&i| items.glyphs.get(i))
                    .any(|g| g.latex.as_deref().map(|l| !l.is_empty()).unwrap_or(false));
                if compact.is_empty() && !has_latex {
                    continue;
                }
                // display math line
                let glyphs: Vec<&Glyph> =
                    line.glyph_ids.iter().map(|&i| &items.glyphs[i]).collect();
                let line_rules = line_rules(&page_rules, &line);
                // A display formula sits AWAY from the column's left edge
                // (indented or centered). A mostly-math line that starts at
                // the margin is a paragraph continuation ("..., W_i^K ∈ ...")
                // and must stay inline text.
                let indented = line.x0 - col_x0 > body * 2.0;
                if !glyphs.is_empty()
                    && indented
                    && line.is_math
                    && math::looks_like_display_math(&glyphs, &items.fonts, line.is_math)
                {
                    flush!();
                    let latex = math::reconstruct(
                        &math::MathRun { glyphs, rules: line_rules.clone(), limit_spans: line.limit_spans.clone() },
                        &items.fonts,
                        warnings,
                    );
                    if !latex.trim().is_empty() {
                        blocks.push(Block::MathBlock(latex));
                    }
                    para_prev_bottom = Some(line.bottom);
                    continue;
                }
                // heading?
                if let Some(level) = heading_level(&line, body, col_width) {
                    // A hyphenated line break inside a heading used to emit two
                    // headings ("…in potentially in-" + "finite dimensions").
                    // When this heading candidate continues a hyphen-ending
                    // heading, fold it into that heading instead.
                    let text = clean_heading(compact);
                    let mut merged_into_prev = false;
                    if let Some(Block::Heading { text: prev, .. }) = blocks.last_mut() {
                        if prev.ends_with('-') {
                            prev.pop();
                            prev.push_str(&text);
                            merged_into_prev = true;
                        }
                    }
                    if !merged_into_prev {
                        flush!();
                        blocks.push(Block::Heading { level, text });
                    }
                    para_prev_bottom = Some(line.bottom);
                    continue;
                }
                // list item?
                if let Some((ordered, marker_len)) = list_marker(compact) {
                    flush!();
                    // The item body goes through line_text_md like the
                    // continuation lines: plain text() lost every inline
                    // formula ("p(x|c)" degraded to "p(xj c)" — \vert's LaTeX
                    // exists only in the math path). The marker words are
                    // dropped geometrically (their glyphs leave the run).
                    let mut remaining = marker_len;
                    let mut marker_end_x: Option<f64> = None;
                    for w in &line.words {
                        let wl = w.text.chars().count();
                        if wl < remaining {
                            marker_end_x = Some(w.x1);
                            remaining -= wl + 1; // word + joining space
                        } else if wl == remaining {
                            marker_end_x = Some(w.x1);
                            remaining = 0;
                            break;
                        } else {
                            break;
                        }
                    }
                    let body = match marker_end_x {
                        Some(ex) => {
                            let rest: Vec<&Glyph> = line
                                .glyph_ids
                                .iter()
                                .map(|&i| &items.glyphs[i])
                                .filter(|g| g.x + g.wx > ex + 0.1)
                                .collect();
                            line_text_md_glyphs(&rest, items, &page_rules, warnings, &line_rules, line.is_math, &line.limit_spans)
                        }
                        None => line_text_md(&line, items, &page_rules, warnings, &line_rules),
                    };
                    blocks.push(Block::ListItem { ordered, text: body.trim().to_string() });
                    para_prev_bottom = Some(line.bottom);
                    para_prev_x0 = Some(line.x0);
                    continue;
                }
                // continuation of a list item (indented, right after)
                if let Some(Block::ListItem { text, .. }) = blocks.last_mut() {
                    if para_prev_bottom.map(|b| line.top - b < body * 1.2).unwrap_or(false)
                        && line.x0 > col_x0 + body * 1.0
                    {
                        text.push(' ');
                        text.push_str(&line_text_md(&line, items, &page_rules, warnings, &line_rules));
                        para_prev_bottom = Some(line.bottom);
                        continue;
                    }
                }
                // paragraph continuity
                let continues = para_prev_bottom
                    .map(|b| {
                        let gap = line.top - b;
                        gap < body * 1.9 && !rule_between(b, &line)
                    })
                    .unwrap_or(false);
                if !continues {
                    flush!();
                }
                para.push(line_text_md(&line, items, &page_rules, warnings, &line_rules));
                para_prev_bottom = Some(line.bottom);
            }
        }
    }
    flush!();
    blocks
}

pub(crate) fn line_rules<'a>(page_rules: &[&'a Rule], line: &Line) -> Vec<&'a Rule> {
    let mut band = line.bbox();
    band.x0 -= line.size;
    band.x1 += line.size;
    band.y0 -= line.size * 1.6;
    band.y1 += line.size * 1.2;
    page_rules
        .iter()
        .copied()
        .filter(|r| band.overlaps(&r.rect))
        .collect()
}

/// Heading heuristics: numbering, boldness, size, known words.
fn heading_level(line: &Line, body: f64, col_width: f64) -> Option<usize> {
    let text_owned = line.text();
    let text = text_owned.trim();
    if text.is_empty() || text.chars().count() > 90 {
        return None;
    }
    // trailing period usually means a sentence, not a heading
    let ends_sentence = text.ends_with('.') && !text.ends_with("..");
    let words = text.split_whitespace().count();

    // numbered headings: "1 Introduction", "2.1 Data", "A. Related"
    let mut depth = 0usize;
    let mut rest_text = String::new();
    let numbered = {
        let mut chars = text.chars().peekable();
        let mut matched = false;
        loop {
            match chars.peek() {
                Some(c) if c.is_ascii_digit() => {
                    while chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                        chars.next();
                    }
                    depth += 1;
                    matched = true;
                }
                Some('.') => {
                    chars.next();
                    if depth == 0 {
                        break;
                    }
                }
                _ => break,
            }
        }
        let rest = chars.collect::<String>();
        rest_text = rest.clone();
        matched && rest.len() < text.len() && rest.trim_start().len() != rest.len() && words <= 14
    };

    let size_ratio = line.size / body.max(1.0);
    if std::env::var("PDF2MD_HEAD_DEBUG").is_ok() {
        eprintln!("[head] {:?} numbered={} depth={} col_w={:.1} line_w={:.1} ratio={:.2} bold={}",
            text, numbered, depth, col_width, line.x1 - line.x0, size_ratio, line.is_bold);
    }
    if numbered {
        let rest_ok = text.split_whitespace().count() >= 2;
        // A section title continues with a capital (or a symbol): "1 we have"
        // after a formula is a sentence fragment, not a heading. And a real
        // title rarely spans the whole column: the ricci intro's numbered
        // paragraphs ("1. The Ricci flow equation, … is the") fill the line.
        let starts_upper = rest_text
            .trim_start()
            .chars()
            .next()
            .map(|c| c.is_ascii_uppercase())
            .unwrap_or(false);
        let spans_column = line.x1 - line.x0 > col_width * 0.95;
        if rest_ok && !ends_sentence && starts_upper && !spans_column {
            return Some((depth + 1).min(6));
        }
    }
    // "Abstract" etc.
    let first_word = text.split_whitespace().next().unwrap_or("").trim_end_matches(':').to_lowercase();
    if words <= 3 && KNOWN_HEADINGS.contains(&first_word.as_str()) {
        return Some(2);
    }
    // big text (title): usually centered on page 1
    if size_ratio >= 1.5 && words <= 16 && !ends_sentence {
        return Some(1);
    }
    if size_ratio >= 1.18 && words <= 14 && !ends_sentence {
        return Some(2);
    }
    // bold short line: section header in two-column venues
    if line.is_bold && words <= 12 && !ends_sentence && line.x1 - line.x0 < col_width * 0.95 {
        return Some(2);
    }
    // centered short line (e.g. "Abstract")
    let center = (line.x0 + line.x1) / 2.0;
    let col_center = col_width / 2.0;
    let _ = center;
    let _ = col_center;
    None
}

fn clean_heading(s: &str) -> String {
    s.trim_end_matches(':').trim().to_string()
}

/// "(3)" / "(3.2)" / "3" → Some("3") — an equation-number annotation.
fn eq_tag(text: &str) -> Option<String> {
    let t = text.trim();
    let inner = match t.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        Some(inner) => inner,
        None => {
            if t.chars().all(|c| c.is_ascii_digit()) && !t.is_empty() {
                t
            } else {
                return None;
            }
        }
    };
    let compact: String = inner.chars().filter(|c| !c.is_whitespace()).collect();
    if !compact.is_empty() && compact.chars().all(|c| c.is_ascii_digit() || c == '.') {
        Some(compact)
    } else {
        None
    }
}

/// Detects list markers. Returns (ordered number, chars consumed).
fn list_marker(text: &str) -> Option<(Option<u64>, usize)> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return None;
    }
    // bullet symbols
    if BULLETS.contains(&chars[0]) && chars.get(1).map(|c| c.is_whitespace()).unwrap_or(false) {
        return Some((None, 1));
    }
    // ordered: 1. / 1) / (1)
    let mut i = 0;
    let mut digits = String::new();
    if chars[0] == '(' {
        i = 1;
    }
    while i < chars.len() && chars[i].is_ascii_digit() && digits.len() < 3 {
        digits.push(chars[i]);
        i += 1;
    }
    if !digits.is_empty() && i < chars.len() {
        let c = chars[i];
        if c == '.' || c == ')' {
            if i + 1 < chars.len() && chars[i + 1].is_whitespace() {
                let n: u64 = digits.parse().unwrap_or(1);
                let consumed = if chars[0] == '(' { i + 1 } else { i + 1 };
                return Some((Some(n), consumed));
            }
        }
    }
    None
}

/// Builds the markdown text of a line: text with inline `$...$` math runs.
pub(crate) fn line_text_md(
    line: &Line,
    items: &PageItems,
    page_rules: &[&Rule],
    warnings: &mut Vec<String>,
    line_rules: &[&Rule],
) -> String {
    let glyphs: Vec<&Glyph> = line.glyph_ids.iter().map(|&i| &items.glyphs[i]).collect();
    line_text_md_glyphs(
        &glyphs,
        items,
        page_rules,
        warnings,
        line_rules,
        line.is_math,
        &line.limit_spans,
    )
}

/// Same, over an explicit glyph slice (a list item's body without its marker).
pub(crate) fn line_text_md_glyphs(
    glyphs: &[&Glyph],
    items: &PageItems,
    page_rules: &[&Rule],
    warnings: &mut Vec<String>,
    line_rules: &[&Rule],
    tex_text_is_math: bool,
    limit_spans: &[(f64, f64)],
) -> String {
    if glyphs.is_empty() {
        return String::new();
    }
    let segs = math::split_segments(glyphs, &items.fonts, tex_text_is_math);
    let mut out = String::new();
    for (is_math, seg) in segs {
        if is_math {
            let latex = math::reconstruct(
                &math::MathRun { glyphs: seg, rules: line_rules.to_vec(), limit_spans: limit_spans.to_vec() },
                &items.fonts,
                warnings,
            );
            let latex = latex.trim();
            if !latex.is_empty() {
                if out.ends_with(' ') || out.is_empty() {
                    // fine
                } else {
                    out.push(' ');
                }
                out.push('$');
                out.push_str(latex);
                out.push('$');
                out.push(' ');
            }
        } else {
            out.push_str(&glyphs_to_text(&seg, &items.fonts));
        }
    }
    out.trim().to_string()
}

/// Glyphs → plain text with gap-based spaces.
///
/// The space threshold comes from the FONT's own word-space advance, not from
/// a fixed fraction of the size: a run of text is one word's glyphs (gaps of
/// ~0pt), and the gaps that separate words are the font's space (Times 0.25em,
/// cmr 0.15em) — both measurable, and about 1.0× the space advance in these
/// papers, while a size-fraction threshold (0.22em) sat right inside the
/// word-gap cluster and glued whole lines ("generativemodelitself…").
pub fn glyphs_to_text(gs: &[&Glyph], fonts: &[FontInfo]) -> String {
    let mut out = String::new();
    let mut prev_x1: Option<f64> = None;
    let mut prev: Option<&Glyph> = None;
    for g in gs {
        if let (Some(px), Some(p)) = (prev_x1, prev) {
            let gap = g.x - px;
            let is_cjk = g.text.chars().next().map(is_cjk_char).unwrap_or(false);
            let prev_cjk = out.chars().last().map(is_cjk_char).unwrap_or(false);
            // The space belongs to the run before the gap; taking the smaller
            // of the two fonts' spaces keeps a math glyph's meaningless wide
            // advance (cmsy reports 1em) from swallowing a real word space.
            let thr = space_threshold(g, fonts).min(space_threshold(p, fonts));
            if !is_cjk && !prev_cjk && gap > thr {
                out.push(' ');
            } else if gap > g.size * 0.9 {
                out.push(' ');
            }
        }
        out.push_str(&g.text);
        prev_x1 = Some(g.x + g.wx);
        prev = Some(g);
    }
    out
}

/// Half the glyph's font space, in points: gaps above it are word spaces,
/// below it kerns (measured: word gaps 0.8–1.4× the advance, kerns ≤0.05pt).
/// A dvips subset carries no /Widths entry for its space glyph at all (the
/// ricci text faces report 0) and a math font's advance is meaningless (cmsy
/// reports 1em) — those fall back to the floor the layout itself uses to split
/// words, because a TeX text face's word gaps are ~0.2em while its kerns are
/// ~0.01em, an order of magnitude apart.
fn space_threshold(g: &Glyph, fonts: &[FontInfo]) -> f64 {
    fonts
        .get(g.font)
        .map(|f| f.space_width / 1000.0 * g.size)
        .filter(|sw| *sw >= g.size * 0.08 && *sw <= g.size * 0.6)
        .map(|sw| sw * 0.5)
        .unwrap_or(g.size * 0.16)
}

/// Paragraph join with de-hyphenation.
fn join_paragraph(lines: &[String]) -> String {
    let mut out = String::new();
    for l in lines {
        let l = l.trim();
        if l.is_empty() {
            continue;
        }
        if out.is_empty() {
            out.push_str(l);
            continue;
        }
        // de-hyphenate: "infor-\nmation" → "information"
        if out.ends_with('-') && l.chars().next().map(|c| c.is_lowercase()).unwrap_or(false) {
            out.pop();
            out.push_str(l);
        } else if out.ends_with('\u{00AD}') {
            out.pop();
            out.push_str(l);
        } else {
            out.push(' ');
            out.push_str(l);
        }
    }
    escape_md(&out)
}

/// Minimal markdown escaping for PDF text. Inline math runs ($…$) are left
/// untouched except for their delimiters: their bodies are already
/// LaTeX-escaped at the glyph layer, and a second pass turned `\#` into
/// `\\#` (KaTeX sees a line break) and `\{` into `\\{`.
fn escape_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_math = false;
    for c in s.chars() {
        if c == '$' {
            // Delimiters stay UNESCAPED: the app's mathScan inline matcher
            // (`(?<![\\$])\$…`) treats `\$` as literal text, so escaping
            // turned every paragraph formula into visible source code while
            // list items (which skip escape_md) rendered fine.
            out.push('$');
            in_math = !in_math;
            continue;
        }
        if in_math {
            out.push(c);
            continue;
        }
        match c {
            '*' => out.push_str("\\*"),
            '#' => out.push_str("\\#"),
            '`' => out.push_str("\\`"),
            '\u{00A0}' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}
