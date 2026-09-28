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
    /// x-spans of groups the big-op prepass claimed as operator limits
    /// (wide display limits); consumed by math::try_limits.
    pub limit_spans: Vec<(f64, f64)>,
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

    // 1) Baseline clustering: group glyphs that sit on (nearly) the same
    // baseline, then split each baseline group into horizontal runs. The two
    // steps are separate because a glyph's neighbours on its baseline may be
    // far away in x: an inline subscript (y slightly below the line) used to
    // sort AFTER the whole line and fail the "continues horizontally" test
    // against the line's last glyph, shredding every inline formula into
    // orphan script lines.
    // Fake-bold double draws print every glyph twice at (nearly) the same
    // spot; the near-duplicate interleave destroyed formulas ("EExxppddaattaa").
    // One copy per (text, latex, ≈x, ≈y) survives.
    let mut kept: Vec<usize> = Vec::with_capacity(items.glyphs.len());
    let mut last_by_key: std::collections::HashMap<(String, String), (f64, f64, usize)> =
        std::collections::HashMap::new();
    for (i, g) in items.glyphs.iter().enumerate() {
        let key = (g.text.clone(), g.latex.clone().unwrap_or_default());
        let dup = match last_by_key.get(&key) {
            Some(&(px, py, _)) => (g.x - px).abs() < 1.0 && (g.y - py).abs() < 1.0,
            None => false,
        };
        if dup {
            continue;
        }
        last_by_key.insert(key, (g.x, g.y, i));
        kept.push(i);
    }
    let kept_set: std::collections::HashSet<usize> = kept.iter().copied().collect();
    let mut glyphs: Vec<(usize, &Glyph)> = kept_set
        .iter()
        .map(|&i| (i, &items.glyphs[i]))
        .collect();
    // The tiebreak on the glyph's original index makes the sort a TOTAL
    // order: two glyphs printed at the same (x, y) — the negation slash and
    // the equals sign of a \neq, drawn on top of each other — must keep their
    // content-stream order, not the HashSet's per-process random iteration
    // order (the same PDF used to convert to a different markdown each run).
    glyphs.sort_by(|(ia, a), (ib, b)| {
        a.y.partial_cmp(&b.y)
            .unwrap()
            .then(a.x.partial_cmp(&b.x).unwrap())
            .then(ia.cmp(ib))
    });

    struct RawGroup {
        baseline: f64,
        size: f64,
        glyphs: Vec<usize>,
        piece: bool,
    }
    // A cmex delimiter piece's glyph ORIGIN sits at a meaningless height (the
    // middle of its tall bracket), so pieces must neither merge into a real
    // baseline cluster (their y coincides with the formula's upper-limit row,
    // welding the ∑'s limit to the brackets) nor absorb one. Each piece gets
    // its own group and attaches to its row in step 2b.
    let is_piece_glyph = |g: &Glyph| -> bool {
        let f = &items.fonts[g.font];
        f.tex == crate::font::TexKind::Cmex
            && g.text.is_empty()
            && g.latex
                .as_deref()
                .map(|l| l.is_empty() || l.starts_with("\\big"))
                .unwrap_or(true)
    };
    // A RADICAL's glyph origin is its covering bar, which TeX places ~0.6–1.6×
    // size ABOVE the radicand's baseline (the glyph hangs from the bar down over
    // its content). Clustered by origin it welds into whatever line sits at the
    // bar's height — the line ABOVE (p4 of 1706.03762: the √ of "divide each by
    // √d_k" landed inside the word "and" of the previous line, and ricci's √
    // left its radicand as an orphan run) — so a radical forms its own group and
    // attaches DOWNWARD, exactly like the big operators whose origin is raised
    // for their limits.
    let is_radical_glyph = |g: &Glyph| -> bool {
        g.latex
            .as_deref()
            .map(|l| l == "\\surd" || l == "√")
            .unwrap_or(false)
            || g.text.starts_with('√')
    };
    let mut groups: Vec<RawGroup> = Vec::new();
    for (_, (orig, g)) in glyphs.iter().enumerate() {
        let gi = *orig;
        let piece = is_piece_glyph(g) || is_radical_glyph(g);
        let merged_in = match groups.last_mut() {
            Some(gr)
                if !gr.piece
                    && !piece
                    && (gr.baseline - g.y).abs() <= (gr.size * 0.25).clamp(0.8, 3.0) =>
            {
                gr.size = gr.size.max(g.size);
                gr.glyphs.push(gi);
                true
            }
            _ => false,
        };
        if !merged_in {
            groups.push(RawGroup {
                baseline: g.y,
                size: g.size,
                glyphs: vec![gi],
                piece,
            });
        }
    }

    // 1b) Split each baseline group into x-runs. A run breaks at a gap large
    // enough that no inline formula slot or word spacing explains it — that is
    // where a second column, a table cell or a page-edge element starts. A gap
    // that is OCCUPIED by other-group glyphs at this line's height (the group's
    // own superscripts/subscripts waiting to attach) is a formula slot, not a
    // boundary: splitting there used to sever "…R^{d_model×d_k}, W_i^K…" into
    // three lines and hang the scripts on the wrong side.
    let mut merged: Vec<(f64, f64, f64, Vec<usize>)> = Vec::new(); // (baseline, size, x1_end, glyphs)
    for gr in &groups {
        let mut sorted = gr.glyphs.clone();
        sorted.sort_by(|&a, &b| {
            items.glyphs[a].x.partial_cmp(&items.glyphs[b].x).unwrap()
        });
        // A gap that is OCCUPIED by other-group glyphs at this line's height
        // (the group's own superscripts/subscripts waiting to attach) is a
        // formula slot, not a boundary. The window must stay a full size wide:
        // tightening it (script band / nearest baseline) split the display
        // formulas of 1406.2661 into several lines and interleaved their rows
        // character by character in reconstruction.
        let slot_occupied = |x_from: f64, x_to: f64| {
            items.glyphs.iter().any(|g2| {
                g2.x + g2.wx >= x_from
                    && g2.x <= x_to
                    && (g2.y - gr.baseline).abs() <= gr.size
            })
        };
        let mut cur: Vec<usize> = Vec::new();
        let mut cur_x1 = f64::MIN;
        let mut runs: Vec<(f64, Vec<usize>)> = Vec::new();
        for gi in sorted {
            let g = &items.glyphs[gi];
            let split_gap = (gr.size * 2.2).max(12.0);
            let gap = g.x - cur_x1;
            let big_jump = !cur.is_empty()
                && gap > split_gap
                && !slot_occupied(cur_x1 + 0.5, g.x - 0.5);
            if big_jump {
                runs.push((cur_x1, std::mem::take(&mut cur)));
                cur_x1 = f64::MIN;
            }
            cur.push(gi);
            cur_x1 = cur_x1.max(g.x + g.wx);
        }
        if !cur.is_empty() {
            runs.push((cur_x1, cur));
        }
        // A run SPLIT off its group carries its OWN baseline and size, never
        // the group's: a group is "glyphs within 0.25×size of the first
        // glyph's y", so a run split off it can sit on an entirely different
        // row. Inheriting the group's baseline/size made ricci's `\int_0`
        // lower limit — 2.6pt below the denominator row it had clustered with
        // — look like a display-size atom on the wrong baseline: the big-op
        // prepass rejected it by size, every host rejected it by distance, and
        // the `0` fell out as its own paragraph ("0 13" in the markdown).
        // A group that produced a single run keeps its own metrics: the run is
        // the group.
        let multi = runs.len() > 1;
        for (x1_end, glyphs) in runs {
            let (b, sz) = if multi {
                run_metrics(items, &glyphs)
            } else {
                (gr.baseline, gr.size)
            };
            merged.push((b, sz, x1_end, glyphs));
        }
    }

    // 2) Attach small groups (scripts) to the nearest larger host group.
    // A group is a script of another when: host is bigger, its baseline lies
    // within host's superscript/subscript window, and it is horizontally close.
    let n = merged.len();
    let gx0: Vec<f64> = merged.iter().map(|m| m.3.iter().map(|&gi| items.glyphs[gi].x).fold(f64::MAX, f64::min)).collect();
    let gx1: Vec<f64> = merged.iter().map(|m| m.3.iter().map(|&gi| items.glyphs[gi].x + items.glyphs[gi].wx).fold(f64::MIN, f64::max)).collect();
    const LIMIT_OPS: [&str; 10] = [
        r"\sum", r"\prod", r"\coprod", r"\int", r"\oint", r"\iint", r"\iiint",
        r"\bigcup", r"\bigcap", r"\bigoplus",
    ];
    // A big operator is identified by its LaTeX (∑,∫ resolve through the CM
    // slot tables or the embedded font's glyph names). Grouping every cmex
    // glyph in made the tall DELIMITERS (bracketleftBig etc.) big operators
    // too: a bracket pair spanning a whole line then "hosted" that very line
    // (the eq(4)→(5) derivation of 1406.2661 collapsed into one interleaved
    // blob), and a line-1 bracket chained into the line-2 block.
    let is_bigop_group = |m: &(f64, f64, f64, Vec<usize>)| {
        m.3.iter().filter_map(|&gi| items.glyphs.get(gi)).any(|g| {
            g.latex.as_deref().map(|l| LIMIT_OPS.contains(&l)).unwrap_or(false)
        })
    };
    // A group made of a radical glyph: same raised posture as a big operator
    // (its origin is the covering bar), never a host and never a host's script.
    let is_radical_group = |m: &(f64, f64, f64, Vec<usize>)| {
        m.3.iter()
            .filter_map(|&gi| items.glyphs.get(gi))
            .any(|g| is_radical_glyph(g))
    };
    let radical_group: Vec<bool> = merged.iter().map(|m| is_radical_group(m)).collect();
    // Per-group precomputations for the O(G²) attachment loops below: a group
    // made only of delimiter pieces (never a host), and its big-operator
    // glyph centers (the near-op window test).
    let is_piece_glyph = |g: &Glyph| -> bool {
        g.text.is_empty()
            && g.latex
                .as_deref()
                .map(|l| l.is_empty() || l.starts_with("\\big"))
                .unwrap_or(true)
    };
    let piece_group: Vec<bool> = merged
        .iter()
        .map(|m| {
            !m.3.is_empty()
                && m.3.iter().all(|&gi| {
                    items.glyphs.get(gi).map(|g| is_piece_glyph(g)).unwrap_or(true)
                })
        })
        .collect();
    let op_centers: Vec<Vec<(f64, f64)>> = merged
        .iter()
        .map(|m| {
            m.3.iter()
                .filter_map(|&gi| items.glyphs.get(gi))
                .filter(|g| {
                    g.latex.as_deref().map(|l| LIMIT_OPS.contains(&l)).unwrap_or(false)
                })
                .map(|g| (g.x + g.wx / 2.0, g.wx.max(g.size) / 2.0))
                .collect()
        })
        .collect();
    let mut host_of: Vec<Option<usize>> = vec![None; n];
    // True when attaching i under j would close a cycle (j's chain reaches i).
    let creates_cycle = |host_of: &Vec<Option<usize>>, mut j: usize, i: usize| {
        for _ in 0..n + 1 {
            if j == i {
                return true;
            }
            match host_of[j] {
                Some(h) => j = h,
                None => return false,
            }
        }
        true
    };
    // 1c) Big-operator limits claim their groups FIRST. A display-style limit
    // hangs 1.1–3.2×op-size BELOW the operator's origin (upper limits 0–0.9
    // above), centered on it. Matching by this TeX pattern — instead of
    // letting the nearest candidate group win — keeps a limit from being
    // stolen by the NEXT formula line whose own ∫ sits closer: eq (3) of
    // 1406.2661 lost its limits to the continuation line (doubled `_{x}^{x}`,
    // orphan `$$z$$`) because the continuation's ∫ origin was 4pt nearer than
    // the owner line's baseline.
    //
    // …but the claim must not reach ACROSS a row. The operator's body hangs
    // off its own row; a script-sized cluster that lies in the script band of
    // some OTHER row belongs to that row (its own base), never to an operator a
    // line away. The `∂` numerator of ricci p11's `\frac{\partial}{\partial
    // \beta}` sat 2.8×size below the bare ∫ of the line above and was claimed
    // as its lower limit: the markdown printed `Z=_{\partial}\int\limits_{
    // \partial}` and the numerator was dragged into the wrong line at line
    // level. Rows are the multi-glyph groups (an operator glyph alone is not a
    // row: its origin is raised for the limits it still has to receive).
    let row_like: Vec<usize> = (0..n)
        .filter(|&j| merged[j].3.len() >= 3 || (gx1[j] - gx0[j]) >= 2.5 * merged[j].1)
        .collect();
    let mut rows: Vec<(f64, usize)> = row_like.iter().map(|&j| (merged[j].0, j)).collect();
    rows.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let nearest_row_dy = |y: f64, skip: usize| -> f64 {
        let mut best = f64::MAX;
        for &(b, j) in &rows {
            if j == skip {
                continue;
            }
            best = best.min((b - y).abs());
        }
        best
    };
    let mut limit_claimed = vec![false; n];
    for gi in 0..n {
        for &gidx in &merged[gi].3 {
            let Some(g) = items.glyphs.get(gidx) else { continue };
            let Some(lx) = g.latex.as_deref() else { continue };
            if !LIMIT_OPS.contains(&lx) {
                continue;
            }
            let op_cx = g.x + g.wx / 2.0;
            let op_w = g.wx.max(g.size);
            // The row this operator decorates: the widest row-like group that
            // spans the operator's x and sits at (just below) its raised origin.
            let op_row = row_like
                .iter()
                .copied()
                .filter(|&j| {
                    j != gi
                        && gx0[j] <= op_cx
                        && op_cx <= gx1[j]
                        && merged[j].0 >= g.y + 0.25 * g.size
                        && merged[j].0 <= g.y + 1.6 * g.size
                })
                .max_by(|&a, &b| {
                    (gx1[a] - gx0[a]).partial_cmp(&(gx1[b] - gx0[b])).unwrap()
                });
            for li in 0..n {
                if li == gi || host_of[li].is_some() || merged[li].3.len() > 40 {
                    continue;
                }
                let lc = (gx0[li] + gx1[li]) / 2.0;
                // Display substack limits span wider than the operator on
                // BOTH sides (the `J\in K^d` fragment sits ~30pt left of the
                // \sum whose lower limit it belongs to).
                let x_window = (op_w * 0.75).max(2.6 * g.size);
                if (lc - op_cx).abs() > x_window {
                    continue;
                }
                let gsz = merged[li].1;
                if gsz > g.size * 0.85 {
                    continue; // limits are script-size — a full-size ∫ below
                              // another ∫ (the next formula line) is no limit
                }
                let dyo = merged[li].0 - g.y; // + = below the op origin
                let lower = dyo >= 1.1 * g.size && dyo <= 3.2 * g.size;
                let upper = dyo < 0.0 && (-dyo) <= 0.9 * g.size;
                if !(lower || upper) {
                    continue;
                }
                if let Some(j) = op_row {
                    if (merged[j].0 - merged[li].0).abs()
                        > nearest_row_dy(merged[li].0, li) + 0.3 * g.size
                    {
                        if std::env::var("PDF2MD_ATTACH_DEBUG").is_ok() {
                            eprintln!("[attach] s1c REJECT grp{li}(y={:.1} sz={:.1} x=[{:.1}..{:.1}]) opgrp{gi} (op {} y={:.1} cx={:.1}) op_row(y={:.1}) nearest_row={:.1}",
                                merged[li].0, merged[li].1, gx0[li], gx1[li], lx, g.y, op_cx, merged[j].0, nearest_row_dy(merged[li].0, li));
                        }
                        continue;
                    }
                }
                if std::env::var("PDF2MD_ATTACH_DEBUG").is_ok() {
                    eprintln!("[attach] s1c grp{li}(y={:.1}) -> opgrp{gi} (op {} y={:.1}, {})",
                        merged[li].0, lx, g.y, if lower { "lower" } else { "upper" });
                }
                host_of[li] = Some(gi);
                limit_claimed[li] = true;
            }
        }
    }
    for i in 0..n {
        if merged[i].3.len() > 40 || host_of[i].is_some() {
            // >40: a whole paragraph line is never a script. Some(…): the
            // big-op prepass (1c) already gave this group its operator —
            // re-attaching by distance would steal a limit back to the
            // neighbouring formula line whose ∫ happens to sit nearer.
            continue;
        }
        let (bi, si) = (merged[i].0, merged[i].1);
        // A big operator (∑,∫ from cmex) has its ORIGIN ~0.5–0.8×size ABOVE
        // the baseline of the line it belongs to (inline math raises it for
        // the limits). Its only legal host is therefore the line BELOW it;
        // without this posture rule the ∑ of a footnote formula used to be
        // sucked into the text line above and shredded that line.
        // A RADICAL has the same posture (its origin is the covering bar, above
        // the radicand's baseline) and the same single legal direction.
        let bigop = is_bigop_group(&merged[i]);
        let radical = radical_group[i];
        let posture = bigop || radical;
        let mut best: Option<(usize, f64)> = None;
        for j in 0..n {
            // A script MAY host another script (a ∑'s limits hang off the ∑
            // even after the ∑ itself attached to its line) — chains flatten
            // to the ultimate host in step 3. Only cycles are forbidden.
            if i == j || creates_cycle(&host_of, j, i) {
                continue;
            }
            let (hj_base, hj_size, hj_glyphs) = (merged[j].0, merged[j].1, &merged[j].3);
            if posture {
                // Posture: big operators hang from an origin ABOVE their
                // line's baseline (∑ raised for its limits; cmex ∫ glyphs
                // carry their origin at the glyph top). The host is therefore
                // strictly BELOW, within 1.45×host size — display-style ∫s
                // sit ~1.37×size above their line — and the operator's body
                // (origin + 1.4×size) must reach down into the host's line
                // box, so a mere paragraph line between formulas never
                // captures the operator.
                // A radical's bar sits 1.0–1.6×size above its radicand's
                // baseline (more when the radicand carries a fraction), so its
                // reach is wider while the same reach test applies.
                let reach = if radical { 2.0 } else { 1.45 };
                let dy = bi - hj_base;
                if dy > -0.05 * hj_size || dy < -reach * hj_size {
                    continue;
                }
                if hj_size < si * 0.95 {
                    continue;
                }
                let body = if radical { 1.0 } else { 1.4 };
                let op_body_reaches = bi + body * si >= hj_base - 0.8 * hj_size;
                if !op_body_reaches {
                    continue;
                }
            } else {
                if hj_size <= si * 1.05 {
                    continue;
                }
                let dy = bi - hj_base; // y-down: + = below host baseline
                let mut dy_limit = 0.6 * hj_size;
                // A big operator's LOWER limit hangs ~0.9–1.2×size below the
                // formula's baseline (TeX display style: ∫_x puts x under the
                // ∫, well below the line). Outside the ordinary script window
                // such a limit could not attach to its own line: the z of
                // eq (3) became an orphan $$z$$ block and the first ∫'s x
                // limit drifted into the NEXT formula. When the host row
                // carries a big operator at the script's x, widen the window.
                if si < hj_size * 0.88 {
                    let sc = gx0[i] + (gx1[i] - gx0[i]) / 2.0;
                    let near_op = op_centers[j]
                        .iter()
                        .any(|&(cx, half)| (sc - cx).abs() <= half + hj_size);
                    if near_op {
                        dy_limit = 1.3 * hj_size;
                    }
                }
                if dy < -0.75 * hj_size || dy > dy_limit {
                    continue;
                }
            }
            let dy = bi - hj_base; // y-down: + = below host baseline
            // A genuinely small glyph run is a script even when its baseline
            // offset is tiny: real subscripts drop by only ~0.15×size, which
            // used to fall into the "practically same baseline" exclusion and
            // detached d_model's "model" into an orphan line.
            let same_size = si > hj_size * 0.85;
            if dy.abs() < 0.16 * hj_size && same_size && !posture {
                continue; // practically same baseline → stays its own line
            }
            // horizontal proximity: overlapping or within 8pt
            let gap = (gx0[i] - gx1[j]).max(gx0[j] - gx1[i]);
            if gap > 8.0 {
                continue;
            }
            // Vertical offset is the primary script signal; the horizontal gap
            // only breaks ties (a ∑'s limit 2pt right of the ∑ must still win
            // over a text run it merely x-overlaps).
            let score = dy.abs() * 2.0 + gap.max(0.0);
            if best.map(|(_, s)| score < s).unwrap_or(true) {
                best = Some((j, score));
            }
        }
        if let Some((j, _)) = best {
            host_of[i] = Some(j);
            if std::env::var("PDF2MD_ATTACH_DEBUG").is_ok() {
                let txt = |m: &(f64, f64, f64, Vec<usize>)| -> String {
                    m.3.iter().filter_map(|&gi| items.glyphs.get(gi)).take(8).map(|g| g.text.clone()).collect()
                };
                eprintln!(
                    "[attach] s2 grp{i}(y={:.1},n={},sz={:.1},{:?}) -> grp{j}(y={:.1},n={},sz={:.1},{:?})",
                    bi, merged[i].3.len(), si, txt(&merged[i]),
                    merged[j].0, merged[j].3.len(), merged[j].1, txt(&merged[j]),
                );
            }
        }
    }
    // 2b) Same-size attachment: fraction numerators/denominators (±0.55×size,
    // x-overlapping the host) and big-operator limits (±1.1×size, narrow
    // overlap). Paragraph leading (~1.2×size) stays outside both windows.
    for i in 0..n {
        if host_of[i].is_some() || merged[i].3.len() > 40 {
            continue;
        }
        // A big operator or a radical is never a same-size "fraction piece":
        // its origin posture is raised above its own line, so the window below
        // (±1.28×size) reaches the TEXT LINE ABOVE and the distance test then
        // swallows it — eq (13) of math0211159 lost its ∫ to the `as` of the
        // sentence before it and the whole display formula was shredded. Its
        // line is found by the posture rule in step 2 only.
        if radical_group[i] || is_bigop_group(&merged[i]) {
            continue;
        }
        let (bi, si) = (merged[i].0, merged[i].1);
        let iw = gx1[i] - gx0[i];
        let mut best: Option<(usize, f64)> = None;
        for j in 0..n {
            if i == j || host_of[i].is_some() || creates_cycle(&host_of, j, i) {
                continue;
            }
            let (hj_base, hj_size, hj_glyphs) = (merged[j].0, merged[j].1, &merged[j].3);
            if hj_size < si * 0.55 || hj_size > si * 1.06 {
                continue;
            }
            let dy = bi - hj_base;
            let ady = dy.abs();
            if ady < 0.30 * hj_size || ady > 1.28 * hj_size {
                continue;
            }
            let jw = gx1[j] - gx0[j];
            // The host must span at least the candidate: a fraction numerator
            // belongs to the line that CONTAINS the fraction slot, not to a
            // neighbouring one-glyph fragment (a stray √ used to win by a
            // hair of vertical distance and swallow the numerator).
            if jw < iw {
                continue;
            }
            // …and the host must not be a pile of DELIMITER PIECES. Tall
            // cmex brackets cluster at their (mid-height) glyph origins, so a
            // line's "[" and "]" survive as one group whose bbox spans the
            // whole line; that hollow group then "hosted" the very line it
            // decorates and two display rows merged into one interleaved blob
            // (eq (4)→(5) of 1406.2661). Pieces decorate a line — they never
            // host one. (A legitimate host row may still carry wide gaps:
            // the slot of a fraction or a big operator inside it.)
            // A radical is decoration too: its origin is the covering bar, and
            // hosting a line from there would weld the line's scripts to it.
            if piece_group[j] || radical_group[j] {
                continue;
            }
            // x-overlap fraction against the narrower group; a small x-gap
            // (fraction slot inside the line) counts as overlapping too.
            let overlap = (gx1[i].min(gx1[j]) - gx0[i].max(gx0[j])).max(0.0);
            let frac = overlap / iw.min(jw).max(1.0);
            let xgap = (gx0[i] - gx1[j]).max(gx0[j] - gx1[i]);
            // Pieces are decorations of a row whose origin y can sit ~1.25×size
            // off the baseline — a piece-only candidate attaches generously,
            // real lines keep the strict window (paragraph leading is
            // ~1.2×size and must never merge this way).
            let cand_pieces = merged[i].3.iter().all(|&gi| {
                items.glyphs.get(gi).map(|g| is_piece_glyph(g)).unwrap_or(true)
            });
            let wide_limit = if cand_pieces { 1.4 * hj_size } else { 1.02 * hj_size };
            // A SAME-SIZE script exists in TeX geometry only around a fraction
            // bar: numerator above it, denominator below. Without a bar between
            // the two baselines the "script" is really the NEXT PARAGRAPH LINE
            // leading the formula — "Now we compute" attached above eq (4.5)
            // and shredded into ^{eco}^{m}^{pu}^{pute} in reconstruction.
            let bar_between = si >= hj_size * 0.88 && !cand_pieces && {
                let (y_lo, y_hi) = if bi < hj_base { (bi, hj_base) } else { (hj_base, bi) };
                items.rules.iter().any(|r| {
                    let rr = r.rect;
                    rr.height() <= 3.5
                        && rr.width() > hj_size * 0.5
                        && rr.y0 > y_lo + 1.0
                        && rr.y1 < y_hi - 1.0
                        && rr.x0 < gx1[i]
                        && rr.x1 > gx0[i]
                })
            };
            let wide_ok = (frac >= 0.5 || xgap <= 6.0)
                && ady < wide_limit
                && (si < hj_size * 0.88
                    || cand_pieces
                    // a same-size script is a FRACTION PIECE: narrow, or a
                    // bar provably sits between the two baselines. A wide
                    // bar-less candidate is the next paragraph line leading
                    // the formula ("Now we compute" → ^{eco}^{m}^{pu}^{pute}).
                    // (Table-cell fragments are narrow too — Table 2 of
                    // 1706.03762 needs them to keep its rows attachable.)
                    || gx1[i] - gx0[i] <= 1.3 * hj_size
                    || bar_between);
            // Narrow overlap = big-operator limits; require a big operator
            // glyph in the host near the script's x (otherwise stray scripts
            // from the neighbouring text line would be captured).
            const LIMIT_OPS: [&str; 10] = [
                r"\sum", r"\prod", r"\coprod", r"\int", r"\oint", r"\iint", r"\iiint",
                r"\bigcup", r"\bigcap", r"\bigoplus",
            ];
            let near_op = hj_glyphs.iter().filter_map(|&gi| items.glyphs.get(gi)).any(|g| {
                let is_op = g
                    .latex
                    .as_deref()
                    .map(|l| LIMIT_OPS.contains(&l))
                    .unwrap_or(false);
                is_op
                    && gx0[i] + iw / 2.0 >= g.x - hj_size
                    && gx0[i] + iw / 2.0 <= g.x + g.wx + hj_size
            });
            let narrow_ok = frac < 0.5
                && xgap > 6.0
                && ady > 0.5 * hj_size
                && ady < 1.28 * hj_size
                && near_op
                && gx0[i] >= gx0[j] - 2.0
                && gx1[i] <= gx1[j] + 2.0;
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
            if std::env::var("PDF2MD_ATTACH_DEBUG").is_ok() {
                let txt = |m: &(f64, f64, f64, Vec<usize>)| -> String {
                    m.3.iter().filter_map(|&gi| items.glyphs.get(gi)).take(8).map(|g| g.text.clone()).collect()
                };
                eprintln!(
                    "[attach] s2b grp{i}(y={:.1},n={},sz={:.1},{:?}) -> grp{j}(y={:.1},n={},sz={:.1},{:?})",
                    bi, merged[i].3.len(), si, txt(&merged[i]),
                    merged[j].0, merged[j].3.len(), merged[j].1, txt(&merged[j]),
                );
            }
        }
    }

    if std::env::var("PDF2MD_GROUPS_DEBUG").is_ok() {
        for (gi, m) in merged.iter().enumerate() {
            let txt: String = m.3.iter().filter_map(|&i| items.glyphs.get(i)).take(10).map(|g| g.text.as_str()).collect();
            eprintln!(
                "[grp] #{} y={:.1} sz={:.1} n={} host={:?} x=[{:.1}..{:.1}] {:?}",
                gi, m.0, m.1, m.3.len(), host_of[gi], gx0[gi], gx1[gi], txt
            );
        }
    }

    // 3) Build visual lines: hosts keep their glyphs + attached script glyphs.
    // Script-of-script chains resolve to the ultimate host — the intermediate
    // groups are not lines of their own, and stopping at the first level used
    // to DROP their glyphs entirely (eq (1)'s numerator vanished).
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
        if let Some(mut h) = host_of[i] {
            // follow the chain up (bounded: host_of is acyclic by construction,
            // a host always has host_of[j] == None at attach time — but guard
            // against future changes with a step cap)
            let mut steps = 0;
            while let Some(h2) = host_of[h] {
                h = h2;
                steps += 1;
                if steps > n {
                    break;
                }
            }
            if let Some(li) = host_line[h] {
                line_members[li].push(i);
            }
        }
    }

    // 4) Convert each line-membership into a Line with words.
    let mut lines: Vec<Line> = Vec::new();
    for members in &line_members {
        // x-spans of this line's prepass-claimed limit groups
        let mut limit_spans: Vec<(f64, f64)> = Vec::new();
        for &m in members {
            if limit_claimed[m] {
                limit_spans.push((gx0[m], gx1[m]));
            }
        }
        limit_spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut idxs: Vec<usize> =
            members.iter().flat_map(|&m| merged[m].3.clone()).collect();
        idxs.sort_by(|&a, &b| {
            items.glyphs[a].x.partial_cmp(&items.glyphs[b].x).unwrap().then(
                items.glyphs[a].y.partial_cmp(&items.glyphs[b].y).unwrap(),
            )
        });
        let refs: Vec<&Glyph> = idxs.iter().map(|&i| &items.glyphs[i]).collect();
        if let Some(mut line) = assemble_line(&refs, items) {
            line.glyph_ids = idxs.clone();
            line.limit_spans = limit_spans;
            lines.push(line);
        }
    }

    lines.sort_by(|a, b| {
        a.baseline.partial_cmp(&b.baseline).unwrap().then(a.x0.partial_cmp(&b.x0).unwrap())
    });
    lines
}

