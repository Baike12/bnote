//! 代码项目的 Tauri 命令:打开仓库、读写文件、搜索、git、语言服务器。
//!
//! ## 路径边界
//!
//! 命令都收一个「项目根」,所有文件操作都在根内做(见
//! [`crate::code::project::resolve_in`])。根由用户显式打开(对话框选目录),
//! 所以它就是沙箱边界——不像 vault 那样由应用管理。
//!
//! 项目根统一 canonicalize 之后当键用:同一个目录用不同写法打开
//! (`/tmp/x` 与 `/private/tmp/x`、带尾斜杠)要算成同一个项目,否则会起
//! 两套语言服务器、两份文件树。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use super::CmdResult;
use crate::code::git::{self, GitStatus};
use crate::code::lsp::{LspManager, ResolvedServer, ServerConfig};
use crate::code::project::{self, CodeEntry, CodeFile, CodeSearchHit, CodeTree};
use crate::code::lang;
use crate::state::AppState;

/// 打开的项目的信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeProjectInfo {
    /// 项目根绝对路径。
    pub root: String,
    /// 目录名(项目名)。
    pub name: String,
    /// 是不是 git 仓库。
    pub is_git: bool,
    /// 仓库根(可能是项目根的祖先)。
    pub git_root: Option<String>,
    /// 当前分支。
    pub branch: Option<String>,
    /// 文件树。
    pub tree: CodeTree,
}

/// 某个语言的语言服务器状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeLspState {
    pub language: String,
    /// "running" | "stopped"
    pub state: String,
}

/// 把项目根 canonicalize,并确认它是个目录。
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

/// 项目根的键(canonicalize 后的字符串)。
fn root_key(root: &PathBuf) -> String {
    root.to_string_lossy().to_string()
}

/// 取(或建)这个项目的语言服务器管理器。
fn manager_for(state: &AppState, root: &PathBuf) -> Result<Arc<LspManager>, String> {
    let key = root_key(root);
    if let Ok(map) = state.code_lsp.lock() {
        if let Some(m) = map.get(&key) {
            return Ok(m.clone());
        }
    }
    let manager = Arc::new(LspManager::new(root.clone()));
    let mut map = state.code_lsp.lock().map_err(|_| "lock poisoned")?;
    // 插入前复查:并发的首次请求只留一个 manager(否则会起两套进程)。
    Ok(match map.get(&key) {
        Some(existing) => existing.clone(),
        None => {
            map.insert(key, manager.clone());
            manager
        }
    })
}

