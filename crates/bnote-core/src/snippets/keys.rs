//! Port of the key-decision layer of `src/editor/snippets/extension.ts`
//! (`runTab`, `runShiftTab`, `tryAutoExpand`, `escapeForSnippet`, the Backspace
//! pair, `closeBracketSkip`) plus the `matrixEnter` binding from `matrix.ts`.
//!
//! # Contract
//!
//! * [`KeyAction::Pass`] — the key is not handled; the host applies its own
//!   default edit and must then remap the session stack with
//!   [`SessionStack::apply_edit`].
//! * [`KeyAction::Apply`] — the key is handled. `changes` are document edits in
//!   pre-edit coordinates (apply them atomically, like a CodeMirror
//!   transaction), `selection` is the cursor/selection in the post-edit
//!   document (`None` = leave the cursor alone). The session stack has already
//!   been updated for those changes.
//! * An expansion is followed by **auto-enlarge** as its own transaction (the
//!   TS `startSessionAt` → `autoEnlargeBrackets` pair): after applying an
//!   expansion, call [`enlarge_after_expansion`] with the new document, the new
//!   cursor and the inserted text.

use crate::markdown::context::EditContext;
use crate::markdown::math_scan::MathRegion;

use super::autofraction::auto_fraction;
use super::config::LatexConfig;
use super::enlarge::auto_enlarge_edits;
use super::engine::{Expansion, MatchOptions, SnippetStore};
use super::matrix::matrix_enter;
use super::replacement::ParsedReplacement;
use super::session::{Session, SessionStack, TabPlan};
use super::tabout::plan_tabout;
use super::{Range, Replace, char_at, line_start, prev_char};

/// What the host must do with a key press. See the module contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    /// Not handled — fall through to the host's default behaviour.
    Pass,
    /// Handled: apply `changes`, then put the cursor/selection at `selection`.
    Apply { changes: Vec<Replace>, selection: Option<Range> },
}

impl KeyAction {
    /// Handled, cursor only.
    pub fn cursor(range: Range) -> Self {
        KeyAction::Apply { changes: Vec::new(), selection: Some(range) }
    }

    /// Handled, no document change and no cursor movement (the key is consumed).
    pub fn consumed() -> Self {
        KeyAction::Apply { changes: Vec::new(), selection: None }
    }

    pub fn is_pass(&self) -> bool {
        matches!(self, KeyAction::Pass)
    }
}

/// Port of the TS `runTab` — the three-layer decision, in the plugin's
/// `handleKeydown` order: session tabstops → expansion → tabout.
pub fn tab(
    store: &SnippetStore,
    stack: &mut SessionStack,
    doc: &str,
    selection: Range,
    ctx: &EditContext,
    math: &[MathRegion],
    config: &LatexConfig,
) -> KeyAction {
    if !stack.is_empty() {
        return match stack.plan_tab() {
            Some(TabPlan::Select { level, index }) => match stack.select(level, index) {
                Some(range) => KeyAction::cursor(range),
                None => KeyAction::consumed(),
            },
            Some(TabPlan::End) => {
                // The landing point is clamped inside math regions (a whole-block
                // snippet must not throw the cursor out of its formula).
                let target = stack.exit_cursor(selection.to, math);
                stack.clear();
                KeyAction::Apply { changes: Vec::new(), selection: target.map(Range::caret) }
            }
            None => KeyAction::consumed(),
        };
    }
    let expand = expand_on_tab(store, stack, doc, selection, ctx, config);
    if !expand.is_pass() {
        return expand;
    }
    tabout(stack, doc, selection.to, ctx, math, config)
}

/// Port of the TS `runShiftTab`: previous tabstop → matrix ` & ` → tabout.
/// (In the plugin the matrix separator only hangs off Shift — ordinary Tab is
/// left to tabout.)
pub fn shift_tab(
    stack: &mut SessionStack,
    doc: &str,
    selection: Range,
    ctx: &EditContext,
    math: &[MathRegion],
    config: &LatexConfig,
) -> KeyAction {
    if !stack.is_empty() {
        return match stack.previous() {
            super::session::PreviousAction::Select(range) => KeyAction::cursor(range),
            super::session::PreviousAction::Popped => KeyAction::consumed(),
            super::session::PreviousAction::NoSession => KeyAction::consumed(),
        };
    }
    if let Some(replace) = super::matrix::matrix_separator(doc, selection, ctx, math, config) {
        let cursor = replace.from + replace.insert.len();
        stack.apply_edit(&replace, doc.len());
        return KeyAction::Apply { changes: vec![replace], selection: Some(Range::caret(cursor)) };
    }
    tabout(stack, doc, selection.to, ctx, math, config)
}

