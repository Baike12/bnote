//! Formula reconstruction: glyph runs + rules → LaTeX.
//!
//! Pure geometry, no OCR: superscripts/subscripts from size+offset, fractions
//! from rules with numerator/denominator clusters, radicals from the radical
//! glyph + covering bar, big operators with centered limits, accent wrapping,
//! and conservative matrix/cases detection.

use crate::content::{Glyph, Rule};
use crate::font::FontInfo;
use crate::geom::Rect;
use crate::glyphdata;
use crate::layout::is_cjk_char;

pub struct MathRun<'a> {
    pub glyphs: Vec<&'a Glyph>,
    pub rules: Vec<&'a Rule>,
    /// x-spans of glyph groups the layout pass claimed as big-operator
    /// limits (display-style limits wider than the operator itself).
    /// Empty for sub-runs.
    pub limit_spans: Vec<(f64, f64)>,
}

/// Big operators that take centered limits (see layout.rs's LIMIT_OPS: the
/// layout pass claims their limit clusters, this pass consumes the claims).
pub(crate) const LIMIT_OPS: [&str; 10] = [
    "\\sum", "\\prod", "\\coprod", "\\int", "\\oint", "\\iint", "\\iiint",
    "\\bigcup", "\\bigcap", "\\bigoplus",
];

/// Glyph index of the big operator a limit cluster at center `c` hangs from:
/// the operator whose own center is nearest. Used to keep a line-level claimed
/// limit span from being honoured by a different operator on the same line.
fn limit_owner(glyphs: &[&Glyph], c: f64) -> usize {
    let mut best = usize::MAX;
    let mut best_d = f64::MAX;
    for (k, g) in glyphs.iter().enumerate() {
        let is_op = g
            .latex
            .as_deref()
            .map(|l| LIMIT_OPS.contains(&l))
            .unwrap_or(false);
        if !is_op {
            continue;
        }
        let d = (g.x + g.wx / 2.0 - c).abs();
        if d < best_d {
            best_d = d;
            best = k;
        }
    }
    best
}

/// Reconstructs LaTeX for a run of glyphs (already sorted by x).
/// Unrecoverable situations are reported into `warn` (deduped by the caller).
pub fn reconstruct(run: &MathRun, fonts: &[FontInfo], warn: &mut Vec<String>) -> String {
    if run.glyphs.is_empty() {
        return String::new();
    }
    let mut glyphs = run.glyphs.clone();
    glyphs.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    let base_size = glyphs.iter().map(|g| g.size).fold(0.0f64, f64::max);
    // Same height gate as rule generation in content.rs: thin bars of any
    // provenance (re rects, stroke lines) are fraction/radical bar candidates.
    let rules: Vec<&Rule> = run
        .rules
        .iter()
        .filter(|r| r.rect.width() > 1.5 && r.rect.height() <= 3.5)
        .copied()
        .collect();
    let mut dropped = 0usize;
    let debug = std::env::var("PDF2MD_MATH_DEBUG").is_ok();
    let wraps = std::cell::RefCell::new(std::collections::HashMap::new());
    let mut out = Builder {
        fonts,
        rules: &rules,
        used_rules: vec![false; rules.len()],
        warn,
        dropped: &mut dropped,
        limit_spans: &run.limit_spans,
        wraps: &wraps,
    }
    .build(&glyphs, None, base_size);
    if debug {
        let src: String = glyphs.iter().map(|g| g.text.as_str()).collect::<Vec<_>>().join("");
        eprintln!("[math] in={:?} rules={} -> {:?}", src, rules.len(), out.trim());
        for g in &glyphs {
            eprintln!(
                "[glyph] x={:.2} y={:.2} wx={:.2} sz={:.2} {:?} latex={:?}",
                g.x, g.y, g.wx, g.size, g.text, g.latex
            );
        }
        for (ri, r) in rules.iter().enumerate() {
            eprintln!(
                "[rule#{}] x0={:.2} y0={:.2} x1={:.2} y1={:.2} w={:.2} h={:.2}",
                ri, r.rect.x0, r.rect.y0, r.rect.x1, r.rect.y1, r.rect.width(), r.rect.height()
            );
        }
    }
    out = out.trim().to_string();
    if out.is_empty() {
        // fall back to raw text
        out = glyphs.iter().map(|g| g.text.clone()).collect();
        if !out.trim().is_empty() {
            warn.push("公式无法结构化还原，已按原始字符输出".into());
        }
    }
    if dropped > 0 {
        warn.push(format!("{} 个数学字形（cmex 大定界符等）解不出 LaTeX，已丢弃", dropped));
    }
    out
}

struct Builder<'a> {
    fonts: &'a [FontInfo],
    rules: &'a [&'a Rule],
    used_rules: Vec<bool>,
    warn: &'a mut Vec<String>,
    dropped: &'a mut usize,
    limit_spans: &'a [(f64, f64)],
    /// Rewritten atoms by glyph ADDRESS (see fold_accent): an accented base
    /// that was still pending as a script glyph of the enclosing level. Shared
    /// with every nested Builder — the pending script's body is built there.
    wraps: &'a std::cell::RefCell<std::collections::HashMap<usize, String>>,
}

impl<'a> Builder<'a> {
    /// Builds a (sub-)expression. `base_y` = the baseline of the enclosing
    /// level (None = infer); `base_size` = font size reference.
    fn build(&mut self, glyphs: &[&Glyph], base_y: Option<f64>, base_size: f64) -> String {
        if glyphs.is_empty() {
            return String::new();
        }

        // ---- matrix / cases detection (multi-row with grid structure) ----
        if let Some(s) = self.try_matrix(glyphs, base_size) {
            return s;
        }

        // ---- fraction detection: find the top-level bar ----
        if let Some((bar_idx, above, mid, below)) = self.split_fraction(glyphs) {
            let bar = self.rules[bar_idx].rect;
            let num_size = above.iter().map(|g| g.size).fold(0.0f64, f64::max).max(base_size * 0.5);
            let den_size = below.iter().map(|g| g.size).fold(0.0f64, f64::max).max(base_size * 0.5);
            // Build both sides BEFORE committing to the fraction: a cluster
            // whose glyphs all turn out to be dropped pieces builds to nothing,
            // and `\frac{}{}` must never reach the markdown (an arrow shaft
            // with a glyph in its slot is still not a fraction). Bailing out
            // restores the rule bookkeeping so the linear pass below sees the
            // same state it would have.
            let saved_rules = self.used_rules.clone();
            let num = self.build(&above, None, num_size);
            let den = self.build(&below, None, den_size);
            if !num.is_empty() && !den.is_empty() {
            self.used_rules[bar_idx] = true;
            // mid glyphs sit beside the fraction on the main baseline. Their
            // enclosing baseline must be INFERRED like the linear pass does —
            // classifying them against None made every inline script beside a
            // fraction a plain atom (∑ limits flattened to "i=m1", ∇θ_d lost
            // its subscript: the GAN Algorithm-1 update lines).
            let mid_main_y = match base_y {
                Some(y) => y,
                None => dominant_baseline(&mid),
            };
            let mid_size_ref = mid
                .iter()
                .filter(|g| (g.y - mid_main_y).abs() < 0.6 * g.size)
                .map(|g| g.size)
                .fold(0.0f64, f64::max)
                .max(base_size * 0.6);
            let mut mid_consumed = vec![false; mid.len()];
            let mut out = String::new();
            let mut sup: Vec<&Glyph> = Vec::new();
            let mut sub: Vec<&Glyph> = Vec::new();
            let bar_cx = (bar.x0 + bar.x1) / 2.0;
            let mut frac_placed = false;
            let frac_latex = format!("\\frac{{{}}}{{{}}}", num, den);
            // A fraction whose numerator AND denominator both sit above (or
            // both below) the enclosing baseline is not a sibling of the run:
            // it is the SCRIPT of the atom before it. `(4\pi\tau)^{-n/2}` came
            // out as `(4\pi\tau)^{-}\frac{n}{2}` because the fraction was emitted
            // beside the run instead of inside the exponent.
            let frac_script = if mid.is_empty() {
                None // no base atom on this level: the fraction stands alone
            } else {
                let all_above = above
                    .iter()
                    .chain(below.iter())
                    .all(|g| g.y < mid_main_y - 0.08 * mid_size_ref);
                let all_below = above
                    .iter()
                    .chain(below.iter())
                    .all(|g| g.y > mid_main_y + 0.08 * mid_size_ref);
                if all_above {
                    Some('^')
                } else if all_below {
                    Some('_')
                } else {
                    None
                }
            };
            // Other bars among the beside glyphs are fractions of their OWN:
            // `\frac{d}{dt} logV=\frac{1}{V}\int RdV` is two fractions on one
            // baseline, and the second one's stack is not a script of the `=`
            // that precedes it. Its glyphs are claimed here (built as a
            // fraction and emitted at the bar's x), so the beside pass sees the
            // enclosing level's atoms only — before this, `\frac{1}{V}` beside
            // `\frac{d}{dt}` collapsed to `=_{V}^{1}`.
            let mut beside: Vec<(f64, String, Option<char>)> = Vec::new();
            for (ri, r) in self.rules.iter().enumerate() {
                if ri == bar_idx || self.used_rules[ri] || r.rect.height() > 2.0 {
                    continue;
                }
                let rr = r.rect;
                let Some((a, b)) = slotted_stack(&mid, rr) else { continue };
                let bs = a.iter().map(|g| g.size).fold(0.0f64, f64::max).max(base_size * 0.5);
                let ds = b.iter().map(|g| g.size).fold(0.0f64, f64::max).max(base_size * 0.5);
                let n = self.build(&a, None, bs);
                let d = self.build(&b, None, ds);
                if n.is_empty() || d.is_empty() {
                    continue;
                }
                self.used_rules[ri] = true;
                for (mi, g) in mid.iter().enumerate() {
                    let cx = g.x + g.wx / 2.0;
                    if cx >= rr.x0 - 1.0 && cx <= rr.x1 + 1.0 {
                        mid_consumed[mi] = true;
                    }
                }
                // …and a beside fraction set wholly above/below the line is a
                // SCRIPT of the atom before it, like the main fraction.
                let raised = a
                    .iter()
                    .chain(b.iter())
                    .all(|g| g.y < mid_main_y - 0.08 * mid_size_ref);
                let lowered = a
                    .iter()
                    .chain(b.iter())
                    .all(|g| g.y > mid_main_y + 0.08 * mid_size_ref);
                let script = if raised {
                    Some('^')
                } else if lowered {
                    Some('_')
                } else {
                    None
                };
                beside.push(((rr.x0 + rr.x1) / 2.0, format!("\\frac{{{}}}{{{}}}", n, d), script));
            }
            beside.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let mut beside_done = vec![false; beside.len()];
            for (mi, g) in mid.iter().enumerate() {
                if mid_consumed[mi] {
                    continue;
                }
                for (fi, (fx, flatex, fscript)) in beside.iter().enumerate() {
                    if !beside_done[fi] && g.x >= *fx {
                        beside_done[fi] = true;
                        match fscript {
                            Some(_) => push_fraction(
                                &mut out, &mut sup, &mut sub, self.fonts, mid_size_ref,
                                self.warn, *fscript, flatex, self.wraps,
                            ),
                            None => push_sep(&mut out, flatex),
                        }
                    }
                }
                // Accent glyphs beside the bar modify their base too: handling
                // them only in the linear pass left every `\tilde{g}_{ij}` of a
                // formula that also carries a fraction as a floating macro
                // (`g\tilde{}_{ij}`, 20 times in math0211159).
                if self.fold_accent(&mid, mi, &mut mid_consumed, &mut out, &mut sup, &mut sub) {
                    continue;
                }
                let cls = classify_script(g, Some(mid_main_y), mid_size_ref);
                match cls {
                    Script::Sup => sup.push(g),
                    Script::Sub => sub.push(g),
                    Script::Normal => {
                        flush_scripts(&mut out, &mut sup, &mut sub, self.fonts, mid_size_ref, self.warn, self.wraps);
                        // big operator with centered limits?
                        if let Some(limits) = self.try_limits(&mid, mi, &mut mid_consumed, mid_main_y, mid_size_ref) {
                            if !frac_placed && g.x >= bar_cx {
                                push_fraction(&mut out, &mut sup, &mut sub, self.fonts, mid_size_ref, self.warn, frac_script, &frac_latex, self.wraps);
                                frac_placed = true;
                            }
                            push_sep(&mut out, &limits);
                            continue;
                        }
                        if !frac_placed && g.x >= bar_cx {
                            push_fraction(&mut out, &mut sup, &mut sub, self.fonts, mid_size_ref, self.warn, frac_script, &frac_latex, self.wraps);
                            frac_placed = true;
                        }
                        // A RADICAL among the beside glyphs brings its own
                        // radicand (`=\sqrt{2N\tau(q)}+...` is all one run
                        // beside the fraction of the same line).
                        let gl = self.atom_latex(g);
                        if gl == "\\surd" || gl == "√" {
                            mid_consumed[mi] = true;
                            let rad = self.radical_at(&mid, mi, &mut mid_consumed, mid_size_ref);
                            push_sep(&mut out, &rad);
                            continue;
                        }
                        push_sep(&mut out, &self.atom_sized(g, mid_size_ref));
                    }
                    Script::LimitAbove | Script::LimitBelow => {
                        sup.push(g);
                    }
                }
            }
            flush_scripts(&mut out, &mut sup, &mut sub, self.fonts, mid_size_ref, self.warn, self.wraps);
            if !frac_placed {
                push_fraction(&mut out, &mut sup, &mut sub, self.fonts, mid_size_ref, self.warn, frac_script, &frac_latex, self.wraps);
            }
            return out;
            } else {
                self.used_rules = saved_rules;
            }
        }

        // ---- linear pass: scripts, limits, radicals, accents ----
        let main_y = match base_y {
            Some(y) => y,
            None => dominant_baseline(glyphs),
        };
        let size_ref = glyphs
            .iter()
            .filter(|g| (g.y - main_y).abs() < 0.6 * g.size)
            .map(|g| g.size)
            .fold(0.0f64, f64::max)
            .max(base_size * 0.6);

        // Big operators with limits: mark consumed glyphs.
        let mut consumed = vec![false; glyphs.len()];
        let mut out = String::new();
        let mut sup: Vec<&Glyph> = Vec::new();
        let mut sub: Vec<&Glyph> = Vec::new();
        // A script centered UNDER a multi-glyph base word (\min_G, \max_D: the
        // limit sits below the middle of the whole operator) is x-interleaved
        // with the word's own glyphs. Left in x order it attaches to a letter
        // in the middle ("m_G in m_D ax"). When a script's span lies inside
        // the span of the adjacent normal-glyph word and its center matches
        // the word's center, it belongs to the word END — hold it until the
        // word's last glyph is emitted.
        let mut deferred_scripts: Vec<(usize, Script)> = Vec::new();
        let mut defer_end_x = f64::MIN;
        // Words of adjacent Normal glyphs, in x order — precomputed in ONE
        // pass (the per-script walk this replaces was O(n²) per line and hung
        // on page-size math regions). Scripts and consumed glyphs do not
        // interrupt a run: \min_G's G sits between m and i, the run spans all
        // of "min".
        let glyph_runs = normal_runs(glyphs, main_y, size_ref);
        let mut i = 0;
        while i < glyphs.len() {
            if consumed[i] {
                i += 1;
                continue;
            }
            let g = glyphs[i];

            // flush run-deferred scripts once the word is behind us
            if !deferred_scripts.is_empty() && g.x > defer_end_x + 0.5 {
                for (di, cls) in deferred_scripts.drain(..) {
                    match cls {
                        Script::Sub => sub.push(glyphs[di]),
                        _ => sup.push(glyphs[di]),
                    }
                }
            }

            // radical: \surd / √
            let lx = self.atom_latex(g);
            if lx == "\\surd" || lx == "√" {
                consumed[i] = true;
                let rad = self.radical_at(glyphs, i, &mut consumed, size_ref);
                push_sep(&mut out, &rad);
                i += 1;
                continue;
            }

            // Accent glyphs (`\bar`, `\hat`, `\tilde`, a bare macron) are
            // modifiers, not atoms — see fold_accent.
            if self.fold_accent(glyphs, i, &mut consumed, &mut out, &mut sup, &mut sub) {
                i += 1;
                continue;
            }

            let cls = classify_script(g, Some(main_y), size_ref);
            if matches!(cls, Script::Sup | Script::Sub) {
                // run-center deferral check (see deferred_scripts above)
                if let Some(run) = run_containing(glyph_runs.as_slice(), g) {
                    if run.1 - run.0 > g.wx * 1.2 {
                        let sc = g.x + g.wx / 2.0;
                        let wc = (run.0 + run.1) / 2.0;
                        let contained = g.x >= run.0 - 1.0 && g.x + g.wx <= run.1 + 1.0;
                        let centered = (sc - wc).abs() <= (0.75 * g.wx).max(0.1 * (run.1 - run.0));
                        if contained && centered {
                            deferred_scripts.push((i, cls));
                            defer_end_x = defer_end_x.max(run.1);
                            i += 1;
                            continue;
                        }
                    }
                }
            }
            match cls {
                Script::Normal => {
                    flush_scripts(&mut out, &mut sup, &mut sub, self.fonts, size_ref, self.warn, self.wraps);
                    // big operator with limits?
                    if let Some(limits) = self.try_limits(glyphs, i, &mut consumed, main_y, size_ref) {
                        out.push_str(&limits);
                        i += 1;
                        continue;
                    }
                    push_sep(&mut out, &self.atom_sized(g, size_ref));
                }
                Script::Sup => sup.push(g),
                Script::Sub => sub.push(g),
                Script::LimitAbove | Script::LimitBelow => {
                    // stray centered glyph (no big op): treat as script of prev
                    sup.push(g);
                }
            }
            i += 1;
        }
        for (di, cls) in deferred_scripts.drain(..) {
            match cls {
                Script::Sup => sup.push(glyphs[di]),
                _ => sub.push(glyphs[di]),
            }
        }
        flush_scripts(&mut out, &mut sup, &mut sub, self.fonts, size_ref, self.warn, self.wraps);
        out
    }

