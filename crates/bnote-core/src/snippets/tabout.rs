//! Port of `src/editor/snippets/tabout.ts` — the last Tab layer: carry the
//! cursor out of brackets / math blocks.
//!
//! 1. Only inside math (inline/block); plain-text Tab stays an indent.
//! 2. From the cursor, scan forward to the **end of the formula content**
//!    (excluding the closing delimiter); crossing one of `} ) ] > | $` moves
//!    the cursor one step past it — nested brackets leave one layer per Tab.
//! 3. Scanning to the content end with only whitespace left means the cursor
//!    already sits on the formula's tail: an inline formula lands after its
//!    closing `$`; a block formula lands on the line after the closing `$$`
//!    and the cursor's old line gets its trailing whitespace trimmed. If the
//!    closing `$$` is the last line, a newline is inserted first.
//!
//! Three deliberate differences from the plugin, all covered by tests: the
//! trim is `trimEnd` only (the plugin's `trim()` would eat a list item's
//! indentation, which is markdown structure); the landing point is mapped
//! through the trim instead of using a stale coordinate; `codeMath` (formulas
//! in ```math fences) does not participate — bnote has no
//! `forceMathLanguages`, so fenced math never enters the math regions.

use crate::markdown::context::EditContext;
use crate::markdown::math_scan::MathRegion;

use super::{
    Replace, is_js_ws_char, line_count, line_end, line_from_number, line_number, line_start,
    trim_end_js_ws,
};

/// Characters the forward scan steps over.
const TARGET_CHARS: &str = "})]>|$";

/// The plugin special-cases `\rangle` (it does not end in a single scan char).
const RIGHT_ANGLE: &str = "\\rangle";

/// What the host must do: apply `changes`, then put the cursor at `pos`
/// (post-edit coordinates).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaboutPlan {
    pub pos: usize,
    pub changes: Vec<Replace>,
}

/// Content end of a region (excluding the closing delimiter): `$$` is two
/// characters, `$` one.
fn content_end(region: &MathRegion) -> usize {
    if region.display { region.to.saturating_sub(2) } else { region.to.saturating_sub(1) }
}

/// Content start of a region (excluding the opening delimiter).
fn content_start(region: &MathRegion) -> usize {
    if region.display { region.from + 2 } else { region.from + 1 }
}

/// Pure decision: whether to step out, where to, and what to change; `None`
/// when there is nowhere to step out to. `ctx` must be the context at `pos`.
pub fn plan_tabout(
    doc: &str,
    pos: usize,
    ctx: &EditContext,
    math: &[MathRegion],
) -> Option<TaboutPlan> {
    if !ctx.inline_math && !ctx.block_math {
        return None;
    }
    let region = math.iter().find(|r| pos >= r.from && pos <= r.to)?;
    let end = content_end(region);
    // The cursor sits on a delimiter (the `$`s at the formula's head/tail):
    // not a tabout position.
    if pos > end || pos < content_start(region) {
        return None;
    }

    // Only the slice from the cursor to the content end: Tab is a hot key, do
    // not pull the whole document into a string for one scan.
    let seg = &doc[pos..end];
    for (i, ch) in seg.char_indices() {
        if TARGET_CHARS.contains(ch) {
            return Some(TaboutPlan { pos: pos + i + 1, changes: Vec::new() });
        }
        if seg[i..].starts_with(RIGHT_ANGLE) {
            return Some(TaboutPlan { pos: pos + i + RIGHT_ANGLE.len(), changes: Vec::new() });
        }
    }

    // Only whitespace between the cursor and the content end: leave the whole
    // formula.
    if !seg.trim_matches(is_js_ws_char).is_empty() {
        return None;
    }
    if !region.display {
        return Some(TaboutPlan { pos: region.to, changes: Vec::new() });
    }
    Some(block_exit(doc, pos, end))
}

