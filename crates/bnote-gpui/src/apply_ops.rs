//! Glue between the pure `bnote_core::markdown::ops` outcomes and the
//! gpui-kit editor: applies edits (descending, via the engine's LSP edit
//! path so undo/decoration remap stays engine-owned) and places cursors.

use bnote_core::markdown::ops::OpsOutcome;
use gpui::{Entity, Window};
use gpui_kit::component::input::EditorState;

/// UTF-8 byte offset → LSP (line, utf-16 column). O(line) walk from the top;
/// commands run rarely, so the simplicity wins.
pub(crate) fn to_lsp_pos(text: &str, byte: usize) -> lsp_types::Position {
    let byte = byte.min(text.len());
    let mut line = 0u32;
    let mut line_start = 0usize;
    for (i, b) in text.bytes().enumerate() {
        if i >= byte {
            break;
        }
        if b == b'\n' {
            line += 1;
            line_start = i + 1;
        }
    }
    let character: usize = text[line_start..byte].chars().map(|c| c.len_utf16()).sum();
    lsp_types::Position { line, character: character as u32 }
}

/// Apply an ops outcome to the editor in one transaction. Multi-cursor
/// placement is v1-limited to the first cursor (the engine's multi-selection
/// setter is not public yet).
pub fn apply_outcome(
    editor: &Entity<EditorState>,
    out: &OpsOutcome,
    window: &mut Window,
    cx: &mut gpui::App,
) {
    editor.update(cx, |state, cx| apply_outcome_state(state, out, window, cx));
}

/// [`apply_outcome`] against an already-borrowed state. The editor's own
/// update paths (the host's Enter rule, action listeners) hold `&mut
/// EditorState` — re-entering the entity through `Entity::update` there would
/// panic on the update stack.
pub(crate) fn apply_outcome_state(
    state: &mut EditorState,
    out: &OpsOutcome,
    window: &mut Window,
    cx: &mut gpui::Context<EditorState>,
) {
    if out.edits.is_empty() {
        return;
    }
    let text = state.value().to_string();
    let mut text_edits: Vec<lsp_types::TextEdit> = out
        .edits
        .iter()
        .map(|e| lsp_types::TextEdit {
            range: lsp_types::Range {
                start: to_lsp_pos(&text, e.start),
                end: to_lsp_pos(&text, e.end),
            },
            new_text: e.text.clone(),
        })
        .collect();
    // The engine re-derives offsets per edit against the live text, so apply
    // highest-offset-first to keep earlier positions valid.
    text_edits.sort_by(|a, b| {
        (b.range.start.line, b.range.start.character)
            .cmp(&(a.range.start.line, a.range.start.character))
    });

    state.apply_lsp_edits(&text_edits, window, cx);
    if let Some(&(anchor, head)) = out.cursors.first() {
        state.set_selected_range(anchor.min(head)..anchor.max(head), cx);
    }
}

/// Cursor (head) byte offset → 1-based (line, column in chars), for the
/// status bar and the ⌘T return memory.
pub fn byte_to_line_col(text: &str, byte: usize) -> (usize, usize) {
    let byte = byte.min(text.len());
    let mut line = 1usize;
    let mut col = 0usize;
    for (i, b) in text.bytes().enumerate() {
        if i >= byte {
            break;
        }
        if b == b'\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    (line, col)
}
