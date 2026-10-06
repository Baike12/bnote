//! Layout tests against deterministic fake metrics.
//!
//! The measurer below is fake but *linear*: a run is `0.6 * size` per character
//! wide, its ascent is `0.8 * size` and its descent `0.2 * size`. Every number
//! asserted here is derived from those three rules, so the tests pin the
//! geometry this crate computes rather than the metrics of any real font.
//!
//! Conventions used throughout: `SIZE = 16`, script size `0.7 * 16 = 11.2`,
//! thin space `0.1667 * 16 = 2.6672`, and the tests read items as
//! `(x, baseline, text, size)` for runs and `(x, y, w, h)` for rules.

use crate::parse::parse_mathml;
use crate::*;

const SIZE: f32 = 16.0;
/// Scripts are set at 0.7 of the base size.
const SCRIPT: f32 = SIZE * 0.7;

struct Fake;
impl MathFontMetrics for Fake {
    fn measure(&self, text: &str, spec: FontSpec) -> Measured {
        Measured {
            width: text.chars().count() as f32 * spec.size * 0.6,
            ascent: spec.size * 0.8,
            descent: spec.size * 0.2,
        }
    }
}

/// `(x, baseline, text, size)` of one run.
type RunItem = (f32, f32, String, f32);
/// `(x, y, w, h)` of one rule.
type RuleItem = (f32, f32, f32, f32);

/// `(x, baseline, text, size)` for every run, in paint order.
fn runs(l: &MathLayout) -> Vec<RunItem> {
    l.items
        .iter()
        .filter_map(|item| match item {
            MathItem::Run {
                x,
                baseline,
                text,
                spec,
            } => Some((*x, *baseline, text.clone(), spec.size)),
            MathItem::Rule { .. } => None,
        })
        .collect()
}

/// `(x, y, w, h)` for every rule, in paint order.
fn rules(l: &MathLayout) -> Vec<RuleItem> {
    l.items
        .iter()
        .filter_map(|item| match item {
            MathItem::Rule { x, y, w, h } => Some((*x, *y, *w, *h)),
            MathItem::Run { .. } => None,
        })
        .collect()
}

fn laid(tex: &str, display: bool) -> MathLayout {
    layout(tex, display, SIZE, None, &Fake).unwrap_or_else(|| panic!("no layout for {tex:?}"))
}

/// The single run with this text (the fixtures are small enough that texts are
/// unique per formula).
fn run(l: &MathLayout, text: &str) -> (f32, f32, f32) {
    let hits: Vec<_> = runs(l).into_iter().filter(|r| r.2 == text).collect();
    assert_eq!(
        hits.len(),
        1,
        "expected exactly one {text:?} run in {hits:?}"
    );
    (hits[0].0, hits[0].1, hits[0].3)
}

fn width_of(size: f32, chars: usize) -> f32 {
    chars as f32 * size * 0.6
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() <= 0.01
}

fn assert_close(a: f32, b: f32, what: &str) {
    assert!(close(a, b), "{what}: {a} != {b}");
}

// ---------------------------------------------------------------------------
// Structural rules
// ---------------------------------------------------------------------------

#[test]
fn fraction_bar_sits_between_the_halves_and_spans_the_wider_one() {
    let l = laid(r"\frac{a}{b}", false);
    let (_, num_baseline, num_size) = run(&l, "a");
    let (_, den_baseline, _) = run(&l, "b");
    let bars = rules(&l);
    assert_eq!(bars.len(), 1, "one bar: {bars:?}");
    let (bar_x, bar_y, bar_w, bar_h) = bars[0];

    let num_bottom = num_baseline + 0.2 * num_size;
    // 0.1em padding above and below a 0.04em bar.
    assert_close(num_bottom + 0.1 * SIZE, bar_y, "padding above the bar");
    assert_close(
        bar_y + bar_h + 0.1 * SIZE,
        den_baseline - 0.8 * SCRIPT,
        "padding below",
    );
    assert!(num_bottom < bar_y, "bar below the numerator");
    assert!(
        bar_y + bar_h < den_baseline - 0.8 * SCRIPT,
        "bar above the denominator"
    );
    assert_close(bar_w, width_of(SCRIPT, 1), "bar spans the widest half");
    assert_close(bar_x, 0.0, "single-glyph halves are the same width");
    assert_close(bar_h, 0.04 * SIZE, "bar thickness");
}

#[test]
fn fraction_halves_are_full_size_in_display_and_script_size_inline() {
    let inline = laid(r"\frac{a}{b}", false);
    assert_close(run(&inline, "a").2, SCRIPT, "inline numerator size");
    let display = laid(r"\frac{a}{b}", true);
    assert_close(run(&display, "a").2, SIZE, "display numerator size");
    assert_close(run(&display, "b").2, SIZE, "display denominator size");
}

