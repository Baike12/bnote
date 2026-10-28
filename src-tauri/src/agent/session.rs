//! Agent session: conversation state + the tool-call turn loop.

use super::mcp::McpManager;
use super::provider::Provider;
use super::skills::SkillInfo;
use super::tools::{ToolContext, StudyContent};
use super::types::{AgentEvent, ChatItem, Content, InlineImage, ToolDef};
use serde_json::Value;
use tauri::Emitter;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 会话形态：学习（纯问答，围绕中栏材料）或创作（带工具 + skill + MCP，
/// 围绕仓库内容与 HTML 产物）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    Study,
    Creative,
}

pub struct Session {
    pub id: String,
    pub mode: SessionMode,
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

/// `running` 的守卫:进入 `send` 时建,离开作用域(正常结束 / 出错 / panic)
/// 时自动把会话放回可发送状态。
///
/// 没有它,一次挂起或 panic 会让 `running` 永远为 true:之后每次 `agent_send`
/// 都被 SESSION_BUSY 拒掉,而前端只弹一个几秒消失的 toast——用户看到的就是
/// 「再次发送没有回应」。
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
    /// `images` 是随消息发送的截图/图片(可为空)。
    ///
    /// 契约:**每次 send 都以恰好一个终止事件(turn_end / error)结束**。
    /// 前端靠它清「生成中」状态;少发一次,面板就永远停在忙碌态。
    pub async fn send(&self, text: &str, images: Vec<InlineImage>) {
        let _guard = RunningGuard(self.running.clone());
        if text.trim().is_empty() && images.is_empty() {
            // provider 会因空 content 弹 400,这里直接报错结束——但不能静默
            // return,否则前端等不到终止事件。
            self.emit(AgentEvent::Error {
                message: "消息为空:请先输入内容或添加图片".into(),
                items: self.history().len(),
            });
            return;
        }
        if let Ok(mut items) = self.items.lock() {
            items.push(ChatItem::user_message(text, &images));
        }
        let result = self.run_loop().await;
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

    /// 把事件推给前端(命令层在 panic 兜底时也要用)。
    pub fn emit(&self, event: AgentEvent) {
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
            if let Some(usage) = turn.usage {
                // 只保留最新一条就是当前上下文占用;input 已含系统提示词与全部历史。
                self.emit(AgentEvent::Usage {
                    input: usage.input,
                    output: usage.output,
                });
            }
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
        match self.mode {
            // 学习助手是纯问答:不注册任何工具,提示词也不引导(见
            // build_study_prompt),模型只凭自身知识直接回答。
            SessionMode::Study => Vec::new(),
            // 创作助手带完整工具面:内置工具(文件/URL/bash/skill/预览)+
            // MCP 工具;提示词与工具注册必须同步(两边都开或都关)。
            SessionMode::Creative => {
                let mut defs: Vec<ToolDef> = super::tools::tool_schemas()
                    .iter()
                    .map(|(name, description, schema)| ToolDef {
                        name: (*name).to_string(),
                        description: (*description).to_string(),
                        input_schema: schema.clone(),
                        mcp_server: None,
                    })
                    .collect();
                for tool in &self.mcp.tools {
                    defs.push(ToolDef {
                        name: tool.name.clone(),
                        description: tool.description.clone(),
                        input_schema: tool.input_schema.clone(),
                        mcp_server: None,
                    });
                }
                defs
            }
        }
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

/// Builds the system prompt for a study session (pure Q&A around the
/// material open in the middle column).
///
/// 三层结构,从固定到可变:
/// 1. 固定的通用要求(代码写死):简洁、直击本质、符合认知科学——这是学习
///    场景的底线,用户配置不能把它顶掉;
/// 2. `user_instructions`:vault 的 `.bnote/AGENTS.md`(旧版 `.bnote/agent.md`),
///    设置里可编辑;
/// 3. 运行时上下文(仓库、当前笔记、学习材料)。
///
/// 学习助手是纯问答:不注册任何工具,提示词也不引导调用工具——两边只要
/// 有一边漏掉,模型就会去调不存在的工具或绕路读文件。
pub fn build_study_prompt(
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
        p.push_str("\n## 用户自定义指令(.bnote/AGENTS.md)\n\n");
        p.push_str(user);
        p.push_str("\n");
    }
    p
}

/// Builds the system prompt for a creation session.
///
/// 与学习 prompt 同样分层,但面向**通用创作**:结构、叙事、忠实于用户素材;
/// HTML 的具体形态(结构/样式/产物路径)不由这份 prompt 规定——那由用户
/// 通过 `/skill-name` 调用的 skill 决定。工具使用规则、/ 与 @ 约定、技能
/// 清单、MCP 说明都在这里给齐,与 `tool_defs()` 注册的工具面严格同步。
pub fn build_creative_prompt(
    vault_name: &str,
    current_note: Option<&str>,
    user_instructions: &str,
    skills: &[SkillInfo],
    mcp_tool_names: &[String],
) -> String {
    let mut p = String::from(
        "You are bnote's creation assistant, embedded in a markdown note-taking \
app. The user curates notes in a vault; you help them create, transform and \
polish content — essays, blog posts, documentation, and HTML pages derived \
from those notes. Answer and write in the user's language.\n\n\
\
## 沟通方式(必须遵守)\n\n\
- 结论先行:第一句先给交付物或结论(写完了什么/改了哪里/还差什么),再给必要的解释。不要复述需求、不要寒暄。\n\
- 简洁:正文默认不超过 200 字;用户要求展开或交付长文时才写长。对话里用 markdown。\n\
- 忠实汇报:工具失败或文件不存在要如实说明;不确定就说不确定并指出验证路径;不编造没读过的文件内容。\n\n\
\
## 创作守则\n\n\
- 内容优先:动笔前先确认受众、结构与要点;用户已给结构时照做,不自作主张换框架。\n\
- 忠于素材:改写与扩写忠于原文事实,不擅自增删用户的主张与数据;引用用户笔记时以文件内容为准。\n\
- 产物落盘:交付的文章/HTML 用 write_file 写进仓库,不要只贴在对话里;写完用 preview_html 推到中栏预览(仅 HTML)。\n\
- HTML 的结构、样式与产物路径由用户调用的 skill 决定;本提示词不规定 HTML 的具体形态。没有合适 skill 时先问用户要,或按用户明说的要求来。\n\n\
\
## 工具\n\n\
- 优先用专用工具,不用 bash 替代:读文件用 read_file,整篇写用 write_file,局部改用 edit_file;bash 留给确实需要 shell 的场景。\n\
- 动任何文件前先 read_file;多个相互独立的调用放在同一轮并行发出。\n\
- preview_html 预览 vault 内的 HTML 文件:先 write_file 保存,再 preview_html 指向该文件。预览是交付的一部分,改完必须刷新预览。\n\
- 用户消息里的两个约定:\n  - `/skill-name`:用户选择了这个技能,先调用 skill 工具加载它,再严格按其指导行动;列出的技能之外不要猜名字。\n  - `@path/to/file`:用户引用了仓库里的文件,用 read_file 读取它。\n\
- `mcp__<服务器>__<工具>` 形式的工具来自 MCP 服务器,调用方式与内置工具相同。\n\n",
    );
    if skills.is_empty() {
        p.push_str("## 可用技能\n\n(仓库暂无技能;用户提到 /技能名 时如实告知没有找到。)\n\n");
    } else {
        p.push_str("## 可用技能\n\n用户可以用 /技能名 调用,你也可以按描述主动匹配:\n\n");
        for s in skills {
            let desc = s.description.trim();
            p.push_str(&format!("- {}: {}\n", s.name, if desc.is_empty() { "(无描述)" } else { desc }));
        }
        p.push('\n');
    }
    if mcp_tool_names.is_empty() {
        p.push_str("## MCP\n\n(未连接 MCP 服务器。)\n\n");
    } else {
        p.push_str("## MCP\n\n已连接工具:\n\n");
        for name in mcp_tool_names {
            p.push_str(&format!("- {name}\n"));
        }
        p.push('\n');
    }
    p.push_str(&format!("- Vault: {vault_name}\n"));
    if let Some(note) = current_note {
        p.push_str(&format!("- Current note: {note}\n"));
    }
    let user = user_instructions.trim();
    if !user.is_empty() {
        p.push_str("\n## 用户自定义指令(.bnote/AGENTS.md)\n\n");
        p.push_str(user);
        p.push_str("\n");
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_guard_离开作用域一定复位_含_panic_展开() {
        // 历史缺陷:running 只在 send 末尾手动复位,panic 或任务被丢弃
        // (请求挂起)时永远为 true → 之后每次 agent_send 都被拒绝。
        let flag = Arc::new(AtomicBool::new(true));
        {
            let _g = RunningGuard(flag.clone());
        }
        assert!(!flag.load(Ordering::SeqCst));

        flag.store(true, Ordering::SeqCst);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = RunningGuard(flag.clone());
            panic!("模拟会话内部 panic");
        }));
        assert!(result.is_err());
        assert!(
            !flag.load(Ordering::SeqCst),
            "panic 展开时守卫必须复位 running"
        );
    }

