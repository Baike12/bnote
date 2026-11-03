//! Study-mode commands: agent sessions, definitions, config, and PDF→markdown
//! conversion.

use super::pen_cursor;
use super::CmdResult;
use crate::agent::defs::{self, AgentDefinition};
use crate::agent::mcp::McpManager;
use crate::agent::session::{create_session, SessionMode, SessionSeed};
use crate::agent::shell::{BgRegistry, ShellCwd};
use crate::agent::skills::SkillRegistry;
use crate::agent::tools::{StudyContent, ToolContext};
use crate::agent::Provider;
use crate::state::AppState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, State};

/// Global switch for selection translation in web pages. The page sends
/// requests through `document.title`, and any page script can forge the same
/// title -- so gate hard on this switch first, then rate-limit sentence
/// requests to one per 600ms; single words only hit the built-in dictionary
/// and cost no API quota.
static PREVIEW_TRANSLATE_ENABLED: AtomicBool = AtomicBool::new(false);
static PREVIEW_TRANSLATE_LAST: Mutex<Option<Instant>> = Mutex::new(None);

fn get_mcp_manager(state: &State<'_, AppState>) -> Option<Arc<McpManager>> {
    state.mcp_manager.lock().ok().and_then(|g| g.clone())
}

/// Fork point for a helper session: take the first `items` entries of the
/// `from` session's history (a prefix that includes the forking message) as
/// the new session's initial history. The source session is left untouched.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentForkSpec {
    pub from: String,
    pub items: usize,
}

/// A restored session keeps its own model configuration (the snapshot in the
/// first line of the session record).
///
/// After the model/context length changes in settings, a saved session still
/// continues with the configuration it was created with -- that is an explicit
/// user choice: a session's model must not be silently swapped by later
/// settings. The API key is not part of the snapshot; it always uses the
/// currently saved `api_key` (switching provider requires a new key anyway).
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelChoice {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub context_window: u64,
}

impl AgentModelChoice {
    /// Overrides only the fields that actually carry a value in the snapshot:
    /// older records missing a field fall back to the current configuration.
    fn apply(self, cfg: &mut crate::agent::AgentConfig) {
        if !self.provider.is_empty() {
            cfg.provider = self.provider;
        }
        if !self.model.is_empty() {
            cfg.model = self.model;
        }
        if !self.base_url.is_empty() {
            cfg.base_url = self.base_url;
        }
        if self.max_tokens > 0 {
            cfg.max_tokens = self.max_tokens;
        }
        if self.context_window > 0 {
            cfg.context_window = self.context_window;
        }
    }
}

/// Custom instructions moved to `crate::agent::load_user_instructions` (the
/// session refreshes them dynamically; the command layer only seeds the first
/// assembly through the same helper).