/// Port of the TS `matrixEnter` binding: Enter inside a matrix environment.
/// `Pass` when the host should do its ordinary newline.
pub fn enter(
    stack: &mut SessionStack,
    doc: &str,
    selection: Range,
    shift: bool,
    ctx: &EditContext,
    math: &[MathRegion],
    config: &LatexConfig,
) -> KeyAction {
    let Some(plan) = matrix_enter(doc, selection, shift, ctx, math, config) else {
        return KeyAction::Pass;
    };
    for change in &plan.changes {
        stack.apply_edit(change, doc.len());
    }
    KeyAction::Apply { changes: plan.changes, selection: Some(Range::caret(plan.cursor)) }
}

/// Port of the TS `tryAutoExpand` (minus the vim/composition listener plumbing,
/// which is host-side). The key has already been inserted by the caller and the
/// cursor sits after it.
pub fn auto_expand(
    store: &SnippetStore,
    stack: &mut SessionStack,
    doc: &str,
    cursor: usize,
    ctx: &EditContext,
    math: &[MathRegion],
    config: &LatexConfig,
    typed_key: &str,
    visual_text: Option<&str>,
) -> KeyAction {
    // latex-suite auto-fraction: a `/` in math turns the expression before the
    // cursor into a fraction. It also fires during a snippet session (in the
    // plugin it is a keystroke-level feature): the fraction pushes a child
    // session and Tab walks it before returning to the outer one.
    if typed_key == "/" && store.enabled {
        if let Some(frac) = auto_fraction(doc, cursor, visual_text, ctx, math) {
            return start_session(stack, doc, frac.start, frac.end, &frac.replacement);
        }
    }
    // Environment names are excluded from auto-expansion (`\begin{ali|` must not
    // expand `ali` into a full environment template — the mirrored tabstops then
    // copy the damage into `\end{}` and the cursor drifts). Manual Tab expansion
    // is not limited: that is the user's explicit intent.
    if !store.enabled || inside_env_name(doc, cursor) {
        return KeyAction::Pass;
    }
    let opts = MatchOptions::from_config(config, true, Some(typed_key), visual_text);
    let Some(exp) = store.compiled.match_at(doc, cursor, ctx, &opts) else {
        return KeyAction::Pass;
    };
    start_expansion(stack, doc, &exp)
}

/// Port of the TS `escapeForSnippet` + `clearSession`: with vim enabled the
/// engine gets Esc first (leave insert mode) and the session is popped by the
/// exit rule once the cursor leaves the expansion — otherwise a live session
/// would eat the first Esc. With vim off, latex-suite semantics: Esc ends the
/// session.
pub fn escape(stack: &mut SessionStack, vim_enabled: bool) -> KeyAction {
    if vim_enabled || stack.is_empty() {
        return KeyAction::Pass;
    }
    stack.clear();
    KeyAction::consumed()
}

/// Port of the TS `deleteDollarPair`: Backspace between two `$` deletes both at
/// once (`$|$` / `$$|$$`). Only decides *what* to delete; whether the key may
/// run here at all (the vim gate) is the host's binding.
pub fn delete_dollar_pair(
    doc: &str,
    cursor: usize,
    ctx: &EditContext,
    config: &LatexConfig,
) -> Option<Replace> {
    if !config.auto_delete_dollar {
        return None;
    }
    if char_at(doc, cursor) != Some('$') {
        return None;
    }
    if cursor == 0 || prev_char(doc, cursor) != Some('$') {
        return None;
    }
    if !ctx.inline_math && !ctx.block_math {
        return None;
    }
    Some(Replace::delete(cursor - 1, cursor + 1))
}

/// Cheap three-byte pre-check for [`delete_script_braces`]: hosts can run this
/// before computing the `EditContext` (the TS orders it that way so Backspace,
/// a hot key, short-circuits before the math scan).
pub fn script_braces_at(doc: &str, pos: usize) -> bool {
    let Some(lead) = pos.checked_sub(2).and_then(|from| doc.get(from..pos + 1)) else {
        return false;
    };
    lead == "_{}" || lead == "^{}"
}

/// Port of the TS `deleteScriptBraces`: Backspace between the braces of `_{}` /
/// `^{}` removes the whole pair including the `_`/`^` marker. Text-mode `_{}`
/// is left alone (`_` is a markdown emphasis marker there).
pub fn delete_script_braces(doc: &str, cursor: usize, ctx: &EditContext) -> Option<Replace> {
    if !script_braces_at(doc, cursor) {
        return None;
    }
    if !ctx.inline_math && !ctx.block_math {
        return None;
    }
    Some(Replace::delete(cursor - 2, cursor + 1))
}

/// Port of the TS `setup.ts` Backspace chain: `deleteDollarPair || deleteScriptBraces`.
pub fn backspace(
    stack: &mut SessionStack,
    doc: &str,
    cursor: usize,
    ctx: &EditContext,
    config: &LatexConfig,
) -> KeyAction {
    if let Some(replace) = delete_dollar_pair(doc, cursor, ctx, config) {
        stack.apply_edit(&replace, doc.len());
        return KeyAction::Apply { changes: vec![replace], selection: Some(Range::caret(cursor - 1)) };
    }
    if let Some(replace) = delete_script_braces(doc, cursor, ctx) {
        stack.apply_edit(&replace, doc.len());
        return KeyAction::Apply { changes: vec![replace], selection: Some(Range::caret(cursor - 2)) };
    }
    KeyAction::Pass
}

