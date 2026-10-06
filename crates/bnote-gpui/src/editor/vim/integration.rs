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

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use gpui::{App, ClipboardItem, Entity, Focusable as _, Keystroke, Window};
use gpui_kit::component::input::{Backspace, Delete, EditorState, Enter, Redo, Undo};

use super::core::state::Pending;
use super::core::{
    feed_apply, CursorPlan, Execution, HostContext, HostIntent, Key, Mode, Outcome, VimState,
    Viewport,
};
use super::vimrc::{MapMode, Mapping, Mappings, Resolution};

/// How long a held mapping prefix waits for its next key before the buffer is
/// replayed literally (vim's `timeoutlen`).
const MAPPING_TIMEOUT: Duration = Duration::from_millis(1000);
/// Recursion cap for remappable right-hand sides (`map a b`, `map b c`, …).
const MAPPING_DEPTH: u32 = 4;

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
/// The mapping layer's mutable state, shared by every clone of the bridge.
/// One buffer for the whole app: at most one editor is focused, and a mode
/// change or focus change clears it.
#[derive(Default)]
struct MappingState {
    table: Mappings,
    /// Keys held while they may still extend a mapping.
    pending: Vec<Key>,
    /// Bumped whenever the buffer changes: a stale timeout must not flush.
    generation: u64,
}

/// What `set_vimrc` installed, for the settings page and the status bar.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct VimrcReport {
    pub mappings: usize,
    pub errors: Vec<String>,
    pub clipboard_unnamed: bool,
}