#[tauri::command]
pub async fn agent_get_config(state: State<'_, AppState>) -> CmdResult<crate::agent::AgentConfig> {
    // Same reasoning as config.rs: a sync command runs on the main thread, so
    // every IO call goes to the worker pool.
    let dir = state.data_dir();
    tauri::async_runtime::spawn_blocking(move || Ok(crate::agent::AgentConfig::load(&dir)))
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_save_config(
    state: State<'_, AppState>,
    config: crate::agent::AgentConfig,
) -> CmdResult<()> {
    let dir = state.data_dir();
    tauri::async_runtime::spawn_blocking(move || config.save(&dir))
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Ensures an MCP manager for the current config (reconnects when missing).
async fn ensure_mcp(state: &State<'_, AppState>) -> Result<Arc<McpManager>, String> {
    if let Some(m) = get_mcp_manager(state) {
        return Ok(m);
    }
    let cfg = crate::agent::AgentConfig::load(&state.data_dir());
    let manager = Arc::new(McpManager::connect_all(&cfg).await);
    if let Ok(mut cell) = state.mcp_manager.lock() {
        *cell = Some(manager.clone());
    }
    Ok(manager)
}

#[tauri::command]
pub async fn agent_start_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    study: Option<StudyContent>,
    fork: Option<AgentForkSpec>,
    // Restore a saved session: the model-side history the frontend rebuilt
    // from the session record's jsonl.
    // Mutually exclusive with `fork` (restore and fork never happen together).
    history: Option<Vec<crate::agent::types::ChatItem>>,
    // On restore/fork, reuse the source session's model configuration
    // (see AgentModelChoice).
    model: Option<AgentModelChoice>,
    // Session shape: omitted = study mode (plain Q&A); "creative" = creative
    // mode (tools + skills); "coding" = the code-project agent.
    mode: Option<String>,
) -> CmdResult<serde_json::Value> {
    let session_mode = SessionMode::parse(mode.as_deref())?;
    let mut cfg = crate::agent::AgentConfig::load(&state.data_dir());
    if let Some(choice) = model {
        choice.apply(&mut cfg);
    }
    if cfg.api_key.is_empty() {
        return Err("NO_API_KEY: 在设置的 Agent 部分填写 API Key".into());
    }
    // The effective definition: built-ins + user files, with the seed history
    // (restore/fork) carried over unchanged.
    let vault = state.vault();
    let (defs, def_errors) = defs::load_definitions(vault.as_deref());
    let def_id = session_mode.definition_id();
    let def = Arc::new(
        defs.into_iter()
            .find(|d| d.id == def_id)
            .ok_or_else(|| format!("DEF_MISSING: agent 定义 {} 不存在", def_id))?,
    );
    // Only MCP-enabled sessions pay for connecting servers.
    let mcp = if def.mcp_enabled() {
        ensure_mcp(&state).await?
    } else {
        Arc::new(McpManager {
            connections: Default::default(),
            tools: Vec::new(),
            errors: Vec::new(),
        })
    };
    let skills = Arc::new(SkillRegistry::discover(
        &state.data_dir(),
        vault.as_ref(),
        &cfg.skill_dirs,
    ));

    let provider = Arc::new(Provider::new(
        &cfg.provider,
        &cfg.base_url,
        &cfg.api_key,
        &cfg.model,
        cfg.max_tokens,
    ));

    // Fork: copy a history prefix from the source session (the count is
    // authoritative in the backend's end event -- truncate if too long, use
    // what exists if too short). A missing source session means the frontend
    // state is stale, so report it honestly.
    // Restore: the frontend turns the session record back into ChatItems and
    // uses them directly as the initial history.
    let seed_items: Vec<crate::agent::types::ChatItem> = match (history, &fork) {
        (Some(items), _) => items,
        (None, None) => Vec::new(),
        (None, Some(spec)) => {
            let snapshot = {
                let registry = state.sessions.lock().map_err(|e| e.to_string())?;
                let src = registry
                    .get(&spec.from)
                    .ok_or_else(|| "SESSION_NOT_FOUND: 源会话已不存在".to_string())?;
                src.history()
            };
            let n = spec.items.min(snapshot.len());
            snapshot[..n].to_vec()
        }
    };

    let vault_name = vault
        .as_ref()
        .and_then(|v| v.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_default();
    let current_note = state.current_note.lock().ok().and_then(|n| n.clone());
    let mcp_names: Vec<String> = mcp.tools.iter().map(|t| t.name.clone()).collect();
    // Coding sessions anchor at the opened code project: relative tool paths
    // and bash start there, writes are confined to vault ∪ project.
    let workdir = match (session_mode, study.as_ref()) {
        (SessionMode::Coding, Some(StudyContent::Code { path, .. })) => Some(PathBuf::from(path)),
        _ => None,
    };
    let ctx = Arc::new(ToolContext {
        vault: vault.clone(),
        data_dir: state.data_dir(),
        study_content: Arc::new(std::sync::RwLock::new(study)),
        abort: Arc::new(AtomicBool::new(false)),
        app: Some(app.clone()),
        preview_seq: std::sync::atomic::AtomicU64::new(0),
        workdir,
        shell: Arc::new(ShellCwd::new()),
        bg: Arc::new(BgRegistry::new()),
    });

    // Timestamp + increasing sequence number: opening the main session and
    // forking a helper session within the same millisecond cannot collide.
    static SESSION_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SESSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!(
        "s{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        seq
    );
    let session = Arc::new(create_session(SessionSeed {
        id: id.clone(),
        mode: session_mode,
        def: def.clone(),
        vault_name,
        current_note,
        mcp_names,
        user_instructions: crate::agent::load_user_instructions(vault.as_deref()),
        skills,
        mcp: mcp.clone(),
        provider,
        ctx,
        app: app.clone(),
        context_window: cfg.context_window,
    }));
    {
        let mut registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry.insert(id.clone(), session.clone());
    }
    // The self weak-reference powers the background-task wakeup path.
    if let Ok(mut slot) = session.self_ref.lock() {
        *slot = Some(Arc::downgrade(&session));
    }
    // Restore/fork seeds enter the history after construction.
    if !seed_items.is_empty() {
        if let Ok(mut items) = session.items.lock() {
            *items = seed_items;
        }
    }

    Ok(serde_json::json!({
        "sessionId": id,
        "skills": session.skills.skills,
        "mcpTools": mcp.tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
        "mcpErrors": mcp.errors.clone(),
        "definition": {
            "id": def.id,
            "name": def.display_name(),
            "description": def.description.clone(),
            "tools": def.effective_tools(),
        },
        "defErrors": def_errors,
        // The model configuration this session actually uses: the frontend
        // footnote shows it, and the session record writes it into its
        // metadata line so a restore continues from the snapshot (decoupled
        // from the current settings).
        "model": {
            "provider": cfg.provider,
            "model": cfg.model,
            "baseUrl": cfg.base_url,
            "maxTokens": cfg.max_tokens,
            "contextWindow": cfg.context_window,
        },
    }))
}

/// System prompt for titling: only the title itself, no restating the whole
/// sentence and no extra punctuation.
const TITLE_SYSTEM_PROMPT: &str = "你在给一段对话起标题。根据用户的第一条消息，给出一个能概括主题的短标题：不超过 14 个汉字（英文不超过 8 个词），不要引号、不要书名号、不要句末标点、不要「标题：」这类前缀，只输出标题本身。";

/// Titles a session from **its own** first message by asking the model for a
/// short title.
///
/// Shares the model configuration with the conversation (a restored session
/// passes its own snapshot); sends one short request only, registers no
/// session and enters no session history. On failure the caller keeps its
/// locally truncated title.
#[tauri::command]
pub async fn agent_generate_title(
    state: State<'_, AppState>,
    text: String,
    model: Option<AgentModelChoice>,
) -> CmdResult<String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("BAD_ARGS: text".into());
    }
    let mut cfg = crate::agent::AgentConfig::load(&state.data_dir());
    if let Some(choice) = model {
        choice.apply(&mut cfg);
    }
    if cfg.api_key.is_empty() {
        return Err("NO_API_KEY: 在设置的 Agent 部分填写 API Key".into());
    }
    let provider = Provider::new(
        &cfg.provider,
        &cfg.base_url,
        &cfg.api_key,
        &cfg.model,
        cfg.max_tokens,
    );
    let items = vec![crate::agent::types::ChatItem::user_text(&text)];
    let collected = Mutex::new(String::new());
    provider
        .stream_turn(TITLE_SYSTEM_PROMPT, &items, &[], &|event| {
            if let crate::agent::types::AgentEvent::TextDelta { text } = event {
                if let Ok(mut buf) = collected.lock() {
                    buf.push_str(&text);
                }
            }
        })
        .await?;
    collected.into_inner().map_err(|e| e.to_string())
}