    /// LaTeX of the radical glyph at `i`: its covering bar defines the
    /// radicand (the glyphs whose boxes sit under the bar), which is built as
    /// its own expression. Used by the linear pass AND by the glyphs beside a
    /// fraction bar — an inline `=\sqrt{2N\tau(q)}+...` is one long beside-run,
    /// and emitting the √ there as a bare atom left `=\surd2N\tau(q)`.
    fn radical_at(
        &mut self,
        glyphs: &[&Glyph],
        i: usize,
        consumed: &mut [bool],
        size_ref: f64,
    ) -> String {
        let g = glyphs[i];
        // find covering bar
        let mut bar_ri: Option<usize> = None;
        let mut bar = Rect::empty();
        let mut radicand: Vec<&Glyph> = Vec::new();
        for (ri, r) in self.rules.iter().enumerate() {
            if self.used_rules[ri] {
                continue;
            }
            let rr = r.rect;
            if !is_covering_bar(g, rr) {
                continue;
            }
            {
                bar = rr;
                // radicand = glyphs whose bbox sits under the bar
                for (k, g2) in glyphs.iter().enumerate() {
                    if consumed[k] || k == i {
                        continue;
                    }
                    let b2 = g2.bbox();
                    // The radicand ends where the bar ends: TeX sizes the bar to
                    // the radicand box, so a glyph whose CENTER lies past the
                    // bar is not under it. The old ink test allowed half a size
                    // of overhang, which swallowed the atom AFTER the radical —
                    // ricci's `\int\sqrt{...|^2}d\tau` kept the differential
                    // inside the radicand (`\sqrt{...\vert ^{2} d}`).
                    let cx2 = g2.x + g2.wx / 2.0;
                    if b2.x0 >= bar.x0 - 1.0
                        && cx2 <= bar.x1 + g.size * 0.12
                        && b2.y1 > bar.y0 - 0.5
                    {
                        radicand.push(g2);
                        consumed[k] = true;
                    }
                }
                self.used_rules[ri] = true;
                bar_ri = Some(ri);
                break;
            }
        }
        radicand.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        // The radicand sits on its own baseline (typically ~1×size
        // below the √'s origin) — the parent baseline is meaningless
        // for it, so let the sub-build infer (its scripts would
        // otherwise be mis-classified against the wrong baseline and
        // \sqrt{d_k} degraded to \sqrt{dk}).
        let inner = self.build(&radicand, None, size_ref);
        // Only NOW claim the bars the radicand enclosed: claiming them before
        // the sub-build stripped the radicand of its own fractions
        // (`\sqrt{\frac{N}{2\tau}+R}` came out as `\sqrt{2N\tau+R}` with the
        // fraction gone). After the build, the claim still keeps a sibling
        // sub-expression from stealing them.
        if bar_ri.is_some() {
            for (rj, r2) in self.rules.iter().enumerate() {
                if self.used_rules[rj] || Some(rj) == bar_ri {
                    continue;
                }
                if r2.rect.x0 >= bar.x0 && r2.rect.x1 <= bar.x1 + 1.0 {
                    self.used_rules[rj] = true;
                }
            }
        }
        let index = sub_script_of(glyphs, consumed, i, true);
        if inner.is_empty() {
            // nothing that builds under the bar: emit the bare radical
            // sign — `\sqrt{}` is noise (and was all over earlier
            // outputs), and an index without a radicand has no
            // well-formed TeX form either.
            "\\surd".to_string()
        } else {
            format!("\\sqrt{}{{{}}}", index, inner)
        }
    }



    /// Big operator (\sum,\prod,\int,\bigcup…) with glyphs centered directly
    /// above/below → `\sum_{sub}^{sup}` (with \limits for integrals).
    fn try_limits(        &mut self,
        glyphs: &[&Glyph],
        i: usize,
        consumed: &mut [bool],
        main_y: f64,
        size_ref: f64,
    ) -> Option<String> {
        let g = glyphs[i];
        let lx = self.atom_latex(g);
        const SIDE_OPS: [&str; 6] = ["\\biguplus", "\\bigvee", "\\bigwedge", "\\bigodot", "\\bigotimes", "\\bigsqcup"];
        let is_limit_op = LIMIT_OPS.contains(&lx.as_str());
        let is_side_op = SIDE_OPS.contains(&lx.as_str());
        if !is_limit_op && !is_side_op {
            return None;
        }
        let op_cx = g.x + g.wx / 2.0;
        let op_w = g.wx.max(g.size);
        // Display-style limits can be much WIDER than the operator
        // (\sum_{K\in K^d, J\in \mathbb{N}^d}); the layout pass claims
        // those clusters and hands their x-spans down — glyphs inside a
        // claimed span belong to this operator regardless of the narrow
        // per-glyph window.
        //
        // A span is a LINE-level fact, though: every operator on the line sees
        // all of them, so a span may only be honoured by the operator it was
        // claimed for — the big operator the cluster sits under, i.e. the
        // nearest one in x. Without the ownership test eq (3) of 1406.2661
        // merged both integrals' limits into `\int\limits_{xz}` (the second
        // ∫'s `z` span was inside the first ∫'s lookup) and left the second ∫
        // bare.
        let in_limit_span = |c: f64| {
            self.limit_spans.iter().any(|&(a, b)| c >= a - 1.0 && c <= b + 1.0)
                && limit_owner(glyphs, c) == i
        };
        // TeX also sets a big operator's limits BESIDE it: `\int_0^{\tau(q)}`
        // in text style puts the subscript at the operator's right edge and the
        // superscript above it. The centered window misses those, and the
        // cluster then hangs on whatever atom is emitted last — ricci p13's
        // `\int_0^{\tau(q)}\sqrt{...}` came out as `\sqrt{...}^{\tau(q)}`
        // with the ∫ bare. One size around the operator's box, restricted to
        // the operator the cluster sits under (limit_owner).
        // …the window is generous (the cluster is as wide as its own text —
        // `\tau(q)` spans 15pt) and stays safe because a glyph is only a limit
        // when it is SCRIPT-SIZED (see below) and the operator it sits under is
        // the nearest one (limit_owner).
        let beside_op = |c: f64| {
            c >= g.x - 0.25 * g.size
                && c <= g.x + g.wx + 2.5 * g.size
                && limit_owner(glyphs, c) == i
        };
        let mut above: Vec<&Glyph> = Vec::new();
        let mut below: Vec<&Glyph> = Vec::new();
        for (k, g2) in glyphs.iter().enumerate() {
            if consumed[k] || k == i {
                continue;
            }
            // A radical — or a second operator — is an ATOM, never a limit: the
            // √ of `\int\sqrt{...}` sits in the ∫'s own window and was claimed
            // as its upper limit (`\int\limits_{0}^{\surd _{\tau(q)}}`).
            if is_radical_latex(g2)
                || g2.latex.as_deref().map(|l| LIMIT_OPS.contains(&l)).unwrap_or(false)
            {
                continue;
            }
            let c2 = g2.x + g2.wx / 2.0;
            if (c2 - op_cx).abs() > op_w * 0.75 && !in_limit_span(c2) && !beside_op(c2) {
                continue;
            }
            let dy = g2.y - main_y;
            if dy < -0.55 * size_ref {
                above.push(g2);
                consumed[k] = true;
            } else if dy > 0.75 * size_ref && g2.size <= size_ref * 1.05 {
                below.push(g2);
                consumed[k] = true;
            }
        }
        if above.is_empty() && below.is_empty() {
            return None;
        }
        above.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        below.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        let sup = self.build(&above, None, size_ref * 0.8);
        let sub = self.build(&below, None, size_ref * 0.8);
        let limits_cmd = if is_limit_op && lx.starts_with("\\i") {
            "\\limits"
        } else {
            ""
        };
        let mut s = format!("{}{}", lx, limits_cmd);
        if !sub.is_empty() {
            s.push_str(&format!("_{{{}}}", sub));
        }
        if !sup.is_empty() {
            s.push_str(&format!("^{{{}}}", sup));
        }
        Some(s)
    }

