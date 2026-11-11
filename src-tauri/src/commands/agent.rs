//! Study-mode commands: agent sessions, config, and PDF→markdown conversion.

use super::pen_cursor;
use super::CmdResult;
use crate::agent::defs;
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

/// Fork point for a helper session: take the first `items` entries of the
/// `from` session's history (a prefix that includes the forking message) as
/// the new session's initial history. The source session is left untouched.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentForkSpec {
    pub from: String,
    pub items: usize,
}

#[tauri::command]
pub async fn agent_get_config(_state: State<'_, AppState>) -> CmdResult<crate::agent::AgentConfig> {
    // Same reasoning as config.rs: a sync command runs on the main thread, so
    // every IO call goes to the worker pool.
    tauri::async_runtime::spawn_blocking(|| Ok(crate::agent::AgentConfig::load()))
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_save_config(
    state: State<'_, AppState>,
    config: crate::agent::AgentConfig,
) -> CmdResult<()> {
    let log_requests = config.log_requests;
    tauri::async_runtime::spawn_blocking(move || config.save())
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))??;
    // The request-record switch belongs to the conversation, not to the
    // settings file: a save pushes it into the sessions already open, so the
    // very next request is recorded (subagents created later inherit it).
    let sessions: Vec<Arc<crate::agent::session::Session>> = state
        .sessions
        .lock()
        .map(|registry| registry.values().cloned().collect())
        .unwrap_or_default();
    for session in sessions {
        session.set_log_requests(log_requests);
    }
    Ok(())
}