/// Skill inventory for the settings page and the input box's `/` completion
/// (discovered on every call, so it reflects what is actually on disk).
#[tauri::command]
pub async fn agent_list_skills(
    state: State<'_, AppState>,
) -> CmdResult<Vec<crate::agent::skills::SkillInfo>> {
    let cfg = crate::agent::AgentConfig::load(&state.data_dir());
    let dir = state.data_dir();
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(SkillRegistry::discover(&dir, vault.as_ref(), &cfg.skill_dirs).skills)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

// ---------------------------------------------------------------------------
// Agent definitions: the plugin surface (list / read / write / delete) plus
// the compaction entry and the assembly preview.
// ---------------------------------------------------------------------------

/// Definition ids are file names: restrict them to the safe subset up front so
/// `<vault>/.bnote/agents/<id>.md` can never traverse.
fn valid_def_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err("INVALID_ID: id 只能包含字母/数字/-/_,且不超过 64 字符".into())
    }
}

fn definitions_dir(vault: &Option<PathBuf>) -> Result<PathBuf, String> {
    vault
        .as_ref()
        .map(|v| v.join(".bnote").join("agents"))
        .ok_or_else(|| "NO_VAULT: agent 定义保存在仓库的 .bnote/agents/,请先打开仓库".to_string())
}

