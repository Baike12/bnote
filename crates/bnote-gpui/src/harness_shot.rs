//! The pixel channel of the debug harness (`DEBUGGING.md`): a script-driven
//! headless run of the real shell — real `Workspace`, real bridges, real
//! key dispatch — that writes one PNG per `shot` step. The window is created
//! `show: false, focus: false` on a headless platform and Metal renders to a
//! texture: nothing appears on screen, no focus is taken, the user keeps
//! working. This is how a debug session *sees* the app instead of only
//! asserting on its state.
//!
//! ```text
//! cargo run --features harness-shot -- --harness-shot script.json [out-dir]
//! ```
//!
//! Script shape (`/tmp/bnote-harness-shots` is the default out dir; the
//! throwaway vault is printed so its disk bytes can be checked too):
//!
//! ```json
//! {
//!   "size": [1200, 800], "theme": "dark", "vim": true,
//!   "files": { "note.md": "# 标题\n\n正文" }, "open": "note.md",
//!   "steps": [
//!     { "type": "i你好" }, { "key": "escape" }, { "chord": "cmd-shift-o" },
//!     { "cursor": 5 }, { "waitMs": 300 }, { "shot": "01-after-esc" }
//!   ]
//! }
//! ```
//!
//! One step may combine fields; they run in order: `doc` (replace the
//! note's text) → `open` (load a vault file) → `cursor` (byte offset) →
//! `type` (key-char typing) → `key`/`chord` (parsed keystroke) → `waitMs`
//! (simulated clock + real time, for autosave/image decode) → `shot`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context as _};
use gpui::{App, AppContext as _, Keystroke, Pixels, Size, px, size};
use gpui_kit::HeadlessAppContext;
use gpui_kit::assets::Assets as KitAssets;
use gpui_kit::component::theme::{Theme, ThemeMode};

use crate::editor::snippets_host::SnippetBridge;
use crate::editor::vim::integration::VimBridge;
use crate::theme;
use crate::workspace::Workspace;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Script {
    #[serde(default = "default_size")]
    size: [f32; 2],
    theme: Option<String>,
    #[serde(default = "default_true")]
    vim: bool,
    vault: Option<String>,
    files: Option<BTreeMap<String, String>>,
    open: Option<String>,
    #[serde(default)]
    steps: Vec<Step>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    doc: Option<String>,
    open: Option<String>,
    cursor: Option<usize>,
    #[serde(rename = "type")]
    typ: Option<String>,
    key: Option<String>,
    chord: Option<String>,
    #[serde(rename = "waitMs")]
    wait_ms: Option<u64>,
    shot: Option<String>,
}

fn default_size() -> [f32; 2] {
    [1200.0, 800.0]
}
fn default_true() -> bool {
    true
}

