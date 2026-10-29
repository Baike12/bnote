//! Study-mode commands: agent sessions, config, and PDF→markdown conversion.

use super::pen_cursor;
use super::CmdResult;
use crate::agent::mcp::McpManager;
use crate::agent::session::{build_study_prompt, Session, SessionRegistry};
use crate::agent::skills::SkillRegistry;
use crate::agent::tools::{StudyContent, ToolContext};
use crate::agent::Provider;
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, State};

/// 网页选中翻译的总开关。页面通过 document.title 发请求,任意页面脚本也能
/// 伪造同一条 title——这里先按开关硬门控,再对句子请求做 600ms 限频;单词
/// 只查本地词典,不占 API。
static PREVIEW_TRANSLATE_ENABLED: AtomicBool = AtomicBool::new(false);
static PREVIEW_TRANSLATE_LAST: Mutex<Option<Instant>> = Mutex::new(None);

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

/// 恢复会话时沿用它自己的模型配置(会话记录第一行的快照)。
///
/// 设置里改了模型/上下文长度后,已保存的会话仍按创建时的配置继续——这是
/// 用户的明确选择:一个会话的模型不该被之后的设置悄悄换掉。密钥不在快照
/// 里,始终用当前保存的 api_key(换供应商时用户本来就要改密钥)。
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
    /// 只覆盖快照里真正有值的字段:旧记录缺字段时沿用当前配置。
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

/// vault 里的自定义指令,类比 ZCode 的 AGENTS.md / Claude Code 的 CLAUDE.md。
///
/// 读 `.bnote/AGENTS.md`;旧版文件名 `.bnote/agent.md` 作为回退(不自动改名,
/// 用户在设置页保存时才会落成 AGENTS.md)。文件不存在 = 空串,提示词里就不
/// 出现这一节。
fn load_user_instructions(state: &AppState) -> String {
    let dot = state
        .vault()
        .map(|v| v.join(".bnote"))
        .unwrap_or_default();
    for name in ["AGENTS.md", "agent.md"] {
        if let Ok(content) = std::fs::read_to_string(dot.join(name)) {
            return content;
        }
    }
    String::new()
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
    // 恢复一条已保存的会话:前端从会话记录 jsonl 还原出的模型侧历史。
    // 与 `fork` 互斥(恢复/分叉不会同时发生)。
    history: Option<Vec<crate::agent::types::ChatItem>>,
    // 恢复/分叉时沿用源会话的模型配置(见 AgentModelChoice)。
    model: Option<AgentModelChoice>,
    // 会话形态:省略 = 学习模式(纯问答);"creative" = 创作模式(工具+skill)。
    mode: Option<String>,
) -> CmdResult<serde_json::Value> {
    let session_mode = match mode.as_deref() {
        None | Some("") | Some("study") => crate::agent::session::SessionMode::Study,
        Some("creative") => crate::agent::session::SessionMode::Creative,
        other => return Err(format!("INVALID_MODE: 未知的会话模式 {other:?}")),
    };
    let mut cfg = crate::agent::AgentConfig::load(&state.data_dir());
    if let Some(choice) = model {
        choice.apply(&mut cfg);
    }
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
    // 恢复:前端把会话记录还原成 ChatItem,直接作为初始历史。
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
    let system_prompt = match session_mode {
        crate::agent::session::SessionMode::Study => build_study_prompt(
            &vault_name,
            current_note.as_deref(),
            study.as_ref(),
            &user_instructions,
        ),
        crate::agent::session::SessionMode::Creative => {
            let mcp_names: Vec<String> = mcp.tools.iter().map(|t| t.name.clone()).collect();
            crate::agent::session::build_creative_prompt(
                &vault_name,
                current_note.as_deref(),
                &user_instructions,
                &skills.skills,
                &mcp_names,
            )
        }
    };

    let ctx = Arc::new(ToolContext {
        vault: state.vault(),
        data_dir: state.data_dir(),
        study_content: Arc::new(std::sync::RwLock::new(study)),
        abort: Arc::new(AtomicBool::new(false)),
        app: Some(app.clone()),
        preview_seq: std::sync::atomic::AtomicU64::new(0),
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
        mode: session_mode,
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
        // 本会话实际使用的模型配置:前端脚注显示它、会话记录也把它写进
        // 元数据行,恢复时按快照继续(与设置里的当前配置解耦)。
        "model": {
            "provider": cfg.provider,
            "model": cfg.model,
            "baseUrl": cfg.base_url,
            "maxTokens": cfg.max_tokens,
            "contextWindow": cfg.context_window,
        },
    }))
}