/// The definition inventory: built-ins + user files, each tagged with where it
/// comes from and whether its file failed to parse (a broken file must be
/// visible and editable, not silently skipped).
#[tauri::command]
pub async fn agent_list_definitions(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let (defs, errors) = defs::load_definitions(vault.as_deref());
        let user_dir = vault.as_ref().map(|v| v.join(".bnote").join("agents"));
        let list: Vec<serde_json::Value> = defs
            .iter()
            .map(|d| {
                let is_user = user_dir
                    .as_ref()
                    .map(|dir| dir.join(format!("{}.md", d.id)).is_file())
                    .unwrap_or(false);
                serde_json::json!({
                    "id": d.id,
                    "name": d.display_name(),
                    "description": d.description,
                    "source": if is_user { "user" } else { "builtin" },
                    "tools": d.effective_tools(),
                })
            })
            .collect();
        Ok(serde_json::json!({ "definitions": list, "errors": errors }))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// One definition with its file content. Built-ins serialize through the
/// canonical writer so the settings page always shows a load-bearing form.
#[tauri::command]
pub async fn agent_get_definition(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<serde_json::Value> {
    valid_def_id(&id)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let (defs, errors) = defs::load_definitions(vault.as_deref());
        let def = defs
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| format!("DEF_NOT_FOUND: {}", id))?;
        let user_file = vault
            .as_ref()
            .map(|v| v.join(".bnote").join("agents").join(format!("{}.md", id)));
        let parse_error = errors
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.message.clone());
        Ok(match user_file {
            Some(path) if path.is_file() => {
                let content =
                    std::fs::read_to_string(&path).map_err(|e| format!("READ_FAILED: {}", e))?;
                serde_json::json!({
                    "source": "user",
                    "file": path.display().to_string(),
                    "content": content,
                    "definition": def,
                    "parseError": parse_error,
                })
            }
            _ => serde_json::json!({
                "source": "builtin",
                "file": null,
                "content": defs::serialize_definition(def),
                "definition": def,
                "parseError": parse_error,
            }),
        })
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Writes (creating if needed) `<vault>/.bnote/agents/<id>.md` from the
/// definition. The canonical serializer runs here so the file on disk and the
/// parser can never drift.
#[tauri::command]
pub async fn agent_save_definition(
    state: State<'_, AppState>,
    definition: AgentDefinition,
) -> CmdResult<String> {
    valid_def_id(&definition.id)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = definitions_dir(&vault)?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        let path = dir.join(format!("{}.md", definition.id));
        std::fs::write(&path, defs::serialize_definition(&definition))
            .map_err(|e| format!("WRITE_FAILED: {}", e))?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Deletes a user definition file. Built-ins have no file: deleting one is a
/// NO_VAULT/NOT_FOUND, not a silent success.
#[tauri::command]
pub async fn agent_delete_definition(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    valid_def_id(&id)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = definitions_dir(&vault)?;
        let path = dir.join(format!("{}.md", id));
        if !path.is_file() {
            return Err(format!(
                "DEF_NOT_FOUND: {} 没有用户定义文件(内置定义不可删除)",
                id
            ));
        }
        std::fs::remove_file(&path).map_err(|e| format!("DELETE_FAILED: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Manual compaction (/compact). Same claim protocol as agent_send: the CAS
/// keeps two compactions from racing a running turn.
#[tauri::command]
pub async fn agent_compact(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let session = {
        let registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry
            .get(&session_id)
            .cloned()
            .ok_or("SESSION_NOT_FOUND".to_string())?
    };
    if session
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("SESSION_BUSY: 还有回复在生成".into());
    }
    tauri::async_runtime::spawn(async move {
        use futures::FutureExt;
        let turn = std::panic::AssertUnwindSafe(session.run_compact());
        if turn.catch_unwind().await.is_err() {
            session.emit(crate::agent::types::AgentEvent::Error {
                message: "压缩失败,本轮已中止(可重试)".into(),
                items: session.history().len(),
            });
        }
    });
    Ok(())
}

/// Dry-runs the assembly pipeline for the definition editor's preview: the
/// ordered segments with their content, plus a flag per layer on whether its
/// file actually loaded. No session is created.
#[tauri::command]
pub async fn agent_assemble_preview(
    state: State<'_, AppState>,
    definition: AgentDefinition,
    workdir: Option<String>,
) -> CmdResult<Vec<crate::agent::prompt::PromptSegment>> {
    let vault = state.vault();
    let data_dir = state.data_dir();
    let cfg = crate::agent::AgentConfig::load(&data_dir);
    let current_note = state.current_note.lock().ok().and_then(|n| n.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let skills = SkillRegistry::discover(&data_dir, vault.as_ref(), &cfg.skill_dirs);
        let vault_name = vault
            .as_ref()
            .and_then(|v| v.file_name().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_default();
        let user = crate::agent::load_user_instructions(vault.as_deref());
        let input = crate::agent::prompt::AssembleInput {
            def: &definition,
            vault_name: &vault_name,
            current_note: current_note.as_deref(),
            workdir: workdir.as_deref(),
            vault: vault.as_deref(),
            study: None,
            skills: &skills.skills,
            mcp_names: &[],
            user_instructions: &user,
        };
        Ok(crate::agent::prompt::segments(&input))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_send(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    // Older callers (the browser harness) send no images: the absent Option
    // defaults to empty and behaves like plain text.
    images: Option<Vec<crate::agent::types::InlineImage>>,
) -> CmdResult<()> {
    let session = {
        let registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "SESSION_NOT_FOUND".to_string())?
    };
    // Check and claim must be atomic: loading first and setting the flag
    // later, inside the spawned task, leaves a window in which two sends
    // both slip in and run the same session history concurrently. With CAS,
    // whoever arrives first takes the slot; the slot is released by the
    // session's RunningGuard when the turn ends.
    if session
        .running
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return Err("SESSION_BUSY: 还有回复在生成".into());
    }
    // Run the turn in the background; events stream to the frontend.
    tauri::async_runtime::spawn(async move {
        use futures::FutureExt;
        let turn = std::panic::AssertUnwindSafe(session.send(&text, images.unwrap_or_default()));
        // A panic must still produce a terminal event: otherwise the frontend
        // stays stuck on "generating", and later sends are rejected by
        // SESSION_BUSY with only a toast that disappears after seconds.
        if turn.catch_unwind().await.is_err() {
            session.emit(crate::agent::types::AgentEvent::Error {
                message: "会话内部错误,本轮已中止(可重试)".into(),
                items: session.history().len(),
            });
        }
    });
    Ok(())
}

#[tauri::command]
pub fn agent_abort(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = registry.get(&session_id) {
        session
            .ctx
            .abort
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn agent_get_history(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Vec<crate::agent::types::ChatItem>> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = registry.get(&session_id).ok_or("SESSION_NOT_FOUND")?;
    Ok(session.history())
}

/// Label of the study-mode web preview embedded in the middle column.
///
/// It is a child *webview* of the main window, not an iframe: a site can
/// refuse to be framed (`X-Frame-Options` / CSP `frame-ancestors`), and a
/// child webview is a plain browser view that ignores both. The cost is that
/// it is a native view — it does not take part in DOM layout, so the frontend
/// reports the rectangle of its placeholder element and we keep the native
/// view glued to it.
const STUDY_PREVIEW_LABEL: &str = "study-preview";

/// Label of the standalone preview window (escape hatch when a page misbehaves
/// inside the embedded view).
const STUDY_WINDOW_LABEL: &str = "study-preview-window";

/// Rectangle of the middle column's preview placeholder, in logical pixels
/// relative to the top-left corner of the window's content area — which is
/// what `Element.getBoundingClientRect()` returns.
#[derive(serde::Deserialize)]
pub struct PreviewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl PreviewBounds {
    fn position(&self) -> tauri::LogicalPosition<f64> {
        tauri::LogicalPosition::new(self.x, self.y)
    }

    fn size(&self) -> tauri::LogicalSize<f64> {
        tauri::LogicalSize::new(self.width, self.height)
    }

    fn rect(&self) -> tauri::Rect {
        tauri::Rect {
            position: tauri::Position::Logical(self.position()),
            size: tauri::Size::Logical(self.size()),
        }
    }
}

fn parse_study_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("INVALID_URL: {}", e))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("INVALID_URL: 只支持 http/https 链接({})", url));
    }
    Ok(parsed)
}

/// Shows (creating if needed) the embedded preview on the middle column.
///
/// Called on mount and whenever the URL changes; a ResizeObserver reports
/// geometry-only updates through [`set_study_preview_bounds`].
///
/// `annotation_script` is the page-side annotation runtime (built by
/// `study/webAnnotations.ts`). It is registered as an initialization script at
/// creation, so every navigation — including links the user clicks inside the
/// page — re-installs it. The script only touches its own DOM/localStorage and
/// reports changes through `document.title`; remote IPC stays closed.
#[tauri::command]
pub async fn show_study_preview(
    app: tauri::AppHandle,
    url: String,
    bounds: PreviewBounds,
    annotation_script: String,
) -> CmdResult<()> {
    use tauri::Manager;

    let parsed = parse_study_url(&url)?;
    if let Some(existing) = app.get_webview(STUDY_PREVIEW_LABEL) {
        let _ = existing.set_bounds(bounds.rect());
        existing
            .navigate(parsed)
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        existing
            .show()
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        // The script was registered when the webview was created; install it
        // once more so the current document really has the runtime (after a
        // hot update the script in the old webview may be a stale version).
        if !annotation_script.trim().is_empty() {
            let _ = existing.eval(annotation_script);
        }
        // Pen cursor: the same webview may be reused, so attach it again
        // (idempotent).
        let _ = existing.with_webview(|platform| pen_cursor::attach(platform.inner()));
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "WEBVIEW_FAILED: 找不到主窗口".to_string())?;
    // add_child schedules the build on the main thread and waits for the
    // result, so it may only be called from an async command (calling it
    // from a sync command or an event callback deadlocks; see tauri's
    // WebviewBuilder docs).
    let webview = window
        .add_child(
            tauri::webview::WebviewBuilder::new(
                STUDY_PREVIEW_LABEL,
                tauri::WebviewUrl::External(parsed),
            )
            .initialization_script(annotation_script)
            // After the page loads, tell the main window: re-apply the
            // annotation mode and push the vault's anchors back into the page.
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = webview.emit_to(
                        "main",
                        "study-preview-loaded",
                        payload.url().to_string(),
                    );
                }
            })
            // Annotation changes in the page are written behind the
            // `bnote-anno:` prefix of document.title.
            // No remote IPC: no web page can reach app commands; this title
            // channel only carries data.
            // WeRead's route tracking (`src/study/weread.ts`) reuses the
            // same channel with the `bnote-weread:` prefix and is dispatched
            // as study-weread-route; titles without a prefix (the page title
            // WeRead sets itself) are ignored.
            .on_document_title_changed(|webview, title| {
                const ANNO_PREFIX: &str = "bnote-anno:";
                const WEREAD_PREFIX: &str = "bnote-weread:";
                // Reading-region shortcuts pressed inside the page (switch to
                // the Agent panel / notes region). Keys in a child webview do
                // not bubble to the main window, so they are forwarded through
                // this existing title channel.
                const KEY_PREFIX: &str = "bnote-key:";
                // Selection translation: the page only sends the text and a
                // request id; the translation happens in Rust (single words hit
                // the built-in dictionary, sentences go through the configured
                // API) and the result is eval'd back into the page's card. That
                // way the page never sees the API key and does not need a
                // detour through the main window and the child webview.
                const TRANSLATE_PREFIX: &str = "bnote-translate:";
                if let Some(raw) = title.strip_prefix(TRANSLATE_PREFIX) {
                    let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw) else {
                        return;
                    };
                    let id = payload
                        .get("id")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    let text = payload
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    // The page generates a document token on every load and
                    // sends it back verbatim with the result, so a late reply
                    // from before a navigation cannot be painted onto the new
                    // page.
                    let doc = payload
                        .get("doc")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if id == 0 || text.trim().is_empty() || doc.is_empty() || doc.len() > 80 {
                        return;
                    }
                    let doc_lit =
                        serde_json::to_string(&doc).unwrap_or_else(|_| "\"\"".to_string());
                    // Switch off: even a page script forging the title cannot
                    // trigger a lookup or translation.
                    if !PREVIEW_TRANSLATE_ENABLED.load(Ordering::Relaxed) {
                        return;
                    }
                    // Sentences go through a paid API: at most one per 600ms;
                    // single words only hit the built-in dictionary, cost no
                    // quota, and work normally when selected in quick
                    // succession.
                    if matches!(
                        crate::translate::classify(&text),
                        crate::translate::SelectionKind::Sentence
                    ) {
                        let allowed = match PREVIEW_TRANSLATE_LAST.lock() {
                            Ok(mut slot) => {
                                let now = Instant::now();
                                let fresh = match *slot {
                                    Some(last) => {
                                        now.saturating_duration_since(last)
                                            >= Duration::from_millis(600)
                                    }
                                    None => true,
                                };
                                if fresh {
                                    *slot = Some(now);
                                }
                                fresh
                            }
                            Err(_) => false,
                        };
                        if !allowed {
                            let js = format!(
                                "window.__bnoteAnno && window.__bnoteAnno.showTranslation({}, {}, {});",
                                id,
                                doc_lit,
                                serde_json::json!({
                                    "kind": "error",
                                    "message": "翻译请求过于频繁，请稍后再试。",
                                })
                            );
                            let _ = webview.eval(js);
                            return;
                        }
                    }
                    let webview = webview.clone();
                    let data_dir = webview.app_handle().path().app_data_dir().ok();
                    tauri::async_runtime::spawn(async move {
                        let payload = match data_dir {
                            None => serde_json::json!({
                                "kind": "error",
                                "message": "无法定位应用数据目录",
                            }),
                            Some(dir) => {
                                match crate::translate::translate_selection(&dir, &text).await {
                                    Ok(result) => {
                                        serde_json::to_value(result).unwrap_or_else(|_| {
                                            serde_json::json!({
                                                "kind": "error",
                                                "message": "翻译结果序列化失败",
                                            })
                                        })
                                    }
                                    Err(e) => {
                                        serde_json::json!({ "kind": "error", "message": e })
                                    }
                                }
                            }
                        };
                        let js = format!(
                            "window.__bnoteAnno && window.__bnoteAnno.showTranslation({}, {}, {});",
                            id, doc_lit, payload
                        );
                        let _ = webview.eval(js);
                    });
                    return;
                }
                let (event, raw) = if let Some(raw) = title.strip_prefix(ANNO_PREFIX) {
                    ("study-web-annotations", raw)
                } else if let Some(raw) = title.strip_prefix(WEREAD_PREFIX) {
                    ("study-weread-route", raw)
                } else if let Some(raw) = title.strip_prefix(KEY_PREFIX) {
                    ("study-preview-key", raw)
                } else {
                    return;
                };
                let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw) else {
                    return;
                };
                let _ = webview.emit_to("main", event, payload);
            }),
            bounds.position(),
            bounds.size(),
        )
        .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    // The pen cursor lives on the native view: the page CSS only keeps the
    // native cursor keyword, the real pen is swapped in here.
    let _ = webview.with_webview(|platform| pen_cursor::attach(platform.inner()));
    Ok(())
}