    /// Accent glyphs (`\bar`, `\hat`, `\tilde`, a bare macron…) modify the
    /// atom they sit on instead of being atoms themselves: the accent wraps its
    /// BASE glyph. The base is looked up geometrically among the glyphs before
    /// the accent (TeX draws the accent after its base, with an italic
    /// overhang) and the immediate next one — producers also draw it exactly ON
    /// top of the base, with the accent's origin on the baseline, where any
    /// y-based test fails.
    ///
    /// Folds the accent into that base: the wrapped atom replaces the base's
    /// text in `out`, or rewrites the base's entry when the base is still
    /// PENDING as a script glyph of this level (TeX draws the accent of
    /// `|_{t=\bar t}` while the subscript cluster is open). Returns true when
    /// `glyphs[i]` was an accent and is now consumed.
    #[allow(clippy::too_many_arguments)]
    fn fold_accent(
        &mut self,
        glyphs: &[&Glyph],
        i: usize,
        consumed: &mut [bool],
        out: &mut String,
        sup: &mut Vec<&Glyph>,
        sub: &mut Vec<&Glyph>,
    ) -> bool {
        let g = glyphs[i];
        let mut lx = self.atom_latex(g);
        // Accent macros reach us both as "\bar{}" and as a bare "\tilde" —
        // normalize the bare form so the base-wrap logic applies (a bare
        // \tilde plus the next glyph's subscript emitted `\tilde _{2}`).
        if lx.starts_with('\\')
            && lx.len() > 1
            && lx[1..].chars().all(|c| c.is_ascii_alphabetic())
            && [
                "bar", "hat", "tilde", "check", "breve", "acute", "grave",
                "vec", "dot", "ddot", "widehat", "widetilde",
            ]
            .contains(&&lx[1..])
        {
            lx = format!("{}{{}}", lx);
        }
        if !(lx.ends_with("{}") && lx.starts_with('\\') && lx.len() > 3) {
            return false;
        }
        let name = lx[..lx.len() - 2].to_string();
        consumed[i] = true;
        let accent_cx = g.x + g.wx / 2.0;
        let mut best: Option<(usize, f64)> = None;
        let mut looked = 0;
        for k in (0..i).rev() {
            if consumed[k] {
                continue;
            }
            looked += 1;
            if looked > 4 {
                break;
            }
            let b = glyphs[k];
            if b.x + b.wx < accent_cx - 2.0 * g.size {
                break;
            }
            if b.size >= g.size * 0.8 && (b.y - g.y).abs() <= g.size {
                let dist = (b.x + b.wx / 2.0 - accent_cx).abs();
                if best.map(|(_, d)| dist < d).unwrap_or(true) {
                    best = Some((k, dist));
                }
            }
        }
        if let Some(next) = (i + 1..glyphs.len()).find(|&j| !consumed[j]) {
            let b = glyphs[next];
            if b.size >= g.size * 0.8 && (b.y - g.y).abs() <= g.size {
                let dist = (b.x + b.wx / 2.0 - accent_cx).abs();
                if best.map(|(_, d)| dist < d).unwrap_or(true) {
                    best = Some((next, dist));
                }
            }
        }
        let wrapped = best.and_then(|(bi, _)| {
            let atom = self.atom(glyphs[bi]);
            if atom.is_empty() {
                None
            } else {
                Some((bi, atom))
            }
        });
        let Some((bi, atom)) = wrapped else {
            // No base glyph is identifiable (the accent floats over a cluster
            // already folded into `out`, or its base was a dropped piece). The
            // accent still exists in the source, and a macro without an
            // argument makes the WHOLE formula invalid for KaTeX (`\tilde`
            // alone is a parse error, and it swallows whatever comes next:
            // `\tilde ^{N-1}`). `\tilde{}` keeps both the accent and the
            // syntax.
            push_sep(out, &format!("{}{{}}", name));
            return true;
        };
        consumed[bi] = true;
        let wrap = format!("{}{{{}}}", name, atom);
        // The base may still be pending as a script of this level: the accent
        // of `|_{t=\bar t}` is drawn while the subscript cluster is open, so the
        // base has not reached `out`. Rewrite the pending glyph's atom — the
        // tail-replace below would otherwise cut whatever macro happens to end
        // `out` (`\vert` lost its `t` to a `\bar{t}` and the invalid `\ver`
        // reached the markdown).
        let pending = sub
            .iter()
            .position(|&x| std::ptr::eq(x, glyphs[bi]))
            .map(|p| ('_', p))
            .or_else(|| sup.iter().position(|&x| std::ptr::eq(x, glyphs[bi])).map(|p| ('^', p)));
        if let Some((_kind, _pos)) = pending {
            self.wraps
                .borrow_mut()
                .insert(glyphs[bi] as *const Glyph as usize, wrap);
            return true;
        }
        // The atom may only be replaced when it sits at `out`'s own tail: the
        // final `t` of `\vert` must not be read as the atom "t" (wrapping it
        // cut the macro down to the invalid `\ver`). A macro atom is
        // self-delimiting; a bare-letter atom is only a token when the
        // character before it does not continue a name.
        let boundary = atom.starts_with('\\')
            || out.len() == atom.len()
            || out[..out.len().saturating_sub(atom.len())]
                .chars()
                .next_back()
                .map(|c| !c.is_ascii_alphanumeric())
                .unwrap_or(true);
        if boundary && out.ends_with(&atom) {
            let start = out.len() - atom.len();
            out.replace_range(start.., &wrap);
        } else {
            push_sep(out, &wrap);
        }
        true
    }

    /// One glyph → its LaTeX body.
    fn atom(&mut self, g: &Glyph) -> String {
        self.atom_latex(g)
    }

    fn atom_sized(&mut self, g: &Glyph, size_ref: f64) -> String {
        let body = self.atom_latex(g);
        if body.is_empty() {
            return body;
        }
        // Sized delimiters: map oversized brackets to \bigl etc.
        const DELIMS: [(&str, &str); 16] = [
            ("(", "\\bigl("),
            (")", "\\bigr)"),
            ("[", "\\bigl["),
            ("]", "\\bigr]"),
            ("\\{", "\\bigl\\{"),
            ("\\}", "\\bigr\\}"),
            ("\\langle", "\\bigl\\langle"),
            ("\\rangle", "\\bigr\\rangle"),
            ("|", "\\bigl|"),
            ("\\vert", "\\bigl|"),
            ("/", "\\big/"),
            ("\\surd", "\\big\\surd"),
            ("\\lfloor", "\\bigl\\lfloor"),
            ("\\rfloor", "\\bigr\\rfloor"),
            ("\\lceil", "\\bigl\\lceil"),
            ("\\rceil", "\\bigr\\rceil"),
        ];
        let ratio = if size_ref > 0.1 { g.size / size_ref } else { 1.0 };
        if ratio > 1.3 {
            if let Some((base, big)) = DELIMS.iter().find(|(b, _)| *b == body) {
                let _ = base;
                let mut n_big = 0; // 1=\big 2=\Big 3=\bigg 4=\Bigg
                n_big = if ratio > 3.2 {
                    4
                } else if ratio > 2.4 {
                    3
                } else if ratio > 1.8 {
                    2
                } else {
                    1
                };
                let name = big.replace("\\big", match n_big {
                    2 => "\\Big",
                    3 => "\\bigg",
                    4 => "\\Bigg",
                    _ => "\\big",
                });
                return name;
            }
        }
        body
    }

    /// LaTeX body of a glyph (tables → unicode mapping → escaping).
    fn atom_latex(&mut self, g: &Glyph) -> String {
        // an accented base that was pending when its accent arrived: its atom
        // is the wrapped one (see fold_accent)
        if let Some(w) = self
            .wraps
            .borrow()
            .get(&(g as *const Glyph as usize))
        {
            return w.clone();
        }
        if let Some(lx) = &g.latex {
            if !lx.is_empty() {
                return lx.clone();
            }
            *self.dropped += 1; // piece glyph (cmex big delimiters etc.)
            return String::new();
        }
        let mut out = String::new();
        for ch in g.text.chars() {
            if let Some(lx) = glyphdata::uni_to_latex(ch as u32) {
                out.push_str(lx);
            } else if let Some(lx) = glyphdata::unicode_math_to_latex(ch as u32) {
                out.push_str(&lx);
            } else if ch.is_alphanumeric() || is_cjk_char(ch) {
                out.push(ch);
            } else if "\\{}%&#$^_~".contains(ch) {
                out.push('\\');
                out.push(ch);
            } else {
                out.push(ch);
            }
        }
        // Upright multi-letter words inside math → \text or known operators.
        if out.chars().all(|c| c.is_ascii_alphabetic()) && out.len() >= 2 {
            if let Some(f) = self.fonts.get(g.font) {
                if !f.is_math && !f.is_italic {
                    return match out.to_lowercase().as_str() {
                        "lim" => "\\lim".into(),
                        "log" => "\\log".into(),
                        "ln" => "\\ln".into(),
                        "sin" => "\\sin".into(),
                        "cos" => "\\cos".into(),
                        "tan" => "\\tan".into(),
                        "min" => "\\min".into(),
                        "max" => "\\max".into(),
                        "sup" => "\\sup".into(),
                        "inf" => "\\inf".into(),
                        "exp" => "\\exp".into(),
                        "det" => "\\det".into(),
                        "arg" => "\\arg".into(),
                        "mod" => "\\bmod".into(),
                        "gcd" => "\\gcd".into(),
                        "Pr" => "\\Pr".into(),
                        _ => format!("\\text{{{}}}", out),
                    };
                }
            }
        }
        out
    }

    /// Detects matrices / cases: ≥2 rows and ≥2 columns inside delimiters.
    fn try_matrix(&mut self, glyphs: &[&Glyph], base_size: f64) -> Option<String> {
        if glyphs.len() < 4 {
            return None;
        }
        // cluster baselines
        let mut baselines: Vec<f64> = glyphs.iter().map(|g| g.y).collect();
        baselines.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut rows: Vec<f64> = Vec::new();
        for &y in &baselines {
            match rows.last() {
                Some(&r) if (r - y).abs() < base_size * 0.5 => {}
                _ => rows.push(y),
            }
        }
        if rows.len() < 2 {
            return None;
        }
        // columns via x clustering of left edges
        let mut xs: Vec<f64> = glyphs.iter().map(|g| g.x).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut cols: Vec<f64> = Vec::new();
        for &x in &xs {
            match cols.last() {
                Some(&c) if (c - x).abs() < base_size * 0.9 => {}
                _ => cols.push(x),
            }
        }
        if cols.len() < 2 {
            return None;
        }
        // only when there is real grid density
        if glyphs.len() < rows.len() * cols.len() {
            return None;
        }
        // enclosure check: leftmost and rightmost glyph are delimiters
        let left = *glyphs.iter().min_by(|a, b| a.x.partial_cmp(&b.x).unwrap())?;
        let right = *glyphs.iter().max_by(|a, b| (a.x + a.wx).partial_cmp(&(b.x + b.wx)).unwrap())?;
        let lx = self.atom_latex(left);
        let rx = self.atom_latex(right);
        let openers = ["(", "[", "\\{", "\\langle", "\\vert", "|"];
        let closers = [")", "]", "\\}", "\\rangle", "\\vert", "|"];
        let is_cases = lx == "\\{" && (right.x - left.x) < glyphs.iter().map(|g| g.wx).sum::<f64>() * 1.2;
        if !is_cases && !(openers.contains(&lx.as_str()) && closers.contains(&rx.as_str())) {
            return None;
        }
        let (env, inner): (&str, Vec<&Glyph>) = if is_cases {
            ("cases", glyphs[1..].to_vec())
        } else {
            let env = match (lx.as_str(), rx.as_str()) {
                ("[", "]") => "bmatrix",
                ("\\{", "\\}") => "Bmatrix",
                ("(", ")") => "pmatrix",
                ("\\vert", "\\vert") | ("|", "|") => "vmatrix",
                _ => "pmatrix",
            };
            // exclude enclosure glyphs
            let inner: Vec<&Glyph> = glyphs
                .iter()
                .filter(|g| !std::ptr::eq(*g, &left) && !std::ptr::eq(*g, &right))
                .cloned()
                .collect();
            (env, inner)
        };
        // assign cells
        let mut grid: Vec<Vec<Vec<&Glyph>>> = vec![vec![Vec::new(); cols.len()]; rows.len()];
        let mut loose: Vec<&Glyph> = Vec::new();
        for g in &inner {
            let ri = rows.iter().enumerate().min_by(|(_, a), (_, b)| {
                (**a - g.y).abs().partial_cmp(&(**b - g.y).abs()).unwrap()
            });
            let ci = cols.iter().enumerate().min_by(|(_, a), (_, b)| {
                (**a - g.x).abs().partial_cmp(&(**b - g.x).abs()).unwrap()
            });
            match (ri, ci) {
                (Some((ri, _)), Some((ci, _)))
                    if (rows[ri] - g.y).abs() < base_size * 0.75
                        && (cols[ci] - g.x).abs() < base_size * 1.4 =>
                {
                    grid[ri][ci].push(g);
                }
                _ => loose.push(g),
            }
        }
        if !loose.is_empty() || grid.iter().flatten().any(|c| c.is_empty()) {
            return None;
        }
        for (ri, row) in grid.iter_mut().enumerate() {
            for cell in row.iter_mut() {
                cell.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
                let _ = ri;
            }
        }
        let mut out = format!("\\begin{{{}}}", env);
        for (ri, row) in grid.iter().enumerate() {
            if ri > 0 {
                out.push_str(" \\\\ ");
            }
            let cells: Vec<String> = row
                .iter()
                .map(|cell| {
                    let row_y = cell.first().map(|g| g.y);
                    self.build(cell, row_y, base_size * 0.9)
                })
                .collect();
            out.push_str(&cells.join(" & "));
        }
        out.push_str(&format!("\\end{{{}}}", env));
        Some(out)
    }

