//! Port of `src/editor/snippets/autofraction.ts` — latex-suite's auto-fraction:
//! typing `/` in math expands the expression before the cursor into
//! `\frac{numerator}{}`.
//!
//! Semantics, one by one from the plugin's `features/autofraction.ts`:
//!
//! * the numerator is scanned right-to-left, stopping at whitespace, an
//!   opening bracket, a newline or a breaking character (`+-=` and Tab);
//!   `) ] }` first jump to their matching opener and then decide — so
//!   `\frac{a}{b}/` takes the whole `\frac{a}{b}` as the numerator;
//! * breaking characters cut the expression: `a+b/c` → `a+\frac{b}{c}`;
//! * a space after a Greek command is not a boundary: `\alpha x/` →
//!   `\frac{\alpha x}{}`;
//! * a numerator that is a parenthesised group loses its outer parens:
//!   `(a+b)/` → `\frac{a+b}{}`;
//! * no expansion inside `^{…}` or `\pu{…}` (exponents stay literal);
//! * no expansion inside `\text{…}`, and none outside math.
//!
//! bnote's timing differs from the plugin: the plugin intercepts the `/`
//! keypress (the character never enters the document) while here `/` has
//! already been inserted and the cursor sits after it — so the backward scan
//! starts at `cursor - 2` and the expansion region includes that `/`.

use crate::markdown::context::EditContext;
use crate::markdown::math_scan::MathRegion;

use super::brackets::{find_matching_bracket, within_env};
use super::replacement::{ParsedReplacement, parse_replacement};

/// Everything the backward scan stops on: `" $([{\n"` plus the breaking
/// characters (`+`, `-`, `=` and Tab) — in the plugin those also *cut* the
/// expression, which is the same thing here since the scan stops at the first
/// one and takes everything after it as the numerator.
const STOP_CHARS: &str = " $([{\n+-=\t";
/// Environments whose content stays literal.
const EXCLUDED_ENVS: [(&str, &str); 2] = [("^{", "}"), ("\\pu{", "}")];

/// The plugin's Greek letter table (Yi/Psi & co. are missing there too — the
/// original table is authoritative).
const GREEK_NAMES: [&str; 37] = [
    "alpha", "beta", "gamma", "Gamma", "delta", "Delta", "epsilon", "varepsilon", "zeta", "eta",
    "theta", "Theta", "iota", "kappa", "lambda", "Lambda", "mu", "nu", "omicron", "xi", "Xi", "pi",
    "Pi", "rho", "sigma", "Sigma", "tau", "upsilon", "Upsilon", "varphi", "phi", "Phi", "chi",
    "psi", "Psi", "omega", "Omega",
];

/// One auto-fraction decision: the region to replace (including the `/`) and
/// the parsed replacement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoFraction {
    pub start: usize,
    pub end: usize,
    pub replacement: ParsedReplacement,
}

