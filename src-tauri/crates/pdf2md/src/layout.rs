//! Layout analysis: glyphs → words → visual lines (main baseline + attached
//! scripts) → columns (XY-cut) → ordered lines. Y grows downward everywhere.

use crate::content::{Glyph, PageItems};
use crate::font::FontInfo;
use crate::geom::Rect;

/// A word: consecutive glyphs joined without an inter-word gap.
#[derive(Debug, Clone)]
pub struct Word {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub text: String,
    /// Any LaTeX captured from math glyphs inside.
    pub latex: Option<String>,
    pub size: f64,
    pub is_math: bool,
    pub is_bold: bool,
    pub is_italic: bool,
    pub is_mono: bool,
}

impl Word {
    pub fn bbox(&self) -> Rect {
        Rect { x0: self.x0, y0: self.y0, x1: self.x1, y1: self.y1 }
    }
}

/// A visual line: main-baseline words plus script words kept in reading order.
#[derive(Debug, Clone, Default)]
pub struct Line {
    pub words: Vec<Word>,
    pub x0: f64,
    pub x1: f64,
    /// Baseline of the dominant (largest) run.
    pub baseline: f64,
    /// Top of the tallest glyph run (for block spacing).
    pub top: f64,
    pub bottom: f64,
    pub size: f64,
    pub is_math: bool,
    pub is_bold: bool,
    pub is_italic: bool,
    pub is_mono: bool,
    /// Horizontal offset of line start from column left (indent).
    pub indent: f64,
    /// Indices into PageItems.glyphs (for math reconstruction).
    pub glyph_ids: Vec<usize>,
}

impl Line {
    pub fn bbox(&self) -> Rect {
        Rect { x0: self.x0, y0: self.top, x1: self.x1, y1: self.bottom }
    }

    pub fn text(&self) -> String {
        self.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
    }
}

/// One page of layout: ordered lines (columns resolved later) plus graphics.
pub struct PageLayout {
    pub lines: Vec<Line>,
    pub items: PageItems,
}