#[test]
fn nested_fractions_step_down_the_size_ladder() {
    let l = laid(r"\frac{\frac{a}{b}}{c}", false);
    // display → text → script → scriptscript.
    assert_close(run(&l, "c").2, SCRIPT, "outer halves at script size");
    assert_close(
        run(&l, "a").2,
        SIZE * 0.5,
        "inner halves at scriptscript size",
    );
}

#[test]
fn a_binom_has_no_bar() {
    let l = laid(r"\binom{1}{2}", false);
    assert!(rules(&l).is_empty(), "linethickness=0 means no rule");
}

#[test]
fn superscript_sits_above_a_smaller_base_and_starts_after_it() {
    let l = laid(r"x^2", false);
    let (base_x, base_baseline, base_size) = run(&l, "x");
    let (sup_x, sup_baseline, sup_size) = run(&l, "2");
    assert!(
        sup_size < base_size,
        "script size {sup_size} < base {base_size}"
    );
    assert_close(sup_size, SCRIPT, "script size");
    assert!(
        sup_baseline < base_baseline,
        "superscript baseline is raised"
    );
    assert!(
        sup_x > base_x + width_of(base_size, 1),
        "superscript starts after the base"
    );
    // 0.45em raise, 0.05em gap.
    assert_close(
        base_baseline - sup_baseline,
        0.45 * SIZE,
        "superscript raise",
    );
    assert_close(
        sup_x - (base_x + width_of(base_size, 1)),
        0.05 * SIZE,
        "script gap",
    );
    assert!(l.ascent >= 0.45 * SIZE + 0.8 * SCRIPT || l.ascent >= 0.8 * SIZE);
}

#[test]
fn subscript_sits_below_the_base() {
    let l = laid(r"x_i", false);
    let (_, base_baseline, _) = run(&l, "x");
    let (sub_x, sub_baseline, sub_size) = run(&l, "i");
    assert_close(sub_baseline - base_baseline, 0.15 * SIZE, "subscript drop");
    assert!(sub_size < SIZE, "subscript is a script");
    assert!(sub_x > width_of(SIZE, 1), "subscript starts after the base");
    // The box has to reach below the baseline to hold the lowered script.
    assert!(l.descent > 0.15 * SIZE, "descent covers the subscript");
}

#[test]
fn a_raised_superscript_over_a_tall_nucleus_clears_it() {
    // `{\sqrt{x}}^2` (the braces are needed: without them latex2mathml folds the
    // superscript *into* the radical). The radical is taller than a flat
    // x-height raise would clear, so the script is put on top of it instead.
    let l = laid(r"{\sqrt{x}}^2", false);
    let (_, radical_baseline, _) = run(&l, "x");
    let (_, sup_baseline, sup_size) = run(&l, "2");
    assert!(sup_size < SIZE, "still a script");
    // The radical is 0.04em of bar plus a glyph tall; the flat raise would put
    // the script inside it, so the shift clears the nucleus instead.
    let radical_ascent = 0.04 * SIZE + 0.8 * SIZE;
    assert!(
        radical_baseline - sup_baseline > 0.45 * SIZE,
        "raised past the flat x-height rule"
    );
    assert_close(
        radical_baseline - sup_baseline,
        radical_ascent,
        "superscript baseline sits on the nucleus's top",
    );
    assert!(
        l.ascent >= radical_ascent - 0.01,
        "the box still holds the radical"
    );
}

#[test]
fn sqrt_overbar_spans_the_content_and_the_hook_comes_first() {
    let l = laid(r"\sqrt{x}", false);
    let (inner_x, inner_baseline, inner_size) = run(&l, "x");
    let hook = run(&l, "√");
    let bars = rules(&l);
    assert_eq!(bars.len(), 1, "one overbar: {bars:?}");
    let (bar_x, bar_y, bar_w, bar_h) = bars[0];

    assert_close(hook.0, 0.0, "hook at the left edge");
    assert_close(
        inner_x,
        hook.0 + width_of(hook.2, 1),
        "content starts after the hook",
    );
    assert_close(bar_x, inner_x, "bar starts at the content");
    assert!(
        bar_w >= width_of(inner_size, 1) - 0.01,
        "bar spans the content"
    );
    assert_close(
        bar_w,
        width_of(inner_size, 1),
        "bar is exactly the content width",
    );
    assert_close(bar_h, 0.04 * SIZE, "bar thickness");
    // The bar rests on the content's top: the content's box begins right below it.
    assert_close(
        inner_baseline - 0.8 * inner_size,
        bar_y + bar_h,
        "bar on the content top",
    );
}

