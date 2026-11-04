//! Agent session: conversation state + the tool-call turn loop.
//!
//! A session is shaped by its [`AgentDefinition`]: the definition decides the
//! system prompt (through the assembly pipeline in `prompt.rs`), the tool
//! surface, compaction and subagent policy. Study, creative and coding only
//! choose an id from `<vault>/.bnote/agents/<id>/`; there is no per-mode
//! prompt builder left.
//!
//! The loop follows Claude Code's contract (see `query.ts` there):
//! `needsFollowUp` (a tool_use block arrived) is the only natural exit; the
//! next request is `history ++ assistants ++ tool_results`; independent tools
//! run in parallel; every tool_use gets exactly one tool_result.

use super::defs::AgentDefinition;
use super::defs::DEFAULT_TOOLS as DEFAULT_TOOLS_ITER;
use super::mcp::McpManager;
use super::permissions::{self, Decision};
use super::prompt::{assemble, AssembleInput};
use super::provider::{Provider, TurnOptions, ABORTED};
use super::results::ResultStore;
use super::schema;
use super::shell::{self, BgRegistry, ShellCwd, DEFAULT_TIMEOUT_SECS};
use super::tasks::TaskList;
use super::todo::{self, TodoItem};
use super::tools::{ToolContext, ToolOutput};
use super::types::{AgentEvent, ChatItem, Content, InlineImage, ToolDef};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use tauri::Emitter;
use tokio::sync::oneshot;

/// Cap on tool-call rounds per turn when the definition does not set one.
const DEFAULT_MAX_TURNS: u32 = 25;
/// Cap for subagent turns (subagents report back, they do not converse).
const SUBAGENT_MAX_TURNS: u32 = 20;
/// CC's fork child cap (forkSubagent.ts).
const FORK_MAX_TURNS: u32 = 200;
/// Token buffer kept free below the context window; auto-compact fires first.
/// Claude Code uses the same fixed 13k so the threshold travels across models.
const AUTOCOMPACT_BUFFER_TOKENS: u64 = 13_000;
/// Ceiling auto-compact failure tolerance (CC's circuit breaker).
const MAX_COMPACT_FAILURES: u32 = 3;
/// The ceiling the loop raises to once when the model hits `max_tokens`.
const ESCALATED_MAX_TOKENS: u32 = 64_000;
/// How many "resume" messages the loop injects after the escalation.
const MAX_OUTPUT_TOKENS_RECOVERY: u32 = 3;
/// Concurrent tools per batch (CC's CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).
const MAX_TOOL_CONCURRENCY: usize = 10;

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

/// Why a turn ended. Mirrors CC's `Terminal.reason`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnOutcome {
    pub reason: &'static str,
}

impl TurnOutcome {
    fn new(reason: &'static str) -> Self {
        TurnOutcome { reason }
    }
}

/// What the user answered in the approval dialog.
pub struct PermissionAnswer {
    pub allow: bool,
    /// The optional note typed next to "reject".
    pub feedback: Option<String>,
}