/// Baseline-clusters glyphs, merges script runs, and returns visual lines
/// sorted by (baseline, x).
pub fn build_lines(items: &PageItems) -> Vec<Line> {
    if items.glyphs.is_empty() {
        return Vec::new();
    }

    // 1) Baseline clustering with size-relative tolerance. Entries carry the
    // original index into items.glyphs so lines can reference glyphs later.
    let mut glyphs: Vec<(usize, &Glyph)> =
        items.glyphs.iter().enumerate().collect();
    glyphs.sort_by(|(_, a), (_, b)| {
        a.y.partial_cmp(&b.y).unwrap().then(a.x.partial_cmp(&b.x).unwrap())
    });

    struct RawGroup {
        baseline: f64,
        size: f64,
        glyphs: Vec<usize>,
        x0: f64,
        x1: f64,
        min_y: f64,
        max_y: f64,
    }
    let mut groups: Vec<RawGroup> = Vec::new();
    let mut prev: Option<&Glyph> = None;
    for (_, (orig, g)) in glyphs.iter().enumerate() {
        let gi = *orig;
        let tol = (g.size * 0.22).clamp(0.8, 3.0);
        // Merge into the previous group only when the glyph sits on the same
        // baseline AND continues it horizontally — same-y glyphs from a second
        // column must NOT merge (the column gutter separates them).
        let prev_ok = match prev {
            Some(p) => {
                (groups.last().unwrap().baseline - g.y).abs() <= tol
                    && g.x >= p.x
                    && (g.x - (p.x + p.wx)) < (g.size * 1.8).max(6.0)
            }
            None => false,
        };
        if prev_ok && !groups.is_empty() {
            let gr = groups.last_mut().unwrap();
            gr.size = gr.size.max(g.size);
            gr.glyphs.push(gi);
            gr.x0 = gr.x0.min(g.x);
            gr.x1 = gr.x1.max(g.x + g.wx);
            gr.min_y = gr.min_y.min(g.bbox().y0);
            gr.max_y = gr.max_y.max(g.bbox().y1);
        } else {
            groups.push(RawGroup {
                baseline: g.y,
                size: g.size,
                glyphs: vec![gi],
                x0: g.x,
                x1: g.x + g.wx,
                min_y: g.bbox().y0,
                max_y: g.bbox().y1,
            });
        }
        prev = Some(g);
    }
    let merged = groups;

    // 2) Attach small groups (scripts) to the nearest larger host group.
    // A group is a script of another when: host is bigger, its baseline lies
    // within host's superscript/subscript window, and it is horizontally close.
    let n = merged.len();
    let mut host_of: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if merged[i].glyphs.len() > 40 {
            continue;
        }
        let (bi, si) = (merged[i].baseline, merged[i].size);
        let mut best: Option<(usize, f64)> = None;
        for j in 0..n {
            if i == j || host_of[j].is_some() {
                continue; // a script cannot host another script
            }
            let hj = &merged[j];
            if hj.size <= si * 1.05 {
                continue;
            }
            let dy = bi - hj.baseline; // y-down: + = below host baseline
            if dy < -0.75 * hj.size || dy > 0.6 * hj.size {
                continue;
            }
            if dy.abs() < 0.16 * hj.size {
                continue; // practically same baseline → stays its own line
            }
            // horizontal proximity: overlapping or within 8pt
            let gap = (merged[i].x0 - hj.x1).max(hj.x0 - merged[i].x1);
            if gap > 8.0 {
                continue;
            }
            let score = dy.abs() + gap.max(0.0);
            if best.map(|(_, s)| score < s).unwrap_or(true) {
                best = Some((j, score));
            }
        }
        if let Some((j, _)) = best {
            host_of[i] = Some(j);
        }
    }
    // 2b) Same-size attachment: fraction numerators/denominators (±0.55×size,
    // x-overlapping the host) and big-operator limits (±1.1×size, narrow
    // overlap). Paragraph leading (~1.2×size) stays outside both windows.
    for i in 0..n {
        if host_of[i].is_some() || merged[i].glyphs.len() > 40 {
            continue;
        }
        let (bi, si) = (merged[i].baseline, merged[i].size);
        let iw = merged[i].x1 - merged[i].x0;
        let mut best: Option<(usize, f64)> = None;
        for j in 0..n {
            if i == j || host_of[j].is_some() || host_of[i].is_some() {
                continue;
            }
            let hj = &merged[j];
            if hj.size < si * 0.55 || hj.size > si * 1.06 {
                continue;
            }
            let dy = bi - hj.baseline;
            let ady = dy.abs();
            if ady < 0.30 * hj.size || ady > 1.28 * hj.size {
                continue;
            }
            // x-overlap fraction against the narrower group; a small x-gap
            // (fraction slot inside the line) counts as overlapping too.
            let jw = hj.x1 - hj.x0;
            let overlap = (merged[i].x1.min(hj.x1) - merged[i].x0.max(hj.x0)).max(0.0);
            let frac = overlap / iw.min(jw).max(1.0);
            let xgap = (merged[i].x0 - hj.x1).max(hj.x0 - merged[i].x1);
            let wide_ok = (frac >= 0.5 || xgap <= 6.0) && ady < 1.02 * hj.size;
            // Narrow overlap = big-operator limits; require a big operator
            // glyph in the host near the script's x (otherwise stray scripts
            // from the neighbouring text line would be captured).
            const LIMIT_OPS: [&str; 10] = [
                r"\sum", r"\prod", r"\coprod", r"\int", r"\oint", r"\iint", r"\iiint",
                r"\bigcup", r"\bigcap", r"\bigoplus",
            ];
            let near_op = hj.glyphs.iter().filter_map(|&gi| items.glyphs.get(gi)).any(|g| {
                let is_op = g
                    .latex
                    .as_deref()
                    .map(|l| LIMIT_OPS.contains(&l))
                    .unwrap_or(false);
                is_op
                    && merged[i].x0 + iw / 2.0 >= g.x - hj.size
                    && merged[i].x0 + iw / 2.0 <= g.x + g.wx + hj.size
            });
            let narrow_ok = frac < 0.5
                && xgap > 6.0
                && ady > 0.5 * hj.size
                && ady < 1.28 * hj.size
                && near_op
                && merged[i].x0 >= hj.x0 - 2.0
                && merged[i].x1 <= hj.x1 + 2.0;
            if !wide_ok && !narrow_ok {
                continue;
            }
            let score = ady;
            if best.map(|(_, s)| score < s).unwrap_or(true) {
                best = Some((j, score));
            }
        }
        if let Some((j, _)) = best {
            host_of[i] = Some(j);
        }
    }

    // 3) Build visual lines: hosts keep their glyphs + attached script glyphs.
    let mut line_members: Vec<Vec<usize>> = Vec::new();
    let mut host_line: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if host_of[i].is_none() {
            let li = line_members.len();
            line_members.push(vec![i]);
            host_line[i] = Some(li);
        }
    }
    for i in 0..n {
        if let Some(h) = host_of[i] {
            if let Some(li) = host_line[h] {
                line_members[li].push(i);
            }
        }
    }

    // 4) Convert each line-membership into a Line with words.
    let mut lines: Vec<Line> = Vec::new();
    for members in &line_members {
        let mut idxs: Vec<usize> =
            members.iter().flat_map(|&m| merged[m].glyphs.clone()).collect();
        idxs.sort_by(|&a, &b| {
            items.glyphs[a].x.partial_cmp(&items.glyphs[b].x).unwrap().then(
                items.glyphs[a].y.partial_cmp(&items.glyphs[b].y).unwrap(),
            )
        });
        let refs: Vec<&Glyph> = idxs.iter().map(|&i| &items.glyphs[i]).collect();
        if let Some(mut line) = assemble_line(&refs, items) {
            line.glyph_ids = idxs.clone();
            lines.push(line);
        }
    }

    lines.sort_by(|a, b| {
        a.baseline.partial_cmp(&b.baseline).unwrap().then(a.x0.partial_cmp(&b.x0).unwrap())
    });
    lines
}

