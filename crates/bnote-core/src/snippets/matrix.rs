//! Port of `src/editor/snippets/matrix.ts` — matrix environment shortcuts.
//!
//! latex-suite's `matrixShortcuts`: **Shift+Tab** inserts ` & ` (align the next
//! column), Enter inserts ` \\` (row break; Shift+Enter only moves the cursor
//! to the next line's end). Only block math participates, and the environment
//! is recognised by its `\begin{name}`/`\end{name}` pair with the names from
//! the settings.
//!
//! The separator deliberately hangs off **Shift+Tab**: in the plugin ordinary
//! Tab is left to tabout, so `&` can only be typed with Shift+Tab. Keep that
//! split — otherwise Tab inside a matrix could never reach the tabout layer.

use crate::markdown::context::EditContext;
use crate::markdown::math_scan::MathRegion;

use super::brackets::within_env;
use super::config::LatexConfig;
use super::{
    Range, Replace, is_js_ws_char, line_count, line_end, line_from_number, line_number, line_start,
};

/// Matrix row separator: space + LaTeX `\\` + newline. The `iden` snippet
/// shares this constant — one place owns the escaping layer count.
pub const MATRIX_ROW_BREAK: &str = " \\\\\n";

/// Matrix env name at `pos`; `None` when not inside one (or not in block math).
/// `ctx` must be the context at `pos` (see the module contract in `snippets`).
pub fn matrix_env_at(
    doc: &str,
    pos: usize,
    ctx: &EditContext,
    math: &[MathRegion],
    config: &LatexConfig,
) -> Option<String> {
    if !ctx.block_math {
        return None;
    }
    let region = math.iter().find(|r| pos >= r.from && pos <= r.to)?;
    let content = &doc[region.from..region.to];
    let rel = pos - region.from;
    for env in &config.matrix_envs {
        if within_env(
            content,
            rel,
            &format!("\\begin{{{}}}", env),
            &format!("\\end{{{}}}", env),
        ) {
            return Some(env.clone());
        }
    }
    None
}

/// Matrix column separator: replace the selection with ` & `. `None` outside a
/// matrix environment (the caller falls through).
pub fn matrix_separator(
    doc: &str,
    selection: Range,
    ctx: &EditContext,
    math: &[MathRegion],
    config: &LatexConfig,
) -> Option<Replace> {
    if !config.matrix_shortcuts {
        return None;
    }
    matrix_env_at(doc, selection.from, ctx, math, config)?;
    Some(Replace::new(selection.from, selection.to, " & "))
}

/// The result of an Enter inside a matrix: the document edits plus the cursor
/// position in the post-edit document (Shift+Enter has no edits).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatrixEnter {
    pub changes: Vec<Replace>,
    pub cursor: usize,
}

/// Port of `src/editor/snippets/matrix.ts::matrixEnter`.
pub fn matrix_enter(
    doc: &str,
    selection: Range,
    shift: bool,
    ctx: &EditContext,
    math: &[MathRegion],
    config: &LatexConfig,
) -> Option<MatrixEnter> {
    if !config.matrix_shortcuts {
        return None;
    }
    let env = matrix_env_at(doc, selection.from, ctx, math, config)?;
    if shift {
        // Shift+Enter: move to the next line's end without touching the document.
        let n = line_number(doc, selection.to);
        if n >= line_count(doc) {
            return None;
        }
        let next_from = line_from_number(doc, n + 1);
        return Some(MatrixEnter { changes: vec![], cursor: line_end(doc, next_from) });
    }
    // align is an alignment environment, not a data table: a ` \\` row break
    // would keep the equal signs misaligned (the `&` is placed by hand).
    // alignEnter only takes over lines it can complete; the rest fall back to
    // the host's default newline.
    if env == "align" {
        return align_enter(doc, selection);
    }
    let replace = Replace::new(selection.from, selection.to, MATRIX_ROW_BREAK);
    let cursor = replace.from + replace.insert.len();
    Some(MatrixEnter { changes: vec![replace], cursor })
}

/// Pure decision of the align continuation (exported for the gates): the text
/// before the cursor → the replacement for that half-line (with ` \\` and the
/// newline), `None` = do not take over (cursor at line start, a
/// `\begin`/`\end` line, or a half-line already ending in `\\`).
///
/// Two completions mimic a hand-written align (`a &= b \\`):
/// * no `&` in the half-line: insert `&` before the first bare relation
///   operator (`=` / `<=` / `>=`); an existing `&` is respected;
/// * append ` \\` (the LaTeX row separator) to the half-line.
///
/// The cursor is the split point (same semantics as a plain newline): the text
/// after the cursor becomes the new line, so `\end{align}` is never swallowed.
pub fn align_enter_plan(head_text: &str) -> Option<String> {
    if head_text.trim_matches(is_js_ws_char).is_empty() {
        return None;
    }
    if head_text.trim_start_matches(is_js_ws_char).starts_with("\\begin{")
        || head_text.trim_start_matches(is_js_ws_char).starts_with("\\end{")
    {
        return None;
    }
    if trim_end_js(head_text).ends_with("\\\\") {
        return None;
    }
    let mut out = head_text.to_string();
    if !out.contains('&') {
        if let Some(at) = first_relation_operator(&out) {
            out.insert(at, '&');
        }
    }
    // The row separator is shared with the matrix path (`MATRIX_ROW_BREAK`).
    Some(format!("{}{}", out, MATRIX_ROW_BREAK))
}