#[test]
fn root_index_is_a_script_at_the_upper_left() {
    let l = laid(r"\sqrt[3]{x}", false);
    let index = run(&l, "3");
    let hook = run(&l, "√");
    let bars = rules(&l);
    assert_eq!(bars.len(), 1);
    assert!(index.2 < SIZE, "index is a script: {}", index.2);
    assert_close(index.0, 0.0, "index at the left edge");
    assert_close(
        hook.0,
        index.0 + width_of(index.2, 1),
        "hook after the index",
    );
    assert_close(
        bars[0].0,
        hook.0 + width_of(hook.2, 1),
        "bar starts where the content does",
    );
    assert!(index.1 < hook.1, "index baseline is above the hook's");
}

#[test]
fn matrix_cells_share_a_column_and_are_centred_on_the_row_axis() {
    let l = laid(r"\begin{pmatrix}a&b\\c&d\end{pmatrix}", false);
    let (ax, abaseline, asize) = run(&l, "a");
    let (cx, cbaseline, _) = run(&l, "c");
    let (bx, _, _) = run(&l, "b");
    let (dx, _, _) = run(&l, "d");

    assert_close(ax, cx, "first column x");
    assert_close(bx, dx, "second column x");
    assert!(bx - ax > width_of(asize, 1), "columns do not overlap");
    assert_close(bx - ax, width_of(asize, 1) + 1.0 * SIZE, "1em column gap");
    // A row is as tall as its tallest cell, so a uniform matrix has rows one
    // cell high: `a` and `c` are a row apart.
    assert_close(cbaseline - abaseline, SIZE, "row pitch is the cell height");

    // The delimiters were stretched to the table and centred on it.
    let paren = run(&l, "(");
    let table_top = abaseline - 0.8 * asize;
    let table_bottom = cbaseline + 0.2 * SIZE;
    assert!(paren.2 > SIZE, "stretched past the base size: {}", paren.2);
    assert_close(
        paren.1 - 0.8 * paren.2,
        table_top,
        "delimiter covers the table top",
    );
    assert_close(
        paren.1 + 0.2 * paren.2,
        table_bottom,
        "delimiter covers the table bottom",
    );
    assert_eq!(rules(&l).len(), 0, "no rule inside a matrix");
}

#[test]
fn stretchy_delimiters_cover_a_fraction() {
    let l = laid(r"\left(\frac{a}{b}\right)", false);
    let paren = run(&l, "(");
    assert!(paren.2 > SIZE, "delimiter grew: {}", paren.2);
    let fraction_height = 2.0 * SCRIPT + 2.0 * 0.1 * SIZE + 0.04 * SIZE;
    assert!(
        paren.2 * (0.8 + 0.2) >= fraction_height - 0.01,
        "delimiter box {} covers the fraction {fraction_height}",
        paren.2 * (0.8 + 0.2)
    );
    // The bar is the tall content's centre, so the delimiter is centred on it.
    let bar = rules(&l)[0];
    let bar_centre = bar.1 + bar.3 / 2.0;
    let paren_centre = paren.1 + (0.2 - 0.8) / 2.0 * paren.2;
    assert_close(paren_centre, bar_centre, "delimiter centred on the bar");
}

#[test]
fn an_empty_delimiter_is_zero_width() {
    // `\right.` emits `<mo stretchy="true" form="postfix"></mo>`.
    let l = laid(r"\left(x\right.", false);
    assert_eq!(run(&l, "x").0, width_of(SIZE, 1));
    assert!(l.width >= width_of(SIZE, 1));
}

// ---------------------------------------------------------------------------
// Spacing
// ---------------------------------------------------------------------------

#[test]
fn binary_operators_and_relations_get_a_thin_space() {
    let l = laid(r"a+b=c", false);
    let thin = 0.1667 * SIZE;
    let (ax, _, asize) = run(&l, "a");
    let (plus_x, _, _) = run(&l, "+");
    let (bx, _, bsize) = run(&l, "b");
    let (eq_x, _, _) = run(&l, "=");
    let (cx, _, _) = run(&l, "c");

    assert_close(plus_x - (ax + width_of(asize, 1)), thin, "space before +");
    assert_close(bx - (plus_x + width_of(SIZE, 1)), thin, "space after +");
    assert_close(eq_x - (bx + width_of(bsize, 1)), thin, "space before =");
    assert_close(cx - (eq_x + width_of(SIZE, 1)), thin, "space after =");
    assert!(
        ax < plus_x && plus_x < bx && bx < eq_x && eq_x < cx,
        "left to right"
    );
}