    /// Finds the top-level fraction bar and splits glyphs above/mid/below.
    ///
    /// A thin rule is a FRACTION bar only when the glyphs it separates stack on
    /// both sides of it INSIDE its x-slot. TeX sizes the rule to the wider of
    /// the numerator/denominator boxes, so a rule with nothing in its slot on
    /// one side is not a fraction: an arrow shaft, a table edge, an underline,
    /// a radical's covering bar seen from another line. Emitting `\frac{}{}`
    /// from those was the empty-fraction bug (the arrow between two
    /// isomorphism squares of 2609.27549 became `\frac{}{}`).
    ///
    /// The width gate is relative to the bar's OWN clusters, never to the
    /// enclosing line's size: an inline fraction is typeset at script size
    /// (`1/2` in 12pt body text has a 4pt bar), so anchoring it to the text
    /// size rejected every inline fraction and flattened it to "21".
    #[allow(clippy::type_complexity)]
    fn split_fraction<'b>(
        &self,
        glyphs: &'b [&'b Glyph],
    ) -> Option<(usize, Vec<&'b Glyph>, Vec<&'b Glyph>, Vec<&'b Glyph>)> {
        let mut best: Option<(usize, f64)> = None;
        for (ri, r) in self.rules.iter().enumerate() {
            if self.used_rules[ri] {
                continue;
            }
            let rr = r.rect;
            // horizontal and thin (a thicker rule is a table/frame edge)
            if rr.height() > 2.0 {
                continue;
            }
            if slotted_stack(glyphs, rr).is_none() {
                continue;
            }
            if inside_radical_bar(self.rules, &self.used_rules, glyphs, rr) {
                continue;
            }
            // …and the bar over a radical's OWN hook is the radical's, never a
            // fraction's: `0<r<\rho(w)\sqrt{t}` of math0211159 printed
            // `\surd ^{1}\frac{0}{t}` because the √'s covering bar also
            // separated two glyphs x-overlapping its slot (the line above's
            // `1`,`0`), and the fraction branch claimed the run before the
            // radical could.
            if glyphs
                .iter()
                .any(|g| is_radical_latex(g) && is_covering_bar(g, rr))
            {
                continue;
            }
            // score: prefers wide bars close to the glyph cloud's center
            let ys: Vec<f64> = glyphs.iter().map(|g| g.y).collect();
            let ymin = ys.iter().cloned().fold(f64::MAX, f64::min);
            let ymax = ys.iter().cloned().fold(f64::MIN, f64::max);
            let center_dist = ((rr.y0 + rr.y1) / 2.0 - (ymin + ymax) / 2.0).abs();
            let score = rr.width() - center_dist;
            if best.map(|(_, s)| score > s).unwrap_or(true) {
                best = Some((ri, score));
            }
        }
        let (ri, _) = best?;
        let rr = self.rules[ri].rect;
        let mut above = Vec::new();
        let mut mid = Vec::new();
        let mut below = Vec::new();
        for g in glyphs {
            let y = g.baseline_or_y();
            // The fraction is a vertical structure occupying the bar's x slot:
            // glyphs inside the slot stack above/below it; glyphs outside the
            // slot sit beside it on the enclosing baseline. A denominator that
            // starts with √ has its origin only ~0.2×size below the bar —
            // baseline-inside-the-slot means below, not beside.
            let cx = g.x + g.wx / 2.0;
            let in_slot = cx >= rr.x0 - 1.0 && cx <= rr.x1 + 1.0;
            if !in_slot {
                mid.push(*g);
            } else if y < rr.y0 - 0.5 {
                above.push(*g);
            } else {
                below.push(*g);
            }
        }
        above.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        below.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        mid.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        Some((ri, above, mid, below))
    }
}

/// The x-slot clusters a fraction bar separates: the glyphs whose center lies
/// under the bar, split by whether their baseline sits above it.
fn fraction_clusters<'b>(glyphs: &[&'b Glyph], rr: Rect) -> (Vec<&'b Glyph>, Vec<&'b Glyph>) {
    let mut above = Vec::new();
    let mut below = Vec::new();
    for g in glyphs {
        let cx = g.x + g.wx / 2.0;
        if cx < rr.x0 - 1.0 || cx > rr.x1 + 1.0 {
            continue;
        }
        if g.baseline_or_y() < rr.y0 - 0.5 {
            above.push(*g);
        } else {
            below.push(*g);
        }
    }
    (above, below)
}

/// A rule is a FRACTION BAR only when the glyphs it separates stack on both
/// sides of it INSIDE its x-slot. TeX sizes the rule to the wider of the
/// numerator/denominator boxes, so a rule with nothing in its slot on one side
/// is not a fraction: an arrow shaft, a table edge, an underline, a radical's
/// covering bar seen from another line. Emitting `\frac{}{}` from those was the
/// empty-fraction bug (the arrow between two isomorphism squares of
/// 2609.27549 became `\frac{}{}`). Returns the two clusters when the bar is a
/// fraction.
fn slotted_stack<'b>(glyphs: &[&'b Glyph], rr: Rect) -> Option<(Vec<&'b Glyph>, Vec<&'b Glyph>)> {
    let (above, below) = fraction_clusters(glyphs, rr);
    if above.is_empty() || below.is_empty() {
        return None;
    }
    let cluster_w = cluster_width(&above).max(cluster_width(&below));
    if rr.width() < 0.6 * cluster_w || rr.width() > 1.8 * cluster_w + 3.0 {
        return None;
    }
    Some((above, below))
}

/// Horizontal extent of a glyph cluster (0.0 for an empty one).
fn cluster_width(cluster: &[&Glyph]) -> f64 {
    if cluster.is_empty() {
        return 0.0;
    }
    let x0 = cluster.iter().map(|g| g.x).fold(f64::MAX, f64::min);
    let x1 = cluster.iter().map(|g| g.x + g.wx).fold(f64::MIN, f64::max);
    (x1 - x0).max(0.0)
}

/// Emits a fraction at its place among the glyphs beside the enclosing bar:
/// as a script of the preceding atom when the WHOLE fraction is raised (or
/// lowered) — `(4\pi\tau)^{-n/2}`, where the pending `-` and the fraction are
/// one superscript cluster — else as an atom of the stream.
#[allow(clippy::too_many_arguments)]
fn push_fraction(
    out: &mut String,
    sup: &mut Vec<&Glyph>,
    sub: &mut Vec<&Glyph>,
    fonts: &[FontInfo],
    size_ref: f64,
    warn: &mut Vec<String>,
    script: Option<char>,
    latex: &str,
    wraps: &std::cell::RefCell<std::collections::HashMap<usize, String>>,
) {
    match script {
        Some(kind) if !out.is_empty() => {
            // flush first so `^{-}` and the fraction share one group
            flush_scripts(out, sup, sub, fonts, size_ref, warn, wraps);
            append_script(out, kind, latex);
        }
        _ => out.push_str(latex),
    }
}

/// True when the rule `rr` is the covering bar of the radical glyph `g`: it
/// starts right after the radical's hook and sits at its origin height. The
/// LENGTH gate may only demand "a bar that covers something" — scaling it to
/// the font size (0.4×size) rejected every one-letter radicand (`\surd t` for
/// `\sqrt{t}`: the bar over a "t" is 4.2pt wide at 12pt, the gate wanted 4.8).
fn is_covering_bar(g: &Glyph, rr: Rect) -> bool {
    rr.x0 >= g.x + g.wx * 0.5
        && rr.x0 <= g.x + g.wx + g.size
        && (rr.y0 - (g.bbox().y0)).abs() < g.size * 0.8
        && rr.width() > 0.15 * g.size
}

/// True when `rr` lies inside the coverage of an unused RADICAL covering bar:
/// such a bar is the radicand's own fraction and must not be taken as the
/// level's top-level fraction — `\sqrt{\frac{N}{2\tau}+R+...}` lost its
/// radicand structure that way (the fraction split the run into num/den/mid and
/// the radical, a mid glyph, could only rebuild from the mid part).
fn inside_radical_bar(
    rules: &[&Rule],
    used: &[bool],
    glyphs: &[&Glyph],
    rr: Rect,
) -> bool {
    for (ri, r) in rules.iter().enumerate() {
        if used[ri] {
            continue;
        }
        let outer = r.rect;
        if outer.width() <= rr.width() || outer.height() > 2.0 {
            continue;
        }
        if outer.x0 > rr.x0 + 1.0 || outer.x1 + 1.0 < rr.x1 {
            continue;
        }
        if glyphs
            .iter()
            .any(|g| is_radical_latex(g) && is_covering_bar(g, outer))
        {
            return true;
        }
    }
    false
}

/// Appends an atom, keeping trailing macros separated from a following
/// letter: `\upsilon` + `R` must never fuse into the unknown command
/// `\upsilonR` (KaTeX refuses the whole formula).
fn push_sep(out: &mut String, atom: &str) {
    if atom.is_empty() {
        return;
    }
    let ends_macro = (out.ends_with(|c: char| c.is_ascii_alphabetic())
        && out
            .rfind('\\')
            .map(|p| out[p + 1..].chars().all(|c| c.is_ascii_alphabetic()))
            .unwrap_or(false))
        || out.ends_with('}');
    let starts_letter = atom.starts_with(|c: char| c.is_ascii_alphabetic());
    if ends_macro && starts_letter {
        out.push(' ');
    }
    out.push_str(atom);
}

trait BaselineOrY {
    fn baseline_or_y(&self) -> f64;
}

