//! Agent session: conversation state + the tool-call turn loop.
//!
//! A session is shaped by its [`AgentDefinition`]: the definition decides the
//! system prompt (through the assembly pipeline in `prompt.rs`), the tool
//! surface, compaction and subagent policy. Study, creative and coding only
//! choose an id from `<vault>/.bnote/agents/<id>/`; there is no per-mode
//! prompt builder left.

use super::defs::AgentDefinition;
use super::defs::DEFAULT_TOOLS as DEFAULT_TOOLS_ITER;
use super::mcp::McpManager;
use super::prompt::{assemble, AssembleInput};
use super::provider::Provider;
use super::shell::{self, BgRegistry, ShellCwd, DEFAULT_TIMEOUT_SECS};
use super::todo::{self, TodoItem};
use super::tools::{ToolContext, ToolOutput};
use super::types::{AgentEvent, ChatItem, Content, InlineImage, ToolDef};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use tauri::Emitter;

/// Cap on tool-call rounds per turn when the definition does not set one.
const DEFAULT_MAX_TURNS: u32 = 25;
/// Cap for subagent turns (subagents report back, they do not converse).
const SUBAGENT_MAX_TURNS: u32 = 20;
/// Token fraction at which auto-compact fires when the definition leaves the
/// threshold unset (Claude Code keeps a fixed 13k buffer; a ratio travels
/// across context-window sizes).
const COMPACT_THRESHOLD: f64 = 0.85;

/// Session shape: which definition id seeds it. The definition itself lives
/// in `Session::def`, loaded from the vault's agent directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    Study,
    Creative,
    Coding,
}

impl SessionMode {
    pub fn definition_id(self) -> &'static str {
        match self {
            SessionMode::Study => "study",
            SessionMode::Creative => "creative",
            SessionMode::Coding => "coding",
        }
    }

    pub fn parse(s: Option<&str>) -> Result<SessionMode, String> {
        match s {
            None | Some("") | Some("study") => Ok(SessionMode::Study),
            Some("creative") => Ok(SessionMode::Creative),
            Some("coding") => Ok(SessionMode::Coding),
            other => Err(format!("INVALID_MODE: 未知的会话模式 {other:?}")),
        }
    }
}

pub struct Session {
    pub id: String,
    pub mode: SessionMode,
    pub def: Arc<AgentDefinition>,
    pub items: Mutex<Vec<ChatItem>>,
    /// Assembled system prompt; the dynamic segments are re-read before every
    /// model request (see refresh_dynamic_prompt).
    pub system_prompt: RwLock<String>,
    /// Snapshot fields of the assembly environment (current note / MCP list do
    /// not change mid-session — the same convention as the model snapshot).
    pub vault_name: String,
    pub current_note: Option<String>,
    pub mcp_names: Vec<String>,
    pub ctx: Arc<ToolContext>,
    pub skills: Arc<super::skills::SkillRegistry>,
    pub mcp: Arc<McpManager>,
    pub provider: Arc<Provider>,
    pub running: Arc<AtomicBool>,
    pub seq: Arc<AtomicU64>,
    pub app: tauri::AppHandle,
    /// Model context window (from the config snapshot): auto-compact measures
    /// usage.input against threshold × this.
    pub context_window: u64,
    /// Latest reported usage; the auto-compact trigger input.
    pub last_usage: Mutex<Option<super::types::TokenUsage>>,
    /// The todo tool's list (single writer: the todo tool on this session).
    pub todos: Mutex<Vec<TodoItem>>,
    /// Background-task completions waiting to be injected as a wakeup message.
    pub pending_wakeups: Mutex<Vec<String>>,
    /// Weak self-reference, set right after the session enters its `Arc` (the
    /// background-task completion callback needs to reach the session without
    /// an `Arc` cycle through the registry it owns).
    pub self_ref: Mutex<Option<Weak<Session>>>,
}

/// One erased tool-call. `Box<dyn Future + Send>` is the type-level firewall:
/// whatever the dispatcher awaits stays inside the box, so the loop's future
/// never grows by the subagent machinery.
type BoxTool<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = ToolOutput> + Send + 'a>>;