#[allow(unused_variables)]
fn assemble_line(gs: &[&Glyph], items: &PageItems) -> Option<Line> {    if gs.is_empty() {
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
    // Math-ness by GLYPH coverage, not word count: a sentence with a couple of
    // single-letter math words ("mean 0 and variance 1") has few math glyphs
    // but many math WORDS, and the word rule used to flip whole text lines
    // into display math. Real formulas are glyph-dominated.
    // A TeX-set formula line is math even when math fonts carry "only" a
    // quarter-plus of the TeX glyphs: eq (1) of 1406.2661 keeps its operator
    // names and digits in cmr ("min", "log", "1") and its variables in cmmi —
    // cmr there is part of the formula, not text. A paragraph with inline
    // math has a handful of math glyphs against hundreds of text glyphs and
    // stays text (the ricci title/paragraph case: 0 math fonts).
    let is_math_font = |g: &Glyph| {
        items.fonts.get(g.font).map(|f| f.is_math).unwrap_or(false) || g.latex.is_some()
    };
    let n_math_glyphs = gs.iter().filter(|g| is_math_font(g)).count();
    let n_tex_glyphs = gs
        .iter()
        .filter(|g| items.fonts.get(g.font).map(|f| f.tex != crate::font::TexKind::None).unwrap_or(false))
        .count();
    let is_math = n_math_glyphs * 2 > gs.len()
        || (n_math_glyphs >= 4 && n_math_glyphs * 4 > n_tex_glyphs)
        || (n_math_glyphs >= 2 && gs.len() <= 6);
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
        limit_spans: Vec::new(),
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

/// Baseline and size of one x-run of glyphs: the baseline is the row holding
/// the run's TALLEST glyphs (advance weight breaks ties — the same rule
/// `assemble_line`/math.rs's dominant_baseline use), the size their max.
fn run_metrics(items: &PageItems, run: &[usize]) -> (f64, f64) {
    let mut buckets: Vec<(f64, f64, f64)> = Vec::new(); // (y, max_size, advance)
    let mut size = 0.0f64;
    for &gi in run {
        let Some(g) = items.glyphs.get(gi) else { continue };
        size = size.max(g.size);
        let b = (g.y * 2.0).round() / 2.0;
        match buckets.iter_mut().find(|(y, _, _)| (*y - b).abs() < 0.51) {
            Some((_, ms, w)) => {
                *ms = ms.max(g.size);
                *w += g.wx.max(0.1);
            }
            None => buckets.push((b, g.size, g.wx.max(0.1))),
        }
    }
    let base = buckets
        .iter()
        .max_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap()
                .then(a.2.partial_cmp(&b.2).unwrap())
        })
        .map(|(y, _, _)| *y)
        .unwrap_or(0.0);
    (base, size.max(0.1))
}

