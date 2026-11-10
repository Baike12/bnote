//! Tauri commands for code projects: open a repository, read/write files,
//! search, git, and the language server.
//!
//! ## Path boundary
//!
//! Every command takes a "project root" and does all file operations inside
//! it (see [`crate::code::project::resolve_in`]). The root is opened explicitly
//! by the user (a directory picker), so it is the sandbox boundary - unlike
//! the vault, which the app manages itself.
//!
//! The project root is canonicalized once and then used as the key: the same
//! directory opened through different spellings (`/tmp/x` vs
//! `/private/tmp/x`, a trailing slash) must count as one project, otherwise
//! two language servers and two file trees would be started.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use super::CmdResult;
use crate::code::git::{self, GitStatus};
use crate::code::lang;
use crate::code::lsp::{LspManager, ServerConfig};
use crate::code::project::{self, CodeEntry, CodeFile, CodeSearchHit, CodeTree};
use crate::state::AppState;

/// Information about the opened project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeProjectInfo {
    /// Absolute path of the project root.
    pub root: String,
    /// Directory name (the project name).
    pub name: String,
    /// Whether it is a git repository.
    pub is_git: bool,
    /// Repository root (may be an ancestor of the project root).
    pub git_root: Option<String>,
    /// Current branch.
    pub branch: Option<String>,
    /// File tree.
    pub tree: CodeTree,
}

/// Language server state for one language.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeLspState {
    pub language: String,
    /// "running" | "stopped"
    pub state: String,
}

/// Canonicalize the project root and make sure it is a directory.
fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("PROJECT_INVALID: 路径为空".to_string());
    }
    let p = PathBuf::from(trimmed);
    let c = p
        .canonicalize()
        .map_err(|e| format!("PROJECT_INVALID: {}", e))?;
    if !c.is_dir() {
        return Err("PROJECT_INVALID: 不是目录".to_string());
    }
    Ok(c)
}

/// Key of the project root (the canonicalized string).
fn root_key(root: &Path) -> String {
    root.to_string_lossy().to_string()
}

/// Runs blocking work (tree scan, file IO, git subprocess) off the async
/// worker.
///
/// The command surface is `async`, but a repository scan, a `git status` and a
/// file read are synchronous syscalls. Running them inline occupies one of the
/// runtime's worker threads and stalls every other command queued behind it, so
/// opening a large repository would also freeze unrelated commands. The same
/// discipline is already applied in `files.rs`, `home.rs` and `vault.rs`.
async fn blocking<T, F>(work: F) -> CmdResult<T>
where
    F: FnOnce() -> CmdResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("JOIN: {e}"))?
}

/// Return the **already scanned** file tree of this project; if there is none,
/// scan once and remember it.
///
/// The file tree has exactly two writers: opening the project and "rescan".
/// Search reads this cache instead of walking the repository again - an
/// `ignore` traversal stats every directory and reads .gitignore, and search
/// arrives on every keystroke (200ms debounce), so on a large repository that
/// cost must not be paid per keystroke.
///
/// The price: the search scope is exactly the tree shown in the left pane.
/// After creating or deleting files outside the app you have to "rescan" for
/// both sides to update - they therefore always come from the same source and
/// can never contradict each other ("in the tree but not searchable").
fn tree_for(state: &AppState, root: &Path) -> Result<CodeTree, String> {
    let key = root_key(root);
    if let Ok(map) = state.code_trees.lock() {
        if let Some(tree) = map.get(&key) {
            return Ok(tree.clone());
        }
    }
    let tree = project::scan(root);
    let mut map = state.code_trees.lock().map_err(|_| "lock poisoned")?;
    map.insert(key, tree.clone());
    Ok(tree)
}

/// Scan once and write the result into the cache (used by open project / rescan).
fn scan_into_cache(state: &AppState, root: &Path) -> CodeTree {
    let tree = project::scan(root);
    if let Ok(mut map) = state.code_trees.lock() {
        map.insert(root_key(root), tree.clone());
    }
    tree
}

/// Get (or create) the language server manager for this project.
fn manager_for(state: &AppState, root: &PathBuf) -> Result<Arc<LspManager>, String> {
    let key = root_key(root);
    if let Ok(map) = state.code_lsp.lock() {
        if let Some(m) = map.get(&key) {
            return Ok(m.clone());
        }
    }
    let manager = Arc::new(LspManager::new(root.clone()));
    let mut map = state.code_lsp.lock().map_err(|_| "lock poisoned")?;
    // Re-check before inserting: concurrent first requests keep only one
    // manager (otherwise two server processes would start).
    Ok(match map.get(&key) {
        Some(existing) => existing.clone(),
        None => {
            map.insert(key, manager.clone());
            manager
        }
    })
}

