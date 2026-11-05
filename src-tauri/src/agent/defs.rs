//! Built-in agent definitions.
//!
//! The definition (model policy, tool whitelist, prompt layers) is **code**:
//! the prompt markdown files under `resources/agents/` are compiled into the
//! binary with `include_str!`, so the running app never reads them from disk
//! and the vault's `.bnote` holds nothing but user instructions (`AGENTS.md`).
//!
//! Claude Code splits the same way: its agent definitions are constants in the
//! source, while only the user-editable memory files live on disk.

use std::collections::BTreeMap;

/// Per-tool execution policy, the same three outcomes Claude Code's permission
/// modes have: `allow` runs the tool, `ask` pauses the turn for the panel's
/// approval, `deny` refuses without running anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompactionCfg {
    pub enabled: bool,
    /// Fraction of the model context window at which auto-compact fires
    /// (Claude Code keeps a fixed token buffer; a ratio travels across models).
    pub threshold: f64,
}

impl Default for CompactionCfg {
    fn default() -> Self {
        CompactionCfg {
            enabled: true,
            threshold: 0.0,
        }
    }
}

/// An agent definition. `tools` is a whitelist of code-registered tool names
/// plus the pseudo-entry `mcp` (all MCP tools).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentDefinition {
    /// Stable id: the definition's name in `registry()`.
    pub id: String,
    pub name: String,
    pub description: String,
    /// Tool whitelist. `None` (key absent) = the general default set
    /// ([`DEFAULT_TOOLS`]); an **empty list is a deliberate "no tools"**
    /// (the study shape) — that distinction is the whole point of Option.
    pub tools: Option<Vec<String>>,
    pub permissions: BTreeMap<String, Permission>,
    pub compaction: CompactionCfg,
    /// Subagent definition ids the `task` tool may spawn. Empty = all
    /// definitions are allowed.
    pub subagents: Vec<String>,
    /// Ordered prompt layers, compiled into the binary.
    pub prompts: Vec<&'static str>,
    pub model: String,
    pub max_tokens: u32,
    /// Cap on tool-call rounds per turn; 0 = the session default (25).
    pub max_turns: u32,
}

/// Toolset for definitions that leave `tools` absent: the general coding
/// surface without the study/creative-only entries.
pub const DEFAULT_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "glob",
    "grep",
    "bash",
    "bash_output",
    "bash_kill",
    "todo",
    "task_create",
    "task_update",
    "task_list",
    "task_get",
    "ask_user_question",
    "skill",
];

impl AgentDefinition {
    /// The tool whitelist this session runs with (key absent → default set),
    /// with `deny` permissions applied last so they win over the whitelist.
    pub fn effective_tools(&self) -> Vec<String> {
        let base: Vec<String> = match &self.tools {
            Some(list) => list.clone(),
            None => DEFAULT_TOOLS.iter().map(|s| s.to_string()).collect(),
        };
        base.into_iter()
            .filter(|t| self.permissions.get(t) != Some(&Permission::Deny))
            .collect()
    }

    pub fn tool_enabled(&self, name: &str) -> bool {
        if self.permissions.get(name) == Some(&Permission::Deny) {
            return false;
        }
        self.effective_tools().iter().any(|t| t == name)
    }

    pub fn mcp_enabled(&self) -> bool {
        self.tool_enabled("mcp")
    }

    pub fn display_name(&self) -> &str {
        if self.name.trim().is_empty() {
            &self.id
        } else {
            self.name.trim()
        }
    }
}

fn tools(list: &[&str]) -> Option<Vec<String>> {
    Some(list.iter().map(|s| s.to_string()).collect())
}