/// Sets the page-side annotation tool: `"highlight"` (yellow), `"note"`
/// (blue + in-page note card), or `None` to leave annotation mode.
#[tauri::command]
pub fn set_study_preview_annotation_mode(
    app: tauri::AppHandle,
    mode: Option<String>,
) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        let arg = match mode.as_deref() {
            Some("highlight") => "\"highlight\"",
            Some("note") => "\"note\"",
            _ => "null",
        };
        webview
            .eval(format!(
                "window.__bnoteAnno && window.__bnoteAnno.setMode({});",
                arg
            ))
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        // The native pen follows the tool (highlight = yellow pen, text note =
        // blue pen); leaving annotation mode still uses the yellow pen.
        pen_cursor::set_mode(mode.as_deref() == Some("note"));
    }
    Ok(())
}

/// Enables/disables selection translation in the embedded web page.
///
/// Translation and annotation never compete for the same gesture: the page
/// runtime only translates when its annotation mode is `null`, and entering an
/// annotation mode closes any open translation card. This flag is the user's
/// global switch; the annotation tool remains the higher-priority mode.
#[tauri::command]
pub fn set_study_preview_translate(app: tauri::AppHandle, enabled: bool) -> CmdResult<()> {
    PREVIEW_TRANSLATE_ENABLED.store(enabled, Ordering::Relaxed);
    if let Ok(mut slot) = PREVIEW_TRANSLATE_LAST.lock() {
        *slot = None;
    }
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .eval(format!(
                "window.__bnoteAnno && window.__bnoteAnno.setTranslate({});",
                enabled
            ))
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// Study-mode paging: while focus is in the main window, the command layer
/// forwards PageUp/PageDown to the embedded web page here. The in-page runtime
/// detects the main scroll container itself and scrolls by the configured step.
#[tauri::command]
pub fn scroll_study_preview(app: tauri::AppHandle, delta: i32) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        let direction = delta.signum();
        if direction != 0 {
            webview
                .eval(format!(
                    "window.__bnoteReader && window.__bnoteReader.page({});",
                    direction
                ))
                .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        }
    }
    Ok(())
}

