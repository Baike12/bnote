use serde::Serialize;
use tauri::State;

use super::{ensure_within, require_vault, validate_name, CmdResult};
use crate::state::AppState;
use crate::commands::vault::vault_join;

/// Files inside `<vault>/.bnote/` that the app reads as configuration.
const VAULT_CONFIG_FILES: &[&str] = &["vimrc", "snippets.js", "keybindings.json"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEntry {
    pub path: String,
    pub rel_path: String,
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        eprintln!("[bnote] read_file: {}", full.display());
        std::fs::read_to_string(&full).map_err(|e| format!("READ_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn write_file(state: State<'_, AppState>, path: String, contents: String) -> CmdResult<()> {
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        std::fs::write(&full, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Creates `parent/name.md`, deduplicating as "name 2.md", "name 3.md", …
/// Returns the actual created path.
#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> CmdResult<CreatedEntry> {
    let root = require_vault(&state)?;
    validate_name(&name)?;
    let parent_path = if parent.is_empty() || parent == "/" {
        root.clone()
    } else {
        let p = root.join(&parent);
        ensure_within(&root, &p)?;
        p
    };

    tauri::async_runtime::spawn_blocking(move || {
        let stem = strip_extension(&name);
        let ext = extension_of(&name);
        let mut candidate = parent_path.join(&name);
        let mut counter = 2;
        while candidate.exists() {
            candidate = parent_path.join(format!("{} {}.{}", stem, counter, ext));
            counter += 1;
        }
        std::fs::write(&candidate, "").map_err(|e| format!("CREATE_FAILED: {}", e))?;
        Ok(created(&root, &candidate))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn create_dir(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> CmdResult<CreatedEntry> {
    let root = require_vault(&state)?;
    validate_name(&name)?;
    let parent_path = if parent.is_empty() || parent == "/" {
        root.clone()
    } else {
        let p = root.join(&parent);
        ensure_within(&root, &p)?;
        p
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut candidate = parent_path.join(&name);
        let mut counter = 2;
        while candidate.exists() {
            candidate = parent_path.join(format!("{} {}", name, counter));
            counter += 1;
        }
        std::fs::create_dir_all(&candidate).map_err(|e| format!("CREATE_FAILED: {}", e))?;
        Ok(created(&root, &candidate))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> CmdResult<String> {
    let root = require_vault(&state)?;
    validate_name(&new_name)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        let target = full
            .parent()
            .ok_or("RENAME_FAILED: no parent")?
            .join(&new_name);
        if target.exists() {
            return Err(format!("RENAME_FAILED: {} already exists", new_name));
        }
        std::fs::rename(&full, &target).map_err(|e| format!("RENAME_FAILED: {}", e))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn trash_path(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        trash::delete(&full).map_err(|e| format!("TRASH_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Reads `<vault>/.bnote/<name>` for name in the whitelist; None when absent.
#[tauri::command]
pub async fn read_vault_file(state: State<'_, AppState>, name: String) -> CmdResult<Option<String>> {
    if !VAULT_CONFIG_FILES.contains(&name.as_str()) {
        return Err(format!("INVALID_NAME: {}", name));
    }
    let path = vault_join(&state, &format!(".bnote/{}", name))?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn write_vault_file(
    state: State<'_, AppState>,
    name: String,
    contents: String,
) -> CmdResult<()> {
    if !VAULT_CONFIG_FILES.contains(&name.as_str()) {
        return Err(format!("INVALID_NAME: {}", name));
    }
    let path = vault_join(&state, &format!(".bnote/{}", name))?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        std::fs::write(&path, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

fn created(root: &std::path::Path, full: &std::path::Path) -> CreatedEntry {
    CreatedEntry {
        path: full.to_string_lossy().to_string(),
        rel_path: full
            .strip_prefix(root)
            .unwrap_or(full)
            .to_string_lossy()
            .replace('\\', "/"),
    }
}

fn strip_extension(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name.to_string(),
    }
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_string(),
        _ => "md".to_string(),
    }
}