/// Open a code project: scan the file tree and read the git status.
#[tauri::command]
pub async fn code_open_project(app: AppHandle, root: String) -> CmdResult<CodeProjectInfo> {
    let root = canonical_root(&root)?;
    // Images in the project are rendered through the asset protocol, scoped to
    // this repository (see `paths::allow_asset_dir`).
    crate::paths::allow_asset_dir(&app, &root);
    let scan_app = app.clone();
    let scan_root = root.clone();
    let git_root = root.clone();
    let (tree, status) = blocking(move || {
        let state = scan_app.state::<AppState>();
        let tree = scan_into_cache(&state, &scan_root);
        let status = git::status(&git_root).unwrap_or_default();
        Ok((tree, status))
    })
    .await?;
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string());
    Ok(CodeProjectInfo {
        root: root.to_string_lossy().to_string(),
        name,
        is_git: status.is_repo,
        git_root: status.root,
        branch: status.branch,
        tree,
    })
}

/// Rescan the file tree (after the user edited .gitignore or created files
/// outside the app).
#[tauri::command]
pub async fn code_rescan(app: AppHandle, root: String) -> CmdResult<CodeTree> {
    let root = canonical_root(&root)?;
    blocking(move || {
        let state = app.state::<AppState>();
        Ok(scan_into_cache(&state, &root))
    })
    .await
}

/// Read a file (together with its language id).
#[tauri::command]
pub async fn code_read_file(root: String, path: String) -> CmdResult<CodeFile> {
    blocking(move || {
        let root = canonical_root(&root)?;
        let target = project::resolve_target(&root, &path)?;
        let (content, binary, size) = project::read_text(&target.abs)?;
        let language_id = lang::language_for_path(&target.abs).to_string();
        Ok(CodeFile {
            path,
            language_id,
            content,
            binary,
            size,
            external: target.external,
        })
    })
    .await
}

/// Write a file.
#[tauri::command]
pub async fn code_write_file(root: String, path: String, content: String) -> CmdResult<()> {
    blocking(move || {
        let root = canonical_root(&root)?;
        let abs = project::resolve_in(&root, &path)?;
        project::write_text(&abs, &content)
    })
    .await
}

/// Search file contents in the project (literal, case-insensitive).
#[tauri::command]
pub async fn code_search(
    app: AppHandle,
    root: String,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<CodeSearchHit>> {
    let root = canonical_root(&root)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let tree = tree_for(&state, &root)?;
        Ok(project::search_contents(
            &root,
            &tree,
            &query,
            limit.unwrap_or(200),
        ))
    })
    .await
}

/// Fuzzy file name search (for quick open): subsequence match, returns relative paths.
#[tauri::command]
pub async fn code_search_files(
    app: AppHandle,
    root: String,
    query: String,
) -> CmdResult<Vec<CodeEntry>> {
    let root = canonical_root(&root)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let tree = tree_for(&state, &root)?;
        let q = query.to_lowercase();
        // The ignore-hidden paths are in the tree but not searchable: node_modules
        // would otherwise take every quick-open result (`code_search` reasons the
        // same way, see `CodeTree::searchable`).
        let mut hits: Vec<CodeEntry> = tree
            .searchable()
            .filter(|e| !e.is_dir && fuzzy_match(&e.name.to_lowercase(), &q))
            .cloned()
            .collect();
        // Matches first, directory order as the tie-breaker.
        hits.sort_by(|a, b| {
            let ra = rank(&a.name.to_lowercase(), &q);
            let rb = rank(&b.name.to_lowercase(), &q);
            ra.cmp(&rb).then_with(|| a.path.cmp(&b.path))
        });
        hits.truncate(50);
        Ok(hits)
    })
    .await
}

/// Subsequence match: `abc` hits `a_b_c`.
fn fuzzy_match(text: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let mut chars = text.chars();
    query.chars().all(|q| chars.any(|c| c == q))
}

/// Match quality: exact > prefix > contains > subsequence.
fn rank(text: &str, query: &str) -> u8 {
    if text == query {
        0
    } else if text.starts_with(query) {
        1
    } else if text.contains(query) {
        2
    } else {
        3
    }
}

