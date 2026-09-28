//! Figure handling: raster image extraction (DCT passthrough, Flate→PNG,
//! SMask alpha) and vector-figure clustering → SVG.

use crate::content::{ImageSource, InlineImage, PageItems, Path, PathSeg};
use crate::geom::Rect;
use crate::layout::Line;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use std::io::Write;

pub struct ExtractedFigure {
    /// Bounding box on the page.
    pub bbox: Rect,
    /// Top of the visual row the figure sits in (min y0 over the row's
    /// figures). Side-by-side subfigures share a row top, so the assembly
    /// stream keeps them in reading order instead of hair-splitting y0 order.
    pub row_top: f64,
    /// Relative path of the written asset.
    pub asset: String,
    /// true when produced from vector paths (svg), false for raster.
    pub is_svg: bool,
    /// Alt text: labels claimed from inside a raster figure's box (raster
    /// assets cannot carry text; markdown alt keeps the content reachable
    /// without leaking bare label lines into the text flow).
    pub alt: String,
}

pub struct AssetSink<'a> {
    pub dir: &'a std::path::Path,
    pub page_no: u32,
}

impl<'a> AssetSink<'a> {
    pub fn new(dir: &'a std::path::Path, page_no: u32) -> Self {
        AssetSink { dir, page_no }
    }
}

/// Figures detected on one page plus the flow lines they consumed.
pub struct PageFigures {
    pub figures: Vec<ExtractedFigure>,
    /// Indices into `lines` claimed by figures (labels rendered inside the
    /// figure asset). The caller removes them from the text flow — the same
    /// ownership model tables apply to their rules.
    pub claimed_lines: std::collections::BTreeSet<usize>,
    /// Indices into `items.rules` claimed by figures (drawing strokes inside
    /// a figure's box). Excluded from table detection so a diagram's own
    /// horizontal arrows cannot pass as table row borders.
    pub claimed_rules: std::collections::BTreeSet<usize>,
}

/// True when two boxes touch or lie within `gap` of each other on both axes.
fn within_gap(a: &Rect, b: &Rect, gap: f64) -> bool {
    if a.overlaps(b) {
        return true;
    }
    let dx = (a.x0 - b.x1).max(b.x0 - a.x1);
    let dy = (a.y0 - b.y1).max(b.y0 - a.y1);
    dx < gap && dy < gap
}

/// How much wider than its figure a label may be: a label annotates one
/// drawing, so it scales with the drawing (the attention sub-figure titles are
/// wider than the small images they label) — a paragraph line, which spans the
/// whole text column, is not a label however close it hangs.
fn label_width_limit(region: &Rect, gap: f64) -> f64 {
    2.0 * region.width().max(region.height()) + 2.0 * gap
}

/// Union-find over drawing-ink boxes: two strokes belong to the same figure
/// when they overlap or sit within `gap` of each other on both axes. Groups
/// come out in a deterministic order (by their lowest member index).
fn cluster_boxes(boxes: &[Rect], gap: f64) -> Vec<Vec<usize>> {
    let n = boxes.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, i: usize) -> usize {
        let mut root = i;
        while p[root] != root {
            root = p[root];
        }
        let mut cur = i;
        while p[cur] != root {
            let next = p[cur];
            p[cur] = root;
            cur = next;
        }
        root
    }
    for i in 0..n {
        for j in (i + 1)..n {
            let (bi, bj) = (boxes[i], boxes[j]);
            let dist = (bi.x0 - bj.x1)
                .max(bj.x0 - bi.x1)
                .max(bi.y0 - bj.y1)
                .max(bj.y0 - bi.y1);
            if dist < gap || bi.intersect_area(&bj) > 0.0 || bi.overlaps(&bj) {
                let a = find(&mut parent, i);
                let b = find(&mut parent, j);
                if a != b {
                    parent[a] = b;
                }
            }
        }
    }
    let mut groups: std::collections::BTreeMap<usize, Vec<usize>> = std::collections::BTreeMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    let mut out: Vec<Vec<usize>> = groups.into_values().collect();
    out.sort_by_key(|g| g.first().copied().unwrap_or(usize::MAX));
    out
}

/// Why a candidate figure region is not a figure, if it is not.
fn reject_reason(
    n_paths: usize,
    n_members: usize,
    bbox: &Rect,
    lines: &[Line],
    body: f64,
) -> Option<&'static str> {
    let min_side = 18.0;
    if bbox.width() < min_side || bbox.height() < min_side {
        return Some("too-small");
    }
    if n_members < 3 {
        return Some("few-strokes");
    }
    if n_paths == 0 {
        // A grid of straight rules with no curve, diagonal stroke or fill is a
        // table, not a figure: keeping tables out of the figures is what stops
        // their borders from leaving table detection.
        return Some("no-paths");
    }
    if bbox.height() < body * 1.4 {
        // Rule lines crossing text lines are tables/math, not figures: a
        // cluster whose box is "flat" (height < line height) over text is
        // decoration; skip those.
        let touches_text = lines
            .iter()
            .any(|l| l.bbox().intersect_area(bbox) > 0.3 * bbox.height() * bbox.width().max(1.0));
        if touches_text {
            return Some("flat-over-text");
        }
    }
    None
}

/// One figure's own ink: the connected strokes it is made of, as indices into
/// the page's paths and rules, with the box they span (labels included) and
/// the indices of the text runs that belong to it.
struct FigureInk {
    bbox: Rect,
    paths: Vec<usize>,
    rules: Vec<usize>,
    labels: Vec<usize>,
}

/// One claimable piece of figure text: a word of a flow line, or a run of
/// non-horizontal glyphs. Positions are page space (y down).
struct TextRun {
    bbox: Rect,
    /// Baseline origin.
    x: f64,
    y: f64,
    text: String,
    size: f64,
    /// Baseline direction (unit vector, page space): `(1, 0)` for flow words,
    /// the measured direction for rotated runs.
    dir: (f64, f64),
    /// Owning flow line, when the run came from one (drives the flow guards).
    line: Option<usize>,
}

impl TextRun {
    fn angle_deg(&self) -> f64 {
        self.dir.1.atan2(self.dir.0).to_degrees()
    }

    /// True when this run can be a figure label at all: real text, no bigger
    /// than body size, not a caption, and not part of a paragraph. This is the
    /// coarse gate; whether a figure actually owns it is decided per figure.
    fn is_label_text(&self, lines: &[Line], line_caption: &[bool], body: f64) -> bool {
        if self.text.trim().is_empty() || self.size <= 0.0 || self.size > body * 1.15 {
            return false;
        }
        let caption = self
            .line
            .map(|li| line_caption.get(li).copied().unwrap_or(false))
            .unwrap_or(false);
        if caption || is_caption_line(&self.text) {
            return false;
        }
        !self.line.map(|li| flow_attached(li, lines, body)).unwrap_or(false)
    }
}

/// The figure's strokes that run THROUGH the line: a stroke overlaps the
/// line's text band, lies in the line's horizontal neighbourhood, and is
/// local to it.
///
/// This is what separates a diagram's own row — the arrows are drawn inside
/// the span its labels leave — from a drawing elsewhere on the same baseline:
/// a stroke that spans the line end to end is a rule under the text, not a
/// row of the drawing.
fn crossing_strokes(
    ink: &FigureInk,
    boxes: &[Rect],
    n_paths: usize,
    line: &Line,
    gap: f64,
) -> Vec<Rect> {
    let band = Rect { x0: line.x0, y0: line.top - 1.0, x1: line.x1, y1: line.bottom + 1.0 };
    // Strokes spanning the line are not the line's own row: a diagram arrow is
    // local to the whitespace it is drawn in, a rule under text is not.
    let span_limit = 0.6 * band.width().max(12.0);
    let mut out: Vec<Rect> = Vec::new();
    let mut take = |b: Rect| {
        if b.y0 > band.y1 || b.y1 < band.y0 {
            return;
        }
        let dx = (b.x0 - band.x1).max(band.x0 - b.x1);
        if dx > gap || b.width() > span_limit {
            return;
        }
        out.push(b);
    };
    for &pi in &ink.paths {
        take(boxes[pi]);
    }
    for &ri in &ink.rules {
        take(boxes[n_paths + ri]);
    }
    out
}