#[test]
fn ordinary_atoms_get_no_space() {
    let l = laid(r"f'(x)", false);
    let f = run(&l, "f");
    let prime = run(&l, "′");
    let open = run(&l, "(");
    let x = run(&l, "x");
    // `f'` is an `msup` (latex2mathml folds the prime into a superscript).
    assert!(prime.2 < f.2, "prime is a script");
    assert_close(
        prime.0,
        f.0 + width_of(f.2, 1) + 0.05 * SIZE,
        "script gap after f",
    );
    // `(`, `)` and the group they wrap are all ordinary: no thin space anywhere.
    assert_close(
        open.0,
        prime.0 + width_of(prime.2, 1),
        "no space before a group",
    );
    assert_close(x.0, open.0 + width_of(SIZE, 1), "no space inside the group");
}

#[test]
fn mspace_advances_by_its_em_width() {
    let l = laid(r"x\,y", false);
    let x = run(&l, "x");
    let y = run(&l, "y");
    assert_close(
        y.0 - x.0,
        width_of(x.2, 1) + 0.16666667 * SIZE,
        "thin math space",
    );
}

#[test]
fn negative_mspace_overlaps_without_panicking() {
    // `a\!b` is a *negative* `mspace`; TeX's intent is an overlap.
    let l = laid(r"a\!b", false);
    assert!(run(&l, "b").0 < width_of(SIZE, 1), "b moves back over a");
}

#[test]
fn text_and_function_tokens_are_upright() {
    let text = laid(r"\text{hi}", false);
    let runs = runs(&text);
    assert_eq!(runs.len(), 1);
    assert_close(runs[0].3, SIZE, "mtext keeps the base size");
    assert!(!is_italic(&text, "hi"), "mtext is upright");

    let function = laid(r"\sin x", false);
    assert!(
        !is_italic(&function, "sin"),
        "multi-letter identifiers are upright"
    );
    assert!(is_italic(&function, "x"), "single letters are italic");
    // No space is inserted between a function name and its argument.
    assert_close(
        run(&function, "x").0,
        run(&function, "sin").0 + width_of(SIZE, 3),
        "function argument follows immediately",
    );
}

fn is_italic(l: &MathLayout, text: &str) -> bool {
    l.items.iter().any(|item| match item {
        MathItem::Run { text: t, spec, .. } => t == text && spec.italic,
        MathItem::Rule { .. } => false,
    })
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

#[test]
fn display_limits_stack_and_centre_on_the_base() {
    let l = laid(r"\lim_{x\to\infty}", true);
    let (base_x, base_baseline, base_size) = run(&l, "lim");
    let under: Vec<_> = runs(&l).into_iter().filter(|r| r.2 != "lim").collect();
    assert_eq!(under.len(), 3, "x, →, ∞: {under:?}");
    let left = under.iter().map(|r| r.0).fold(f32::INFINITY, f32::min);
    let right = under
        .iter()
        .map(|r| r.0 + width_of(r.3, r.2.chars().count()))
        .fold(f32::NEG_INFINITY, f32::max);
    let under_centre = (left + right) / 2.0;
    let base_centre = base_x + width_of(base_size, 3) / 2.0;
    assert_close(
        under_centre,
        base_centre,
        "under-content centred on the base",
    );
    for u in &under {
        assert!(
            u.1 > base_baseline + 0.2 * base_size,
            "limit sits below the base"
        );
        assert_close(u.3, SCRIPT, "limits are set in script size");
    }
}

#[test]
fn display_sum_stacks_its_limits_and_text_style_sum_puts_them_beside() {
    let display = laid(r"\sum_{i=1}^{n} i", true);
    let sum = run(&display, "∑");
    let (sup_x, sup_baseline, sup_size) = run(&display, "n");
    // The lower limit is everything painted below the operator's baseline.
    let under: Vec<_> = runs(&display).into_iter().filter(|r| r.1 > sum.1).collect();
    assert_eq!(under.len(), 3, "i, = and 1: {under:?}");
    assert!(sup_baseline < sum.1, "upper limit above the operator");
    assert_close(sup_size, SCRIPT, "upper limit is a script");
    assert_close(
        sup_x + width_of(sup_size, 1) / 2.0,
        sum.0 + width_of(SIZE, 1) / 2.0,
        "upper limit centred on the operator",
    );
    // Both limits are centred on the operator, and the operator on them.
    let under_left = under.iter().map(|r| r.0).fold(f32::INFINITY, f32::min);
    let under_right = under
        .iter()
        .map(|r| r.0 + width_of(r.3, r.2.chars().count()))
        .fold(f32::NEG_INFINITY, f32::max);
    assert_close(
        (under_left + under_right) / 2.0,
        sum.0 + width_of(SIZE, 1) / 2.0,
        "lower limit centred under the operator",
    );

    let inline = laid(r"\sum_{i=1}^{n} i", false);
    let inline_sum = run(&inline, "∑");
    let (inline_n_x, inline_n_baseline, _) = run(&inline, "n");
    assert!(
        inline_n_x > inline_sum.0 + width_of(SIZE, 1),
        "inline limits go to the side"
    );
    assert!(
        inline_n_baseline < inline_sum.1,
        "inline superscript is raised"
    );
}

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

/// Every item of a formula, rounded to 0.01 for readability. Written out from a
/// first run and checked by hand: the x positions increase within each mrow, the
/// scripts are at 0.7 size, and every bar sits between the halves it separates.
fn golden(tex: &str, display: bool) -> (Vec<RunItem>, Vec<RuleItem>) {
    let l = laid(tex, display);
    let round = |v: f32| (v * 100.0).round() / 100.0;
    (
        runs(&l)
            .into_iter()
            .map(|(x, b, t, s)| (round(x), round(b), t, round(s)))
            .collect(),
        rules(&l)
            .into_iter()
            .map(|(x, y, w, h)| (round(x), round(y), round(w), round(h)))
            .collect(),
    )
}

fn assert_runs(actual: &[(f32, f32, String, f32)], expected: &[(f32, f32, &str, f32)]) {
    assert_eq!(actual.len(), expected.len(), "run count: {actual:?}");
    for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert_close(a.0, e.0, &format!("run {i} x"));
        assert_close(a.1, e.1, &format!("run {i} baseline"));
        assert_eq!(a.2, e.2, "run {i} text");
        assert_close(a.3, e.3, &format!("run {i} size"));
    }
}

