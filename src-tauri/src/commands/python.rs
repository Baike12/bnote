//! Python 功能的 Tauri 命令:运行、取消、项目信息、项目配置、LSP 同步、uv 环境。
//!
//! 结构约定:spawn_blocking 只搬纯数据(cloned vault / 路径),不搬 `State`;
//! std 锁的守卫一律不跨 await(python_lsp map 用「读出 → 放锁 → await → 复查」)。

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
    /// 笔记不在 vault 内时为 null。
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

/// 解析 md 路径 → (vault, 项目, 项目配置)。
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

/// 合并单项目配置(None = 不动,Some("") = 清除);lsp 被关掉时顺带停掉
/// 该项目的 LSP 服务器。返回合并后的项目配置。
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

/// 前端防抖后的同步入口:项目 LSP 关着就静默返回 enabled=false;开着则
/// 确保 server 起来并 didOpen/didChange。
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

    // 取活跃 server;没有就 spawn + 握手(全程不持 map 锁,插入前复查,
    // 并发的首次同步各自 spawn 后只留一个活的)。
    let server = {
        let existing = state
            .python_lsp
            .lock()
            .ok()
            .and_then(|m| m.get(&key).cloned())
            .filter(|s| s.alive.load(std::sync::atomic::Ordering::Relaxed));
        match existing {
            Some(s) => s,
            None => {
                let server = LspServer::spawn(&project, ty, app.clone()).await?;
                server.initialize().await?;
                let mut map = state.python_lsp.lock().map_err(|_| "lock poisoned")?;
                match map.get(&key) {
                    Some(s) if s.alive.load(std::sync::atomic::Ordering::Relaxed) => s.clone(),
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

    // open / change(版本记账在 server.docs,锁在算出动作后立刻放掉,
    // await 不进锁的作用域)。
    let to_change: Option<u32> = {
        let mut docs = server.docs.lock().map_err(|_| "lock poisoned")?;
        match docs.get(&md_path) {
            None => {
                docs.insert(md_path.clone(), 0);
                None
            }
            Some(v) => {
                let next = *v + 1;
                docs.insert(md_path.clone(), next);
                Some(next)
            }
        }
    };
    match to_change {
        None => server.open_doc(&md_path, &text).await?,
        Some(version) => server.change_doc(&md_path, version, &text).await?,
    }
    Ok(LspSyncResult { enabled: true })
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
        if server.alive.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = server.close_doc(&md_path).await;
        }
    }
    Ok(())
}

/// 换 vault / 退出前清场。
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