#[allow(unused_variables)]
fn assemble_line(gs: &[&Glyph], items: &PageItems) -> Option<Line> {
    if gs.is_empty() {
        return None;
    }
    let body = dominant_size(gs);

    // Word segmentation with size-aware gaps.
    let mut words: Vec<Word> = Vec::new();
    let mut cur: Vec<&&Glyph> = Vec::new();
    let mut cur_x1 = 0.0;
    for g in gs {
        let is_cjk = g.text.chars().next().map(is_cjk_char).unwrap_or(false);
        let space_w = {
            let f = &items.fonts[g.font];
            f.space_width / 1000.0 * g.size
        };
        let gap_threshold = if is_cjk {
            g.size * 0.28
        } else {
            (space_w * 0.9).max(g.size * 0.16)
        };
        let mut starts_new = false;
        if !cur.is_empty() {
            let gap = g.x - cur_x1;
            let prev_is_cjk = cur.last().unwrap().text.chars().last().map(is_cjk_char).unwrap_or(false);
            if gap > gap_threshold {
                // CJK↔latin boundary gets a space only for readability; CJK
                // internally never breaks on small gaps.
                starts_new = true;
            } else if gap > 0.0 && !is_cjk && !prev_is_cjk && gap < gap_threshold {
                starts_new = false;
            }
        }
        if starts_new {
            push_word(&mut words, &cur, items);
            cur.clear();
        }
        cur.push(g);
        cur_x1 = g.x + g.wx;
    }
    push_word(&mut words, &cur, items);

    if words.is_empty() {
        return None;
    }
    let x0 = words.iter().map(|w| w.x0).fold(f64::MAX, f64::min);
    let x1 = words.iter().map(|w| w.x1).fold(f64::MIN, f64::max);
    let top = words.iter().map(|w| w.y0).fold(f64::MAX, f64::min);
    let bottom = words.iter().map(|w| w.y1).fold(f64::MIN, f64::max);
    let baseline = gs
        .iter()
        .filter(|g| g.size >= body * 0.9)
        .map(|g| g.y)
        .sum::<f64>()
        / gs.iter().filter(|g| g.size >= body * 0.9).count().max(1) as f64;
    let size = body;
    let is_math = words.iter().filter(|w| w.is_math).count() * 3 > words.len().max(1)
        || words.iter().any(|w| w.is_math) && words.len() <= 3;
    let is_bold = words.iter().filter(|w| w.is_bold).count() * 2 > words.len();
    let is_italic = words.iter().filter(|w| w.is_italic).count() * 2 > words.len();
    let is_mono = words.iter().any(|w| w.is_mono);
    Some(Line {
        words,
        x0,
        x1,
        baseline,
        top,
        bottom,
        size,
        is_math,
        is_bold,
        is_italic,
        is_mono,
        indent: x0,
        glyph_ids: Vec::new(),
    })
}