fn assert_rules(actual: &[RuleItem], expected: &[RuleItem]) {
    assert_eq!(actual.len(), expected.len(), "rule count: {actual:?}");
    for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert_close(a.0, e.0, &format!("rule {i} x"));
        assert_close(a.1, e.1, &format!("rule {i} y"));
        assert_close(a.2, e.2, &format!("rule {i} w"));
        assert_close(a.3, e.3, &format!("rule {i} h"));
    }
}

#[test]
fn golden_single_token() {
    let (r, u) = golden("x", false);
    assert_runs(&r, &[(0.0, 12.8, "x", 16.0)]);
    assert_rules(&u, &[]);
}

#[test]
fn golden_binary_expression() {
    let (r, u) = golden("a+b=c", false);
    assert_runs(
        &r,
        &[
            (0.0, 12.8, "a", 16.0),
            (12.27, 12.8, "+", 16.0),
            (24.53, 12.8, "b", 16.0),
            (36.8, 12.8, "=", 16.0),
            (49.07, 12.8, "c", 16.0),
        ],
    );
    assert_rules(&u, &[]);
}

#[test]
fn golden_inline_fraction() {
    let (r, u) = golden(r"\frac{a}{b}", false);
    assert_runs(&r, &[(0.0, 8.96, "a", 11.2), (0.0, 24.0, "b", 11.2)]);
    assert_rules(&u, &[(0.0, 12.8, 6.72, 0.64)]);
}

#[test]
fn golden_scripts() {
    // `x_i^2` arrives as `msub(x, msup(i, 2))` and is absorbed back into the
    // `msubsup`: base, then both scripts on one left edge — the superscript
    // raised, the subscript dropped.
    let (r, u) = golden(r"x_i^2", false);
    assert_runs(
        &r,
        &[
            (0.0, 16.16, "x", 16.0),
            (10.4, 8.96, "2", 11.2),
            (10.4, 18.56, "i", 11.2),
        ],
    );
    assert_rules(&u, &[]);
}

#[test]
fn golden_scripts_written_in_the_other_order() {
    // `x^2_i` is the mirror image upstream (`msup(x, msub(2, i))`) and has to
    // come out identically.
    let (r, u) = golden(r"x^2_i", false);
    assert_runs(
        &r,
        &[
            (0.0, 16.16, "x", 16.0),
            (10.4, 8.96, "2", 11.2),
            (10.4, 18.56, "i", 11.2),
        ],
    );
    assert_rules(&u, &[]);
}

#[test]
fn golden_radical() {
    let (r, u) = golden(r"\sqrt{x}", false);
    assert_runs(&r, &[(0.0, 13.44, "√", 16.0), (9.6, 13.44, "x", 16.0)]);
    assert_rules(&u, &[(9.6, 0.0, 9.6, 0.64)]);
}

#[test]
fn golden_stretchy_group() {
    let (r, u) = golden(r"\left(\frac{a}{b}\right)", false);
    assert_runs(
        &r,
        &[
            (0.0, 20.99, "(", 26.24),
            (15.74, 8.96, "a", 11.2),
            (15.74, 24.0, "b", 11.2),
            (22.46, 20.99, ")", 26.24),
        ],
    );
    assert_rules(&u, &[(15.74, 12.8, 6.72, 0.64)]);
}