/// Port of the TS `faceCloseBracket`: the cursor faces a closing bracket and the
/// same character is being typed → do not insert a duplicate, tab out instead.
pub fn face_close_bracket(doc: &str, from: usize, to: usize, text: &str) -> bool {
    if from != to || text.len() != 1 {
        return false;
    }
    let Some(ch) = text.chars().next() else { return false };
    if !")]}".contains(ch) {
        return false;
    }
    char_at(doc, from) == Some(ch)
}

/// Port of the TS `closeBracketSkip` decision, asked **before** the character
/// is inserted: when the cursor faces the same closing bracket and the session
/// still has a next tabstop, the key is consumed and the cursor jumps there
/// (the TS applies the same net state as insert-then-undo, because its listener
/// runs after the insert).
pub fn close_bracket_skip(
    stack: &mut SessionStack,
    doc: &str,
    cursor: usize,
    typed: &str,
) -> KeyAction {
    if !face_close_bracket(doc, cursor, cursor, typed) || stack.is_empty() {
        return KeyAction::Pass;
    }
    match stack.plan_tab() {
        // The plugin passes the last tabstop through (the character is inserted).
        Some(TabPlan::Select { level, index }) => match stack.select(level, index) {
            Some(range) => KeyAction::cursor(range),
            None => KeyAction::Pass,
        },
        _ => KeyAction::Pass,
    }
}

/// Port of the TS `startSessionAt` → `autoEnlargeBrackets` second transaction:
/// call with the document and cursor **after** the expansion was applied.
pub fn enlarge_after_expansion(
    doc_after: &str,
    head: usize,
    inserted: &str,
    config: &LatexConfig,
    math: &[MathRegion],
) -> Vec<Replace> {
    auto_enlarge_edits(doc_after, head, inserted, config, math).unwrap_or_default()
}

/// Port of the TS `insideEnvName`: the cursor sits inside a `\begin{` /
/// `\end{` environment name (no closing brace yet). One backward line scan.
pub fn inside_env_name(doc: &str, pos: usize) -> bool {
    let line_from = line_start(doc, pos);
    let prefix = &doc[line_from..pos];
    // /\\(?:begin|end)\{[^}]*$/ — the last opener before the cursor that has no
    // `}` after it.
    let last_begin = prefix.rfind("\\begin{");
    let last_end = prefix.rfind("\\end{");
    let (at, len) = match (last_begin, last_end) {
        (None, None) => return false,
        (Some(b), None) => (b, "\\begin{".len()),
        (None, Some(e)) => (e, "\\end{".len()),
        (Some(b), Some(e)) => {
            if b > e {
                (b, "\\begin{".len())
            } else {
                (e, "\\end{".len())
            }
        }
    };
    !prefix[at + len..].contains('}')
}

/// Manual expansion on Tab when no session is active (TS `expandOnTab`).
fn expand_on_tab(
    store: &SnippetStore,
    stack: &mut SessionStack,
    doc: &str,
    selection: Range,
    ctx: &EditContext,
    config: &LatexConfig,
) -> KeyAction {
    if !store.enabled {
        return KeyAction::Pass;
    }
    let visual = if selection.is_empty() { None } else { doc.get(selection.from..selection.to) };
    let opts = MatchOptions::from_config(config, false, None, visual);
    let Some(exp) = store.compiled.match_at(doc, selection.to, ctx, &opts) else {
        return KeyAction::Pass;
    };
    start_expansion(stack, doc, &exp)
}

/// Starts a snippet session from an expansion (TS `startSession`, one
/// transaction: the edit plus the new session on top of the chain).
fn start_expansion(stack: &mut SessionStack, doc: &str, exp: &Expansion<'_>) -> KeyAction {
    start_session(stack, doc, exp.start, exp.end, &exp.replacement)
}

/// Shared by snippet expansions and auto-fractions: replace `[start, end)` with
/// the parsed replacement, push the session (the existing chain is remapped
/// through the edit) and return the first tabstop as the new selection.
fn start_session(
    stack: &mut SessionStack,
    doc: &str,
    start: usize,
    end: usize,
    replacement: &ParsedReplacement,
) -> KeyAction {
    let replace = Replace::new(start, end, replacement.text.clone());
    let session = Session::build(start, replacement);
    let end_caret = Range::caret(start + replacement.text.len());
    let selection = session.as_ref().and_then(|s| s.initial_selection()).unwrap_or(end_caret);
    match session {
        Some(s) => stack.push_child(s, &replace, doc.len()),
        None => stack.apply_edit(&replace, doc.len()),
    }
    KeyAction::Apply { changes: vec![replace], selection: Some(selection) }
}

