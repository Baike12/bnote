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
}

/// Assembles one page's blocks from column-ordered lines plus figures/tables.
pub fn assemble_page(
    columns: Vec<Vec<Line>>,
    ctx: &mut AssembleCtx,
    figures: Vec<ExtractedFigure>,
    tables: Vec<Table>,
    page_width: f64,
) -> Vec<Block> {
    // column x-ranges
    let col_ranges: Vec<(f64, f64)> = columns
        .iter()
        .map(|ls| {
            let x0 = ls.iter().map(|l| l.x0).fold(f64::MAX, f64::min);
            let x1 = ls.iter().map(|l| l.x1).fold(f64::MIN, f64::max);
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

    // Lines already carry their column via `columns`; but the tables/figures
    // own some of the lines' region — those lines get dropped when assembling
    // if they fall inside a table bbox (handled in stream loop).

    let mut blocks: Vec<Block> = Vec::new();
    for ci in 0..columns.len() {
        // merge lines + foreign elements into one y-ordered stream
        let mut stream: Vec<StreamEl> = Vec::new();
        for l in columns[ci].iter().cloned() {
            stream.push(StreamEl::Line(l));
        }
        for f in &per_col_fig[ci] {
            stream.push(StreamEl::Figure(f));
        }
        for t in &per_col_tab[ci] {
            stream.push(StreamEl::Table(t));
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
    Figure(&'a ExtractedFigure),
    Table(&'a Table),
}

fn el_top(el: &StreamEl) -> f64 {
    match el {
        StreamEl::Line(l) => l.top,
        StreamEl::Figure(f) => f.bbox.y0,
        StreamEl::Table(t) => t.bbox.y0,
    }
}

fn line_is_mathy(line: &Line, ctx: &AssembleCtx) -> bool {
    let glyphs: Vec<&Glyph> = line.glyph_ids.iter().map(|&i| &ctx.items.glyphs[i]).collect();
    !glyphs.is_empty() && (line.is_math || math::looks_like_display_math(&glyphs, &ctx.items.fonts))
}

/// Merges vertically-adjacent mathy lines into single StreamEl::Line blobs
/// (a synthetic Line whose glyph_ids cover the whole region).
fn merge_math_regions<'a>(stream: Vec<StreamEl<'a>>, ctx: &AssembleCtx) -> Vec<StreamEl<'a>> {
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
                });
                i += 1;
                continue;
            }
        };
        if !line_is_mathy(&line, ctx) {
            out.push(StreamEl::Line(line));
            i += 1;
            continue;
        }
        // start a region
        let mut region = line.clone();
        let mut last = &line;
        let mut j = i + 1;
        while j < stream.len() {
            let next = match &stream[j] {
                StreamEl::Line(l) => l,
                _ => break,
            };
            let gap = next.top - last.bottom;
            if gap > 1.8 * next.size.max(last.size) || !line_is_mathy(next, ctx) {
                break;
            }
            region.glyph_ids.extend(next.glyph_ids.iter().cloned());
            region.x0 = region.x0.min(next.x0);
            region.x1 = region.x1.max(next.x1);
            region.top = region.top.min(next.top);
            region.bottom = region.bottom.max(next.bottom);
            last = next;
            j += 1;
        }
        let _ = last;
        out.push(StreamEl::Line(region));
        i = j;
    }
    out
}

fn el_bottom(el: &StreamEl) -> f64 {
    match el {
        StreamEl::Line(l) => l.bottom,
        StreamEl::Figure(f) => f.bbox.y1,
        StreamEl::Table(t) => t.bbox.y1,
    }
}

