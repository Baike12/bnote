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
pub async fn agent_get_config(state: State<'_, AppState>) -> CmdResult<crate::agent::AgentConfig> {
    // 与 config.rs 同理：同步命令跑在主线程，IO 一律丢进 worker 池。
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
        "pdfPath": pdf_copy.to_string_lossy(),
        "title": stem,
        "pages": output.page_count,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
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
#[tauri::command]
pub async fn show_study_preview(
    app: tauri::AppHandle,
    url: String,
    bounds: PreviewBounds,
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
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "WEBVIEW_FAILED: 找不到主窗口".to_string())?;
    // add_child 内部会把构建排到主线程再等结果,所以只能在异步命令里调用
    // (同步命令/事件回调里调用会死锁,见 tauri 的 WebviewBuilder 文档)。
    window
        .add_child(
            tauri::webview::WebviewBuilder::new(
                STUDY_PREVIEW_LABEL,
                tauri::WebviewUrl::External(parsed),
            ),
            bounds.position(),
            bounds.size(),
        )
        .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
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
    }
    Ok(())
}

/// The native view always paints *above* the DOM, so it has to be hidden while
/// an HTML overlay (settings / command palette / quick switcher) is open.
#[tauri::command]
pub fn set_study_preview_visible(app: tauri::AppHandle, visible: bool) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        let result = if visible { webview.show() } else { webview.hide() };
        result.map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// Drops the embedded preview (leaving study mode / closing the URL content).
#[tauri::command]
pub fn close_study_preview(app: tauri::AppHandle) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .close()
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
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