/// TS `tabout(view)`: the last Tab layer. `Pass` when disabled or when there is
/// nowhere to step out to.
fn tabout(
    stack: &mut SessionStack,
    doc: &str,
    pos: usize,
    ctx: &EditContext,
    math: &[MathRegion],
    config: &LatexConfig,
) -> KeyAction {
    if !config.tabout {
        return KeyAction::Pass;
    }
    let Some(plan) = plan_tabout(doc, pos, ctx, math) else {
        return KeyAction::Pass;
    };
    for change in &plan.changes {
        stack.apply_edit(change, doc.len());
    }
    KeyAction::Apply { changes: plan.changes, selection: Some(Range::caret(plan.pos)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::context::context_at_scan;
    use crate::markdown::math_scan::scan_math;
    use crate::snippets::config::LatexConfig;
    use crate::snippets::default_snippets::DEFAULT_SNIPPETS;
    use crate::snippets::engine::{RawSnippet, SnippetStore, lit};
    use crate::snippets::parse_replacement;
    use crate::snippets::session::Session;
    use crate::snippets::apply_replaces;

    /// Fake host: document + cursor + session stack, applying [`KeyAction`]s the
    /// way the TS fake views applied transactions.
    struct Sim {
        doc: String,
        sel: Range,
        stack: SessionStack,
        store: SnippetStore,
        config: LatexConfig,
    }

    impl Sim {
        fn new(doc: &str, cursor: usize) -> Self {
            Sim {
                doc: doc.to_string(),
                sel: Range::caret(cursor),
                stack: SessionStack::new(),
                store: SnippetStore::from_raw(&[], true),
                config: LatexConfig::default(),
            }
        }

        fn with_snippets(doc: &str, cursor: usize, raws: &[RawSnippet<'_>]) -> Self {
            let mut sim = Sim::new(doc, cursor);
            sim.store = SnippetStore::from_raw(raws, true);
            sim
        }

        fn with_builtin(doc: &str, cursor: usize) -> Self {
            let mut sim = Sim::new(doc, cursor);
            sim.store = SnippetStore::builtin();
            sim
        }

        fn ctx(&self) -> EditContext {
            let math = scan_math(&self.doc);
            context_at_scan(&self.doc, self.sel.to, &math)
        }

        fn math(&self) -> Vec<MathRegion> {
            scan_math(&self.doc)
        }

        fn apply(&mut self, action: KeyAction) -> bool {
            match action {
                KeyAction::Pass => false,
                KeyAction::Apply { changes, selection } => {
                    self.doc = apply_replaces(&self.doc, &changes);
                    if let Some(sel) = selection {
                        self.sel = sel;
                    }
                    true
                }
            }
        }

        fn head(&self) -> usize {
            self.sel.to
        }

        fn tab(&mut self) -> bool {
            let ctx = self.ctx();
            let math = self.math();
            let action = tab(&self.store, &mut self.stack, &self.doc, self.sel, &ctx, &math, &self.config);
            self.apply(action)
        }

        fn shift_tab(&mut self) -> bool {
            let ctx = self.ctx();
            let math = self.math();
            let action =
                shift_tab(&mut self.stack, &self.doc, self.sel, &ctx, &math, &self.config);
            self.apply(action)
        }

        /// The TS test shape: the key is already in the document and only the
        /// auto-expand decision runs (TS `tryAutoExpand(view, key, visual)`).
        fn try_auto(&mut self, key: &str) -> bool {
            let cursor = self.head();
            let ctx = self.ctx();
            let math = self.math();
            let action = auto_expand(
                &self.store,
                &mut self.stack,
                &self.doc,
                cursor,
                &ctx,
                &math,
                &self.config,
                key,
                None,
            );
            self.apply(action)
        }

        /// Insert one character (mapped into the stack) and then run the
        /// auto-expansion, like the TS input handler.
        fn type_char(&mut self, key: &str) -> bool {
            let at = self.head();
            let change = Replace::insert_at(at, key);
            let before_len = self.doc.len();
            self.doc = apply_replaces(&self.doc, std::slice::from_ref(&change));
            self.sel = Range::caret(at + key.len());
            self.stack.apply_edit(&change, before_len);
            self.try_auto(key)
        }

        /// The real host order for a typed character: a facing close bracket is
        /// skipped before it is inserted (TS `closeBracketSkipListener`).
        fn type_like_host(&mut self, key: &str) -> bool {
            let cursor = self.head();
            let action = close_bracket_skip(&mut self.stack, &self.doc, cursor, key);
            if !action.is_pass() {
                return self.apply(action);
            }
            self.type_char(key)
        }

        fn backspace(&mut self) -> bool {
            let cursor = self.head();
            let ctx = self.ctx();
            let action = backspace(&mut self.stack, &self.doc, cursor, &ctx, &self.config);
            self.apply(action)
        }

        fn close_bracket(&mut self, key: &str) -> bool {
            let cursor = self.head();
            let action = close_bracket_skip(&mut self.stack, &self.doc, cursor, key);
            self.apply(action)
        }

        fn enter(&mut self, shift: bool) -> bool {
            let selection = self.sel;
            let ctx = self.ctx();
            let math = self.math();
            let action = enter(
                &mut self.stack,
                &self.doc,
                selection,
                shift,
                &ctx,
                &math,
                &self.config,
            );
            self.apply(action)
        }
    }

    /// `Tab 链路次序:会话 → 展开 → tabout`.
    const DM_BLOCK: &str = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";

    #[test]
    fn with_a_session_tab_walks_tabstops() {
        let mut sim = Sim::new("$\\mathbf{}$", 10);
        sim.stack.push(Session::build(1, &parse_replacement("\\mathbf{$0}$1", &[], None, false)).unwrap());
        let doc = sim.doc.clone();
        assert!(sim.tab());
        assert_eq!(sim.head(), doc.find("}$").unwrap() + 1);
        assert_eq!(sim.doc, doc); // cursor only
        assert!(!sim.stack.is_empty()); // the session is still alive
    }

    #[test]
    fn after_the_session_is_done_tab_falls_through_to_tabout() {
        // The shape after `sum` + auto-enlarge: the cursor left the `\sum…`
        // session, `\right)` waits outside.
        let doc = "$\\left( \\sum_{i=1}^{N} \\right)$";
        let mut sim = Sim::new(doc, doc.find("\\right)").unwrap());
        let pos = doc.find("\\sum").unwrap();
        sim.stack.push(
            Session::build(pos, &parse_replacement("\\sum_{${0:i}=${1:1}}^{${2:N}} $3", &[], None, false))
                .unwrap(),
        );
        sim.tab();
        assert!(!sim.stack.is_empty());
        for _ in 0..6 {
            sim.tab();
        }
        assert!(sim.head() > doc.find(')').unwrap());
    }

    #[test]
    fn without_a_session_tab_reaches_tabout() {
        let doc = "$$\n\\left( x \\right)\n$$";
        let mut sim = Sim::new(doc, doc.find("\\right)").unwrap());
        assert!(sim.tab());
        assert_eq!(sim.head(), doc.find(')').unwrap() + 1);
        assert_eq!(sim.doc, doc);
    }

    #[test]
    fn ordinary_tab_in_a_matrix_does_not_insert_a_separator() {
        let mut sim = Sim::new(DM_BLOCK, DM_BLOCK.find('Q').unwrap());
        assert!(sim.tab());
        assert_eq!(sim.doc, DM_BLOCK); // nothing was written into the formula
        // Shift+Tab is the column separator.
        let mut shifted = Sim::new(DM_BLOCK, DM_BLOCK.find('Q').unwrap());
        assert!(shifted.shift_tab());
        assert_eq!(shifted.doc, DM_BLOCK.replace('Q', " & Q"));
    }

    #[test]
    fn repeated_tab_in_a_matrix_walks_the_cursor_past_the_environment() {
        let mut sim = Sim::new(DM_BLOCK, DM_BLOCK.find('Q').unwrap());
        assert!(sim.tab());
        assert_eq!(
            sim.head(),
            DM_BLOCK.find("\\end{pmatrix}").unwrap() + "\\end{pmatrix}".len()
        );
        assert!(sim.tab());
        assert_eq!(sim.doc[sim.head()..].trim(), "");
    }

    #[test]
    fn shift_tab_without_a_matrix_walks_back_a_tabstop() {
        let doc = "$\\mathbf{}$";
        let mut sim = Sim::new(doc, doc.find("}$").unwrap() + 1);
        let mut session =
            Session::build(1, &parse_replacement("\\mathbf{$0}$1", &[], None, false)).unwrap();
        session.active = 1;
        sim.stack.push(session);
        assert!(sim.shift_tab());
        assert_eq!(sim.doc, doc);
        assert_eq!(sim.head(), doc.find('}').unwrap()); // back to $0
    }

    /// `闭括号跳越:敲下光标前那个右括号 = 一次 Tab`.
    #[test]
    fn typing_the_facing_close_bracket_skips_instead_of_duplicating() {
        let mut sim = Sim::new("()", 1);
        sim.stack.push(Session::build(0, &parse_replacement("($0)$1", &[], None, false)).unwrap());
        assert!(sim.close_bracket(")"));
        assert_eq!(sim.doc, "()"); // the plugin's net state: no extra `)`
        assert_eq!(sim.head(), 2); // stepped out to $1
    }

    #[test]
    fn the_last_tabstop_passes_the_close_bracket_through() {
        let mut sim = Sim::new("()", 2);
        let mut session = Session::build(0, &parse_replacement("($0)$1", &[], None, false)).unwrap();
        session.active = 1;
        sim.stack.push(session);
        assert!(!sim.close_bracket(")"));
        // The host inserts the character as usual.
        sim.type_char(")");
        assert_eq!(sim.doc, "())");
    }

    #[test]
    fn a_close_bracket_that_is_not_faced_is_not_skipped() {
        let mut sim = Sim::new("(x", 2);
        sim.stack.push(Session::build(0, &parse_replacement("($0)$1", &[], None, false)).unwrap());
        assert!(!sim.close_bracket(")"));
    }

    #[test]
    fn without_a_session_the_close_bracket_is_inserted() {
        let mut sim = Sim::new("()", 1);
        assert!(!sim.close_bracket(")"));
    }

    #[test]
    fn closing_square_bracket_skips_too() {
        let mut sim = Sim::new("[]", 1);
        sim.stack.push(Session::build(0, &parse_replacement("[$0]$1", &[], None, false)).unwrap());
        assert!(sim.close_bracket("]"));
        assert_eq!(sim.doc, "[]");
    }

    /// `会话与 tabout 的接缝`: once tabout carries the cursor out of the
    /// expansion, the exit rule drops the session.
    #[test]
    fn tabout_carries_the_cursor_out_of_the_session() {
        let doc = "$(x)$";
        let mut stack = SessionStack::new();
        stack.push(Session::build(0, &parse_replacement("($0)$1", &[], None, false)).unwrap());
        let out = doc.find(')').unwrap() + 1; // after the `)`
        assert_eq!(out, 4);
        assert_eq!(stack.exit_chain(out), None);
    }

    /// `tabout:派发与开关`.
    #[test]
    fn tabout_applies_the_plan_and_its_block_cleanup() {
        let doc = "$$\nx   \n$$\n下一段";
        let mut sim = Sim::new(doc, doc.find('x').unwrap() + 1);
        assert!(sim.tab());
        assert_eq!(sim.doc, "$$\nx\n$$\n下一段");
        assert_eq!(&sim.doc[sim.head()..], "下一段");
    }

    #[test]
    fn tabout_declines_when_there_is_nowhere_to_go() {
        let mut sim = Sim::new("正文段落", 0);
        assert!(!sim.tab());
        assert_eq!(sim.doc, "正文段落");
    }

    #[test]
    fn switching_tabout_off_stops_the_takeover() {
        let mut sim = Sim::new("$(x)$", 2);
        sim.config.tabout = false;
        assert!(!sim.tab());
        assert_eq!(sim.doc, "$(x)$");
    }

    /// `autoDelete$:光标夹在两个 $ 之间时一次删两个`.
    #[test]
    fn empty_inline_formula_deletes_as_a_pair() {
        let mut sim = Sim::new("$$", 1);
        assert!(sim.backspace());
        assert_eq!(sim.doc, "");
    }

    #[test]
    fn empty_block_formula_deletes_as_a_pair() {
        let mut sim = Sim::new("$$$$", 2);
        assert!(sim.backspace());
        assert_eq!(sim.doc, "$$");
    }

    #[test]
    fn a_single_dollar_keeps_the_default_deletion() {
        let mut sim = Sim::new("$x$", 2);
        assert!(!sim.backspace());
        assert_eq!(sim.doc, "$x$");
    }

    #[test]
    fn two_dollars_outside_math_are_not_deleted() {
        let mut sim = Sim::new("价格$5 和 $10 不同", 5 + 8);
        assert!(!sim.backspace());
    }

    #[test]
    fn switching_auto_delete_dollar_off_stops_the_takeover() {
        let mut sim = Sim::new("$$", 1);
        sim.config.auto_delete_dollar = false;
        assert!(!sim.backspace());
    }

    /// `deleteScriptBraces:上下标空花括号连标记一起删`.
    fn at_brace(doc: &str) -> usize {
        doc.find('}').unwrap()
    }

    #[test]
    fn empty_subscript_braces_delete_as_a_whole() {
        let doc = "$x_{}$";
        let mut sim = Sim::new(doc, at_brace(doc));
        assert!(sim.backspace());
        assert_eq!(sim.doc, "$x$");
    }

    #[test]
    fn empty_superscript_braces_delete_as_a_whole() {
        let doc = "$a^{}$";
        let mut sim = Sim::new(doc, at_brace(doc));
        assert!(sim.backspace());
        assert_eq!(sim.doc, "$a$");
    }

    #[test]
    fn script_braces_work_in_block_math_too() {
        let doc = "$$\nx_{}\n$$";
        let mut sim = Sim::new(doc, at_brace(doc));
        assert!(sim.backspace());
        assert_eq!(sim.doc, "$$\nx\n$$");
    }

    #[test]
    fn nested_script_braces_delete_only_the_innermost_pair() {
        let doc = "$x_{a_{}}$";
        let mut sim = Sim::new(doc, at_brace(doc));
        assert!(sim.backspace());
        assert_eq!(sim.doc, "$x_{a}$");
    }

    #[test]
    fn braces_with_content_are_a_plain_deletion() {
        let doc = "$x_{a}$";
        let mut sim = Sim::new(doc, at_brace(doc));
        assert!(!sim.backspace());
        assert_eq!(sim.doc, "$x_{a}$");
    }

    #[test]
    fn script_braces_outside_math_are_left_alone() {
        let doc = "x_{}";
        let mut sim = Sim::new(doc, at_brace(doc));
        assert!(!sim.backspace());
        assert_eq!(sim.doc, "x_{}");
    }

    #[test]
    fn a_selection_keeps_the_default_deletion() {
        // The TS handler bails on a non-empty selection; in the port that guard
        // belongs to the host (these handlers take a caret). What the port must
        // guarantee is that the caret at `range.to` is not taken over either.
        let doc = "$x_{}$";
        let mut sim = Sim::new(doc, 5); // range.to of a 2..5 selection
        assert!(!sim.backspace());
        assert!(!script_braces_at(doc, 5));
        assert!(script_braces_at(doc, 4));
    }

    /// `环境名内禁止自动展开(光标漂移根因)`.
    fn env_name_sim(doc: &str, cursor: usize) -> Sim {
        Sim::with_snippets(
            doc,
            cursor,
            &[lit("ali", "\\begin{align}\n$0\n\\end{align}", "mA")],
        )
    }

    #[test]
    fn ali_expands_normally_inside_the_formula_body() {
        let mut sim = env_name_sim("$$ali", 5);
        assert!(sim.try_auto("i"));
        assert_eq!(sim.doc, "$$\\begin{align}\n\n\\end{align}");
    }

    #[test]
    fn typing_inside_a_begin_env_name_does_not_expand() {
        let mut sim = env_name_sim("$$\\begin{al", 11);
        assert!(!sim.try_auto("i"));
        assert_eq!(sim.doc, "$$\\begin{al");
    }

    #[test]
    fn typing_inside_an_end_env_name_does_not_expand() {
        let mut sim = env_name_sim("$$\\begin{x}\\end{al", 18);
        assert!(!sim.try_auto("i"));
        assert_eq!(sim.doc, "$$\\begin{x}\\end{al");
    }

    #[test]
    fn after_the_env_name_closed_expansion_works_again() {
        let mut sim = env_name_sim("$$\\begin{x}ali", 14);
        assert!(sim.try_auto("i"));
    }

    #[test]
    fn inside_env_name_predicate_matches_the_ts_regex() {
        assert!(inside_env_name("$$\\begin{al", 11));
        assert!(inside_env_name("$$\\begin{x}\\end{al", 18));
        assert!(!inside_env_name("$$\\begin{x}ali", 14));
        assert!(!inside_env_name("$$ali", 5));
        assert!(!inside_env_name("\\begin{a}\nbody", 14));
    }

    /// `tryAutoExpand 汇合 auto-fraction`.
    #[test]
    fn slash_expands_inside_math_and_lands_in_the_denominator() {
        let mut sim = Sim::new("$$silu(x)=1/", 12);
        assert!(sim.try_auto("/"));
        assert_eq!(sim.doc, "$$silu(x)=\\frac{1}{}");
        assert_eq!(sim.head(), 19); // between `{` and `}`
    }

    #[test]
    fn slash_outside_math_stays_literal() {
        let mut sim = Sim::new("x/", 2);
        assert!(!sim.try_auto("/"));
        assert_eq!(sim.doc, "x/");
    }

    #[test]
    fn slash_still_expands_while_a_bracket_session_is_alive() {
        let mut sim = Sim::with_builtin("$$f(", 4);
        // The `(` is already in the document (the TS test's shape) and
        // auto-expands into a session with the cursor inside the parens.
        assert!(sim.try_auto("("));
        assert_eq!(sim.doc, "$$f()");
        assert!(!sim.stack.is_empty());
        // Keep typing (the session spans the whole line, as in the real path).
        for c in ["x", ")", "=", "1"] {
            sim.type_char(c);
        }
        assert_eq!(sim.doc, "$$f(x)=1)");
        assert!(!sim.stack.is_empty());
        // `/` has been inserted by the input path; the fix must expand it
        // instead of the session swallowing it.
        assert!(sim.type_char("/"));
        assert_eq!(sim.doc, "$$f(x)=\\frac{1}{})");
        // The fraction pushed a child session; the outer bracket session is
        // still on the chain (Tab walks back out through it).
        assert_eq!(sim.stack.len(), 2);
    }

    /// `escapeForSnippet:活会话不得吃掉 vim 的第一下 Esc`.
    #[test]
    fn with_vim_on_escape_leaves_the_session_to_the_engine() {
        let mut sim = Sim::with_builtin("$$ali", 5);
        assert!(sim.try_auto("i")); // a live session
        assert!(!sim.stack.is_empty());
        let doc = sim.doc.clone();
        let action = escape(&mut sim.stack, true);
        assert!(action.is_pass());
        assert_eq!(sim.doc, doc);
        assert!(!sim.stack.is_empty()); // the session is kept for the engine
    }

    #[test]
    fn with_vim_off_escape_ends_the_session() {
        let mut sim = Sim::new("$$\n\n$$", 3);
        sim.stack.push(Session::build(0, &parse_replacement("$$\n$0\n$$", &[], None, false)).unwrap());
        assert!(!sim.stack.is_empty());
        let action = escape(&mut sim.stack, false);
        assert!(sim.apply(action));
        assert!(sim.stack.is_empty());
    }

    /// Manual Tab expansion (`expandOnTab`).
    #[test]
    fn manual_tab_expands_a_word_boundary_snippet() {
        // `dm` is `tAw`: it needs manual Tab in the middle of a line.
        let mut sim = Sim::with_builtin("正文\n\ndm", 10);
        assert!(sim.tab());
        assert_eq!(sim.doc, "正文\n\n$$\n\\begin{align}\n\n\\end{align}\n$$");
        assert!(!sim.stack.is_empty());
    }

    /// The expansion → auto-enlarge pair (TS `startSessionAt` +
    /// `autoEnlargeBrackets`, two transactions).
    #[test]
    fn expansion_followed_by_the_enlarge_transaction() {
        let mut sim = Sim::with_builtin("$$(", 3);
        assert!(sim.type_char("(")); // `(` → `($0)$1`
        for c in ["s", "u", "m"] {
            sim.type_char(c); // `sum` auto-expands inside the parens
        }
        assert!(sim.doc.contains("\\sum_{"), "sum expanded: {}", sim.doc);
        let head = sim.head();
        let math = sim.math();
        // The TS passes the *expanded* replacement text to autoEnlargeBrackets.
        let inserted = "\\sum_{i=1}^{N} ";
        let edits = enlarge_after_expansion(&sim.doc, head, inserted, &sim.config, &math);
        assert!(!edits.is_empty());
        let out = apply_replaces(&sim.doc, &edits);
        assert!(out.contains("\\left("), "{out}");
        assert!(out.contains("\\right)"), "{out}");
    }

    /// The three-layer Tab ordering is what makes `Tab 跳不出去` impossible: the
    /// last layer must exist (TS `runTab` gate).
    #[test]
    fn tab_layer_order_is_session_expand_tabout() {
        // Layer 1: an active session wins.
        let mut sim = Sim::new("$\\mathbf{}$", 10);
        sim.stack.push(Session::build(1, &parse_replacement("\\mathbf{$0}$1", &[], None, false)).unwrap());
        assert!(sim.tab());
        assert_eq!(sim.doc, "$\\mathbf{}$");

        // Layer 2: no session, a trigger before the cursor → expand instead of
        // tabbing out (the built-in `dm` needs a word boundary, use `ali`).
        let mut sim = Sim::with_builtin("$$\\begin{x}ali", 14);
        let before = sim.doc.clone();
        assert!(sim.tab());
        assert_ne!(sim.doc, before);

        // Layer 3: nothing to expand → tabout.
        let doc = "$a)b$";
        let mut sim = Sim::new(doc, 1);
        assert!(sim.tab());
        assert_eq!(sim.head(), 3);
    }

    /// The host bindings for the two remaining keys: a facing close bracket is
    /// skipped before it is ever inserted, and Enter inside a matrix inserts
    /// the ` \\` row break (Shift+Enter only moves the cursor).
    #[test]
    fn host_bindings_for_close_bracket_and_enter() {
        let mut sim = Sim::new("()", 1);
        sim.stack.push(Session::build(0, &parse_replacement("($0)$1", &[], None, false)).unwrap());
        assert!(sim.type_like_host(")"));
        assert_eq!(sim.doc, "()"); // never inserted
        assert_eq!(sim.head(), 2);

        let q = DM_BLOCK.find('Q').unwrap();
        let mut sim = Sim::new(DM_BLOCK, q);
        assert!(sim.enter(false));
        // The row break is ` \\` + newline: space, two backslashes, newline.
        assert_eq!(sim.doc, "$$\n\\begin{pmatrix}\n \\\\\nQ & b\n\\end{pmatrix}\n$$");
        let mut sim = Sim::new(DM_BLOCK, q);
        assert!(sim.enter(true));
        assert_eq!(sim.doc, DM_BLOCK); // cursor only
    }

    #[test]
    fn builtin_data_compiles_into_the_store() {
        let store = SnippetStore::from_raw(DEFAULT_SNIPPETS, true);
        assert_eq!(store.compiled.list.len(), DEFAULT_SNIPPETS.len());
    }
}