/// The coding agent's prompt layers, in system-prompt order (the same sections
/// Claude Code's `getSystemPrompt` assembles).
fn coding_prompts() -> Vec<&'static str> {
    vec![
        include_str!("../../resources/agents/coding/SYSTEM_PROMPT.md"),
        include_str!("../../resources/agents/coding/SYSTEM.md"),
        include_str!("../../resources/agents/coding/DOING_TASKS.md"),
        include_str!("../../resources/agents/coding/EXECUTING_ACTIONS_WITH_CARE.md"),
        include_str!("../../resources/agents/coding/USING_YOUR_TOOLS.md"),
        include_str!("../../resources/agents/coding/TONE_AND_STYLE.md"),
        include_str!("../../resources/agents/coding/OUTPUT_EFFICIENCY.md"),
        include_str!("../../resources/agents/coding/SESSION_GUIDANCE.md"),
    ]
}

/// The registry: every definition the app can start. Ids are stable because
/// the frontend names the mode by them.
pub fn registry() -> Vec<AgentDefinition> {
    vec![
        AgentDefinition {
            id: "coding".into(),
            name: "编码助手".into(),
            description: "代码项目的 coding agent:bash/glob/grep/todo/task/压缩全套能力。".into(),
            tools: tools(&[
                "read_file",
                "write_file",
                "edit_file",
                "list_files",
                "glob",
                "grep",
                "bash",
                "todo",
                "task",
                "skill",
                "mcp",
                "bash_output",
                "bash_kill",
                "task_create",
                "task_update",
                "task_list",
                "task_get",
                "ask_user_question",
                "send_message",
                "EnterPlanMode",
                "ExitPlanMode",
            ]),
            permissions: BTreeMap::new(),
            compaction: CompactionCfg::default(),
            subagents: Vec::new(),
            prompts: coding_prompts(),
            model: String::new(),
            max_tokens: 0,
            max_turns: 0,
        },
        AgentDefinition {
            id: "creative".into(),
            name: "创作助手".into(),
            description: "创作模式:工具 + 技能 + MCP,产出文章与 HTML 并实时预览。".into(),
            tools: tools(&[
                "read_file",
                "write_file",
                "edit_file",
                "list_files",
                "read_url",
                "bash",
                "preview_html",
                "read_study_content",
                "skill",
                "mcp",
                "task_create",
                "task_update",
                "task_list",
                "task_get",
                "ask_user_question",
            ]),
            permissions: BTreeMap::new(),
            compaction: CompactionCfg::default(),
            subagents: Vec::new(),
            prompts: vec![include_str!(
                "../../resources/agents/creative/SYSTEM_PROMPT.md"
            )],
            model: String::new(),
            max_tokens: 0,
            max_turns: 0,
        },
        AgentDefinition {
            id: "study".into(),
            name: "学习助手".into(),
            description: "围绕当前 PDF / 网页的纯问答助手,不注册任何工具。".into(),
            // The empty list is deliberate: pure Q&A, no tool surface at all.
            tools: Some(Vec::new()),
            permissions: BTreeMap::new(),
            compaction: CompactionCfg::default(),
            subagents: Vec::new(),
            // The study prompt runs inside the prompt pipeline; with no tools
            // it must stay free of tool guidance.
            prompts: vec![include_str!("../../resources/agents/study/SYSTEM_PROMPT.md")],
            model: String::new(),
            max_tokens: 0,
            max_turns: 0,
        },
        AgentDefinition {
            id: "general-purpose".into(),
            name: "通用助手".into(),
            description: "通用子代理:全工具(除子代理派发),独立上下文,只回报最终结论。".into(),
            tools: tools(&[
                "read_file",
                "write_file",
                "edit_file",
                "list_files",
                "glob",
                "grep",
                "bash",
                "todo",
                "skill",
                "mcp",
                "bash_output",
                "bash_kill",
                "task_create",
                "task_update",
                "task_list",
                "task_get",
                "ask_user_question",
                "send_message",
            ]),
            permissions: BTreeMap::new(),
            compaction: CompactionCfg::default(),
            subagents: Vec::new(),
            prompts: vec![include_str!(
                "../../resources/agents/general-purpose/SYSTEM_PROMPT.md"
            )],
            model: String::new(),
            max_tokens: 0,
            max_turns: 0,
        },
        AgentDefinition {
            id: "explore".into(),
            name: "探索子代理".into(),
            description: "只读探索子代理:找代码、读文件、报告位置与结构,不改动任何东西。".into(),
            tools: tools(&["read_file", "list_files", "glob", "grep"]),
            permissions: BTreeMap::new(),
            compaction: CompactionCfg::default(),
            subagents: Vec::new(),
            prompts: vec![include_str!(
                "../../resources/agents/explore/SYSTEM_PROMPT.md"
            )],
            model: String::new(),
            max_tokens: 0,
            max_turns: 0,
        },
        AgentDefinition {
            id: "plan".into(),
            name: "计划子代理".into(),
            description: "只读计划子代理:调研后给出可执行的实施步骤与关键文件,不改动任何东西。".into(),
            tools: tools(&["read_file", "list_files", "glob", "grep"]),
            permissions: BTreeMap::new(),
            compaction: CompactionCfg::default(),
            subagents: Vec::new(),
            prompts: vec![include_str!("../../resources/agents/plan/SYSTEM_PROMPT.md")],
            model: String::new(),
            max_tokens: 0,
            max_turns: 0,
        },
    ]
}