fn trim_end_js(s: &str) -> &str {
    s.trim_end_matches(is_js_ws_char)
}

/// TS `/(^|[^\\])([<>]?=)/`: leftmost `=` not preceded by a backslash; the
/// operator starts at the `<`/`>` when one is directly in front of it.
fn first_relation_operator(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let is_op = |at: usize| -> bool {
        match b.get(at) {
            Some(b'=') => true,
            Some(b'<') | Some(b'>') => b.get(at + 1) == Some(&b'='),
            _ => false,
        }
    };
    for at in 0..b.len() {
        if at > 0 && b[at - 1] == b'\\' {
            continue;
        }
        if is_op(at) {
            return Some(at);
        }
    }
    None
}

/// align environment Enter (empty selection): completes the half-line before
/// the cursor and breaks the line, cursor at the new line's start. Only called
/// by [`matrix_enter`] after the align environment was recognised.
fn align_enter(doc: &str, selection: Range) -> Option<MatrixEnter> {
    if !selection.is_empty() {
        return None;
    }
    let line_from = line_start(doc, selection.from);
    let head_text = &doc[line_from..selection.from];
    let plan = align_enter_plan(head_text)?;
    let replace = Replace::new(line_from, selection.from, plan.clone());
    Some(MatrixEnter { changes: vec![replace], cursor: line_from + plan.len() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::context::context_at_scan;
    use crate::markdown::math_scan::scan_math;
    use crate::snippets::config::LatexConfig;
    use crate::snippets::{apply_replaces, line_from_number};

    const BLOCK: &str = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";

    fn enter(doc: &str, cursor: usize, shift: bool) -> Option<MatrixEnter> {
        let math = scan_math(doc);
        let ctx = context_at_scan(doc, cursor, &math);
        matrix_enter(doc, Range::caret(cursor), shift, &ctx, &math, &LatexConfig::default())
    }

    fn env_at(doc: &str, pos: usize) -> Option<String> {
        let math = scan_math(doc);
        let ctx = context_at_scan(doc, pos, &math);
        matrix_env_at(doc, pos, &ctx, &math, &LatexConfig::default())
    }

    /// `矩阵环境判定与快捷`.
    #[test]
    fn recognizes_a_matrix_env_in_block_math() {
        let pos = BLOCK.find("Q & b").unwrap() + 1;
        assert_eq!(env_at(BLOCK, pos).as_deref(), Some("pmatrix"));
    }

    #[test]
    fn cases_align_bmatrix_array_are_all_configured() {
        for env in ["cases", "align", "bmatrix", "array"] {
            // Use Q as the cursor marker: env names can contain x/a (bmatrix,
            // matrix) and would put the cursor inside the environment name.
            let doc = format!("$$\n\\begin{{{env}}}\nQ\n\\end{{{env}}}\n$$");
            let pos = doc.find('Q').unwrap() + 1;
            assert_eq!(env_at(&doc, pos).as_deref(), Some(env), "env {env}");
        }
    }

    #[test]
    fn outside_the_env_is_none() {
        let doc = "$$\na & b\n$$";
        assert!(env_at(doc, doc.find('&').unwrap()).is_none());
    }

    #[test]
    fn inline_math_does_not_trigger() {
        let doc = "$\\begin{pmatrix}a\\end{pmatrix}$";
        assert!(env_at(doc, doc.find('a').unwrap()).is_none());
    }

    #[test]
    fn separator_lives_on_shift_tab_and_replaces_the_selection() {
        let pos = BLOCK.find('Q').unwrap();
        let math = scan_math(BLOCK);
        let ctx = context_at_scan(BLOCK, pos, &math);
        let r = matrix_separator(BLOCK, Range::caret(pos), &ctx, &math, &LatexConfig::default())
            .expect("inside a matrix");
        assert_eq!(apply_replaces(BLOCK, &[r]), BLOCK.replace('Q', " & Q"));

        let doc = "$$x$$";
        let math = scan_math(doc);
        let ctx = context_at_scan(doc, 2, &math);
        assert!(matrix_separator(doc, Range::caret(2), &ctx, &math, &LatexConfig::default()).is_none());
    }

    #[test]
    fn enter_inserts_a_two_backslash_row_break() {
        // The separator is exactly [' ', '\\', '\\', '\n'].
        assert_eq!(MATRIX_ROW_BREAK.chars().collect::<Vec<_>>(), vec![' ', '\\', '\\', '\n']);
        let pos = BLOCK.find('Q').unwrap();
        let plan = enter(BLOCK, pos, false).unwrap();
        assert_eq!(
            apply_replaces(BLOCK, &plan.changes),
            "$$\n\\begin{pmatrix}\n \\\\\nQ & b\n\\end{pmatrix}\n$$"
        );
    }

    #[test]
    fn shift_enter_only_moves_the_cursor_to_the_next_line_end() {
        let pos = BLOCK.find('Q').unwrap();
        let plan = enter(BLOCK, pos, true).unwrap();
        assert!(plan.changes.is_empty());
        // The cursor was on line 3 (`Q & b`); Shift+Enter puts it at the end of
        // line 4 (the `\end{pmatrix}` line).
        assert_eq!(plan.cursor, line_end(BLOCK, line_from_number(BLOCK, 4)));
        let doc = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";
        assert_eq!(line_number(doc, plan.cursor), 4);
    }

    #[test]
    fn shortcuts_off_means_no_separator_and_no_enter() {
        let mut config = LatexConfig::default();
        config.matrix_shortcuts = false;
        let pos = BLOCK.find('Q').unwrap();
        let math = scan_math(BLOCK);
        let ctx = context_at_scan(BLOCK, pos, &math);
        assert!(matrix_separator(BLOCK, Range::caret(pos), &ctx, &math, &config).is_none());
        assert!(matrix_enter(BLOCK, Range::caret(pos), false, &ctx, &math, &config).is_none());
    }

    /// `align 续行:Enter 补关系符 & 与行尾 \\`.
    #[test]
    fn align_plan_inserts_align_point_and_row_break() {
        assert_eq!(align_enter_plan("c=d").as_deref(), Some("c&=d \\\\\n"));
        assert_eq!(align_enter_plan("a = b").as_deref(), Some("a &= b \\\\\n"));
        // `<=`/`>=`: the align point sits before the relation operator.
        assert_eq!(align_enter_plan("a <= b").as_deref(), Some("a &<= b \\\\\n"));
        assert_eq!(align_enter_plan("x >= y").as_deref(), Some("x &>= y \\\\\n"));
        // No relation operator: only the row break is appended.
        assert_eq!(align_enter_plan("\\alpha").as_deref(), Some("\\alpha \\\\\n"));
        // An existing `&` is the user's own align point.
        assert_eq!(align_enter_plan("a &= b").as_deref(), Some("a &= b \\\\\n"));
        // An escaped relation operator (`\=`) is not an align point.
        assert_eq!(align_enter_plan("a \\=b").as_deref(), Some("a \\=b \\\\\n"));
    }

    #[test]
    fn align_plan_declines_empty_begin_end_and_row_break_lines() {
        assert!(align_enter_plan("").is_none());
        assert!(align_enter_plan("   ").is_none());
        assert!(align_enter_plan("\\begin{align}").is_none());
        assert!(align_enter_plan("\\end{align}").is_none());
        assert!(align_enter_plan("a &= b \\\\").is_none());
        assert!(align_enter_plan("a &= b\\\\ ").is_none());
    }

    const ALIGN: &str = "$$\n\\begin{align}\nLINE\n\\end{align}\n$$";

    /// Enter completes the half-line before the cursor; the cursor lands on the
    /// new (empty) line and the tail moves down naturally.
    #[test]
    fn align_enter_breaks_the_line_at_the_cursor() {
        let doc = ALIGN.replace("LINE", "c=d");
        let at = line_from_number(&doc, 3) + 3;
        let plan = enter(&doc, at, false).unwrap();
        let out = apply_replaces(&doc, &plan.changes);
        assert_eq!(out, ALIGN.replace("LINE", "c&=d \\\\\n"));
        assert_eq!(plan.cursor, line_from_number(&out, 4));
        assert_eq!(line_end(&out, plan.cursor), plan.cursor); // the new line is empty

        // Cursor in the middle (no relation operator before the split): the
        // first half only gets the row break, the tail becomes the new line.
        let at = line_from_number(&doc, 3) + 1;
        let plan = enter(&doc, at, false).unwrap();
        let out = apply_replaces(&doc, &plan.changes);
        let lines: Vec<&str> = out.split('\n').collect();
        assert_eq!(lines[2], "c \\\\");
        assert_eq!(lines[3], "=d");
    }

    #[test]
    fn align_enter_declines_lines_it_cannot_complete() {
        for line in ["", "a &= b \\\\", "\\end{align}"] {
            let doc = ALIGN.replace("LINE", line);
            let at = line_from_number(&doc, 3) + line.len();
            assert!(enter(&doc, at, false).is_none(), "line {line:?}");
        }
        // Cursor at the line start (empty head half) is not taken over either.
        let doc = ALIGN.replace("LINE", "c=d");
        assert!(enter(&doc, line_from_number(&doc, 3), false).is_none());
    }

    #[test]
    fn pmatrix_still_gets_the_row_break() {
        let doc = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";
        let pos = doc.find('Q').unwrap();
        let plan = enter(doc, pos, false).unwrap();
        assert_eq!(
            apply_replaces(doc, &plan.changes),
            "$$\n\\begin{pmatrix}\n \\\\\nQ & b\n\\end{pmatrix}\n$$"
        );
    }
}
