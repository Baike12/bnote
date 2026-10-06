//! Host integration: the `App::intercept_keystrokes` bridge that runs the
//! pure engine *before* GPUI's action dispatch and native text input.
//!
//! The host calls [`VimBridge::init`] once at startup, then [`attach`]es each
//! editor that should be modal. On every keystroke the bridge finds the
//! attached, focused editor, feeds the key to [`crate::editor::vim::core`],
//! applies the resulting `Execution` through the editor's programmatic APIs,
//! and stops propagation for every key vim consumed. In Insert mode the
//! bridge is transparent (`Outcome::Unhandled`), so native typing, IME
//! composition, and gpui-kit's own editing keys are untouched.
//!
//! See `super` for the keystroke-seam research that picked this design
//! (interceptors run before action matching and IME; `stop_propagation` in
//! one consumes the key entirely).
//!
//! ## Ownership rules (AGENTS.md 性能是生命线)
//!
//! - Text is snapshotted per keystroke (`text()` → `String`). The pure core
//!   needs a byte-addressable view; bnote vaults are ~70KB, so the copy is a
//!   few µs. If that ever shows in a profile, add a `Rope` adapter instead
//!   of touching the interceptor shape.
//! - Only one writer: the bridge is the sole caller of `apply_lsp_edits` /
//!   `set_selected_range` for attached editors; normal mode keeps the editor
//!   `readonly` so the IME path can never race it (programmatic edits bypass
//!   readonly by design).
//!
//! ## v1 limits (explicit)
//!
//! - `"+`/`"*` registers: `HostContext.clipboard` is `None`, so `"+p` reads
//!   nothing; `clipboard_write` is mirrored out but reads wait for the
//!   clipboard port. Unnamed/yank/delete/named registers are fully local.
//! - `HostIntent::OpenSearch` is ignored: `/` opens nothing yet (search-bar
//!   port pending). `n`/`N`/`*` still work on `state.last_search`.
//! - Visual `Select` paints through the editor's plain selection
//!   (`min..max`); the inclusive last-char nuance and yank flash are
//!   cosmetic layers for a later pass.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{App, ClipboardItem, Entity, Focusable as _, Keystroke, Window};
use gpui_kit::component::input::{EditorState, Redo, Undo};

use super::core::state::Pending;
use super::core::{
    feed, CursorPlan, Execution, HostContext, HostIntent, Key, Mode, Outcome, VimState, Viewport,
};

/// Modes where the engine wants native text handling (typing, IME).
fn inserts_natively(mode: Mode) -> bool {
    matches!(mode, Mode::Insert | Mode::Replace)
}

struct Attachment {
    editor: Entity<EditorState>,
    vim: VimState,
}

/// An observer told about a mode change right after the key that made it
/// (`Mode` on the left is the mode the editor was in before).
type ModeObserver = Rc<dyn Fn(Mode, &mut App)>;

/// App-wide vim bridge. Cheap to clone (shares the attachment list); the
/// interceptor closure holds one, the host keeps another to attach editors
/// and to read the current mode for the status bar.
#[derive(Clone)]
pub struct VimBridge {
    attachments: Rc<RefCell<Vec<Attachment>>>,
    shiftwidth: usize,
    /// Told when an attached editor's mode changes (the IME follow's trigger:
    /// Esc back to normal moves neither text nor caret, so no editor event
    /// fires for it).
    mode_observer: Rc<RefCell<Option<ModeObserver>>>,
}

impl VimBridge {
    /// Register the keystroke interceptor. Call once, before opening windows.
    pub fn init(cx: &mut App) -> Self {
        let bridge = Self {
            attachments: Rc::new(RefCell::new(Vec::new())),
            shiftwidth: 4,
            mode_observer: Rc::new(RefCell::new(None)),
        };
        let handled = bridge.clone();
        // The subscription lives as long as the app; the bridge itself is
        // held by the caller.
        let _subscription = cx.intercept_keystrokes(move |event, window, cx| {
            handled.on_keystroke(&event.keystroke, window, cx);
        });
        bridge
    }

    /// Make an editor modal: attach its vim state and start in Normal mode
    /// (readonly, so a stray IME event cannot edit behind vim's back).
    pub fn attach(&self, editor: Entity<EditorState>, cx: &mut App) {
        {
            let mut list = self.attachments.borrow_mut();
            if list.iter().any(|a| a.editor == editor) {
                return;
            }
            list.push(Attachment { editor: editor.clone(), vim: VimState::new() });
        }
        editor.update(cx, |state, cx| state.set_readonly(true, cx));
    }

    pub fn detach(&self, editor: &Entity<EditorState>) {
        self.attachments.borrow_mut().retain(|a| &a.editor != editor);
    }

    /// Observe mode changes (one observer; the shell has one editor).
    pub fn set_mode_observer(&self, observer: impl Fn(Mode, &mut App) + 'static) {
        *self.mode_observer.borrow_mut() = Some(Rc::new(observer));
    }

    /// Current mode of an attached editor (status-bar indicator).
    pub fn mode_of(&self, editor: &Entity<EditorState>) -> Option<Mode> {
        self.attachments
            .borrow()
            .iter()
            .find(|a| &a.editor == editor)
            .map(|a| a.vim.mode)
    }

    /// Forget per-buffer state that does not survive a buffer swap (the host
    /// calls this when it replaces the editor's text wholesale). Registers
    /// are deliberately kept — vim registers span files.
    pub fn reset(&self, editor: &Entity<EditorState>) {
        if let Some(att) = self
            .attachments
            .borrow_mut()
            .iter_mut()
            .find(|a| &a.editor == editor)
        {
            att.vim.pending = Pending::None;
            att.vim.curswant = None;
            att.vim.mode = Mode::Normal;
        }
    }