impl BaselineOrY for Glyph {
    fn baseline_or_y(&self) -> f64 {
        self.y
    }
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum Script {
    Normal,
    Sup,
    Sub,
    LimitAbove,
    LimitBelow,
}

fn classify_script(g: &Glyph, base_y: Option<f64>, size_ref: f64) -> Script {
    let y = match base_y {
        Some(y) => y,
        None => return Script::Normal,
    };
    // A big operator is an ATOM, never a script: its raised/lowered origin is
    // the cmex glyph's posture (∫ origins sit far above the line), not a
    // superscript relation to its neighbour. The same holds for sizable
    // delimiter pieces (\bigl( …): their origin sits mid-height on the tall
    // glyph and used to surface as bogus ^{\bigl(} superscripts — and for the
    // RADICAL, whose origin is its covering bar, ~1×size above the radicand's
    // baseline (it used to be swallowed as a superscript: `=^{\surd}2N\tau`,
    // `\int^{\surd_{\tau(q)}}`).
    let is_big_op = g
        .latex
        .as_deref()
        .map(|l| {
            l == "\\sum" || l == "\\prod" || l == "\\int" || l == "\\oint"
                || l == "\\iint" || l == "\\iiint" || l.starts_with("\\big")
                || l == "\\surd" || l == "√"
        })
        .unwrap_or(false);
    if is_big_op {
        return Script::Normal;
    }
    if g.text.is_empty() {
        // cmex pieces and unmapped big glyphs (empty text, maybe bracket
        // latex): their origin encodes posture, never a script relation.
        return Script::Normal;
    }
    let dy = g.y - y; // + = below baseline
    if g.size < size_ref * 0.88 {
        // TeX subscripts drop by as little as 0.10×size (q_i in 9pt footnotes
        // drops 1.0pt = 0.10×size_ref) — the old 0.14 gate left them as normal
        // atoms and shredded "q_ik_i" into "qik i".
        if dy < -0.08 * size_ref {
            return Script::Sup;
        }
        if dy > 0.08 * size_ref {
            return Script::Sub;
        }
    } else if g.size < size_ref * 1.02 {
        // same-size raised/lowered glyphs: accents over ops etc.
        if dy < -0.85 * size_ref {
            return Script::LimitAbove;
        }
        if dy > 0.95 * size_ref {
            return Script::LimitBelow;
        }
    }
    Script::Normal
}

/// Words of adjacent Normal glyphs, x-ordered. Consecutive Normal glyphs
/// join while their gap stays within TeX kerning distance; a script between
/// two normals does NOT split the run (the G of \min_G sits between m and i).
fn normal_runs(glyphs: &[&Glyph], main_y: f64, size_ref: f64) -> Vec<(f64, f64)> {
    let join_gap = (0.12 * size_ref).max(0.8);
    let mut runs: Vec<(f64, f64)> = Vec::new();
    for g in glyphs {
        if !matches!(classify_script(g, Some(main_y), size_ref), Script::Normal) {
            continue;
        }
        match runs.last_mut() {
            Some((_, x1)) if g.x - *x1 <= join_gap => {
                *x1 = (*x1).max(g.x + g.wx);
            }
            _ => runs.push((g.x, g.x + g.wx)),
        }
    }
    runs
}

/// The run whose span holds the script's center, if any (runs are x-ordered).
fn run_containing(runs: &[(f64, f64)], g: &Glyph) -> Option<(f64, f64)> {
    let c = g.x + g.wx / 2.0;
    let idx = runs.partition_point(|r| r.1 < c);
    for r in runs.iter().skip(idx.saturating_sub(1)).take(2) {
        if r.0 <= c && c <= r.1 {
            return Some(*r);
        }
    }
    None
}

/// Emits pending ^{} / _{} groups after their base atom.
fn flush_scripts(
    out: &mut String,
    sup: &mut Vec<&Glyph>,
    sub: &mut Vec<&Glyph>,
    fonts: &[FontInfo],
    size_ref: f64,
    _warn: &mut Vec<String>,
    wraps: &std::cell::RefCell<std::collections::HashMap<usize, String>>,
) {
    if sup.is_empty() && sub.is_empty() {
        return;
    }
    if !out.is_empty() {
        // attach to previous atom; wrap atom in braces if it is a macro
        // (e.g. \alpha^2) — safe unconditionally for single tokens
        sup.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        sub.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        let sup_s = if sup.is_empty() {
            String::new()
        } else {
            let mut b = Builder {
                fonts,
                rules: &[],
                used_rules: Vec::new(),
                warn: _warn,
                dropped: &mut 0,
                limit_spans: &[],
                wraps,
            };
            b.build(sup, None, size_ref * 0.85)
        };
        let sub_s = if sub.is_empty() {
            String::new()
        } else {
            let mut b = Builder {
                fonts,
                rules: &[],
                used_rules: Vec::new(),
                warn: _warn,
                dropped: &mut 0,
                limit_spans: &[],
                wraps,
            };
            b.build(sub, None, size_ref * 0.85)
        };
        let last = out.chars().last().unwrap();
        let is_macro = last.is_ascii_alphabetic()
            && {
                // find trailing \word
                let s = out.as_str();
                if let Some(pos) = s.rfind('\\') {
                    s[pos + 1..].chars().all(|c| c.is_ascii_alphabetic())
                } else {
                    false
                }
            };
        if is_macro {
            out.push(' ');
        }
        // A base carries at most ONE script of each kind: `x_{a}_{b}` is a KaTeX
        // parse error and TeX has no such construct. When the pass has already
        // emitted a `_{...}` for this base — a limit claimed by try_limits, or a
        // previous flush — the glyphs now pending are part of the same script
        // cluster (our classification split one cluster into two), so they are
        // merged into that group instead of opening a second one. See
        // append_script for the case where the base wears the other kind too.
        // This is the `\int\limits_{R}_{n}` / `\int\limits_{N}^{-1}_{M+n}` fix.
        if !sub_s.is_empty() {
            append_script(out, '_', &sub_s);
        }
        if !sup_s.is_empty() {
            append_script(out, '^', &sup_s);
        }
    }
    sup.clear();
    sub.clear();
}

/// Appends `_{body}` / `^{body}` to `out`, keeping the result parseable:
/// a same-kind group already on the base absorbs the glyphs; a base that
/// already wears BOTH kinds is braced first (`x_{a}^{b}_{c}` is a KaTeX parse
/// error, `{x_{a}^{b}}_{c}` is the same expression written legally); a base
/// with only the other kind takes the new script as is (`x^{2}_{i}`).
fn append_script(out: &mut String, kind: char, body: &str) {
    if body.is_empty() {
        return;
    }
    let groups = trailing_script_groups(out);
    if let Some(&(_, brace)) = groups.iter().rev().find(|(k, _)| *k == kind) {
        append_to_script_group(out, brace, body);
        return;
    }
    if groups.len() > 1 {
        *out = format!("{{{}}}", out);
    }
    out.push_str(&format!("{}{{{}}}", kind, body));
}

/// Kind and opening-brace position of the trailing run of `_{...}` / `^{...}`
/// groups of `out` (a base atom with its scripts), innermost first.
fn trailing_script_groups(out: &str) -> Vec<(char, usize)> {
    let mut groups: Vec<(char, usize)> = Vec::new();
    let bytes = out.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1] == b'}' {
        let mut depth = 0usize;
        let mut i = end;
        while i > 0 {
            i -= 1;
            match bytes[i] {
                b'}' => depth += 1,
                b'{' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
        }
        if depth != 0 || i == 0 || !matches!(bytes[i - 1] as char, '_' | '^') {
            break;
        }
        groups.push((bytes[i - 1] as char, i));
        end = i - 1;
    }
    groups.reverse();
    groups
}

/// Appends `extra` to the body of the `_{...}` / `^{...}` group opening at
/// `brace` (which need not be the trailing group — the base may wear another
/// script after it), keeping the macro/letter separation `push_sep` applies at
/// top level (`\alpha` followed by `R` must not fuse into `\alphaR`).
fn append_to_script_group(out: &mut String, brace: usize, extra: &str) {
    if extra.is_empty() {
        return;
    }
    // the group's OWN closing brace, not the last character of `out`
    let bytes = out.as_bytes();
    let mut depth = 0usize;
    let mut close = brace;
    while close < bytes.len() {
        match bytes[close] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        close += 1;
    }
    if depth != 0 || close >= bytes.len() {
        return;
    }
    let mut body = out[brace + 1..close].to_string();
    push_sep(&mut body, extra);
    out.replace_range(brace + 1..close + 1, &format!("{}}}", body));
}

/// Sub/superscript glyphs immediately preceding a radical (nth roots).
fn sub_script_of<'b>(
    glyphs: &[&'b Glyph],
    consumed: &mut [bool],
    radical_idx: usize,
    _is_sqrt: bool,
) -> String {
    // glyphs before the radical that are small and raised slightly
    let g = glyphs[radical_idx];
    let mut idx: Vec<&Glyph> = Vec::new();
    let mut k = radical_idx;
    while k > 0 {
        k -= 1;
        let prev = glyphs[k];
        if consumed[k] {
            break;
        }
        let dy = prev.y - g.y;
        if prev.size < g.size * 0.95 && dy.abs() < 0.8 * g.size && prev.x + prev.wx >= g.x - 1.5 {
            idx.push(prev);
            consumed[k] = true;
        } else {
            break;
        }
    }
    idx.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    if idx.is_empty() {
        return String::new();
    }
    let texts: String = idx
        .iter()
        .map(|gg| {
            gg.latex.clone().unwrap_or_else(|| gg.text.clone())
        })
        .collect();
    format!("[{}]", texts)
}

fn dominant_baseline(glyphs: &[&Glyph]) -> f64 {
    // baseline of the row holding the LARGEST glyphs — scripts are smaller
    // than their base by definition, so the base row is the anchor scripts
    // are classified against. Advance weight only breaks ties between
    // same-size rows. Pure advance weighting used to flip the anchor to a
    // subscript cluster that merely outnumbered the base ("R_{𝔛,n}" lost its
    // braces: three 8pt glyphs outweighed one 12pt base, the scripts then sat
    // "on the baseline" and classified as normal atoms).
    let mut buckets: Vec<(f64, f64, f64)> = Vec::new(); // (y, max_size, adv)
    for g in glyphs {
        let b = (g.y * 2.0).round() / 2.0;
        match buckets.iter_mut().find(|(y, _, _)| (*y - b).abs() < 0.51) {
            Some((_, ms, w)) => {
                *ms = ms.max(g.size);
                *w += g.wx.max(0.1);
            }
            None => buckets.push((b, g.size, g.wx.max(0.1))),
        }
    }
    buckets
        .iter()
        .max_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap()
                .then(a.2.partial_cmp(&b.2).unwrap())
        })
        .map(|(y, _, _)| *y)
        .unwrap_or_else(|| glyphs.first().map(|g| g.y).unwrap_or(0.0))
}

/// Splits a mixed text/math line into (is_math, glyph slice) segments.
/// `tex_text_is_math`: the line's own TeX-math fonts dominate (a formula
/// line) — digits/operator letters set in CM Roman are then math atoms, not
/// text (a formula's "1" comes from cmr like its variables come from cmmi).
pub fn split_segments<'b>(
    glyphs: &[&'b Glyph],
    fonts: &[FontInfo],
    tex_text_is_math: bool,
) -> Vec<(bool, Vec<&'b Glyph>)> {
    let prose = prose_word_mask(glyphs, fonts);
    let (body_size, body_y) = run_body_metrics(glyphs);
    let mut segs: Vec<(bool, Vec<&Glyph>)> = Vec::new();
    // The glyphs directly under a radical's covering bar are its radicand and
    // are kerned to the radical glyph (TeX puts no space between them), so a
    // run that follows a √ within one word starts in the math path even when
    // the radical sits in prose: `radius \sqrt{2N\tau(q)}` kept the √ in math
    // and left its radicand in the text run (`$\surd$ 2 $N\tau$ ( $q$ )`).
    let mut radicand_x1: Option<f64> = None;
    for (gi, g) in glyphs.iter().enumerate() {
        let f = fonts.get(g.font);
        let font_math = f.map(|f| f.is_math).unwrap_or(false);
        let tex_font = f.map(|f| f.tex != crate::font::TexKind::None).unwrap_or(false);
        let is_radical = is_radical_latex(g);
        // …but only across a KERN: a word space (0.25em for a Times-bodied
        // paper, 0.33em for cmr) or any formula spacing ends the radicand, and
        // a prose word is never part of one. Without the tight gate the pull
        // ran on through the sentence ("√d_k, and apply a softmax" came out as
        // `$\sqrt{d_{k},} andapplyasoftmax...$`).
        let in_radicand = !is_radical
            && !prose[gi]
            && radicand_x1
                .map(|x1| g.x - x1 <= 0.12 * g.size.max(1.0))
                .unwrap_or(false);
        // Running text and math symbols share the cm fonts (a LaTeX paper sets
        // prose in cmr12 and its digits/= in cmr12 too), so the FONT cannot
        // decide alone: the unit that separates them is the WORD. A prose word
        // leaves a paragraph's prose out of the math path — before this, any
        // line whose inline formulas were dense enough to be flagged math
        // dragged its whole sentence in and the spaces were lost
        // ("$where\delta g_{ij}=...vanish esidentically$").
        let mathy = font_math
            || g.latex.is_some()
            || in_radicand
            || (tex_font
                && !prose[gi]
                && (tex_text_is_math
                    // A TeX-set SCRIPT glyph (smaller than the run's body size
                    // and off its baseline) is math whatever the line's own
                    // classification: LaTeX never sets prose off the baseline.
                    // This keeps the stacked digits of an inline `\frac{1}{2}`
                    // in a text paragraph in the math path — as plain text they
                    // came out in x-order, i.e. as the literal "21".
                    || is_script_glyph(g, body_size, body_y)));
        let text_mathy = !g.text.is_empty()
            && g.text.chars().all(|c| {
                let u = c as u32;
                (0x2190..=0x2BFF).contains(&u) || (0x1D400..=0x1D7FF).contains(&u)
            });
        let m = mathy || text_mathy;
        radicand_x1 = if is_radical || in_radicand {
            Some(g.x + g.wx)
        } else {
            None
        };
        match segs.last_mut() {
            Some((is_math, v)) if *is_math == m => v.push(g),
            _ => segs.push((m, vec![g])),
        }
    }
    fold_script_text(&mut segs);
    merge_adjacent_math(&mut segs);
    if std::env::var("PDF2MD_SEG_DEBUG").is_ok() {
        for (is_math, seg) in &segs {
            let txt: String = seg.iter().map(|g| g.text.as_str()).collect();
            eprintln!("[seg] math={} n={} {:?}", is_math, seg.len(), txt);
            for g in seg {
                eprintln!("   [sg] x={:.2} y={:.2} sz={:.2} {:?} latex={:?}", g.x, g.y, g.size, g.text, g.latex);
            }
        }
    }
    segs
}

/// True for a glyph that draws a radical sign (`\surd`, cmsy/cmex "√" or a
/// cm-slot mapping that resolves to it).
fn is_radical_latex(g: &Glyph) -> bool {
    g.latex
        .as_deref()
        .map(|l| l == "\\surd" || l == "√")
        .unwrap_or(false)
}

/// True when a TeX-font glyph is set as a script of the run's body: clearly
/// smaller than the body size AND off the body baseline (TeX sets prose of a
/// paragraph on one baseline at one size; only math stacks glyphs off it).
fn is_script_glyph(g: &Glyph, body_size: f64, body_y: f64) -> bool {
    if body_size <= 0.1 {
        return false;
    }
    g.size <= body_size * 0.92 && (g.y - body_y).abs() >= 0.08 * body_size
}

/// Body size and baseline of a glyph run: advance-weighted mode of the sizes
/// plus the baseline of the glyphs set at that size.
fn run_body_metrics(glyphs: &[&Glyph]) -> (f64, f64) {
    let mut buckets: Vec<(f64, f64)> = Vec::new(); // (size, weight)
    for g in glyphs {
        let b = (g.size * 2.0).round() / 2.0;
        match buckets.iter_mut().find(|(s, _)| (*s - b).abs() < 0.26) {
            Some((_, w)) => *w += g.wx.max(0.1),
            None => buckets.push((b, g.wx.max(0.1))),
        }
    }
    let body = buckets
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .map(|(s, _)| *s)
        .unwrap_or(10.0);
    let mut ys: Vec<f64> = glyphs
        .iter()
        .filter(|g| g.size >= body * 0.95)
        .map(|g| g.y)
        .collect();
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let y = ys.get(ys.len() / 2).copied().unwrap_or(0.0);
    (body, y)
}

/// Operator names TeX sets upright in the surrounding text font: they look
/// exactly like prose words but are part of the formula (`\min`, `\log`).
const MATH_WORD_OPERATORS: [&str; 16] = [
    "lim", "log", "ln", "sin", "cos", "tan", "min", "max", "sup", "inf", "exp",
    "det", "arg", "mod", "gcd", "Pr",
];