/// The attachment state of one session: what changed since the last request.
#[derive(Default)]
struct AttachmentState {
    /// The date the model was last told about (a new day injects a reminder).
    date: Option<String>,
    /// Files written by tools since the last request.
    changed: Vec<String>,
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
    /// usage.input against it.
    pub context_window: u64,
    /// Latest reported usage; the auto-compact trigger input.
    pub last_usage: Mutex<Option<super::types::TokenUsage>>,
    /// The todo tool's list (single writer: the todo tool on this session).
    pub todos: Mutex<Vec<TodoItem>>,
    /// The v2 task list (task_create / task_update / …).
    pub tasks: Mutex<TaskList>,
    /// Background-task completions waiting to be injected as a wakeup message.
    pub pending_wakeups: Mutex<Vec<String>>,
    /// Closeable tool approvals: request id → channel back to the loop.
    pub pending_permissions: Mutex<HashMap<String, oneshot::Sender<PermissionAnswer>>>,
    /// Closeable `ask_user_question` waits.
    pub pending_questions: Mutex<HashMap<String, oneshot::Sender<String>>>,
    /// Oversized tool results are persisted here instead of truncated.
    pub results: ResultStore,
    /// Consecutive auto-compact failures (CC's circuit breaker).
    compact_failures: AtomicU32,
    /// Attachments (date change, changed files) since the last request.
    attachments: Mutex<AttachmentState>,
    /// Set for subagents whose definition is read-only: `.bnote/AGENTS.md` is
    /// omitted from their context (CC's `omitClaudeMd`).
    pub omit_user_instructions: bool,
    /// The composer's permission mode (confirm / auto / full).
    permission_mode: Mutex<permissions::Mode>,
    /// Subagents this session spawned, kept after they finish so
    /// `send_message` can continue them (CC/ZCode's agent registry).
    pub children: Mutex<HashMap<String, Arc<Session>>>,
    /// Set on a subagent: the session that spawned it.
    parent_id: Option<String>,
    /// Where this subagent's transcript is persisted; `None` for the main
    /// session (its record lives with the material).
    agent_dir: Option<std::path::PathBuf>,
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
            if name == "send_message" {
                return self.0.run_send_message(input).await;
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
            if name == "task" || name == "send_message" {
                return ToolOutput::text(
                    false,
                    tool_use_error("子代理不能派生子代理,也不能给别的 agent 发消息"),
                );
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

/// Wraps a tool failure the way Claude Code does, so the model can tell a tool
/// error from ordinary output.
pub fn tool_use_error(message: impl AsRef<str>) -> String {
    format!("<tool_use_error>{}</tool_use_error>", message.as_ref())
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
        // A new turn starts un-aborted. The flag is sticky inside a turn (a stop
        // that lands during the final stream must not be cleared by the loop),
        // so resetting it happens here and only here.
        self.ctx.abort.reset();
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
        self.ctx.abort.reset();
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
        self.finish_turn(self.compact().await.map(|()| TurnOutcome::new("end")))
            .await;
    }

    /// Emits the turn's terminal event (the one contract every entry point
    /// must keep).
    async fn finish_turn(&self, result: Result<TurnOutcome, String>) {
        let count = self.history().len();
        let event = match result {
            Ok(outcome) => AgentEvent::TurnEnd {
                reason: outcome.reason.into(),
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

    /// The composer's permission mode.
    pub fn permission_mode(&self) -> permissions::Mode {
        self.permission_mode
            .lock()
            .map(|g| *g)
            .unwrap_or(permissions::Mode::Auto)
    }

    pub fn set_permission_mode(&self, mode: permissions::Mode) {
        if let Ok(mut slot) = self.permission_mode.lock() {
            *slot = mode;
        }
    }

    /// Re-assembles the dynamic prompt segments (environment, git status,
    /// prompt files). Called before every model request: two small file reads
    /// against an LLM round-trip is nothing, and it is what makes a saved
    /// prompt file edit take effect on the next message.
    fn refresh_dynamic_prompt(&self) {
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
        };
        let prompt = assemble(&input);
        if let Ok(mut slot) = self.system_prompt.write() {
            if *slot != prompt {
                *slot = prompt;
            }
        }
    }

    /// The request messages: the user-context meta message, then the history.
    ///
    /// CC puts CLAUDE.md and the current date in a `<system-reminder>` user
    /// message in front of the conversation instead of inside the system
    /// prompt, so editing the instructions file reaches the model on the very
    /// next request without touching the cached prefix.
    fn request_items(&self) -> Vec<ChatItem> {
        let mut items = Vec::new();
        if let Some(context) = self.user_context() {
            items.push(ChatItem::user_text(&context));
        }
        items.extend(self.history());
        items
    }

    fn user_context(&self) -> Option<String> {
        let mut sections = String::new();
        if !self.omit_user_instructions {
            let user = super::load_user_instructions(self.ctx.vault.as_deref());
            if !user.trim().is_empty() {
                sections.push_str(&format!("# AGENTS.md\n{}\n\n", user.trim()));
            }
        }
        let today = super::prompt::today_string();
        sections.push_str(&format!("# currentDate\nToday's date is {}.\n", today));
        Some(format!(
            "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n{}\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>",
            sections.trim_end()
        ))
    }

    /// System-reminder attachments for this request: a new day, files changed by
    /// tools since the last request. CC injects these after tool results so the
    /// model sees them at the point where they matter.
    fn take_attachments(&self) -> Vec<String> {
        let today = super::prompt::today_string();
        let mut out = Vec::new();
        let mut state = match self.attachments.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if state.date.as_deref() != Some(today.as_str()) {
            if state.date.is_some() {
                out.push(format!("Today's date is now {}.", today));
            }
            state.date = Some(today);
        }
        if !state.changed.is_empty() {
            let mut files = std::mem::take(&mut state.changed);
            files.sort();
            files.dedup();
            out.push(format!(
                "The following files were modified since the last message:\n{}",
                files
                    .iter()
                    .map(|f| format!("- {}", f))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        out
    }

    /// Records a successful write so the next request can remind the model
    /// which files changed.
    fn note_changed(&self, path: &str) {
        if let Ok(mut state) = self.attachments.lock() {
            if !state.changed.iter().any(|p| p == path) {
                state.changed.push(path.to_string());
            }
        }
    }

    /// The turn loop. `dispatch` is erased so the subagent path never nests
    /// back into this future type (see the trait comment above).
    async fn run_loop(&self, dispatch: &dyn ToolDispatch) -> Result<TurnOutcome, String> {
        let max_turns = if self.def.max_turns > 0 {
            self.def.max_turns
        } else {
            DEFAULT_MAX_TURNS
        };
        let mut turn_count = 0u32;
        // The output ceiling starts at the provider's value; one `max_tokens`
        // hit raises it, further hits inject a resume message (CC's recovery).
        let mut max_tokens_override: Option<u32> = None;
        let mut escalations = 0u32;
        let mut recoveries = 0u32;
        loop {
            if self.ctx.abort.is_aborted() {
                return Ok(TurnOutcome::new("aborted"));
            }
            // A subagent writes its transcript before each request: a crash or a
            // quota failure must not erase the work already done.
            if self.parent_id.is_some() {
                self.persist_agent("running");
            }
            self.refresh_dynamic_prompt();
            self.maybe_auto_compact().await?;
            self.inject_pending_wakeups();
            let tools = self.tool_defs();
            let sink = |event: AgentEvent| self.emit(event);
            let snapshot = self.request_items();
            let system = self
                .system_prompt
                .read()
                .map(|g| g.clone())
                .unwrap_or_default();
            let sink_ref: &(dyn Fn(AgentEvent) + Send + Sync) = &sink;
            let opts = TurnOptions {
                max_tokens: max_tokens_override,
                abort: self.ctx.abort.clone(),
            };
            let turn = self
                .provider
                .stream_turn_with(&system, &snapshot, &tools, sink_ref, &opts)
                .await;
            let turn = match turn {
                Ok(t) => t,
                Err(e) if e == ABORTED => return Ok(TurnOutcome::new("aborted")),
                Err(e) => return Err(e),
            };
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
            // Output-token recovery: raise the ceiling once, then ask the model
            // to resume where it stopped.
            if turn.hit_max_tokens && turn.tool_calls.is_empty() {
                if escalations == 0 {
                    escalations += 1;
                    max_tokens_override = Some(ESCALATED_MAX_TOKENS);
                    self.emit(AgentEvent::Notice {
                        text: format!("输出达到上限,提升到 {} tokens 继续", ESCALATED_MAX_TOKENS),
                    });
                    continue;
                }
                if recoveries < MAX_OUTPUT_TOKENS_RECOVERY {
                    recoveries += 1;
                    if let Ok(mut items) = self.items.lock() {
                        items.push(ChatItem::user_text(
                            "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
                        ));
                    }
                    continue;
                }
                return Ok(TurnOutcome::new("max_tokens"));
            }
            if turn.tool_calls.is_empty() {
                // The model is done — but a background task may have finished
                // while it was writing: drain the wakeups and keep the turn
                // alive so the model sees them (the wake-on-event path).
                if self.inject_pending_wakeups() {
                    continue;
                }
                return Ok(TurnOutcome::new("end"));
            }
            turn_count += 1;
            let calls: Vec<ToolCall> = turn
                .tool_calls
                .iter()
                .filter_map(|c| match c {
                    Content::ToolUse {
                        id,
                        name,
                        input,
                        input_error,
                    } => Some(ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                        input_error: input_error.clone(),
                    }),
                    _ => None,
                })
                .collect();
            let results = self.execute_calls(dispatch, &calls).await;
            if !results.is_empty() {
                if let Ok(mut items) = self.items.lock() {
                    items.push(ChatItem::Message {
                        role: "user".into(),
                        content: results,
                    });
                }
            }
            // Attachments go after the tool results: the API rejects a
            // tool_result message interleaved with ordinary user messages.
            let reminders = self.take_attachments();
            if !reminders.is_empty() {
                if let Ok(mut items) = self.items.lock() {
                    for reminder in reminders {
                        items.push(ChatItem::user_text(&format!(
                            "<system-reminder>{}</system-reminder>",
                            reminder
                        )));
                    }
                }
            }
            if self.ctx.abort.is_aborted() {
                return Ok(TurnOutcome::new("aborted"));
            }
            if turn_count >= max_turns {
                self.emit(AgentEvent::Notice {
                    text: format!("达到最大轮次({max_turns}),本轮结束;可以继续发消息接着做。"),
                });
                return Ok(TurnOutcome::new("max_turns"));
            }
        }
    }

    /// Validates, authorizes and runs all tool calls of one assistant message.
    /// The returned results are in call order, one per call.
    async fn execute_calls(
        &self,
        dispatch: &dyn ToolDispatch,
        calls: &[ToolCall],
    ) -> Vec<Content> {
        let mut outputs: Vec<Option<ToolOutput>> = (0..calls.len()).map(|_| None).collect();
        let mut ready: Vec<usize> = Vec::new();
        for (index, call) in calls.iter().enumerate() {
            self.emit(AgentEvent::ToolStart {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
            });
            // 1. The streamed JSON must parse.
            if let Some(error) = &call.input_error {
                outputs[index] = Some(ToolOutput::text(
                    false,
                    tool_use_error(format!("InputValidationError: {}", error)),
                ));
                continue;
            }
            // 2. The input must match the schema that was sent to the model.
            if let Some(message) = self.validate_input(&call.name, &call.input) {
                outputs[index] = Some(ToolOutput::text(
                    false,
                    tool_use_error(format!("InputValidationError: {}", message)),
                ));
                continue;
            }
            // 3. The definition's permission decides.
            match permissions::decide(self.permission_mode(), &self.def, &call.name, &call.input) {
                Decision::Deny => {
                    outputs[index] = Some(ToolOutput::text(
                        false,
                        tool_use_error(permissions::denial_message(&call.name)),
                    ));
                }
                Decision::Ask => match self.ask_permission(&call.name, &call.input).await {
                    PermissionAnswer { allow: true, .. } => ready.push(index),
                    PermissionAnswer { feedback, .. } => {
                        outputs[index] = Some(ToolOutput::text(
                            false,
                            tool_use_error(permissions::reject_message(feedback.as_deref())),
                        ));
                    }
                },
                Decision::Allow => ready.push(index),
            }
        }
        // Consecutive concurrency-safe calls share one parallel batch; anything
        // else runs alone, in call order.
        let mut cursor = 0usize;
        while cursor < ready.len() {
            if self.ctx.abort.is_aborted() {
                for &index in &ready[cursor..] {
                    outputs[index] = Some(ToolOutput::text(
                        false,
                        tool_use_error("aborted by user"),
                    ));
                }
                break;
            }
            let first = ready[cursor];
            let safe = super::tools::is_concurrency_safe(&calls[first].name);
            let mut group = vec![first];
            cursor += 1;
            if safe {
                while cursor < ready.len() {
                    let next = ready[cursor];
                    // Only consecutive calls form a batch (CC keeps call order).
                    if next != group[group.len() - 1] + 1
                        || !super::tools::is_concurrency_safe(&calls[next].name)
                    {
                        break;
                    }
                    group.push(next);
                    cursor += 1;
                }
            }
            if group.len() == 1 {
                let index = group[0];
                let out = dispatch.call(&calls[index].name, &calls[index].input).await;
                outputs[index] = Some(out);
                continue;
            }
            let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_TOOL_CONCURRENCY));
            let futures = group.iter().map(|&index| {
                let name = calls[index].name.clone();
                let input = calls[index].input.clone();
                let semaphore = semaphore.clone();
                async move {
                    let _permit = semaphore.acquire().await;
                    (index, dispatch.call(&name, &input).await)
                }
            });
            for (index, out) in futures::future::join_all(futures).await {
                outputs[index] = Some(out);
            }
        }
        let mut results = Vec::with_capacity(calls.len());
        for (index, call) in calls.iter().enumerate() {
            let mut out = outputs[index]
                .take()
                .unwrap_or_else(|| ToolOutput::text(false, tool_use_error("tool did not run")));
            // Never truncate in place: a huge result goes to a file with a
            // preview, so the model can read the rest itself.
            out.text = self.results.cap(&self.id, out.text);
            if out.ok && (call.name == "write_file" || call.name == "edit_file") {
                if let Some(path) = call.input["path"].as_str() {
                    self.note_changed(path);
                }
            }
            self.emit(AgentEvent::ToolEnd {
                id: call.id.clone(),
                ok: out.ok,
                output: out.text.clone(),
                images: out.images.clone(),
            });
            results.push(Content::ToolResult {
                tool_use_id: call.id.clone(),
                content: out.text,
                is_error: !out.ok,
                images: out.images,
            });
        }
        self.results.apply_budget(&self.id, &mut results);
        results
    }

    fn validate_input(&self, name: &str, input: &Value) -> Option<String> {
        let schema = super::tools::tool_schemas()
            .iter()
            .find(|(registered, _, _)| *registered == name)
            .map(|(_, _, schema)| schema.clone())
            .or_else(|| {
                // MCP tools carry the schema the server advertised; validate it
                // the same way so a malformed call fails locally and cheaply.
                self.mcp
                    .tools
                    .iter()
                    .find(|t| t.name == name)
                    .map(|t| t.input_schema.clone())
            })?;
        schema::validate(&schema, input).err()
    }

    /// Pauses the turn until the user approves or rejects the call in the panel.
    async fn ask_permission(&self, tool: &str, input: &Value) -> PermissionAnswer {
        let request_id = format!(
            "{}-perm-{}",
            self.id,
            self.seq.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = self.pending_permissions.lock() {
            map.insert(request_id.clone(), tx);
        }
        self.emit(AgentEvent::PermissionRequest {
            id: request_id.clone(),
            tool: tool.to_string(),
            input: input.clone(),
        });
        let answer = tokio::select! {
            _ = self.ctx.abort.wait() => PermissionAnswer { allow: false, feedback: Some("用户中止了本轮".into()) },
            received = rx => match received {
                Ok(answer) => answer,
                // The waiter was dropped (session torn down): refuse, never run.
                Err(_) => PermissionAnswer { allow: false, feedback: None },
            },
        };
        if let Ok(mut map) = self.pending_permissions.lock() {
            map.remove(&request_id);
        }
        answer
    }

    /// Pauses the turn until the panel answers an `ask_user_question` call.
    async fn ask_question(&self, questions: &Value) -> Result<String, String> {
        let request_id = format!(
            "{}-q-{}",
            self.id,
            self.seq.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        self.pending_questions
            .lock()
            .map_err(|e| e.to_string())?
            .insert(request_id.clone(), tx);
        self.emit(AgentEvent::Question {
            id: request_id.clone(),
            questions: questions.clone(),
        });
        let answer = tokio::select! {
            _ = self.ctx.abort.wait() => Err("用户中止了本轮".to_string()),
            received = rx => received.map_err(|_| "问题未回答:等待方已结束".to_string()),
        };
        if let Ok(mut map) = self.pending_questions.lock() {
            map.remove(&request_id);
        }
        answer
    }

    /// Delivers the panel's answer to a waiting `ask_permission`.
    pub fn resolve_permission(
        &self,
        request_id: &str,
        answer: PermissionAnswer,
    ) -> Result<(), String> {
        let sender = self
            .pending_permissions
            .lock()
            .map_err(|e| e.to_string())?
            .remove(request_id)
            .ok_or_else(|| format!("PERMISSION_NOT_PENDING: {request_id}"))?;
        sender
            .send(answer)
            .map_err(|_| "PERMISSION_CLOSED: 等待方已结束".to_string())
    }

    /// Delivers the panel's answer to a waiting `ask_user_question`.
    pub fn resolve_question(&self, request_id: &str, answer: String) -> Result<(), String> {
        let sender = self
            .pending_questions
            .lock()
            .map_err(|e| e.to_string())?
            .remove(request_id)
            .ok_or_else(|| format!("QUESTION_NOT_PENDING: {request_id}"))?;
        sender
            .send(answer)
            .map_err(|_| "QUESTION_CLOSED: 等待方已结束".to_string())
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
                return ToolOutput::text(false, tool_use_error("MCP 工具未启用"));
            }
            let mut parts = rest.splitn(2, "__");
            let (server, tool) = match (parts.next(), parts.next()) {
                (Some(s), Some(t)) => (s, t),
                _ => {
                    return ToolOutput::text(
                        false,
                        tool_use_error(format!("malformed mcp tool name: {}", name)),
                    )
                }
            };
            return match self.mcp.call(server, tool, input).await {
                Ok((text, is_error)) => {
                    if is_error {
                        ToolOutput::text(false, tool_use_error(text))
                    } else {
                        ToolOutput::text(true, text)
                    }
                }
                Err(e) => ToolOutput::text(false, tool_use_error(e)),
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
                    Err(e) => ToolOutput::text(false, tool_use_error(e)),
                };
            }
            "bash" => {
                return self.run_bash(input).await;
            }
            "bash_output" | "bash_kill" => {
                return self.run_bg_control(name, input);
            }
            "ask_user_question" => {
                return match self.ask_question(&input["questions"]).await {
                    Ok(answer) => ToolOutput::text(true, answer),
                    Err(e) => ToolOutput::text(false, tool_use_error(e)),
                };
            }
            _ => {}
        }
        // The v2 task list: the same single-writer rule as the todo list.
        if matches!(
            name,
            "task_create" | "task_update" | "task_list" | "task_get"
        ) {
            let mut list = self
                .tasks
                .lock()
                .map(|mut g| std::mem::take(&mut *g))
                .unwrap_or_default();
            let outcome = match name {
                "task_create" => list.create(input),
                "task_update" => list.update(input),
                "task_get" => input["id"]
                    .as_str()
                    .map(|id| list.get(id))
                    .unwrap_or_else(|| Err("id 不能为空".to_string())),
                _ => Ok(list.list()),
            };
            *self.tasks.lock().unwrap_or_else(|e| e.into_inner()) = list.clone();
            let tasks = list.render();
            self.emit(AgentEvent::Tasks { tasks });
            return match outcome {
                Ok(text) => ToolOutput::text(true, text),
                Err(e) => ToolOutput::text(false, tool_use_error(e)),
            };
        }
        super::tools::execute(&self.ctx, &self.skills, name, input).await
    }

    /// The bash tool: foreground commands through the persistent-cwd shell,
    /// or a detached background task whose completion wakes the session.
    async fn run_bash(&self, input: &Value) -> ToolOutput {
        let command = input["command"].as_str().unwrap_or_default().to_string();
        if command.trim().is_empty() {
            return ToolOutput::text(false, tool_use_error("command 不能为空"));
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
                Err(e) => ToolOutput::text(false, tool_use_error(e)),
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
            return ToolOutput::text(
                false,
                tool_use_error(format!("unknown background task: {id}")),
            );
        };
        if name == "bash_kill" {
            task.kill();
            return ToolOutput::text(
                true,
                format!("kill signal sent to background task {id}"),
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
        self.requeue_or_wake(notice);
    }

    /// A background result arrives: queue it for the running turn, or claim the
    /// session and start a wakeup turn.
    fn requeue_or_wake(&self, notice: String) {
        if self.running.load(Ordering::SeqCst) {
            if let Ok(mut q) = self.pending_wakeups.lock() {
                q.push(notice);
                return;
            }
        }
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
        } else if let Ok(mut q) = self.pending_wakeups.lock() {
            // Lost the race with a turn that just started: it will drain this.
            q.push(notice);
        }
    }

    /// Spawns a subagent and returns its report as the tool result.
    ///
    /// CC's Agent tool shape: `subagent_type` optional (default
    /// general-purpose), `run_in_background` optional, `model` optional, and a
    /// report trailer carrying the agent id and usage. `fork: true` runs the
    /// fork child: it inherits the parent transcript and reports once.
    async fn run_subagent(&self, input: &Value) -> ToolOutput {
        let prompt = input["prompt"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        if prompt.is_empty() {
            return ToolOutput::text(false, tool_use_error("prompt 不能为空"));
        }
        let description = input["description"].as_str().unwrap_or_default().to_string();
        let fork = input["fork"].as_bool().unwrap_or(false);
        let background = input["run_in_background"].as_bool().unwrap_or(false);
        let def_id = input["subagent_type"]
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if fork {
                    "fork".to_string()
                } else {
                    "general-purpose".to_string()
                }
            });
        if fork && def_id != "fork" {
            return ToolOutput::text(
                false,
                tool_use_error("fork: true 与 subagent_type 不能同时给出"),
            );
        }
        // Whitelist: empty = every definition is allowed; otherwise the id must
        // be listed. A deny in the child's own permissions always wins.
        if !self.def.subagents.is_empty() && !self.def.subagents.iter().any(|s| *s == def_id) {
            return ToolOutput::text(
                false,
                tool_use_error(format!(
                    "子代理 {} 不在允许列表 [{}] 内",
                    def_id,
                    self.def.subagents.join(", ")
                )),
            );
        }
        let mut child_def = if fork {
            // The fork child is not a definition on disk: it inherits the
            // parent's surface (CC's FALLBACK descriptor).
            AgentDefinition {
                id: "fork".into(),
                name: "Fork".into(),
                description: "Forked worker that inherits the parent conversation".into(),
                tools: Some(self.def.effective_tools()),
                dir: self.def.dir.clone(),
                ..Default::default()
            }
        } else {
            let (defs, errors) = super::defs::load_definitions(self.ctx.vault.as_deref());
            for err in &errors {
                if err.id == def_id {
                    return ToolOutput::text(
                        false,
                        tool_use_error(format!("子代理定义损坏: {}", err.message)),
                    );
                }
            }
            match defs.into_iter().find(|d| d.id == def_id) {
                Some(d) => d,
                None => {
                    return ToolOutput::text(
                        false,
                        tool_use_error(format!("unknown subagent: {def_id}")),
                    )
                }
            }
        };
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
        // `model` on the call may override the definition, which overrides the
        // parent (empty = inherit).
        let model_override = input["model"]
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| Some(child_def.model.clone()).filter(|m| !m.is_empty()));
        if child_def.max_tokens == 0 {
            child_def.max_tokens = self.provider.max_tokens;
        }
        if child_def.max_turns == 0 {
            child_def.max_turns = if fork {
                FORK_MAX_TURNS
            } else {
                SUBAGENT_MAX_TURNS
            };
        }
        // Subagents that cannot write do not need the vault's user instructions
        // (CC's omitClaudeMd for read-only agents).
        let read_only = !child_def
            .effective_tools()
            .iter()
            .any(|t| t == "write_file" || t == "edit_file" || t == "bash");
        let child_def = Arc::new(child_def);
        let child_provider = match model_override {
            Some(model) if model != self.provider.model => Arc::new(Provider::new(
                &self.provider.kind,
                &self.provider.base_url,
                &self.provider.api_key,
                &model,
                child_def.max_tokens,
            )),
            _ => self.provider.clone(),
        };
        let child_ctx = Arc::new(ToolContext {
            vault: self.ctx.vault.clone(),
            data_dir: self.ctx.data_dir.clone(),
            study_content: self.ctx.study_content.clone(),
            // The child observes the parent's stop but never clears it.
            abort: self.ctx.abort.child(),
            app: None,
            preview_seq: std::sync::atomic::AtomicU64::new(0),
            workdir: self.ctx.workdir.clone(),
            shell: Arc::new(ShellCwd::new()),
            bg: Arc::new(BgRegistry::new()),
        });
        let workdir_s = self
            .ctx
            .workdir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let study = self.ctx.study_content.read().ok().and_then(|g| g.clone());
        let assemble_input = AssembleInput {
            def: &child_def,
            vault_name: &self.vault_name,
            current_note: self.current_note.as_deref(),
            workdir: workdir_s.as_deref(),
            study: study.as_ref(),
            skills: &self.skills.skills,
            mcp_names: &self.mcp_names,
        };
        // The initial history: the fork inherits the parent transcript (minus
        // incomplete tool calls); a normal subagent starts from one user turn.
        let items = if fork {
            let mut inherited: Vec<ChatItem> = self.history();
            drop_incomplete_tail(&mut inherited);
            inherited.push(ChatItem::user_text(&format!(
                "STOP. You are a forked worker process, not the main agent. \
                 You cannot ask the user anything, cannot spawn sub-agents, and must not \
                 narrate. Do the task below and finish with a report of at most 500 words \
                 in this shape:\n\nScope: …\nResult: …\nKey files: …\nFiles changed: …\nIssues: …\n\nTask:\n{}",
                prompt
            )));
            inherited
        } else {
            vec![ChatItem::user_text(&prompt)]
        };
        let label = child_def.display_name().to_string();
        let child_id_for_dir = format!(
            "agent-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            self.seq.fetch_add(1, Ordering::Relaxed)
        );
        let child = Arc::new(Session {
            id: format!("{}-sub-{}", self.id, child_def.id),
            mode: self.mode,
            def: child_def.clone(),
            items: Mutex::new(items),
            system_prompt: RwLock::new(assemble(&assemble_input)),
            vault_name: self.vault_name.clone(),
            current_note: self.current_note.clone(),
            mcp_names: self.mcp_names.clone(),
            ctx: child_ctx,
            skills: self.skills.clone(),
            mcp: self.mcp.clone(),
            provider: child_provider,
            running: Arc::new(AtomicBool::new(false)),
            seq: self.seq.clone(),
            app: self.app.clone(),
            context_window: self.context_window,
            last_usage: Mutex::new(None),
            todos: Mutex::new(Vec::new()),
            tasks: Mutex::new(TaskList::new()),
            pending_wakeups: Mutex::new(Vec::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            pending_questions: Mutex::new(HashMap::new()),
            results: ResultStore::new(self.ctx.data_dir.join("tool-results")),
            compact_failures: AtomicU32::new(0),
            attachments: Mutex::new(AttachmentState::default()),
            omit_user_instructions: read_only,
            permission_mode: Mutex::new(self.permission_mode()),
            children: Mutex::new(HashMap::new()),
            parent_id: Some(self.id.clone()),
            agent_dir: Some(
                self.ctx
                    .data_dir
                    .join("agents")
                    .join(&self.id)
                    .join(&child_id_for_dir),
            ),
            self_ref: Mutex::new(None),
        });
        if let Ok(mut slot) = child.self_ref.lock() {
            *slot = Some(Arc::downgrade(&child));
        }
        // Register the child before it runs: once it is in the map, and its
        // transcript is on disk, `send_message` can continue it even after a
        // crash, a rate limit or a stop.
        if let Ok(mut map) = self.children.lock() {
            map.insert(child.id.clone(), child.clone());
        }
        child.persist_agent("running");
        self.emit(AgentEvent::Notice {
            text: format!(
                "子代理 {}{} 启动 ({})",
                label,
                if description.is_empty() {
                    String::new()
                } else {
                    format!("({})", description)
                },
                child.id
            ),
        });
        let started = std::time::Instant::now();
        // The loop runs in its own task with the subagent dispatcher: that is
        // the type-level break the Send proof needs (see ToolDispatch) and the
        // no-nested-subagents policy.
        let runner_child = child.clone();
        let runner = tauri::async_runtime::spawn(async move {
            runner_child.refresh_dynamic_prompt();
            let loop_result = runner_child.run_loop(&SubDispatch(&runner_child)).await;
            runner_child.persist_agent(if loop_result.is_ok() { "completed" } else { "failed" });
            let mut report = last_assistant_text(&runner_child.history());
            if report.trim().is_empty() {
                if let Err(e) = &loop_result {
                    report = format!("(子代理在产出报告前中止: {e})");
                }
            }
            let usage = runner_child
                .last_usage
                .lock()
                .map(|g| *g)
                .unwrap_or(None);
            (report, usage)
        });
        if background {
            // Background subagent: answer immediately; the completion notice
            // wakes the parent (the same channel background bash uses).
            let parent = self
                .self_ref
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_default();
            let label_bg = label.clone();
            tauri::async_runtime::spawn(async move {
                let (report, usage) = match runner.await {
                    Ok(v) => v,
                    Err(e) => (format!("(子代理 join 失败: {e})"), None),
                };
                let totals = usage
                    .map(|u| format!("\ntotal_tokens: {}", u.input + u.output))
                    .unwrap_or_default();
                let notice = format!(
                    "<system-reminder>后台子代理 {label_bg} 已完成。报告:\n{report}{totals}\n</system-reminder>"
                );
                if let Some(session) = parent.upgrade() {
                    session.emit(AgentEvent::Notice {
                        text: format!("子代理 {label_bg} 完成"),
                    });
                    session.requeue_or_wake(notice);
                }
            });
            return ToolOutput::text(
                true,
                format!(
                    "Async agent launched successfully.\nagentId: {}\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work. Briefly tell the user what you launched and why.",
                    child.id
                ),
            );
        }
        let (report, usage) = match runner.await {
            Ok(v) => v,
            Err(e) => return ToolOutput::text(false, tool_use_error(format!("join failed: {}", e))),
        };
        self.emit(AgentEvent::Notice {
            text: format!("子代理 {} 完成 ({})", label, child.id),
        });
        let duration = started.elapsed().as_millis();
        let body = if report.trim().is_empty() {
            "(Subagent completed but returned no output.)".to_string()
        } else {
            report
        };
        // CC's trailer: the id (for a follow-up), tokens, duration.
        let trailer = format!(
            "\n\nagentId: {}\n<usage>total_tokens: {}\nduration_ms: {}</usage>",
            child.id,
            usage.map(|u| u.input + u.output).unwrap_or(0),
            duration
        );
        // "One-shot" read-only agents omit the trailer: there is nothing to
        // continue, and the ids only add noise.
        if read_only && !fork {
            ToolOutput::text(true, body)
        } else {
            ToolOutput::text(true, format!("{}{}", body, trailer))
        }
    }

    /// Writes a subagent's transcript and metadata under
    /// `<data_dir>/agents/<parentId>/<agentId>/`. The main session has no
    /// `agent_dir`: its record belongs to the material.
    fn persist_agent(&self, status: &str) {
        let Some(dir) = &self.agent_dir else { return };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        if let Ok(json) = serde_json::to_string(&self.history()) {
            let _ = std::fs::write(dir.join("transcript.json"), json);
        }
        let meta = json!({
            "agentId": self.id,
            "parentId": self.parent_id,
            "defId": self.def.id,
            "label": self.def.display_name(),
            "status": status,
            "model": self.provider.model,
            "updatedAt": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
        });
        let _ = std::fs::write(dir.join("metadata.json"), meta.to_string());
    }

    /// `send_message`: deliver a message to a subagent this session spawned.
    ///
    /// Same three outcomes ZCode's SendMessage has: a running agent gets the
    /// message queued for its next turn, an agent that already finished (or
    /// died on a rate limit) is resumed in the background with its history
    /// intact, and an unknown id is refused. The resumed turn reports back
    /// through the same wakeup channel a background task uses.
    async fn run_send_message(&self, input: &Value) -> ToolOutput {
        let to = input["to"].as_str().unwrap_or_default().trim().to_string();
        let message = input["message"].as_str().unwrap_or_default().to_string();
        if to.is_empty() || message.trim().is_empty() {
            return ToolOutput::text(false, tool_use_error("to 和 message 都不能为空"));
        }
        let child = self
            .children
            .lock()
            .ok()
            .and_then(|map| map.get(&to).cloned());
        let Some(child) = child else {
            return ToolOutput::text(
                false,
                tool_use_error(format!(
                    "No active local agent found for target {to}. Spawn a new task or fork instead."
                )),
            );
        };
        // Running: queue it; the child drains the queue at its next turn
        // boundary (the same channel a background bash completion uses).
        if child.running.load(Ordering::SeqCst) {
            if let Ok(mut queue) = child.pending_wakeups.lock() {
                queue.push(format!(
                    "<system-reminder>Message from the parent session:\n{}</system-reminder>",
                    message
                ));
            }
            return ToolOutput::text(
                true,
                format!(
                    "Message queued for running agent {to}; it will be delivered at its next turn."
                ),
            );
        }
        if child
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return ToolOutput::text(
                true,
                format!("Message queued for running agent {to}; it will be delivered at its next turn."),
            );
        }
        if let Ok(mut items) = child.items.lock() {
            items.push(ChatItem::user_text(&message));
        }
        child.ctx.abort.reset();
        let parent = self
            .self_ref
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_default();
        let child_for_task = child.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = RunningGuard(child_for_task.running.clone());
            child_for_task.persist_agent("running");
            let started = std::time::Instant::now();
            let result = child_for_task.run_loop(&SubDispatch(&child_for_task)).await;
            let report = last_assistant_text(&child_for_task.history());
            let status = if result.is_ok() { "completed" } else { "failed" };
            child_for_task.persist_agent(status);
            let usage = child_for_task
                .last_usage
                .lock()
                .map(|g| *g)
                .unwrap_or(None);
            let label = child_for_task.def.display_name().to_string();
            if let Some(parent) = parent.upgrade() {
                parent.emit(AgentEvent::Notice {
                    text: format!("子代理 {label} 继续完成"),
                });
                let body = if report.trim().is_empty() {
                    "(agent produced no new report)".to_string()
                } else {
                    report
                };
                let totals = usage
                    .map(|u| format!("\ntotal_tokens: {}", u.input + u.output))
                    .unwrap_or_default();
                parent.requeue_or_wake(format!(
                    "<system-reminder>Agent {} finished another turn ({} ms). Report:\n{}{}\n</system-reminder>",
                    child_for_task.id,
                    started.elapsed().as_millis(),
                    body,
                    totals
                ));
            }
        });
        ToolOutput::text(
            true,
            format!("Agent {to} was resumed in the background with your message. You will be notified when it completes."),
        )
    }