/// A run that reads as a word: it contains a run of three or more ASCII
/// letters ("the", "Mod", "qcoh"). A row made of such words is prose, however
/// it is wrapped — a diagram row's labels are symbols and short tags.
fn word_run(text: &str) -> bool {
    let mut run = 0usize;
    for c in text.chars() {
        if c.is_ascii_alphabetic() {
            run += 1;
            if run >= 3 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// True when the row carries a counted-out sentence rather than the labels of
/// a drawing.
fn prose_row(runs: &[&TextRun]) -> bool {
    runs.iter().filter(|r| word_run(&r.text)).count() >= 3
}

/// The figure's own ink box (the strokes alone, without the labels the region
/// has grown over), the scale its labels are placed at.
fn ink_member_box(ink: &FigureInk, boxes: &[Rect], n_paths: usize) -> Rect {
    let mut b = Rect::empty();
    for &pi in &ink.paths {
        b.union(&boxes[pi]);
    }
    for &ri in &ink.rules {
        b.union(&boxes[n_paths + ri]);
    }
    b
}

/// True when every run of the row lies within `reach` of the row's own
/// strokes, chained outwards through the row's content.
///
/// A display equation's number sits at the right margin and shares its
/// baseline with whatever diagram the display holds; it is a text element, and
/// the drawing's own scale is what tells it apart from the diagram's labels:
/// a label lies inside the drawing, a number a whole column away does not.
fn row_reaches_strokes(strokes: &[Rect], runs: &[&TextRun], reach: f64) -> bool {
    let mut lo = f64::MAX;
    let mut hi = f64::MIN;
    for s in strokes {
        lo = lo.min(s.x0);
        hi = hi.max(s.x1);
    }
    let mut left: Vec<&TextRun> = runs.to_vec();
    loop {
        let mut grew = false;
        let mut still: Vec<&TextRun> = Vec::with_capacity(left.len());
        for r in left {
            let gap = (r.bbox.x0 - hi).max(lo - r.bbox.x1);
            if gap <= reach {
                lo = lo.min(r.bbox.x0);
                hi = hi.max(r.bbox.x1);
                grew = true;
            } else {
                still.push(r);
            }
        }
        left = still;
        if !grew {
            break;
        }
    }
    left.is_empty()
}

/// Detects figures (raster + vector) on a page and writes their assets.
///
/// Model: a figure is a connected region of drawing INK — both the painted
/// paths and the thin axis-aligned rules (a commutative diagram is mostly
/// straight h/v strokes; leaving those out of the clustering shredded one
/// diagram into several arrowhead-sized figures whose labels fell outside
/// every box). Raster images are first-class figures of their own.
///
/// Figure TEXT is claimed per text RUN (one word with its own box, size and
/// baseline direction — including rotated runs, which flow lines never see),
/// and each run is rendered at its own position, so labels keep their places
/// instead of collapsing into one line-wide string.
///
/// A diagram's labels do not all lie inside its ink: they sit in the whitespace
/// the arrows leave, on the drawing's own rows, which the text pipeline reads
/// as a stack of lines (a paragraph). Those rows are claimed as ROWS — the
/// whole line, like every other claim — so a figure never takes half a row and
/// the row never leaks into the flow as a stray label line beside the asset.
pub fn extract_figures(
    doc: &lopdf::Document,
    items: &PageItems,
    lines: &[Line],
    body_size: f64,
    sink: &mut AssetSink,
    warnings: &mut Vec<String>,
) -> PageFigures {
    let fig_debug = std::env::var("PDF2MD_FIG_DEBUG").ok();
    let dbg_page = fig_debug.as_deref().and_then(|s| s.parse::<u32>().ok());
    if dbg_page == Some(sink.page_no) {
        eprintln!(
            "[figdbg] page {} paths={} images={} rules={}",
            sink.page_no,
            items.paths.len(),
            items.images.len(),
            items.rules.len()
        );
        for (i, r) in items.rules.iter().enumerate() {
            eprintln!(
                "[figdbg]   rule[{}] ({:.1},{:.1})-({:.1},{:.1})",
                i, r.rect.x0, r.rect.y0, r.rect.x1, r.rect.y1
            );
        }
    }

    // ---- cluster the page's drawing INK by bbox proximity (union-find) ----
    // Ink is paths AND rules: a commutative diagram is drawn almost entirely
    // as straight h/v strokes, which the rule classifier (correctly) takes for
    // rules. Clustering paths alone left one diagram as several fragments the
    // size of an arrowhead, their labels outside every fragment's box.
    // Raster images never join clusters: each is its own figure asset.
    let mut boxes: Vec<Rect> = Vec::new();
    for p in &items.paths {
        if !p.fill && !p.stroke {
            continue;
        }
        // ignore huge background rects (page-filling panels)
        if p.bbox.width() > items.page_width * 0.98 && p.bbox.height() > items.page_height * 0.95 {
            continue;
        }
        boxes.push(p.bbox);
    }
    let n_paths = boxes.len();
    for r in &items.rules {
        if r.rect.width() > items.page_width * 0.98 && r.rect.height() > items.page_height * 0.95 {
            continue;
        }
        boxes.push(r.rect);
    }
    // ---- text runs: flow words + rotated runs ----
    // Both are claimable text: the unit is the RUN, so a baseline shared by
    // several diagram labels yields one <text> per label at its own position,
    // and each run goes to the figure that actually CONTAINS it.
    let line_caption: Vec<bool> = lines.iter().map(|l| is_caption_line(&l.text())).collect();
    let mut runs: Vec<TextRun> = Vec::new();
    let mut line_words: Vec<Vec<usize>> = vec![Vec::new(); lines.len()];
    for (li, l) in lines.iter().enumerate() {
        for w in &l.words {
            let bbox = w.bbox();
            if w.text.trim().is_empty() || bbox.is_empty() {
                continue;
            }
            // A word can mix sizes: a subscript or superscript inside a label
            // ("G_T", "U″") is one Word whose glyphs sit at several baselines.
            // Each size class gets its own run at its own origin, so the label
            // keeps the original's sizes and sub/superscript positions.
            let pieces = word_pieces(&items.glyphs, l, w);
            let split_text: String = pieces.iter().map(|p| p.text.as_str()).collect();
            if pieces.len() > 1 && split_text == w.text {
                for mut p in pieces {
                    p.line = Some(li);
                    line_words[li].push(runs.len());
                    runs.push(p);
                }
                continue;
            }
            line_words[li].push(runs.len());
            runs.push(TextRun {
                bbox,
                x: w.x0,
                y: w.y1 - w.size * 0.24,
                text: w.text.clone(),
                size: w.size,
                dir: (1.0, 0.0),
                line: Some(li),
            });
        }
    }
    for glyph_run in rotated_runs(&items.rotated) {
        runs.push(glyph_run);
    }

    let _n = boxes.len();
    // Merging scale, in document units: strokes of one figure are joined by
    // gaps smaller than about one and a half text lines (diagram arrows are
    // drawn with a gap where they cross), while separate figures on a page are
    // set off by a full blank band (a caption or a paragraph line).
    let gap_limit = (body_size * 1.6).max(12.0);
    let clusters = cluster_boxes(&boxes, gap_limit);
    let cluster_span: Vec<Rect> = clusters
        .iter()
        .map(|m| {
            let mut b = Rect::empty();
            for &i in m {
                b.union(&boxes[i]);
            }
            b
        })
        .collect();

    // ---- a figure's own labels sit IN its drawing ----
    // An arrow stops where its label starts, so a diagram is often drawn as
    // stroke groups separated by exactly the text between them (cartier p40's
    // lower square: the left arrow and the dashed top arrow are 30pt apart,
    // with the label filling the gap). A label box therefore EXTENDS the
    // region it lies in and BRIDGES the groups it separates.
    //
    // Only detached, label-sized text may do so: a caption belongs to the text
    // flow, and a body line — however close it hangs — is not a label. The
    // width bound is what separates them: a label is local to its figure, a
    // paragraph line spans the column.
    let mut group_of: Vec<usize> = (0..clusters.len()).collect();
    fn find_group(g: &mut Vec<usize>, i: usize) -> usize {
        let mut r = i;
        while g[r] != r {
            r = g[r];
        }
        let mut c = i;
        while g[c] != r {
            let next = g[c];
            g[c] = r;
            c = next;
        }
        r
    }
    let mut cluster_labels: Vec<Vec<usize>> = vec![Vec::new(); clusters.len()];
    for (ri, run) in runs.iter().enumerate() {
        if run.bbox.is_empty() || !run.is_label_text(lines, &line_caption, body_size) {
            continue;
        }
        let touching: Vec<usize> = (0..clusters.len())
            .filter(|&k| {
                let span = cluster_span[k];
                within_gap(&span, &run.bbox, gap_limit)
                    && run.bbox.width() <= label_width_limit(&span, gap_limit)
            })
            .collect();
        for &k in &touching {
            cluster_labels[k].push(ri);
        }
        for w in touching.windows(2) {
            let a = find_group(&mut group_of, w[0]);
            let b = find_group(&mut group_of, w[1]);
            if a != b {
                group_of[a] = b;
            }
        }
    }
    // Aggregate the merged groups: their ink (the figure's strokes) and their
    // labels (the text that belongs to the figure).
    let mut group_members: std::collections::BTreeMap<usize, Vec<usize>> = Default::default();
    for k in 0..clusters.len() {
        let root = find_group(&mut group_of, k);
        group_members.entry(root).or_default().extend_from_slice(&clusters[k]);
    }
    let mut group_labels: std::collections::BTreeMap<usize, Vec<usize>> = Default::default();
    for k in 0..clusters.len() {
        let root = find_group(&mut group_of, k);
        for &ri in &cluster_labels[k] {
            let e = group_labels.entry(root).or_default();
            if !e.contains(&ri) {
                e.push(ri);
            }
        }
    }

    // ---- plausibility gates ----
    // Each accepted figure keeps the exact ink it owns: its own strokes are
    // rendered into the SVG and are excluded from table detection. Its label
    // runs are recorded with it, so the region and the claim cannot drift
    // apart.
    let mut inks: Vec<FigureInk> = Vec::new();
    for (root, members) in &group_members {
        let mut ink_box = Rect::empty();
        let mut paths: Vec<usize> = Vec::new();
        let mut rules: Vec<usize> = Vec::new();
        for &m in members {
            ink_box.union(&boxes[m]);
            if m < n_paths {
                paths.push(m);
            } else {
                rules.push(m - n_paths);
            }
        }
        if ink_box.is_empty() {
            continue;
        }
        let rejected = reject_reason(paths.len(), members.len(), &ink_box, lines, body_size);
        // The region is the ink PLUS the labels that belong to it.
        let mut region = ink_box;
        let mut labels: Vec<usize> = group_labels.remove(root).unwrap_or_default();
        labels.sort_unstable();
        for &ri in &labels {
            region.union(&runs[ri].bbox);
        }
        if dbg_page == Some(sink.page_no) {
            eprintln!(
                "[figdbg]   cluster paths={} rules={} labels={} ink=({:.1},{:.1})-({:.1},{:.1}) {}",
                paths.len(),
                rules.len(),
                labels.len(),
                ink_box.x0,
                ink_box.y0,
                ink_box.x1,
                ink_box.y1,
                if rejected.is_none() { "ACCEPT" } else { rejected.unwrap() }
            );
            if rejected.is_none() {
                for &m in members {
                    eprintln!(
                        "[figdbg]     ink[{}] ({:.1},{:.1})-({:.1},{:.1})",
                        m, boxes[m].x0, boxes[m].y0, boxes[m].x1, boxes[m].y1
                    );
                }
            }
        }
        if rejected.is_none() {
            inks.push(FigureInk { bbox: region, paths, rules, labels });
        }
    }
    // Deterministic figure order: by box position.
    inks.sort_by(|a, b| {
        (a.bbox.y0, a.bbox.x0)
            .partial_cmp(&(b.bbox.y0, b.bbox.x0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // ---- raster figures: every placed image is a figure ----
    let mut raster_boxes: Vec<Rect> = Vec::new();
    let mut raster_img_idx: Vec<usize> = Vec::new();
    for (i, img) in items.images.iter().enumerate() {
        if img.bbox.width() >= 2.0 && img.bbox.height() >= 2.0 {
            raster_boxes.push(img.bbox);
            raster_img_idx.push(i);
        }
    }

    // ---- deterministic reading order (row grouping, then left-to-right) ----
    // Names and markdown order must not depend on HashMap iteration order.
    let mut all_boxes: Vec<Rect> = Vec::new();
    all_boxes.extend_from_slice(&raster_boxes);
    all_boxes.extend_from_slice(&inks.iter().map(|i| i.bbox).collect::<Vec<_>>());
    let (order, row_top_of) = reading_order(&all_boxes);
    let n_raster = raster_boxes.len();

    // ---- the rows a figure's drawing crosses ----
    // A commutative diagram is laid out by its drawing: its labels sit in the
    // whitespace the arrows leave, on the drawing's own rows. Those rows are
    // then several separate lines sharing a baseline, and the text pipeline
    // reads a stack of them as a paragraph — which vetoes every label that is
    // not strictly inside the ink box — while the all-or-nothing line rule
    // drops the whole row, so the diagram renders with NO labels at all and
    // its text leaks into the flow as stray display-math blocks (cartier
    // p67/p5/p63/p61/p62).
    //
    // The drawing's rows are found geometrically, from the drawing itself: a
    // line is one of the figure's rows when one of the figure's strokes runs
    // THROUGH it (overlaps the line's text band, is local to its span). What
    // must NOT be claimed is prose: a sentence that happens to share its
    // baseline with a drawing — or to sit inside its box — stays in the text,
    // accents and all, so the claim is gated on the row's KIND (a row of
    // words is a text row, a caption's continuation line is caption text),
    // never on how close the drawing hangs.
    let mut row_owner: Vec<Option<usize>> = vec![None; lines.len()];
    let mut row_dist: Vec<f64> = vec![f64::MAX; lines.len()];
    // Rows the per-run pass already owns in full (every word claimed by some
    // figure): they leave the flow as they are and need no rescue.
    let pre_owned: Vec<bool> = (0..lines.len())
        .map(|li| {
            !line_words[li].is_empty()
                && line_words[li].iter().all(|&ri| {
                    let run = &runs[ri];
                    order.iter().any(|&f| {
                        figure_claims_run(
                            &all_boxes[f],
                            run,
                            lines,
                            &line_caption,
                            body_size,
                            items.page_width,
                            items.page_height,
                        )
                    })
                })
        })
        .collect();
    for (vi, ink) in inks.iter().enumerate() {
        let fidx = n_raster + vi;
        let fbox = all_boxes[fidx];
        // A page-dominating figure never claims the text layer.
        if fbox.width() > items.page_width * 0.9 || fbox.height() > items.page_height * 0.9 {
            continue;
        }
        let ink_box = ink_member_box(ink, &boxes, n_paths);
        let reach = ink_box.width().max(ink_box.height()).max(3.0 * body_size).max(12.0);
        for (li, l) in lines.iter().enumerate() {
            // Captions belong to the text flow — including the continuation
            // lines of a wrapped caption, which a figure's box crosses.
            if line_caption[li]
                || is_caption_line(&l.text())
                || in_caption_block(li, lines, &line_caption, body_size)
            {
                continue;
            }
            let lruns: Vec<&TextRun> = line_words[li].iter().map(|&ri| &runs[ri]).collect();
            // Headings and body-size-only rows: a crossed heading is not a
            // figure row, and neither is a row carrying text bigger than body.
            if lruns.is_empty() || lruns.iter().any(|r| r.size <= 0.0 || r.size > body_size * 1.15) {
                continue;
            }
            // A row whose words are already all claimed needs no rescue: its
            // labels render in the figures that own them, and growing a region
            // over such a row only pulls a neighbouring subfigure's half of the
            // row into this figure's viewBox. A row of prose belongs to the
            // text however close the drawing hangs: its own accent bars are
            // text ink, not the drawing's strokes, and a sentence has no place
            // in an asset.
            if pre_owned[li] || prose_row(&lruns) {
                continue;
            }
            let strokes = crossing_strokes(ink, &boxes, n_paths, l, gap_limit);
            if strokes.is_empty() || !row_reaches_strokes(&strokes, &lruns, reach) {
                continue;
            }
            // The nearest drawing wins the row when two share it.
            let (cx, cy) = fbox.center();
            let (lx, ly) = l.bbox().center();
            let d = ((cx - lx).powi(2) + (cy - ly).powi(2)).sqrt();
            if d < row_dist[li] {
                row_dist[li] = d;
                row_owner[li] = Some(fidx);
            }
        }
    }
    // The region grows over its own rows before the per-run pass runs: a label
    // that hangs outside the ink box (the source object of an arrow, a
    // subscript at the row's end) is then inside the region's reach too.
    for li in 0..lines.len() {
        if let Some(f) = row_owner[li] {
            all_boxes[f].union(&lines[li].bbox());
        }
    }
    if dbg_page == Some(sink.page_no) {
        for li in 0..lines.len() {
            let Some(f) = row_owner[li] else { continue };
            let l = &lines[li];
            eprintln!(
                "[figdbg]   row-claimed line{} y={:.1} x={:.1}..{:.1} sz={:.1} fig=({:.1},{:.1})-({:.1},{:.1}) {:?}",
                li, l.baseline, l.x0, l.x1, l.size,
                all_boxes[f].x0, all_boxes[f].y0, all_boxes[f].x1, all_boxes[f].y1,
                l.text()
            );
        }
    }

    // ---- assign every run to at most one figure ----
    // A run the label closure already bound to a figure belongs to it; the
    // claim test still has the last word (a side stamp can lie within gap of a
    // figure without being inside it).
    let mut run_owner: Vec<Option<usize>> = vec![None; runs.len()];
    for (vi, ink) in inks.iter().enumerate() {
        for &ri in &ink.labels {
            if run_owner[ri].is_none() {
                run_owner[ri] = Some(n_raster + vi);
            }
        }
    }
    let mut run_figure: Vec<Option<usize>> = vec![None; runs.len()];
    for (ri, run) in runs.iter().enumerate() {
        let owner = run_owner[ri].filter(|&f| {
            figure_claims_run(&all_boxes[f], run, lines, &line_caption, body_size, items.page_width, items.page_height)
        });
        run_figure[ri] = match owner {
            Some(f) => Some(f),
            None => {
                let mut best: Option<(usize, f64, f64)> = None; // (figure, key, tie)
                for &fidx in order.iter() {
                    let fbox = all_boxes[fidx];
                    if !figure_claims_run(&fbox, run, lines, &line_caption, body_size, items.page_width, items.page_height) {
                        continue;
                    }
                    // Prefer the box that actually encloses the run (smallest
                    // such box), then the nearest one — a label between two
                    // subfigures belongs to the drawing it sits in, not to its
                    // left neighbour.
                    let contains = fbox.contains_rect(&run.bbox);
                    let (cx, cy) = fbox.center();
                    let (rx, ry) = run.bbox.center();
                    let dist = ((cx - rx).powi(2) + (cy - ry).powi(2)).sqrt();
                    let key = if contains { 0.0 } else { 1.0 };
                    let candidate = (fidx, key, dist);
                    best = match best {
                        None => Some(candidate),
                        Some(prev) => {
                            let prev_better = (prev.1, prev.2) <= (candidate.1, candidate.2);
                            Some(if prev_better { prev } else { candidate })
                        }
                    };
                }
                best.map(|(fidx, _, _)| fidx)
            }
        };
    }
    // Ownership is all-or-nothing per LINE: a figure either owns a label line
    // (every word of it) or leaves it whole in the text flow. Claiming single
    // words of a body line would print them twice — once in the asset, once in
    // the paragraph — and tear the paragraph apart.
    //
    // A row the figure's drawing crosses is the figure's OWN row, so the whole
    // row goes to it: the labels render at their places inside the asset and
    // the row leaves the flow instead of surfacing beside the figure as a
    // stray display-math block. Runs another figure already claimed keep their
    // owner (side-by-side subfigures share a baseline across a row).
    for li in 0..lines.len() {
        let Some(f) = row_owner[li] else { continue };
        for &ri in &line_words[li] {
            if run_figure[ri].is_none() {
                run_figure[ri] = Some(f);
            }
        }
    }
    let mut line_owned = vec![true; lines.len()];
    for li in 0..lines.len() {
        for &ri in &line_words[li] {
            if run_figure[ri].is_none() {
                line_owned[li] = false;
                break;
            }
        }
        if line_words[li].is_empty() {
            line_owned[li] = false;
        }
    }
    if dbg_page == Some(sink.page_no) {
        for (ri, run) in runs.iter().enumerate() {
            if run_figure[ri].is_some() {
                continue;
            }
            // Why the runs that stayed in the flow were not claimed: the
            // closure verdict against the nearest enclosing candidate box.
            let mut verdict = "no-candidate";
            let mut best = f64::MAX;
            for &fidx in order.iter() {
                let fbox = all_boxes[fidx];
                let (cx, cy) = fbox.center();
                let (rx, ry) = run.bbox.center();
                let d = ((cx - rx).powi(2) + (cy - ry).powi(2)).sqrt();
                if d < best {
                    best = d;
                    verdict = claim_verdict(&fbox, run, lines, &line_caption, body_size, items.page_width, items.page_height)
                        .unwrap_or("CLAIMED-nearest");
                }
            }
            let owner = run.line.map(|li| format!("line{}", li)).unwrap_or_else(|| "rot".into());
            eprintln!(
                "[figdbg]   unclaimed run ({:.1},{:.1})-({:.1},{:.1}) sz={:.1} {} {:?} -> {} (d={:.1})",
                run.bbox.x0, run.bbox.y0, run.bbox.x1, run.bbox.y1, run.size, owner, run.text, verdict, best
            );
        }
        for (li, l) in lines.iter().enumerate() {
            if line_owned[li] {
                continue;
            }
            let stray: Vec<String> = line_words[li]
                .iter()
                .filter(|&&ri| run_figure[ri].is_none())
                .map(|&ri| format!("{:?}", runs[ri].text))
                .collect();
            let is_claimed: Vec<String> = line_words[li]
                .iter()
                .filter(|&&ri| run_figure[ri].is_some())
                .map(|&ri| format!("{:?}", runs[ri].text))
                .collect();
            if is_claimed.is_empty() {
                continue;
            }
            eprintln!(
                "[figdbg]   line{} y={:.1} x={:.1}..{:.1} sz={:.1} PARTLY-CLAIMED stray={:?} claimed={:?} text={:?}",
                li, l.baseline, l.x0, l.x1, l.size, stray, is_claimed, l.text()
            );
        }
    }
    let mut claimed_runs: Vec<Vec<usize>> = vec![Vec::new(); all_boxes.len()];
    let mut claimed_set = std::collections::BTreeSet::new();
    for (ri, run) in runs.iter().enumerate() {
        let Some(fidx) = run_figure[ri] else { continue };
        match run.line {
            Some(li) if !line_owned[li] => continue,
            Some(li) => {
                claimed_set.insert(li);
            }
            None => {}
        }
        claimed_runs[fidx].push(ri);
    }

    // ---- the drawing strokes a figure owns ----
    // A figure's own horizontal arrows/strokes sit in whitespace between
    // text rows — exactly where table row borders live. Without ownership
    // they resurface as table rules and shred the surrounding paragraph
    // into a fake table. Ownership is exact: a stroke belongs to the figure
    // whose ink it is connected to (plus the strokes an accepted figure's box
    // encloses, so a rule crossing a figure never reappears as a table row).
    let mut claimed_rules_set = std::collections::BTreeSet::new();
    for &fidx in order.iter() {
        if fidx >= n_raster {
            for &ri in &inks[fidx - n_raster].rules {
                claimed_rules_set.insert(ri);
            }
        }
        let fbox = all_boxes[fidx];
        for (ri, r) in items.rules.iter().enumerate() {
            if claimed_rules_set.contains(&ri) {
                continue;
            }
            let rect = r.rect;
            // Rules are thin (often zero-height), so their AREA is ~0 and an
            // area-overlap test never fires. Measure coverage along the long
            // axis instead, with the short axis required to cross the box.
            let (rw, rh) = (rect.width(), rect.height());
            let span = |a0: f64, a1: f64, b0: f64, b1: f64| (a1.min(b1) - a0.max(b0)).max(0.0);
            let (covered, short_inside) = if rw >= rh {
                (
                    span(rect.x0, rect.x1, fbox.x0, fbox.x1) / rw.max(1e-6),
                    rect.y0 + rh / 2.0 >= fbox.y0 && rect.y0 + rh / 2.0 <= fbox.y1,
                )
            } else {
                (
                    span(rect.y0, rect.y1, fbox.y0, fbox.y1) / rh.max(1e-6),
                    rect.x0 + rw / 2.0 >= fbox.x0 && rect.x0 + rw / 2.0 <= fbox.x1,
                )
            };
            if covered >= 0.6 && short_inside {
                claimed_rules_set.insert(ri);
            }
        }
    }
    if dbg_page == Some(sink.page_no) {
        eprintln!("[figdbg]   claimed rules: {:?}", claimed_rules_set);
        eprintln!("[figdbg]   claimed lines: {:?}", claimed_set);
        for (fi, &fidx) in order.iter().enumerate() {
            if claimed_runs[fidx].is_empty() {
                continue;
            }
            eprintln!(
                "[figdbg]   fig#{} bbox=({:.1},{:.1})-({:.1},{:.1}) claims {} runs:",
                fi, all_boxes[fidx].x0, all_boxes[fidx].y0, all_boxes[fidx].x1, all_boxes[fidx].y1,
                claimed_runs[fidx].len()
            );
            for &ri in &claimed_runs[fidx] {
                let r = &runs[ri];
                eprintln!(
                    "[figdbg]     run ({:.1},{:.1})-({:.1},{:.1}) sz={:.1} {:?}",
                    r.bbox.x0, r.bbox.y0, r.bbox.x1, r.bbox.y1, r.size, r.text
                );
            }
        }
    }

    // ---- write raster assets (their own files, referenced directly) ----
    let dir = sink.dir;
    let mut raster_names: Vec<Option<String>> = vec![None; items.images.len()];
    let mut raster_seq = 0u32;
    let mut raster_written = vec![false; all_boxes.len()];
    for &fidx in order.iter() {
        if fidx >= n_raster {
            continue;
        }
        let img_idx = raster_img_idx[fidx];
        let img = &items.images[img_idx];
        raster_seq += 1;
        let base = format!("p{}-img{}", sink.page_no, raster_seq);
        let src = match &img.source {
            ImageSource::XObject(rid) => match raster_to_file(doc, *rid, dir, &base) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("raster figure failed: {}", e);
                    None
                }
            },
            ImageSource::Inline(inline) => inline_to_file(inline, dir, &base),
        };
        match src {
            Some(name) => {
                raster_names[img_idx] = Some(name);
                raster_written[fidx] = true;
            }
            None => {
                let w = format!("page {}: image skipped (unsupported encoding)", sink.page_no);
                if !warnings.contains(&w) {
                    warnings.push(w);
                }
            }
        }
    }

    // ---- assemble figures in reading order (alt = claimed labels for rasters) ----
    let mut vector_seq = 0u32;
    let mut figures: Vec<ExtractedFigure> = Vec::new();
    for &fidx in order.iter() {
        let bbox = all_boxes[fidx];
        let mut labels: Vec<&TextRun> = claimed_runs[fidx].iter().map(|&ri| &runs[ri]).collect();
        // Reading order inside the figure: top to bottom, left to right.
        labels.sort_by(|a, b| {
            (a.bbox.y0, a.bbox.x0)
                .partial_cmp(&(b.bbox.y0, b.bbox.x0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if fidx < n_raster {
            if raster_written[fidx] {
                let img_idx = raster_img_idx[fidx];
                let asset = raster_names[img_idx].clone().expect("written raster has a name");
                let alt = alt_from_labels(&labels);
                let row_top = row_top_of[fidx];
                figures.push(ExtractedFigure { bbox, row_top, asset, is_svg: false, alt });
            }
        } else {
            vector_seq += 1;
            // The SVG's viewBox must cover the claimed labels too — a
            // sub-figure title above the drawing sits outside the drawn
            // paths' box and would be clipped invisible otherwise.
            let ink = &inks[fidx - n_raster];
            let mut full_bbox = bbox;
            for l in &labels {
                full_bbox.union(&l.bbox);
            }
            let name = format!("p{}-fig{}.svg", sink.page_no, vector_seq);
            let path = dir.join(&name);
            let raster_name = |i: usize| raster_names.get(i).cloned().flatten();
            match write_figure_svg(items, ink, &labels, &full_bbox, &path, raster_name) {
                Ok(()) => {
                    let row_top = row_top_of[fidx];
                    figures.push(ExtractedFigure { bbox: full_bbox, row_top, asset: name, is_svg: true, alt: String::new() })
                }
                Err(e) => {
                    eprintln!("svg figure failed: {}", e);
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    PageFigures { figures, claimed_lines: claimed_set, claimed_rules: claimed_rules_set }
}

/// Splits one word into size-homogeneous runs, using the line's glyphs: a
/// subscript keeps its smaller size and lower baseline instead of being
/// flattened onto the word's dominant baseline. The caller checks that the
/// pieces' text reconstructs the word exactly and falls back to the whole word
/// otherwise, so a missing glyph can never lose characters.
fn word_pieces(glyphs: &[crate::content::Glyph], line: &Line, word: &crate::layout::Word) -> Vec<TextRun> {
    let box_ = word.bbox();
    let mut own: Vec<&crate::content::Glyph> = Vec::new();
    for &gi in &line.glyph_ids {
        let Some(g) = glyphs.get(gi) else { continue };
        let gb = g.bbox();
        if gb.x0 >= box_.x0 - 0.5 && gb.x1 <= box_.x1 + 0.5 && gb.y0 >= box_.y0 - 0.5 && gb.y1 <= box_.y1 + 0.5 {
            own.push(g);
        }
    }
    own.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    let mut pieces: Vec<Vec<&crate::content::Glyph>> = Vec::new();
    for g in own {
        match pieces.last_mut() {
            Some(p) if (p[0].size - g.size).abs() <= 0.5 => p.push(g),
            _ => pieces.push(vec![g]),
        }
    }
    pieces
        .into_iter()
        .map(|ps| {
            let mut bbox = Rect::empty();
            let mut text = String::new();
            for g in &ps {
                bbox.union(&g.bbox());
                text.push_str(&g.text);
            }
            TextRun {
                bbox,
                x: ps[0].x,
                y: ps[0].y,
                text,
                size: ps.iter().map(|g| g.size).fold(0.0, f64::max),
                dir: (1.0, 0.0),
                line: None,
            }
        })
        .collect()
}

/// Groups non-horizontal glyphs into text runs: glyphs that share a baseline
/// (same direction, same perpendicular offset, same size) and advance along
/// it with no gap wider than a space. A column of rotated words — the
/// attention word grids' axis labels are 35 of them, 11pt apart — comes out
/// as one run per word at its own position and orientation.
fn rotated_runs(glyphs: &[crate::content::RotatedGlyph]) -> Vec<TextRun> {
    // Sort by (baseline offset, position along the baseline): the glyphs of
    // one baseline then form a contiguous block in reading order.
    let mut order: Vec<usize> = (0..glyphs.len()).collect();
    let perp_of = |g: &crate::content::RotatedGlyph| -g.dir.1 * g.x + g.dir.0 * g.y;
    let along_of = |g: &crate::content::RotatedGlyph| g.dir.0 * g.x + g.dir.1 * g.y;
    order.sort_by(|&a, &b| {
        let (ga, gb) = (&glyphs[a], &glyphs[b]);
        perp_of(ga)
            .partial_cmp(&perp_of(gb))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(along_of(ga).partial_cmp(&along_of(gb)).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.cmp(&b))
    });

    let mut runs: Vec<TextRun> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_end = 0.0f64;
    for &gi in &order {
        let g = &glyphs[gi];
        let along = along_of(g);
        let connected = match cur.last() {
            None => false,
            Some(&pi) => {
                let p = &glyphs[pi];
                let parallel = p.dir.0 * g.dir.0 + p.dir.1 * g.dir.1 > 0.99;
                let same_size = (g.size - p.size).abs() <= p.size * 0.2;
                let same_line = (perp_of(g) - perp_of(p)).abs() <= g.size * 0.35;
                // The gap is measured in BOTH directions: two baselines a
                // hair apart interleave in the sort, and a glyph far behind
                // the run's end is the next column, not the next letter.
                parallel && same_size && same_line && (along - cur_end).abs() <= g.size * 0.5
            }
        };
        if !connected {
            if !cur.is_empty() {
                runs.push(build_rotated_run(glyphs, &cur));
            }
            cur.clear();
            cur_end = f64::MIN;
        }
        cur_end = cur_end.max(along + g.wx);
        cur.push(gi);
    }
    if !cur.is_empty() {
        runs.push(build_rotated_run(glyphs, &cur));
    }
    runs
}

/// One run from its glyphs (already in reading order along the baseline).
fn build_rotated_run(glyphs: &[crate::content::RotatedGlyph], members: &[usize]) -> TextRun {
    let first = &glyphs[members[0]];
    let mut text = String::new();
    let mut bbox = Rect::empty();
    for &mi in members {
        let g = &glyphs[mi];
        text.push_str(&g.text);
        // The glyph body sits perpendicular to the baseline: take the four
        // corners of its advance box (ascent 0.78, descent 0.24 of the size)
        // so the run's box is the ink box, not the baseline.
        let n = (-g.dir.1, g.dir.0);
        for (t, p) in [(0.0, -g.size * 0.78), (g.wx, -g.size * 0.78), (g.wx, g.size * 0.24), (0.0, g.size * 0.24)] {
            bbox.add(g.x + g.dir.0 * t + n.0 * p, g.y + g.dir.1 * t + n.1 * p);
        }
    }
    TextRun {
        bbox,
        x: first.x,
        y: first.y,
        text,
        size: first.size,
        dir: first.dir,
        line: None,
    }
}

/// Markdown alt text from labels claimed by a raster figure.
fn alt_from_labels(labels: &[&TextRun]) -> String {
    let mut out = String::new();
    for l in labels {
        let t = l.text.trim();
        if t.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    // ']' would close the markdown image syntax early.
    out.replace('[', "(").replace(']', ")")
}

/// True when the line reads like a figure/table caption — captions belong to
/// the text flow even when they sit within the claim margin of a figure box.
fn is_caption_line(text: &str) -> bool {
    let t = text.trim_start().to_lowercase();
    ["figure ", "fig. ", "fig ", "table ", "scheme ", "plate "]
        .iter()
        .any(|p| t.starts_with(p))
}

/// A text run belongs to a figure when it sits in the figure's region and is
/// not part of the text flow.
///
/// The unit is the RUN, not the visual line: a baseline shared by several
/// diagram labels must not collapse into one string drawn at the leftmost x.
///
/// Flow text is only ever claimed when the run lies INSIDE the figure's box
/// (a paragraph line crossing a figure is the figure's own overlay, and a
/// lone continuation line 1.5 leading above the box is not a label — the
/// width bound below is what separates the two). Detached text — diagram
/// labels, sub-figure titles — may hang one label-slack outside the box:
/// vertically within a leading of the box's edge, horizontally within the
/// figure's own width plus that slack. A run several times wider than the
/// figure it passes over is a body line, never a label.
fn figure_claims_run(
    fbox: &Rect,
    run: &TextRun,
    lines: &[Line],
    line_caption: &[bool],
    body: f64,
    page_w: f64,
    page_h: f64,
) -> bool {
    claim_verdict(fbox, run, lines, line_caption, body, page_w, page_h).is_none()
}

/// The same decision as `figure_claims_run`, with the reason it failed:
/// `None` = the figure owns the run. Kept as one function so the debug trace
/// can never drift from the production decision.
fn claim_verdict(
    fbox: &Rect,
    run: &TextRun,
    lines: &[Line],
    line_caption: &[bool],
    body: f64,
    page_w: f64,
    page_h: f64,
) -> Option<&'static str> {
    // A page-dominating figure (a scanned page's bitmap) must never swallow
    // the text layer.
    if fbox.width() > page_w * 0.9 || fbox.height() > page_h * 0.9 {
        return Some("page-dominating");
    }
    // Headings and anything bigger than body text are not labels.
    if run.size <= 0.0 || run.size > body * 1.15 {
        return Some("oversize");
    }
    // Glyph runs that decoded to no text (fonts without a unicode mapping)
    // have nothing to render into the asset and nothing to preserve.
    if run.text.trim().is_empty() {
        return Some("empty-text");
    }
    // Captions belong to the text flow: both the run's own text and the text
    // of the line it sits on ("Figure 4: ..." is one caption, not six words).
    let caption = run.line.map(|li| line_caption.get(li).copied().unwrap_or(false)).unwrap_or(false);
    if caption || is_caption_line(&run.text) {
        return Some("caption");
    }
    let mx = 3.0 * body;
    let my = 1.15 * body;
    // Horizontal reach: within the box, or overhanging it by at most one
    // label slack on each side (a subfigure title wider than its drawing).
    if run.bbox.x0 < fbox.x0 - mx || run.bbox.x1 > fbox.x1 + mx {
        return Some("x-outside");
    }
    if run.dir.1.abs() > run.dir.0.abs() {
        // Rotated runs are never flow, so no leading argument applies: they
        // belong to a figure only when the figure's ink encloses them (an
        // arXiv side stamp is a page-edge strip no figure box contains).
        return if fbox.contains_rect(&run.bbox) { None } else { Some("rotated-outside") };
    }
    let inside_box = fbox.contains_rect(&run.bbox);
    let baseline_inside = run.y >= fbox.y0 && run.y <= fbox.y1;
    let flow = run.line.map(|li| flow_attached(li, lines, body)).unwrap_or(false);
    let isolated = run.line.map(|li| line_isolated(li, lines, body)).unwrap_or(true);
    if inside_box {
        return None;
    }
    // What is not inside the box is only a label when it is DETACHED text.
    // Flow text hangs over an edge as a wrapped caption continuation or a
    // paragraph crossing the drawing: that belongs to the text flow.
    let in_caption_block = run.line.map(|li| caption_neighbour(li, lines, line_caption, body)).unwrap_or(false);
    if flow || in_caption_block {
        return Some("flow-text");
    }
    if baseline_inside {
        return None;
    }
    // A detached label may hang one leading past the edge; sub-figure titles
    // hang further above the drawing and additionally must be isolated.
    if run.y >= fbox.y0 - my && run.y <= fbox.y1 + my {
        return None;
    }
    if isolated && run.y >= fbox.y0 - body * 1.7 && run.y <= fbox.y1 {
        return None;
    }
    Some("detached-outside")
}

/// True when the line sits in a caption's block: a caption wraps over several
/// lines, and its continuation lines must stay in the flow even when they
/// physically overlap the figure they belong to.
fn caption_neighbour(line_idx: usize, lines: &[Line], line_caption: &[bool], body: f64) -> bool {
    let line = &lines[line_idx];
    lines.iter().enumerate().any(|(oi, o)| {
        oi != line_idx
            && line_caption.get(oi).copied().unwrap_or(false)
            && (line.baseline - o.baseline).abs() < body * 1.6
            && o.x0 < line.x1
            && o.x1 > line.x0
    })
}

/// True when the line sits in a caption's block: a caption wraps over several
/// lines and every one of them is caption text, so a figure whose ink reaches
/// the caption's last line (attention p14: the image ends 2.5pt above "and 6.
/// Note that the attentions are very sharp...") must not take it.
fn in_caption_block(line_idx: usize, lines: &[Line], line_caption: &[bool], body: f64) -> bool {
    let mut seen: Vec<usize> = vec![line_idx];
    let mut queue: Vec<usize> = vec![line_idx];
    while let Some(ci) = queue.pop() {
        if line_caption.get(ci).copied().unwrap_or(false) {
            return true;
        }
        if seen.len() > 24 {
            break;
        }
        let c = &lines[ci];
        for (oi, o) in lines.iter().enumerate() {
            if seen.contains(&oi) {
                continue;
            }
            // One leading of vertical distance and a shared column: the
            // wrapped continuation of the same block.
            if (c.baseline - o.baseline).abs() < body * 1.6 && o.x0 < c.x1 && o.x1 > c.x0 {
                seen.push(oi);
                queue.push(oi);
            }
        }
    }
    false
}

/// No other line horizontally overlapping this one sits within 1.6 body
/// above or below — i.e. the line is not part of a paragraph.
fn line_isolated(line_idx: usize, lines: &[Line], body: f64) -> bool {
    let line = &lines[line_idx];
    !lines.iter().enumerate().any(|(oi, o)| {
        oi != line_idx
            && (line.baseline - o.baseline).abs() < body * 1.6
            && o.x0 < line.x1
            && o.x1 > line.x0
    })
}

/// True when the line belongs to a text block of ≥3 stacked lines (lines
/// linked by ~1 leading vertical distance and horizontal overlap). A 1-2
/// line detached block is a label; a ≥3 line chain is a paragraph.
fn flow_attached(line_idx: usize, lines: &[Line], body: f64) -> bool {
    let mut chain: Vec<usize> = vec![line_idx];
    loop {
        if chain.len() >= 3 {
            return true;
        }
        let mut next: Vec<usize> = Vec::new();
        for &ci in &chain {
            let c = &lines[ci];
            for (oi, o) in lines.iter().enumerate() {
                if chain.contains(&oi) || next.contains(&oi) {
                    continue;
                }
                if (c.baseline - o.baseline).abs() < body * 1.6 && o.x0 < c.x1 && o.x1 > c.x0 {
                    next.push(oi);
                }
            }
        }
        if next.is_empty() {
            return false;
        }
        chain.extend(next);
    }
}

/// Reading order for page elements: boxes are grouped into visual rows
/// (vertical overlap ≥ half the shorter box), rows go top-to-bottom, boxes
/// within a row left-to-right. Returns indices sorted by (row, x0) plus each
/// box's row top.
fn reading_order(rects: &[Rect]) -> (Vec<usize>, Vec<f64>) {
    let mut by_y: Vec<usize> = (0..rects.len()).collect();
    by_y.sort_by(|&a, &b| rects[a].y0.partial_cmp(&rects[b].y0).unwrap_or(std::cmp::Ordering::Equal));
    let mut row_top: Vec<f64> = Vec::new();
    let mut row_bot: Vec<f64> = Vec::new();
    let mut row_of = vec![0usize; rects.len()];
    for &i in &by_y {
        let r = &rects[i];
        let mut placed = false;
        for ri in 0..row_top.len() {
            let overlap = r.y1.min(row_bot[ri]) - r.y0.max(row_top[ri]);
            let min_h = r.height().min(row_bot[ri] - row_top[ri]).max(1.0);
            if overlap > 0.5 * min_h {
                row_of[i] = ri;
                row_top[ri] = row_top[ri].min(r.y0);
                row_bot[ri] = row_bot[ri].max(r.y1);
                placed = true;
                break;
            }
        }
        if !placed {
            row_top.push(r.y0);
            row_bot.push(r.y1);
            row_of[i] = row_top.len() - 1;
        }
    }
    let mut order: Vec<usize> = (0..rects.len()).collect();
    order.sort_by(|&a, &b| {
        (row_of[a], rects[a].x0)
            .partial_cmp(&(row_of[b], rects[b].x0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut box_row_top = vec![0.0f64; rects.len()];
    for i in 0..rects.len() {
        box_row_top[i] = row_top[row_of[i]];
    }
    (order, box_row_top)
}

/// Writes one figure region as SVG (the ink it owns + linked raster assets +
/// one <text> per claimed run, at the run's own position and orientation).
fn write_figure_svg(
    items: &PageItems,
    ink: &FigureInk,
    labels: &[&TextRun],
    bbox: &Rect,
    path: &std::path::Path,
    raster_name: impl Fn(usize) -> Option<String>,
) -> Result<(), String> {
    // The region was measured on the PDF's glyph boxes, but the labels render
    // in the viewer's own font: give them the room they will actually take, or
    // a label at the region's edge is clipped by the viewBox.
    let mut view = *bbox;
    for l in labels {
        view.union(&rendered_label_box(l));
    }
    let w = view.width().max(1.0);
    let h = view.height().max(1.0);
    let mut svg = String::new();
    svg.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 {:.1} {:.1}\" width=\"{:.0}\" height=\"{:.0}\">\n",
        w, h, w * 2.0, h * 2.0
    ));
    svg.push_str(&format!(
        "<g transform=\"translate({:.2},{:.2})\">\n",
        -view.x0, -view.y0
    ));

    // raster images inside the vector region (annotation over photo): link
    // the standalone asset file, never re-encode it into the SVG.
    for (idx, img) in items.images.iter().enumerate() {
        if !bbox.contains_rect(&img.bbox) {
            continue;
        }
        if let Some(href) = raster_name(idx) {
            svg.push_str(&format!(
                "<image x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" xlink:href=\"{}\" preserveAspectRatio=\"none\"/>\n",
                img.bbox.x0, img.bbox.y0, img.bbox.width(), img.bbox.height(), href
            ));
        }
    }

    // the figure's own painted paths, then its straight strokes (arrow
    // shafts, dashed lines, panel borders) — a diagram drawn with rules was
    // exported as arrowheads-only until the rules became part of the ink.
    for &pi in &ink.paths {
        if let Some(p) = items.paths.get(pi) {
            svg.push_str(&path_to_svg(p));
        }
    }
    for &ri in &ink.rules {
        if let Some(r) = items.rules.get(ri) {
            svg.push_str(&rule_to_svg(r));
        }
    }

    // claimed labels: one <text> per run, in the run's own place
    for l in labels {
        let angle = l.angle_deg();
        if angle.abs() < 0.5 {
            svg.push_str(&format!(
                "<text x=\"{:.1}\" y=\"{:.1}\" font-family=\"sans-serif\" font-size=\"{:.1}\">{}</text>\n",
                l.x,
                l.y,
                l.size,
                xml_escape(&l.text)
            ));
        } else {
            // Rotated run: its own baseline axes (SVG y grows downward, same
            // as page space), so the string advances along the run.
            svg.push_str(&format!(
                "<text x=\"{:.1}\" y=\"{:.1}\" font-family=\"sans-serif\" font-size=\"{:.1}\" transform=\"rotate({:.1} {:.1} {:.1})\">{}</text>\n",
                l.x,
                l.y,
                l.size,
                angle,
                l.x,
                l.y,
                xml_escape(&l.text)
            ));
        }
    }

    svg.push_str("</g>\n</svg>\n");
    std::fs::write(path, svg).map_err(|e| e.to_string())
}

/// The box a label occupies once the viewer renders it: the string advances
/// in the viewport's own font, which is not the font its box was measured in.
/// The measured box is kept too — a viewer's font may be narrower.
fn rendered_label_box(l: &TextRun) -> Rect {
    let advance = 0.62 * l.size * l.text.chars().count() as f64;
    let (up, down) = (0.86 * l.size, 0.32 * l.size);
    let (dx, dy) = l.dir;
    let (nx, ny) = (-dy, dx);
    let mut b = l.bbox;
    for (t, p) in [(0.0, -up), (advance, -up), (advance, down), (0.0, down)] {
        b.add(l.x + dx * t + nx * p, l.y + dy * t + ny * p);
    }
    b
}

/// A straight stroke as a filled zero-height rectangle outline: SVG cannot
/// stroke a zero-length path, and rules are drawn at their exact extent.
fn rule_to_svg(r: &crate::content::Rule) -> String {
    let rect = r.rect;
    let (x0, y0) = (rect.x0, rect.y0);
    let (w, h) = (rect.width(), rect.height());
    let color = color_hex(r.color);
    format!(
        "<rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\" fill=\"{}\"/>\n",
        x0,
        y0,
        w.max(0.3),
        h.max(0.3),
        color
    )
}

fn path_to_svg(p: &Path) -> String {
    let mut d = String::new();
    for seg in &p.segs {
        match seg {
            PathSeg::Move(x, y) => d.push_str(&format!("M{:.2} {:.2} ", x, y)),
            PathSeg::Line(x, y) => d.push_str(&format!("L{:.2} {:.2} ", x, y)),
            PathSeg::Curve(c1, c2, end) => match (c1, c2) {
                (Some((x1, y1)), _) => {
                    d.push_str(&format!("C{:.2} {:.2} {:.2} {:.2} {:.2} {:.2} ", x1, y1, c2.0, c2.1, end.0, end.1))
                }
                (None, _) => {
                    // v-style: first control = current point (unknown here) — approximate with end
                    d.push_str(&format!("S{:.2} {:.2} {:.2} {:.2} ", c2.0, c2.1, end.0, end.1))
                }
            },
            PathSeg::Close => d.push('Z'),
        }
    }
    let fc = color_hex(p.fill_color);
    let sc = color_hex(p.stroke_color);
    let mut attrs = String::new();
    if p.fill {
        attrs.push_str(&format!("fill=\"{}\"", fc));
    } else {
        attrs.push_str("fill=\"none\"");
    }
    if p.stroke {
        attrs.push_str(&format!(" stroke=\"{}\" stroke-width=\"{:.2}\"", sc, p.line_width.max(0.2)));
    }
    format!("<path d=\"{}\" {}/>\n", d.trim(), attrs)
}

fn color_hex(c: (f64, f64, f64)) -> String {
    let (r, g, b) = (
        (c.0.clamp(0.0, 1.0) * 255.0).round() as u8,
        (c.1.clamp(0.0, 1.0) * 255.0).round() as u8,
        (c.2.clamp(0.0, 1.0) * 255.0).round() as u8,
    );
    format!("#{:02X}{:02X}{:02X}", r, g, b)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// --------------------------------------------------------------------------
// Raster extraction
// --------------------------------------------------------------------------

/// Decodes an image XObject and writes it as .jpg/.png under `dir`.
/// `base` is the asset name without extension. Returns the file name to
/// reference (relative), or None if unsupported.
pub fn raster_to_file(
    doc: &lopdf::Document,
    rid: lopdf::ObjectId,
    dir: &std::path::Path,
    base: &str,
) -> Result<Option<String>, String> {
    let obj = doc.get_object(rid).map_err(|e| e.to_string())?;
    let stream = match obj {
        lopdf::Object::Stream(s) => s.clone(),
        _ => return Ok(None),
    };
    let dict = &stream.dict;
    let width = dict.get(b"Width").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    let height = dict.get(b"Height").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    if width == 0 || height == 0 {
        return Ok(None);
    }
    let filters = stream_filters(&stream);
    let data = stream
        .decompressed_content()
        .unwrap_or_else(|_| stream.content.clone());

    // DCT: write jpeg as-is
    if filters.iter().any(|f| f == "DCTDecode") {
        let name = format!("{}.jpg", base);
        std::fs::write(dir.join(&name), &data).map_err(|e| e.to_string())?;
        return Ok(Some(name));
    }
    if filters.iter().any(|f| f == "JPXDecode" || f == "CCITTFaxDecode" || f == "JBIG2Decode") {
        return Ok(None); // unsupported without extra codecs
    }

    let bpc = dict.get(b"BitsPerComponent").and_then(|o| o.as_i64()).unwrap_or(8) as u32;
    let cs = color_space_components(dict, doc);
    let (pixels, channels) = match decode_samples(&data, width, height, bpc, cs.0) {
        Some(v) => v,
        None => return Ok(None),
    };
    // SMask → alpha
    let mut rgba: Option<Vec<u8>> = None;
    if let Ok(Ok(smask_id)) = dict.get(b"SMask").map(|o| o.as_reference()) {
        if let Some(alpha) = decode_smask(doc, smask_id, width, height) {
            let mut with_a = Vec::with_capacity((width * height * 4) as usize);
            for i in 0..(width * height) as usize {
                let px = i * channels;
                with_a.extend_from_slice(&pixels[px..px + channels.min(3)]);
                if channels == 4 {
                    // cmyk already converted to rgb; recompute below
                }
                with_a.push(alpha[i.min(alpha.len() - 1)]);
            }
            rgba = Some(with_a);
        }
    }
    let name = format!("{}.png", base);
    let ok = if let Some(rgba) = rgba {
        write_png(dir.join(&name), width, height, 4, &rgba).is_ok()
    } else {
        match channels {
        1 => write_png(dir.join(&name), width, height, 1, &pixels).is_ok(),
        3 => write_png(dir.join(&name), width, height, 3, &pixels).is_ok(),
        4 => {
            // CMYK → RGB
            let mut rgb = Vec::with_capacity((width * height * 3) as usize);
            for px in pixels.chunks(4) {
                let (c, m, y, k) = (px[0], px[1], px[2], px.get(3).copied().unwrap_or(0));
                rgb.push((255 - c.min(255)).min(255 - k.min(255)));
                rgb.push((255 - m.min(255)).min(255 - k.min(255)));
                rgb.push((255 - y.min(255)).min(255 - k.min(255)));
            }
            write_png(dir.join(&name), width, height, 3, &rgb).is_ok()
        }
        _ => false,
        }
    };
    if ok {
        Ok(Some(name))
    } else {
        Ok(None)
    }
}

fn stream_filters(stream: &lopdf::Stream) -> Vec<String> {
    match stream.dict.get(b"Filter") {
        Ok(lopdf::Object::Name(n)) => vec![String::from_utf8_lossy(n).to_string()],
        Ok(lopdf::Object::Array(a)) => a
            .iter()
            .filter_map(|o| match o {
                lopdf::Object::Name(n) => Some(String::from_utf8_lossy(n).to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Returns (components, is_indexed, palette) for the color space.
fn color_space_components(dict: &lopdf::Dictionary, doc: &lopdf::Document) -> (usize, Option<Vec<u8>>) {
    match dict.get(b"ColorSpace") {
        Ok(lopdf::Object::Name(n)) => match n.as_slice() {
            b"DeviceGray" | b"G" => (1, None),
            b"DeviceRGB" | b"RGB" => (3, None),
            b"DeviceCMYK" | b"CMYK" => (4, None),
            _ => (1, None),
        },
        Ok(lopdf::Object::Array(a)) => {
            let family = a.first().and_then(|o| match o {
                lopdf::Object::Name(n) => Some(n.clone()),
                _ => None,
            });
            match family.as_deref() {
                Some(b"ICBased") => {
                    let n = dict_n_of(&a[1], doc).unwrap_or(3);
                    (n as usize, None)
                }
                Some(b"Indexed") => {
                    // [/Indexed base hival lookup]
                    let lookup = a.get(3).cloned();
                    let palette = match lookup {
                        Some(lopdf::Object::Stream(s)) => s
                            .decompressed_content()
                            .unwrap_or_else(|_| s.content.clone()),
                        Some(lopdf::Object::String(bytes, _)) => bytes.clone(),
                        Some(lopdf::Object::Reference(rid)) => match doc.get_object(rid).ok() {
                            Some(lopdf::Object::Stream(s)) => s
                                .decompressed_content()
                                .unwrap_or_else(|_| s.content.clone()),
                            _ => Vec::new(),
                        },
                        _ => Vec::new(),
                    };
                    (1, Some(palette))
                }
                _ => (3, None),
            }
        }
        _ => (1, None),
    }
}

fn dict_n_of(o: &lopdf::Object, doc: &lopdf::Document) -> Option<i64> {
    match o {
        lopdf::Object::Reference(rid) => doc
            .get_object(*rid)
            .ok()
            .and_then(|obj| obj.as_dict().ok())
            .and_then(|d| d.get(b"N").and_then(|x| x.as_i64()).ok()),
        lopdf::Object::Dictionary(d) => d.get(b"N").and_then(|x| x.as_i64()).ok(),
        _ => None,
    }
}

/// Expands raw samples to 8-bit channels; handles indexed palettes.
fn decode_samples(
    data: &[u8],
    width: u32,
    height: u32,
    bpc: u32,
    channels: usize,
) -> Option<(Vec<u8>, usize)> {
    let expected = (width as usize) * (height as usize);
    if bpc == 8 {
        if data.len() < expected * channels {
            return None;
        }
        let mut out = Vec::with_capacity(expected * channels);
        out.extend_from_slice(&data[..expected * channels]);
        Some((out, channels))
    } else if bpc == 1 && channels == 1 {
        let row_bytes = ((width as usize) + 7) / 8;
        if data.len() < row_bytes * height as usize {
            return None;
        }
        let mut out = Vec::with_capacity(expected);
        for y in 0..height as usize {
            for x in 0..width as usize {
                let byte = data[y * row_bytes + x / 8];
                let bit = (byte >> (7 - (x % 8))) & 1;
                out.push(if bit == 0 { 0 } else { 255 });
            }
        }
        Some((out, 1))
    } else {
        None
    }
}

fn decode_smask(doc: &lopdf::Document, rid: lopdf::ObjectId, width: u32, height: u32) -> Option<Vec<u8>> {
    let obj = doc.get_object(rid).ok()?;
    let stream = match obj {
        lopdf::Object::Stream(s) => s.clone(),
        _ => return None,
    };
    let sw = stream.dict.get(b"Width").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    let sh = stream.dict.get(b"Height").and_then(|o| o.as_i64()).unwrap_or(0) as u32;
    let bpc = stream.dict.get(b"BitsPerComponent").and_then(|o| o.as_i64()).unwrap_or(8) as u32;
    let data = stream.decompressed_content().ok()?;
    if sw == 0 || sh == 0 {
        return None;
    }
    let (pixels, _) = decode_samples(&data, sw, sh, bpc, 1)?;
    // resample to target size (nearest)
    let mut out = Vec::with_capacity((width * height) as usize);
    for y in 0..height {
        let sy = (y * sh / height.max(1)) as usize;
        for x in 0..width {
            let sx = (x * sw / width.max(1)) as usize;
            out.push(pixels[sy * sw as usize + sx]);
        }
    }
    Some(out)
}

// --------------------------------------------------------------------------
// PNG writer (no external image crate)
// --------------------------------------------------------------------------

pub fn write_png(path: std::path::PathBuf, width: u32, height: u32, channels: u32, pixels: &[u8]) -> Result<(), String> {
    if width == 0 || height == 0 || channels == 0 || channels > 4 {
        return Err("bad dims".into());
    }
    let expected = (width as usize) * (height as usize) * (channels as usize);
    if pixels.len() < expected {
        return Err(format!("png: need {} bytes, got {}", expected, pixels.len()));
    }
    // raw scanlines with filter byte 0
    let stride = width as usize * channels as usize;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for y in 0..height as usize {
        raw.push(0u8);
        raw.extend_from_slice(&pixels[y * stride..(y + 1) * stride]);
    }
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&raw).map_err(|e| e.to_string())?;
    let idat = enc.finish().map_err(|e| e.to_string())?;

    let color_type: u8 = match channels {
        1 => 0,
        3 => 2,
        4 => 6,
        _ => return Err("bad channels".into()),
    };
    let mut png = Vec::with_capacity(idat.len() + 128);
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
    write_chunk(&mut png, b"IHDR", &ihdr);
    write_chunk(&mut png, b"IDAT", &idat);
    write_chunk(&mut png, b"IEND", &[]);
    std::fs::write(path, png).map_err(|e| e.to_string())
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, e) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *e = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// Inline images (BI..EI): decode like XObject images.
pub fn inline_to_file(img: &InlineImage, dir: &std::path::Path, base: &str) -> Option<String> {
    let channels = match img.color_space.as_str() {
        "G" | "DeviceGray" | "CalGray" => 1,
        "RGB" | "DeviceRGB" | "CalRGB" => 3,
        "CMYK" | "DeviceCMYK" => 4,
        _ => 1,
    };
    let data = if img.filter.contains("Fl") {
        inflate(&img.data).ok()?
    } else {
        img.data.clone()
    };
    let (pixels, channels) = decode_samples(&data, img.width, img.height, img.bits, channels)?;
    let name = format!("{}.png", base);
    if write_png(dir.join(&name), img.width, img.height, channels as u32, &pixels).is_ok() {
        Some(name)
    } else {
        None
    }
}

fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut decoder = flate2::read::ZlibDecoder::new(data);
    std::io::Read::read_to_end(&mut decoder, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Line;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
        Rect { x0, y0, x1, y1 }
    }

    fn line(x0: f64, baseline: f64, x1: f64, size: f64, text: &str) -> Line {
        Line {
            words: Vec::new(),
            x0,
            x1,
            baseline,
            top: baseline - size * 0.8,
            bottom: baseline + size * 0.2,
            size,
            is_math: false,
            is_bold: false,
            is_italic: false,
            is_mono: false,
            indent: x0,
            glyph_ids: Vec::new(),
            limit_spans: Vec::new(),
    }
        .with_text(text)
    }

    trait WithText {
        fn with_text(self, t: &str) -> Line;
    }
    impl WithText for Line {
        fn with_text(mut self, t: &str) -> Line {
            // One word per line: the claim unit is the run, and a single run
            // keeps these geometry tests focused.
            self.words.push(crate::layout::Word {
                x0: self.x0,
                y0: self.baseline - self.size * 0.78,
                x1: self.x1,
                y1: self.baseline + self.size * 0.24,
                text: t.to_string(),
                latex: None,
                size: self.size,
                is_math: false,
                is_bold: false,
                is_italic: false,
                is_mono: false,
            });
            self
        }
    }

    const BODY: f64 = 10.0;
    const PAGE_W: f64 = 612.0;
    const PAGE_H: f64 = 792.0;

    /// The claim decision for the run of `lines[li]` (its first word).
    fn claims(fbox: &Rect, li: usize, lines: &[Line]) -> bool {
        let caption: Vec<bool> = lines.iter().map(|l| is_caption_line(&l.text())).collect();
        let l = &lines[li];
        let w = &l.words[0];
        let run = TextRun {
            bbox: w.bbox(),
            x: w.x0,
            y: l.baseline,
            text: w.text.clone(),
            size: w.size,
            dir: (1.0, 0.0),
            line: Some(li),
        };
        figure_claims_run(fbox, &run, lines, &caption, BODY, PAGE_W, PAGE_H)
    }

    /// Figure-assembly dump for one fixture page: ink, clusters, accepted
    /// figure regions (with their labels) and the rotated runs.
    /// `EXPLORE_PDF=<pdf> EXPLORE_PAGE=<n> cargo test explore_assembly -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn explore_assembly() {
        let file = std::env::var("EXPLORE_PDF").expect("EXPLORE_PDF");
        let page: u32 = std::env::var("EXPLORE_PAGE").unwrap_or_else(|_| "1".into()).parse().unwrap();
        let doc = lopdf::Document::load(&file).expect("load");
        let mut cache = std::collections::HashMap::new();
        for (num, id) in doc.get_pages() {
            if num != page {
                continue;
            }
            let interp = crate::content::Interp::new(&doc, &mut cache);
            let items = interp.run_page(id).expect("run");
            let lines = crate::layout::build_lines(&items);
            let body = crate::layout::body_size(&[lines.clone()]);
            println!(
                "PAGE {} paths={} images={} rules={} glyphs={} rotated={} lines={} body={:.1}",
                num,
                items.paths.len(),
                items.images.len(),
                items.rules.len(),
                items.glyphs.len(),
                items.rotated.len(),
                lines.len(),
                body
            );
            for (i, im) in items.images.iter().enumerate() {
                println!("  IMG[{}] bbox=({:.1},{:.1})-({:.1},{:.1})", i, im.bbox.x0, im.bbox.y0, im.bbox.x1, im.bbox.y1);
            }
            for r in rotated_runs(&items.rotated) {
                println!(
                    "  RRUN ({:.1},{:.1})-({:.1},{:.1}) x={:.1} y={:.1} text={:?}",
                    r.bbox.x0, r.bbox.y0, r.bbox.x1, r.bbox.y1, r.x, r.y, r.text
                );
            }
            let mut ink: Vec<Rect> = items.paths.iter().map(|p| p.bbox).collect();
            let np = ink.len();
            ink.extend(items.rules.iter().map(|r| r.rect));
            println!("  INK paths={} rules={}", np, items.rules.len());
            for (gi, m) in cluster_boxes(&ink, (body * 1.6).max(12.0)).iter().enumerate() {
                let mut bb = Rect::empty();
                for &i in m {
                    bb.union(&ink[i]);
                }
                let npat = m.iter().filter(|&&i| i < np).count();
                println!(
                    "  CLUSTER[{}] paths={} members={} bbox=({:.1},{:.1})-({:.1},{:.1}) {}",
                    gi,
                    npat,
                    m.len(),
                    bb.x0,
                    bb.y0,
                    bb.x1,
                    bb.y1,
                    reject_reason(npat, m.len(), &bb, &lines, body).unwrap_or("ACCEPT")
                );
            }
        }
    }

    #[test]
    fn claims_label_fully_inside_box() {
        let fbox = rect(100.0, 200.0, 300.0, 320.0);
        let lines = vec![line(150.0, 250.0, 240.0, BODY, "making")];
        assert!(claims(&fbox, 0, &lines));
    }

    #[test]
    fn claims_subfigure_title_above_box() {
        // attention p4: the sub-figure title hangs ~15pt above a small image
        // box and is wider than it — claimed via the isolated-line path.
        let fbox = rect(175.0, 94.0, 239.0, 221.0);
        let lines = vec![line(147.0, 79.0, 266.0, BODY, "Scaled Dot-Product Attention")];
        assert!(claims(&fbox, 0, &lines));
    }

    #[test]
    fn does_not_claim_paragraph_line_near_full_width_figure() {
        // A paragraph line has leading neighbours: it stays in the flow even
        // when horizontally inside a full-width figure's claim window.
        let fbox = rect(114.0, 357.0, 500.0, 483.0);
        let lines = vec![
            line(108.0, 333.0, 504.0, BODY, "first paragraph line"),
            line(108.0, 345.0, 504.0, BODY, "second paragraph line"),
        ];
        assert!(!claims(&fbox, 0, &lines));
        assert!(!claims(&fbox, 1, &lines));
    }

    #[test]
    fn does_not_claim_lone_body_line_hanging_above_box() {
        // cartier p54: "There exists morphisms 𝜑1 : 𝔗 → 𝔘1 … fitting into the
        // commutative diagram" is a paragraph's last line. It is isolated (its
        // only neighbour on the page is the running head), it sits 1.5 leading
        // above the diagram's box and its CENTRE is over the box — and it must
        // still stay in the text flow: a label is never several times wider
        // than the drawing it annotates.
        let fbox = rect(261.6, 88.2, 359.1, 170.3);
        let lines = vec![
            line(500.9, 30.8, 554.4, BODY, "Sami Fersi"),
            line(57.6, 69.6, 539.5, BODY,
                "There exists morphisms 𝜑1 ∶ 𝔗 → 𝔘1 and 𝜑12 ∶ 𝔘1 → 𝔘2 fitting into the commutative diagram"),
        ];
        assert!(!claims(&fbox, 1, &lines));
    }

    #[test]
    fn claims_close_subcaption_below_box_but_not_paragraph() {
        // A sub-caption sits ~6pt below the figure (well inside one leading);
        // a paragraph line sits AT leading distance (12pt) — outside the band.
        let fbox = rect(114.0, 357.0, 500.0, 483.0);
        let lines = vec![
            line(114.0, 491.0, 500.0, BODY, "a) MNIST b) TFD"),
        ];
        assert!(claims(&fbox, 0, &lines));
        let para = vec![
            line(108.0, 333.0, 504.0, BODY, "first paragraph line"),
            line(108.0, 345.0, 504.0, BODY, "second paragraph line"),
        ];
        assert!(!claims(&fbox, 1, &para));
    }

    #[test]
    fn does_not_claim_caption_or_heading() {
        let fbox = rect(100.0, 200.0, 300.0, 320.0);
        let lines = vec![
            line(120.0, 250.0, 260.0, BODY, "Figure 2: samples"),
            line(120.0, 250.0, 260.0, BODY * 1.3, "Attention Visualizations"),
        ];
        assert!(!claims(&fbox, 0, &lines));
        assert!(!claims(&fbox, 1, &lines));
    }

    #[test]
    fn page_dominating_figure_claims_nothing() {
        // A scanned page's bitmap must never swallow the OCR text layer.
        let fbox = rect(20.0, 20.0, PAGE_W - 20.0, PAGE_H - 20.0);
        let lines = vec![line(150.0, 250.0, 240.0, BODY, "making")];
        assert!(!claims(&fbox, 0, &lines));
    }

    #[test]
    fn claims_rotated_run_inside_box_but_not_the_side_stamp() {
        // attention p13: the word-grid axis labels are drawn with a 90° Tm.
        // They are figure text, placed by their own run box.
        let fbox = rect(119.7, 84.3, 504.7, 302.1);
        let lines: Vec<Line> = Vec::new();
        let caption: Vec<bool> = Vec::new();
        let word = TextRun {
            bbox: rect(119.6, 144.1, 130.0, 160.5),
            x: 119.6,
            y: 160.5,
            text: "It".into(),
            size: 7.78,
            dir: (0.0, -1.0),
            line: None,
        };
        assert!(figure_claims_run(&fbox, &word, &lines, &caption, BODY, PAGE_W, PAGE_H));
        // The arXiv side stamp is a page-edge strip: no figure box contains it.
        let stamp = TextRun {
            bbox: rect(25.0, 100.0, 40.0, 700.0),
            x: 25.0,
            y: 100.0,
            text: "arXiv:2609.27549".into(),
            size: 8.0,
            dir: (0.0, -1.0),
            line: None,
        };
        assert!(!figure_claims_run(&fbox, &stamp, &lines, &caption, BODY, PAGE_W, PAGE_H));
    }

    #[test]
    fn reading_order_rows_left_to_right() {
        // Two side-by-side subfigures whose y0 differ (82.7 vs 94): the LEFT
        // one must come first despite sitting slightly lower.
        let rects = vec![
            rect(175.0, 94.0, 239.0, 221.0),   // left
            rect(346.8, 82.7, 467.0, 267.3),   // right, slightly higher
        ];
        let (order, row_tops) = reading_order(&rects);
        assert_eq!(order, vec![0, 1]);
        assert_eq!(row_tops[0], row_tops[1]);
    }

    #[test]
    fn reading_order_stacked_rows_top_to_bottom() {
        // Two stacked rows of images (gan p6): the upper visual row first,
        // left-to-right within the row.
        let rects = vec![
            rect(313.0, 497.9, 500.3, 624.1), // lower row, right
            rect(114.0, 497.9, 301.2, 624.1), // lower row, left
            rect(114.0, 357.3, 301.2, 483.7), // upper row, left
            rect(313.1, 357.9, 500.3, 483.7), // upper row, right
        ];
        let (order, _) = reading_order(&rects);
        assert_eq!(order, vec![2, 3, 1, 0]);
    }

    #[test]
    fn diagram_strokes_cluster_into_one_figure() {
        // cartier p40, top commutative diagram: its arrowheads and diagonals
        // are paths, its long straight arrows are rules. Clustering paths
        // alone split it into three fragments the size of an arrowhead, with
        // the labels outside every fragment's box; ink clustering keeps it
        // whole. Boxes below are the page's real ones.
        let diag1: Vec<Rect> = vec![
            // paths
            rect(391.6, 199.1, 394.1, 204.9),
            rect(275.3, 294.3, 281.0, 296.8),
            rect(218.1, 213.0, 259.2, 236.9),
            rect(217.8, 233.3, 221.4, 238.3),
            rect(361.9, 210.9, 394.4, 236.0),
            rect(361.7, 232.4, 365.4, 236.9),
            rect(403.0, 294.3, 408.7, 296.8),
            rect(339.3, 241.0, 341.8, 246.7),
            rect(203.3, 336.6, 209.0, 339.1),
            rect(348.9, 336.6, 354.7, 339.1),
            rect(391.0, 304.7, 393.5, 310.4),
            rect(218.6, 318.2, 260.0, 342.5),
            rect(218.4, 338.9, 222.0, 343.9),
            rect(365.6, 317.0, 393.8, 339.0),
            rect(365.4, 335.4, 369.1, 339.9),
            rect(335.4, 347.0, 337.9, 352.7),
            // rules (straight arrow shafts, dashed runs, panel border)
            rect(309.0, 202.0, 393.9, 202.0),
            rect(278.2, 213.0, 278.2, 296.5),
            rect(405.8, 212.5, 405.8, 296.5),
            rect(217.6, 243.8, 341.6, 243.8),
            rect(206.2, 254.4, 206.2, 338.9),
            rect(351.8, 251.4, 351.8, 338.9),
            rect(309.8, 307.5, 393.3, 307.5),
            rect(218.2, 349.9, 337.6, 349.9),
        ];
        let groups = cluster_boxes(&diag1, 19.2);
        assert_eq!(groups.len(), 1, "the diagram's strokes form one figure");
        assert_eq!(groups[0].len(), diag1.len());

        // The next diagram down the page is separated by a blank band: it
        // must stay a figure of its own.
        let diag2: Vec<Rect> = vec![
            rect(331.8, 390.4, 334.3, 396.2),
            rect(271.2, 422.7, 276.9, 425.2),
            rect(343.2, 422.7, 348.9, 425.2),
            rect(331.3, 433.1, 333.7, 438.9),
            rect(304.9, 393.3, 334.1, 393.3),
            rect(274.0, 404.3, 274.0, 425.0),
            rect(346.0, 403.8, 346.0, 425.0),
            rect(305.7, 436.0, 333.5, 436.0),
        ];
        let mut both = diag1.clone();
        both.extend_from_slice(&diag2);
        let groups = cluster_boxes(&both, 19.2);
        assert_eq!(groups.len(), 3, "the two diagrams never merge");

        // Its own label fills the gap where the lower square's arrows stop:
        // the label box bridges the strokes it separates.
        let label = rect(248.6, 388.0, 299.0, 397.5);
        assert!(within_gap(&groups[1].iter().fold(Rect::empty(), |mut b, &i| { b.union(&both[i]); b }), &label, 19.2));
        let spans: Vec<Rect> = groups
            .iter()
            .map(|m| m.iter().fold(Rect::empty(), |mut b, &i| {
                b.union(&both[i]);
                b
            }))
            .collect();
        let local = label_width_limit(&spans[0], 19.2);
        assert!(label.width() <= local, "a diagram label may bridge its own strokes");
        let body_line = rect(57.6, 69.6, 539.5, 72.5);
        assert!(body_line.width() > local, "a paragraph line is not a label");

        // A table is a grid of straight rules ONLY: no curve, no arrowhead.
        // It must never be taken for a figure (its borders would leave table
        // detection), however tight its grid is.
        let table: Vec<Rect> = (0..4)
            .flat_map(|i| [rect(100.0, 300.0 + i as f64 * 14.0, 400.0, 300.5 + i as f64 * 14.0)])
            .collect();
        let grid = cluster_boxes(&table, 19.2);
        assert_eq!(grid.len(), 1);
        let mut grid_box = Rect::empty();
        for b in &table {
            grid_box.union(b);
        }
        assert_eq!(reject_reason(0, grid[0].len(), &grid_box, &[], BODY), Some("no-paths"));
    }

    /// One run of a line, from its first word (the file's `line` helper packs
    /// the whole text into one word).
    fn run_of(l: &Line, li: usize) -> TextRun {
        let w = &l.words[0];
        TextRun {
            bbox: w.bbox(),
            x: w.x0,
            y: l.baseline,
            text: w.text.clone(),
            size: w.size,
            dir: (1.0, 0.0),
            line: Some(li),
        }
    }

    /// One run per entry, laid out left to right (the claim unit is the run).
    fn runs_of(texts: &[&str]) -> Vec<TextRun> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let x = 100.0 + i as f64 * 60.0;
                TextRun {
                    bbox: rect(x, 120.0, x + 50.0, 132.0),
                    x,
                    y: 130.0,
                    text: (*t).to_string(),
                    size: BODY,
                    dir: (1.0, 0.0),
                    line: None,
                }
            })
            .collect()
    }

    /// A figure whose ink is exactly `strokes` (used as paths, so the rule
    /// bookkeeping is not in the way).
    fn ink_of(strokes: &[Rect]) -> FigureInk {
        let mut b = Rect::empty();
        for s in strokes {
            b.union(s);
        }
        FigureInk { bbox: b, paths: (0..strokes.len()).collect(), rules: Vec::new(), labels: Vec::new() }
    }

    // ---- a diagram's own rows ----
    // A commutative diagram's labels sit in the whitespace its arrows leave,
    // often outside the ink's box and as several separate lines sharing a
    // baseline. The text pipeline reads such a stack as a paragraph and vetoes
    // every label that is not strictly inside the ink; the all-or-nothing line
    // rule then drops the whole row, so the diagram used to render with no
    // labels at all (cartier p67/p5/p63/p61/p62).

    #[test]
    fn crossing_stroke_is_one_through_the_rows_band() {
        // cartier p5, the pullback diagram's label row: the vertical arrow at
        // x=224.7 crosses the row "F_{U/S}   F_{T/S}   F_{T/S}".
        let strokes = vec![rect(224.7, 579.7, 224.7, 604.2)];
        let ink = ink_of(&strokes);
        let boxes = strokes.clone();
        let l = line(201.4, 594.8, 410.1, 8.4, "𝐹𝑈/𝑆 𝐹𝑇/𝑆 𝐹𝑇/𝑆");
        let runs: Vec<TextRun> = vec![run_of(&l, 0)];
        let refs: Vec<&TextRun> = runs.iter().collect();
        let found = crossing_strokes(&ink, &boxes, 0, &l, 19.2);
        assert_eq!(found.len(), 1, "the arrow shaft runs through the row");
        let _ = refs;
        // The same shaft does not cross a row two leads away.
        let far = line(201.4, 660.0, 410.1, 8.4, "𝑥 𝑦");
        assert!(crossing_strokes(&ink, &boxes, 0, &far, 19.2).is_empty());
    }

    #[test]
    fn rule_spanning_the_line_is_not_a_crossing_stroke() {
        // A rule under a paragraph (a table's border, a page furniture line)
        // spans the line: it is not the drawing's row.
        let strokes = vec![rect(57.6, 641.0, 554.4, 641.0)];
        let ink = ink_of(&strokes);
        let boxes = strokes.clone();
        let l = line(57.6, 644.0, 554.4, BODY, "Figure 2: samples");
        assert!(crossing_strokes(&ink, &boxes, 0, &l, 19.2).is_empty());
    }

    #[test]
    fn prose_row_is_not_a_figure_row() {
        // cartier p43: "that there exists a unique morphism v : T_V' -> V'
        // fitting into the following commutative" shares its baseline with the
        // diagram's top row; the sentence stays in the flow.
        let sentence = runs_of(&["that", "there", "exists", "a", "unique", "morphism"]);
        let refs: Vec<&TextRun> = sentence.iter().collect();
        assert!(prose_row(&refs));
        // A diagram row is symbols and short tags, however it is wrapped.
        let diagram = runs_of(&["𝒞𝑙q𝑓coh(𝑋′/𝒮)", "𝐶𝑋∗", "/𝒮,𝑙𝑓", "𝒞q𝑙coh(𝑋/𝒮)"]);
        let drefs: Vec<&TextRun> = diagram.iter().collect();
        assert!(!prose_row(&drefs));
        assert!(word_run("qcoh") && word_run("the") && word_run("Mod"));
        assert!(!word_run("𝑋′") && !word_run("/𝒮,𝑙𝑓") && !word_run("Id"));
    }

    #[test]
    fn row_reach_leaves_a_margin_equation_number_in_the_text() {
        // cartier p62: the row "X' pi X (8.37.26)" shares its baseline with the
        // diagram. The number sits at the right margin, a whole column beyond a
        // drawing 108pt wide: it is text, not part of the row.
        let runs: Vec<TextRun> = vec![
            TextRun { bbox: rect(300.5, 311.4, 310.4, 323.3), x: 300.5, y: 323.3, text: "𝑋".into(), size: 12.0, dir: (1.0, 0.0), line: None },
            TextRun { bbox: rect(331.9, 308.4, 337.4, 316.7), x: 331.9, y: 316.7, text: "𝜋".into(), size: 8.4, dir: (1.0, 0.0), line: None },
            TextRun { bbox: rect(354.5, 311.4, 364.4, 323.3), x: 354.5, y: 323.3, text: "𝑋".into(), size: 12.0, dir: (1.0, 0.0), line: None },
            TextRun { bbox: rect(509.5, 311.4, 554.4, 323.3), x: 509.5, y: 323.3, text: "(8.37.26)".into(), size: 12.0, dir: (1.0, 0.0), line: None },
        ];
        let strokes = vec![rect(254.5, 270.6, 362.6, 359.6)];
        let ink = ink_member_box(&ink_of(&strokes), &strokes, 0);
        let reach = ink.width().max(ink.height()).max(3.0 * BODY).max(12.0);
        let refs: Vec<&TextRun> = runs.iter().collect();
        assert!(reach >= 108.0);
        assert!(!row_reaches_strokes(&strokes, &refs, reach), "the margin number is out of the drawing's reach");
        // Without it, the drawing's own row is fully absorbed.
        let own: Vec<&TextRun> = refs[..3].to_vec();
        assert!(row_reaches_strokes(&strokes, &own, reach));
    }

    #[test]
    fn wrapped_caption_block_stays_in_the_flow() {
        // attention p14: the image ends 2.5pt above the caption's last line,
        // which is two leads below the caption's first line.
        let lines = vec![
            line(108.0, 618.6, 504.0, BODY, "Figure 4: Two attention heads, also in layer"),
            line(108.0, 631.3, 500.9, BODY, "Full attentions for head 5. Bottom: Isolated attentions"),
            line(108.0, 643.7, 343.3, BODY, "and 6. Note that the attentions are very sharp for this word."),
        ];
        let caption: Vec<bool> = lines.iter().map(|l| is_caption_line(&l.text())).collect();
        assert!(!caption[2], "the continuation line is not itself a caption");
        assert!(in_caption_block(2, &lines, &caption, BODY));
        // A diagram's own row elsewhere on the page is not in the block.
        let other = line(240.0, 120.0, 320.0, BODY, "𝑇1 ×𝑇 𝑇2");
        let mut all = lines.clone();
        all.push(other);
        let caption: Vec<bool> = all.iter().map(|l| is_caption_line(&l.text())).collect();
        assert!(!in_caption_block(3, &all, &caption, BODY));
    }

    #[test]
    fn label_box_room_covers_the_viewers_font() {
        // A label renders in the viewport's own font: its box must cover both
        // the measured glyphs and the string the viewer will draw.
        let l = TextRun {
            bbox: rect(332.3, 111.4, 341.4, 123.3),
            x: 332.3,
            y: 119.9,
            text: "𝑅1′".into(),
            size: 12.0,
            dir: (1.0, 0.0),
            line: None,
        };
        let b = rendered_label_box(&l);
        assert!(b.x0 <= 332.3 && b.y0 <= 111.4, "the measured box is kept");
        assert!(b.x1 >= 332.3 + 0.62 * 12.0 * 3.0, "the rendered string fits");
        // A rotated run's room follows its own baseline direction.
        let r = TextRun {
            bbox: rect(119.6, 144.1, 130.0, 160.5),
            x: 119.6,
            y: 160.5,
            text: "It".into(),
            size: 7.78,
            dir: (0.0, -1.0),
            line: None,
        };
        let rb = rendered_label_box(&r);
        assert!(rb.y0 <= 160.5 - 0.62 * 7.78 * 2.0, "a rotated label grows along its baseline");
    }

    #[test]
    fn alt_text_joins_labels_and_brackets() {
        let lines = vec![line(0.0, 0.0, 10.0, BODY, "a [b]"), line(0.0, 20.0, 10.0, BODY, "c")];
        let caption: Vec<bool> = lines.iter().map(|l| is_caption_line(&l.text())).collect();
        let runs: Vec<TextRun> = lines
            .iter()
            .enumerate()
            .map(|(li, l)| {
                let w = &l.words[0];
                TextRun {
                    bbox: w.bbox(),
                    x: w.x0,
                    y: l.baseline,
                    text: w.text.clone(),
                    size: w.size,
                    dir: (1.0, 0.0),
                    line: Some(li),
                }
            })
            .filter(|r| figure_claims_run(&rect(0.0, -30.0, 20.0, 40.0), r, &lines, &caption, BODY, PAGE_W, PAGE_H))
            .collect();
        let refs: Vec<&TextRun> = runs.iter().collect();
        assert_eq!(alt_from_labels(&refs), "a (b) c");
    }

    #[test]
    fn does_not_claim_caption_continuation_crossing_the_box() {
        // A wrapped caption's second line ("...Bottom: Isolated...")
        // physically overlaps the figure's lower region: it must stay in the
        // flow (it starts at the figure's left edge and spans its width).
        let fbox = rect(122.0, 123.9, 503.7, 641.6);
        let lines = vec![
            line(108.0, 620.0, 504.0, BODY, "Figure 4: Two attention heads, also in layer"),
            line(108.0, 632.7, 500.9, BODY,
                "Full attentions for head 5. Bottom: Isolated attentions from just the word"),
        ];
        assert!(!claims(&fbox, 1, &lines));
        // A short axis title starting at the same edge is still a label.
        let label = vec![line(108.0, 331.2, 208.0, BODY, "Input-Input Layer5")];
        assert!(claims(&fbox, 0, &label));
    }
}
