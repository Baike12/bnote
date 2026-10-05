//! Study-mode commands: agent sessions, config, and PDF→markdown conversion.

use super::CmdResult;
use crate::agent::mcp::McpManager;
use crate::agent::session::{Session, build_system_prompt};
use crate::agent::skills::SkillRegistry;
use crate::agent::tools::{StudyContent, ToolContext};
use crate::agent::Provider;
use crate::state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

fn get_mcp_manager(state: &AppState) -> Option<Arc<McpManager>> {
    state.mcp_manager.lock().ok().and_then(|g| g.clone())
}

/// 同步入口,内部跑在 core 私有 tokio runtime 上;调用方(GPUI 壳)必须放到
/// 后台线程,不许在 UI 线程直接调。
pub fn agent_get_config(state: &AppState) -> CmdResult<crate::agent::AgentConfig> {
    // 与 config.rs 同理:文件 IO 丢进 worker 池,不占调用线程。
    let dir = state.data_dir();
    crate::runtime::block_on(async move {
        tokio::task::spawn_blocking(move || Ok(crate::agent::AgentConfig::load(&dir)))
            .await
            .map_err(|e| format!("JOIN_FAILED: {}", e))?
    })
}

/// 同步入口,内部跑在 core 私有 tokio runtime 上;调用方(GPUI 壳)必须放到
/// 后台线程,不许在 UI 线程直接调。
pub fn agent_save_config(state: &AppState, config: crate::agent::AgentConfig) -> CmdResult<()> {
    let dir = state.data_dir();
    crate::runtime::block_on(async move {
        tokio::task::spawn_blocking(move || config.save(&dir))
            .await
            .map_err(|e| format!("JOIN_FAILED: {}", e))?
    })
}

/// 同步入口,内部跑在 core 私有 tokio runtime 上;调用方(GPUI 壳)必须放到
/// 后台线程,不许在 UI 线程直接调。
pub fn agent_start_session(
    state: &AppState,
    study: Option<StudyContent>,
) -> CmdResult<serde_json::Value> {
    let cfg = crate::agent::AgentConfig::load(&state.data_dir());
    if cfg.api_key.is_empty() {
        return Err("NO_API_KEY: 在设置的 Agent 部分填写 API Key".into());
    }
    // MCP:已有管理器直接复用;缺失才连接(网络 IO,丢进 core runtime)。
    let mcp = match get_mcp_manager(state) {
        Some(m) => m,
        None => {
            let cfg_for_mcp = cfg.clone();
            let manager = crate::runtime::block_on(async move {
                Arc::new(McpManager::connect_all(&cfg_for_mcp).await)
            });
            if let Ok(mut cell) = state.mcp_manager.lock() {
                *cell = Some(manager.clone());
            }
            manager
        }
    };
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
        events: state.events.clone(),
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

pub fn agent_send(state: &AppState, session_id: String, text: String) -> CmdResult<()> {
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
    // Run the turn in the background; events stream to the shell via the bus.
    crate::runtime::spawn(async move {
        session.send(&text).await;
    });
    Ok(())
}

pub fn agent_abort(state: &AppState, session_id: String) -> CmdResult<()> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = registry.get(&session_id) {
        session.ctx.abort.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

pub fn agent_get_history(
    state: &AppState,
    session_id: String,
) -> CmdResult<Vec<crate::agent::types::ChatItem>> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = registry
        .get(&session_id)
        .ok_or("SESSION_NOT_FOUND")?;
    Ok(session.history())
}

/// Converts a dropped PDF into a markdown note + assets under the vault.
///
/// The original file is copied into the same folder as the note: a converted
/// paper is only useful if the PDF it came from stays reachable (figures are
/// re-converted from it, the Agent is asked about pages we did not turn into
/// text). Everything for one paper lands together:
///
/// ```text
/// <vault>/pdfs/<stem>.pdf          原文(拷贝进来的)
/// <vault>/pdfs/<stem>.md           转换结果
/// <vault>/pdfs/assets/<stem>/*.svg 图表
/// ```
///
/// The asset prefix in the markdown is relative to the note (`assets/<stem>`),
/// which is what both the editor's image renderer and any other markdown tool
/// reading this vault resolve against.
///
/// 同步入口,内部跑在 core 私有 tokio runtime 上;调用方(GPUI 壳)必须放到
/// 后台线程,不许在 UI 线程直接调(CPU 密集的 PDF 解析在 spawn_blocking 池)。
pub fn convert_pdf_to_markdown(
    state: &AppState,
    pdf_path: String,
    folder_rel: String,
) -> CmdResult<serde_json::Value> {
    let vault = super::require_vault(state)?;
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
    // The target folder may not exist yet (first PDF of a fresh vault) — the
    // converter creates the asset directory, but the .md write must not depend
    // on that side effect.
    let folder_rel = folder_rel.trim_matches('/').to_string();
    if folder_rel.split('/').any(|seg| seg == "..") {
        return Err(format!("INVALID_FOLDER: {}", folder_rel));
    }
    let out_dir = vault.join(&folder_rel);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("MKDIR_FAILED: {}", e))?;

    // Copy the original in first: a failed copy must not leave a note behind
    // pointing at a PDF that is still sitting in ~/Downloads.
    let pdf_copy = out_dir.join(format!("{}.pdf", safe_stem));
    let source = std::fs::canonicalize(&pdf).ok();
    if source.as_deref() != std::fs::canonicalize(&pdf_copy).ok().as_deref() {
        std::fs::copy(&pdf, &pdf_copy).map_err(|e| format!("COPY_FAILED: {}", e))?;
    }

    let asset_dir = out_dir.join("assets").join(&safe_stem);
    let opts = pdf2md::ConvertOptions::new(asset_dir, format!("assets/{}", safe_stem));
    let started = std::time::Instant::now();
    let result = crate::runtime::block_on(async move {
        tokio::task::spawn_blocking(move || pdf2md::convert_file(&pdf_path, &opts))
            .await
            .map_err(|e| format!("join: {}", e))?
    });
    let output = result.map_err(|e| e)?;
    let md_path = out_dir.join(format!("{}.md", safe_stem));
    std::fs::write(&md_path, &output.markdown).map_err(|e| format!("WRITE_FAILED: {}", e))?;
    Ok(serde_json::json!({
        "mdPath": md_path.to_string_lossy(),
        "pdfPath": pdf_copy.to_string_lossy(),
        "title": stem,
        "pages": output.page_count,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

pub fn agent_set_current_note(state: &AppState, path: Option<String>) -> CmdResult<()> {
    if let Ok(mut note) = state.current_note.lock() {
        *note = path;
    }
    Ok(())
}
