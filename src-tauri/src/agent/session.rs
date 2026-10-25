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
        // 条数随结束事件一起给前端:分叉辅助会话时按它截断,不用猜。
        let count = self.history().len();
        let event = match result {
            Ok(()) => AgentEvent::TurnEnd {
                reason: "end".into(),
                items: count,
            },
            Err(e) => AgentEvent::Error { message: e, items: count },
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
        // 学习助手是纯问答:不注册任何工具,提示词也不引导(见
        // build_system_prompt),模型只凭自身知识直接回答。要恢复工具时,
        // 在这里重新拼内置工具(tool_schemas)+ MCP 工具,并同步恢复提示词
        // 里的 skills/MCP 节。
        Vec::new()
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
///
/// 三层结构,从固定到可变:
/// 1. 固定的通用要求(代码写死):简洁、直击本质、符合认知科学——这是学习
///    场景的底线,用户配置不能把它顶掉;
/// 2. `user_instructions`:vault 的 `.bnote/agent.md`(类比 ZCode 的
///    AGENTS.md / Claude Code 的 CLAUDE.md),设置里可编辑;
/// 3. 运行时上下文(仓库、当前笔记、学习材料)。
///
/// 学习助手是纯问答:不注册任何工具,提示词也不引导调用工具——两边只要
/// 有一边漏掉,模型就会去调不存在的工具或绕路读文件。
pub fn build_system_prompt(
    vault_name: &str,
    current_note: Option<&str>,
    study: Option<&StudyContent>,
    user_instructions: &str,
) -> String {
    let mut p = String::from(
        "You are bnote's study assistant, embedded in a markdown note-taking app. \
The user is studying material (a PDF paper or a web page) shown in the \
center panel while their own notes stay in the right pane. Answer in the user's language. \
Use markdown and $...$ / $$...$$ LaTeX math. Answer questions directly from your \
own knowledge.\n\n\
\
## 回答方式(必须遵守)\n\n\
- 结论先行:第一句直接回答问题,再给最短必要的解释。不要复述问题、不要寒暄、不要绕圈子。\n\
- 直击本质:先给一句话核心(这个概念到底在解决什么问题),再给细节;细节只保留影响理解的部分。\n\
- 符合认知科学:组块化——把内容组织成 3~5 个要点,每个要点一个概念;先框架后细节;新概念用已有概念类比;对比易混概念时给出明确的判别标准。\n\
- 控制长度:默认不超过 200 字或 5 个要点;只有用户明确要求展开、或问题确实复杂时才写长。\n\
- 结构服务理解:能用一个公式说清就不用三段文字;步骤用有序列表;并列要点用无序列表;重要对比用表格。\n\
- 不确定就说不确定,并指出验证路径;不要编造论文里没有的内容。\n\n",
    );
    p.push_str(&format!("- Vault: {}\n", vault_name));
    if let Some(note) = current_note {
        p.push_str(&format!("- Current note: {}\n", note));
    }
    match study {
        Some(StudyContent::Pdf { path, title }) => {
            p.push_str(&format!("- Study content: PDF \"{}\" at {}\n", title, path));
        }
        Some(StudyContent::Url { url, title }) => {
            p.push_str(&format!("- Study content: web page \"{}\" at {}\n", title, url));
        }
        None => {}
    }
    let user = user_instructions.trim();
    if !user.is_empty() {
        p.push_str("\n## 用户自定义指令(.bnote/agent.md)\n\n");
        p.push_str(user);
        p.push_str("\n");
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 固定要求在自定义指令之前_且自定义指令为空时不出现该节() {
        let base = build_system_prompt("vault", None, None, "");
        assert!(base.contains("结论先行"));
        assert!(!base.contains(".bnote/agent.md"));

        let with_user = build_system_prompt("vault", None, None, "  多用表格回答。 \n");
        let custom = with_user.find("多用表格回答。").unwrap();
        let fixed = with_user.find("结论先行").unwrap();
        assert!(fixed < custom, "用户指令应在固定要求之后追加");
    }

    #[test]
    fn 纯问答_提示词不出现任何工具引导() {
        // 历史缺陷:提示词要求"答前先调 read_study_content",叠加把内置 +
        // MCP 工具全量注册进请求,导致每个问题都触发工具调用。学习助手是
        // 纯问答,这条不变量锁住:提示词里不得出现任何工具名或加载引导。
        let study = StudyContent::Pdf {
            path: "/tmp/paper.pdf".into(),
            title: "paper".into(),
        };
        let p = build_system_prompt("vault", Some("notes/a.md"), Some(&study), "");
        assert!(!p.contains("tool"), "不得引导调用工具:\n{}", p);
        assert!(!p.contains("read_study_content"));
        assert!(!p.contains("skill"));
        assert!(!p.contains("mcp__"));
        assert!(!p.contains("MCP"));
    }
}
