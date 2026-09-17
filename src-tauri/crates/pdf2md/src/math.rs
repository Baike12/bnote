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
}

/// Reconstructs LaTeX for a run of glyphs (already sorted by x).
pub fn reconstruct(run: &MathRun, fonts: &[FontInfo]) -> String {
    if run.glyphs.is_empty() {
        return String::new();
    }
    let mut glyphs = run.glyphs.clone();
    glyphs.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    let base_size = glyphs.iter().map(|g| g.size).fold(0.0f64, f64::max);
    let rules: Vec<&Rule> = run
        .rules
        .iter()
        .filter(|r| r.rect.width() > 1.5 && r.rect.height() < 2.0)
        .copied()
        .collect();
    let mut out = Builder {
        fonts,
        rules: &rules,
        used_rules: vec![false; rules.len()],
    }
    .build(&glyphs, None, base_size);
    out = out.trim().to_string();
    if out.is_empty() {
        // fall back to raw text
        out = glyphs.iter().map(|g| g.text.clone()).collect();
    }
    out
}

struct Builder<'a> {
    fonts: &'a [FontInfo],
    rules: &'a [&'a Rule],
    used_rules: Vec<bool>,
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
        if let Some((bar_idx, above, mid, below)) = self.split_fraction(glyphs, base_size) {
            self.used_rules[bar_idx] = true;
            let bar = self.rules[bar_idx].rect;
            let num_size = above.iter().map(|g| g.size).fold(0.0f64, f64::max).max(base_size * 0.5);
            let den_size = below.iter().map(|g| g.size).fold(0.0f64, f64::max).max(base_size * 0.5);
            let num = self.build(&above, None, num_size);
            let den = self.build(&below, None, den_size);
            // mid glyphs sit beside the fraction on the main baseline
            let mut out = String::new();
            let mut sup: Vec<&Glyph> = Vec::new();
            let mut sub: Vec<&Glyph> = Vec::new();
            let bar_cx = (bar.x0 + bar.x1) / 2.0;
            let mut frac_placed = false;
            for g in mid {
                let cls = classify_script(g, base_y, base_size);
                match cls {
                    Script::Sup => sup.push(g),
                    Script::Sub => sub.push(g),
                    Script::Normal => {
                        flush_scripts(&mut out, &mut sup, &mut sub, self.fonts, base_size);
                        if !frac_placed && g.x >= bar_cx {
                            out.push_str(&format!("\\frac{{{}}}{{{}}}", num, den));
                            frac_placed = true;
                        }
                        out.push_str(&self.atom(g));
                        if !frac_placed {
                            // atom right before the bar keeps it pending
                        }
                    }
                    Script::LimitAbove | Script::LimitBelow => {
                        sup.push(g);
                    }
                }
            }
            flush_scripts(&mut out, &mut sup, &mut sub, self.fonts, base_size);
            if !frac_placed {
                out.push_str(&format!("\\frac{{{}}}{{{}}}", num, den));
            }
            return out;
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
        let mut accent_pending: Option<String> = None;
        let mut i = 0;
        while i < glyphs.len() {
            if consumed[i] {
                i += 1;
                continue;
            }
            let g = glyphs[i];

            // radical: \surd / √
            let lx = self.atom_latex(g);
            if lx == "\\surd" || lx == "√" {
                consumed[i] = true;
                // find covering bar
                let mut radicand: Vec<&Glyph> = Vec::new();
                let mut bar_used = false;
                for (ri, r) in self.rules.iter().enumerate() {
                    if self.used_rules[ri] {
                        continue;
                    }
                    let rr = r.rect;
                    if rr.x0 >= g.x + g.wx * 0.5
                        && rr.x0 <= g.x + g.wx + g.size
                        && (rr.y0 - (g.bbox().y0)).abs() < g.size * 0.8
                        && rr.width() > g.size * 0.4
                    {
                        // radicand = glyphs whose bbox sits under the bar
                        for (k, g2) in glyphs.iter().enumerate() {
                            if consumed[k] || k == i {
                                continue;
                            }
                            let b2 = g2.bbox();
                            if b2.x0 >= rr.x0 - 1.0 && b2.x1 <= rr.x1 + g.size * 0.5 && b2.y1 > rr.y0 - 0.5 {
                                radicand.push(g2);
                                consumed[k] = true;
                            }
                        }
                        // nested rules inside radicand
                        for (rj, r2) in self.rules.iter().enumerate() {
                            if self.used_rules[rj] || rj == ri {
                                continue;
                            }
                            if r2.rect.x0 >= rr.x0 && r2.rect.x1 <= rr.x1 + 1.0 {
                                self.used_rules[rj] = true;
                            }
                        }
                        self.used_rules[ri] = true;
                        bar_used = true;
                        break;
                    }
                }
                radicand.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
                let inner = self.build(&radicand, Some(main_y), size_ref);
                let index = sub_script_of(&glyphs, &mut consumed, i, true);
                out.push_str(&format!("\\sqrt{}{{{}}}", index, inner));
                let _ = bar_used;
                i += 1;
                continue;
            }

            // accents: latex like "\hat{}" wraps the next atom
            if lx.ends_with("{}") && lx.starts_with('\\') && lx.len() > 3 {
                let name = &lx[..lx.len() - 2];
                consumed[i] = true;
                // next non-consumed normal glyph is the base
                let mut j = i + 1;
                while j < glyphs.len() && consumed[j] {
                    j += 1;
                }
                if j < glyphs.len() {
                    consumed[j] = true;
                    let base = self.atom(glyphs[j]);
                    out.push_str(&format!("{}{{{}}}", name, base));
                    i = j + 1;
                } else {
                    out.push_str(name);
                }
                accent_pending = None;
                continue;
            }

            let cls = classify_script(g, Some(main_y), size_ref);
            match cls {
                Script::Normal => {
                    flush_scripts(&mut out, &mut sup, &mut sub, self.fonts, size_ref);
                    // big operator with limits?
                    if let Some(limits) = self.try_limits(glyphs, i, &mut consumed, main_y, size_ref) {
                        out.push_str(&limits);
                        i += 1;
                        continue;
                    }
                    out.push_str(&self.atom_sized(g, size_ref));
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
        flush_scripts(&mut out, &mut sup, &mut sub, self.fonts, size_ref);
        out
    }

    /// Big operator (\sum,\prod,\int,\bigcup…) with glyphs centered directly
    /// above/below → `\sum_{sub}^{sup}` (with \limits for integrals).
    fn try_limits(
        &mut self,
        glyphs: &[&Glyph],
        i: usize,
        consumed: &mut [bool],
        main_y: f64,
        size_ref: f64,
    ) -> Option<String> {
        let g = glyphs[i];
        let lx = self.atom_latex(g);
        const LIMIT_OPS: [&str; 10] = [
            "\\sum", "\\prod", "\\coprod", "\\int", "\\oint", "\\iint", "\\iiint",
            "\\bigcup", "\\bigcap", "\\bigoplus",
        ];
        const SIDE_OPS: [&str; 6] = ["\\biguplus", "\\bigvee", "\\bigwedge", "\\bigodot", "\\bigotimes", "\\bigsqcup"];
        let is_limit_op = LIMIT_OPS.contains(&lx.as_str());
        let is_side_op = SIDE_OPS.contains(&lx.as_str());
        if !is_limit_op && !is_side_op {
            return None;
        }
        let op_cx = g.x + g.wx / 2.0;
        let op_w = g.wx.max(g.size);
        let mut above: Vec<&Glyph> = Vec::new();
        let mut below: Vec<&Glyph> = Vec::new();
        for (k, g2) in glyphs.iter().enumerate() {
            if consumed[k] || k == i {
                continue;
            }
            let c2 = g2.x + g2.wx / 2.0;
            if (c2 - op_cx).abs() > op_w * 0.75 {
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
        Some(format!("{}{}{}_{{{}}}^{{{}}}", lx, limits_cmd, "", sub, sup))
    }

    /// One glyph → its LaTeX body.
    fn atom(&self, g: &Glyph) -> String {
        self.atom_latex(g)
    }

    fn atom_sized(&self, g: &Glyph, size_ref: f64) -> String {
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
    fn atom_latex(&self, g: &Glyph) -> String {
        if let Some(lx) = &g.latex {
            if !lx.is_empty() {
                return lx.clone();
            }
            return String::new(); // piece glyph intentionally dropped
        }
        let mut out = String::new();
        for ch in g.text.chars() {
            if let Some(lx) = glyphdata::uni_to_latex(ch as u32) {
                out.push_str(lx);
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
        let left = glyphs.iter().min_by(|a, b| a.x.partial_cmp(&b.x).unwrap())?;
        let right = glyphs.iter().max_by(|a, b| (a.x + a.wx).partial_cmp(&(b.x + b.wx)).unwrap())?;
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
                .filter(|g| !std::ptr::eq(*g, left) && !std::ptr::eq(*g, right))
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
    #[allow(clippy::type_complexity)]
    fn split_fraction<'b>(
        &self,
        glyphs: &'b [&'b Glyph],
        base_size: f64,
    ) -> Option<(usize, Vec<&'b Glyph>, Vec<&'b Glyph>, Vec<&'b Glyph>)> {
        let mut best: Option<(usize, f64)> = None;
        for (ri, r) in self.rules.iter().enumerate() {
            if self.used_rules[ri] {
                continue;
            }
            let rr = r.rect;
            // horizontal, roughly expression width, near the vertical middle
            if rr.height() > 2.0 || rr.width() < base_size * 0.6 {
                continue;
            }
            let above = glyphs.iter().filter(|g| g.baseline_or_y() < rr.y0 - 0.5).count();
            let below = glyphs
                .iter()
                .filter(|g| g.baseline_or_y() > rr.y1 + 0.35 * base_size)
                .count();
            if above == 0 || below == 0 {
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
            if y < rr.y0 - 0.5 {
                above.push(*g);
            } else if y > rr.y1 + 0.35 * base_size {
                below.push(*g);
            } else {
                mid.push(*g);
            }
        }
        above.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        below.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        mid.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        Some((ri, above, mid, below))
    }
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
    let dy = g.y - y; // + = below baseline
    if g.size < size_ref * 0.88 {
        if dy < -0.10 * size_ref {
            return Script::Sup;
        }
        if dy > 0.14 * size_ref {
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

/// Emits pending ^{} / _{} groups after their base atom.
fn flush_scripts(
    out: &mut String,
    sup: &mut Vec<&Glyph>,
    sub: &mut Vec<&Glyph>,
    fonts: &[FontInfo],
    size_ref: f64,
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
        if !sub_s.is_empty() {
            out.push_str(&format!("_{{{}}}", sub_s));
        }
        if !sup_s.is_empty() {
            out.push_str(&format!("^{{{}}}", sup_s));
        }
    }
    sup.clear();
    sub.clear();
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
    // baseline of the largest, most common y
    let mut buckets: Vec<(f64, f64)> = Vec::new();
    for g in glyphs {
        let b = (g.y * 2.0).round() / 2.0;
        match buckets.iter_mut().find(|(y, _)| (*y - b).abs() < 0.51) {
            Some((_, w)) => *w += g.wx.max(0.1),
            None => buckets.push((b, g.wx.max(0.1))),
        }
    }
    buckets
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .map(|(y, _)| *y)
        .unwrap_or_else(|| glyphs[0].y)
}

/// Splits a mixed text/math line into (is_math, glyph slice) segments.
pub fn split_segments<'b>(glyphs: &[&'b Glyph], fonts: &[FontInfo]) -> Vec<(bool, Vec<&'b Glyph>)> {
    let mut segs: Vec<(bool, Vec<&Glyph>)> = Vec::new();
    for g in glyphs {
        let mathy = fonts
            .get(g.font)
            .map(|f| f.is_math || g.latex.is_some())
            .unwrap_or(false)
            || g.latex.is_some();
        let text_mathy = !g.text.is_empty()
            && g.text.chars().all(|c| {
                let u = c as u32;
                (0x2190..=0x2BFF).contains(&u) || (0x1D400..=0x1D7FF).contains(&u)
            });
        let m = mathy || text_mathy;
        match segs.last_mut() {
            Some((is_math, v)) if *is_math == m => v.push(g),
            _ => segs.push((m, vec![g])),
        }
    }
    segs
}

/// Heuristic: does this glyph run look like display math (own-line formula)?
pub fn looks_like_display_math(glyphs: &[&Glyph], fonts: &[FontInfo]) -> bool {
    if glyphs.is_empty() {
        return false;
    }
    let n_math = glyphs
        .iter()
        .filter(|g| {
            fonts
                .get(g.font)
                .map(|f| f.is_math)
                .unwrap_or(false)
                || g.latex.is_some()
        })
        .count();
    let has_op = glyphs.iter().any(|g| {
        g.latex
            .as_deref()
            .map(|l| l.contains('=') || l == "\\sum" || l == "\\int" || l == "\\in")
            .unwrap_or(false)
    });
    n_math * 2 >= glyphs.len() || (n_math >= 2 && has_op)
}

#[allow(dead_code)]
fn bbox_of(glyphs: &[&Glyph]) -> Rect {
    let mut r = Rect::empty();
    for g in glyphs {
        r.union(&g.bbox());
    }
    r
}