/// Marks the glyphs that form a PROSE word: a run of two or more alphabetic
/// glyphs of a TeX text font, kerned together (a word space ends the run) and
/// not a math operator name. Only meaningful for TeX fonts — a paper whose body
/// font is not a CM family (Nimbus etc.) needs no such test, its glyphs are not
/// math candidates in the first place.
fn prose_word_mask(glyphs: &[&Glyph], fonts: &[FontInfo]) -> Vec<bool> {
    let mut mask = vec![false; glyphs.len()];
    let is_letter_glyph = |g: &Glyph| -> bool {
        // A LIGATURE glyph (ﬁ, ﬂ — ONE glyph carrying two letters) is part of
        // its word like any other letter: rejecting non-single-char glyphs left
        // the ligature unprose, so a line whose inline formulas made it "math"
        // emitted `$ﬂ$ ow` for "flow" (ricci prints 34 of those).
        if g.latex.is_some() || g.text.is_empty() || g.text.chars().count() > 3 {
            return false;
        }
        if !g.text.chars().all(|c| c.is_alphabetic()) {
            return false;
        }
        fonts
            .get(g.font)
            .map(|f| f.tex != crate::font::TexKind::None && !f.is_math)
            .unwrap_or(false)
    };
    let mut i = 0;
    while i < glyphs.len() {
        if !is_letter_glyph(glyphs[i]) {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i + 1;
        while end < glyphs.len() && is_letter_glyph(glyphs[end]) {
            let gap = glyphs[end].x - (glyphs[end - 1].x + glyphs[end - 1].wx);
            if gap > 0.35 * glyphs[end].size.max(1.0) {
                break; // a word space: the run is one word
            }
            end += 1;
        }
        let text: String = glyphs[start..end].iter().map(|g| g.text.as_str()).collect();
        if text.chars().count() >= 2 && !MATH_WORD_OPERATORS.contains(&text.as_str()) {
            for m in mask.iter_mut().take(end).skip(start) {
                *m = true;
            }
        }
        i = end;
    }
    mask
}

/// After a text run folded into the math run before it, the math run after it
/// is the SAME formula (the text run was the only thing between them):
/// `R^{d_{model}} | ×d_k` used to stay two $…$ runs.
fn merge_adjacent_math(segs: &mut Vec<(bool, Vec<&Glyph>)>) {
    let mut merged: Vec<(bool, Vec<&Glyph>)> = Vec::new();
    for (is_math, run) in segs.drain(..) {
        if is_math {
            if let Some((true, prev)) = merged.last_mut() {
                prev.extend(run);
                continue;
            }
        }
        merged.push((is_math, run));
    }
    *segs = merged;
}

/// Word/Office typeset sub/superscripts in the SURROUNDING TEXT font at a
/// smaller size (d_model's "model": 7pt Nimbus after a 10pt math glyph). The
/// font-based split used to leave them as loose words beside `$d$`. A short
/// text run that is clearly smaller and vertically offset from the math run
/// before it is part of that formula.
fn fold_script_text(segs: &mut Vec<(bool, Vec<&Glyph>)>) {
    // prev run: its TAIL mean (the math run's mean drifts off-baseline and
    // broke the offset test for W^{O}'s d_model); candidate run: its HEAD
    // mean (the candidate may continue with same-size text — " model = 512"
    // — whose tail dilutes the offset to zero and blocked the fold).
    let run_stats = |run: &[&Glyph], head: bool| -> (f64, f64) {
        let max_size = run.iter().map(|g| g.size).fold(0.0f64, f64::max);
        let part = if head {
            &run[..run.len().min(3)]
        } else {
            &run[run.len().saturating_sub(3)..]
        };
        let mean_y = part.iter().map(|g| g.y).sum::<f64>() / part.len().max(1) as f64;
        (max_size, mean_y)
    };
    let mut k = 1;
    while k < segs.len() {
        let (is_math, _) = segs[k];
        let (prev_math, _) = segs[k - 1];
        if !is_math && prev_math {
            let (prev_size, prev_y) = run_stats(&segs[k - 1].1, false);
            let (size, y) = run_stats(&segs[k].1, true);
            let small = size <= prev_size * 0.92;
            let offset = (y - prev_y).abs() >= prev_size * 0.10;
            let short = segs[k].1.len() <= 12;
            if small && offset && short {
                let run = segs.remove(k);
                segs[k - 1].1.extend(run.1);
                // the merged run may now neighbour an identical math segment
                continue;
            }
            // A small leading sub-run glued to same-size text ("model" +
            // "-dimensional" in one text segment): fold only the small
            // prefix into the math segment.
            if offset && segs[k].1.len() > 1 {
                let split = segs[k]
                    .1
                    .iter()
                    .position(|g| g.size > prev_size * 0.92)
                    .unwrap_or(segs[k].1.len());
                if split > 0 && split < segs[k].1.len() {
                    let head: Vec<&Glyph> = segs[k].1.drain(..split).collect();
                    segs[k - 1].1.extend(head);
                    continue;
                }
            }
        }
        k += 1;
    }
}

/// Heuristic: does this glyph run look like display math (own-line formula)?
/// `tex_text_is_math`: the line's TeX-math fonts dominate — digits, operator
/// names and relations are then cmr-set parts of the formula ("min", "="),
/// not text; counting them is what keeps eq (1) of 1406.2661 a display block
/// after cmr stopped carrying per-glyph latex.
pub fn looks_like_display_math(
    glyphs: &[&Glyph],
    fonts: &[FontInfo],
    tex_text_is_math: bool,
) -> bool {
    if glyphs.is_empty() {
        return false;
    }
    let n_math = glyphs
        .iter()
        .filter(|g| {
            fonts
                .get(g.font)
                .map(|f| f.is_math || (tex_text_is_math && f.tex == crate::font::TexKind::Cmr))
                .unwrap_or(false)
                || g.latex.is_some()
        })
        .count();
    let has_op = glyphs.iter().any(|g| {
        g.latex
            .as_deref()
            .map(|l| l.contains('=') || l == "\\sum" || l == "\\int" || l == "\\in")
            .unwrap_or(false)
            || g.text.trim_start().starts_with('=')
    });
    // The has_op escape used to fire on ANY sentence with a couple of inline
    // math glyphs and an equals sign (footnotes with "q·k = ..."), shredding
    // running text into bogus display blocks. A display formula is dominated
    // by math glyphs; the escape now requires 1/3 coverage on top of the op.
    n_math * 2 >= glyphs.len() || (has_op && n_math * 3 >= glyphs.len())
}

#[allow(dead_code)]
fn bbox_of(glyphs: &[&Glyph]) -> Rect {
    let mut r = Rect::empty();
    for g in glyphs {
        r.union(&g.bbox());
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Glyph;
    use crate::font::{FontInfo, TexKind};

    fn glyph(x: f64, y: f64, size: f64, text: &str, latex: Option<&str>) -> Glyph {
        Glyph { x, y, wx: size * 0.55, size, code: 0, text: text.into(), latex: latex.map(Into::into), font: 0 }
    }

    fn fonts_math() -> Vec<FontInfo> {
        let mut f = FontInfo::new();
        f.is_math = true;
        vec![f]
    }

    /// RC4: a sentence with a couple of inline math glyphs and an "=" is NOT
    /// display math (footnote 4 of 1706.03762 became a giant $$ blob).
    #[test]
    fn inline_text_with_equals_is_not_display() {
        let fonts = fonts_math();
        let mut text = FontInfo::new();
        let mut fonts = fonts;
        fonts.push(text);
        let mut glyphs: Vec<Glyph> = "some sentence with a formula q=k inside it".chars()
            .enumerate()
            .map(|(i, c)| {
                let mathy = matches!(c, 'q' | 'k' | '=');
                let t = c.to_string();
                let mut g = glyph(10.0 + 5.0 * i as f64, 100.0, 10.0, &t,
                    if mathy { Some(t.as_str()) } else { None });
                g.font = if mathy { 0 } else { 1 };
                g
            })
            .collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        assert!(!looks_like_display_math(&refs, &fonts, false));
    }

    /// A real display formula is dominated by math glyphs.
    #[test]
    fn display_formula_is_display() {
        let fonts = fonts_math();
        let glyphs: Vec<Glyph> = "Attention(Q,K,V)=softmax(x)".chars().enumerate()
            .map(|(i, c)| glyph(10.0 + 5.0 * i as f64, 100.0, 10.0, &c.to_string(), Some(&c.to_string())))
            .collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        assert!(looks_like_display_math(&refs, &fonts, true));
    }

    /// An inline fraction is set at SCRIPT size: `\frac{1}{2}` in 12pt body
    /// text has cmr8 digits and a bar of ~4pt. Judging that bar against the
    /// LINE's body size rejected it, and the digits then came out of the linear
    /// pass in x-order — the GAN abstract printed "equal to 21 everywhere" and
    /// Theorem 1 printed `D_G^*(x)=_{2}^{1}`. The bar's own clusters are the
    /// only valid scale for the width gate (TeX sizes the rule to
    /// max(numerator, denominator)).
    #[test]
    fn script_size_inline_fraction_keeps_its_bar() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(10.0, 100.0, 9.96, "D", Some("D")),
            glyph(18.0, 100.0, 9.96, "=", Some("=")),
            // the fraction, centered on x=25, at 6.97pt
            glyph(23.0, 95.5, 6.97, "1", Some("1")),
            glyph(23.0, 103.0, 6.97, "2", Some("2")),
        ];
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 23.0, y0: 99.3, x1: 26.97, y1: 99.3 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] }, &fonts, &mut warn);
        assert!(out.contains("\\frac{1}{2}"), "got {:?}", out);
        assert!(!out.contains("21"), "the digits must not fall back to x-order: {:?}", out);
    }

    /// A rule with nothing in its x-slot on one side is not a fraction — an
    /// arrow shaft, a table edge, an underline, a radical bar seen from another
    /// line. Nothing may ever be emitted as `\frac{}{}` (the acceptance rule):
    /// the isomorphism arrows of 2609.27549 came out as empty fractions.
    #[test]
    fn one_sided_bar_is_not_a_fraction() {        let fonts = fonts_math();
        // an arrow shaft between two symbols: no glyph inside the shaft's slot
        let glyphs = vec![
            glyph(10.0, 100.0, 10.0, "U", Some("U")),
            glyph(20.0, 100.0, 10.0, "V", Some("V")),
            glyph(60.0, 100.0, 10.0, "X", Some("X")),
            glyph(70.0, 100.0, 10.0, "Y", Some("Y")),
        ];
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 30.0, y0: 100.0, x1: 55.0, y1: 100.0 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: rule_refs.clone(), limit_spans: vec![] }, &fonts, &mut warn);
        assert_eq!(out, "UVXY", "an arrow shaft must not become a fraction: {:?}", out);
        // an underline: glyphs in the slot ABOVE the rule only
        let under = vec![glyph(32.0, 96.0, 10.0, "x", Some("x")), glyph(42.0, 96.0, 10.0, "+", Some("+"))];
        let refs: Vec<&Glyph> = under.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] }, &fonts, &mut warn);
        assert!(!out.contains("\\frac"), "an underline must not become a fraction: {:?}", out);
    }

    /// An accent whose base cannot be identified must still be a COMPLETE
    /// macro: a bare `\tilde` invalidates the whole formula for KaTeX (and
    /// swallows the next atom — `\tilde ^{N-1}`, `\hat ^{\bullet\bullet}`).
    #[test]
    fn accent_without_base_stays_parseable() {
        let fonts = fonts_math();
        let glyphs = vec![glyph(10.0, 100.0, 10.0, "~", Some("\\tilde"))];
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: vec![], limit_spans: vec![] }, &fonts, &mut warn);
        assert_eq!(out, "\\tilde{}");
    }

    /// A base carries at most ONE script of each kind — `x_{a}_{b}` is a KaTeX
    /// parse error and has no TeX meaning. A limit already emitted by
    /// try_limits absorbs the glyphs that follow (`\int\limits_{R}` + `n`);
    /// with both kinds already on the base, the new script braces it.
    #[test]
    fn scripts_never_duplicate_a_kind() {
        let mut out = String::from("\\int\\limits_{R}");
        append_script(&mut out, '_', "n");
        assert_eq!(out, "\\int\\limits_{Rn}");
        let mut out = String::from("\\int\\limits_{N}^{-1}");
        append_script(&mut out, '_', "M+n");
        assert_eq!(out, "\\int\\limits_{NM+n}^{-1}");
        // a script of the kind the base does not wear yet needs no braces
        let mut out = String::from("x^{2}");
        append_script(&mut out, '_', "i");
        assert_eq!(out, "x^{2}_{i}");
        let mut out = String::from("x");
        append_script(&mut out, '^', "2");
        assert_eq!(out, "x^{2}");
    }

    /// A line-level claimed limit span belongs to the operator it was claimed
    /// for — the one the cluster sits under. Without the ownership test eq (3)
    /// of 1406.2661 merged both integrals' limits into `\int\limits_{xz}` and
    /// left the second ∫ bare.
    #[test]
    fn claimed_limit_belongs_to_the_nearest_operator() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(10.0, 100.0, 10.0, "", Some("\\int")),
            glyph(30.0, 112.0, 7.0, "x", Some("x")),
            glyph(16.0, 100.0, 10.0, "p", Some("p")),
            glyph(110.0, 100.0, 10.0, "", Some("\\int")),
            glyph(130.0, 112.0, 7.0, "z", Some("z")),
            glyph(116.0, 100.0, 10.0, "p", Some("p")),
        ];
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        // the layout prepass hands down both clusters' spans
        let spans = vec![(30.0, 36.0), (130.0, 136.0)];
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: vec![], limit_spans: spans }, &fonts, &mut warn);
        assert!(out.contains("_{x}"), "the first ∫ keeps its own limit: {:?}", out);
        assert!(out.contains("_{z}"), "the second ∫ keeps its own limit: {:?}", out);
        assert!(!out.contains("_{xz}"), "limits of two operators must not merge: {:?}", out);
    }

    /// Prose of a cmr-set paper stays OUT of the math segments even when the
    /// line carries enough inline formulas to be flagged as a formula line:
    /// before this, every such line dragged its whole sentence into the math
    /// path and the spaces were lost
    /// (`$where\delta g_{ij}=v_{ij},...vanish esidentically$`).
    #[test]
    fn prose_words_stay_out_of_the_math_segments() {
        let mut cmr = FontInfo::new();
        cmr.tex = TexKind::Cmr;
        let fonts = vec![cmr];
        let mut glyphs: Vec<Glyph> = Vec::new();
        let mut x = 10.0;
        for (i, c) in "where".chars().enumerate() {
            let mut g = glyph(x, 100.0, 12.0, &c.to_string(), None);
            g.wx = 5.0;
            x += 5.0 + if i == 4 { 4.0 } else { 0.0 };
            glyphs.push(g);
        }
        let mut d = glyph(x, 100.0, 12.0, "δ", Some("\\delta"));
        d.wx = 5.0;
        glyphs.push(d);
        glyphs.push(glyph(x + 6.0, 100.0, 12.0, "=", None));
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let segs = split_segments(&refs, &fonts, true);
        let text: String = segs
            .iter()
            .filter(|(m, _)| !*m)
            .flat_map(|(_, s)| s.iter().map(|g| g.text.as_str()))
            .collect();
        assert_eq!(text, "where", "the prose word must stay text: {:?}", segs.iter().map(|(m, s)| (*m, s.iter().map(|g| g.text.clone()).collect::<String>())).collect::<Vec<_>>());
    }

    /// A TeX-set SCRIPT glyph in a TEXT line is math: the stacked `1`/`2` of an
    /// inline `\frac{1}{2}` inside a paragraph (cmr8 digits, off the body
    /// baseline) used to join the text run and print in x-order as "21".
    #[test]
    fn tex_script_glyph_is_math_in_a_text_line() {
        let mut cmr = FontInfo::new();
        cmr.tex = TexKind::Cmr;
        let mut text = FontInfo::new();
        text.space_width = 250.0;
        let fonts = vec![cmr, text];
        let mut glyphs: Vec<Glyph> = "ab".chars().enumerate().map(|(i, c)| {
            let mut g = glyph(10.0 + 6.0 * i as f64, 100.0, 12.0, &c.to_string(), None);
            g.font = 1;
            g
        }).collect();
        // the fraction's digits: same x, one raised, one lowered, at 8pt
        let mut n = glyph(30.0, 94.0, 8.0, "1", None);
        n.font = 0;
        let mut d = glyph(30.0, 106.0, 8.0, "2", None);
        d.font = 0;
        glyphs.push(n);
        glyphs.push(d);
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        // the line is TEXT (its own flag is false): the script glyphs still
        // have to reach the math path
        let segs = split_segments(&refs, &fonts, false);
        let dump: Vec<(bool, String)> = segs
            .iter()
            .map(|(m, s)| (*m, s.iter().map(|g| g.text.clone()).collect::<String>()))
            .collect();
        let math_txt: String = dump.iter().filter(|(m, _)| *m).map(|(_, t)| t.clone()).collect();
        assert_eq!(math_txt.len(), 2, "the stacked digits must form a math run: {:?}", dump);
        assert!(math_txt.contains('1') && math_txt.contains('2'), "both digits are math: {:?}", dump);
        assert_eq!(dump.first().map(|(m, t)| (*m, t.as_str())), Some((false, "ab")), "{:?}", dump);
    }

    /// Fraction slot classification: the √ of the denominator has its origin
    /// barely below the bar — it belongs BELOW, not beside (eq (1) of
    /// 1706.03762 degraded to `Q\sqrt{}Kd_k^T`).
    #[test]
    fn fraction_slot_classifies_radical_below() {
        let fonts = fonts_math();
        // numerator "QK" above the bar, √ barely below it, "d" well below,
        // "s" sits beside the bar on the main baseline
        let glyphs = vec![
            glyph(10.0, 90.0, 10.0, "Q", Some("Q")),
            glyph(16.0, 90.0, 10.0, "K", Some("K")),
            glyph(24.0, 100.0, 10.0, "s", Some("s")),
            glyph(10.0, 100.2, 10.0, "√", Some("\\surd")),
            glyph(16.0, 108.0, 10.0, "d", Some("d")),
        ];
        // bar at y=100, x 8..22
        let rules = vec![Rule { rect: crate::geom::Rect { x0: 8.0, y0: 100.0, x1: 22.0, y1: 100.0 }, color: (0.0, 0.0, 0.0) }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let (_, above, _mid, below) = Builder {
            fonts: &fonts,
            rules: &rule_refs,
            used_rules: vec![false],
            warn: &mut Vec::new(),
            dropped: &mut 0,
            limit_spans: &[],
            wraps: &std::cell::RefCell::new(std::collections::HashMap::new()),
        }
        .split_fraction(&refs)
        .expect("a bar with glyphs above and below must split");
        let above_txt: String = above.iter().map(|g| g.text.as_str()).collect();
        let below_txt: String = below.iter().map(|g| g.text.as_str()).collect();
        assert_eq!(above_txt, "QK");
        assert!(below_txt.contains('d'), "d must be below: {}", below_txt);
        assert!(below_txt.contains("√"), "the √ (origin 0.2 below the bar) must be below: {}", below_txt);
        let mid_txt: String = _mid.iter().map(|g| g.text.as_str()).collect();
        assert!(mid_txt.contains('s'), "the beside-bar glyph must stay mid: {}", mid_txt);
    }

    /// RC6: `\upsilon` followed by `R` must not fuse into `\upsilonR`.
    #[test]
    fn macro_letters_keep_separated() {
        let mut out = String::from("\\upsilon");
        push_sep(&mut out, "R");
        assert_eq!(out, "\\upsilon R");
        // braces also separate (renders identically in math mode)
        let mut out2 = String::from("\\text{where}");
        push_sep(&mut out2, "head");
        assert_eq!(out2, "\\text{where} head");
    }

    /// RC-accent: a macron whose glyph ORIGIN sits ON the base's baseline
    /// (the ricci paper draws \bar this way) must wrap the base under it —
    /// the nearest glyph by center — never the next glyph. (τ̄ used to come
    /// out as `\tau\bar{)}` / `\tau\bar{2}`.)
    #[test]
    fn accent_wraps_nearest_base() {
        let fonts = vec![FontInfo { tex: TexKind::Cmmi, is_math: true, ..FontInfo::new() }];
        let glyphs = vec![
            glyph(110.9, 311.2, 12.0, "τ", Some("\\tau")),
            // the macron's origin sits ON the baseline, x just right of τ
            glyph(111.5, 311.2, 12.0, "¯", None),
            glyph(120.1, 311.2, 12.0, ")", Some(")")),
        ];
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: vec![], limit_spans: vec![] }, &fonts, &mut warn);
        assert_eq!(out, "\\bar{\\tau})");
    }

    /// RC-run-script: a subscript centered under a multi-glyph operator word
    /// attaches to the word END, not to the letter it x-interleaves with
    /// (eq (1) of 1406.2661: min_G max_D used to become "m_G in m_D ax").
    #[test]
    fn run_centered_subscript_attaches_at_word_end() {
        let mut text = FontInfo::new();
        text.tex = TexKind::Cmr;
        let mut math = FontInfo::new();
        math.tex = TexKind::Cmmi;
        math.is_math = true;
        let fonts = vec![text, math];
        // "min" at baseline in font 0 (kerned: zero gaps), G centered below
        // the word in font 1
        let glyphs = vec![
            glyph(152.2, 100.0, 10.0, "m", None),
            glyph(157.7, 100.0, 10.0, "i", None),
            glyph(160.5, 100.0, 10.0, "n", None),
            glyph(157.4, 103.5, 7.0, "G", Some("G")),
            glyph(170.5, 100.0, 10.0, "V", Some("V")),
        ];
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: vec![], limit_spans: vec![] }, &fonts, &mut warn);
        assert!(out.contains("min_{G}"), "got {:?}", out);
        assert!(!out.contains("m_{G}"), "got {:?}", out);
    }

    /// RC-frac-mid: glyphs beside a fraction classify against the line's own
    // baseline — the fraction branch used to pass base_y=None and flatten
    // every inline script (∑ limits became "i=m1").
    #[test]
    fn scripts_beside_fraction_survive() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(10.0, 100.0, 10.0, "a", Some("a")),
            glyph(16.0, 101.5, 7.0, "b", Some("b")),
            glyph(20.0, 100.0, 10.0, "F", Some("F")),
            // fraction bar at y=100, x 24..30 with 1 above and m below
            glyph(25.0, 92.0, 10.0, "1", Some("1")),
            glyph(25.0, 107.0, 10.0, "m", Some("m")),
            glyph(40.0, 100.0, 10.0, "+", Some("+")),
        ];
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 24.0, y0: 100.0, x1: 30.0, y1: 100.0 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] }, &fonts, &mut warn);
        assert!(out.contains("\\frac{1}{m}"), "got {:?}", out);
        assert!(out.contains("a_{b}"), "got {:?}", out);
    }

    /// Empty radicals must not be emitted as `\sqrt{}` noise.
    #[test]
    fn empty_radical_falls_back_to_surd() {
        let fonts = fonts_math();
        let glyphs = vec![glyph(10.0, 100.0, 10.0, "√", Some("\\surd"))];
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: vec![], limit_spans: vec![] }, &fonts, &mut warn);
        assert_eq!(out, "\\surd");
    }

    /// cmsy slot 0 is the minus sign (1406.2661 lost every "1−D" minus).
    #[test]
    fn cm_slot_minus_maps() {
        assert_eq!(glyphdata::cm_slot_latex(1, 0), Some("-"));
        assert_eq!(glyphdata::cm_slot_latex(0, 0x1C), Some("\\tau"));
    }

    /// Unicode math alphanumerics (Word/unicode-math exports) map to LaTeX.
    #[test]
    fn unicode_math_letters_map() {
        assert_eq!(glyphdata::unicode_math_to_latex(0x1D49E).as_deref(), Some("\\mathcal{C}"));
        assert_eq!(glyphdata::unicode_math_to_latex(0x1D431).as_deref(), Some("\\mathbf{x}"));
    }

    /// cmex piece glyphs count as dropped, not silently vanishing.
    #[test]
    fn dropped_pieces_are_counted() {
        let fonts = vec![FontInfo { tex: TexKind::Cmex, is_math: true, ..FontInfo::new() }];
        let glyphs = vec![glyph(10.0, 100.0, 10.0, "", Some(""))];
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: vec![], limit_spans: vec![] }, &fonts, &mut warn);
        assert!(out.is_empty());
        assert!(warn.iter().any(|w| w.contains("数学字形")), "warn: {:?}", warn);
    }

    /// A one-letter radicand has a SHORT covering bar (`\sqrt{t}` at 12pt has a
    /// 4.2pt rule); scaling the bar-length gate to the font size (0.4×size)
    /// rejected it and the radical lost its radicand ("\surd t" all over
    /// math0211159).
    #[test]
    fn short_covering_bar_still_finds_its_radicand() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(10.0, 100.0, 12.0, "n", Some("n")),
            glyph(20.0, 100.0, 12.0, "√", Some("\\surd")),
            glyph(30.0, 100.0, 12.0, "t", Some("t")),
        ];
        // the covering bar starts right after the radical glyph, 4.2pt long
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 30.0, y0: 98.6, x1: 34.2, y1: 98.6 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] }, &fonts, &mut warn);
        assert_eq!(out, "n\\sqrt{t}", "got {:?}", out);
    }

    /// A fraction whose numerator AND denominator both sit above the enclosing
    /// baseline is the SCRIPT of the atom before it: `(4\pi\tau)^{-n/2}` was
    /// emitted as `(4\pi\tau)^{-}\frac{n}{2}` (the fraction drifted out of the
    /// exponent).
    #[test]
    fn raised_fraction_goes_into_the_script() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(10.0, 100.0, 12.0, "(", Some("(")),
            glyph(16.0, 100.0, 12.0, "a", Some("a")),
            glyph(22.0, 100.0, 12.0, ")", Some(")")),
            // the exponent: `-` then a fraction, all of it above the line
            glyph(28.0, 94.0, 8.0, "-", Some("-")),
            glyph(34.0, 91.0, 6.0, "n", Some("n")),
            glyph(34.0, 96.5, 6.0, "2", Some("2")),
        ];
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 34.0, y0: 93.9, x1: 37.65, y1: 93.9 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] }, &fonts, &mut warn);
        assert!(out.contains("^{-\\frac{n}{2}}"), "the fraction belongs to the exponent: {:?}", out);
    }

    /// Two fractions on ONE baseline: `\frac{d}{dt} logV=\frac{1}{V}\int RdV`
    /// lost the second one to `=_{V}^{1}` because the beside pass classified
    /// its stack as scripts of the preceding `=`.
    #[test]
    fn second_fraction_beside_the_first_keeps_its_bar() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(10.0, 100.0, 12.0, "d", Some("d")),
            // the first fraction: d over dt, the bar at y=100
            glyph(15.0, 95.5, 8.0, "d", Some("d")),
            glyph(15.0, 104.5, 8.0, "d", Some("d")),
            glyph(19.4, 104.5, 8.0, "t", Some("t")),
            glyph(30.0, 100.0, 12.0, "=", Some("=")),
            // the second fraction on the same baseline: 1 over V
            glyph(40.0, 95.5, 8.0, "1", Some("1")),
            glyph(40.0, 104.5, 8.0, "V", Some("V")),
            glyph(52.0, 100.0, 12.0, "R", Some("R")),
        ];
        let rules = vec![
            Rule { rect: crate::geom::Rect { x0: 15.0, y0: 100.0, x1: 23.0, y1: 100.0 }, color: (0.0, 0.0, 0.0) },
            Rule { rect: crate::geom::Rect { x0: 40.0, y0: 100.0, x1: 44.4, y1: 100.0 }, color: (0.0, 0.0, 0.0) },
        ];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(&MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] }, &fonts, &mut warn);
        assert!(out.contains("\\frac{d}{dt}"), "got {:?}", out);
        assert!(out.contains("\\frac{1}{V}"), "the second fraction must keep its bar: {:?}", out);
        assert!(!out.contains("_{V}^{1}"), "got {:?}", out);
    }

    /// An inline radicand is kerned to its radical glyph, so it follows the √
    /// into the math run even in a text line: `radius $\surd$ 2 $N\tau$` was the
    /// split of `\sqrt{2N\tau(q)}` in a paragraph of math0211159.
    #[test]
    fn radicand_follows_its_radical_into_math() {
        let mut cmr = FontInfo::new();
        cmr.tex = TexKind::Cmr;
        let mut text = FontInfo::new();
        let fonts = vec![cmr, text];
        let mk = |x: f64, t: &str, latex: Option<&str>, font: usize| {
            let mut g = glyph(x, 100.0, 12.0, t, latex);
            g.font = font;
            g
        };
        // kerned: each glyph's advance is size*0.55 = 6.6pt
        let glyphs = vec![
            // "r" of "radius", prose in the cmr body font
            mk(0.0, "r", None, 0),
            mk(6.6, "√", Some("\\surd"), 0),
            mk(13.2, "2", None, 0),
            mk(19.8, "N", Some("N"), 0),
            mk(26.4, "(", None, 0),
        ];
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let segs = split_segments(&refs, &fonts, false);
        let dump: Vec<(bool, String)> = segs
            .iter()
            .map(|(m, s)| (*m, s.iter().map(|g| g.text.clone()).collect::<String>()))
            .collect();
        assert_eq!(dump, vec![(false, "r".to_string()), (true, "√2N(".to_string())], "{:?}", dump);
    }

    /// RC-radicand-bar: the radicand ends where the covering bar ends — a
    /// glyph whose CENTER lies past the bar is the atom AFTER the radical. The
    /// old half-size ink tolerance swallowed the differential of ricci p13's
    /// `\int_0^{\tau(q)}\sqrt{\frac{N}{2\tau}+R+|\dot\gamma_M(\tau)|^2}\,d\tau`
    /// (`\sqrt{...\vert ^{2} d}` kept it inside the root).
    #[test]
    fn radicand_ends_at_the_covering_bar() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(260.28, 647.52, 11.96, "r", Some("\\surd")),
            // the radicand row
            glyph(289.56, 666.48, 11.96, "+", None),
            glyph(301.32, 666.48, 11.96, "R", Some("R")),
            // the differential: its ink still ends at the bar's edge (the old
            // half-size tolerance swallowed it), its CENTER is past it
            glyph(366.71, 666.48, 11.96, "d", Some("d")),
            glyph(373.32, 666.48, 11.96, "\\tau", Some("\\tau")),
        ];
        // the radical's covering bar spans the radicand, ending at x=367.31
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 272.27, y0: 647.05, x1: 367.31, y1: 647.53 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(
            &MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] },
            &fonts,
            &mut warn,
        );
        assert_eq!(out, "\\sqrt{+R} d\\tau", "the differential stays outside the root");
    }

    /// RC-side-limit: TeX sets a big operator's limits BESIDE it in text style —
    /// `\int_0^{\tau(q)}` puts the subscript at the operator's right edge and
    /// the superscript above it. The centered window missed them and the
    /// cluster hung on the last atom emitted instead: ricci p13 printed
    /// `\sqrt{...}^{\tau(q)}` with the ∫ bare.
    #[test]
    fn side_script_cluster_becomes_the_operators_limit() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(230.52, 650.16, 11.96, "Z", Some("\\int")),
            glyph(242.52, 653.40, 7.97, "\\tau", Some("\\tau")),
            glyph(247.20, 653.40, 7.97, "(", None),
            glyph(250.44, 653.40, 7.97, "q", Some("q")),
            glyph(254.52, 653.40, 7.97, ")", None),
            glyph(237.12, 677.28, 7.97, "0", Some("0")),
            // the radical follows the cluster, so a limit left unclaimed hangs
            // on the root instead of the operator
            glyph(260.28, 647.52, 11.96, "r", Some("\\surd")),
            // the row the formula sits on
            glyph(289.56, 666.48, 11.96, "+", None),
            glyph(301.32, 666.48, 11.96, "R", Some("R")),
        ];
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 272.27, y0: 647.05, x1: 367.31, y1: 647.53 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(
            &MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] },
            &fonts,
            &mut warn,
        );
        assert!(
            out.starts_with("\\int\\limits_{0}^{\\tau(q)}\\sqrt{"),
            "the cluster is the integral's own limit, not the root's script: {:?}",
            out
        );
    }

    /// A radical is an ATOM, never a limit: the √ of `\int\sqrt{...}` sits in
    /// the ∫'s own window and was claimed as its upper limit
    /// (`\int\limits_{0}^{\surd _{\tau(q)}}`).
    #[test]
    fn radical_is_never_a_limit() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(230.52, 650.16, 11.96, "Z", Some("\\int")),
            glyph(260.28, 647.52, 11.96, "r", Some("\\surd")),
            glyph(289.56, 666.48, 11.96, "+", None),
            glyph(301.32, 666.48, 11.96, "R", Some("R")),
        ];
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 272.27, y0: 647.05, x1: 367.31, y1: 647.53 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(
            &MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] },
            &fonts,
            &mut warn,
        );
        assert!(
            out.starts_with("\\int\\sqrt{"),
            "the radical is an atom, never a limit: {:?}",
            out
        );
    }

    /// RC-accent-pending: an accent whose base is still PENDING as a script
    /// glyph rewrites that base — it must not eat the tail of `out`. In ricci
    /// p29 the `\bar` of `\vert_{t=\bar{t}}` wrapped the final `t` of `\vert`,
    /// which reached the markdown as the invalid `\ver`.
    #[test]
    fn accent_on_a_pending_script_base_keeps_macros_whole() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(482.88, 300.36, 11.96, "|", Some("\\vert")),
            glyph(486.24, 302.28, 7.97, "t", Some("t")),
            glyph(489.24, 302.28, 7.97, "=", None),
            glyph(495.84, 302.28, 7.97, "t", Some("t")),
            // the macron, drawn on its base
            glyph(495.96, 300.84, 7.97, "\u{00AF}", None),
        ];
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(
            &MathRun { glyphs: refs, rules: vec![], limit_spans: vec![] },
            &fonts,
            &mut warn,
        );
        assert!(
            !out.contains("\\ver ") && !out.ends_with("\\ver"),
            "a macro must stay whole: {:?}",
            out
        );
        assert!(out.contains("\\vert"), "the operator survives: {:?}", out);
        assert!(out.contains("_{t=\\bar{t}}"), "the accent wraps the pending base: {:?}", out);
    }

    /// RC-accent-beside-fraction: a run that carries a fraction bar goes
    /// through the fraction branch, and its beside-glyphs must fold accents
    /// there too. ricci's `\tilde{g}_{ij}=g_{ij},\tilde{g}_{\alpha\beta}=
    /// \tau g_{\alpha\beta}` (the same run as `\frac{N}{2\tau}`) came out as
    /// `g\tilde{}_{ij}` with the tilde floating after its base, 20 times.
    #[test]
    fn accent_beside_a_fraction_wraps_its_base() {
        let fonts = fonts_math();
        let glyphs = vec![
            glyph(164.64, 587.16, 11.96, "g", Some("g")),
            glyph(165.00, 587.16, 11.96, "\u{02DC}", None),
            glyph(170.28, 588.96, 7.97, "i", Some("i")),
            glyph(173.16, 588.96, 7.97, "j", Some("j")),
            glyph(180.84, 587.16, 11.96, "=", None),
            // the fraction `\frac{N}{2\tau}` on the same baseline
            glyph(240.32, 583.44, 7.97, "N", Some("N")),
            glyph(240.32, 591.84, 7.97, "2", None),
            glyph(244.90, 591.84, 7.97, "\\tau", Some("\\tau")),
        ];
        let rules = vec![Rule {
            rect: crate::geom::Rect { x0: 238.0, y0: 587.66, x1: 245.0, y1: 587.66 },
            color: (0.0, 0.0, 0.0),
        }];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(
            &MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] },
            &fonts,
            &mut warn,
        );
        assert!(out.contains("\\tilde{g}_{ij}"), "the tilde wraps its base: {:?}", out);
        assert!(!out.contains("g\\tilde{}"), "got {:?}", out);
    }


    /// RC-ligature: a LIGATURE glyph (ﬁ/ﬂ — one glyph carrying two letters)
    /// belongs to its word like any other letter. Rejecting non-single-char
    /// glyphs left it unprose, so on a line whose inline formulas made it
    /// "math" the ligature became an inline formula of its own: `$ﬂ$ ow` for
    /// "flow", `de $ﬁ$ ned` for "defined", `satis $ﬁ$ es` for "satisfies"
    /// (34 such runs in math0211159 before the fix).
    #[test]
    fn ligature_glyphs_join_their_prose_word() {
        let mut cmr = FontInfo::new();
        cmr.tex = TexKind::Cmr;
        let fonts = vec![cmr];
        let mut glyphs: Vec<Glyph> = Vec::new();
        for raw in ["f", "\u{FB02}", "o", "w"] {
            let mut g = glyph(10.0 + 5.0 * glyphs.len() as f64, 100.0, 12.0, raw, None);
            g.wx = 5.0;
            glyphs.push(g);
        }
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let segs = split_segments(&refs, &fonts, true);
        let dump: Vec<(bool, String)> = segs
            .iter()
            .map(|(m, s)| (*m, s.iter().map(|g| g.text.clone()).collect::<String>()))
            .collect();
        let text: String = dump.iter().filter(|(m, _)| !*m).map(|(_, t)| t.clone()).collect();
        assert_eq!(text, "f\u{FB02}ow", "the ligature stays in its word: {:?}", dump);
        assert!(dump.iter().all(|(m, _)| !*m), "no inline formula from a word: {:?}", dump);
    }


    /// RC-radical-bar-is-not-a-fraction-bar: the bar over a radical's own hook
    /// is the radical's, never a fraction's. ricci's `0<r<\rho(w)\sqrt{t}`
    /// put the radical's bar between two glyphs of the line ABOVE that
    /// x-overlap its slot, so the fraction branch claimed the run first and the
    /// formula printed `\surd ^{1}\frac{0}{t}` (the radicand lost, a garbage
    /// fraction built from the neighbouring line's `1`,`0`).
    #[test]
    fn radical_covering_bar_is_not_taken_as_a_fraction() {
        let fonts = fonts_math();
        let mut glyphs = vec![
            glyph(274.93, 196.92, 11.96, "\rho", Some("\\rho")),
            glyph(280.92, 196.92, 11.96, "(", None),
            glyph(285.48, 196.92, 11.96, "w", Some("w")),
            glyph(294.24, 196.92, 11.96, ")", None),
            glyph(298.80, 187.20, 11.96, "r", Some("\\surd")),
            // the line above: two script-sized digits 11.8pt above this one
            glyph(301.80, 185.16, 7.97, "1", None),
            glyph(306.00, 185.16, 7.97, "0", None),
            // the radicand
            glyph(308.64, 196.92, 11.96, "t", Some("t")),
        ];
        glyphs[4].wx = 9.96;
        let rules = vec![
            // the line above's fraction bar …
            Rule { rect: crate::geom::Rect { x0: 301.79, y0: 177.85, x1: 310.31, y1: 178.33 }, color: (0.0, 0.0, 0.0) },
            // … and the radical's own covering bar, over the `t`
            Rule { rect: crate::geom::Rect { x0: 308.63, y0: 186.73, x1: 312.95, y1: 187.21 }, color: (0.0, 0.0, 0.0) },
        ];
        let rule_refs: Vec<&Rule> = rules.iter().collect();
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut warn = Vec::new();
        let out = reconstruct(
            &MathRun { glyphs: refs, rules: rule_refs, limit_spans: vec![] },
            &fonts,
            &mut warn,
        );
        assert!(out.contains("\\sqrt{t}"), "the radicand is found: {:?}", out);
        assert!(!out.contains("\\frac{0}{t}"), "the radical's bar is no fraction: {:?}", out);
    }

}
