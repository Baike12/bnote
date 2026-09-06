use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher, recommended_watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{ensure_within, require_vault, validate_name, CmdResult};
use crate::state::AppState;

/// Directories never shown in the file tree or watched for content.
const IGNORED_DIRS: &[&str] = &[
    ".git", ".bnote", ".obsidian", ".DS_Store", "node_modules", ".trash",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    /// Path relative to the vault root, using `/` separators.
    pub rel_path: String,
    pub kind: String, // "file" | "dir"
    /// Directories load lazily: null means "not read yet, call read_dir".
    pub children: Option<Vec<FileNode>>,
}

#[tauri::command]
pub fn set_vault(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<VaultInfo> {
    set_vault_blocking(&app, &state, path)
}

fn set_vault_blocking(app: &AppHandle, state: &State<'_, AppState>, path: String) -> CmdResult<VaultInfo> {
    eprintln!("[bnote] set_vault: {path}");
    let root = std::fs::canonicalize(&path)
        .map_err(|e| format!("INVALID_VAULT: {} ({})", path, e))?;
    if !root.is_dir() {
        return Err(format!("INVALID_VAULT: {} is not a directory", path));
    }

    *state.vault.write().map_err(|_| "lock poisoned")? = Some(root.clone());

    // Remember the vault for the next launch.
    super::config::persist_last_vault(state, &root.to_string_lossy())?;

    start_watcher(app, state, &root)?;

    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string());
    Ok(VaultInfo {
        path: root.to_string_lossy().to_string(),
        name,
    })
}

#[tauri::command]
pub fn get_vault(state: State<'_, AppState>) -> CmdResult<Option<VaultInfo>> {
    Ok(state.vault().map(|root| {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string());
        VaultInfo {
            path: root.to_string_lossy().to_string(),
            name,
        }
    }))
}

/// Root level of the vault; directories arrive with children = null and are
/// read on expand (Obsidian-style lazy tree) so huge vaults open instantly.
#[tauri::command]
pub async fn read_tree(state: State<'_, AppState>) -> CmdResult<Vec<FileNode>> {
    let root = require_vault(&state)?;
    run_blocking(move || {
        eprintln!("[bnote] read_tree");
        Ok(build_level(&root, ""))
    })
    .await
}

/// One level of a directory inside the vault.
#[tauri::command]
pub async fn read_dir(state: State<'_, AppState>, rel_path: String) -> CmdResult<Vec<FileNode>> {
    let root = require_vault(&state)?;
    run_blocking(move || {
        for part in rel_path.split('/') {
            validate_name(part)?;
        }
        let full = root.join(&rel_path);
        ensure_within(&root, &full)?;
        Ok(build_level(&full, &rel_path))
    })
    .await
}

/// Flat list of all note file paths (quick switcher / wikilinks). A single
/// walk without tree building; fast even on big vaults (off the main thread).
#[tauri::command]
pub async fn list_files(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let root = require_vault(&state)?;
    run_blocking(move || {
        eprintln!("[bnote] list_files");
        let mut out = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in rd.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                let name = entry.file_name().to_string_lossy().to_string();
                let p = entry.path();
                if ft.is_dir() {
                    if !IGNORED_DIRS.contains(&name.as_str()) {
                        stack.push(p);
                    }
                } else if ft.is_file() && is_note_file(&name) {
                    if let Ok(rel) = p.strip_prefix(&root) {
                        out.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    })
    .await
}

async fn run_blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

fn build_level(dir: &Path, rel_prefix: &str) -> Vec<FileNode> {
    let mut nodes: Vec<(bool, FileNode)> = Vec::new();

    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(ft) = entry.file_type() else { continue };
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix, name)
        };
        if ft.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            nodes.push((
                true,
                FileNode {
                    name,
                    rel_path: rel,
                    kind: "dir".into(),
                    children: None,
                },
            ));
        } else if ft.is_file() && is_note_file(&name) {
            nodes.push((
                false,
                FileNode {
                    name,
                    rel_path: rel,
                    kind: "file".into(),
                    children: None,
                },
            ));
        }
    }

    nodes.sort_by_key(|(_, n)| n.name.to_lowercase());
    let mut dirs: Vec<FileNode> = Vec::new();
    let mut files: Vec<FileNode> = Vec::new();
    for (is_dir, node) in nodes {
        if is_dir {
            dirs.push(node);
        } else {
            files.push(node);
        }
    }
    dirs.extend(files);
    dirs
}

fn is_note_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".md", ".markdown", ".txt"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Watches the vault with plain notify (FSEvents registration is O(1)) and a
/// hand-rolled debouncer, then emits `vault-changed` to the UI. Unlike
/// notify-debouncer-full this avoids the initial full-tree file-id scan that
/// froze large vaults.
fn start_watcher(app: &AppHandle, state: &State<'_, AppState>, root: &PathBuf) -> CmdResult<()> {
    let mut guard = state.watcher.lock().map_err(|_| "lock poisoned")?;
    // Signal the previous debounce thread to stop, then unregister its watch.
    if let Some(old) = guard.take() {
        old.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(old);
    }

    let app_handle = app.clone();
    let (tx, rx) = mpsc::channel::<std::result::Result<notify::Event, notify::Error>>();
    let mut watcher = recommended_watcher(tx).map_err(|e| format!("WATCHER_FAILED: {}", e))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("WATCHER_FAILED: {}", e))?;

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_thread = stop.clone();

    std::thread::spawn(move || {
        let mut pending: std::collections::HashSet<String> = std::collections::HashSet::new();
        loop {
            if stop_thread.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            // Batch events; emit once the stream stays quiet for 300ms.
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(Ok(event)) => {
                    for p in event.paths {
                        pending.insert(p.to_string_lossy().to_string());
                    }
                }
                Ok(Err(e)) => {
                    eprintln!("[bnote] watch error: {e}");
                }
                Err(_timeout) => {
                    if !pending.is_empty() {
                        let paths: Vec<String> = pending.drain().collect();
                        let _ = app_handle.emit("vault-changed", paths);
                    }
                }
            }
        }
    });

    *guard = Some(crate::state::WatcherHandle {
        _watcher: watcher,
        stop,
    });
    Ok(())
}

/// Resolves a relative path against the vault, for read_vault_file etc.
pub(crate) fn vault_join(state: &AppState, rel: &str) -> CmdResult<PathBuf> {
    let root = require_vault(state)?;
    for part in rel.split('/') {
        validate_name(part)?;
    }
    let full = root.join(rel);
    ensure_within(&root, &full)?;
    Ok(full)
}
