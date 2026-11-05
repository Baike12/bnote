//! Home (`~/.bnote`) file commands for the agent panel.
//!
//! A coding session's transcript belongs to the agent, not to the vault: its
//! record lives under `~/.bnote/projects/<project>/`. The panel writes and
//! reads those files through these commands, which are the only way the
//! frontend can touch the home directory — every path is confined to it.

use super::materials::{summarize_session, SessionMeta};
use super::CmdResult;
use crate::agent::home;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeWorkspace {
    /// `<agent home>/projects/<sanitized project root>`.
    pub dir: String,
}

/// Resolves (and creates) the record directory of a code project.
#[tauri::command]
pub async fn agent_home_workspace(workdir: String) -> CmdResult<HomeWorkspace> {
    let root = PathBuf::from(&workdir);
    if !root.is_dir() {
        return Err(format!("INVALID_WORKDIR: {} 不是目录", workdir));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = home::project_dir(&root);
        home::ensure_dir(&dir)?;
        Ok(HomeWorkspace {
            dir: dir.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Lists the session records of a code project (newest first).
#[tauri::command]
pub async fn agent_home_sessions_list(workdir: String) -> CmdResult<Vec<SessionMeta>> {
    let root = PathBuf::from(&workdir);
    if !root.is_dir() {
        return Err(format!("INVALID_WORKDIR: {} 不是目录", workdir));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = home::project_dir(&root);
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(out);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(meta) = summarize_session(&path) {
                out.push(meta);
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

fn confined(path: &str) -> Result<PathBuf, String> {
    let full = Path::new(path);
    if !full.is_absolute() {
        return Err(format!("INVALID_PATH: {}", path));
    }
    home::ensure_within_home(full)?;
    Ok(full.to_path_buf())
}

#[tauri::command]
pub async fn agent_home_read_file(path: String) -> CmdResult<Option<String>> {
    let full = confined(&path)?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&full) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_home_write_file(path: String, contents: String) -> CmdResult<()> {
    let full = confined(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        std::fs::write(&full, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_home_append_file(path: String, contents: String) -> CmdResult<()> {
    let full = confined(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&full)
            .map_err(|e| format!("WRITE_FAILED: {}", e))?;
        use std::io::Write as _;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Writes the model-generated title back into the metadata line of a coding
/// session record (the same rewrite the vault sessions get).
#[tauri::command]
pub async fn agent_home_set_session_title(
    workdir: String,
    id: String,
    title: String,
) -> CmdResult<()> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("BAD_ARGS: title".into());
    }
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("INVALID_ID: {}", id));
    }
    let root = PathBuf::from(&workdir);
    if !root.is_dir() {
        return Err(format!("INVALID_WORKDIR: {} 不是目录", workdir));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = home::project_dir(&root);
        let path = dir.join(format!("{}.jsonl", id));
        home::ensure_within_home(&path)?;
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("IO: {}", e))?;
        let next = super::materials::retitle_transcript(&raw, &title);
        if next == raw {
            return Ok(());
        }
        let tmp = dir.join(format!(".{}.jsonl.tmp", id));
        std::fs::write(&tmp, next).map_err(|e| format!("IO: {}", e))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("IO: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// One settings layer as the settings UI shows it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPathInfo {
    pub path: String,
    pub exists: bool,
    /// A parse error of that file (the UI surfaces it instead of pretending
    /// the file is fine).
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPaths {
    pub home: String,
    /// Merge order: user, project, project local.
    pub files: Vec<SettingsPathInfo>,
}

/// The three settings files and their parse state. `project` is the code
/// project when one is open, the vault otherwise.
#[tauri::command]
pub async fn agent_settings_paths(project: Option<String>) -> CmdResult<SettingsPaths> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = project.map(std::path::PathBuf::from).filter(|p| p.is_dir());
        let loaded = crate::agent::settings::load(project.as_deref());
        Ok(SettingsPaths {
            home: home::home_dir().to_string_lossy().to_string(),
            files: loaded
                .files
                .into_iter()
                .map(|file| SettingsPathInfo {
                    path: file.path.to_string_lossy().to_string(),
                    exists: file.exists,
                    error: file.error,
                })
                .collect(),
        })
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Every output style available for a project (built-ins first, then user
/// files, then project files).
#[tauri::command]
pub async fn agent_output_styles(
    project: Option<String>,
) -> CmdResult<Vec<crate::agent::output_style::StyleInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = project.map(std::path::PathBuf::from).filter(|p| p.is_dir());
        Ok(crate::agent::output_style::discover(project.as_deref())
            .into_iter()
            .map(|style| style.info())
            .collect())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// One prompt of `~/.bnote/history.jsonl`, newest first.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub display: String,
    pub project: String,
    pub session_id: String,
    pub timestamp: u64,
}

/// Recent prompts for the ↑ recall. `project` filters to prompts submitted
/// from that project (a coding session's repository); None = everything.
#[tauri::command]
pub async fn agent_history(
    project: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Vec<HistoryEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = home::history_file();
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Ok(Vec::new());
        };
        let limit = limit.unwrap_or(50).clamp(1, 500) as usize;
        let mut out: Vec<HistoryEntry> = Vec::new();
        for line in raw.lines().rev() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(display) = value.get("display").and_then(|v| v.as_str()) else {
                continue;
            };
            let entry_project = value
                .get("project")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if let Some(wanted) = project.as_deref() {
                if entry_project != wanted {
                    continue;
                }
            }
            out.push(HistoryEntry {
                display: display.to_string(),
                project: entry_project.to_string(),
                session_id: value
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                timestamp: value.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0),
            });
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// The settings/preferences surface reads and writes the user-level settings
/// file through the same confinement.
#[tauri::command]
pub async fn agent_home_read_settings(_state: State<'_, AppState>) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = home::settings_file();
        home::ensure_within_home(&path)?;
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("READ_FAILED: {}", e)),
        }
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_home_write_settings(
    _state: State<'_, AppState>,
    contents: String,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        // Valid JSON only: a hand-edited settings file that no longer parses
        // would silently disable permissions/hooks, so the write is the place
        // to reject it.
        serde_json::from_str::<serde_json::Value>(&contents)
            .map_err(|e| format!("INVALID_JSON: {}", e))?;
        let path = home::settings_file();
        home::ensure_within_home(&path)?;
        if let Some(parent) = path.parent() {
            home::ensure_dir(parent)?;
        }
        std::fs::write(&path, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}
