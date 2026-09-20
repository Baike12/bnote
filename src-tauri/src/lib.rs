pub mod agent;
mod commands;
/// Browser-preview bridge; debug builds only (see the module docs).
#[cfg(debug_assertions)]
mod devbridge;
mod state;

use std::path::PathBuf;
use std::sync::RwLock;

use tauri::Manager;

use state::AppState;

/// macOS menu: Tauri's default menu minus `File → Close Window`.
///
/// Why that one item has to go: it carries ⌘W, and AppKit resolves menu key
/// equivalents *before* the webview ever sees the key — the press is consumed
/// natively and never becomes a DOM `keydown`, so a command bound to ⌘W (here
/// `edit.toggle-todo`) silently never fires. Confirmed empirically: rebuild
/// with the default menu disabled and ⌘W starts working at once.
///
/// The trade-off is deliberate. macOS HIG reserves ⌘W for closing the window,
/// so inside bnote ⌘W is a text-editing command and no longer closes anything
/// — an exception to the platform convention, not an oversight. Closing still
/// works via the traffic light, ⌘Q, and the Window menu. Moving the binding off
/// ⌘W and keeping the stock menu was the alternative; it was rejected because
/// ⌘W has been this command's binding for a long time.
#[cfg(target_os = "macos")]
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};

    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };

    let app_menu = SubmenuBuilder::new(app, pkg.name.clone())
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
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
    let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir: PathBuf = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir)?;

            app.manage(AppState {
                vault: RwLock::new(None),
                watcher: std::sync::Mutex::new(None),
                data_dir,
                sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
                mcp_manager: std::sync::Mutex::new(None),
                current_note: std::sync::Mutex::new(None),
            });

            #[cfg(target_os = "macos")]
            install_menu(app.handle())?;

            // Debug builds also answer on a loopback port so the same UI can be
            // driven from a browser tab (see `devbridge`).
            #[cfg(debug_assertions)]
            devbridge::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault::set_vault,
            commands::vault::get_vault,
            commands::vault::read_tree,
            commands::vault::read_dir,
            commands::vault::list_files,
            commands::files::read_file,
            commands::files::write_file,
            commands::files::write_file_base64,
            commands::files::create_file,
            commands::files::create_dir,
            commands::files::ensure_dir,
            commands::files::rename_path,
            commands::files::trash_path,
            commands::files::read_vault_file,
            commands::files::write_vault_file,
            commands::config::load_app_config,
            commands::config::save_app_config,
            commands::config::load_keybindings,
            commands::config::save_keybindings,
            commands::config::read_vimrc,
            commands::config::save_vimrc,
            commands::ime::list_input_sources,
            commands::ime::get_current_input_source,
            commands::ime::set_input_source,
            commands::agent::agent_get_config,
            commands::agent::agent_save_config,
            commands::agent::agent_start_session,
            commands::agent::agent_send,
            commands::agent::agent_abort,
            commands::agent::agent_get_history,
            commands::agent::agent_set_current_note,
            commands::agent::convert_pdf_to_markdown,
            commands::agent::show_study_preview,
            commands::agent::set_study_preview_bounds,
            commands::agent::set_study_preview_visible,
            commands::agent::close_study_preview,
            commands::agent::open_study_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