    /// Auto-compact: when the latest reported input crosses the threshold,
    /// replace the history with a summary. Runs before a model request, so the
    /// very next request already starts from the compact form.
    ///
    /// Threshold = context window − 13k, the same buffer CC keeps free for the
    /// next response. Three consecutive failures trip the breaker: a model that
    /// cannot summarize must not burn a request per turn.
    async fn maybe_auto_compact(&self) -> Result<(), String> {
        if !self.def.compaction.enabled || self.context_window == 0 {
            return Ok(());
        }
        if self.compact_failures.load(Ordering::SeqCst) >= MAX_COMPACT_FAILURES {
            return Ok(());
        }
        let last = self.last_usage.lock().map(|g| *g).unwrap_or(None);
        let Some(usage) = last else { return Ok(()) };
        let threshold = if self.def.compaction.threshold > 0.0 {
            (self.def.compaction.threshold.clamp(0.3, 1.0) * self.context_window as f64) as u64
        } else {
            self.context_window
                .saturating_sub(AUTOCOMPACT_BUFFER_TOKENS)
        };
        if usage.input < threshold {
            return Ok(());
        }
        match self.compact().await {
            Ok(()) => {
                self.compact_failures.store(0, Ordering::SeqCst);
                Ok(())
            }
            Err(e) => {
                let failures = self.compact_failures.fetch_add(1, Ordering::SeqCst) + 1;
                if failures >= MAX_COMPACT_FAILURES {
                    self.emit(AgentEvent::Notice {
                        text: format!("自动压缩连续失败 {failures} 次,本轮起跳过压缩: {e}"),
                    });
                }
                Err(e)
            }
        }
    }

