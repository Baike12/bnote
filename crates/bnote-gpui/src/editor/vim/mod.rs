//! Vim-mode engine for the bnote GPUI shell.
//!
//! Layering follows Zed's `crates/vim` design, trimmed to what a single-cursor
//! markdown editor needs: a **pure state machine** (`core`, zero gpui
//! dependencies, drives edits through an [`core::Outcome`] plan) plus a thin
//! **adapter** ([`adapter`]) that implements the core's text abstraction over
//! gpui-kit's `Rope` and applies outcomes to `EditorState`.
//!
//! # Key-event seam (investigated, see `core::exec` for the consumer)
//!
//! Facts established by reading gpui-pre 0.3.8 and gpui-kit sources (paths are
//! relative to the cargo registry checkout `gpui-pre-0.3.8/` unless noted):
//!
//! 1. gpui-kit's `InputBaseState` renders a div with `.key_context("Input")`
//!    (gpui-kit `crates/base/src/input/base/state.rs:4463`, `CONTEXT` at
//!    `:133`) and registers `.on_action` listeners only for named editing
//!    actions — backspace, enter, arrows, undo, … (`state.rs:4464-4542`).
//!    Printable characters have **no** bindings, so nothing intercepts them
//!    at the action layer.
//! 2. Typed text reaches the editor through GPUI's IME path: macOS AppKit
//!    `interpretKeyEvents` → `insertText:` (gpui-pre-macos-0.3.8
//!    `src/window.rs:258`) → `PlatformInputHandler::dispatch_input`
//!    (`src/platform.rs:2037`) → `EntityInputHandler::replace_text_in_range`
//!    (`state.rs:3976`). That impl returns early, **silently and without any
//!    event**, when `!is_editable()` (`state.rs:3983-3986`) — there is no
//!    Zed-style `InputIgnored` event to observe.
//! 3. Every `KeyDownEvent` flows through `Window::dispatch_key_event`
//!    (`src/window.rs:5871`) in this order:
//!      a. **keystroke interceptors** (`window.rs:5939`, registered via the
//!         public `App::intercept_keystrokes`, `src/app.rs:2465`) — these run
//!         *before* action matching and text input; `cx.stop_propagation()`
//!         inside one consumes the key entirely (its doc comment at
//!         `app.rs:2459-2464` spells this out);
//!      b. binding match against the focused context stack
//!         (`src/key_dispatch.rs:483 dispatch_key`) with native multi-stroke
//!         pending machinery (`window.rs:5962-6015`, `has_pending_keystrokes`
//!         at `window.rs:6174`) — `"g g"`-style bindings are constructible
//!         programmatically via `KeyBinding::new` (`src/keymap/binding.rs:33`,
//!         keystrokes split on whitespace; `App::bind_keys` at
//!         `src/app.rs:2480`). Binding priority: deeper context first, then
//!         later registration wins (`src/keymap.rs:218-221`);
//!      c. matched actions are dispatched (`window.rs:6033-6047`); an action
//!         handler that does *not* call `cx.stop_propagation()` lets dispatch
//!         fall through to the next binding and ultimately to text insertion
//!         (`dispatch_action_on_node_inner`, `window.rs:6351`, only stops when
//!         a listener stops propagation);
//!      d. whatever survives reaches AppKit text insertion.
//! 4. Readonly: `InputBaseState::set_readonly` (`state.rs:1123`) blocks only
//!     user-driven edits (IME path, `state.rs:3983`); programmatic
//!     `insert`/`replace`/`set_selected_range`/`replace_text_in_range` calls
//!     made by the host bypass it via `with_edits_allowed`
//!     (`state.rs:996-1004`) — so normal mode can keep the editor readonly
//!     as belt-and-braces without breaking vim-driven edits.
//!
//! ## Chosen interception design: `App::intercept_keystrokes`
//!
//! [`init`] registers **one** app-wide keystroke interceptor. On every
//! KeyDown it looks up the focused attached editor in a small registry,
//! feeds the keystroke to the pure core ([`core::exec::feed`]), applies the
//! returned [`core::Outcome`] through [`adapter`], and calls
//! `cx.stop_propagation()` for every key the core consumed. In Insert mode
//! the interceptor is *transparent* (returns without stopping propagation),
//! so normal typing, IME composition and gpui-kit's own insert-mode behavior
//! (auto-indent on Enter, …) are untouched.
//!
//! Why not the alternative (a generated `KeyBinding` per keystroke, e.g.
//! `actions!(vim, [KeyA, …])` dispatched in the `"Input"` context)? It is
//! feasible — contexts are plain names the app can bind by, and later
//! registration outranks gpui-kit's defaults — but the bindings would be
//! live in *every* mode and window (quick-open inputs included) and would
//! rely on per-handler pass-through-by-not-stopping-propagation, which is
//! fragile. The mode gate lives in exactly one place with the interceptor.
//! Multi-key sequences (`gg`, `dd`, `f{char}`, operator+motion) are handled
//! by the core's own pending-key state, which — unlike GPUI's binding
//! pending timeout — matches vim semantics: an operator stays pending until
//! the next key, however long.
//!
//! Keys the core does not consume (all chords with ctrl/cmd/alt/function,
//! and printable keys while in Insert mode) fall through unchanged.
//! In Normal/Visual mode the interceptor stops propagation for *every*
//! printable key — vim consumes them; unrecognized ones just do nothing —
//! and the host should additionally keep the editor `set_readonly(true)` in
//! those modes as defense in depth (see fact 4: readonly does not block the
//! vim adapter's programmatic edits).
//!
//! # v1 limitations (explicit)
//!
//! - **Single cursor**: multi-cursor (gpui-kit `selections`, visual-block
//!   `I`/`A`/`c` per line) is out of scope. `Mode::VisualBlock` exists in
//!   the enum but ctrl-v does not enter it.
//! - **`.` repeat of insertions** relies on a passive host hook
//!   ([`VimState::record_insert`]): the adapter observes `InputEvent::Change`
//!   while in Insert mode and records typed text; CJK/IME text records fine
//!   because recording never consumes keys. A `.` with no recorded action
//!   does nothing.
//! - `j`/`k` curswant uses **char columns**; bnote's pixel-accurate
//!   `lastHSPos` anchoring (bnote `src/editor/vim/verticalMotion.ts`) is a
//!   host-level refinement on top of [`core::state::VimState::curswant`].
//! - `R` (Replace mode) overwrites chars and does not restore overwritten
//!   text on exit.
//! - `/` and `?` emit `HostIntent::OpenSearch` and expect the host to feed
//!   matches back via `VimState::set_last_search`; `n`/`N`/`*` search with
//!   plain substring semantics (no regex in hot paths).
//! - Paste is byte-exact: no auto-indent of pasted linewise registers.
//! - Undo grouping is host-side; the core only emits `UndoIntent` hints and
//!   `HostIntent::Undo`/`Redo` for `u`/`ctrl-r`.

pub mod adapter;
pub mod core;
pub mod vimrc;
pub mod integration;
pub mod tests;

#[allow(unused_imports)] // the module's public surface (used by integration)
pub use core::{HostContext, Mode, Outcome, VimState};
