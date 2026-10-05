//! Thin Tauri command wrappers over bnote-core.
//!
//! Core functions are synchronous and blocking; each wrapper decides where to
//! run them. Anything that touches disk or blocks on core's private tokio
//! runtime goes through `spawn_blocking` so it never lands on the main thread
//! (see bnote-core/src/commands/config.rs for why that matters under typing).

use std::sync::Arc;

use bnote_core::agent::tools::StudyContent;
use bnote_core::commands;
use bnote_core::state::AppState;
use serde_json::Value;



/// Runs a synchronous core call on the async runtime's blocking pool.
///
/// `$state` must be an expression that yields `Arc<AppState>` when evaluated
/// on the caller's thread (i.e. `sync(&state)`); the `state` name inside
/// `$body` then refers to that Arc, so core functions taking `&AppState` work
/// via deref coercion, and nothing borrowed escapes into the 'static closure.
/// Runs a synchronous core call on the async runtime's blocking pool.
///
/// `$state` is the caller's `state` binding (a `State<'_, Arc<AppState>>`):
/// the macro rebinds the *same identifier* to its `Arc<AppState>` clone, so
/// the 'static closure captures an owned Arc and `$core`'s `&state` derefs to
/// `&AppState`. Hygiene note: rebinding must use `$state:ident` — a macro-internal
/// name would not resolve inside `$core`.
macro_rules! blocking {
    ($state:ident, $core:expr) => {{
        let $state = $state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || $core)
            .await
            .map_err(|e| format!("JOIN_FAILED: {}", e))?
    }};
}

// ---- vault ----

#[tauri::command]
pub fn set_vault(state: tauri::State<'_, Arc<AppState>>, path: String) -> commands::CmdResult<commands::vault::VaultInfo> {
    commands::vault::set_vault(&state, path)
}

#[tauri::command]
pub fn get_vault(state: tauri::State<'_, Arc<AppState>>) -> commands::CmdResult<Option<commands::vault::VaultInfo>> {
    commands::vault::get_vault(&state)
}

#[tauri::command]
pub async fn read_tree(state: tauri::State<'_, Arc<AppState>>) -> commands::CmdResult<Vec<commands::vault::FileNode>> {
    blocking!(state, commands::vault::read_tree(&state))
}

#[tauri::command]
pub async fn read_dir(
    state: tauri::State<'_, Arc<AppState>>,
    rel_path: String,
) -> commands::CmdResult<Vec<commands::vault::FileNode>> {
    blocking!(state, commands::vault::read_dir(&state, rel_path))
}

#[tauri::command]
pub async fn list_files(state: tauri::State<'_, Arc<AppState>>) -> commands::CmdResult<commands::vault::VaultIndex> {
    blocking!(state, commands::vault::list_files(&state))
}

// ---- files ----

#[tauri::command]
pub async fn read_file(state: tauri::State<'_, Arc<AppState>>, path: String) -> commands::CmdResult<String> {
    blocking!(state, commands::files::read_file(&state, path))
}

#[tauri::command]
pub async fn write_file(state: tauri::State<'_, Arc<AppState>>, path: String, contents: String) -> commands::CmdResult<()> {
    blocking!(state, commands::files::write_file(&state, path, contents))
}

#[tauri::command]
pub async fn write_file_base64(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    contents_base64: String,
) -> commands::CmdResult<()> {
    blocking!(state, commands::files::write_file_base64(&state, path, contents_base64))
}

#[tauri::command]
pub async fn create_file(
    state: tauri::State<'_, Arc<AppState>>,
    parent: String,
    name: String,
) -> commands::CmdResult<commands::files::CreatedEntry> {
    blocking!(state, commands::files::create_file(&state, parent, name))
}

#[tauri::command]
pub async fn create_dir(
    state: tauri::State<'_, Arc<AppState>>,
    parent: String,
    name: String,
) -> commands::CmdResult<commands::files::CreatedEntry> {
    blocking!(state, commands::files::create_dir(&state, parent, name))
}

#[tauri::command]
pub async fn ensure_dir(state: tauri::State<'_, Arc<AppState>>, rel_path: String) -> commands::CmdResult<()> {
    blocking!(state, commands::files::ensure_dir(&state, rel_path))
}

