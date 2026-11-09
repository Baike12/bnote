pub mod agent;
mod code;
mod commands;
/// Browser-preview bridge; debug builds only (see the module docs).
#[cfg(debug_assertions)]
mod devbridge;
pub mod dict;
pub mod lsp;
mod paths;
mod state;
pub mod translate;

use std::path::PathBuf;
use std::sync::RwLock;

use tauri::Manager;

use state::AppState;

mod python;
mod term;

/// The app window, looked up by label.
///
/// Never use `get_webview_window` for this. Tauri answers that call only when
/// every webview attached to the window carries the window's own label
/// (`tauri-2.11.5/src/window/mod.rs:1160`, `is_webview_window`), and bnote
/// attaches child webviews ("study-preview", "creative-preview") to this very
/// window for study mode and the agent preview. The lookup therefore returned
/// `None` for as long as a page was open, and focus mode broke on both sides:
/// locking failed with `NO_WINDOW`, and unlocking silently skipped the restore
/// and left the window at level 25 above every other app.
///
/// `get_window` is a plain label lookup on the window table, so child webviews
/// cannot affect it.
pub fn main_window(app: &tauri::AppHandle) -> Option<tauri::Window> {
    app.get_window("main")
}

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
    let fullscreen = MenuItemBuilder::with_id(MENU_FULLSCREEN, "Toggle Full Screen").build(app)?;

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
                if let Some(win) = main_window(app) {
                    let _ = win.minimize();
                }
            }
            MENU_FULLSCREEN => {
                if let Some(win) = main_window(app) {
                    let _ = win.set_fullscreen(!win.is_fullscreen().unwrap_or(false));
                }
            }
            _ => {}
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .enable_macos_default_menu(false)
        .on_menu_event(handle_menu_event)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Inline agent HTML previews: the framed document must come from a
        // non-local scheme, or the app CSP is inherited into it and its inline
        // scripts are blocked (see commands/preview.rs).
        .register_uri_scheme_protocol(commands::preview::SCHEME, |_ctx, request| {
            commands::preview::serve(&request)
        })
        .setup(|app| {
            let data_dir: PathBuf = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir)?;
            // The agent home is the open vault's `.bnote`, and no vault is open
            // yet. It is created, and the legacy configuration is copied into
            // it, when the vault is set (`commands::vault::set_vault`); doing it
            // here would recreate `$HOME/.bnote` on every launch.

            app.manage(AppState {
                vault: RwLock::new(None),
                watcher: std::sync::Mutex::new(None),
                data_dir,
                sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
                current_note: std::sync::Mutex::new(None),
                python_runs: std::sync::Arc::new(python::runner::RunRegistry::new()),
                python_lsp: std::sync::Mutex::new(std::collections::HashMap::new()),
                code_lsp: std::sync::Mutex::new(std::collections::HashMap::new()),
                code_trees: std::sync::Mutex::new(std::collections::HashMap::new()),
                terminals: term::TermManager::new(),
            });

            #[cfg(target_os = "macos")]
            install_menu(app.handle())?;

            // Warm the dictionary on a background thread: the cold decompression
            // (~5-20ms) is paid there, so the first word lookup finds it hot.
            dict::warm_up();

            // Main window geometry: restored before the event loop starts, so the
            // first frame already has the size and position the user left.
            commands::config::restore_window_bounds(app.handle());

            // Focus mode's "steal back on blur" listener: installed once, from
            // then on focus.rs decides for itself whether to pull the window
            // back (it does nothing while focus mode is not locked).
            commands::focus::install_focus_guard(app.handle());

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
            commands::files::read_file_base64,
            commands::files::write_file,
            commands::files::append_file,
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
            commands::focus::focus_status,
            commands::focus::focus_lock,
            commands::focus::focus_unlock,
            commands::focus::focus_set_hard_lock,
            commands::focus::focus_set_hard_lock_active,
            commands::ime::list_input_sources,
            commands::ime::get_current_input_source,
            commands::ime::set_input_source,
            commands::agent::agent_get_config,
            commands::agent::agent_save_config,
            commands::agent::agent_start_session,
            commands::agent::agent_send,
            commands::agent::agent_abort,
            commands::agent::agent_get_history,
            commands::agent::agent_context_breakdown,
            commands::agent::agent_set_current_note,
            commands::agent::agent_list_skills,
            commands::agent::agent_read_skill,
            commands::agent::agent_list_project_files,
            commands::agent::agent_generate_title,
            commands::agent::agent_compact,
            commands::home::agent_home_workspace,
            commands::home::agent_home_sessions_list,
            commands::home::agent_home_read_file,
            commands::home::agent_home_write_file,
            commands::home::agent_home_append_file,
            commands::home::agent_home_set_session_title,
            commands::home::agent_mode_paths,
            commands::home::agent_read_mode_settings,
            commands::home::agent_write_mode_settings,
            commands::home::agent_read_mode_instructions,
            commands::home::agent_write_mode_instructions,
            commands::home::agent_set_mode_root,
            commands::home::agent_output_styles,
            commands::home::agent_history,
            commands::agent::agent_set_permission_mode,
            commands::agent::agent_permission_reply,
            commands::agent::agent_question_reply,
            commands::preview::agent_preview_put,
            commands::bblog::bblog_sections,
            commands::bblog::bblog_publish,
            commands::materials::study_material_ensure,
            commands::materials::study_sessions_list,
            commands::materials::study_session_set_title,
            commands::materials::study_import_pdf,
            commands::agent::show_study_preview,
            commands::agent::set_study_preview_bounds,
            commands::agent::set_study_preview_visible,
            commands::agent::set_study_preview_annotation_mode,
            commands::agent::set_study_preview_translate,
            commands::agent::set_study_preview_read_step,
            commands::agent::set_study_preview_read_keys,
            commands::agent::set_study_preview_shortcuts,
            commands::agent::set_study_preview_zoom,
            commands::agent::focus_study_preview,
            commands::agent::scroll_study_preview,
            commands::agent::merge_study_preview_annotations,
            commands::agent::show_creative_preview,
            commands::agent::set_creative_preview_bounds,
            commands::agent::set_creative_preview_visible,
            commands::agent::close_creative_preview,
            commands::agent::close_study_preview,
            commands::agent::open_study_url,
            commands::translate::translate_selection,
            commands::translate::translate_get_config,
            commands::translate::translate_save_config,
            commands::translate::translate_test,
            commands::python::python_run,
            commands::python::python_run_cancel,
            commands::python::python_get_info,
            commands::python::python_set_project_config,
            commands::python::python_lsp_sync,
            commands::python::python_lsp_request,
            commands::python::python_lsp_close,
            commands::python::python_lsp_stop_all,
            commands::python::python_uv_create,
            commands::code::code_open_project,
            commands::code::code_rescan,
            commands::code::code_read_file,
            commands::code::code_write_file,
            commands::code::code_search,
            commands::code::code_search_files,
            commands::code::code_git_status,
            commands::code::code_git_diff,
            commands::code::code_git_stage,
            commands::code::code_git_unstage,
            commands::code::code_lsp_resolve,
            commands::code::code_lsp_start,
            commands::code::code_lsp_stop,
            commands::code::code_lsp_status,
            commands::code::code_lsp_sync,
            commands::code::code_lsp_close,
            commands::code::code_lsp_request,
            commands::term::term_open,
            commands::term::term_write,
            commands::term::term_resize,
            commands::term::term_close,
            commands::term::term_close_all,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Shells are not killed by the OS when this process exits: without
            // this, every closed window would leave its terminals running.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(state) = app.try_state::<AppState>() {
                    state.terminals.close_all();
                }
            }
        });
}