/// Pushes the paging step to the in-page runtime (shared by keyboard paging
/// and the top-half gradient).
#[tauri::command]
pub fn set_study_preview_read_step(app: tauri::AppHandle, step: f64) -> CmdResult<()> {
    use tauri::Manager;
    let step = if step.is_finite() {
        step.clamp(0.1, 1.0)
    } else {
        0.5
    };
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .eval(format!(
                "window.__bnoteReader && window.__bnoteReader.setStep({});",
                step
            ))
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// Hands keyboard focus to the embedded web page (used by the region-switch
/// command "switch to reading region").
///
/// The native child webview's focus is not part of the main window's DOM:
/// focusing only the main window's placeholder div still keeps the keys from
/// reaching the page. Focusing the native view here hands the keys to the
/// in-page runtime.
#[tauri::command]
pub fn focus_study_preview(app: tauri::AppHandle) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .set_focus()
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// Pushes the command layer's paging bindings to the in-page runtime (custom
/// shortcuts work inside the web page too).
#[tauri::command]
pub fn set_study_preview_read_keys(
    app: tauri::AppHandle,
    prev: Vec<String>,
    next: Vec<String>,
) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        let payload = serde_json::json!({ "prev": prev, "next": next });
        webview
            .eval(format!(
                "window.__bnoteReader && window.__bnoteReader.setKeys({}, {});",
                payload["prev"], payload["next"]
            ))
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// Pushes the reading-region shortcuts that are "forwarded to the main window"
/// to the in-page runtime.
///
/// Web pages and WeRead run in a native child webview, so their keys never
/// bubble to the main window; the in-page runtime matches these keys, writes
/// document.title, and the title channel above turns it into
/// `study-preview-key`.
#[tauri::command]
pub fn set_study_preview_shortcuts(app: tauri::AppHandle, keys: Vec<String>) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        let list = serde_json::to_string(&keys).unwrap_or_else(|_| "[]".to_string());
        webview
            .eval(format!(
                "window.__bnoteReader && window.__bnoteReader.setHostKeys({});",
                list
            ))
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// Page zoom of the embedded web page (browser-level: text reflows and the
/// whole page scales).
///
/// The zoom value is owned only by the main window's settings (single
/// writer); here it is translated into the native view's page zoom: on macOS
/// `WKWebView.pageZoom`, on Windows WebView2's `SetZoomFactor` -- both live
/// on the view, so navigating within the same webview does not reset it.
/// The frontend already clamps the range; this clamps it again as a backstop.
#[tauri::command]
pub fn set_study_preview_zoom(app: tauri::AppHandle, zoom: f64) -> CmdResult<()> {
    use tauri::Manager;
    if !zoom.is_finite() {
        return Err("INVALID_ZOOM: 网页缩放必须是有限数值".into());
    }
    let zoom = zoom.clamp(0.5, 3.0);
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .set_zoom(zoom)
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// Pushes vault-side anchors into the page (the page merges by id, so this is
/// idempotent and never overwrites newer page-side data).
#[tauri::command]
pub fn merge_study_preview_annotations(
    app: tauri::AppHandle,
    url: String,
    annotations: serde_json::Value,
) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        let payload = serde_json::json!({ "url": url, "annotations": annotations });
        webview
            .eval(format!(
                "window.__bnoteAnno && window.__bnoteAnno.merge({});",
                payload
            ))
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// Moves/resizes the embedded preview (window resize, divider drag, sidebar
/// toggle — anything that reflows the middle column).
#[tauri::command]
pub fn set_study_preview_bounds(app: tauri::AppHandle, bounds: PreviewBounds) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .set_bounds(bounds.rect())
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        // The native view moved: the pen cursor's cached screen rectangle
        // has to be recomputed.
        pen_cursor::refresh();
    }
    Ok(())
}

/// The native view always paints *above* the DOM, so it has to be hidden while
/// an HTML overlay (settings / command palette / quick switcher) is open.
#[tauri::command]
pub fn set_study_preview_visible(app: tauri::AppHandle, visible: bool) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        let result = if visible {
            webview.show()
        } else {
            webview.hide()
        };
        result.map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        // Right after showing it again the mouse may not be moving, so draw
        // the pen once immediately instead of waiting for the next move.
        if visible {
            pen_cursor::refresh();
        }
    }
    Ok(())
}

/// Drops the embedded preview (leaving study mode / closing the URL content).
#[tauri::command]
pub fn close_study_preview(app: tauri::AppHandle) -> CmdResult<()> {
    use tauri::Manager;
    // With the preview gone, the page-side translation channel closes too;
    // leftover titles no longer trigger requests.
    PREVIEW_TRANSLATE_ENABLED.store(false, Ordering::Relaxed);
    if let Ok(mut slot) = PREVIEW_TRANSLATE_LAST.lock() {
        *slot = None;
    }
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .close()
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    // With the view gone: drop the pen takeover, so the main window's own
    // cursor rules take effect immediately.
    pen_cursor::detach();
    Ok(())
}