/// 打开一个代码项目:扫文件树 + 看 git 状态。
#[tauri::command]
pub async fn code_open_project(root: String) -> CmdResult<CodeProjectInfo> {
    let root = canonical_root(&root)?;
    let tree = project::scan(&root);
    let status = git::status(&root).unwrap_or_default();
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

/// 重扫文件树(用户改了 .gitignore、或在外部新建了文件之后)。
#[tauri::command]
pub async fn code_rescan(root: String) -> CmdResult<CodeTree> {
    let root = canonical_root(&root)?;
    Ok(project::scan(&root))
}

/// 读一个文件(连同它的语言 id)。
#[tauri::command]
pub async fn code_read_file(root: String, path: String) -> CmdResult<CodeFile> {
    let root = canonical_root(&root)?;
    let abs = project::resolve_in(&root, &path)?;
    let (content, binary, size) = project::read_text(&abs)?;
    let language_id = lang::language_for_path(&abs).to_string();
    Ok(CodeFile {
        path,
        language_id,
        content,
        binary,
        size,
    })
}

/// 写一个文件。
#[tauri::command]
pub async fn code_write_file(root: String, path: String, content: String) -> CmdResult<()> {
    let root = canonical_root(&root)?;
    let abs = project::resolve_in(&root, &path)?;
    project::write_text(&abs, &content)
}

/// 在项目里搜文件内容(字面量,忽略大小写)。
#[tauri::command]
pub async fn code_search(
    root: String,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<CodeSearchHit>> {
    let root = canonical_root(&root)?;
    let tree = project::scan(&root);
    Ok(project::search_contents(
        &root,
        &tree.entries,
        &query,
        limit.unwrap_or(200),
    ))
}

/// 文件名模糊搜索(快速打开文件用):按子序列匹配,返回相对路径。
#[tauri::command]
pub async fn code_search_files(root: String, query: String) -> CmdResult<Vec<CodeEntry>> {
    let root = canonical_root(&root)?;
    let tree = project::scan(&root);
    let q = query.to_lowercase();
    let mut hits: Vec<CodeEntry> = tree
        .entries
        .into_iter()
        .filter(|e| !e.is_dir && fuzzy_match(&e.name.to_lowercase(), &q))
        .collect();
    // 命中的排前面,目录顺序兜底。
    hits.sort_by(|a, b| {
        let ra = rank(&a.name.to_lowercase(), &q);
        let rb = rank(&b.name.to_lowercase(), &q);
        ra.cmp(&rb).then_with(|| a.path.cmp(&b.path))
    });
    hits.truncate(50);
    Ok(hits)
}

/// 子序列匹配:`abc` 能命中 `a_b_c`。
fn fuzzy_match(text: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let mut chars = text.chars();
    query.chars().all(|q| chars.any(|c| c == q))
}

/// 命中质量:完全相等 > 前缀 > 包含 > 子序列。
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

/// 读 git 状态。
#[tauri::command]
pub async fn code_git_status(root: String) -> CmdResult<GitStatus> {
    let root = canonical_root(&root)?;
    git::status(&root)
}

/// 取一个文件的差异(unified diff 文本)。
#[tauri::command]
pub async fn code_git_diff(root: String, path: String, staged: bool) -> CmdResult<String> {
    let root = canonical_root(&root)?;
    git::diff(&root, &path, staged)
}

/// 暂存一个文件的改动,并回新的状态。
#[tauri::command]
pub async fn code_git_stage(root: String, path: String) -> CmdResult<GitStatus> {
    let root = canonical_root(&root)?;
    let repo = git::repo_root(&root).ok_or("NOT_A_REPO: 不是 git 仓库")?;
    git::stage(&repo, &path)?;
    git::status(&root)
}

/// 把改动从暂存区撤回,并回新的状态。
#[tauri::command]
pub async fn code_git_unstage(root: String, path: String) -> CmdResult<GitStatus> {
    let root = canonical_root(&root)?;
    let repo = git::repo_root(&root).ok_or("NOT_A_REPO: 不是 git 仓库")?;
    git::unstage(&repo, &path)?;
    git::status(&root)
}

/// 解析这个语言该用哪个语言服务器(前端据此决定要不要显示 LSP 入口)。
#[tauri::command]
pub async fn code_lsp_resolve(
    root: String,
    language: String,
    overrides: Option<ServerConfig>,
) -> CmdResult<Option<ResolvedServerInfo>> {
    let root = canonical_root(&root)?;
    let resolved = crate::code::lsp::resolve_server(&root, &language, overrides.as_ref());
    Ok(resolved.map(|r| ResolvedServerInfo {
        command: r.config.command,
        args: r.config.args,
        disabled: r.disabled,
    }))
}

/// 解析结果给前端的形状。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedServerInfo {
    pub command: String,
    pub args: Vec<String>,
    pub disabled: bool,
}

/// 确保某个语言的服务器起着。
#[tauri::command]
pub async fn code_lsp_start(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    language: String,
    overrides: Option<ServerConfig>,
) -> CmdResult<CodeLspState> {
    let root = canonical_root(&root)?;
    let Some(resolved) = crate::code::lsp::resolve_server(&root, &language, overrides.as_ref())
    else {
        return Err(format!("LSP_UNSUPPORTED: {} 没有可用的语言服务器", language));
    };
    if resolved.disabled {
        return Err(format!("LSP_DISABLED: {} 已被项目配置关掉", language));
    }
    let manager = manager_for(&state, &root)?;
    manager
        .ensure(&language, &resolved.config, app)
        .await
        .map(|_| CodeLspState {
            language,
            state: "running".to_string(),
        })
}

/// 停掉这个项目的所有语言服务器。
#[tauri::command]
pub async fn code_lsp_stop(state: State<'_, AppState>, root: String) -> CmdResult<()> {
    let root = canonical_root(&root)?;
    let key = root_key(&root);
    let manager = {
        let mut map = state.code_lsp.lock().map_err(|_| "lock poisoned")?;
        map.remove(&key)
    };
    if let Some(m) = manager {
        m.stop_all();
    }
    Ok(())
}

/// 当前有哪些语言的服务器活着。
#[tauri::command]
pub async fn code_lsp_status(state: State<'_, AppState>, root: String) -> CmdResult<Vec<CodeLspState>> {
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
    for language in ["typescript", "typescriptreact", "javascript", "rust", "go", "python"] {
        if manager.has(language) {
            out.push(CodeLspState {
                language: language.to_string(),
                state: "running".to_string(),
            });
        }
    }
    Ok(out)
}

/// 把文件内容同步给语言服务器(didOpen / didChange)。
#[tauri::command]
pub async fn code_lsp_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    path: String,
    content: String,
) -> CmdResult<bool> {
    let root = canonical_root(&root)?;
    let abs = project::resolve_in(&root, &path)?;
    let language = lang::language_for_path(&abs).to_string();
    let manager = manager_for(&state, &root)?;
    if !manager.has(&language) {
        return Ok(false); // 没起服务器:前端会先 code_lsp_start
    }
    let Some(client) = manager.get(&language) else {
        return Ok(false);
    };
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

/// 关掉一个文档(didClose)。
#[tauri::command]
pub async fn code_lsp_close(state: State<'_, AppState>, root: String, path: String) -> CmdResult<()> {
    let root = canonical_root(&root)?;
    let abs = project::resolve_in(&root, &path)?;
    let language = lang::language_for_path(&abs).to_string();
    let manager = manager_for(&state, &root)?;
    if let Some(client) = manager.get(&language) {
        let uri = crate::lsp::path_to_uri(&abs);
        let _ = client.did_close(&uri).await;
    }
    Ok(())
}

/// 转发一个语言服务器请求。
///
/// - `method` 走白名单,杜绝别的请求从这条路溜进来;
/// - `textDocument.uri` 由后端按 `path` 注入,前端给不了假文档;
/// - 服务器没起来就回 null(前端据此降级,不当错误弹)。
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
    let Some(client) = manager.get(&language) else {
        return Ok(Value::Null);
    };
    if !params.is_object() {
        params = Value::Object(serde_json::Map::new());
    }
    if let Some(p) = &path {
        let abs = project::resolve_in(&root, p)?;
        params["textDocument"] = serde_json::json!({ "uri": crate::lsp::path_to_uri(&abs) });
    }
    match client.interaction_request(&method, params).await {
        Ok(v) => Ok(v),
        // 服务器中途没了不算错误:前端降级即可。
        Err(e) if e.starts_with("LSP_DIED") || e.starts_with("LSP_TIMEOUT") => Ok(Value::Null),
        Err(e) => Err(e),
    }
}