    /// Replaces the history with the compaction summary (one user message),
    /// following CC's post-compact shape: the summary carries the "continue
    /// where you left off" instruction, and the mechanism sections (tools,
    /// skills, MCP) are re-announced by the next assembled system prompt.
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
        let opts = TurnOptions {
            max_tokens: None,
            abort: self.ctx.abort.clone(),
        };
        self.provider
            .stream_turn_with(COMPACTION_PROMPT, &snapshot, &[], &sink, &opts)
            .await?;
        let mut summary = collected.into_inner().map_err(|e| e.to_string())?;
        summary = strip_analysis(&summary);
        if summary.trim().is_empty() {
            return Err("压缩失败:模型没有返回摘要".into());
        }
        if let Ok(mut items) = self.items.lock() {
            *items = vec![ChatItem::user_text(&format!(
                "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n\n{summary}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened."
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

/// One parsed tool call of an assistant message.
struct ToolCall {
    id: String,
    name: String,
    input: Value,
    input_error: Option<String>,
}

/// The last assistant text: the model's own closing message. Walks backwards
/// until a message with text is found (CC's finalizeAgentTool), so a subagent
/// that ended on a tool call still reports something.
fn last_assistant_text(items: &[ChatItem]) -> String {
    for item in items.iter().rev() {
        if let ChatItem::Message { role, content } = item {
            if role != "assistant" {
                continue;
            }
            let text: String = content
                .iter()
                .filter_map(|c| match c {
                    Content::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    String::new()
}

/// Drops a trailing assistant message whose tool calls have no results yet: a
/// fork must not inherit a half-finished tool round (CC's
/// `filterIncompleteToolCalls`).
fn drop_incomplete_tail(items: &mut Vec<ChatItem>) {
    let Some(ChatItem::Message { role, content }) = items.last() else {
        return;
    };
    if role != "assistant" {
        return;
    }
    let has_tool_use = content.iter().any(|c| matches!(c, Content::ToolUse { .. }));
    if has_tool_use || content.is_empty() {
        items.pop();
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
const COMPACTION_PROMPT: &str = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will be used to continue the work in a fresh context without losing important information.\n\nBefore providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis process, chronologically analyze each message: the user's explicit requests and intents, your approach, key decisions, file names and code snippets, errors and how you fixed them, and any user feedback about doing something differently.\n\nYour summary should include the following sections:\n\n1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.\n2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.\n3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created, with short code snippets where applicable and why they matter.\n4. Errors and fixes: List errors you ran into and how you fixed them, especially user feedback about doing something differently.\n5. Problem Solving: Document problems solved and any ongoing troubleshooting.\n6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the user's feedback and changing intent.\n7. Pending Tasks: Outline pending tasks you have been explicitly asked to work on.\n8. Current Work: Describe precisely what was being worked on immediately before this summary request.\n9. Optional Next Step: List the next step directly in line with the user's most recent request. If the last task was concluded, say so instead of inventing new work. Include verbatim quotes from the most recent conversation so the next step is unambiguous.\n\nAfter the <analysis> block, output the summary as plain text with the nine numbered sections.\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";

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
    pub skills: Arc<super::skills::SkillRegistry>,
    pub mcp: Arc<McpManager>,
    pub provider: Arc<Provider>,
    pub ctx: Arc<ToolContext>,
    pub app: tauri::AppHandle,
    pub context_window: u64,
    /// The composer's mode when the session starts (default: auto).
    pub permission_mode: Option<permissions::Mode>,
}

pub fn create_session(seed: SessionSeed) -> Session {
    let results = ResultStore::new(seed.ctx.data_dir.join("tool-results"));
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
        tasks: Mutex::new(TaskList::new()),
        pending_wakeups: Mutex::new(Vec::new()),
        pending_permissions: Mutex::new(HashMap::new()),
        pending_questions: Mutex::new(HashMap::new()),
        results,
        compact_failures: AtomicU32::new(0),
        attachments: Mutex::new(AttachmentState::default()),
        omit_user_instructions: false,
        permission_mode: Mutex::new(
            seed.permission_mode.unwrap_or_default(),
        ),
        children: Mutex::new(HashMap::new()),
        parent_id: None,
        agent_dir: None,
        self_ref: Mutex::new(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn the_last_assistant_text_skips_trailing_tool_only_messages() {
        let items = vec![
            ChatItem::user_text("do it"),
            ChatItem::Message {
                role: "assistant".into(),
                content: vec![Content::Text {
                    text: "first answer".into(),
                }],
            },
            ChatItem::Message {
                role: "assistant".into(),
                content: vec![Content::ToolUse {
                    id: "t1".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a"}),
                    input_error: None,
                }],
            },
        ];
        assert_eq!(last_assistant_text(&items), "first answer");
    }

    #[test]
    fn a_fork_drops_a_trailing_assistant_turn_without_results() {
        let mut items = vec![
            ChatItem::user_text("do it"),
            ChatItem::Message {
                role: "assistant".into(),
                content: vec![Content::ToolUse {
                    id: "t1".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a"}),
                    input_error: None,
                }],
            },
        ];
        drop_incomplete_tail(&mut items);
        assert_eq!(items.len(), 1);
    }
}
