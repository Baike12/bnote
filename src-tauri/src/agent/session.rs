//! Agent session: conversation state + the tool-call turn loop.

use super::mcp::McpManager;
use super::provider::Provider;
use super::tools::{ToolContext, StudyContent};
use super::types::{AgentEvent, ChatItem, Content, ToolDef};
use serde_json::Value;
use tauri::Emitter;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub struct Session {
    pub id: String,
    pub items: Mutex<Vec<ChatItem>>,
    pub system_prompt: String,
    pub ctx: Arc<ToolContext>,
    pub skills: Arc<super::skills::SkillRegistry>,
    pub mcp: Arc<McpManager>,
    pub provider: Arc<Provider>,
    pub running: Arc<AtomicBool>,
    pub seq: Arc<AtomicU64>,
    pub app: tauri::AppHandle,
}

impl Session {
    pub fn history(&self) -> Vec<ChatItem> {
        self.items.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Runs one user turn: stream → tool calls → results → repeat.
    pub async fn send(&self, text: &str) {
        if let Ok(mut items) = self.items.lock() {
            items.push(ChatItem::user_text(text));
        }
        self.running.store(true, Ordering::SeqCst);
        let result = self.run_loop().await;
        self.running.store(false, Ordering::SeqCst);
        let event = match result {
            Ok(()) => AgentEvent::TurnEnd { reason: "end".into() },
            Err(e) => AgentEvent::Error { message: e },
        };
        self.emit(event);
    }

    fn emit(&self, event: AgentEvent) {
        let payload = serde_json::json!({
            "sessionId": self.id,
            "event": event,
        });
        let _ = self.app.emit("agent-event", payload);
    }

    async fn run_loop(&self) -> Result<(), String> {
        let tools = self.tool_defs();
        for _step in 0..25 {
            if self.ctx.abort.load(Ordering::SeqCst) {
                self.ctx.abort.store(false, Ordering::SeqCst);
                return Ok(());
            }
            let sink = |event: AgentEvent| self.emit(event);
            let snapshot = self.history();
            let sink_ref: &(dyn Fn(AgentEvent) + Send + Sync) = &sink;
            let turn = self
                .provider
                .stream_turn(&self.system_prompt, &snapshot, &tools, sink_ref)
                .await?;
            // Assemble the assistant message.
            let mut content: Vec<Content> = Vec::new();
            if !turn.text.is_empty() {
                content.push(Content::Text { text: turn.text.clone() });
            }
            content.extend(turn.tool_calls.iter().cloned());
            if let Ok(mut items) = self.items.lock() {
                items.push(ChatItem::Message {
                    role: "assistant".into(),
                    content,
                });
            }
            if turn.tool_calls.is_empty() {
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
                let (ok, output) = self.execute_tool(name, input).await;
                self.emit(AgentEvent::ToolEnd {
                    id: id.clone(),
                    ok,
                    output: output.clone(),
                });
                results.push(Content::ToolResult {
                    tool_use_id: id.clone(),
                    content: output,
                    is_error: !ok,
                });
            }
            if let Ok(mut items) = self.items.lock() {
                items.push(ChatItem::Message {
                    role: "user".into(),
                    content: results,
                });
            }
        }
        Err("too many tool-call rounds (25)".into())
    }

    fn tool_defs(&self) -> Vec<ToolDef> {
        let mut defs: Vec<ToolDef> = super::tools::tool_schemas()
            .iter()
            .map(|(name, desc, schema)| ToolDef {
                name: name.to_string(),
                description: desc.to_string(),
                input_schema: schema.clone(),
                mcp_server: None,
            })
            .collect();
        defs.extend(self.mcp.tools.iter().map(|t| ToolDef {
            name: t.name.clone(),
            description: t.description.clone(),
            input_schema: t.input_schema.clone(),
            mcp_server: None,
        }));
        defs
    }

    async fn execute_tool(&self, name: &str, input: &Value) -> (bool, String) {
        if let Some(rest) = name.strip_prefix("mcp__") {
            let mut parts = rest.splitn(2, "__");
            let (server, tool) = match (parts.next(), parts.next()) {
                (Some(s), Some(t)) => (s, t),
                _ => return (false, format!("malformed mcp tool name: {}", name)),
            };
            match self.mcp.call(server, tool, input).await {
                Ok(text) => (true, text),
                Err(e) => (false, e),
            }
        } else {
            super::tools::execute(&self.ctx, &self.skills, name, input).await
        }
    }
}

/// Session registry shared in Tauri state.
#[derive(Default)]
pub struct SessionRegistry {
    pub sessions: Mutex<std::collections::HashMap<String, Arc<Session>>>,
}

/// Builds the system prompt for a session.
pub fn build_system_prompt(
    vault_name: &str,
    current_note: Option<&str>,
    study: Option<&StudyContent>,
    skills_block: &str,
    mcp_block: &str,
) -> String {
    let mut p = String::from(
        "You are bnote's study assistant, embedded in a markdown note-taking app. \
The user is studying material (a converted PDF paper or a web page) shown in the \
center panel while their own notes stay on the right. Answer in the user's language. \
Use markdown and $...$ / $$...$$ LaTeX math. When the question relates to the study \
material, ground your answer in it via the read_study_content tool before answering \
from memory; quote the relevant formulas precisely.\n\n",
    );
    p.push_str(&format!("- Vault: {}\n", vault_name));
    if let Some(note) = current_note {
        p.push_str(&format!("- Current note: {}\n", note));
    }
    match study {
        Some(StudyContent::Markdown { path, title }) => {
            p.push_str(&format!("- Study content: \"{}\" (markdown file at {})\n", title, path));
        }
        Some(StudyContent::Url { url, title }) => {
            p.push_str(&format!("- Study content: web page \"{}\" at {}\n", title, url));
        }
        None => {}
    }
    p.push_str(skills_block);
    p.push_str(mcp_block);
    p
}