/// Label of the creative-mode live preview (agent-generated HTML) embedded
/// in the middle column. Same cooperation model as study-preview ("placeholder
/// rectangle + native child webview"); the two are mutually exclusive
/// (creative mode and study mode are different states of the panel).
const CREATIVE_PREVIEW_LABEL: &str = "creative-preview";

fn parse_preview_file_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("INVALID_URL: {}", e))?;
    if parsed.scheme() != "file" {
        return Err(format!("INVALID_URL: 创作预览只接受 file:// URL({})", url));
    }
    Ok(parsed)
}

/// Shows (creating if needed) the creative-mode preview on the middle column.
/// Driven by the `creative-preview-updated` event: every preview_html write
/// lands a new versioned snapshot, and the frontend swaps the URL to reload.
#[tauri::command]
pub async fn show_creative_preview(
    app: tauri::AppHandle,
    url: String,
    bounds: PreviewBounds,
) -> CmdResult<()> {
    use tauri::Manager;

    let parsed = parse_preview_file_url(&url)?;
    if let Some(existing) = app.get_webview(CREATIVE_PREVIEW_LABEL) {
        let _ = existing.set_bounds(bounds.rect());
        existing
            .navigate(parsed)
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        existing
            .show()
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "WEBVIEW_FAILED: 找不到主窗口".to_string())?;
    // add_child must be called from an async command (it schedules onto the
    // main thread and waits; calling it from a sync command deadlocks --
    // same constraint as show_study_preview).
    window
        .add_child(
            tauri::webview::WebviewBuilder::new(
                CREATIVE_PREVIEW_LABEL,
                tauri::WebviewUrl::External(parsed),
            )
            // Once a snapshot finishes loading, take a screenshot for the
            // agent's preview_html (fetched by version number, see the
            // screenshot registry below); navigations that are not snapshot
            // pages (redirects and the like) are not captured.
            .on_page_load(|webview, payload| {
                if payload.event() != PageLoadEvent::Finished {
                    return;
                }
                let Some(version) = preview_version_from_url(payload.url().as_str()) else {
                    return;
                };
                capture_preview_shot(&webview, version);
            }),
            bounds.position(),
            bounds.size(),
        )
        .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn set_creative_preview_bounds(app: tauri::AppHandle, bounds: PreviewBounds) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(CREATIVE_PREVIEW_LABEL) {
        webview
            .set_bounds(bounds.rect())
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_creative_preview_visible(app: tauri::AppHandle, visible: bool) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(CREATIVE_PREVIEW_LABEL) {
        let result = if visible {
            webview.show()
        } else {
            webview.hide()
        };
        result.map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn close_creative_preview(app: tauri::AppHandle) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(CREATIVE_PREVIEW_LABEL) {
        webview
            .close()
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

// ---------- Creative-mode preview screenshots: preview_html returns the render ----------

/// Captured preview screenshots, indexed by snapshot version. The only writer
/// is the preview webview's on_page_load (main thread); the only reader is
/// preview_html (waiting for its own version). Capped at 8: an older version
/// has no waiter left, so evicting the oldest keeps memory from growing.
static PREVIEW_SHOTS: std::sync::LazyLock<Mutex<std::collections::HashMap<u64, Vec<u8>>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
static PREVIEW_SHOT_NOTIFY: tokio::sync::Notify = tokio::sync::Notify::const_new();

fn store_preview_shot(version: u64, png: Vec<u8>) {
    if let Ok(mut shots) = PREVIEW_SHOTS.lock() {
        shots.insert(version, png);
        while shots.len() > 8 {
            let Some(oldest) = shots.keys().min().copied() else {
                break;
            };
            shots.remove(&oldest);
        }
    }
    PREVIEW_SHOT_NOTIFY.notify_one();
}

/// Waits for its own version's screenshot after preview_html has been written.
/// Registers the waiter before checking the table: notify_one stores a permit
/// when there is no waiter, so there is no race window between the table
/// lookup and the wait.
pub(crate) async fn wait_preview_shot(version: u64, timeout: Duration) -> Option<Vec<u8>> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let notified = PREVIEW_SHOT_NOTIFY.notified();
        if let Ok(shots) = PREVIEW_SHOTS.lock() {
            if let Some(png) = shots.get(&version) {
                return Some(png.clone());
            }
        }
        tokio::time::timeout_at(deadline, notified).await.ok()?;
    }
}

/// Snapshot file name `preview-{version}.html` -> version number; any other
/// URL (the user's own pages, redirects) returns None and is not captured.
fn preview_version_from_url(url: &str) -> Option<u64> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let digits = name.strip_prefix("preview-")?.strip_suffix(".html")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Starts the capture from on_page_load (main thread). On macOS: delay 250ms
/// for the first frame's styles and images to settle, then return to the main
/// thread and takeSnapshot the WKWebView, encoding it as PNG for the waiter.
/// The delay uses "thread sleep + run_on_main_thread" instead of
/// dispatch_after: the latter's closure would have to carry the WKWebView
/// pointer across threads (not Send), whereas here the pointer is only
/// obtained and used inside the main-thread closure. Other platforms have no
/// implementation yet, so preview_html falls back to plain text without a
/// screenshot.
fn capture_preview_shot<R: tauri::Runtime>(webview: &tauri::Webview<R>, version: u64) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let app = webview.app_handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let app2 = app.clone();
            let on_main = move || {
                use tauri::Manager;
                // The preview is closed: no screenshot for this version, and
                // the waiter falls back to plain text on timeout.
                let Some(webview) = app2.get_webview(CREATIVE_PREVIEW_LABEL) else {
                    return;
                };
                let _ = webview.with_webview(move |platform| {
                    let wk = platform.inner() as *mut objc2_web_kit::WKWebView;
                    unsafe { capture_wkwebview_png(wk, version) };
                });
            };
            let _ = app.run_on_main_thread(on_main);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, version);
    }
}