    fn on_keystroke(&self, ks: &Keystroke, window: &mut Window, cx: &mut App) {
        let Some(key) = translate(ks) else {
            return; // chords outside vim's vocabulary pass through
        };
        let editor = {
            let list = self.attachments.borrow();
            list.iter()
                .find(|a| a.editor.read(cx).focus_handle(cx).is_focused(window))
                .map(|a| a.editor.clone())
        };
        let Some(editor) = editor else { return };

        // Snapshot the document once; the pure core addresses it by byte.
        let (text, cursor, selection) = {
            let state = editor.read(cx);
            (state.text().to_string(), state.cursor(), state.selected_range())
        };
        let ctx = HostContext {
            cursor,
            selection,
            viewport: Viewport { first_line: 0, last_line: 1_000_000 },
            shiftwidth: self.shiftwidth,
            clipboard: None,
        };

        let (outcome, mode_before, mode_after) = {
            let mut list = self.attachments.borrow_mut();
            let att = list.iter_mut().find(|a| a.editor == editor).expect("attached");
            let before = att.vim.mode;
            let outcome = feed(&mut att.vim, &text, key, &ctx);
            let after = att.vim.mode;
            (outcome, before, after)
        };
        // The observer runs outside the attachment borrow: it re-enters this
        // bridge (`mode_of`) and must not see it locked.
        if mode_before != mode_after {
            let observer = self.mode_observer.borrow().clone();
            if let Some(observer) = observer {
                observer(mode_after, cx);
            }
        }

        match outcome {
            Outcome::Executed(exec) => {
                cx.stop_propagation();
                apply_execution(&editor, &exec, window, cx);
            }
            Outcome::Pending => {
                // A multi-key sequence is in flight (operator, count, find,
                // …): the key belongs to vim.
                cx.stop_propagation();
            }
            Outcome::Unhandled => {
                // Insert-mode typing etc.: let the engine handle it natively.
            }
        }
    }
}

/// Apply one executed command to the editor: edits (descending), cursor,
/// mode gating, clipboard/host intents.
fn apply_execution(editor: &Entity<EditorState>, exec: &Execution, window: &mut Window, cx: &mut App) {
    editor.update(cx, |state, cx| {
        if !exec.edits.is_empty() {
            let text = state.text().to_string();
            let mut edits: Vec<lsp_types::TextEdit> = exec
                .edits
                .iter()
                .map(|e| lsp_types::TextEdit {
                    range: lsp_types::Range {
                        start: crate::apply_ops::to_lsp_pos(&text, e.range.start),
                        end: crate::apply_ops::to_lsp_pos(&text, e.range.end),
                    },
                    new_text: e.text.clone(),
                })
                .collect();
            // The engine re-derives offsets per edit against the live text,
            // so apply highest-offset-first to keep earlier positions valid.
            edits.sort_by(|a, b| {
                (b.range.start.line, b.range.start.character)
                    .cmp(&(a.range.start.line, a.range.start.character))
            });
            state.apply_lsp_edits(&edits, window, cx);
        }

        if let Some(cursor) = &exec.cursor {
            let range = match cursor {
                CursorPlan::Collapse(pos) => *pos..*pos,
                CursorPlan::Select { anchor, head } => (*anchor).min(*head)..(*anchor).max(*head),
            };
            state.set_selected_range(range, cx);
        }

        if let Some(mode) = exec.mode_after {
            state.set_readonly(!inserts_natively(mode), cx);
        }

        for intent in &exec.host_intents {
            match intent {
                HostIntent::Undo => window.dispatch_action(Box::new(Undo), cx),
                HostIntent::Redo => window.dispatch_action(Box::new(Redo), cx),
                // The search-bar port is pending; `n`/`N` still work on the
                // last query.
                HostIntent::OpenSearch => {}
            }
        }
    });

    if let Some(text) = exec.clipboard_write.clone() {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }
    // `exec.flash` (yank feedback) is a paint-layer feature; deferred.
}

/// GPUI keystroke → the core's normalized key. Printable characters ride
/// `key_char` (the produced char: shift+a → 'A', layout-faithful `$`/`%`).
fn translate(ks: &Keystroke) -> Option<Key> {
    let m = ks.modifiers;
    if m.platform || m.function {
        return None; // cmd-* shortcuts belong to the app
    }
    if m.control {
        if m.alt {
            return None;
        }
        return match ks.key.as_str() {
            "r" => Some(Key::CtrlR),
            "a" => Some(Key::CtrlA),
            "x" => Some(Key::CtrlX),
            "o" => Some(Key::CtrlO),
            _ => None,
        };
    }
    if m.alt {
        return None; // option chords are not vim input in v1
    }
    match ks.key.as_str() {
        "escape" => Some(Key::Escape),
        "enter" => Some(Key::Enter),
        "backspace" => Some(Key::Backspace),
        "delete" => Some(Key::Delete),
        "tab" => Some(Key::Tab),
        "up" => Some(Key::Up),
        "down" => Some(Key::Down),
        "left" => Some(Key::Left),
        "right" => Some(Key::Right),
        _ => {
            let chars = ks.key_char.as_deref()?;
            let mut it = chars.chars();
            let c = it.next()?;
            if it.next().is_some() {
                return None; // a composed multi-char sequence: not vim input
            }
            Some(Key::Char(c))
        }
    }
}
