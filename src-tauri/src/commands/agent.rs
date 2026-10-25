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
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, State};

fn get_mcp_manager(state: &State<'_, AppState>) -> Option<Arc<McpManager>> {
    state.mcp_manager.lock().ok().and_then(|g| g.clone())
}

/// 辅助会话的分叉点:从 `from` 会话的历史里取前 `items` 条(前缀,含分叉
/// 那条消息)作为新会话的初始历史。原会话不动。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentForkSpec {
    pub from: String,
    pub items: usize,
}

/// vault 里的自定义指令(`.bnote/agent.md`,类比 AGENTS.md / CLAUDE.md);
/// 文件不存在 = 空串,提示词里就不出现这一节。
fn load_user_instructions(state: &AppState) -> String {
    state
        .vault()
        .and_then(|v| std::fs::read_to_string(v.join(".bnote").join("agent.md")).ok())
        .unwrap_or_default()
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
    fork: Option<AgentForkSpec>,
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

    // 分叉:从源会话复制历史前缀(条数以后端在结束事件里给的权威计数为准,
    // 多了截断,少了就用现有的)。源会话不存在是前端状态过期,如实报错。
    let seed_items: Vec<crate::agent::types::ChatItem> = match &fork {
        None => Vec::new(),
        Some(spec) => {
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

    // Read MCP errors for the UI; the system prompt stays tool-free.
    let vault_name = state
        .vault()
        .and_then(|v| v.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_default();
    let current_note = state
        .current_note
        .lock()
        .ok()
        .and_then(|n| n.clone());
    let user_instructions = load_user_instructions(&state);
    let system_prompt = build_system_prompt(
        &vault_name,
        current_note.as_deref(),
        study.as_ref(),
        &user_instructions,
    );

    let ctx = Arc::new(ToolContext {
        vault: state.vault(),
        data_dir: state.data_dir(),
        study_content: Arc::new(std::sync::RwLock::new(study)),
        abort: Arc::new(AtomicBool::new(false)),
    });

    // 时间戳 + 递增序号:同一毫秒内开主会话再分叉辅助会话也不会撞 id。
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
    let session = Arc::new(Session {
        id: id.clone(),
        items: Mutex::new(seed_items),
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
    // 旧调用方(浏览器 harness)不带 images:Option 缺省成空,行为同纯文本。
    images: Option<Vec<crate::agent::types::InlineImage>>,
) -> CmdResult<()> {
    let session = {
        let registry = state.sessions.lock().map_err(|e| e.to_string())?;
        registry
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "SESSION_NOT_FOUND".to_string())?
    };
    // 检查与占位必须是一个原子操作:先 load 再在 spawned 任务里置位,中间
    // 存在窗口,两次发送都能挤进来并发跑同一份会话历史。CAS 之后谁先到谁
    // 占用,占用由 Session 的 RunningGuard 在结束时释放。
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
        // panic 也必须有终止事件:否则前端永远停在「生成中」,而且后续发送
        // 会被 SESSION_BUSY 挡掉却只有一个几秒消失的 toast。
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

/// Imported PDF inside the vault.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPdf {
    /// Absolute path of the copy (the study reader and the Agent both use it).
    pub pdf_path: String,
    /// Vault-relative path, for display and for keeping history vault-portable.
    pub rel_path: String,
    pub title: String,
}

/// Copies a dropped/picked PDF into the vault (`pdfs/` by default).
///
/// The study reader displays the PDF itself — nothing is converted. The copy
/// keeps the paper next to the notes that discuss it, and keeps the original
/// in ~/Downloads disposable.
///
/// A file already living at the destination is reused instead of copied onto
/// itself; a *different* PDF with the same stem gets a `"name 2.pdf"` suffix so
/// imports never overwrite an earlier paper.
#[tauri::command]
pub async fn import_pdf(
    state: State<'_, AppState>,
    pdf_path: String,
    folder_rel: String,
) -> CmdResult<ImportedPdf> {
    let vault = super::require_vault(&state)?;
    let pdf = std::path::PathBuf::from(&pdf_path);
    if !pdf.is_file() {
        return Err(format!("PDF_NOT_FOUND: {}", pdf_path));
    }
    let title = pdf
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "paper".into());
    // Sanitize the stem for filesystem use; keep the display title untouched.
    let safe_stem: String = title
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect();

    let folder_rel = folder_rel.trim_matches('/').to_string();
    if folder_rel.split('/').any(|seg| seg == "..") {
        return Err(format!("INVALID_FOLDER: {}", folder_rel));
    }
    let out_dir = if folder_rel.is_empty() {
        vault.clone()
    } else {
        vault.join(&folder_rel)
    };
    super::ensure_within(&vault, &out_dir)?;
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("MKDIR_FAILED: {}", e))?;

    let direct = out_dir.join(format!("{}.pdf", safe_stem));
    let source = std::fs::canonicalize(&pdf).map_err(|e| format!("PDF_NOT_FOUND: {}", e))?;
    let is_same_file = std::fs::canonicalize(&direct).ok().as_deref() == Some(source.as_path());
    let dest = if is_same_file {
        direct
    } else if direct.exists() {
        unique_pdf_path(&out_dir, &safe_stem)
    } else {
        direct
    };
    if !is_same_file {
        std::fs::copy(&pdf, &dest).map_err(|e| format!("COPY_FAILED: {}", e))?;
    }

    let rel_path = dest
        .strip_prefix(&vault)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| dest.to_string_lossy().to_string());
    Ok(ImportedPdf {
        pdf_path: dest.to_string_lossy().to_string(),
        rel_path,
        title,
    })
}

/// `pdfs/name.pdf` taken → `pdfs/name 2.pdf`, `name 3.pdf`, …
fn unique_pdf_path(dir: &std::path::Path, stem: &str) -> std::path::PathBuf {
    let mut n = 2u32;
    loop {
        let candidate = dir.join(format!("{} {}.pdf", stem, n));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
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
        // 脚本已随 webview 创建时注册;这里再装一次,保证当前文档里已经有运行时
        // (热更新后旧 webview 里的脚本可能是老版本)。
        if !annotation_script.trim().is_empty() {
            let _ = existing.eval(annotation_script);
        }
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
            )
            .initialization_script(annotation_script)
            // 页面加载完通知主窗口:重新套用批注模式,并把仓库里的锚点推回页面。
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = webview.emit_to(
                        "main",
                        "study-preview-loaded",
                        payload.url().to_string(),
                    );
                }
            })
            // 页面里的批注变化写在 document.title 的 `bnote-anno:` 前缀后面。
            // 不开远程 IPC:任意网页都拿不到应用命令,这条 title 通道只传数据。
            // 微信读书的路由追踪(`src/study/weread.ts`)复用同一条通道,前缀
            // `bnote-weread:`,分发成 study-weread-route;不带前缀的 title
            // (微信读书自己设置的页面标题)一律忽略。
            .on_document_title_changed(|webview, title| {
                const ANNO_PREFIX: &str = "bnote-anno:";
                const WEREAD_PREFIX: &str = "bnote-weread:";
                let (event, raw) = if let Some(raw) = title.strip_prefix(ANNO_PREFIX) {
                    ("study-web-annotations", raw)
                } else if let Some(raw) = title.strip_prefix(WEREAD_PREFIX) {
                    ("study-weread-route", raw)
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
    Ok(())
}

/// Toggles the page-side annotation mode (yellow text highlights).
#[tauri::command]
pub fn set_study_preview_annotation_mode(
    app: tauri::AppHandle,
    enabled: bool,
) -> CmdResult<()> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .eval(format!(
                "window.__bnoteAnno && window.__bnoteAnno.setMode({});",
                enabled
            ))
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    Ok(())
}

/// 学习模式翻页：焦点在主窗口时，命令层通过这里把 PageUp/PageDown 转给
/// 内嵌网页。页内运行时自己探测主滚动容器，并按设置步长滚动。
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

/// 把翻页步长推给页内运行时（键盘翻页与上半屏渐变共用）。
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

/// 把命令层的翻页绑定推给页内运行时（自定义快捷键在网页里同样生效）。
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
