//! Tauri commands for the Python features: run, cancel, project info, project
//! config, LSP sync, and uv environments.
//!
//! Structural rule: `spawn_blocking` only carries plain data (cloned vault /
//! paths), never `State`; a std lock guard never crosses an `.await` (the
//! python_lsp map follows "read out -> drop the lock -> await -> re-check").

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::CmdResult;
use crate::python::lsp::LspServer;
use crate::python::runner::{self, ResolvedEnv};
use crate::python::{self, ProjectConfig};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSyncResult {
    pub enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInfo {
    /// Null when the note is not inside the vault.
    pub project_root: Option<String>,
    pub project_name: String,
    /// "off" | "ty"
    pub lsp: String,
    pub python_override: Option<String>,
    pub ty_path: Option<String>,
    pub venv_exists: bool,
    pub has_pyproject: bool,
    pub env: Option<ResolvedEnv>,
    pub uv_available: bool,
    pub ty_available: bool,
}

/// Resolves an md path -> (vault, project, project config).
fn with_project(
    state: &State<'_, AppState>,
    md_path: &str,
) -> Result<(PathBuf, python::ProjectRef, ProjectConfig), String> {
    let vault = super::require_vault(state)?;
    let project = python::resolve_project(&vault, Path::new(md_path))?;
    let config = python::load_config(&vault).project(&project.name);
    Ok((vault, project, config))
}

#[tauri::command]
pub async fn python_run(
    app: AppHandle,
    state: State<'_, AppState>,
    md_path: String,
    code: String,
) -> CmdResult<runner::RunStarted> {
    runner::run_note(app, &state, md_path, code).await
}

#[tauri::command]
pub async fn python_run_cancel(state: State<'_, AppState>, md_path: String) -> CmdResult<bool> {
    Ok(state.python_runs.cancel(&md_path))
}

#[tauri::command]
pub async fn python_get_info(state: State<'_, AppState>, md_path: String) -> CmdResult<PythonInfo> {
    let (vault, project, config) = with_project(&state, &md_path)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<PythonInfo, String> {
        let env = runner::resolve_env(&project.root, &config);
        let ty_available = python::lsp::find_ty(&project.root, &config).is_ok();
        Ok(PythonInfo {
            project_root: Some(project.root.to_string_lossy().to_string()),
            project_name: project.name,
            lsp: config.lsp.clone().unwrap_or_else(|| "off".into()),
            python_override: config.python.clone(),
            ty_path: config.ty_path.clone(),
            venv_exists: runner::venv_python(&project.root).is_some(),
            has_pyproject: project.root.join("pyproject.toml").exists(),
            env: Some(env),
            uv_available: runner::find_on_path("uv").is_some(),
            ty_available,
        })
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Merges a single project's config (None = leave unchanged, Some("") = clear);
/// turning the LSP off also stops that project's LSP server. Returns the merged
/// project config.
#[tauri::command]
pub async fn python_set_project_config(
    app: AppHandle,
    state: State<'_, AppState>,
    md_path: String,
    lsp: Option<String>,
    python: Option<String>,
    ty_path: Option<String>,
) -> CmdResult<ProjectConfig> {
    let (vault, project, _) = with_project(&state, &md_path)?;
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<ProjectConfig, String> {
        let mut cfg = python::load_config(&vault);
        let entry = cfg.projects.entry(project.name.clone()).or_default();
        if let Some(v) = lsp {
            set_or_remove(&mut entry.lsp, &v);
        }
        if let Some(v) = python {
            set_or_remove(&mut entry.python, &v);
        }
        if let Some(v) = ty_path {
            set_or_remove(&mut entry.ty_path, &v);
        }
        let result = entry.clone();
        python::save_config(&vault, &cfg)?;
        Ok(result)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))??;

    if saved.lsp.as_deref() != Some("ty") {
        let key = project.root.to_string_lossy().to_string();
        if let Ok(mut map) = state.python_lsp.lock() {
            if let Some(server) = map.remove(&key) {
                server.stop();
                let _ = app.emit(
                    "python-lsp-status",
                    serde_json::json!({ "project": server.project_name, "state": "stopped" }),
                );
            }
        }
    }
    Ok(saved)
}

fn set_or_remove(slot: &mut Option<String>, value: &str) {
    let v = value.trim();
    if v.is_empty() {
        *slot = None;
    } else {
        *slot = Some(v.to_string());
    }
}

/// Sync entry point called after the frontend debounce: with the project LSP
/// off it silently returns enabled=false; with it on it makes sure the server
/// is running and that didOpen/didChange were sent.
#[tauri::command]
pub async fn python_lsp_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    md_path: String,
    text: String,
) -> CmdResult<LspSyncResult> {
    let (_vault, project, config) = with_project(&state, &md_path)?;
    if config.lsp.as_deref() != Some("ty") {
        return Ok(LspSyncResult { enabled: false });
    }
    let ty = python::lsp::find_ty(&project.root, &config)?;
    let key = project.root.to_string_lossy().to_string();

    // Grab the live server; if there is none, spawn + handshake (the map lock
    // is never held across the spawn, and the map is re-checked before the
    // insert, so concurrent first syncs each spawn one and only one survives).
    let server = {
        let existing = state
            .python_lsp
            .lock()
            .ok()
            .and_then(|m| m.get(&key).cloned())
            .filter(|s| s.alive());
        match existing {
            Some(s) => s,
            None => {
                let server = LspServer::spawn(&project, ty, app.clone()).await?;
                server.initialize().await?;
                let mut map = state.python_lsp.lock().map_err(|_| "lock poisoned")?;
                match map.get(&key) {
                    Some(s) if s.alive() => s.clone(),
                    _ => {
                        map.insert(key.clone(), server.clone());
                        let _ = app.emit(
                            "python-lsp-status",
                            serde_json::json!({ "project": project.name, "state": "running" }),
                        );
                        server
                    }
                }
            }
        }
    };

    // open / change: the version accounting lives in the client (the only
    // writer), so the caller only supplies the content.
    server.sync_doc(&md_path, &text).await?;
    Ok(LspSyncResult { enabled: true })
}

/// Forwarding point for the in-chat LSP requests (completion / hover).
/// Constraints:
/// - only read-only methods are allowed, so no other request can slip into ty
///   through this path;
/// - the server is not spawned here -- the frontend completion/hover sources
///   first sync the document through python_lsp_sync, and this only forwards
///   while the server is already alive; without one it answers null;
/// - textDocument.uri is injected by interaction_request from the md path, so
///   the frontend cannot hand in a forged document.
#[tauri::command]
pub async fn python_lsp_request(
    state: State<'_, AppState>,
    md_path: String,
    method: String,
    params: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    const ALLOWED: &[&str] = &["textDocument/completion", "textDocument/hover"];
    if !ALLOWED.contains(&method.as_str()) {
        return Err(format!("FORBIDDEN_METHOD: {}", method));
    }
    let (_vault, project, config) = with_project(&state, &md_path)?;
    if config.lsp.as_deref() != Some("ty") {
        return Ok(serde_json::Value::Null);
    }
    let key = project.root.to_string_lossy().to_string();
    let server = state
        .python_lsp
        .lock()
        .ok()
        .and_then(|m| m.get(&key).cloned())
        .filter(|s| s.alive());
    match server {
        Some(s) => s.interaction_request(&method, &md_path, params).await,
        None => Ok(serde_json::Value::Null),
    }
}

#[tauri::command]
pub async fn python_lsp_close(state: State<'_, AppState>, md_path: String) -> CmdResult<()> {
    let (_vault, project, config) = with_project(&state, &md_path)?;
    if config.lsp.as_deref() != Some("ty") {
        return Ok(());
    }
    let key = project.root.to_string_lossy().to_string();
    let server = state
        .python_lsp
        .lock()
        .ok()
        .and_then(|m| m.get(&key).cloned());
    if let Some(server) = server {
        if server.alive() {
            let _ = server.close_doc(&md_path).await;
        }
    }
    Ok(())
}

/// Tears down every server when the vault is switched or before quitting.
#[tauri::command]
pub async fn python_lsp_stop_all(state: State<'_, AppState>) -> CmdResult<()> {
    if let Ok(mut map) = state.python_lsp.lock() {
        for (_, server) in map.drain() {
            server.stop();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn python_uv_create(
    state: State<'_, AppState>,
    md_path: String,
) -> CmdResult<python::uvenv::UvOutcome> {
    let (_, project, _) = with_project(&state, &md_path)?;
    python::uvenv::create_uv_env(&project.root).await
}
