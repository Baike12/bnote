//! The GPUI shell's debug harness — the Tauri shell's `harness.html`, headless.
//!
//! Everything here runs inside `#[gpui::test]`: the window is a pure-memory
//! `TestWindow` (never on screen, `is_active()` always false), keystrokes are
//! dispatched programmatically, and geometry is read back from the painted
//! scene. No screenshots of any real display, no focus taken — debugging
//! happens entirely in the background while the user keeps working.
//!
//! The four layers (full guide in `DEBUGGING.md`):
//! - behavior: a real [`Workspace`] over a throwaway vault with the real vim
//!   and snippet bridges — the end-to-end keystroke path, not mocks;
//! - geometry: `cx.debug_bounds("id")` / `cx.painted_quads()` after a draw,
//!   no rasterization;
//! - pixels: `HeadlessAppContext` + Metal off-screen render (rare, macOS,
//!   see DEBUGGING.md's pixel section);
//! - perf: `gpui-fps` HUD in a dev build, `#[gpui::bench]` for numbers.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use gpui::{AnyWindowHandle, Entity, Focusable as _, Keystroke, TestAppContext, VisualTestContext};

use crate::workspace::Workspace;

/// A throwaway vault + data dir, unique per fixture: the suite runs tests in
/// parallel threads, and the shell reloads state from disk by construction,
/// so a shared pair would let one test's writes land inside another's.
pub struct Fixture {
    pub vault: PathBuf,
    pub data_dir: PathBuf,
    // Keep the dirs alive (and clean them up) for the whole test.
    _vault_dir: tempfile::TempDir,
    _data_dir: tempfile::TempDir,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let tag = format!("{}-{}-{}", tag, std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
        let vault_dir = tempfile::TempDir::with_prefix(format!("bnote-h-vault-{tag}-"))
            .expect("a temp vault");
        let data_dir = tempfile::TempDir::with_prefix(format!("bnote-h-data-{tag}-"))
            .expect("a temp data dir");
        std::fs::create_dir_all(vault_dir.path().join("Daily")).expect("the Daily dir");
        Self {
            vault: vault_dir.path().to_path_buf(),
            data_dir: data_dir.path().to_path_buf(),
            _vault_dir: vault_dir,
            _data_dir: data_dir,
        }
    }

    /// Write a file into the vault (creating parent dirs).
    pub fn write(&self, rel: &str, text: &str) {
        let abs = self.vault.join(rel);
        if let Some(dir) = abs.parent() {
            std::fs::create_dir_all(dir).expect("the parent dir");
        }
        std::fs::write(abs, text).expect("write the file");
    }

    pub fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.vault.join(rel)).expect("read the file")
    }
}

/// Platform seams the headless shell cannot exercise — shared with the
/// scripted-shots binary (`dev_services`).
pub use crate::dev_services::{inert_ime, inert_lsp};

/// A real workspace over a throwaway vault, the editor focused, `note.md`
/// open and empty. `vim` decides whether the shell starts in vim mode (the
/// owner's default; most debugging wants it on).
pub fn note_fixture(
    cx: &mut TestAppContext,
    vim: bool,
) -> (Entity<Workspace>, Fixture, &mut VisualTestContext) {
    let (workspace, fixture, cx) = workspace_fixture_with(cx, |fixture| {
        fixture.write("note.md", "");
        vec!["note.md".to_string()]
    });
    workspace.update_in(cx, |ws, _window, cx| {
        ws.harness_set_vim(vim, cx);
    });
    cx.run_until_parked();
    (workspace, fixture, cx)
}

/// The full fixture with a caller-shaped opening state: `prepare` writes
/// files into the vault and returns the file to open (a real on-disk note so
/// the save paths have something to write).
pub fn workspace_fixture_with(
    cx: &mut TestAppContext,
    prepare: impl FnOnce(&Fixture) -> Vec<String>,
) -> (Entity<Workspace>, Fixture, &mut VisualTestContext) {
    let fixture = Fixture::new("ws");
    let open = prepare(&fixture);
    cx.update(|cx| gpui_kit::init(cx));
    let (state, rx) = bnote_core::state::AppState::new(fixture.data_dir.clone());
    let mut bridges = None;
    cx.update(|cx| {
        bridges = Some((
            crate::editor::snippets_host::SnippetBridge::init(cx),
            crate::editor::vim::integration::VimBridge::init(cx),
        ));
    });
    let (snippet_bridge, vim_bridge) = bridges.expect("the bridges");
    let vault = fixture.vault.clone();
    let open = open.first().cloned();
    let (workspace, cx) = cx.add_window_view(move |window, cx| {
        let mut ws = Workspace::new(
            state.clone(),
            rx.resubscribe(),
            Some(vault.clone()),
            vim_bridge,
            snippet_bridge,
            inert_ime(),
            inert_lsp(),
            window,
            cx,
        );
        if let Some(rel) = open {
            let text = std::fs::read_to_string(vault.join(&rel)).unwrap_or_default();
            ws.harness_load(&rel, &text, window, cx);
        }
        let focus = ws.harness_editor().focus_handle(cx);
        window.focus(&focus, cx);
        ws
    });
    cx.run_until_parked();
    (workspace, fixture, cx)
}

