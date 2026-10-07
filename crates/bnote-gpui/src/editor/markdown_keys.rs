//! Markdown typing semantics the editor component cannot know.
//!
//! One rule today, ported from the TS editor where it is a `Prec.highest`
//! keymap entry on Enter (`setup.ts` + `ops.ts::enterContinueListItem`):
//! **Enter on a list line continues the item** — `- `, `1. `, `- [ ] `, a
//! nested item losing one level when empty, a top-level one leaving the list.
//! The core rule (with its tests) is
//! `bnote_core::markdown::ops::enter_continue_list_item`; this module is only
//! the wiring into the editor's Enter, through
//! `gpui_kit::component::input::EditorState::set_enter_override`.
//!
//! Ordering is why the hook lives on the editor and not in a keystroke
//! interceptor: the snippet bridge's interceptor runs first and consumes the
//! keys it wants (a matrix row break inside a formula), so an editor-level
//! rule can never double-apply on top of it.

use gpui::{Context, Window};
use gpui_kit::component::input::EditorState;

use crate::apply_ops::apply_outcome_state;

/// The list indent unit both shells use (`indent.ts`: two spaces).
const INDENT_UNIT: &str = "  ";

/// The editor's Enter rule (see the module docs). Returns whether it consumed
/// the key; `false` lets the built-in newline + smart indent run.
pub fn enter_continue(
    state: &mut EditorState,
    window: &mut Window,
    cx: &mut Context<EditorState>,
) -> bool {
    let text = state.value().to_string();
    let selection = state.selected_range();
    if selection.start != selection.end {
        return false;
    }
    let Some(outcome) =
        bnote_core::markdown::ops::enter_continue_list_item(&text, selection.start, INDENT_UNIT)
    else {
        return false;
    };
    // A `- ` line inside a formula is LaTeX, not a list. The snippet bridge
    // owns Enter there and runs before this hook; the check keeps a line that
    // looks like a list inside `$$…$$` from continuing when it reaches here
    // anyway (a selection-less Enter the snippet layer passed through).
    if bnote_core::markdown::math_scan::scan_math(&text)
        .iter()
        .any(|region| selection.start >= region.from && selection.start <= region.to)
    {
        return false;
    }
    apply_outcome_state(state, &outcome, window, cx);
    true
}