/// takeSnapshot: the visible viewport is output at 1x (logical points),
/// halving the token cost on the model side while staying readable.
/// Main-thread only; the pointer is owned by the original webview and only
/// borrowed here.
#[cfg(target_os = "macos")]
unsafe fn capture_wkwebview_png(wk: *mut objc2_web_kit::WKWebView, version: u64) {
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::WKSnapshotConfiguration;

    let Some(webview) = (unsafe { Retained::retain(wk) }) else {
        return;
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let config = unsafe { WKSnapshotConfiguration::new(mtm) };
    // snapshotWidth is the logical point width: setting it to the view width
    // yields a 1x output (unset would give a Retina 2x).
    unsafe { config.setSnapshotWidth(Some(&NSNumber::new_f64(webview.bounds().size.width))) };
    let block = block2::RcBlock::new(
        move |image: *mut objc2_app_kit::NSImage, _error: *mut NSError| {
            let Some(image) = (unsafe { Retained::retain(image) }) else {
                return;
            };
            autoreleasepool(|_| {
                // NSImage -> TIFF -> bitmap representation -> PNG data. All three
                // steps are Options: if any step fails, this version's screenshot
                // is dropped and preview_html falls back on timeout.
                let Some(tiff) = image.TIFFRepresentation() else {
                    return;
                };
                let Some(rep) = NSBitmapImageRep::imageRepWithData(&tiff) else {
                    return;
                };
                let Some(png) = (unsafe {
                    rep.representationUsingType_properties(
                        NSBitmapImageFileType::PNG,
                        &NSDictionary::new(),
                    )
                }) else {
                    return;
                };
                store_preview_shot(version, png.to_vec());
            });
        },
    );
    unsafe {
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
    }
}

/// Opens (or re-navigates) the standalone preview window.
///
/// The JS `new WebviewWindow(...)` API reports failures through a
/// `tauri://error` event instead of rejecting, so a failed preview used to be
/// invisible. Creating the window here turns every failure into a real error
/// the frontend can show.
#[tauri::command]
pub async fn open_study_url(app: tauri::AppHandle, url: String) -> CmdResult<()> {
    use tauri::Manager;

    let parsed = parse_study_url(&url)?;
    if let Some(existing) = app.get_webview_window(STUDY_WINDOW_LABEL) {
        existing
            .navigate(parsed)
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        let _ = existing.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        STUDY_WINDOW_LABEL,
        tauri::WebviewUrl::External(parsed),
    )
    .title("bnote 网页预览")
    .inner_size(1100.0, 820.0)
    .build()
    .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn agent_set_current_note(state: State<'_, AppState>, path: Option<String>) -> CmdResult<()> {
    if let Ok(mut note) = state.current_note.lock() {
        *note = path;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentConfig;

    /// Restoring a session overrides from the snapshot: only fields with a
    /// value are overridden, empty fields keep the current settings (an old
    /// record missing a field must not leave the model as an empty string).
    #[test]
    fn the_session_model_snapshot_only_overrides_the_fields_that_have_a_value() {
        let mut cfg = AgentConfig {
            provider: "openai".into(),
            model: "current".into(),
            base_url: "https://current.example".into(),
            api_key: "sk-current".into(),
            max_tokens: 4096,
            context_window: 128_000,
            mcp_servers: Default::default(),
            skill_dirs: Vec::new(),
        };
        AgentModelChoice {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-5".into(),
            base_url: "https://old.example".into(),
            max_tokens: 8192,
            context_window: 200_000,
        }
        .apply(&mut cfg);
        assert_eq!(cfg.provider, "anthropic");
        assert_eq!(cfg.model, "claude-sonnet-4-5");
        assert_eq!(cfg.base_url, "https://old.example");
        assert_eq!(cfg.max_tokens, 8192);
        assert_eq!(cfg.context_window, 200_000);
        // The key always comes from the current config and is never written
        // into the session record.
        assert_eq!(cfg.api_key, "sk-current");

        AgentModelChoice::default().apply(&mut cfg);
        assert_eq!(cfg.model, "claude-sonnet-4-5");
    }

    #[test]
    fn the_preview_version_is_parsed_only_from_the_snapshot_file_name() {
        assert_eq!(
            preview_version_from_url("file:///tmp/creative-preview/preview-7.html"),
            Some(7)
        );
        assert_eq!(
            preview_version_from_url("file:///tmp/creative-preview/preview-12.html?a=1#f"),
            Some(12)
        );
        // The user's own pages, directories, non-numeric versions and
        // neighbouring names are not captured
        assert_eq!(preview_version_from_url("file:///tmp/page.html"), None);
        assert_eq!(preview_version_from_url("file:///tmp/preview-x.html"), None);
        assert_eq!(
            preview_version_from_url("file:///tmp/repreview-3.html"),
            None
        );
        assert_eq!(
            preview_version_from_url("file:///tmp/preview-3.html.bak"),
            None
        );
    }

    #[tokio::test]
    async fn preview_screenshots_are_fetched_by_version_and_the_waiter_registers_first() {
        // With no screenshot stored, the timeout returns None (a short timeout
        // keeps the test from dragging on for 4 seconds)
        assert!(
            wait_preview_shot(987_654, Duration::from_millis(50))
                .await
                .is_none(),
            "an unknown version must never resolve"
        );
        // Once stored, the waiter gets that version immediately
        store_preview_shot(987_655, b"fake-png".to_vec());
        let shot = wait_preview_shot(987_655, Duration::from_secs(1)).await;
        assert_eq!(shot.as_deref(), Some(b"fake-png".as_slice()));
    }
}