/// Starts a session.
///
/// A restored session keeps its own model configuration (the snapshot of the
/// first line of its record): after the catalog changes, a saved session still
/// continues on the model it was created with, and the API key always comes
/// from the current configuration (switching provider requires a new key
/// anyway). A record written before the catalog existed carries the snapshot
/// alone; a current one also carries a `selection` resolved against the
/// catalog.
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
    // On restore/fork, the source session's model snapshot (its record's
    // metadata line); a record from before the catalog only has this.
    model: Option<crate::agent::models::SessionModelConfig>,
    // On restore/fork, the catalog selection the source session ran on. A
    // fresh session passes the default selection of the settings.
    selection: Option<crate::agent::models::ModelSelection>,
    // Session shape: omitted = study mode (plain Q&A); "creative" = creative
    // mode (tools + skills); "coding" = the code-project agent.
    mode: Option<String>,
    // Coding sessions anchor at the opened code project. It is passed
    // explicitly: a code project is independent of the vault and no longer
    // travels through the study content.
    workdir: Option<String>,
    // Restore: the transcript record id, so the persisted task list continues.
    task_list_id: Option<String>,
) -> CmdResult<serde_json::Value> {
    let session_mode = SessionMode::parse(mode.as_deref())?;
    let cfg = crate::agent::AgentConfig::load();
    let resolved = cfg.resolve_session(selection.as_ref(), model.as_ref())?;
    if resolved.api_key.is_empty() {
        return Err("NO_API_KEY: 在设置的 Agent 部分填写 API Key".into());
    }
    // The effective definition is built into the binary; the vault only holds
    // user instructions. The seed history (restore/fork) is carried over
    // unchanged.
    let vault = state.vault();
    let agent_mode = crate::agent::home::AgentMode::from(session_mode);
    let mode_root = crate::agent::home::mode_root(agent_mode, vault.as_deref());
    let def_id = session_mode.definition_id();
    let def = Arc::new(
        defs::definition(def_id).ok_or_else(|| format!("DEF_MISSING: {def_id} 不在内置定义里"))?,
    );
    // Coding sessions anchor at the opened code project: relative tool paths
    // and bash start there, writes are confined to the project ∪ agent home.
    let workdir = match workdir {
        Some(path) if !path.trim().is_empty() => {
            let root = PathBuf::from(&path);
            if !root.is_dir() {
                return Err(format!("INVALID_WORKDIR: {} 不是目录", path));
            }
            Some(root)
        }
        _ => None,
    };
    if session_mode == SessionMode::Coding && workdir.is_none() {
        return Err("INVALID_WORKDIR: 编码会话需要一个代码项目目录".into());
    }
    // The mode's settings: its own file, plus the code project's two files for
    // coding sessions. MCP servers, skill directories and the permission
    // defaults all come from here, so the three modes never share them.
    let settings_project = if session_mode.reads_project() {
        workdir.as_deref()
    } else {
        None
    };
    let layered = crate::agent::settings::load(agent_mode, &mode_root, settings_project);
    // Only MCP-enabled sessions pay for connecting servers.
    let mcp = if def.mcp_enabled() {
        Arc::new(
            McpManager::connect_all(
                &layered.settings.mcp_servers,
                &layered.settings.disabled_mcp_servers,
            )
            .await,
        )
    } else {
        Arc::new(McpManager {
            connections: Default::default(),
            tools: Vec::new(),
            errors: Vec::new(),
        })
    };
    let skills = Arc::new(SkillRegistry::discover(
        agent_mode,
        &mode_root,
        workdir.as_deref(),
        &layered.settings.skill_dirs,
        &layered.settings.disabled_skills,
    ));

    let provider = Arc::new(Provider::from_resolved(&resolved));

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
    // `additionalDirectories` widens the writable roots for this session.
    let extra_roots: Vec<PathBuf> = layered
        .settings
        .permissions
        .additional_directories
        .iter()
        .map(PathBuf::from)
        .collect();
    let ctx = Arc::new(ToolContext {
        vault: vault.clone(),
        data_dir: state.data_dir(),
        study_content: Arc::new(std::sync::RwLock::new(study)),
        abort: crate::agent::cancel::Abort::new(),
        app: Some(app.clone()),
        preview_seq: std::sync::atomic::AtomicU64::new(0),
        workdir,
        shell: Arc::new(ShellCwd::new()),
        bg: Arc::new(BgRegistry::new()),
        read_paths: std::sync::Mutex::new(Vec::new()),
        extra_roots,
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
        skills,
        mcp: mcp.clone(),
        provider,
        selection: resolved.selection(),
        ctx,
        app: app.clone(),
        context_window: resolved.context_window,
        permission_mode: None,
        task_list_id,
        log_requests: cfg.log_requests,
        mode_root: Some(mode_root.clone()),
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
    // SessionStart hooks run once, before the first request.
    session.run_start_hook().await;

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
        // The model configuration this session actually uses: the panel's
        // picker shows it, and the session record writes it into its metadata
        // line so a restore continues from the snapshot (decoupled from the
        // current settings). `selection` is what a restore resolves against
        // the catalog.
        "model": resolved.snapshot(),
        "selection": resolved.selection(),
    }))
}

/// Switches the model / thinking level of an open session.
///
/// The next round of the turn uses it; a request that is already streaming
/// finishes on the provider it started with (see `Session::set_model`). The
/// catalog is read from disk here, so a provider added since the session
/// started is selectable without restarting it.
#[tauri::command]
pub async fn agent_set_session_model(
    state: State<'_, AppState>,
    session_id: String,
    selection: crate::agent::models::ModelSelection,
) -> CmdResult<serde_json::Value> {
    let cfg = tauri::async_runtime::spawn_blocking(crate::agent::AgentConfig::load)
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?;
    let resolved = cfg.resolve(Some(&selection))?;
    if resolved.api_key.is_empty() {
        return Err(format!(
            "NO_API_KEY: 供应商 {} 没有填写 API Key",
            resolved.provider_name
        ));
    }
    let session = {
        let registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "SESSION_NOT_FOUND: 会话已不存在".to_string())?
    };
    session.set_model(
        Arc::new(Provider::from_resolved(&resolved)),
        resolved.context_window,
        resolved.selection(),
    );
    Ok(serde_json::json!({
        "model": resolved.snapshot(),
        "selection": resolved.selection(),
    }))
}