#[tauri::command]
pub async fn rename_path(state: tauri::State<'_, Arc<AppState>>, path: String, new_name: String) -> commands::CmdResult<String> {
    blocking!(state, commands::files::rename_path(&state, path, new_name))
}

#[tauri::command]
pub async fn trash_path(state: tauri::State<'_, Arc<AppState>>, path: String) -> commands::CmdResult<()> {
    blocking!(state, commands::files::trash_path(&state, path))
}

#[tauri::command]
pub async fn read_vault_file(state: tauri::State<'_, Arc<AppState>>, name: String) -> commands::CmdResult<Option<String>> {
    blocking!(state, commands::files::read_vault_file(&state, name))
}

#[tauri::command]
pub async fn write_vault_file(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    contents: String,
) -> commands::CmdResult<()> {
    blocking!(state, commands::files::write_vault_file(&state, name, contents))
}

// ---- config ----

#[tauri::command]
pub async fn load_app_config(state: tauri::State<'_, Arc<AppState>>) -> commands::CmdResult<Value> {
    blocking!(state, commands::config::load_app_config(&state))
}

#[tauri::command]
pub async fn save_app_config(state: tauri::State<'_, Arc<AppState>>, config: Value) -> commands::CmdResult<()> {
    blocking!(state, commands::config::save_app_config(&state, config))
}

#[tauri::command]
pub async fn load_keybindings(state: tauri::State<'_, Arc<AppState>>) -> commands::CmdResult<Option<Value>> {
    blocking!(state, commands::config::load_keybindings(&state))
}

#[tauri::command]
pub async fn save_keybindings(state: tauri::State<'_, Arc<AppState>>, keybindings: Value) -> commands::CmdResult<()> {
    blocking!(state, commands::config::save_keybindings(&state, keybindings))
}

#[tauri::command]
pub async fn read_vimrc(state: tauri::State<'_, Arc<AppState>>) -> commands::CmdResult<Option<String>> {
    blocking!(state, commands::config::read_vimrc(&state))
}

#[tauri::command]
pub async fn save_vimrc(state: tauri::State<'_, Arc<AppState>>, contents: String) -> commands::CmdResult<()> {
    blocking!(state, commands::config::save_vimrc(&state, contents))
}

// ---- ime ----

#[tauri::command]
pub fn list_input_sources() -> commands::CmdResult<Vec<commands::ime::InputSourceInfo>> {
    commands::ime::list_input_sources()
}

#[tauri::command]
pub fn get_current_input_source() -> commands::CmdResult<String> {
    commands::ime::get_current_input_source()
}

#[tauri::command]
pub fn set_input_source(state: tauri::State<'_, Arc<AppState>>, mode: String) -> commands::CmdResult<commands::ime::SetImeOutcome> {
    commands::ime::set_input_source(&state, mode)
}

// ---- agent ----

#[tauri::command]
pub async fn agent_get_config(state: tauri::State<'_, Arc<AppState>>) -> commands::CmdResult<bnote_core::agent::AgentConfig> {
    blocking!(state, commands::agent::agent_get_config(&state))
}

#[tauri::command]
pub async fn agent_save_config(
    state: tauri::State<'_, Arc<AppState>>,
    config: bnote_core::agent::AgentConfig,
) -> commands::CmdResult<()> {
    blocking!(state, commands::agent::agent_save_config(&state, config))
}

#[tauri::command]
pub async fn agent_start_session(
    state: tauri::State<'_, Arc<AppState>>,
    study: Option<StudyContent>,
) -> commands::CmdResult<Value> {
    blocking!(state, commands::agent::agent_start_session(&state, study))
}

#[tauri::command]
pub async fn agent_send(state: tauri::State<'_, Arc<AppState>>, session_id: String, text: String) -> commands::CmdResult<()> {
    blocking!(state, commands::agent::agent_send(&state, session_id, text))
}

#[tauri::command]
pub fn agent_abort(state: tauri::State<'_, Arc<AppState>>, session_id: String) -> commands::CmdResult<()> {
    commands::agent::agent_abort(&state, session_id)
}

#[tauri::command]
pub fn agent_get_history(
    state: tauri::State<'_, Arc<AppState>>,
    session_id: String,
) -> commands::CmdResult<Vec<bnote_core::agent::types::ChatItem>> {
    commands::agent::agent_get_history(&state, session_id)
}