#[derive(Clone)]
pub struct VimBridge {
    attachments: Rc<RefCell<Vec<Attachment>>>,
    shiftwidth: usize,
    /// `vimrc` mappings (global file first, the vault's `.bnote/vimrc` after).
    mappings: Rc<RefCell<MappingState>>,
    /// `set clipboard=unnamed`: the unnamed register tracks the system
    /// clipboard in both directions.
    clipboard_unnamed: Rc<Cell<bool>>,
    /// Told about a mapping the shell cannot run (unknown command id).
    message_observer: Rc<RefCell<Option<Rc<dyn Fn(String, &mut App)>>>>,
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
            mappings: Rc::new(RefCell::new(MappingState::default())),
            clipboard_unnamed: Rc::new(Cell::new(false)),
            message_observer: Rc::new(RefCell::new(None)),
            mode_observer: Rc::new(RefCell::new(None)),
        };
        let handled = bridge.clone();
        // The interceptor lives as long as the app. `detach` is what makes
        // that true: dropping the returned `Subscription` would unsubscribe
        // immediately (its `Drop` runs the unsubscribe closure), and this
        // function is where that drop would happen.
        cx.intercept_keystrokes(move |event, window, cx| {
            handled.on_keystroke(&event.keystroke, window, cx);
        })
        .detach();
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

    /// Observe a mapping the shell cannot run (an unknown command id).
    pub fn set_message_observer(&self, observer: impl Fn(String, &mut App) + 'static) {
        *self.message_observer.borrow_mut() = Some(Rc::new(observer));
    }

    /// Replace the mapping table from the two vimrc sources — the global file
    /// first, then the vault's (which wins for the same mode + lhs, the TS
    /// shell's load order). Returns the summary the settings page reports.
    pub fn set_vimrc(&self, global: Option<&str>, vault: Option<&str>) -> VimrcReport {
        let mut report = VimrcReport::default();
        {
            let mut state = self.mappings.borrow_mut();
            state.table.clear();
            state.pending.clear();
            state.generation += 1;
        }
        for source in [global, vault].into_iter().flatten() {
            let parsed = super::vimrc::parse_vimrc(source);
            report.mappings += parsed.mappings.len();
            report.errors.extend(parsed.errors);
            if parsed.clipboard_unnamed {
                report.clipboard_unnamed = true;
            }
            self.mappings.borrow_mut().table.install(&parsed.mappings);
        }
        self.clipboard_unnamed.set(report.clipboard_unnamed);
        report
    }

    /// True when any mapping is installed (the keystroke path's fast gate).
    pub fn has_mappings(&self) -> bool {
        !self.mappings.borrow().table.is_empty()
    }

    /// Drop a held mapping prefix (the host calls this when the editor loses
    /// focus or the document is swapped under it).
    pub fn clear_pending_mapping(&self) {
        let mut state = self.mappings.borrow_mut();
        if !state.pending.is_empty() {
            state.pending.clear();
            state.generation += 1;
        }
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

    /// The mode the mapping table resolves against. The engine's visual modes
    /// collapse into `Visual`; replace maps with `Normal` (vim has no
    /// `rmap` — `map` covers normal, which is what CM-vim does too).
    fn current_mode(&self, editor: &Entity<EditorState>) -> Option<Mode> {
        let list = self.attachments.borrow();
        list.iter().find(|a| &a.editor == editor).map(|a| a.vim.mode)
    }

    fn map_mode(mode: Mode) -> MapMode {
        match mode {
            Mode::Insert => MapMode::Insert,
            Mode::Normal | Mode::Replace => MapMode::Normal,
            Mode::Visual | Mode::VisualLine | Mode::VisualBlock => MapMode::Visual,
        }
    }

    /// One keystroke through the mapping table. `true` means the bridge owns
    /// the key (it was held for a longer mapping, or a mapping ran); `false`
    /// means it goes on to the engine — or, in insert mode, to native typing.
    fn map_key(&self, editor: &Entity<EditorState>, key: Key, window: &mut Window, cx: &mut App) -> bool {
        self.map_key_at(editor, key, 0, window, cx)
    }

    /// [`Self::map_key`] with the expansion depth: a remappable right-hand
    /// side re-enters here, and the cap is what stops `map a b` + `map b a`
    /// from recursing forever (vim's `maxmapdepth`).
    fn map_key_at(
        &self,
        editor: &Entity<EditorState>,
        key: Key,
        depth: u32,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        if depth >= MAPPING_DEPTH || !self.has_mappings() {
            return false;
        }
        let Some(mode) = self.current_mode(editor).map(Self::map_mode) else {
            return false;
        };
        let (pending, resolution) = {
            let state = self.mappings.borrow();
            let resolution = state.table.resolve(mode, &state.pending, key);
            (state.pending.clone(), resolution)
        };
        match resolution {
            Resolution::Hold => {
                let mut state = self.mappings.borrow_mut();
                state.pending.push(key);
                state.generation += 1;
                let generation = state.generation;
                drop(state);
                let index = self.attachment_index(editor);
                if let Some(index) = index {
                    self.schedule_mapping_timeout(index, generation, cx);
                }
                cx.stop_propagation();
                true
            }
            Resolution::Fire(ix) => {
                let mapping = self.mappings.borrow().table.entry(ix).cloned();
                self.clear_pending_mapping();
                if let Some(mapping) = mapping {
                    self.run_mapping(&mapping, depth, window, cx);
                }
                cx.stop_propagation();
                true
            }
            Resolution::Literal => {
                if pending.is_empty() {
                    return false;
                }
                // The held keys turned out literal. Vim replays the first one
                // and re-examines the rest, so do exactly that: each key goes
                // back through this function, and only a key that still
                // matches nothing reaches the editor.
                self.clear_pending_mapping();
                for held in pending.into_iter().chain(std::iter::once(key)) {
                    if !self.map_key_at(editor, held, depth, window, cx) {
                        self.deliver_literal(editor, held, window, cx);
                    }
                }
                cx.stop_propagation();
                true
            }
        }
    }

    /// Run a completed mapping: a command id dispatches its action, a key
    /// sequence is replayed (through the mapping table again for `map`,
    /// straight to the editor for `noremap`).
    fn run_mapping(&self, mapping: &Mapping, depth: u32, window: &mut Window, cx: &mut App) {
        if let Some(id) = &mapping.command {
            match crate::commands::action_for(id) {
                Some(action) => window.dispatch_action(action, cx),
                None => {
                    let message = format!("vimrc: 未知命令 {id}");
                    let observer = self.message_observer.borrow().clone();
                    if let Some(observer) = observer {
                        observer(message, cx);
                    }
                }
            }
            return;
        }
        let editor = {
            let list = self.attachments.borrow();
            list.iter()
                .find(|a| a.editor.read(cx).focus_handle(cx).is_focused(window))
                .map(|a| a.editor.clone())
        };
        let Some(editor) = editor else { return };
        for key in &mapping.rhs {
            if !mapping.noremap && self.map_key_at(&editor, *key, depth, window, cx) {
                continue;
            }
            self.deliver_literal(&editor, *key, window, cx);
        }
    }

    /// Send one key to the editor: the engine where it has a meaning, native
    /// editing where insert mode's typing belongs to the platform.
    fn deliver_literal(&self, editor: &Entity<EditorState>, key: Key, window: &mut Window, cx: &mut App) {
        let mode = self.current_mode(editor).unwrap_or(Mode::Normal);
        if inserts_natively(mode) {
            match key {
                Key::Char(c) => {
                    editor.update(cx, |state, cx| state.insert(c.to_string(), window, cx));
                    return;
                }
                Key::Enter => {
                    window.dispatch_action(
                        Box::new(Enter { secondary: false, shift: false }),
                        cx,
                    );
                    return;
                }
                Key::Backspace => {
                    window.dispatch_action(Box::new(Backspace), cx);
                    return;
                }
                Key::Delete => {
                    window.dispatch_action(Box::new(Delete), cx);
                    return;
                }
                _ => {}
            }
        }
        self.feed_engine(editor, key, window, cx);
    }

    /// The attachment slot of an editor, by identity (no `Entity::read`, so
    /// it is safe to call while that editor is being updated).
    fn attachment_index(&self, editor: &Entity<EditorState>) -> Option<usize> {
        self.attachments.borrow().iter().position(|a| &a.editor == editor)
    }

    /// A held prefix waits `MAPPING_TIMEOUT` for its next key; if none comes,
    /// the buffer is replayed literally (the generation guard drops a timer
    /// whose buffer has moved on).
    ///
    /// The flush runs inside the editor's own `update_in` — the one way an
    /// async task gets a `Window` — so the engine work goes through the
    /// attachment slot it captured (taken by index: reading the editor entity
    /// from inside its own update would re-enter it).
    fn schedule_mapping_timeout(&self, index: usize, generation: u64, cx: &mut App) {
        let bridge = self.clone();
        let Some(weak) = self.attachments.borrow().get(index).map(|a| a.editor.downgrade()) else {
            return;
        };
        cx.spawn(async move |cx: &mut gpui::AsyncApp| {
            cx.background_executor().timer(MAPPING_TIMEOUT).await;
            let pending = {
                let state = bridge.mappings.borrow();
                if state.generation != generation || state.pending.is_empty() {
                    return;
                }
                state.pending.clone()
            };
            bridge.clear_pending_mapping();
            let _ = weak.update_in(cx, |state, window, cx| {
                for key in pending {
                    bridge.deliver_with_window(index, state, key, window, cx);
                }
            });
        })
        .detach();
    }

    /// [`Self::deliver_literal`] for the timed flush: the editor's state is
    /// already borrowed, so everything goes through it directly.
    fn deliver_with_window(
        &self,
        index: usize,
        state: &mut EditorState,
        key: Key,
        window: &mut Window,
        cx: &mut gpui::Context<EditorState>,
    ) {
        let mode = self
            .attachments
            .borrow()
            .get(index)
            .map(|a| a.vim.mode)
            .unwrap_or(Mode::Normal);
        if inserts_natively(mode) {
            match key {
                Key::Char(c) => {
                    state.insert(c.to_string(), window, cx);
                    return;
                }
                Key::Enter => {
                    window.dispatch_action(Box::new(Enter { secondary: false, shift: false }), cx);
                    return;
                }
                Key::Backspace => {
                    window.dispatch_action(Box::new(Backspace), cx);
                    return;
                }
                Key::Delete => {
                    window.dispatch_action(Box::new(Delete), cx);
                    return;
                }
                _ => {}
            }
        }
        // The engine paths (Escape leaving insert, normal-mode work).
        let cursor = state.cursor();
        let selection = state.selected_range();
        let viewport = state
            .visible_row_range()
            .map(|rows| Viewport {
                first_line: rows.start,
                last_line: rows.end.saturating_sub(1),
            })
            .unwrap_or(Viewport { first_line: 0, last_line: 1_000_000 });
        let text = state.text().to_string();
        let ctx = HostContext {
            cursor,
            selection,
            viewport,
            shiftwidth: self.shiftwidth,
            clipboard: None,
        };
        let (outcome, mode_before, mode_after) = {
            let mut list = self.attachments.borrow_mut();
            let Some(att) = list.get_mut(index) else { return };
            let before = att.vim.mode;
            let outcome = feed_apply(&mut att.vim, &text, key, &ctx);
            (outcome, before, att.vim.mode)
        };
        if mode_before != mode_after {
            let observer = self.mode_observer.borrow().clone();
            if let Some(observer) = observer {
                observer(mode_after, cx);
            }
        }
        if let Outcome::Executed(exec) = outcome {
            apply_execution_state(state, &exec, window, cx);
        }
    }

    fn on_keystroke(&self, ks: &Keystroke, window: &mut Window, cx: &mut App) {
        // While the settings modal captures a keystroke the chord belongs to
        // the hotkey, not to the note.
        if crate::keybindings::HotkeyCaptureActive::active(cx) {
            return;
        }
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

        // The mapping layer runs before the engine (and before native typing,
        // which is what lets `imap jj <Esc>` hold a lone `j`).
        if self.map_key(&editor, key, window, cx) {
            return;
        }

        self.feed_engine(&editor, key, window, cx);
    }

    /// The engine path of one keystroke: snapshot, feed, apply. `stop_propagation`
    /// is what keeps vim's keys away from action dispatch and native typing.
    fn feed_engine(&self, editor: &Entity<EditorState>, key: Key, window: &mut Window, cx: &mut App) {
        let editor = editor.clone();
        // Snapshot the document once; the pure core addresses it by byte.
        let (text, cursor, selection) = {
            let state = editor.read(cx);
            (state.text().to_string(), state.cursor(), state.selected_range())
        };
        // The real viewport: half/full-page scrolling and H/M/L need the
        // lines the last painted frame showed, not the whole document.
        let viewport = editor
            .read(cx)
            .visible_row_range()
            .map(|rows| Viewport {
                first_line: rows.start,
                last_line: rows.end.saturating_sub(1),
            })
            .unwrap_or(Viewport { first_line: 0, last_line: 1_000_000 });
        let ctx = HostContext {
            cursor,
            selection,
            viewport,
            shiftwidth: self.shiftwidth,
            clipboard: None,
        };

        let (outcome, mode_before, mode_after) = {
            let mut list = self.attachments.borrow_mut();
            let att = list.iter_mut().find(|a| a.editor == editor).expect("attached");
            let before = att.vim.mode;
            let outcome = feed_apply(&mut att.vim, &text, key, &ctx);
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
        apply_execution_state(state, exec, window, cx)
    });
}

/// The body of [`apply_execution`], against an already-borrowed state — the
/// timed mapping flush runs inside the editor's own update and cannot
/// re-enter it.
fn apply_execution_state(
    state: &mut EditorState,
    exec: &Execution,
    window: &mut Window,
    cx: &mut gpui::Context<EditorState>,
) {
    {
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
    }

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
        // Every ctrl chord reaches the core: the engine acts on the ones it
        // knows (C-r/C-a/C-x/C-o/C-d/C-u/C-f/C-b) and reports the rest as
        // `Unhandled`, so the app's keymap still sees them — and a `vimrc`
        // mapping like `<C-s>` has something to match against.
        let mut chars = ks.key.chars();
        return match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_alphabetic() => Some(Key::Ctrl(c.to_ascii_lowercase())),
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