fn push_word(words: &mut Vec<Word>, cur: &[&&Glyph], items: &PageItems) {
    if cur.is_empty() {
        return;
    }
    let mut text = String::new();
    let mut latex: Option<String> = None;
    let mut x0 = f64::MAX;
    let mut x1 = f64::MIN;
    let mut y0 = f64::MAX;
    let mut y1 = f64::MIN;
    let mut size = 0.0f64;
    let mut is_math = false;
    let mut is_bold = false;
    let mut is_italic = false;
    let mut is_mono = false;
    for g in cur {
        text.push_str(&g.text);
        if let Some(lx) = &g.latex {
            is_math = true;
            match &mut latex {
                Some(acc) => acc.push_str(lx),
                None => latex = Some(lx.clone()),
            }
        }
        x0 = x0.min(g.x);
        x1 = x1.max(g.x + g.wx);
        let bb = g.bbox();
        y0 = y0.min(bb.y0);
        y1 = y1.max(bb.y1);
        size = size.max(g.size);
        if let Some(f) = items.fonts.get(g.font) {
            is_bold |= f.is_bold;
            is_italic |= f.is_italic;
            is_mono |= f.is_mono;
            is_math |= f.is_math;
        }
    }
    words.push(Word {
        x0,
        y0,
        x1,
        y1,
        text,
        latex,
        size,
        is_math,
        is_bold,
        is_italic,
        is_mono,
    });
}

fn dominant_size(gs: &[&Glyph]) -> f64 {
    // Mode-ish: bucket sizes to 0.5pt and take the heaviest bucket weighted by
    // glyph advance (body text outweighs scattered scripts).
    let mut buckets: Vec<(f64, f64)> = Vec::new(); // (size, weight)
    for g in gs {
        let b = (g.size * 2.0).round() / 2.0;
        match buckets.iter_mut().find(|(s, _)| (*s - b).abs() < 0.26) {
            Some((_, w)) => *w += g.wx.max(0.1),
            None => buckets.push((b, g.wx.max(0.1))),
        }
    }
    buckets
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .map(|(s, _)| *s)
        .unwrap_or(10.0)
}

pub fn is_cjk_char(c: char) -> bool {
    let u = c as u32;
    (0x2E80..=0x9FFF).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
        || (0xFE30..=0xFE4F).contains(&u)
        || (0xFF00..=0xFFEF).contains(&u)
        || (0x3000..=0x303F).contains(&u)
}

/// XY-cut column detection: splits lines into columns (reading order: column
/// by column, top to bottom within a column).
pub fn order_columns(mut lines: Vec<Line>, page_width: f64) -> Vec<Vec<Line>> {
    if lines.is_empty() {
        return Vec::new();
    }
    if lines.len() < 2 {
        return vec![lines];
    }
    let mut out: Vec<Vec<Line>> = Vec::new();
    let mut queue = vec![lines.clone()];
    lines.clear();
    while let Some(chunk) = queue.pop() {
        if chunk.len() < 2 {
            out.push(chunk);
            continue;
        }
        // gather x coverage
        let top = chunk.iter().map(|l| l.top).fold(f64::MAX, f64::min);
        let bottom = chunk.iter().map(|l| l.bottom).fold(f64::MIN, f64::max);
        let height = (bottom - top).max(1.0);
        const BUCKETS: usize = 160;
        let scale = BUCKETS as f64 / page_width.max(1.0);
        let mut covered = vec![0u32; BUCKETS];
        for l in &chunk {
            let a = ((l.x0 * scale) as usize).min(BUCKETS - 1);
            let b = ((l.x1 * scale) as usize).min(BUCKETS - 1);
            for c in covered.iter_mut().take(b + 1).skip(a) {
                *c += 1;
            }
        }
        // find the widest gap fully covering >= 70% of height with width >= 14pt
        let min_gap_cover = (height * 0.7) as u32;
        let min_gap_width = (14.0 * scale).max(1.0) as usize;
        let mut best: Option<(usize, usize)> = None; // (start,end) exclusive gap
        let mut i = 0;
        while i < BUCKETS {
            if covered[i] == 0 {
                let start = i;
                while i < BUCKETS && covered[i] == 0 {
                    i += 1;
                }
                let width = i - start;
                let interior_cover = covered[start..i].iter().sum::<u32>(); // zero by construction
                let _ = interior_cover;
                // gap must sit strictly inside content, not page margins
                let inner = start > 2 && i < BUCKETS - 2;
                if width >= min_gap_width && inner && (best.is_none() || width > best.unwrap().1 - best.unwrap().0) {
                    // verify vertical span: count lines crossing the gutter
                    let gx0 = start as f64 / scale;
                    let gx1 = i as f64 / scale;
                    let crossing = chunk
                        .iter()
                        .filter(|l| l.x0 < gx1 && l.x1 > gx0)
                        .count();
                    if crossing == 0 {
                        best = Some((start, i));
                    }
                }
            } else {
                i += 1;
            }
        }
        if let Some((s, e)) = best {
            let gx0 = s as f64 / scale;
            let gx1 = e as f64 / scale;
            let mut left: Vec<Line> = Vec::new();
            let mut right: Vec<Line> = Vec::new();
            for l in chunk {
                if l.x1 <= gx1 && l.x0 < gx1 {
                    left.push(l);
                } else {
                    right.push(l);
                }
            }
            // left column first
            queue.push(right);
            queue.push(left);
        } else {
            out.push(chunk);
        }
    }
    out
}