/// Read the git status.
#[tauri::command]
pub async fn code_git_status(root: String) -> CmdResult<GitStatus> {
    blocking(move || {
        let root = canonical_root(&root)?;
        git::status(&root)
    })
    .await
}

/// Get the diff of one file (unified diff text).
#[tauri::command]
pub async fn code_git_diff(root: String, path: String, staged: bool) -> CmdResult<String> {
    blocking(move || {
        let root = canonical_root(&root)?;
        git::diff(&root, &path, staged)
    })
    .await
}

/// Stage the changes of one file and return the new status.
#[tauri::command]
pub async fn code_git_stage(root: String, path: String) -> CmdResult<GitStatus> {
    blocking(move || {
        let root = canonical_root(&root)?;
        let repo = git::repo_root(&root).ok_or("NOT_A_REPO: 不是 git 仓库")?;
        git::stage(&repo, &path)?;
        git::status(&root)
    })
    .await
}

/// Unstage the changes of one file and return the new status.
#[tauri::command]
pub async fn code_git_unstage(root: String, path: String) -> CmdResult<GitStatus> {
    blocking(move || {
        let root = canonical_root(&root)?;
        let repo = git::repo_root(&root).ok_or("NOT_A_REPO: 不是 git 仓库")?;
        git::unstage(&repo, &path)?;
        git::status(&root)
    })
    .await
}

/// Resolve which language server this language should use (the frontend
/// decides from this whether to show the LSP entry).
#[tauri::command]
pub async fn code_lsp_resolve(
    root: String,
    language: String,
    path: Option<String>,
    overrides: Option<ServerConfig>,
) -> CmdResult<Option<ResolvedServerInfo>> {
    let root = canonical_root(&root)?;
    let resolved = crate::code::lsp::resolve_server(
        &root,
        &language,
        path.as_deref().unwrap_or(""),
        overrides.as_ref(),
    );
    Ok(resolved.map(|r| ResolvedServerInfo {
        command: r.config.command,
        args: r.config.args,
        disabled: r.disabled,
    }))
}

/// Shape of the resolve result handed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedServerInfo {
    pub command: String,
    pub args: Vec<String>,
    pub disabled: bool,
}

/// Make sure the server that serves `path` is running.
///
/// `path` decides the workspace: for Python the venv lives in the subproject,
/// so a repository of several assignments gets one server per assignment (see
/// `code::lsp::server_root`). The call is idempotent: an already running
/// server for that workspace is returned, not restarted.
#[tauri::command]
pub async fn code_lsp_start(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    language: String,
    path: String,
    overrides: Option<ServerConfig>,
) -> CmdResult<CodeLspState> {
    let root = canonical_root(&root)?;
    let rel = path.replace('\\', "/");
    let Some(resolved) =
        crate::code::lsp::resolve_server(&root, &language, &rel, overrides.as_ref())
    else {
        return Err(format!(
            "LSP_UNSUPPORTED: {} 没有可用的语言服务器",
            language
        ));
    };
    if resolved.disabled {
        return Err(format!("LSP_DISABLED: {} 已被项目配置关掉", language));
    }
    let workspace = crate::code::lsp::server_root(&root, &language, &rel);
    let manager = manager_for(&state, &root)?;
    manager
        .ensure(&language, &workspace, &resolved.config, app)
        .await
        .map(|_| CodeLspState {
            language,
            state: "running".to_string(),
        })
}

/// Stop all language servers of this project.
#[tauri::command]
pub async fn code_lsp_stop(state: State<'_, AppState>, root: String) -> CmdResult<()> {
    let root = canonical_root(&root)?;
    let key = root_key(&root);
    let manager = {
        let mut map = state.code_lsp.lock().map_err(|_| "lock poisoned")?;
        map.remove(&key)
    };
    if let Ok(mut trees) = state.code_trees.lock() {
        // This root was torn down: the file tree cache goes with it, so a
        // closed project does not stay in memory forever.
        trees.remove(&key);
    }
    if let Some(m) = manager {
        m.stop_all();
    }
    Ok(())
}

/// Which language servers are alive right now.
#[tauri::command]
pub async fn code_lsp_status(
    state: State<'_, AppState>,
    root: String,
) -> CmdResult<Vec<CodeLspState>> {
    let root = canonical_root(&root)?;
    let key = root_key(&root);
    let manager = state
        .code_lsp
        .lock()
        .ok()
        .and_then(|m| m.get(&key).cloned());
    let Some(manager) = manager else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for language in [
        "typescript",
        "typescriptreact",
        "javascript",
        "rust",
        "go",
        "python",
    ] {
        if manager.has_any(language) {
            out.push(CodeLspState {
                language: language.to_string(),
                state: "running".to_string(),
            });
        }
    }
    Ok(out)
}

