//! bnote's native GPUI shell.
//!
//! Same bnote-core backend as the Tauri shell — vault, files, config, events —
//! without a WebView: one Rust process, GPU-rendered UI, no IPC. The editor
//! starts in source mode with Tree-sitter markdown highlighting; the Obsidian-
//! style live preview (hidden marks, embedded formula/image widgets) is the
//! next milestone on the port roadmap.

mod workspace;

use std::path::PathBuf;

use bnote_core::state::AppState;
use gpui::{
    App, AppContext as _, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions, px,
    point, size,
};
use gpui_kit::assets::Assets;
use gpui_kit::component::theme::{Theme, ThemeMode};
use workspace::{Workspace, actions};

/// bnote keeps its own config under the standard app-data dir, shared with the
/// Tauri shell (same `config.json`, so both shells agree on the last vault).
fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join("Library/Application Support/bnote")
}

fn main() {
    gpui_kit::application()
        .with_assets(Assets)
        .run(|cx: &mut App| {
            gpui_kit::init(cx);

            // bnote's own look starts from the built-in themes; the exact
            // palette from src/styles/global.css lands with the theme port.
            Theme::change(ThemeMode::Dark, None, cx);

            cx.bind_keys([
                KeyBinding::new("cmd-s", actions::Save, None),
                KeyBinding::new("cmd-p", actions::QuickOpen, None),
            ]);

            let (state, rx) = AppState::new(data_dir());

            // Restore the last vault (Tauri shell writes the same key).
            let last_vault = bnote_core::commands::config::load_app_config(&state)
                .ok()
                .and_then(|cfg| {
                    cfg.get("lastVault")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                });

            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: point(px(0.), px(0.)),
                    size: size(px(1200.), px(800.)),
                })),
                titlebar: Some(TitlebarOptions {
                    title: Some("bnote".into()),
                    appears_transparent: true,
                    ..Default::default()
                }),
                ..Default::default()
            };

            let vault_for_window = last_vault.map(PathBuf::from);
            let _ = gpui_kit::open_window(options, cx, move |window, cx| {
                cx.new(|cx| Workspace::new(state.clone(), rx.resubscribe(), vault_for_window.clone(), window, cx))
            });

            cx.activate(true);
        });
}