/// Whether `/` should expand into a fraction; `None` = keep the `/` literal.
/// `ctx` must be the context at `cursor`.
pub fn auto_fraction(
    doc: &str,
    cursor: usize,
    visual_text: Option<&str>,
    ctx: &EditContext,
    math: &[MathRegion],
) -> Option<AutoFraction> {
    let region = math.iter().find(|r| cursor >= r.from && cursor <= r.to)?;
    if ctx.text_env || !(ctx.inline_math || ctx.block_math) {
        return None;
    }

    let content_start = if region.display { region.from + 2 } else { region.from + 1 };
    let to = cursor;
    let slash = to.checked_sub(1)?;

    // Excluded environments: a `/` inside `^{…}` / `\pu{…}` stays literal.
    let content = &doc[content_start..region.to];
    let rel_cursor = to - content_start;
    for (open, close) in EXCLUDED_ENVS {
        if within_env(content, rel_cursor, open, close) {
            return None;
        }
    }

    // A selection is the numerator: "/" just replaced it, so it sits at cursor-1.
    if let Some(visual) = visual_text {
        return Some(build(slash, to, visual));
    }

    // The Greek-space trick: `\alpha x` must not stop at the space, so the
    // space is temporarily replaced (same length) before scanning.
    let scanned = hide_greek_space(&doc[content_start..slash]);
    let mut start = 0usize; // relative to content_start
    let bytes = scanned.as_bytes();
    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        let b = bytes[i];
        if b == b')' || b == b']' || b == b'}' {
            let (open, close) = match b {
                b')' => ("(", ")"),
                b']' => ("[", "]"),
                _ => ("{", "}"),
            };
            let j = find_matching_bracket(&scanned, i, open, close, true, scanned.len())?;
            // Continue from just before the opener (`i = j` then the loop's
            // decrement); j == 0 ends the loop.
            i = j;
            continue;
        }
        if STOP_CHARS.contains(b as char) {
            start = i + 1;
            break;
        }
    }
    if start >= scanned.len() {
        return None; // empty numerator
    }
    let numerator_start = content_start + start;
    let numerator = &doc[numerator_start..slash];
    Some(build(numerator_start, to, numerator))
}

/// Builds the `\frac{numerator}{}` replacement; an outer paren pair around the
/// numerator is stripped (`(a+b)/` → `\frac{a+b}{}`).
fn build(start: usize, end: usize, numerator: &str) -> AutoFraction {
    let mut inner = numerator;
    if inner.starts_with('(') && inner.ends_with(')') {
        let closing = find_matching_bracket(inner, 0, "(", ")", false, inner.len());
        if closing == Some(inner.len() - 1) {
            inner = &inner[1..inner.len() - 1];
        }
    }
    AutoFraction {
        start,
        end,
        replacement: parse_replacement(&format!("\\frac{{{}}}{{$0}}$1", inner), &[], None, false),
    }
}