#[test]
fn golden_matrix() {
    let (r, u) = golden(r"\begin{pmatrix}a&b\\c&d\end{pmatrix}", false);
    assert_runs(
        &r,
        &[
            (0.0, 25.6, "(", 32.0),
            (19.2, 12.8, "a", 16.0),
            (44.8, 12.8, "b", 16.0),
            (19.2, 28.8, "c", 16.0),
            (44.8, 28.8, "d", 16.0),
            (54.4, 25.6, ")", 32.0),
        ],
    );
    assert_rules(&u, &[]);
}

#[test]
fn golden_display_sum() {
    let (r, u) = golden(r"\sum_{i=1}^{n} i", true);
    assert_runs(
        &r,
        &[
            (7.15, 23.36, "∑", 16.0),
            (8.59, 8.96, "n", 11.2),
            (0.0, 28.16, "i", 11.2),
            (8.59, 28.16, "=", 11.2),
            (17.17, 28.16, "1", 11.2),
            (23.89, 23.36, "i", 16.0),
        ],
    );
    assert_rules(&u, &[]);
}

#[test]
fn golden_accent() {
    let (r, u) = golden(r"\hat{x}", false);
    // Base first, then the accent 0.1em above its top.
    assert_runs(&r, &[(0.0, 27.2, "x", 16.0), (0.0, 12.8, "^", 16.0)]);
    assert_rules(&u, &[]);
}

#[test]
fn golden_uniform_baseline_for_a_plain_row() {
    let (r, _) = golden(r"\sin x", false);
    assert_runs(&r, &[(0.0, 12.8, "sin", 16.0), (28.8, 12.8, "x", 16.0)]);
}

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

/// A layout that came back has to be finite and internally consistent.
fn assert_sane(tex: &str, display: bool) {
    let Some(l) = layout(tex, display, SIZE, None, &Fake) else {
        return;
    };
    assert!(
        l.width.is_finite() && l.width >= 0.0,
        "{tex:?}: width {}",
        l.width
    );
    assert!(
        l.ascent.is_finite() && l.ascent >= 0.0,
        "{tex:?}: ascent {}",
        l.ascent
    );
    assert!(
        l.descent.is_finite() && l.descent >= 0.0,
        "{tex:?}: descent {}",
        l.descent
    );
    for item in &l.items {
        match item {
            MathItem::Run {
                x, baseline, spec, ..
            } => {
                assert!(x.is_finite() && baseline.is_finite() && spec.size.is_finite());
                assert!(*baseline >= 0.0 && *baseline <= l.ascent + l.descent + 0.01);
            }
            MathItem::Rule { x, y, w, h } => {
                assert!(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite());
                assert!(*w >= 0.0 && *h > 0.0);
            }
        }
    }
}

#[test]
fn empty_and_unparsable_tex_fall_back() {
    assert!(layout("", false, SIZE, None, &Fake).is_none(), "empty TeX");
    assert!(
        layout(r"\frac{", false, SIZE, None, &Fake).is_none(),
        "unbalanced TeX"
    );
    assert!(
        layout(r"\begin{unknown}", false, SIZE, None, &Fake).is_none(),
        "unknown env"
    );
    assert!(
        layout("", true, SIZE, None, &Fake).is_none(),
        "empty TeX, display"
    );
}

#[test]
fn latex2mathml_error_markers_and_broken_tex_fall_back() {
    // Not errors to latex2mathml: a marker embedded in the document, or — for
    // `\begin{align}` — a document that is not even well-formed.
    for tex in [
        r"x_",
        r"\mathcal{L}",
        r"\phantom{x}",
        r"\text{a\,b}",
        r"\displaystyle \sum_{i=1}^n",
        r"\sum\limits_{i=1}^n",
        r"\begin{cases} a & b \end{cases}",
        r"\begin{align} a & b \end{align}",
    ] {
        assert!(layout(tex, false, SIZE, None, &Fake).is_none(), "{tex:?}");
    }
}

#[test]
fn degenerate_base_sizes_fall_back() {
    for size in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert!(
            layout("x", false, size, None, &Fake).is_none(),
            "size {size}"
        );
    }
}

#[test]
fn dollar_signs_are_ordinary_atoms_or_nothing() {
    assert_sane("$$$", false);
}

#[test]
fn a_long_formula_lays_out() {
    let tex = r"\sum_{i=1}^{n} \frac{\sqrt{x_i^2 + y_i^2}}{1 + \left( \alpha_i + \beta_i \right)^2} \le \int_0^1 f(t)\,dt + \text{const}";
    assert!(tex.len() > 100, "the fixture should be long");
    assert_sane(tex, true);
    assert_sane(tex, false);
}

#[test]
fn deeply_nested_formulas_do_not_panic() {
    let mut tex = String::from("x");
    for _ in 0..20 {
        tex = format!(r"\frac{{{tex}}}{{1}}");
        tex = format!(r"\sqrt{{{tex}}}");
    }
    assert_sane(&tex, false);

    // Group nesting, which becomes a chain of `mrow`s.
    let mut grouped = String::from("x");
    for _ in 0..40 {
        grouped = format!("{{{grouped}}}");
    }
    assert_sane(&grouped, false);
}