trait ToolDispatch: Sync {
    fn call<'a>(&'a self, name: &'a str, input: &'a Value) -> BoxTool<'a>;
}

/// The main session's dispatcher: it owns the subagent spawn.
struct ParentDispatch<'s>(&'s Session);

impl<'s> ToolDispatch for ParentDispatch<'s> {
    fn call<'a>(&'a self, name: &'a str, input: &'a Value) -> BoxTool<'a> {
        Box::pin(async move {
            if name == "task" {
                return self.0.run_subagent(input).await;
            }
            self.0.execute_tool_shared(name, input).await
        })
    }
}

/// The subagent's dispatcher: no `task` branch, neither in behavior nor in the
/// future's type.
struct SubDispatch<'s>(&'s Session);

impl<'s> ToolDispatch for SubDispatch<'s> {
    fn call<'a>(&'a self, name: &'a str, input: &'a Value) -> BoxTool<'a> {
        Box::pin(async move {
            if name == "task" {
                return ToolOutput::text(false, "子代理不能再派生子代理");
            }
            self.0.execute_tool_shared(name, input).await
        })
    }
}
/// Guard for `running`: created on entry to `send`, and it puts the session back
/// into a sendable state when the scope ends (normal return / error / panic).
///
/// Without it, one hang or panic leaves `running` true forever: every later
/// `agent_send` is rejected with SESSION_BUSY, and the front end only raises a
/// toast that vanishes after a few seconds — the user just sees "sending again
/// does nothing".
struct RunningGuard(Arc<AtomicBool>);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Session {
    pub fn history(&self) -> Vec<ChatItem> {
        self.items.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Runs one user turn: stream → tool calls → results → repeat.
    /// `images` are the screenshots/images sent along with the message (may be empty).
    ///
    /// Contract: **every send ends with exactly one terminal event
    /// (turn_end / error)**. The front end relies on it to clear the "generating"
    /// state; miss it once and the panel stays busy forever.
    pub async fn send(&self, text: &str, images: Vec<InlineImage>) {
        let _guard = RunningGuard(self.running.clone());
        if text.trim().is_empty() && images.is_empty() {
            // The provider would answer an empty content with a 400, so fail here
            // instead — but never return silently, or the front end waits forever
            // for a terminal event.
            self.emit(AgentEvent::Error {
                message: "消息为空:请先输入内容或添加图片".into(),
                items: self.history().len(),
            });
            return;
        }
        if let Ok(mut items) = self.items.lock() {
            items.push(ChatItem::user_message(text, &images));
        }
        self.finish_turn(self.run_loop(&ParentDispatch(self)).await)
            .await;
    }

    /// A background task woke the session while it was idle: the completion
    /// notice enters the history as a system-injected user message and the
    /// turn loop runs so the model can react to the result.
    pub async fn run_wakeup(&self, notice: String) {
        let _guard = RunningGuard(self.running.clone());
        if let Ok(mut items) = self.items.lock() {
            items.push(ChatItem::user_text(&notice));
        }
        self.emit(AgentEvent::Notice {
            text: "后台任务完成,继续处理".into(),
        });
        self.finish_turn(self.run_loop(&ParentDispatch(self)).await)
            .await;
    }

    /// Manual compaction (the /compact entry): replaces the history with a
    /// summary and ends the turn. Claiming `running` is the caller's job.
    pub async fn run_compact(&self) {
        let _guard = RunningGuard(self.running.clone());
        self.finish_turn(self.compact().await).await;
    }

    /// Emits the turn's terminal event (the one contract every entry point
    /// must keep).
    async fn finish_turn(&self, result: Result<(), String>) {
        let count = self.history().len();
        let event = match result {
            Ok(()) => AgentEvent::TurnEnd {
                reason: "end".into(),
                items: count,
            },
            Err(e) => AgentEvent::Error {
                message: e,
                items: count,
            },
        };
        self.emit(event);
    }

    /// Pushes an event to the front end (the command layer also needs this for
    /// its panic fallback).
    pub fn emit(&self, event: AgentEvent) {
        let payload = serde_json::json!({
            "sessionId": self.id,
            "event": event,
        });
        let _ = self.app.emit("agent-event", payload);
    }

    /// Re-assembles the dynamic prompt segments (environment, user
    /// instructions, definition file layers). Called before every model
    /// request: two small file reads against an LLM round-trip is nothing, and
    /// it is what makes a saved `.bnote/AGENTS.md` edit take effect on the
    /// next message.
    fn refresh_dynamic_prompt(&self) {
        let user = super::load_user_instructions(self.ctx.vault.as_deref());
        let workdir = self
            .ctx
            .workdir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let study = self.ctx.study_content.read().ok().and_then(|g| g.clone());
        let input = AssembleInput {
            def: &self.def,
            vault_name: &self.vault_name,
            current_note: self.current_note.as_deref(),
            workdir: workdir.as_deref(),
            study: study.as_ref(),
            skills: &self.skills.skills,
            mcp_names: &self.mcp_names,
            user_instructions: &user,
        };
        let prompt = assemble(&input);
        if let Ok(mut slot) = self.system_prompt.write() {
            if *slot != prompt {
                *slot = prompt;
            }
        }
    }

    /// Erased tool dispatch. The parent loop and the subagent loop share one
    /// `run_loop` body, but the tool dispatcher is a trait object: a subagent
    /// session has no `task` branch, so the future types never nest back into
    /// themselves (a plain recursive shape — run_loop → execute_tool →
    /// run_subagent → spawn → run_loop — is a circular `Send` proof the
    /// compiler rejects, and it would also encode "subagents may spawn
    /// subagents" into the types).
    async fn run_loop(&self, dispatch: &dyn ToolDispatch) -> Result<(), String> {
        let max_turns = if self.def.max_turns > 0 {
            self.def.max_turns
        } else {
            DEFAULT_MAX_TURNS
        };
        for _step in 0..max_turns {
            if self.ctx.abort.load(Ordering::SeqCst) {
                self.ctx.abort.store(false, Ordering::SeqCst);
                return Ok(());
            }
            self.refresh_dynamic_prompt();
            self.maybe_auto_compact().await?;
            self.inject_pending_wakeups();
            let tools = self.tool_defs();
            let sink = |event: AgentEvent| self.emit(event);
            let snapshot = self.history();
            let system = self
                .system_prompt
                .read()
                .map(|g| g.clone())
                .unwrap_or_default();
            let sink_ref: &(dyn Fn(AgentEvent) + Send + Sync) = &sink;
            let turn = self
                .provider
                .stream_turn(&system, &snapshot, &tools, sink_ref)
                .await?;
            if let Some(usage) = turn.usage {
                self.last_usage
                    .lock()
                    .map(|mut g| *g = Some(usage))
                    .unwrap_or(());
                // Only the latest one matters: it is the current context occupancy;
                // input already includes the system prompt and the whole history.
                self.emit(AgentEvent::Usage {
                    input: usage.input,
                    output: usage.output,
                });
            }
            // Assemble the assistant message.
            let mut content: Vec<Content> = Vec::new();
            if !turn.text.is_empty() {
                content.push(Content::Text {
                    text: turn.text.clone(),
                });
            }
            content.extend(turn.tool_calls.iter().cloned());
            if let Ok(mut items) = self.items.lock() {
                items.push(ChatItem::Message {
                    role: "assistant".into(),
                    content,
                });
            }
            if turn.tool_calls.is_empty() {
                // The model is done — but a background task may have finished
                // while it was writing: drain the wakeups and keep the turn
                // alive so the model sees them (the wake-on-event path).
                if self.inject_pending_wakeups() {
                    continue;
                }
                return Ok(());
            }
            // Execute tools sequentially, feed results back.
            let mut results: Vec<Content> = Vec::new();
            for call in &turn.tool_calls {
                let Content::ToolUse { id, name, input } = call else {
                    continue;
                };
                if self.ctx.abort.load(Ordering::SeqCst) {
                    self.ctx.abort.store(false, Ordering::SeqCst);
                    return Ok(());
                }
                self.emit(AgentEvent::ToolStart {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
                let out = dispatch.call(name, input).await;
                self.emit(AgentEvent::ToolEnd {
                    id: id.clone(),
                    ok: out.ok,
                    output: out.text.clone(),
                    images: out.images.clone(),
                });
                results.push(Content::ToolResult {
                    tool_use_id: id.clone(),
                    content: out.text,
                    is_error: !out.ok,
                    images: out.images,
                });
            }
            if let Ok(mut items) = self.items.lock() {
                items.push(ChatItem::Message {
                    role: "user".into(),
                    content: results,
                });
            }
        }
        Err(format!("too many tool-call rounds ({max_turns})"))
    }

    /// Moves pending background-task notices into the history. Returns true
    /// when something was injected (the caller keeps the turn alive).
    fn inject_pending_wakeups(&self) -> bool {
        let drained: Vec<String> = self
            .pending_wakeups
            .lock()
            .map(|mut g| std::mem::take(&mut *g))
            .unwrap_or_default();
        if drained.is_empty() {
            return false;
        }
        if let Ok(mut items) = self.items.lock() {
            for notice in drained {
                items.push(ChatItem::user_text(&notice));
            }
        }
        true
    }

    fn tool_defs(&self) -> Vec<ToolDef> {
        let tools = self.def.effective_tools();
        if tools.is_empty() {
            // The study assistant is pure Q&A: it registers no tools and the prompt
            // does not steer toward them; the model answers from its own knowledge.
            return Vec::new();
        }
        let mut defs: Vec<ToolDef> = super::tools::tool_schemas()
            .iter()
            .filter(|(name, _, _)| tools.iter().any(|t| t == name))
            .map(|(name, description, schema)| ToolDef {
                name: (*name).to_string(),
                description: (*description).to_string(),
                input_schema: schema.clone(),
                mcp_server: None,
            })
            .collect();
        if self.def.mcp_enabled() {
            for tool in &self.mcp.tools {
                defs.push(ToolDef {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    input_schema: tool.input_schema.clone(),
                    mcp_server: None,
                });
            }
        }
        defs
    }

    async fn execute_tool_shared(&self, name: &str, input: &Value) -> ToolOutput {
        if let Some(rest) = name.strip_prefix("mcp__") {
            if !self.def.mcp_enabled() {
                return ToolOutput::text(false, "MCP 工具未启用");
            }
            let mut parts = rest.splitn(2, "__");
            let (server, tool) = match (parts.next(), parts.next()) {
                (Some(s), Some(t)) => (s, t),
                _ => return ToolOutput::text(false, format!("malformed mcp tool name: {}", name)),
            };
            return match self.mcp.call(server, tool, input).await {
                Ok(text) => ToolOutput::text(true, text),
                Err(e) => ToolOutput::text(false, e),
            };
        }
        // Session-owned tools (they touch session state, not just the context).
        match name {
            "todo" => {
                let mut current = self
                    .todos
                    .lock()
                    .map(|mut g| std::mem::take(&mut *g))
                    .unwrap_or_default();
                return match todo::replace_list(&mut current, input) {
                    Ok(summary) => {
                        *self.todos.lock().unwrap_or_else(|e| e.into_inner()) = current.clone();
                        self.emit(AgentEvent::Todos {
                            todos: todo::render(&current),
                        });
                        ToolOutput::text(true, summary)
                    }
                    Err(e) => ToolOutput::text(false, e),
                };
            }
            "bash" => {
                return self.run_bash(input).await;
            }
            "bash_output" | "bash_kill" => {
                return self.run_bg_control(name, input);
            }
            _ => {}
        }
        super::tools::execute(&self.ctx, &self.skills, name, input).await
    }

    /// The bash tool: foreground commands through the persistent-cwd shell,
    /// or a detached background task whose completion wakes the session.
    async fn run_bash(&self, input: &Value) -> ToolOutput {
        let command = input["command"].as_str().unwrap_or_default().to_string();
        if command.trim().is_empty() {
            return ToolOutput::text(false, "command 不能为空");
        }
        if input["run_in_background"].as_bool().unwrap_or(false) {
            let cwd = self.bg_cwd();
            let weak = self
                .self_ref
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_default();
            let on_done = Arc::new(move |id: u64, ok: bool, code: i32| {
                if let Some(session) = weak.upgrade() {
                    session.on_bg_done(id, ok, code);
                }
            });
            return match self.ctx.bg.spawn(command, cwd, on_done) {
                Ok(id) => ToolOutput::text(
                    true,
                    format!(
                        "background task {id} started\n用 bash_output({{id: {id}}}) 查询输出;任务结束后会自动唤醒本会话。"
                    ),
                ),
                Err(e) => ToolOutput::text(false, e),
            };
        }
        let timeout = input["timeout_secs"]
            .as_u64()
            .unwrap_or(DEFAULT_TIMEOUT_SECS);
        let out = shell::run_command(
            &command,
            timeout,
            &self.ctx.shell,
            &self.default_dir(),
            &self.ctx.abort,
        )
        .await;
        ToolOutput::text(out.ok, out.text)
    }

    fn run_bg_control(&self, name: &str, input: &Value) -> ToolOutput {
        let id = input["id"].as_u64().unwrap_or(u64::MAX);
        let Some(task) = self.ctx.bg.get(id) else {
            return ToolOutput::text(false, format!("unknown background task: {id}"));
        };
        if name == "bash_kill" {
            // A killed task still reports through on_done (wait returns).
            let _ = task;
            return ToolOutput::text(
                true,
                "kill 请求已发出;进程结束后 bash_output 仍可读到已有输出".to_string(),
            );
        }
        ToolOutput::text(true, shell::format_bg_status(&task))
    }

    /// Anchor directory for bash: the code project root for coding sessions,
    /// the vault otherwise.
    fn default_dir(&self) -> std::path::PathBuf {
        self.ctx
            .workdir
            .clone()
            .or_else(|| self.ctx.vault.clone())
            .unwrap_or_else(|| self.ctx.data_dir.clone())
    }

    fn bg_cwd(&self) -> std::path::PathBuf {
        self.ctx
            .workdir
            .clone()
            .or_else(|| self.ctx.vault.clone())
            .unwrap_or_else(|| self.ctx.data_dir.clone())
    }

    /// Background completion callback: notify the panel, then either park the
    /// notice for the running turn or wake the idle session.
    fn on_bg_done(&self, id: u64, ok: bool, code: i32) {
        let tail = self
            .ctx
            .bg
            .get(id)
            .map(|t| {
                let out = t.output();
                let tail = out.lines().rev().take(40).collect::<Vec<_>>();
                tail.into_iter().rev().collect::<Vec<_>>().join("\n")
            })
            .unwrap_or_default();
        let status = if ok { "成功" } else { "失败" };
        self.emit(AgentEvent::Notice {
            text: format!("后台任务 {id} 已结束({status},exit {code})"),
        });
        let notice = format!(
            "<system-reminder>后台任务 {id} 已结束({status},exit code {code})。以下是它的输出尾部:\n{tail}\n</system-reminder>"
        );
        let running = self.running.load(Ordering::SeqCst);
        if running {
            if let Ok(mut q) = self.pending_wakeups.lock() {
                q.push(notice);
                return;
            }
        }
        // Idle: claim the running slot and wake the model. The wakeup turn is
        // spawned on the session's own Weak, so no reference cycle and no
        // borrow may outlive the registry entry.
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let weak = self
                .self_ref
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_default();
            tauri::async_runtime::spawn(async move {
                if let Some(session) = weak.upgrade() {
                    session.run_wakeup(notice).await;
                }
            });
        }
    }

    /// Spawns a subagent from a definition and returns its report as the tool
    /// result. Subagents run to completion here (the parent turn waits) — the
    /// model's own sequencing already interleaves independent calls, and one
    /// shared `running` flag keeps abort semantics simple.
    async fn run_subagent(&self, input: &Value) -> ToolOutput {
        let prompt = input["prompt"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        if prompt.is_empty() {
            return ToolOutput::text(false, "prompt 不能为空");
        }
        let def_id = input["subagent_type"]
            .as_str()
            .unwrap_or("explore")
            .trim()
            .to_string();
        // Whitelist: empty = every definition is allowed; otherwise the id must
        // be listed. A deny in the child's own permissions always wins.
        if !self.def.subagents.is_empty() && !self.def.subagents.iter().any(|s| *s == def_id) {
            return ToolOutput::text(
                false,
                format!(
                    "子代理 {} 不在允许列表 [{}] 内",
                    def_id,
                    self.def.subagents.join(", ")
                ),
            );
        }
        let (defs, errors) = super::defs::load_definitions(self.ctx.vault.as_deref());
        for err in &errors {
            if err.id == def_id {
                return ToolOutput::text(false, format!("子代理定义损坏: {}", err.message));
            }
        }
        let Some(child_def) = defs.into_iter().find(|d| d.id == def_id) else {
            return ToolOutput::text(false, format!("unknown subagent: {def_id}"));
        };
        self.emit(AgentEvent::Notice {
            text: format!("子代理 {} 启动", child_def.display_name()),
        });
        // A subagent explores and reports: no nested subagents, ever.
        let mut child_def = child_def;
        // A subagent explores and reports: no nested subagents, ever. `None`
        // (default set) becomes an explicit list without task.
        child_def.tools = Some(match child_def.tools {
            Some(list) => list.into_iter().filter(|t| t != "task").collect(),
            None => DEFAULT_TOOLS_ITER
                .into_iter()
                .filter(|t| **t != "task")
                .map(|s| s.to_string())
                .collect(),
        });
        // Subagents report back, they do not converse: cap the rounds tighter
        // than the parent's unless the definition says otherwise.
        if child_def.max_turns == 0 {
            child_def.max_turns = SUBAGENT_MAX_TURNS;
        }
        let child_def = Arc::new(child_def);
        let child_ctx = Arc::new(ToolContext {
            vault: self.ctx.vault.clone(),
            data_dir: self.ctx.data_dir.clone(),
            study_content: self.ctx.study_content.clone(),
            abort: self.ctx.abort.clone(),
            app: None,
            preview_seq: std::sync::atomic::AtomicU64::new(0),
            workdir: self.ctx.workdir.clone(),
            shell: Arc::new(ShellCwd::new()),
            bg: Arc::new(BgRegistry::new()),
        });
        let user = super::load_user_instructions(self.ctx.vault.as_deref());
        let workdir_s = self
            .ctx
            .workdir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let study = self.ctx.study_content.read().ok().and_then(|g| g.clone());
        let input_ = AssembleInput {
            def: &child_def,
            vault_name: &self.vault_name,
            current_note: self.current_note.as_deref(),
            workdir: workdir_s.as_deref(),
            study: study.as_ref(),
            skills: &self.skills.skills,
            mcp_names: &self.mcp_names,
            user_instructions: &user,
        };
        let child = Session {
            id: format!("{}-sub-{}", self.id, def_id),
            mode: self.mode,
            def: child_def.clone(),
            items: Mutex::new(vec![ChatItem::user_text(&prompt)]),
            system_prompt: RwLock::new(assemble(&input_)),
            vault_name: self.vault_name.clone(),
            current_note: self.current_note.clone(),
            mcp_names: self.mcp_names.clone(),
            ctx: child_ctx,
            skills: self.skills.clone(),
            mcp: self.mcp.clone(),
            provider: self.provider.clone(),
            running: Arc::new(AtomicBool::new(false)),
            seq: self.seq.clone(),
            app: self.app.clone(),
            context_window: self.context_window,
            last_usage: Mutex::new(None),
            todos: Mutex::new(Vec::new()),
            pending_wakeups: Mutex::new(Vec::new()),
            self_ref: Mutex::new(None),
        };
        // Refresh the dynamic segments once (file layers resolve here, unlike
        // the parent they were not part of the initial assembly). The loop runs
        // in its own task with the subagent dispatcher: that is the type-level
        // break the Send proof needs (see ToolDispatch) and the
        // no-nested-subagents policy.
        let label = child_def.display_name().to_string();
        let handle = tauri::async_runtime::spawn(async move {
            child.refresh_dynamic_prompt();
            let loop_result = child.run_loop(&SubDispatch(&child)).await;
            // The report: the last assistant text (the model's own closing message).
            let mut report = child
                .history()
                .iter()
                .rev()
                .filter_map(|item| match item {
                    ChatItem::Message { role, content } if role == "assistant" => {
                        Some(content.iter().filter_map(|c| match c {
                            Content::Text { text } => Some(text.clone()),
                            _ => None,
                        }))
                    }
                    _ => None,
                })
                .flatten()
                .next()
                .unwrap_or_default();
            if report.trim().is_empty() {
                if let Err(e) = loop_result {
                    report = format!("(子代理在产出报告前中止: {e})");
                }
            }
            report
        });
        let report = match handle.await {
            Ok(r) => r,
            Err(e) => return ToolOutput::text(false, format!("join failed: {}", e)),
        };
        self.emit(AgentEvent::Notice {
            text: format!("子代理 {} 完成", label),
        });
        if report.trim().is_empty() {
            ToolOutput::text(false, format!("子代理 {} 没有产出报告(可能被中止)", label))
        } else {
            ToolOutput::text(true, report)
        }
    }

    /// Auto-compact: when the latest reported input crosses threshold ×
    /// context window, replace the history with a summary. Runs before a model
    /// request, so the very next request already starts from the compact form.
    async fn maybe_auto_compact(&self) -> Result<(), String> {
        if !self.def.compaction.enabled || self.context_window == 0 {
            return Ok(());
        }
        let last = self.last_usage.lock().map(|g| *g).unwrap_or(None);
        let Some(usage) = last else { return Ok(()) };
        let threshold = if self.def.compaction.threshold > 0.0 {
            self.def.compaction.threshold.clamp(0.3, 1.0)
        } else {
            COMPACT_THRESHOLD
        };
        if (usage.input as f64) < threshold * self.context_window as f64 {
            return Ok(());
        }
        self.compact().await
    }

    /// Replaces the history with the compaction summary (one user message).
    pub async fn compact(&self) -> Result<(), String> {
        let snapshot = self.history();
        if snapshot.is_empty() {
            return Ok(());
        }
        let collected = Mutex::new(String::new());
        let sink = |event: AgentEvent| {
            if let AgentEvent::TextDelta { text } = event {
                if let Ok(mut buf) = collected.lock() {
                    buf.push_str(&text);
                }
            }
        };
        self.provider
            .stream_turn(COMPACTION_PROMPT, &snapshot, &[], &sink)
            .await?;
        let mut summary = collected.into_inner().map_err(|e| e.to_string())?;
        summary = strip_analysis(&summary);
        if summary.trim().is_empty() {
            return Err("压缩失败:模型没有返回摘要".into());
        }
        if let Ok(mut items) = self.items.lock() {
            *items = vec![ChatItem::user_text(&format!(
                "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n\n{summary}"
            ))];
        }
        if let Ok(mut slot) = self.last_usage.lock() {
            *slot = None;
        }
        self.emit(AgentEvent::Notice {
            text: format!(
                "上下文已压缩:会话历史已替换为摘要(原 {} 条)",
                snapshot.len()
            ),
        });
        Ok(())
    }
}

/// Removes the `<analysis>` drafting block the compaction prompt asks for —
/// the scratchpad stays out of the continued history (Claude Code's
/// formatCompactSummary).
fn strip_analysis(text: &str) -> String {
    match (text.find("<analysis>"), text.find("</analysis>")) {
        (Some(start), Some(end)) => {
            let mut out = String::new();
            out.push_str(&text[..start]);
            out.push_str(text[end + "</analysis>".len()..].trim_start());
            out.trim().to_string()
        }
        _ => text.trim().to_string(),
    }
}

/// The compaction prompt. Faithful to Claude Code's nine-section summary: the
/// analysis pass organizes the drafting, the sections pin what must survive.
const COMPACTION_PROMPT: &str = "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will be used to continue the work in a fresh context without losing important information.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis process, chronologically analyze each message: the user's explicit requests and intents, your approach, key decisions, file names and code snippets, errors and how you fixed them, and any user feedback about doing something differently.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created, with short code snippets where applicable and why they matter.
4. Errors and fixes: List errors you ran into and how you fixed them, especially user feedback about doing something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the user's feedback and changing intent.
7. Pending Tasks: Outline pending tasks you have explicitly been asked to work on.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step directly in line with the user's most recent request. If the last task was concluded, say so instead of inventing new work.

After the <analysis> block, output the summary as plain text with the nine numbered sections. Respond with text only — do not call any tools.";

/// Session registry shared in Tauri state.
#[derive(Default)]
pub struct SessionRegistry {
    pub sessions: Mutex<std::collections::HashMap<String, Arc<Session>>>,
}

/// Builds one session of the given mode from the effective definition.
/// Shared by `agent_start_session` (the id is assigned there).
pub struct SessionSeed {
    pub id: String,
    pub mode: SessionMode,
    pub def: Arc<AgentDefinition>,
    pub vault_name: String,
    pub current_note: Option<String>,
    pub mcp_names: Vec<String>,
    pub user_instructions: String,
    pub skills: Arc<super::skills::SkillRegistry>,
    pub mcp: Arc<McpManager>,
    pub provider: Arc<Provider>,
    pub ctx: Arc<ToolContext>,
    pub app: tauri::AppHandle,
    pub context_window: u64,
}

pub fn create_session(seed: SessionSeed) -> Session {
    let workdir_s = seed
        .ctx
        .workdir
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    let study = seed.ctx.study_content.read().ok().and_then(|g| g.clone());
    let input = AssembleInput {
        def: &seed.def,
        vault_name: &seed.vault_name,
        current_note: seed.current_note.as_deref(),
        workdir: workdir_s.as_deref(),
        study: study.as_ref(),
        skills: &seed.skills.skills,
        mcp_names: &seed.mcp_names,
        user_instructions: &seed.user_instructions,
    };
    Session {
        id: seed.id,
        mode: seed.mode,
        def: seed.def.clone(),
        items: Mutex::new(Vec::new()),
        system_prompt: RwLock::new(assemble(&input)),
        vault_name: seed.vault_name,
        current_note: seed.current_note,
        mcp_names: seed.mcp_names,
        ctx: seed.ctx,
        skills: seed.skills,
        mcp: seed.mcp,
        provider: seed.provider,
        running: Arc::new(AtomicBool::new(false)),
        seq: Arc::new(AtomicU64::new(0)),
        app: seed.app,
        context_window: seed.context_window,
        last_usage: Mutex::new(None),
        todos: Mutex::new(Vec::new()),
        pending_wakeups: Mutex::new(Vec::new()),
        self_ref: Mutex::new(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_guard_always_resets_on_scope_exit_including_a_panic_unwind() {
        // Historical defect: running was only reset manually at the end of send,
        // so a panic or a dropped task (a hanging request) left it true forever →
        // every later agent_send was rejected.
        let flag = Arc::new(AtomicBool::new(true));
        {
            let _g = RunningGuard(flag.clone());
        }
        assert!(!flag.load(Ordering::SeqCst));

        flag.store(true, Ordering::SeqCst);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = RunningGuard(flag.clone());
            panic!("simulated panic inside the session");
        }));
        assert!(result.is_err());
        assert!(
            !flag.load(Ordering::SeqCst),
            "the guard must reset running while unwinding a panic"
        );
    }

    #[test]
    fn mode_parse_accepts_the_three_shapes_and_rejects_the_rest() {
        assert_eq!(SessionMode::parse(None), Ok(SessionMode::Study));
        assert_eq!(SessionMode::parse(Some("")), Ok(SessionMode::Study));
        assert_eq!(
            SessionMode::parse(Some("creative")),
            Ok(SessionMode::Creative)
        );
        assert_eq!(SessionMode::parse(Some("coding")), Ok(SessionMode::Coding));
        assert!(SessionMode::parse(Some("agent")).is_err());
        assert_eq!(SessionMode::Coding.definition_id(), "coding");
    }

    #[test]
    fn strip_analysis_removes_the_drafting_block_and_keeps_the_summary() {
        let text =
            "<analysis>\nthinking...\n</analysis>\n\n1. Primary Request and Intent:\nbuild it\n";
        assert_eq!(
            strip_analysis(text),
            "1. Primary Request and Intent:\nbuild it"
        );
        assert_eq!(strip_analysis("no tags here"), "no tags here");
        assert_eq!(strip_analysis("  spaced  "), "spaced");
    }
}
