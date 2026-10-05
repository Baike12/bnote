//! Tauri WebView shell over bnote-core.
//!
//! All backend logic lives in `bnote-core`; this crate owns the WebView, the
//! macOS menu, the study-preview child webviews, and forwarding core's event
//! bus to the webview. A second shell (crates/bnote-gpui) consumes the same
//! core without any web layer.

mod commands;
/// Browser-preview bridge; debug builds only (see the module docs).
#[cfg(debug_assertions)]
mod devbridge;
mod study;

use std::path::PathBuf;

use bnote_core::state::AppState;
use tauri::Manager;

/// Menu ids for the items whose key equivalents are deliberately left unset.
#[cfg(target_os = "macos")]
const MENU_QUIT: &str = "menu.quit";
#[cfg(target_os = "macos")]
const MENU_HIDE: &str = "menu.hide";
#[cfg(target_os = "macos")]
const MENU_MINIMIZE: &str = "menu.minimize";
#[cfg(target_os = "macos")]
const MENU_FULLSCREEN: &str = "menu.fullscreen";

/// macOS menu, built by hand so that every key equivalent the app publishes is
/// one we chose.
///
/// AppKit resolves menu key equivalents *before* the webview sees the key: the
/// press is consumed natively and never becomes a DOM `keydown`, so any command
/// bound to that chord (dispatched from `src/commands/globalKeys.ts`) silently
/// never fires. Confirmed empirically on ⌘W in f6b6b44 — with the stock menu
/// disabled the binding started working at once.
///
/// So the rule here is: a chord belongs to bnote's own keybinding layer unless
/// macOS gives us no choice. That costs the app every stock shortcut below,
/// which now reach the DOM and can be bound (or left unbound) in settings:
///
///   ⌘Q  quit              → menu item kept, no key equivalent
///   ⌘H  hide              → menu item kept, no key equivalent
///   ⌘M  minimize          → menu item kept, no key equivalent
///   ⌃⌘F toggle fullscreen → menu item kept, no key equivalent
///   ⌘W  close window      → item dropped entirely (f6b6b44)
///
/// `PredefinedMenuItem` cannot help with this: muda hard-codes its accelerator
/// per item type (`muda-0.19.3/src/items/predefined.rs:317`, `Minimize =>
/// CMD_OR_CTRL + KeyM`) and exposes `set_accelerator` only on plain `MenuItem`
/// (`normal.rs:104`). Hence the four items below are built by hand — the menu
/// stays mouse-reachable, only the chords are given back.
///
/// Two items are dropped rather than rebuilt:
/// - `Hide Others` (⌥⌘H) — no Tauri API for `hideOtherApplications:`, and
///   bnote is a single-window app where it buys nothing.
/// - `Show All`, which only exists to undo `Hide Others`.
///
/// Edit keeps ⌘Z ⌘X ⌘C ⌘V ⌘A on purpose: WKWebView routes the clipboard through
/// those menu items to the `undo:`/`cut:`/`copy:`/`paste:`/`selectAll:`
/// selectors, so removing them would break the clipboard rather than free the
/// chords.
#[cfg(target_os = "macos")]
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };

    let quit = MenuItemBuilder::with_id(MENU_QUIT, format!("Quit {}", pkg.name)).build(app)?;
    let hide = MenuItemBuilder::with_id(MENU_HIDE, format!("Hide {}", pkg.name)).build(app)?;
    let minimize = MenuItemBuilder::with_id(MENU_MINIMIZE, "Minimize").build(app)?;
    let fullscreen =
        MenuItemBuilder::with_id(MENU_FULLSCREEN, "Toggle Full Screen").build(app)?;

    let app_menu = SubmenuBuilder::new(app, pkg.name.clone())
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .item(&hide)
        .separator()
        .item(&quit)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View").item(&fullscreen).build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&minimize)
        .maximize()
        .separator()
        .build()?;
    let help_menu = SubmenuBuilder::new(app, "Help").build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Actions for the key-equivalent-free items `install_menu` builds.
///
/// Quit is the interesting one: it cannot call `AppHandle::exit` directly,
/// because bnote debounces the cursor save and the config write by 300ms
/// (`src/App.tsx`, quit-safety effect) and those flushes live in JS. Exiting
/// from Rust would silently drop whatever the last 300ms held, so the menu
/// hands the request to the frontend, which flushes and then destroys the
/// window — the same path the traffic light's close already takes.
fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Emitter;
        match event.id().as_ref() {
            MENU_QUIT => {
                let _ = app.emit("bnote:menu-quit", ());
            }
            MENU_HIDE => {
                let _ = app.hide();
            }
            MENU_MINIMIZE => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.minimize();
                }
            }
            MENU_FULLSCREEN => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_fullscreen(!win.is_fullscreen().unwrap_or(false));
                }
            }
            _ => {}
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Forwards core's event bus to the webview, preserving the (name, payload)
/// shape the JS side already listens for.
async fn forward_events(
    app: tauri::AppHandle,
    mut rx: tokio::sync::broadcast::Receiver<bnote_core::AppEvent>,
) {
    use tauri::Emitter;
    loop {
        match rx.recv().await {
            Ok(ev) => {
                let _ = app.emit(&ev.name, ev.payload);
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                eprintln!(
                    "[bnote] shell: dropped {} events (webview slower than backend)",
                    n
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .enable_macos_default_menu(false)
        .on_menu_event(handle_menu_event)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir: PathBuf = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir)?;

            let (state, rx) = AppState::new(data_dir);
            app.manage(state);

            // Backend events → webview. The devbridge gets its own receiver
            // (resubscribe) so browser tabs see the same stream.
            #[cfg(debug_assertions)]
            devbridge::spawn(app.handle().clone(), rx.resubscribe());
            tauri::async_runtime::spawn(forward_events(app.handle().clone(), rx));

            #[cfg(target_os = "macos")]
            install_menu(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_vault,
            commands::get_vault,
            commands::read_tree,
            commands::read_dir,
            commands::list_files,
            commands::read_file,
            commands::write_file,
            commands::write_file_base64,
            commands::create_file,
            commands::create_dir,
            commands::ensure_dir,
            commands::rename_path,
            commands::trash_path,
            commands::read_vault_file,
            commands::write_vault_file,
            commands::load_app_config,
            commands::save_app_config,
            commands::load_keybindings,
            commands::save_keybindings,
            commands::read_vimrc,
            commands::save_vimrc,
            commands::list_input_sources,
            commands::get_current_input_source,
            commands::set_input_source,
            commands::agent_get_config,
            commands::agent_save_config,
            commands::agent_start_session,
            commands::agent_send,
            commands::agent_abort,
            commands::agent_get_history,
            commands::agent_set_current_note,
            commands::convert_pdf_to_markdown,
            commands::show_study_preview,
            commands::set_study_preview_bounds,
            commands::set_study_preview_visible,
            commands::close_study_preview,
            commands::open_study_url,
            commands::python_run,
            commands::python_run_cancel,
            commands::python_get_info,
            commands::python_set_project_config,
            commands::python_lsp_sync,
            commands::python_lsp_request,
            commands::python_lsp_close,
            commands::python_lsp_stop_all,
            commands::python_uv_create,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