/// Sync the file content to the language server (didOpen / didChange).
#[tauri::command]
pub async fn code_lsp_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    path: String,
    content: String,
) -> CmdResult<bool> {
    let root = canonical_root(&root)?;
    let abs = project::resolve_target(&root, &path)?.abs;
    let language = lang::language_for_path(&abs).to_string();
    let manager = manager_for(&state, &root)?;
    // The document belongs to the server of its own workspace (Python: its
    // subproject); a document from another subproject must not be pushed into
    // this instance.
    let workspace = crate::code::lsp::server_root(&root, &language, &path);
    let Some(client) = manager.get(&language, &workspace) else {
        return Ok(false); // No server running: the frontend calls code_lsp_start first
    };
    if !client.alive.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(false);
    }
    let uri = crate::lsp::path_to_uri(&abs);
    let known = client
        .docs
        .lock()
        .map_err(|_| "lock poisoned")?
        .contains_key(&uri);
    if known {
        client.did_change(&uri, &content).await?;
    } else {
        client.did_open(&uri, &language, &content).await?;
    }
    let _ = app;
    Ok(true)
}

/// Close a document (didClose).
#[tauri::command]
pub async fn code_lsp_close(
    state: State<'_, AppState>,
    root: String,
    path: String,
) -> CmdResult<()> {
    let root = canonical_root(&root)?;
    let abs = project::resolve_target(&root, &path)?.abs;
    let language = lang::language_for_path(&abs).to_string();
    let manager = manager_for(&state, &root)?;
    let workspace = crate::code::lsp::server_root(&root, &language, &path);
    if let Some(client) = manager.get(&language, &workspace) {
        let uri = crate::lsp::path_to_uri(&abs);
        let _ = client.did_close(&uri).await;
    }
    Ok(())
}

/// Forward a language server request.
///
/// - `method` goes through an allowlist, so no other request can slip in here;
/// - `textDocument.uri` is injected by the backend from `path`, so the frontend
///   cannot forge a document;
/// - "the server cannot be asked" is an **error** (`LSP_NOT_RUNNING` /
///   `LSP_UNREACHABLE`), never a null: null is the server's own answer "nothing
///   at this position", and telling the two apart is what lets the UI say why
///   a jump did not happen.
#[tauri::command]
pub async fn code_lsp_request(
    state: State<'_, AppState>,
    root: String,
    language: String,
    method: String,
    path: Option<String>,
    mut params: Value,
) -> CmdResult<Value> {
    const ALLOWED: &[&str] = &[
        "textDocument/definition",
        "textDocument/typeDefinition",
        "textDocument/implementation",
        "textDocument/references",
        "textDocument/hover",
        "textDocument/completion",
        "textDocument/signatureHelp",
        "textDocument/documentSymbol",
        "textDocument/prepareRename",
        "textDocument/rename",
        "workspace/symbol",
    ];
    if !ALLOWED.contains(&method.as_str()) {
        return Err(format!("FORBIDDEN_METHOD: {}", method));
    }
    let root = canonical_root(&root)?;
    let manager = manager_for(&state, &root)?;
    // A request that names a document must reach the server of that document's
    // workspace (Python: its subproject); a path-less one (`workspace/symbol`)
    // can use any live server of the language.
    let client = match &path {
        Some(p) => {
            let workspace = crate::code::lsp::server_root(&root, &language, p);
            manager.get(&language, &workspace)
        }
        None => manager.live_of(&language),
    };
    let Some(client) = client else {
        return Err(format!("LSP_NOT_RUNNING: {} 语言服务器没有启动", language));
    };
    if !params.is_object() {
        params = Value::Object(serde_json::Map::new());
    }
    if let Some(p) = &path {
        let abs = project::resolve_target(&root, p)?.abs;
        params["textDocument"] = serde_json::json!({ "uri": crate::lsp::path_to_uri(&abs) });
    }
    match client.interaction_request(&method, params).await {
        Ok(v) => Ok(v),
        // A server that dies mid-request never answers: say so instead of
        // pretending it had nothing to say.
        Err(e) if e.starts_with("LSP_DIED") || e.starts_with("LSP_TIMEOUT") => {
            Err(format!("LSP_UNREACHABLE: {}", e))
        }
        Err(e) => Err(e),
    }
}
