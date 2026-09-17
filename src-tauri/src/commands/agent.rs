//! Study-mode commands: agent sessions, config, and PDF→markdown conversion.

use super::CmdResult;
use crate::agent::mcp::McpManager;
use crate::agent::session::{build_system_prompt, Session, SessionRegistry};
use crate::agent::skills::SkillRegistry;
use crate::agent::tools::{StudyContent, ToolContext};
use crate::agent::Provider;
use crate::state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::State;

fn get_mcp_manager(state: &State<'_, AppState>) -> Option<Arc<McpManager>> {
    state.mcp_manager.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
pub fn agent_get_config(state: State<'_, AppState>) -> CmdResult<crate::agent::AgentConfig> {
    Ok(crate::agent::AgentConfig::load(&state.data_dir()))
}

#[tauri::command]
pub fn agent_save_config(
    state: State<'_, AppState>,
    config: crate::agent::AgentConfig,
) -> CmdResult<()> {
    config.save(&state.data_dir())
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
) -> CmdResult<serde_json::Value> {
    let cfg = crate::agent::AgentConfig::load(&state.data_dir());
    if cfg.api_key.is_empty() {
        return Err("NO_API_KEY: 在设置的 Agent 部分填写 API Key".into());
    }
    let mcp = ensure_mcp(&state).await?;
    let skills = {
        let vault = state.vault();
        SkillRegistry::discover(&state.data_dir(), vault.as_ref(), &cfg.skill_dirs)
    };

    let provider = Arc::new(Provider::new(
        &cfg.provider,
        &cfg.base_url,
        &cfg.api_key,
        &cfg.model,
        cfg.max_tokens,
    ));

    // Read MCP errors for the UI + build the system prompt.
    let mcp_block = if mcp.errors.is_empty() {
        format!(
            "\n## MCP\n\n{} MCP tool(s) available via mcp__<server>__<tool>.\n",
            mcp.tools.len()
        )
    } else {
        format!(
            "\n## MCP\n\nSome MCP servers failed: {}\n",
            mcp.errors.join("; ")
        )
    };
    let skills_block = skills.prompt_block();
    let vault_name = state
        .vault()
        .and_then(|v| v.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_default();
    let current_note = state
        .current_note
        .lock()
        .ok()
        .and_then(|n| n.clone());
    let system_prompt = build_system_prompt(
        &vault_name,
        current_note.as_deref(),
        study.as_ref(),
        &skills_block,
        &mcp_block,
    );

    let ctx = Arc::new(ToolContext {
        vault: state.vault(),
        data_dir: state.data_dir(),
        study_content: Arc::new(std::sync::RwLock::new(study)),
        abort: Arc::new(AtomicBool::new(false)),
    });

    let id = format!("s{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let session = Arc::new(Session {
        id: id.clone(),
        items: Mutex::new(Vec::new()),
        system_prompt,
        ctx,
        skills: Arc::new(skills),
        mcp: mcp.clone(),
        provider,
        running: Arc::new(AtomicBool::new(false)),
        seq: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        app: app.clone(),
    });

    {
        let mut registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry.insert(id.clone(), session.clone());
    }

    Ok(serde_json::json!({
        "sessionId": id,
        "skills": session.skills.skills,
        "mcpTools": mcp.tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
        "mcpErrors": mcp.errors.clone(),
    }))
}

#[tauri::command]
pub async fn agent_send(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> CmdResult<()> {
    let session = {
        let registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "SESSION_NOT_FOUND".to_string())?
    };
    if session.running.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("SESSION_BUSY: 还有回复在生成".into());
    }
    // Run the turn in the background; events stream to the frontend.
    tauri::async_runtime::spawn(async move {
        session.send(&text).await;
    });
    Ok(())
}

#[tauri::command]
pub fn agent_abort(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = registry.get(&session_id) {
        session.ctx.abort.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn agent_get_history(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Vec<crate::agent::types::ChatItem>> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = registry
        .get(&session_id)
        .ok_or("SESSION_NOT_FOUND")?;
    Ok(session.history())
}

/// Converts a dropped PDF into a markdown note + assets under the vault.
#[tauri::command]
pub async fn convert_pdf_to_markdown(
    state: State<'_, AppState>,
    pdf_path: String,
    folder_rel: String,
) -> CmdResult<serde_json::Value> {
    let vault = super::require_vault(&state)?;
    let pdf = std::path::PathBuf::from(&pdf_path);
    if !pdf.is_file() {
        return Err(format!("PDF_NOT_FOUND: {}", pdf_path));
    }
    let stem = pdf
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "paper".into());
    // Folder inside the vault; sanitize the stem for filesystem use.
    let safe_stem: String = stem
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect();
    let out_dir = vault.join(&folder_rel);
    let asset_dir = out_dir.join("assets").join(&safe_stem);
    let opts = pdf2md::ConvertOptions::new(
        asset_dir,
        format!("{}/assets/{}/{}", folder_rel, safe_stem, safe_stem),
    );
    let started = std::time::Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        pdf2md::convert_file(&pdf_path, &opts)
    })
    .await
    .map_err(|e| format!("join: {}", e))?;
    let output = result.map_err(|e| e)?;
    let md_path = out_dir.join(format!("{}.md", safe_stem));
    std::fs::write(&md_path, &output.markdown).map_err(|e| format!("WRITE_FAILED: {}", e))?;
    Ok(serde_json::json!({
        "mdPath": md_path.to_string_lossy(),
        "title": stem,
        "pages": output.page_count,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

#[tauri::command]
pub fn agent_set_current_note(state: State<'_, AppState>, path: Option<String>) -> CmdResult<()> {
    if let Ok(mut note) = state.current_note.lock() {
        *note = path;
    }
    Ok(())
}