/// The focused window's handle, for the dispatch helpers below.
pub fn window(cx: &mut VisualTestContext) -> AnyWindowHandle {
    cx.update(|window, _| window.window_handle())
}
/// Type text through the real keystroke path. Printable keys must carry
/// `key_char` — the vim adapter and the input handlers read it from there,
/// and only real typing sets it on the platform. The space bar arrives as
/// `key: "space"` with `key_char: " "`, so a literal `' '` is translated.
pub fn press(cx: &mut VisualTestContext, window: AnyWindowHandle, text: &str) {
    for c in text.chars() {
        let (key, key_char) = if c == ' ' {
            ("space".to_string(), " ".to_string())
        } else {
            (c.to_string(), c.to_string())
        };
        cx.dispatch_keystroke(
            window,
            Keystroke {
                modifiers: Default::default(),
                key,
                key_char: Some(key_char),
            },
        );
    }
}

/// One modifier chord ("cmd-s", "shift-cmd-o", "escape", "enter", …).
pub fn chord(cx: &mut VisualTestContext, window: AnyWindowHandle, text: &str) {
    let ks = Keystroke::parse(text).expect("a keystroke");
    cx.dispatch_keystroke(window, ks);
}

/// One paint pass — the precondition for `debug_bounds`/`painted_quads`.
pub fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

/// The open note's text.
pub fn doc(workspace: &Entity<Workspace>, cx: &VisualTestContext) -> String {
    workspace.read_with(cx, |ws, cx| ws.harness_editor().read(cx).value().to_string())
}

/// The focused editor's vim mode (`None` = the editor is not attached).
pub fn mode(
    workspace: &Entity<Workspace>,
    cx: &VisualTestContext,
) -> Option<crate::editor::vim::core::Mode> {
    workspace.read_with(cx, |ws, _| ws.harness_vim().mode_of(ws.harness_editor()))
}

/// The cursor as a byte offset.
pub fn cursor(workspace: &Entity<Workspace>, cx: &VisualTestContext) -> usize {
    workspace.read_with(cx, |ws, cx| ws.harness_editor().read(cx).cursor())
}

/// The open path relative to the vault.
pub fn open_path(workspace: &Entity<Workspace>, cx: &VisualTestContext) -> Option<String> {
    workspace.read_with(cx, |ws, _| ws.harness_open_path().map(str::to_string))
}

/// `cx.debug_bounds` for one element id, after [`draw`]. Part of the
/// harness's geometry layer (`DEBUGGING.md`); a test picks it up when it
/// needs painted bounds (no test reads one right now).
#[allow(dead_code)]
pub fn bounds(cx: &mut VisualTestContext, id: &'static str) -> Option<gpui::Bounds<gpui::Pixels>> {
    cx.debug_bounds(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The harness's own smoke test: a real keystroke path (vim on) through
    /// the real bridges over a throwaway vault, asserting through the
    /// harness helpers. If this breaks, the harness itself is the bug.
    #[gpui::test]
    fn the_harness_types_edits_and_reports(cx: &mut gpui::TestAppContext) {
        let (ws, fixture, mut cx) = note_fixture(cx, true);
        harness_test_body(&ws, &fixture, &mut cx);
    }

    fn harness_test_body(
        ws: &Entity<Workspace>,
        fixture: &Fixture,
        cx: &mut VisualTestContext,
    ) {
        draw(cx);
        let w = window(cx);
        press(cx, w, "ihello world");
        chord(cx, w, "escape");
        // `b` walks back a word, `x` deletes the char under the cursor.
        press(cx, w, "bx");
        assert_eq!(doc(ws, cx), "hello orld", "the keystroke path edits text");
        assert_eq!(cursor(ws, cx), 6, "the caret reads back at `orld`");
        assert_eq!(mode(ws, cx), Some(crate::editor::vim::core::Mode::Normal));
        assert_eq!(open_path(ws, cx).as_deref(), Some("note.md"));
        // The vault is real: a save lands on disk.
        chord(cx, w, "cmd-s");
        cx.run_until_parked();
        assert_eq!(fixture.read("note.md"), "hello orld");
    }
}