/// Port of the TS `GREEK_SPACE` regex replace `(${GREEK}) ([^ ])` → `$1#$2`:
/// every Greek command followed by a space and a non-space loses the space
/// (replaced by `#` of equal length, so positions are preserved).
fn hide_greek_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < s.len() {
        if let Some(name) = GREEK_NAMES.iter().find(|n| s[i..].starts_with(**n)) {
            let after_name = i + name.len();
            let rest = &s[after_name..];
            if let Some(tail) = rest.strip_prefix(' ') {
                if let Some(next) = tail.chars().next() {
                    if next != ' ' {
                        out.push_str(name);
                        out.push('#');
                        out.push(next);
                        i = after_name + 1 + next.len_utf8();
                        continue;
                    }
                }
            }
        }
        let c = s[i..].chars().next().expect("i is a char boundary");
        out.push(c);
        i += c.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::context::context_at_scan;
    use crate::markdown::math_scan::scan_math;

    /// autofraction.test.ts `frac(doc, cursor, visualText)`.
    fn frac(doc: &str, cursor: usize, visual: Option<&str>) -> Option<AutoFraction> {
        let math = scan_math(doc);
        let ctx = context_at_scan(doc, cursor, &math);
        auto_fraction(doc, cursor, visual, &ctx, &math)
    }

    /// `auto-fraction(latex-suite 语义移植)`.
    #[test]
    fn breaking_char_cuts_the_numerator() {
        let r = frac("$$silu(x)=1/", 12, None).unwrap();
        assert_eq!(r.replacement.text, "\\frac{1}{}");
        assert_eq!(r.start, 10); // right after the `=`
        assert_eq!(r.end, 12); // includes the just-typed `/`
    }

    #[test]
    fn plus_breaks_the_numerator() {
        let r = frac("$$a+b/", 6, None).unwrap();
        assert_eq!(r.replacement.text, "\\frac{b}{}");
        assert_eq!(r.start, 4);
    }

    #[test]
    fn without_a_breaking_char_the_whole_expression_is_the_numerator() {
        assert_eq!(frac("$$ab/", 5, None).unwrap().replacement.text, "\\frac{ab}{}");
    }

    #[test]
    fn closing_brace_jumps_to_the_matching_opener() {
        let r = frac("$$\\frac{a}{b}/", 14, None).unwrap();
        assert_eq!(r.replacement.text, "\\frac{\\frac{a}{b}}{}");
        assert_eq!(r.start, 2);
    }

    #[test]
    fn parenthesised_numerator_loses_its_outer_parens() {
        assert_eq!(frac("$$(a+b)/", 8, None).unwrap().replacement.text, "\\frac{a+b}{}");
    }

    #[test]
    fn a_space_after_a_greek_command_is_not_a_boundary() {
        assert_eq!(
            frac("$$\\alpha x/", 11, None).unwrap().replacement.text,
            "\\frac{\\alpha x}{}"
        );
    }

    #[test]
    fn an_exponent_group_that_closed_still_expands() {
        assert_eq!(frac("$$e^{xy}/", 9, None).unwrap().replacement.text, "\\frac{e^{xy}}{}");
    }

    #[test]
    fn inside_an_exponent_group_nothing_expands() {
        assert!(frac("$$e^{x/}", 7, None).is_none());
    }

    #[test]
    fn inside_pu_nothing_expands() {
        assert!(frac("$$\\pu{x/}", 8, None).is_none());
    }

    #[test]
    fn an_empty_numerator_does_not_expand() {
        assert!(frac("$$x + /", 7, None).is_none());
    }

    #[test]
    fn inside_text_env_nothing_expands() {
        assert!(frac("$$\\text{a/b}$$", 10, None).is_none());
    }

    #[test]
    fn outside_math_nothing_expands() {
        assert!(frac("x/", 2, None).is_none());
    }

    #[test]
    fn inline_math_with_a_closing_dollar_works_too() {
        let r = frac("$a+b/$", 5, None).unwrap();
        assert_eq!(r.replacement.text, "\\frac{b}{}");
    }

    #[test]
    fn the_numerator_never_crosses_a_line() {
        assert_eq!(frac("$$x\ny/", 6, None).unwrap().replacement.text, "\\frac{y}{}");
    }

    #[test]
    fn tab_is_a_breaking_char_and_cuts_the_numerator_empty() {
        assert!(frac("$$x\t/", 5, None).is_none());
    }

    #[test]
    fn the_selection_is_the_numerator() {
        let r = frac("$$/", 3, Some("a+b")).unwrap();
        assert_eq!(r.replacement.text, "\\frac{a+b}{}");
        assert_eq!(r.start, 2);
        assert_eq!(r.end, 3);
    }

    /// The `$0`-in-denominator shape the session relies on.
    #[test]
    fn the_replacement_puts_the_first_tabstop_in_the_denominator() {
        let r = frac("$$silu(x)=1/", 12, None).unwrap();
        assert_eq!(r.replacement.text, "\\frac{1}{}");
        assert_eq!(r.replacement.stops.len(), 2);
        assert_eq!(r.replacement.stops[0], super::super::Stop { index: 0, from: 9, to: 9 });
        assert_eq!(r.replacement.stops[1], super::super::Stop { index: 1, from: 10, to: 10 });
    }

    #[test]
    fn hide_greek_space_rewrites_only_command_space_pairs() {
        assert_eq!(hide_greek_space("\\alpha x"), "\\alpha#x");
        assert_eq!(hide_greek_space("ab"), "ab");
        assert_eq!(hide_greek_space("\\alphax"), "\\alphax");
        assert_eq!(hide_greek_space("\\alpha  x"), "\\alpha  x"); // a space after the space
        assert_eq!(hide_greek_space("x \\varphi y"), "x \\varphi#y");
        // Equal length: positions survive the rewrite.
        assert_eq!(hide_greek_space("\\alpha x").len(), "\\alpha x".len());
    }
}