#[test]
fn unknown_markup_is_rejected_not_laid_out() {
    // Directly through the parser, bypassing the TeX front end.
    assert!(parse_mathml("<math><mi>x</mi><semantics/></math>").is_none());
    let tree = parse_mathml(r#"<math display="inline"><menclose><mi>x</mi></menclose></math>"#);
    assert!(tree.is_none(), "menclose is outside the subset");
}

#[test]
fn width_is_capped_by_max_width() {
    let tex = r"\frac{\sqrt{x_i^2 + y_i^2}}{1 + \left( \alpha_i + \beta_i \right)^2}";
    let natural = laid(tex, false);
    assert!(natural.width > 50.0, "fixture width {}", natural.width);
    for cap in [natural.width * 0.8, natural.width * 0.5, 20.0] {
        let fitted = layout(tex, false, SIZE, Some(cap), &Fake).expect("fitted layout");
        assert!(
            fitted.width <= cap + 0.01,
            "cap {cap}: width {}",
            fitted.width
        );
        // Everything shrank together: the same items, all at a smaller size.
        // Everything scaled together: the ratio between the fitted and the
        // natural sizes is the width ratio.
        let scale = fitted.width / natural.width;
        let natural_run = runs(&natural)[0].3;
        let fitted_run = runs(&fitted)[0].3;
        assert!(fitted_run < natural_run, "cap {cap} shrinks the glyphs");
        assert_close(
            fitted_run,
            natural_run * scale,
            &format!("cap {cap}: size {fitted_run} vs scale {scale}"),
        );
    }
}

// ---------------------------------------------------------------------------
// Performance sanity
// ---------------------------------------------------------------------------

#[test]
fn a_long_formula_lays_out_quickly() {
    // No timing assertion (that belongs to a benchmarking harness); this only
    // fails if the pipeline stops terminating on a realistic input.
    let mut tex = String::new();
    for i in 0..20 {
        tex.push_str(&format!(
            r"\frac{{x_{{{i}}}^2}}{{\sqrt{{y_{{{i}}}^2 + 1}}}} + "
        ));
    }
    tex.push('z');
    assert!(tex.len() > 200, "fixture length {}", tex.len());
    let l = laid(&tex, false);
    assert!(l.items.len() > 100, "{} items", l.items.len());
    assert!(l.width > 0.0);
}

#[test]
fn mstyle_displaystyle_reaches_the_fraction_rule() {
    // `\dbinom` is the one construct that emits `<mstyle displaystyle="true">`:
    // it forces display style, so the halves are full size even inline.
    let display = laid(r"\dbinom{a}{b}", false);
    assert_close(
        run(&display, "a").2,
        SIZE,
        "displaystyle=true sets full size",
    );
    assert!(rules(&display).is_empty(), "a binomial has no bar");

    let text = laid(r"\tbinom{a}{b}", false);
    assert_close(
        run(&text, "a").2,
        SCRIPT,
        "displaystyle=false sets script size",
    );
}

// ---------------------------------------------------------------------------
// Normalization: what the rewrite pass buys
// ---------------------------------------------------------------------------

/// `(x, baseline, text, size)` and every rule of two formulas, compared.
#[track_caller]
fn assert_same_layout(tex: &str, same_as: &str) {
    let (a, b) = (laid(tex, false), laid(same_as, false));
    assert_close(a.width, b.width, "width");
    assert_close(a.ascent, b.ascent, "ascent");
    assert_close(a.descent, b.descent, "descent");
    assert_eq!(
        runs(&a),
        runs(&b),
        "{tex:?} should lay out like {same_as:?}"
    );
    assert_eq!(
        rules(&a),
        rules(&b),
        "{tex:?} rules should match {same_as:?}"
    );
}

#[test]
fn msubsup_puts_the_subscript_below_and_the_superscript_above() {
    // The two limits of `\int_0^1` are not interchangeable: MathML's child
    // order is base, sub, sup, and getting it backwards renders the formula
    // upside down.
    let l = laid(r"\int_0^1 f", false);
    let (_, base_baseline, _) = run(&l, "∫");
    let (_, sub_baseline, sub_size) = run(&l, "0");
    let (_, sup_baseline, sup_size) = run(&l, "1");
    assert!(sub_baseline > base_baseline, "0 is the subscript");
    assert!(sup_baseline < base_baseline, "1 is the superscript");
    assert_close(sub_size, SCRIPT, "limits are scripts");
    assert_close(sup_size, SCRIPT, "limits are scripts");
}

#[test]
fn flattened_scripts_are_rebuilt_in_source_order() {
    // `x_i^2` (msub holding an msup) and `x^2_i` (the mirror) both become one
    // msubsup: i below, 2 above, in either spelling.
    assert_same_layout(r"x_i^2", r"x^2_i");
    // `{x_i}^2` is the explicit way to ask for the *other* reading (the
    // superscript on the whole `x_i`), and keeps its own, wider layout.
    assert!(laid(r"{x_i}^2", false).width > laid(r"x_i^2", false).width);
    let a = laid(r"x_i^2", false);
    let (_, base_baseline, _) = run(&a, "x");
    assert!(run(&a, "i").1 > base_baseline, "i is the subscript");
    assert!(run(&a, "2").1 < base_baseline, "2 is the superscript");
}

#[test]
fn a_repeated_script_is_not_mistaken_for_a_flattened_pair() {
    // `x_{i_j}` is a genuine nesting: `x` with the subscript `i_j`.
    let l = laid(r"x_{i_j}", false);
    assert_eq!(l.items.len(), 3);
    let (_, i_baseline, _) = run(&l, "i");
    let (_, j_baseline, _) = run(&l, "j");
    assert!(j_baseline > i_baseline, "j is below i");
    assert!(i_baseline > run(&l, "x").1, "i is below x");
}

#[test]
fn rewrites_render_like_the_spelling_they_stand_in_for() {
    assert_same_layout(r"1 \le 2", r"1 \leq 2");
    assert_same_layout(r"1 \ge 2", r"1 \geq 2");
    assert_same_layout(r"\neg p", r"\lnot p");
    assert_same_layout(r"x \dots y", r"x \ldots y");
    assert_same_layout(r"\varnothing", r"\emptyset");
    assert_same_layout(r"\gcd(a,b)", r"\operatorname{gcd}(a,b)");
    assert_same_layout(r"\lvert x \rvert", r"|x|");
    assert_same_layout(r"\lVert x \rVert", r"\|x\|");
    assert_same_layout(r"\lbrace x \rbrace", r"\{x\}");
    assert_same_layout(r"\dfrac{a}{b}", r"\frac{a}{b}");
    assert_same_layout(r"\tfrac{a}{b}", r"\frac{a}{b}");
    assert_same_layout(r"\mbox{hi}", r"\text{hi}");
    assert_same_layout(r"a \space b", r"a \; b");
    // The whole point of the `\big` family: a formula that used to fall back to
    // the raw source now renders, with the delimiters sized to the content.
    assert_same_layout(r"\bigl(\frac{a}{b}\bigr)", r"\left(\frac{a}{b}\right)");
    assert_same_layout(r"\Bigl[\frac{a}{b}\Bigr]", r"\left[\frac{a}{b}\right]");
    assert_same_layout(r"\big(x\big)", r"(x)");
}

#[test]
fn substituted_symbols_space_like_the_operators_they_are() {
    // Both arrive as an upright `mi` (a literal codepoint); they still take the
    // relation's thin space, exactly like the `mo` an `\in` would emit.
    let ni = laid(r"a \ni b", false);
    let in_ = laid(r"a \in b", false);
    let thin = 0.1667 * SIZE;
    assert_close(
        run(&ni, "\u{220b}").0 - (run(&ni, "a").0 + width_of(SIZE, 1)),
        thin,
        "space before the substituted relation",
    );
    assert_close(run(&ni, "b").0, run(&in_, "b").0, "same advance as \\in");
    assert_close(
        run(&ni, "\u{220b}").0,
        run(&in_, "∈").0,
        "same position as \\in",
    );

    // `\ast` is a binary operator, and the literal keeps its class too.
    let ast = laid(r"a \ast b", false);
    assert_close(
        run(&ast, "\u{2217}").0 - (run(&ast, "a").0 + width_of(SIZE, 1)),
        thin,
        "space before the substituted binary",
    );
}

#[test]
fn a_normalized_formula_is_a_real_layout() {
    // The end-to-end claim: a note containing these renders boxes instead of
    // falling back to the source line.
    let tex = r"\gcd(a,b) \le \dfrac{a+b}{2} \quad \bigl[ x \ni y \bigr] \quad \mbox{for all}";
    let l = laid(tex, false);
    assert!(l.width > 150.0, "width {}", l.width);
    assert!(
        runs(&l).iter().any(|r| r.2 == "gcd"),
        "the operator renders"
    );
    assert!(runs(&l).iter().any(|r| r.2 == "≤"), "the relation renders");
    assert!(!rules(&l).is_empty(), "the fraction has a bar");
    // The text box renders with its space intact (as U+00A0: the emitter drops
    // ASCII spaces inside `\text{}`).
    assert!(
        runs(&l).iter().any(|r| r.2 == "for\u{a0}all"),
        "the text box renders: {:?}",
        runs(&l)
    );
}