    #[test]
    fn 固定要求在自定义指令之前_且自定义指令为空时不出现该节() {
        let base = build_study_prompt("vault", None, None, "");
        assert!(base.contains("结论先行"));
        assert!(!base.contains(".bnote/AGENTS.md"));

        let with_user = build_study_prompt("vault", None, None, "  多用表格回答。 \n");
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
        let p = build_study_prompt("vault", Some("notes/a.md"), Some(&study), "");
        assert!(!p.contains("tool"), "不得引导调用工具:\n{}", p);
        assert!(!p.contains("read_study_content"));
        assert!(!p.contains("skill"));
        assert!(!p.contains("mcp__"));
        assert!(!p.contains("MCP"));
    }

    #[test]
    fn 创作提示词_约定技能与指令节齐全_空列表也有兜底() {
        let p = build_creative_prompt("vault", Some("notes/a.md"), "", &[], &[]);
        // / 与 @ 约定必须在场:前端补全只负责插入文本,语义全靠提示词解释。
        assert!(p.contains("/skill-name"));
        assert!(p.contains("@path/to/file"));
        assert!(p.contains("preview_html"));
        assert!(!p.contains("## 用户自定义指令(.bnote/AGENTS.md)"), "空指令不出现该节");
        assert!(p.contains("仓库暂无技能"));
        assert!(p.contains("未连接 MCP 服务器"));

        let skills = vec![SkillInfo {
            name: "html-blog".into(),
            description: "把 markdown 排版成博客 HTML".into(),
            path: "/x/SKILL.md".into(),
        }];
        let p = build_creative_prompt(
            "vault",
            None,
            "多用表格",
            &skills,
            &["mcp__volcano__shell".to_string()],
        );
        assert!(p.contains("- html-blog: 把 markdown 排版成博客 HTML"));
        assert!(p.contains("- mcp__volcano__shell"));
        let custom = p.find("多用表格").unwrap();
        let tools = p.find("## 工具").unwrap();
        assert!(tools < custom, "用户指令应在工具规则之后追加");
    }
}
