//! bnote's native GPUI shell.
//!
//! Same bnote-core backend as the Tauri shell — vault, files, config, events —
//! without a WebView: one Rust process, GPU-rendered UI, no IPC. The editor
//! starts in source mode with Tree-sitter markdown highlighting; the Obsidian-
//! style live preview (hidden marks, embedded formula/image widgets) is the
//! next milestone on the port roadmap.

mod agent_panel;
mod apply_ops;
mod commands;
mod daily_host;
mod editor;
mod footprint_host;
mod ime_host;
mod python_lsp;
mod theme;
mod workspace;

use std::path::PathBuf;

use bnote_core::state::AppState;
use gpui::{
    App, AppContext as _, Bounds, KeyBinding, TitlebarOptions, WindowBounds, WindowOptions, px,
    point, size,
};
use gpui_kit::assets::Assets;
use gpui_kit::component::theme::{Theme, ThemeMode};
use editor::snippets_host::SnippetBridge;
use editor::vim::integration::VimBridge;
use workspace::{Workspace, keybinding_for};

/// bnote keeps its own config under the standard app-data dir, shared with the
/// Tauri shell (same `config.json`, so both shells agree on the last vault).
fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join("Library/Application Support/bnote")
}

/// The `settings.theme` the Tauri shell writes ("dark" | "light"), dark by
/// default and on anything unrecognized.
fn theme_mode() -> ThemeMode {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let path = PathBuf::from(home)
        .join("Library/Application Support/bnote")
        .join("config.json");
    let mode = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|cfg| {
            cfg.get("settings")
                .and_then(|s| s.get("theme"))
                .and_then(|v| v.as_str())
                .map(String::from)
        });
    match mode.as_deref() {
        Some("light") => ThemeMode::Light,
        _ => ThemeMode::Dark,
    }
}

fn main() {
    gpui_kit::application()
        .with_assets(Assets)
        .run(|cx: &mut App| {
            gpui_kit::init(cx);

            // bnote's own palette (`src/styles/global.css`, transcribed in
            // `theme.rs`): the built-in theme first, then the override — the
            // other way round `Theme::change` would load over the palette.
            // The mode comes from `config.json` (`settings.theme`, the same
            // key the Tauri shell writes; "dark" unless it says "light").
            let mode = theme_mode();
            Theme::change(mode, None, cx);
            theme::apply(mode, cx);

            // Every registry command gets its default keybinding; overrides
            // from keybindings.json arrive with the settings port.
            let bindings: Vec<KeyBinding> = commands::COMMANDS
                .iter()
                .filter_map(|def| def.key.and_then(|key| keybinding_for(def.id, key)))
                .collect();
            cx.bind_keys(bindings);

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

            // The snippet bridge registers its interceptor FIRST: both
            // interceptors run for every key in registration order, and the
            // snippet layer must read the vim mode *before* vim processes the
            // key (see `editor::snippets_host`'s module docs).
            let snippet_bridge = SnippetBridge::init(cx);
            // One app-wide vim bridge; the workspace attaches the editor on
            // ⌘⇧V (bnote's default: off).
            let vim_bridge = VimBridge::init(cx);

            let vault_for_window = last_vault.map(PathBuf::from);
            let _ = gpui_kit::open_window(options, cx, move |window, cx| {
                cx.new(|cx| {
                    Workspace::new(
                        state.clone(),
                        rx.resubscribe(),
                        vault_for_window.clone(),
                        vim_bridge.clone(),
                        snippet_bridge.clone(),
                        ime_host::ImeServices::platform(),
                        python_lsp::PyLspServices::platform(),
                        window,
                        cx,
                    )
                })
            });

            cx.activate(true);
        });
}