/// 设置页与输入框 `/` 补全用的技能清单(每次即时发现,反映磁盘现状)。
#[tauri::command]
pub async fn agent_list_skills(state: State<'_, AppState>) -> CmdResult<Vec<crate::agent::skills::SkillInfo>> {
    let cfg = crate::agent::AgentConfig::load(&state.data_dir());
    let dir = state.data_dir();
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(SkillRegistry::discover(&dir, vault.as_ref(), &cfg.skill_dirs).skills)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
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
        // 笔形光标:同一个 webview 可能被复用,重新挂一次(幂等)。
        let _ = existing.with_webview(|platform| pen_cursor::attach(platform.inner()));
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "WEBVIEW_FAILED: 找不到主窗口".to_string())?;
    // add_child 内部会把构建排到主线程再等结果,所以只能在异步命令里调用
    // (同步命令/事件回调里调用会死锁,见 tauri 的 WebviewBuilder 文档)。
    let webview = window
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
                // 页内按下的阅读区快捷键(切到 Agent / 笔记区)。子 webview 的
                // 按键不冒泡到主窗口,只能借这条已有的 title 通道转回去。
                const KEY_PREFIX: &str = "bnote-key:";
                // 选中翻译:页面只送文本和请求号,翻译在 Rust 里做(单词查内置
                // 词典,句子走配置的 API),结果再 eval 回页面的卡片。这样网页
                // 拿不到 API key,也不需要在主窗口和子 webview 之间多绕一圈。
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
                    // 页面每次加载生成一个文档令牌;结果回传时原样带回,导航后
                    // 旧请求的迟到结果不会画到新页面上。
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
                    // 开关关着:页面脚本伪造 title 也不能触发查词/翻译。
                    if !PREVIEW_TRANSLATE_ENABLED.load(Ordering::Relaxed) {
                        return;
                    }
                    // 句子会走付费 API:600ms 内最多一次;单词只查内置词典,
                    // 不占额度,快速连续选词照常。
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
    // 笔形光标挂在原生视图上:页面 CSS 只留原生关键字,真正的笔由这里替换。
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
        // 原生笔形跟着工具换图(高亮=黄笔、文字批注=蓝笔);退出批注仍用黄笔。
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

/// 把键盘焦点交给内嵌网页(区域切换快捷键「切到阅读区」用)。
///
/// 原生子 webview 的焦点不在主窗口的 DOM 里:只 focus 主窗口的占位 div,
/// 按键仍然进不了网页。这里把原生视图设为焦点,之后按键由页内运行时接管。
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

/// 把「转发给主窗口」的阅读区快捷键推给页内运行时。
///
/// 网页/微信读书跑在原生子 webview 里,按键不会冒泡到主窗口;页内运行时匹配
/// 这些键后写 document.title,由上面的 title 通道转成 `study-preview-key`。
#[tauri::command]
pub fn set_study_preview_shortcuts(
    app: tauri::AppHandle,
    keys: Vec<String>,
) -> CmdResult<()> {
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

/// 内嵌网页的页面缩放(浏览器级:文字重排、整页一起放大)。
///
/// 缩放值只在主窗口的设置里持有(单一写入者);这里把它转成原生视图的页面
/// 缩放:macOS 是 `WKWebView.pageZoom`,Windows 是 WebView2 的
/// `SetZoomFactor`——两者都挂在视图上,同一次 webview 里导航不会清零。
/// 范围在前端夹过,这里再兜一次底。
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
        // 原生视图换位置了:笔形光标缓存的屏幕矩形跟着重算。
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
        let result = if visible { webview.show() } else { webview.hide() };
        result.map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
        // 刚显示回来时鼠标可能正停着不动:立刻补一次笔形,不等下一次移动。
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
    // 预览没了,网页侧的翻译通道也随之关闭;残留的 title 不再触发请求。
    PREVIEW_TRANSLATE_ENABLED.store(false, Ordering::Relaxed);
    if let Ok(mut slot) = PREVIEW_TRANSLATE_LAST.lock() {
        *slot = None;
    }
    if let Some(webview) = app.get_webview(STUDY_PREVIEW_LABEL) {
        webview
            .close()
            .map_err(|e| format!("WEBVIEW_FAILED: {}", e))?;
    }
    // 视图没了:撤掉笔形接管,主窗口自己的光标规则立刻生效。
    pen_cursor::detach();
    Ok(())
}

/// Label of the creation-mode live preview (agent-generated HTML) embedded
/// in the middle column. 与 study-preview 同一套「占位矩形 + 原生子 webview」
/// 协作模型;二者互斥出现(创作模式与学习模式是面板的不同状态)。
const CREATIVE_PREVIEW_LABEL: &str = "creative-preview";

fn parse_preview_file_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| format!("INVALID_URL: {}", e))?;
    if parsed.scheme() != "file" {
        return Err(format!("INVALID_URL: 创作预览只接受 file:// URL({})", url));
    }
    Ok(parsed)
}