/// Removes header/footer lines: repeated across pages, or lone numbers in the
/// page top/bottom bands. Returns surviving lines per page.
pub fn strip_headers_footers(pages_lines: &mut [Vec<Line>], page_height: f64) {
    use std::collections::HashMap;
    if pages_lines.len() < 3 {
        return; // not enough evidence
    }
    let band = page_height * 0.085;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for lines in pages_lines.iter() {
        let mut seen: Vec<String> = Vec::new();
        for l in lines {
            if l.baseline < band || l.baseline > page_height - band {
                let norm = normalize_for_match(&l.text());
                seen.push(norm);
            }
        }
        for s in seen {
            *counts.entry(s).or_insert(0) += 1;
        }
    }
    let threshold = (pages_lines.len() as f64 * 0.4).ceil() as u32;
    for lines in pages_lines.iter_mut() {
        lines.retain(|l| {
            let in_band = l.baseline < band || l.baseline > page_height - band;
            if !in_band {
                return true;
            }
            let norm = normalize_for_match(&l.text());
            if counts.get(&norm).copied().unwrap_or(0) >= threshold {
                return false;
            }
            // pure page numbers
            let t = l.text();
            let compact: String = t.chars().filter(|c| !c.is_whitespace()).collect();
            if !compact.is_empty() && compact.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '·' || c == 'ⅰ' || c == 'i' || c == 'v' || c == 'x') && compact.len() <= 6 {
                return false;
            }
            true
        });
    }
}

fn normalize_for_match(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_digit() { '#' } else { c })
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// Body text size across the document (most common line size).
pub fn body_size(pages_lines: &[Vec<Line>]) -> f64 {
    let mut buckets: Vec<(f64, u32)> = Vec::new();
    let mut weight: Vec<f64> = Vec::new();
    for lines in pages_lines {
        for l in lines {
            let b = (l.size * 2.0).round() / 2.0;
            match buckets.iter_mut().find(|(s, _)| (*s - b).abs() < 0.26) {
                Some((_, c)) => {
                    *c += 1;
                    let wi = buckets.iter().position(|(s, _)| (*s - b).abs() < 0.26).unwrap();
                    weight[wi] += l.x1 - l.x0;
                }
                None => {
                    buckets.push((b, 1));
                    weight.push(l.x1 - l.x0);
                }
            }
        }
    }
    buckets
        .iter()
        .zip(weight.iter())
        .max_by(|(_, w1), (_, w2)| w1.partial_cmp(w2).unwrap())
        .map(|((s, _), _)| *s)
        .unwrap_or(10.0)
}

/// Helper used by structure analysis: fonts of a glyph index.
pub fn font_of<'a>(items: &'a PageItems, g: &Glyph) -> &'a FontInfo {
    &items.fonts[g.font.min(items.fonts.len() - 1)]
}