/// The subagent definitions the settings page configures a model for (CC's
/// `--agents` list: id, display name, description).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub fn agent_list_subagents() -> CmdResult<Vec<SubagentInfo>> {
    let names: std::collections::BTreeMap<String, String> = defs::registry()
        .into_iter()
        .map(|d| {
            let name = d.display_name().to_string();
            (d.id, name)
        })
        .collect();
    Ok(defs::subagent_listing()
        .into_iter()
        .map(|(id, description)| SubagentInfo {
            name: names.get(&id).cloned().unwrap_or_else(|| id.clone()),
            id,
            description,
        })
        .collect())
}

/// The thinking levels a new model of this protocol/gateway starts with (the
/// settings page fills the editor with them before the first save).
#[tauri::command]
pub fn agent_default_levels(
    protocol: String,
    model: String,
    base_url: String,
    max_tokens: u32,
) -> CmdResult<Vec<crate::agent::models::ThinkingLevel>> {
    Ok(crate::agent::models::default_levels(
        &protocol, &model, &base_url, max_tokens,
    ))
}

/// System prompt for titling: only the title itself, no restating the whole
/// sentence and no extra punctuation.
const TITLE_SYSTEM_PROMPT: &str = "你在给一段对话起标题。根据用户的第一条消息，给出一个能概括主题的短标题：不超过 14 个汉字（英文不超过 8 个词），不要引号、不要书名号、不要句末标点、不要「标题：」这类前缀，只输出标题本身。";

/// Titles a session from **its own** first message by asking the model for a
/// short title.
///
/// Shares the model configuration with the conversation (a restored session
/// passes its own selection / snapshot); sends one short request only,
/// registers no session and enters no session history. On failure the caller
/// keeps its locally truncated title.
///
/// `session_id` is the conversation the title belongs to: when recording is on,
/// this request lands in that conversation's record file too (the record is
/// what shows whether the prompt the title saw matches the session).
#[tauri::command]
pub async fn agent_generate_title(
    state: State<'_, AppState>,
    text: String,
    model: Option<crate::agent::models::SessionModelConfig>,
    selection: Option<crate::agent::models::ModelSelection>,
    session_id: Option<String>,
) -> CmdResult<String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("BAD_ARGS: text".into());
    }
    let cfg = crate::agent::AgentConfig::load();
    let resolved = cfg.resolve_session(selection.as_ref(), model.as_ref())?;
    if resolved.api_key.is_empty() {
        return Err("NO_API_KEY: 在设置的 Agent 部分填写 API Key".into());
    }
    // The session may already be gone (a restored conversation whose panel was
    // closed): then the request simply has no record to join.
    let session = session_id.as_deref().and_then(|id| {
        state
            .sessions
            .lock()
            .ok()
            .and_then(|registry| registry.get(id).cloned())
    });
    let log = session.as_ref().and_then(|session| session.request_log());
    let opts = crate::agent::provider::TurnOptions {
        max_tokens: None,
        abort: crate::agent::cancel::Abort::new(),
        thinking: false,
        log,
        session: session_id.unwrap_or_default(),
        purpose: "title",
    };
    let provider = Provider::from_resolved(&resolved);
    let items = vec![crate::agent::types::ChatItem::user_text(&text)];
    let collected = Mutex::new(String::new());
    provider
        .stream_turn_with(
            TITLE_SYSTEM_PROMPT,
            &items,
            &[],
            &|event| {
                if let crate::agent::types::AgentEvent::TextDelta { text } = event {
                    if let Ok(mut buf) = collected.lock() {
                        buf.push_str(&text);
                    }
                }
            },
            &opts,
        )
        .await?;
    collected.into_inner().map_err(|e| e.to_string())
}