/// Shows (creating if needed) the creation-mode preview on the middle column.
/// 由 `creative-preview-updated` 事件驱动:每次 preview_html 落一个新的带版本
/// 快照,前端换 URL 触发重载。
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
    // add_child 必须在异步命令里调用(内部会排到主线程并等待,同步命令里
    // 调用会死锁,与 show_study_preview 同一约束)。
    window
        .add_child(
            tauri::webview::WebviewBuilder::new(
                CREATIVE_PREVIEW_LABEL,
                tauri::WebviewUrl::External(parsed),
            )
            // 每一版快照加载完就截一张图给 agent 的 preview_html(按版本号
            // 取回,见下面截图注册表);不是快照页的导航(重定向等)不截。
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
pub fn set_creative_preview_bounds(
    app: tauri::AppHandle,
    bounds: PreviewBounds,
) -> CmdResult<()> {
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
        let result = if visible { webview.show() } else { webview.hide() };
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

// ---------- 创作预览截图:preview_html 把渲染图回给模型 ----------

/// 已拍好的预览截图,按快照版本号索引。写入方只有预览 webview 的
/// on_page_load(主线程),读取方只有 preview_html(等自己那一版)。
/// 上限 8 张:旧版本不会再有等待方,挤掉最老的防内存增长。
static PREVIEW_SHOTS: std::sync::LazyLock<
    Mutex<std::collections::HashMap<u64, Vec<u8>>>,
> = std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
static PREVIEW_SHOT_NOTIFY: tokio::sync::Notify = tokio::sync::Notify::const_new();

fn store_preview_shot(version: u64, png: Vec<u8>) {
    if let Ok(mut shots) = PREVIEW_SHOTS.lock() {
        shots.insert(version, png);
        while shots.len() > 8 {
            let Some(oldest) = shots.keys().min().copied() else { break };
            shots.remove(&oldest);
        }
    }
    PREVIEW_SHOT_NOTIFY.notify_one();
}

/// preview_html 落盘后等自己那个版本的截图。先注册 notified 再查表:
/// notify_one 在无等待者时会存许可,查表与等待之间没有竞态窗口。
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

/// 快照文件名 `preview-{version}.html` → 版本号;其他 URL(用户自己的页面、
/// 重定向)返回 None,不截图。
fn preview_version_from_url(url: &str) -> Option<u64> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let digits = name.strip_prefix("preview-")?.strip_suffix(".html")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// on_page_load(主线程)里发起截图。macOS:延后 250ms 等首帧样式与图片
/// 铺完,再回主线程对 WKWebView takeSnapshot,编码成 PNG 交给等待方。
/// 延时用「线程 sleep + run_on_main_thread」而不是 dispatch_after:后者
/// 的闭包要跨线程携带 WKWebView 指针(非 Send);这里指针只在主线程闭包
/// 内取出和使用。其他平台暂无实现,preview_html 得到「无截图」的纯文本降级。
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
                // 预览已关:这一版不截图,等待方按超时降级为纯文本。
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

/// takeSnapshot:可见视口按 1x(逻辑点)输出,模型侧 token 开销减半且够读。
/// 只在主线程调用;指针由原 webview 持有,这里只借。
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
    // snapshotWidth 是逻辑点宽度:设成视图宽度即 1x 输出(不设则是 Retina 2x)。
    unsafe { config.setSnapshotWidth(Some(&NSNumber::new_f64(webview.bounds().size.width))) };
    let block = block2::RcBlock::new(move |image: *mut objc2_app_kit::NSImage, _error: *mut NSError| {
        let Some(image) = (unsafe { Retained::retain(image) }) else {
            return;
        };
        autoreleasepool(|_| {
            // NSImage → TIFF → 位图表示 → PNG 数据。三步都是 Option:任何
            // 一步拿不到就放弃这一版截图,preview_html 按超时降级。
            let Some(tiff) = image.TIFFRepresentation() else { return };
            let Some(rep) = NSBitmapImageRep::imageRepWithData(&tiff) else { return };
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
    });
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

    /// 恢复会话时按快照覆盖:有值的字段才覆盖,空字段沿用当前设置
    /// (旧记录缺字段时不能让模型变成空串)。
    #[test]
    fn 会话模型快照只覆盖有值的字段() {
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
        // 密钥永远用当前保存的,不写进会话记录。
        assert_eq!(cfg.api_key, "sk-current");

        AgentModelChoice::default().apply(&mut cfg);
        assert_eq!(cfg.model, "claude-sonnet-4-5");
    }

    #[test]
    fn 预览版本号只从快照文件名解析() {
        assert_eq!(
            preview_version_from_url("file:///tmp/creative-preview/preview-7.html"),
            Some(7)
        );
        assert_eq!(
            preview_version_from_url("file:///tmp/creative-preview/preview-12.html?a=1#f"),
            Some(12)
        );
        // 用户自己的页面、目录、非数字版本、相邻命名都不截
        assert_eq!(preview_version_from_url("file:///tmp/page.html"), None);
        assert_eq!(
            preview_version_from_url("file:///tmp/preview-x.html"),
            None
        );
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
    async fn 预览截图按版本号存取_等待先注册再查表() {
        // 没有截图时按超时返回 None(用短超时,不让测试拖 4 秒)
        assert!(
            wait_preview_shot(987_654, Duration::from_millis(50)).await.is_none(),
            "未存的版本必须等不到"
        );
        // 存进去之后,等待方立刻拿到该版本
        store_preview_shot(987_655, b"fake-png".to_vec());
        let shot = wait_preview_shot(987_655, Duration::from_secs(1)).await;
        assert_eq!(shot.as_deref(), Some(b"fake-png".as_slice()));
    }
}