/// Whole-formula exit for a block: land on the line after the closing `$$`,
/// trimming the cursor line's trailing whitespace on the way.
fn block_exit(doc: &str, pos: usize, end: usize) -> TaboutPlan {
    let mut changes: Vec<Replace> = Vec::new();
    let closing_line = line_number(doc, end);
    let mut target;
    if closing_line == line_count(doc) {
        // The closing `$$` is the last line: add a newline so there is a next
        // line to land on.
        target = doc.len() + 1;
        changes.push(Replace::insert_at(doc.len(), "\n"));
    } else {
        target = line_from_number(doc, closing_line + 1);
    }

    let line_from = line_start(doc, pos);
    let line_to = line_end(doc, pos);
    let line_text = &doc[line_from..line_to];
    let trimmed = trim_end_js_ws(line_text);
    if trimmed != line_text {
        // The trailing whitespace is removed before the landing point, so the
        // landing point moves left with it (the plugin lands on the stale
        // coordinate and drifts by the trimmed length).
        if line_to <= target {
            target = target + trimmed.len() - line_text.len();
        }
        changes.push(Replace::new(line_from, line_to, trimmed));
    }
    TaboutPlan { pos: target, changes }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::context::context_at_scan;
    use crate::markdown::math_scan::scan_math;

    /// tabout.test.ts `at(doc, cursor)`.
    fn at(doc: &str, pos: usize) -> Option<TaboutPlan> {
        let math = scan_math(doc);
        let ctx = context_at_scan(doc, pos, &math);
        plan_tabout(doc, pos, &ctx, &math)
    }

    fn empty(pos: usize) -> Option<TaboutPlan> {
        Some(TaboutPlan { pos, changes: Vec::new() })
    }

    /// `planTabout:向后扫到一个闭合符就跨过去(一次一层)`.
    #[test]
    fn steps_over_the_closing_paren_of_right() {
        let doc = "$\\left( x \\right)$";
        let closers = doc.find(')').unwrap();
        assert_eq!(at(doc, doc.find("\\right)").unwrap()), empty(closers + 1));
    }

    #[test]
    fn one_layer_per_tab_through_nested_brackets() {
        // The cursor is after the `x` of \frac{a}{x}: `}` → `)` → closing `$`.
        let doc = "$\\frac{a}{x}(y)$";
        let step1 = at(doc, doc.find('x').unwrap() + 1).unwrap();
        assert_eq!(step1.pos, doc.find("}(y)").unwrap() + 1); // the denominator's `}`
        let step2 = at(doc, step1.pos).unwrap();
        assert_eq!(step2.pos, doc.find(')').unwrap() + 1); // the `(y)` paren
        let step3 = at(doc, step2.pos).unwrap();
        assert_eq!(step3.pos, doc.len()); // past the closing `$`, outside the formula
        assert_eq!(at(doc, step3.pos), None); // already outside: Tab is not taken over
    }

    #[test]
    fn right_angle_steps_over_as_a_whole() {
        let doc = "$\\langle x \\rangle$";
        let pos = doc.find("\\rangle").unwrap();
        assert_eq!(at(doc, pos), empty(pos + "\\rangle".len()));
    }

    #[test]
    fn pipe_and_greater_than_are_in_the_scan_table() {
        assert_eq!(at("$a|b$", 1), empty(3));
        assert_eq!(at("$a>b$", 1), empty(3));
    }

    #[test]
    fn characters_after_the_cursor_are_not_stepped_over() {
        let doc = "$a)b$";
        assert_eq!(at(doc, 3), None); // the `)` is BEFORE the cursor
    }

    #[test]
    fn plain_text_is_left_alone() {
        assert_eq!(at("普通文本(说明)", 2), None);
        let doc = "正文\n\n$(x)$";
        assert_eq!(at(doc, doc.find("正文").unwrap()), None);
    }

    #[test]
    fn delimiters_are_not_tabout_positions() {
        let inline = "$(x)$";
        assert_eq!(at(inline, 0), None);
        assert_eq!(at(inline, inline.len()), None);
        let block = "$$\n(x)\n$$";
        assert_eq!(at(block, 1), None);
        assert_eq!(at(block, block.len() - 1), None);
    }

    /// `planTabout:公式尾巴上的整块跳出`.
    #[test]
    fn inline_tail_lands_after_the_closing_dollar() {
        let doc = "$x$";
        assert_eq!(at(doc, 2), empty(doc.len()));
    }

    #[test]
    fn a_trailing_space_inline_is_not_a_formula_at_all() {
        assert_eq!(at("$x $", 2), None);
    }

    #[test]
    fn block_tail_lands_on_the_next_line_and_trims_the_cursor_line() {
        let doc = "$$\nE[q]   \n$$\n下一段";
        let plan = at(doc, doc.find("E[q]").unwrap() + 4).unwrap();
        assert_eq!(
            plan.changes,
            vec![Replace::new(doc.find("E[q]").unwrap(), doc.find("E[q]").unwrap() + 7, "E[q]")]
        );
        assert_eq!(plan.pos, 11);
        let preview = format!(
            "{}{}",
            &doc[..doc.find("E[q]").unwrap() + 4].trim_end(),
            &doc[doc.find("E[q]").unwrap() + 7..]
        );
        assert_eq!(&preview[plan.pos..], "下一段");
    }

    #[test]
    fn block_tail_keeps_the_indentation_of_a_list_item() {
        let doc = "$$\n  E[q]  \n$$\n下一段";
        let plan = at(doc, doc.find("E[q]").unwrap() + 4).unwrap();
        assert_eq!(
            plan.changes,
            vec![Replace::new(
                doc.find("E[q]").unwrap() - 2,
                doc.find("E[q]").unwrap() + 6,
                "  E[q]"
            )]
        );
        assert_eq!(plan.pos, doc.find("下一段").unwrap() - 2);
    }

    #[test]
    fn closing_dollar_on_the_last_line_gets_a_newline_first() {
        let doc = "$$\nx\n$$";
        let plan = at(doc, doc.find('x').unwrap() + 1).unwrap();
        assert_eq!(plan.changes, vec![Replace::insert_at(doc.len(), "\n")]);
        assert_eq!(plan.pos, doc.len() + 1);
    }

    #[test]
    fn content_after_the_cursor_blocks_the_whole_formula_exit() {
        assert_eq!(at("$$\nx\ny\n$$", 4), None);
    }
}