#[tauri::command]
pub fn agent_set_current_note(state: tauri::State<'_, Arc<AppState>>, path: Option<String>) -> commands::CmdResult<()> {
    commands::agent::agent_set_current_note(&state, path)
}

#[tauri::command]
pub async fn convert_pdf_to_markdown(
    state: tauri::State<'_, Arc<AppState>>,
    pdf_path: String,
    folder_rel: String,
) -> commands::CmdResult<Value> {
    blocking!(state, commands::agent::convert_pdf_to_markdown(&state, pdf_path, folder_rel))
}

// ---- python ----

#[tauri::command]
pub async fn python_run(
    state: tauri::State<'_, Arc<AppState>>,
    md_path: String,
    code: String,
) -> commands::CmdResult<bnote_core::python::runner::RunStarted> {
    blocking!(state, commands::python::python_run(&state, md_path, code))
}

#[tauri::command]
pub async fn python_run_cancel(state: tauri::State<'_, Arc<AppState>>, md_path: String) -> commands::CmdResult<bool> {
    blocking!(state, commands::python::python_run_cancel(&state, md_path))
}

#[tauri::command]
pub async fn python_get_info(
    state: tauri::State<'_, Arc<AppState>>,
    md_path: String,
) -> commands::CmdResult<commands::python::PythonInfo> {
    blocking!(state, commands::python::python_get_info(&state, md_path))
}

#[tauri::command]
pub async fn python_set_project_config(
    state: tauri::State<'_, Arc<AppState>>,
    md_path: String,
    lsp: Option<String>,
    python: Option<String>,
    ty_path: Option<String>,
) -> commands::CmdResult<bnote_core::python::ProjectConfig> {
    blocking!(state, commands::python::python_set_project_config(&state, md_path, lsp, python, ty_path))
}

#[tauri::command]
pub async fn python_lsp_sync(
    state: tauri::State<'_, Arc<AppState>>,
    md_path: String,
    text: String,
) -> commands::CmdResult<commands::python::LspSyncResult> {
    blocking!(state, commands::python::python_lsp_sync(&state, md_path, text))
}

#[tauri::command]
pub async fn python_lsp_request(
    state: tauri::State<'_, Arc<AppState>>,
    md_path: String,
    method: String,
    params: Value,
) -> commands::CmdResult<Value> {
    blocking!(state, commands::python::python_lsp_request(&state, md_path, method, params))
}

#[tauri::command]
pub async fn python_lsp_close(state: tauri::State<'_, Arc<AppState>>, md_path: String) -> commands::CmdResult<()> {
    blocking!(state, commands::python::python_lsp_close(&state, md_path))
}

#[tauri::command]
pub async fn python_lsp_stop_all(state: tauri::State<'_, Arc<AppState>>) -> commands::CmdResult<()> {
    blocking!(state, commands::python::python_lsp_stop_all(&state))
}

#[tauri::command]
pub async fn python_uv_create(
    state: tauri::State<'_, Arc<AppState>>,
    md_path: String,
) -> commands::CmdResult<bnote_core::python::uvenv::UvOutcome> {
    blocking!(state, commands::python::python_uv_create(&state, md_path))
}

use crate::study;

// ---- study preview (shell-owned: native child webviews) ----

#[tauri::command]
pub async fn show_study_preview(
    app: tauri::AppHandle,
    url: String,
    bounds: study::PreviewBounds,
) -> commands::CmdResult<()> {
    study::show_study_preview(app, url, bounds).await
}

#[tauri::command]
pub fn set_study_preview_bounds(app: tauri::AppHandle, bounds: study::PreviewBounds) -> commands::CmdResult<()> {
    study::set_study_preview_bounds(app, bounds)
}

#[tauri::command]
pub fn set_study_preview_visible(app: tauri::AppHandle, visible: bool) -> commands::CmdResult<()> {
    study::set_study_preview_visible(app, visible)
}

#[tauri::command]
pub fn close_study_preview(app: tauri::AppHandle) -> commands::CmdResult<()> {
    study::close_study_preview(app)
}

#[tauri::command]
pub async fn open_study_url(app: tauri::AppHandle, url: String) -> commands::CmdResult<()> {
    study::open_study_url(app, url).await
}
