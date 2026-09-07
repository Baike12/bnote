mod commands;
mod state;

use std::path::PathBuf;
use std::sync::RwLock;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            });
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