/// Skill inventory for the settings page and the input box's `/` completion
/// (discovered on every call, so it reflects what is actually on disk). The
/// mode decides the roots; `workdir` adds the code project's `.agents/skills`
/// for coding sessions.
#[tauri::command]
pub async fn agent_list_skills(
    state: State<'_, AppState>,
    mode: Option<String>,
    workdir: Option<String>,
) -> CmdResult<Vec<crate::agent::skills::SkillInfo>> {
    let agent_mode = crate::agent::home::AgentMode::parse(mode.as_deref().unwrap_or("study"))
        .ok_or_else(|| "INVALID_MODE".to_string())?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::agent::home::mode_root(agent_mode, vault.as_deref());
        let project = workdir.map(PathBuf::from).filter(|path| path.is_dir());
        let settings_project = if agent_mode.reads_project() {
            project.as_deref()
        } else {
            None
        };
        let settings = crate::agent::settings::load(agent_mode, &root, settings_project).settings;
        Ok(SkillRegistry::discover(
            agent_mode,
            &root,
            project.as_deref(),
            &settings.skill_dirs,
            &settings.disabled_skills,
        )
        .skills)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// The code project's file index for the composer's `@` completion (CC's
/// `git ls-files` snapshot): relative paths, `.gitignore` respected, capped.
#[tauri::command]
pub async fn agent_list_project_files(
    state: State<'_, AppState>,
    workdir: String,
) -> CmdResult<Vec<String>> {
    let root = PathBuf::from(&workdir);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        const MAX_FILES: usize = 2000;
        let mut out: Vec<String> = Vec::new();
        for entry in crate::code::project::walk_for_agent(root.clone()) {
            let Ok(path) = entry else { continue };
            if !path.is_file() {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(&root) {
                out.push(rel.to_string_lossy().to_string());
                if out.len() >= MAX_FILES {
                    break;
                }
            }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// The body of one skill (the `/name` expansion, CC's
/// `processPromptSlashCommand`): the SKILL.md content the prompt refers to,
/// with the base directory line a file-backed skill needs.
#[tauri::command]
pub async fn agent_read_skill(
    state: State<'_, AppState>,
    mode: Option<String>,
    workdir: Option<String>,
    name: String,
) -> CmdResult<String> {
    let agent_mode = crate::agent::home::AgentMode::parse(mode.as_deref().unwrap_or("study"))
        .ok_or_else(|| "INVALID_MODE".to_string())?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::agent::home::mode_root(agent_mode, vault.as_deref());
        let project = workdir.map(PathBuf::from).filter(|path| path.is_dir());
        let settings_project = if agent_mode.reads_project() {
            project.as_deref()
        } else {
            None
        };
        let settings = crate::agent::settings::load(agent_mode, &root, settings_project).settings;
        let registry = SkillRegistry::discover(
            agent_mode,
            &root,
            project.as_deref(),
            &settings.skill_dirs,
            &settings.disabled_skills,
        );
        registry
            .load(&name)
            .ok_or_else(|| format!("SKILL_NOT_FOUND: {}", name))
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

/// Stops the running turn. Returns whether the session is still live: `false`
/// means the backend can never produce a terminal event for it (the process
/// restarted — a dev rebuild, a replaced binary), so the caller has to clear
/// its busy state itself. A silent Ok here left the panel on "generating"
/// forever with a stop button that did nothing — the one state where stop
/// genuinely cannot work.
#[tauri::command]
pub fn agent_abort(state: State<'_, AppState>, session_id: String) -> CmdResult<bool> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = registry.get(&session_id) {
        session.ctx.abort.abort();
        return Ok(true);
    }
    Ok(false)
}

/// The composer's context card: rough per-part context sizes (estimated
/// tokens) of the live session. The real total comes from the usage events.
#[tauri::command]
pub fn agent_context_breakdown(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<crate::agent::session::ContextBreakdown> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = registry
        .get(&session_id)
        .ok_or_else(|| "SESSION_NOT_FOUND".to_string())?;
    Ok(session.context_breakdown())
}

/// The panel's answer to a tool approval request (`ask` permission).
/// The composer's permission mode for this session (confirm / auto / full).
#[tauri::command]
pub fn agent_set_permission_mode(
    state: State<'_, AppState>,
    session_id: String,
    mode: String,
) -> CmdResult<()> {
    let mode = crate::agent::permissions::Mode::parse(&mode)
        .ok_or_else(|| format!("INVALID_MODE: 未知的权限模式 {mode:?}"))?;
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = registry
        .get(&session_id)
        .ok_or_else(|| "SESSION_NOT_FOUND".to_string())?;
    session.set_permission_mode(mode);
    Ok(())
}

#[tauri::command]
pub fn agent_permission_reply(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    allow: bool,
    feedback: Option<String>,
) -> CmdResult<()> {
    let session = {
        let registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "SESSION_NOT_FOUND".to_string())?
    };
    session.resolve_permission(
        &request_id,
        crate::agent::session::PermissionAnswer { allow, feedback },
    )
}

/// The panel's answer to an `ask_user_question` call.
#[tauri::command]
pub fn agent_question_reply(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    answer: String,
) -> CmdResult<()> {
    let session = {
        let registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "SESSION_NOT_FOUND".to_string())?
    };
    session.resolve_question(&request_id, answer)
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

/// Whether an absolute path names a local HTML document. Only those are
/// readable in the column: a page from disk is opened in place, never imported.
fn is_local_html(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
}

/// A URL the study column can show: an http(s) page or a local HTML file.
///
/// A local page is read where it is — a generated report, one's own notes —
/// and the plain navigation is enough for the sibling stylesheet and the
/// relative links to load (measured in an offscreen WKWebView on macOS 26:
/// both work through `loadRequest`, also when the view was on an http page
/// before, so no read-access grant is needed).
fn parse_study_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("INVALID_URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        "file" => {
            let path = parsed
                .to_file_path()
                .map_err(|_| format!("INVALID_URL: 无法解析本地文件路径({})", url))?;
            if !is_local_html(&path) {
                return Err(format!("INVALID_URL: 本地文件只支持 .html({})", url));
            }
            if !path.is_file() {
                return Err(format!("FILE_NOT_FOUND: {}", path.display()));
            }
            Ok(parsed)
        }
        scheme => Err(format!(
            "INVALID_URL: 只支持 http/https 链接或本地 html 文件({})",
            scheme
        )),
    }
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
    // A plain webview lookup: `get_webview_window` answers only while the window
    // owns no child webviews (see crate::main_window).
    if let Some(existing) = app.get_webview(STUDY_WINDOW_LABEL) {
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
    use crate::agent::models::{ModelSelection, SessionModelConfig};
    use crate::agent::AgentConfig;

    fn catalog() -> AgentConfig {
        let mut cfg = AgentConfig {
            provider: "openai".into(),
            model: "current".into(),
            base_url: "https://current.example".into(),
            api_key: "sk-current".into(),
            max_tokens: 4096,
            context_window: 128_000,
            mcp_servers: Default::default(),
            skill_dirs: Vec::new(),
            agent_roots: Default::default(),
            ..Default::default()
        };
        cfg.normalize();
        cfg
    }

    /// Remote pages and local HTML documents are the two things the study
    /// column can show; everything else is refused with the reason.
    #[test]
    fn the_study_column_opens_http_pages_and_local_html_only() {
        assert!(parse_study_url("https://x.com/a").is_ok());
        assert!(parse_study_url("http://127.0.0.1:8080/a").is_ok());

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("bnote-local-page-{}", stamp));
        std::fs::create_dir_all(&dir).unwrap();
        let page = dir.join("01-electron-model.html");
        std::fs::write(&page, "<p>hi</p>").unwrap();
        let url = tauri::Url::from_file_path(&page).unwrap();
        assert_eq!(
            parse_study_url(url.as_str()).unwrap().scheme(),
            "file",
            "a local html file is opened in place"
        );

        // Only html: the reader would show nothing of any other document.
        let note = dir.join("notes.md");
        std::fs::write(&note, "# hi").unwrap();
        let err = parse_study_url(tauri::Url::from_file_path(&note).unwrap().as_str()).unwrap_err();
        assert!(err.contains("本地文件只支持 .html"), "{err}");

        let missing = dir.join("nope.html");
        let err =
            parse_study_url(tauri::Url::from_file_path(&missing).unwrap().as_str()).unwrap_err();
        assert!(err.starts_with("FILE_NOT_FOUND"), "{err}");

        assert!(parse_study_url("ftp://x/a").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A current record restores through its selection, not through the
    /// snapshot: the catalog stays the source of keys and endpoints.
    #[test]
    fn a_restore_prefers_the_catalog_selection() {
        let cfg = catalog();
        let selection = ModelSelection {
            provider_id: "default".into(),
            model_id: "current".into(),
            thinking: "medium".into(),
        };
        let resolved = cfg.resolve_session(Some(&selection), None).unwrap();
        assert_eq!(resolved.api_key, "sk-current");
        assert_eq!(resolved.model, "current");
        assert_eq!(resolved.thinking_level, "medium");
    }

    /// A record written before the catalog existed has only the snapshot: it
    /// keeps running on the model it recorded, and the key still comes from
    /// the current configuration.
    #[test]
    fn an_old_record_keeps_its_snapshot_model_and_takes_the_current_key() {
        let cfg = catalog();
        let snapshot = SessionModelConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-5".into(),
            base_url: "https://old.example".into(),
            max_tokens: 8192,
            context_window: 200_000,
            ..Default::default()
        };
        let resolved = cfg.resolve_session(None, Some(&snapshot)).unwrap();
        assert_eq!(resolved.model, "claude-sonnet-4-5");
        assert_eq!(resolved.protocol, "anthropic");
        assert_eq!(resolved.base_url, "https://old.example");
        assert_eq!(resolved.max_tokens, 8192);
        assert_eq!(resolved.context_window, 200_000);
        assert_eq!(resolved.api_key, "sk-current");
        // The generated levels are the historical reasoning mapping.
        assert!(!resolved
            .patch
            .as_object()
            .map(|o| o.is_empty())
            .unwrap_or(true));
    }

    /// A record whose model left the catalog still names the provider it ran on.
    /// That provider's key and endpoint are the ones to use: the legacy mirror
    /// holds the *default* provider's key, so pairing it with the record's base
    /// URL would send one provider's credential to another provider's endpoint.
    #[test]
    fn a_removed_model_restores_on_its_own_provider_key_and_endpoint() {
        use crate::agent::models::{ModelEntry, ProviderEntry};
        let mut cfg = AgentConfig {
            providers: vec![
                ProviderEntry {
                    id: "a".into(),
                    name: "A".into(),
                    protocol: "anthropic".into(),
                    base_url: "https://a.example".into(),
                    api_key: "sk-a".into(),
                    models: vec![ModelEntry {
                        id: "retired-model".into(),
                        ..Default::default()
                    }],
                },
                ProviderEntry {
                    id: "b".into(),
                    name: "B".into(),
                    protocol: "openai".into(),
                    base_url: "https://b.example".into(),
                    api_key: "sk-b".into(),
                    models: vec![ModelEntry {
                        id: "live".into(),
                        ..Default::default()
                    }],
                },
            ],
            default_selection: Some(ModelSelection {
                provider_id: "b".into(),
                model_id: "live".into(),
                thinking: "".into(),
            }),
            ..Default::default()
        };
        cfg.normalize();
        // The model is gone from every list (the user deleted it after the session).
        let snapshot = SessionModelConfig {
            provider_id: "a".into(),
            provider: "anthropic".into(),
            model: "deleted-model".into(),
            base_url: "https://a.example".into(),
            max_tokens: 8192,
            context_window: 200_000,
            ..Default::default()
        };
        let resolved = cfg.resolve_session(None, Some(&snapshot)).unwrap();
        assert_eq!(resolved.api_key, "sk-a");
        assert_eq!(resolved.base_url, "https://a.example");
        assert_eq!(resolved.provider_name, "A");
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
