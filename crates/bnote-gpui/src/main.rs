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
mod keybindings;
mod daily_host;
mod dev_services;
mod editor;
mod footprint_host;
mod footprint_zone;
#[cfg(test)]
mod harness;
#[cfg(feature = "harness-shot")]
mod harness_shot;
mod ime_host;
mod python_lsp;
mod theme;
mod workspace;

use std::path::PathBuf;

use bnote_core::state::AppState;
use gpui::{
    App, AppContext as _, Bounds, TitlebarOptions, WindowBounds, WindowOptions, px,
    point, size,
};
use gpui_kit::assets::Assets;
use gpui_kit::component::theme::{Theme, ThemeMode};
use editor::snippets_host::SnippetBridge;
use editor::vim::integration::VimBridge;
use workspace::Workspace;

/// The Tauri shell's app-data dir: macOS derives it from the bundle
/// identifier (`src-tauri/tauri.conf.json`), which is `com.bnote.app`. Both
/// shells therefore share one `config.json` (last vault, theme, settings),
/// `keybindings.json`, `vimrc` and `agent.json`.
fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BNOTE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join("Library/Application Support/com.bnote.app")
}

/// The `settings.theme` the Tauri shell writes ("dark" | "light"), dark by
/// default and on anything unrecognized.
fn theme_mode() -> ThemeMode {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let path = PathBuf::from(home)
        .join("Library/Application Support/com.bnote.app")
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
    // The headless screenshot channel runs instead of the app: a scripted
    // off-screen run that writes PNGs (DEBUGGING.md). Release builds don't
    // even compile it.
    #[cfg(feature = "harness-shot")]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.len() >= 3 && args[1] == "--harness-shot" {
            match harness_shot::run(&args[2], args.get(3).map(String::as_str)) {
                Ok(dir) => println!("out: {}", dir.display()),
                Err(e) => {
                    eprintln!("harness-shot failed: {e:#}");
                    std::process::exit(1);
                }
            }
            return;
        }
    }

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

            let (state, rx) = AppState::new(data_dir());


            // Restore the last vault (Tauri shell writes the same key). The
            // diagnostic channel overrides it so a probe run never touches the
            // user's vault.
            let last_vault = std::env::var("BNOTE_DIAG_VAULT")
                .ok()
                .or_else(|| {
                    bnote_core::commands::config::load_app_config(&state)
                        .ok()
                        .and_then(|cfg| {
                            cfg.get("lastVault")
                                .and_then(|v| v.as_str())
                                .map(String::from)
                        })
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
            let opened = gpui_kit::open_window(options, cx, move |window, cx| {
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

            // Diagnostic channel (`harness-shot` builds only, `BNOTE_DIAG_VAULT`
            // set at runtime): a real window on the real macOS platform, driven
            // by synthetic keystrokes injected after the vault settles — the
            // platform layer a TestWindow cannot exercise. The workspace
            // schedules its own phases (it owns the window context).
            let _ = opened;

            cx.activate(true);
        });
}