/// Looks a definition up by id.
pub fn definition(id: &str) -> Option<AgentDefinition> {
    registry().into_iter().find(|d| d.id == id)
}

/// The definitions the `task` tool may spawn, for the tool description.
/// `fork` is virtual (not in the registry) and is described separately.
pub fn subagent_listing() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = registry()
        .into_iter()
        .filter(|d| d.id == "general-purpose" || d.id == "explore" || d.id == "plan")
        .map(|d| (d.id, d.description))
        .collect();
    out.push((
        "fork".into(),
        "Forked worker that inherits the parent conversation".into(),
    ));
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_definition_is_unique_and_has_a_prompt() {
        let defs = registry();
        let mut ids: Vec<&str> = defs.iter().map(|d| d.id.as_str()).collect();
        ids.sort();
        let mut dedup = ids.clone();
        dedup.dedup();
        assert_eq!(ids, dedup, "duplicate definition id");
        for def in &defs {
            assert!(!def.prompts.is_empty(), "{} has no prompt", def.id);
            assert!(
                def.prompts.iter().all(|p| !p.trim().is_empty()),
                "{} has an empty prompt layer",
                def.id
            );
        }
    }

    #[test]
    fn the_study_agent_registers_no_tools() {
        let study = definition("study").unwrap();
        assert_eq!(study.tools, Some(Vec::new()));
        assert!(study.effective_tools().is_empty());
    }

    #[test]
    fn the_coding_agent_has_the_full_surface_and_ordered_layers() {
        let coding = definition("coding").unwrap();
        let tools = coding.effective_tools();
        for name in ["read_file", "edit_file", "bash", "task", "mcp"] {
            assert!(tools.iter().any(|t| t == name), "missing {name}");
        }
        assert_eq!(coding.prompts.len(), 8);
        assert!(coding.prompts[0].contains("coding agent"));
        assert!(coding.prompts.iter().any(|p| p.contains("Executing actions")));
    }

    #[test]
    fn explore_and_plan_are_read_only() {
        for id in ["explore", "plan"] {
            let def = definition(id).unwrap();
            let tools = def.effective_tools();
            assert!(!tools.iter().any(|t| t == "write_file" || t == "edit_file"));
            assert!(!tools.iter().any(|t| t == "bash"));
        }
    }

    #[test]
    fn the_task_listing_names_the_spawnable_agents() {
        let listing = subagent_listing();
        let ids: Vec<&str> = listing.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"general-purpose"));
        assert!(ids.contains(&"explore"));
        assert!(ids.contains(&"fork"));
        assert!(!ids.contains(&"coding"));
    }

    #[test]
    fn a_deny_permission_removes_the_tool_from_the_effective_set() {
        let mut def = definition("coding").unwrap();
        def.permissions
            .insert("bash".into(), Permission::Deny);
        assert!(!def.tool_enabled("bash"));
        assert!(!def.effective_tools().iter().any(|t| t == "bash"));
    }
}