fn render_stream(stream: Vec<StreamEl>, ctx: &mut AssembleCtx, col_x0: f64, col_x1: f64) -> Vec<Block> {
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
    let stream = merge_math_regions(stream, ctx);

    for el in stream {
        match el {
            StreamEl::Figure(f) => {
                flush!();
                blocks.push(Block::Figure {
                    asset: f.asset.clone(),
                    alt: "figure".into(),
                });
            }
            StreamEl::Table(t) => {
                flush!();
                blocks.push(Block::TableBlock { rows: t.rows.clone() });
            }
            StreamEl::Line(line) => {
                let text_raw = line.text();
                let compact = text_raw.trim();
                if compact.is_empty() {
                    continue;
                }
                // display math line
                let glyphs: Vec<&Glyph> =
                    line.glyph_ids.iter().map(|&i| &ctx.items.glyphs[i]).collect();
                let line_rules = line_rules(ctx, &line);
                if !glyphs.is_empty()
                    && line.is_math
                    && math::looks_like_display_math(&glyphs, &ctx.items.fonts)
                {
                    flush!();
                    let latex = math::reconstruct(
                        &math::MathRun { glyphs, rules: line_rules.clone() },
                        &ctx.items.fonts,
                    );
                    if !latex.trim().is_empty() {
                        blocks.push(Block::MathBlock(latex));
                    }
                    para_prev_bottom = Some(line.bottom);
                    continue;
                }
                // heading?
                if let Some(level) = heading_level(&line, ctx.body, col_width) {
                    flush!();
                    blocks.push(Block::Heading { level, text: clean_heading(compact) });
                    para_prev_bottom = Some(line.bottom);
                    continue;
                }
                // list item?
                if let Some((ordered, marker_len)) = list_marker(compact) {
                    flush!();
                    let item_text = compact.chars().skip(marker_len).collect::<String>().trim().to_string();
                    blocks.push(Block::ListItem { ordered, text: item_text });
                    para_prev_bottom = Some(line.bottom);
                    para_prev_x0 = Some(line.x0);
                    continue;
                }
                // continuation of a list item (indented, right after)
                if let Some(Block::ListItem { text, .. }) = blocks.last_mut() {
                    if para_prev_bottom.map(|b| line.top - b < ctx.body * 1.2).unwrap_or(false)
                        && line.x0 > col_x0 + ctx.body * 1.0
                    {
                        text.push(' ');
                        text.push_str(&line_text_md(&line, ctx, &line_rules));
                        para_prev_bottom = Some(line.bottom);
                        continue;
                    }
                }
                // paragraph continuity
                let continues = para_prev_bottom
                    .map(|b| {
                        let gap = line.top - b;
                        gap < ctx.body * 1.9
                    })
                    .unwrap_or(false);
                if !continues {
                    flush!();
                }
                para.push(line_text_md(&line, ctx, &line_rules));
                para_prev_bottom = Some(line.bottom);
            }
        }
    }
    flush!();
    blocks
}

fn line_rules<'a>(ctx: &'a AssembleCtx, line: &Line) -> Vec<&'a Rule> {
    let mut band = line.bbox();
    band.x0 -= line.size;
    band.x1 += line.size;
    band.y0 -= line.size * 1.6;
    band.y1 += line.size * 1.2;
    ctx.rules
        .iter()
        .cloned()
        .filter(|r| band.intersect_area(&r.rect) > 0.0)
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
        matched && rest.len() < text.len() && rest.trim_start().len() != rest.len() && words <= 14
    };

    let size_ratio = line.size / body.max(1.0);
    if numbered {
        let rest_ok = text.split_whitespace().count() >= 2;
        if rest_ok && !ends_sentence {
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
fn line_text_md(line: &Line, ctx: &AssembleCtx, rules: &[&Rule]) -> String {
    let glyphs: Vec<&Glyph> = line.glyph_ids.iter().map(|&i| &ctx.items.glyphs[i]).collect();
    if glyphs.is_empty() {
        return String::new();
    }
    let segs = math::split_segments(&glyphs, &ctx.items.fonts);
    let mut out = String::new();
    for (is_math, seg) in segs {
        if is_math {
            let latex = math::reconstruct(
                &math::MathRun { glyphs: seg, rules: rules.to_vec() },
                &ctx.items.fonts,
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
            out.push_str(&glyphs_to_text(&seg, &ctx.items.fonts));
        }
    }
    out.trim().to_string()
}

/// Glyphs → plain text with gap-based spaces.
pub fn glyphs_to_text(gs: &[&Glyph], _fonts: &[FontInfo]) -> String {
    let mut out = String::new();
    let mut prev_x1: Option<f64> = None;
    let mut prev_size = 10.0;
    for g in gs {
        if let Some(px) = prev_x1 {
            let gap = g.x - px;
            let is_cjk = g.text.chars().next().map(is_cjk_char).unwrap_or(false);
            let prev_cjk = out.chars().last().map(is_cjk_char).unwrap_or(false);
            if !is_cjk && !prev_cjk && gap > (g.size * 0.22).max(1.2) {
                out.push(' ');
            } else if gap > g.size * 0.9 {
                out.push(' ');
            }
        }
        out.push_str(&g.text);
        prev_x1 = Some(g.x + g.wx);
        prev_size = g.size;
    }
    let _ = prev_size;
    out
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

/// Minimal markdown escaping for PDF text.
fn escape_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '$' => out.push_str("\\$"),
            '*' => out.push_str("\\*"),
            '#' => out.push_str("\\#"),
            '`' => out.push_str("\\`"),
            '\u{00A0}' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}