/// Run the script; returns the out dir on success (for the caller to print).
pub fn run(script_path: &str, out_dir: Option<&str>) -> anyhow::Result<PathBuf> {
    let script_text = std::fs::read_to_string(script_path)
        .with_context(|| format!("reading the script {script_path}"))?;
    let script: Script =
        serde_json::from_str(&script_text).context("parsing the script")?;

    let out = PathBuf::from(out_dir.unwrap_or("/tmp/bnote-harness-shots"));
    std::fs::create_dir_all(&out).context("creating the out dir")?;

    // A throwaway vault + data dir: the shot run must never share state with
    // the user's running app (same rule as the test fixtures).
    let tag = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let vault = match &script.vault {
        Some(path) => PathBuf::from(path),
        None => std::env::temp_dir().join(format!("bnote-shot-vault-{tag}")),
    };
    std::fs::create_dir_all(&vault).context("creating the vault")?;
    if let Some(files) = &script.files {
        for (rel, text) in files {
            let abs = vault.join(rel);
            if let Some(dir) = abs.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(abs, text)?;
        }
    }

    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(KitAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        let mode = match script.theme.as_deref() {
            Some("light") => ThemeMode::Light,
            _ => ThemeMode::Dark,
        };
        Theme::change(mode, None, cx);
        theme::apply(mode, cx);
    });

    // Same app-data layout as the real shell but inside the throwaway dir.
    let data_dir = std::env::temp_dir().join(format!("bnote-shot-data-{tag}"));
    std::fs::create_dir_all(&data_dir).context("creating the data dir")?;
    let (state, rx) = bnote_core::state::AppState::new(data_dir);

    let vault_for_window = vault.clone();
    let size: Size<Pixels> = size(px(script.size[0]), px(script.size[1]));
    let vim = script.vim;

    // The snippet bridge registers its interceptor FIRST (same order the
    // real shell uses: snippets read the vim mode before vim sees the key).
    let (snippet_bridge, vim_bridge) =
        cx.update(|cx| (SnippetBridge::init(cx), VimBridge::init(cx)));

    let handle = HeadlessAppContext::open_window(&mut cx, size, move |window, cx| {
        let ws = cx.new(|cx| {
            Workspace::new(
                state,
                rx,
                Some(vault_for_window),
                vim_bridge,
                snippet_bridge,
                crate::dev_services::inert_ime(),
                crate::dev_services::inert_lsp(),
                window,
                cx,
            )
        });
        if vim {
            ws.update(cx, |ws, cx| ws.debug_set_vim(true, cx));
        }
        ws
    })?;
    let workspace = cx.update(|cx| handle.entity(cx)).context("the workspace entity")?;
    let handle = handle.into();
    cx.run_until_parked();

    // Open the scripted note only after the vault settle pass: `vault_root`
    // is filled by the async restore, and a load before it would early-return.
    if let Some(rel) = &script.open {
        cx.update_window(handle, |_, window, cx| {
            workspace.update(cx, |ws, cx| ws.debug_load_note(rel, window, cx));
        })
        .context("opening the scripted note")?;
        cx.run_until_parked();
    }

    for (index, step) in script.steps.iter().enumerate() {
        cx.update_window(handle, |_view, window, cx| {
            apply_step(step, &workspace, window, cx);
        })
        .with_context(|| format!("step {index}"))?;
        if let Some(ms) = step.wait_ms {
            // Both clocks: the simulated one fires timers (autosave), a real
            // nap lets background threads (image decode) finish.
            cx.advance_clock(Duration::from_millis(ms));
            cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(ms.min(2_000)));
            cx.run_until_parked();
        }
        if let Some(name) = &step.shot {
            cx.run_until_parked();
            cx.update_window(handle, |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })
            .context("the shot draw")?;
            let image = cx.capture_screenshot(handle).context("the capture")?;
            let path = out.join(format!("{name}.png"));
            image.save(&path).with_context(|| format!("saving {}", path.display()))?;
            println!("shot: {}", path.display());
        }
    }

    println!("vault: {}", vault.display());
    Ok(out)
}

fn apply_step(step: &Step, workspace: &gpui::Entity<Workspace>, window: &mut gpui::Window, cx: &mut App) {
    if let Some(doc) = &step.doc {
        workspace.update(cx, |ws, cx| ws.debug_set_doc(doc, window, cx));
    }
    if let Some(rel) = &step.open {
        workspace.update(cx, |ws, cx| ws.debug_load_note(rel, window, cx));
    }
    if let Some(byte) = step.cursor {
        workspace.update(cx, |ws, cx| ws.debug_set_cursor(byte, cx));
    }
    if let Some(text) = &step.typ {
        for c in text.chars() {
            let key = c.to_string();
            window.dispatch_keystroke(
                Keystroke {
                    modifiers: Default::default(),
                    key: key.clone(),
                    key_char: Some(key),
                },
                cx,
            );
        }
    }
    if let Some(chord) = step.key.as_deref().or(step.chord.as_deref()) {
        let ks = Keystroke::parse(chord)
            .unwrap_or_else(|e| panic!("bad keystroke {chord:?}: {e}"));
        window.dispatch_keystroke(ks, cx);
    }
}