fn dominant_size(gs: &[&Glyph]) -> f64 {    // Mode-ish: bucket sizes to 0.5pt and take the heaviest bucket weighted by
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::font::FontInfo;

    fn glyph(x: f64, y: f64, size: f64, text: &str, latex: Option<&str>) -> Glyph {
        Glyph {
            x,
            y,
            wx: text.chars().count() as f64 * size * 0.5,
            size,
            code: 0,
            text: text.into(),
            latex: latex.map(Into::into),
            font: 0,
        }
    }

    fn items_of(glyphs: Vec<Glyph>) -> PageItems {
        let mut items = PageItems::default();
        items.fonts.push(FontInfo::new());
        items.glyphs = glyphs;
        items
    }

    /// RC1 (chain flattening): a script of a script must land in the ultimate
    /// host line, never be dropped. eq (1) of 1706.03762 lost its numerator
    /// exactly this way: T → QK → (fraction host).
    #[test]
    fn script_of_script_chain_keeps_glyphs() {
        // host line at y=100 (5 glyphs), numerator "QK" raised 7pt, its
        // superscript "T" another 3.5pt up.
        let items = items_of(vec![
            glyph(10.0, 100.0, 10.0, "A", Some("A")),
            glyph(16.0, 100.0, 10.0, "t", Some("t")),
            glyph(22.0, 100.0, 10.0, "o", Some("o")),
            glyph(28.0, 100.0, 10.0, "m", Some("m")),
            glyph(34.0, 100.0, 10.0, "s", Some("s")),
            glyph(50.0, 93.0, 10.0, "Q", Some("Q")),
            glyph(56.0, 93.0, 10.0, "K", Some("K")),
            glyph(62.0, 89.5, 7.0, "T", Some("T")),
        ]);
        let lines = build_lines(&items);
        let total: usize = lines.iter().map(|l| l.glyph_ids.len()).sum();
        assert_eq!(total, 8, "every glyph must survive build_lines");
        // the superscript T must sit in the same line as the numerator QK
        let with_q = lines.iter().find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].text == "Q")).unwrap();
        assert!(with_q.glyph_ids.iter().any(|&i| items.glyphs[i].text == "T"),
            "T must join the line containing its numerator");
    }

    /// RC-main: an inline subscript (y ~1.5pt below the line, like d_model's
    /// "model") must join its line — the y-cluster is baseline-based, not
    /// sorted-order-based, so the subscript never "loses the race".
    #[test]
    fn inline_subscript_stays_in_its_line() {
        let items = items_of(vec![
            glyph(10.0, 100.0, 10.0, "w", None),
            glyph(16.0, 100.0, 10.0, "i", None),
            glyph(20.0, 100.0, 10.0, "t", None),
            glyph(24.0, 100.0, 10.0, "h", None),
            glyph(34.0, 100.0, 10.0, "d", Some("d")),
            glyph(41.0, 101.5, 7.0, "model", Some("model")),
            glyph(60.0, 100.0, 10.0, "e", None),
            glyph(64.0, 100.0, 10.0, "n", None),
            glyph(68.0, 100.0, 10.0, "d", None),
        ]);
        let lines = build_lines(&items);
        let with_d = lines.iter().find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].text == "d")).unwrap();
        assert!(with_d.glyph_ids.iter().any(|&i| items.glyphs[i].text == "model"),
            "the 'model' subscript must not become an orphan line");
        assert_eq!(lines.len(), 1, "one visual line, not text + orphan script");
    }

    /// RC-main (column/two-run case): two same-baseline runs split by a wide
    /// gap stay separate lines (columns/table cells) — but a gap occupied by
    /// the line's own scripts must NOT split the line.
    #[test]
    fn slot_occupied_by_scripts_does_not_split() {
        // "R" at 10..18, its superscript "dmodel" raised above the slot at
        // x 22..40, then "," at 44: the superscripts occupy the gap.
        let items = items_of(vec![
            glyph(10.0, 100.0, 10.0, "R", Some("R")),
            glyph(22.0, 96.5, 7.0, "d", Some("d")),
            glyph(26.0, 97.5, 7.0, "m", Some("m")),
            glyph(30.0, 97.5, 7.0, "o", Some("o")),
            glyph(34.0, 97.5, 7.0, "d", Some("d")),
            glyph(38.0, 97.5, 7.0, "e", Some("e")),
            glyph(42.0, 97.5, 7.0, "l", Some("l")),
            glyph(48.0, 100.0, 10.0, ",", None),
        ]);
        let lines = build_lines(&items);
        assert_eq!(lines.len(), 1, "the superscript slot must not split the line");
        let l = &lines[0];
        let txt: String = l.glyph_ids.iter().map(|&i| items.glyphs[i].text.as_str()).collect();
        assert_eq!(txt, "Rdmodel,");
    }

    /// A real column gutter (empty gap ~20pt) still splits.
    #[test]
    fn empty_gutter_gap_splits_runs() {
        let mut left: Vec<Glyph> = "abc".chars().enumerate()
            .map(|(i, c)| glyph(10.0 + 6.0 * i as f64, 100.0, 10.0, &c.to_string(), None))
            .collect();
        let right: Vec<Glyph> = "xyz".chars().enumerate()
            .map(|(i, c)| glyph(90.0 + 6.0 * i as f64, 100.0, 10.0, &c.to_string(), None))
            .collect();
        left.extend(right);
        let items = items_of(left);
        let lines = build_lines(&items);
        assert_eq!(lines.len(), 2, "two columns at the same baseline stay two runs");
    }

    /// RC-bigop: a cmex big operator with its origin above the line must
    /// attach DOWNWARD to its own line, never upward into the text line
    /// above (the footnote-4 ∑ of 1706.03762 shredded the line above).
    #[test]
    fn big_operator_attaches_downward_only() {
        let mut glyphs = vec![
            // text line above (y=100)
            glyph(8.0, 100.0, 10.0, "s", Some("s")),
            glyph(14.0, 100.0, 10.0, "o", Some("o")),
            glyph(20.0, 100.0, 10.0, "m", Some("m")),
            glyph(26.0, 100.0, 10.0, "e", Some("e")),
            // formula line below (y=111)
            glyph(10.0, 111.0, 10.0, "q", Some("q")),
            glyph(16.0, 111.0, 10.0, "k", Some("k")),
            // ∑ raised above the formula line, inside its x-range
            glyph(22.0, 104.5, 9.0, "P", Some("\\sum")),
            // the ∑'s upper limit
            glyph(25.0, 101.0, 6.0, "d", Some("d")),
        ];
        let items = items_of(glyphs);
        let lines = build_lines(&items);
        let with_sum = lines.iter().find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].latex.as_deref() == Some("\\sum"))).unwrap();
        assert!(with_sum.glyph_ids.iter().any(|&i| items.glyphs[i].latex.as_deref() == Some("q")),
            "the ∑ must join the formula line below, not the text line above");
        // and the line above must not contain the ∑'s limit either
        let above = lines.iter().find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].latex.as_deref() == Some("o"))).unwrap();
        assert!(!above.glyph_ids.iter().any(|&i| items.glyphs[i].latex.as_deref() == Some("\\sum")),
            "the text line above must not swallow the ∑");
    }

    /// GAN: display derivation lines are 1.096×size apart — they are separate
    /// formulas even though they are adjacent and mathy.
    #[test]
    fn adjacent_display_lines_do_not_merge_via_attachment() {
        // line 1 at y=100 (5 glyphs), line 2 at y=111 (5 glyphs), both 10pt
        let items = items_of(vec![
            glyph(10.0, 100.0, 10.0, "a", Some("a")),
            glyph(16.0, 100.0, 10.0, "b", Some("b")),
            glyph(22.0, 100.0, 10.0, "c", Some("c")),
            glyph(28.0, 100.0, 10.0, "d", Some("d")),
            glyph(34.0, 100.0, 10.0, "e", Some("e")),
            glyph(10.0, 111.0, 10.0, "f", Some("f")),
            glyph(16.0, 111.0, 10.0, "g", Some("g")),
            glyph(22.0, 111.0, 10.0, "h", Some("h")),
            glyph(28.0, 111.0, 10.0, "i", Some("i")),
            glyph(34.0, 111.0, 10.0, "j", Some("j")),
        ]);
        let lines = build_lines(&items);
        assert_eq!(lines.len(), 2, "two display lines 1.1×size apart stay two lines");
    }

    /// RC-piece-host: a group made only of cmex delimiter pieces (two tall
    /// brackets spanning a whole line) must never HOST that line. The eq(4)→
    /// (5) derivation of 1406.2661 merged into one interleaved blob when the
    /// row attached to its own brackets.
    #[test]
    fn delimiter_pieces_never_host_their_row() {
        let mut f = FontInfo::new();
        f.tex = crate::font::TexKind::Cmex;
        f.is_math = true;
        let mut g = Glyph { x: 0.0, y: 0.0, wx: 5.0, size: 10.0, code: 0, text: String::new(), latex: None, font: 1 };
        let mut items = PageItems::default();
        items.fonts.push(FontInfo::new());
        items.fonts.push(f);
        // row 1 at y=100: 5 glyphs
        let mut glyphs: Vec<Glyph> = "abcde"
            .chars()
            .enumerate()
            .map(|(i, c)| glyph(10.0 + 6.0 * i as f64, 100.0, 10.0, &c.to_string(), Some(&c.to_string())))
            .collect();
        // row 2 at y=122: 5 glyphs
        glyphs.extend(
            "fghij"
                .chars()
                .enumerate()
                .map(|(i, c)| glyph(10.0 + 6.0 * i as f64, 122.0, 10.0, &c.to_string(), Some(&c.to_string()))),
        );
        // the pieces: "[" at x=12 y=111 and "]" at x=38 y=111 — both inside
        // row 1's x-span; their group's bbox (12..43) spans the whole row,
        // which pre-fix let the row attach to its own brackets
        g.x = 12.0;
        g.y = 111.0;
        glyphs.push(g.clone());
        g.x = 38.0;
        glyphs.push(g);
        items.glyphs = glyphs;
        let lines = build_lines(&items);
        let texts: Vec<String> = lines
            .iter()
            .map(|l| {
                l.glyph_ids
                    .iter()
                    .filter_map(|&i| items.glyphs.get(i))
                    .map(|g| if g.text.is_empty() { "[]" } else { g.text.as_str() })
                    .collect()
            })
            .collect();
        assert_eq!(lines.len(), 2, "two display rows 2.2×size apart stay two lines, got {:?}", texts);
    }

    /// RC-limit-prepass: a ∑'s lower limit hangs ~2.2×size below the ∑'s
    /// ORIGIN (0.9×size below the line's baseline). A nearer ∫ on the NEXT
    /// line must not steal it (eq (3) of 1406.2661 doubled its limits).
    #[test]
    fn bigop_limit_belongs_to_the_line_with_the_op() {
        let mut f = FontInfo::new();
        f.tex = crate::font::TexKind::Cmmi;
        f.is_math = true;
        let mut items = PageItems::default();
        items.fonts.push(f);
        let mut glyphs: Vec<Glyph> = "pqrst"
            .chars()
            .enumerate()
            .map(|(i, c)| glyph(10.0 + 6.0 * i as f64, 100.0, 10.0, &c.to_string(), Some(&c.to_string())))
            .collect();
        // ∑ raised above its line (origin 0.95×size above the baseline)
        glyphs.push(Glyph {
            x: 37.0,
            y: 90.5,
            wx: 14.0,
            size: 10.0,
            code: 0,
            text: String::new(),
            latex: Some("\\sum".into()),
            font: 0,
        });
        // its lower limit "i=1" 0.9×size below the baseline, centered on ∑
        glyphs.push(glyph(38.0, 109.0, 7.0, "i", Some("i")));
        glyphs.push(glyph(44.0, 109.0, 7.0, "=", Some("=")));
        glyphs.push(glyph(50.0, 109.0, 7.0, "1", Some("1")));
        // the NEXT display line 1.2×size below, with its own ∫ under the same x
        glyphs.push(Glyph {
            x: 37.0,
            y: 112.0,
            wx: 6.0,
            size: 10.0,
            code: 0,
            text: String::new(),
            latex: Some("\\int".into()),
            font: 0,
        });
        glyphs.extend(
            "vwxyz"
                .chars()
                .enumerate()
                .map(|(i, c)| glyph(60.0 + 6.0 * i as f64, 112.0, 10.0, &c.to_string(), Some(&c.to_string()))),
        );
        items.glyphs = glyphs;
        let lines = build_lines(&items);
        let with_sum = lines
            .iter()
            .find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].latex.as_deref() == Some("\\sum")))
            .expect("∑ must survive");
        let ids: Vec<&str> = with_sum
            .glyph_ids
            .iter()
            .map(|&i| items.glyphs[i].text.as_str())
            .collect();
        // the limit joined the ∑'s line, not the next line's ∫
        assert!(ids.contains(&"i"), "the ∑'s limit must be on the ∑'s line, got {:?}", ids);
        let with_int = lines
            .iter()
            .find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].latex.as_deref() == Some("\\int")))
            .expect("∫ must survive");
        let int_ids: Vec<&str> = with_int
            .glyph_ids
            .iter()
            .map(|&i| items.glyphs[i].text.as_str())
            .collect();
        assert!(!int_ids.contains(&"i"), "the next line must not steal the limit, got {:?}", int_ids);
    }

    /// content.rs: the fraction bar drawn as a q/cm/m/l/S stroke line must
    /// become a Rule AT THE CORRECT y (the `cm` composition was reversed and
    /// pushed every bar ~800pt below the page).
    #[test]
    fn cm_translation_maps_stroke_bar_to_device_space() {
        use lopdf::{dictionary, Object, Stream};
        use std::io::Write;
        let mut doc = lopdf::Document::with_version("1.5");
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"q 1 0 0 1 355.609 313.718 cm 0.398 w 0 0 m 23.326 0 l S Q").unwrap();
        let packed = enc.finish().unwrap();
        let contents = doc.add_object(Object::Stream(Stream::new(
            dictionary! { "Filter" => "FlateDecode" },
            packed,
        )));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Contents" => contents,
            "MediaBox" => Object::Array(vec![
                Object::Integer(0), Object::Integer(0), Object::Integer(612), Object::Integer(792),
            ]),
        });
        let items = crate::content::Interp::new(&doc, &mut std::collections::HashMap::new())
            .run_page(page_id)
            .unwrap();
        assert_eq!(items.rules.len(), 1, "the stroke bar must become a rule");
        let r = &items.rules[0].rect;
        assert!((r.y0 - 478.282).abs() < 0.1, "bar y = 792-313.718, got {:.3}", r.y0);
        assert!((r.x0 - 355.609).abs() < 0.1);
        assert!((r.x1 - 378.935).abs() < 0.1);
        assert_eq!(r.y1, r.y0, "zero-height stroke line");
    }

    /// RC-radical: a radical glyph's ORIGIN is its covering bar, ~1×size ABOVE
    /// the radicand's baseline (the glyph hangs down from the bar). Clustered by
    /// origin it welds into the text line above and lands inside its words —
    /// p4 of 1706.03762 printed "a $\surd$ nd" for "and" plus the √ of the
    /// `1/\sqrt{d_k}` on the NEXT line. It must be its own group and attach
    /// DOWNWARD to the line holding the radicand, like a big operator.
    #[test]
    fn radical_joins_the_line_below_its_bar() {
        let mut items = PageItems::default();
        items.fonts.push(FontInfo::new());
        let mut glyphs: Vec<Glyph> = "queries and keys".chars().enumerate()
            .map(|(i, c)| glyph(10.0 + 6.0 * i as f64, 100.0, 10.0, &c.to_string(), None))
            .collect();
        // the radical: origin ON the bar, 10.3pt above the formula line below
        glyphs.push(glyph(200.0, 100.3, 10.0, "√", Some("\\surd")));
        // the formula line it belongs to
        glyphs.push(glyph(208.0, 110.5, 10.0, "d", Some("d")));
        glyphs.push(glyph(214.0, 111.8, 7.0, "k", Some("k")));
        items.glyphs = glyphs;
        let lines = build_lines(&items);
        let text: String = lines
            .iter()
            .find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].text == "q"))
            .map(|l| l.glyph_ids.iter().map(|&i| items.glyphs[i].text.as_str()).collect())
            .expect("the text line must survive");
        assert!(!text.contains('√'), "the radical must not land in the text line above: {:?}", text);
        let with_radical: String = lines
            .iter()
            .find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].latex.as_deref() == Some("\\surd")))
            .map(|l| l.glyph_ids.iter().map(|&i| items.glyphs[i].text.as_str()).collect())
            .expect("the radical must survive");
        assert_eq!(
            with_radical, "√dk",
            "the radical must join its radicand's line, not stay an orphan line"
        );
    }

    /// RC-split-run: a run SPLIT off a baseline cluster carries its own
    /// baseline and size — the numbers are ricci p13's display formula. The
    /// integral's `0` limit clusters with the denominator row (`2\tau`, 12pt)
    /// 2.64pt above it; the split `0` inherited the denominator's baseline and
    /// 12pt size, the big-op prepass then rejected it BY SIZE and every host
    /// rejected it by distance, so the limit fell out as its own paragraph
    /// ("0 13" in the markdown).
    #[test]
    fn split_run_keeps_its_own_baseline_and_size() {
        let mut items = PageItems::default();
        items.fonts.push(FontInfo::new());
        let mut glyphs: Vec<Glyph> = vec![
            glyph(230.52, 650.16, 11.96, "Z", Some("\\int")),
            // the integral's upper limit (a side script)
            glyph(242.52, 653.40, 7.97, "\\tau", Some("\\tau")),
            glyph(247.20, 653.40, 7.97, "(", None),
            glyph(250.44, 653.40, 7.97, "q", Some("q")),
            glyph(254.52, 653.40, 7.97, ")", None),
            // the fraction row: `2\tau` at y=674.64 …
            glyph(273.48, 674.64, 11.96, "2", Some("2")),
            glyph(279.36, 674.64, 11.96, "\\tau", Some("\\tau")),
            // … and the `0` limit 2.64pt BELOW it (same baseline cluster)
            glyph(237.12, 677.28, 7.97, "0", Some("0")),
            // the row the integral decorates
            glyph(289.56, 666.48, 11.96, "+", None),
            glyph(301.32, 666.48, 11.96, "R", Some("R")),
            glyph(312.96, 666.48, 11.96, "+", None),
            glyph(367.20, 666.48, 11.96, "d", Some("d")),
            glyph(373.32, 666.48, 11.96, "\\tau", Some("\\tau")),
        ];
        glyphs[0].wx = 6.65;
        glyphs[5].wx = 5.86;
        glyphs[6].wx = 5.08;
        items.glyphs = glyphs;
        let lines = build_lines(&items);
        let with_zero = lines
            .iter()
            .find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].text == "0"))
            .expect("the 0 must survive");
        assert!(
            with_zero
                .glyph_ids
                .iter()
                .any(|&i| items.glyphs[i].latex.as_deref() == Some("\\int")),
            "the 0 keeps its own row's metrics and reaches the integral it limits, got size {:.1} baseline {:.1}",
            with_zero.size,
            with_zero.baseline
        );
    }

    /// RC-limit-across-rows: a limit claim must not reach a script cluster that
    /// lies in ANOTHER row's script band. The `\partial` numerator of ricci
    /// p11's next-line `\frac{\partial}{\partial\beta}` sat 2.8×size below a
    /// bare ∫ and was claimed as its lower limit: the markdown printed
    /// `Z=_{\partial}\int\limits_{\partial}` and the numerator was dragged
    /// into the wrong line.
    #[test]
    fn limit_claim_does_not_cross_a_row() {
        let mut items = PageItems::default();
        items.fonts.push(FontInfo::new());
        let mut glyphs: Vec<Glyph> = vec![
            // the row the integral decorates (a text/formula row spanning it)
            glyph(158.40, 348.36, 11.96, "p", None),
            glyph(181.32, 348.36, 11.96, "i", None),
            glyph(300.00, 348.36, 11.96, "s", None),
            glyph(350.00, 348.36, 11.96, "g", None),
            // the bare integral (its origin raised above its row)
            glyph(267.12, 338.76, 11.96, "Z", Some("\\int")),
            // the NEXT row and the numerator sitting in its script band
            glyph(191.04, 377.28, 11.96, "<", Some("<")),
            glyph(204.24, 377.28, 11.96, "E", Some("E")),
            glyph(217.69, 377.28, 11.96, ">", Some(">")),
            glyph(226.80, 377.28, 11.96, "=", None),
            glyph(253.08, 372.60, 7.97, "\\partial", Some("\\partial")),
        ];
        glyphs[4].wx = 5.64;
        items.glyphs = glyphs;
        let lines = build_lines(&items);
        let with_partial = lines
            .iter()
            .find(|l| l.glyph_ids.iter().any(|&i| items.glyphs[i].text == "\\partial"))
            .expect("the \\partial must survive");
        assert!(
            !with_partial
                .glyph_ids
                .iter()
                .any(|&i| items.glyphs[i].latex.as_deref() == Some("\\int")),
            "a script cluster of the next row is not the operator's limit"
        );
    }
}
