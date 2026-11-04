//! Agent definitions loaded from the vault, following Claude Code's split:
//! the definition (model, tool names, prompt files) is data on disk, while the
//! tools themselves stay registered in Rust and are referenced by name.
//!
//! Layout: `<vault>/.bnote/agents/<id>/agent.json` plus the markdown prompt
//! files it lists. `SYSTEM_PROMPT.md` is required; every other `*.md` file is a
//! prompt layer whose position is chosen by `order` in `agent.json`.
//!
//! Prompt files are re-read before every turn (see `prompt.rs`), so editing
//! them takes effect on the next message without reopening the session. The
//! loader validates tool names against the code registry: a typo is a config
//! error surfaced in the UI, never a silently missing capability.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Per-tool execution policy. `deny` removes the tool from the session's tool
/// list (and from the prompt's tool rules); `allow` is the default and only
/// exists so a hand-written file can be explicit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CompactionCfg {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Fraction of the model context window at which auto-compact fires
    /// (Claude Code keeps a fixed token buffer; a ratio travels across models).
    #[serde(default = "default_threshold")]
    pub threshold: f64,
}

impl Default for CompactionCfg {
    fn default() -> Self {
        CompactionCfg {
            enabled: true,
            threshold: default_threshold(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_threshold() -> f64 {
    0.85
}

/// One markdown prompt file inside the agent's directory.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PromptFile {
    /// File name only — no directories, uppercase stem, `.md` suffix.
    pub file: String,
    /// Sort key in the assembled system prompt; ties keep insertion order.
    #[serde(default = "default_prompt_order")]
    pub order: i32,
}

fn default_prompt_order() -> i32 {
    50
}

/// The system prompt file every agent must list.
pub const SYSTEM_PROMPT: &str = "SYSTEM_PROMPT.md";

/// The definition file inside every agent directory.
pub const AGENT_FILE: &str = "agent.json";

/// An agent definition. `tools` is a whitelist of code-registered tool names
/// plus the pseudo-entry `mcp` (all MCP tools).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AgentDefinition {
    /// Stable id: the directory name. The loader assigns it, never the file.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Tool whitelist. `None` (key absent) = the general default set
    /// ([`DEFAULT_TOOLS`]); an **empty list is a deliberate "no tools"**
    /// (the study shape) — that distinction is the whole point of Option.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub permissions: BTreeMap<String, Permission>,
    #[serde(default)]
    pub compaction: CompactionCfg,
    /// Subagent definition ids the `task` tool may spawn. Empty = all
    /// definitions are allowed.
    #[serde(default)]
    pub subagents: Vec<String>,
    /// Ordered prompt files, resolved inside the agent directory.
    #[serde(default)]
    pub prompts: Vec<PromptFile>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub max_tokens: u32,
    /// Cap on tool-call rounds per turn; 0 = the session default (25).
    #[serde(default)]
    pub max_turns: u32,
    /// Absolute directory the prompt files are read from. Runtime state, set
    /// by the loader; the JSON on disk never carries it.
    #[serde(skip)]
    pub dir: Option<PathBuf>,
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
    "todo",
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

/// A definition that could not be loaded; surfaced at session start instead of
/// being dropped silently.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DefError {
    pub id: String,
    pub message: String,
}

pub fn agents_dir(vault: &Path) -> PathBuf {
    vault.join(".bnote").join("agents")
}

/// The first-run agents, embedded from `src-tauri/resources/agents/`. They are
/// ordinary files on disk after seeding; the app never reads these strings
/// again, so editing the vault's copy is the only source of truth.
const SEED_FILES: &[(&str, &str)] = &[
    (
        "coding/agent.json",
        include_str!("../../resources/agents/coding/agent.json"),
    ),
    (
        "coding/SYSTEM_PROMPT.md",
        include_str!("../../resources/agents/coding/SYSTEM_PROMPT.md"),
    ),
    (
        "creative/agent.json",
        include_str!("../../resources/agents/creative/agent.json"),
    ),
    (
        "creative/SYSTEM_PROMPT.md",
        include_str!("../../resources/agents/creative/SYSTEM_PROMPT.md"),
    ),
    (
        "study/agent.json",
        include_str!("../../resources/agents/study/agent.json"),
    ),
    (
        "study/SYSTEM_PROMPT.md",
        include_str!("../../resources/agents/study/SYSTEM_PROMPT.md"),
    ),
    (
        "explore/agent.json",
        include_str!("../../resources/agents/explore/agent.json"),
    ),
    (
        "explore/SYSTEM_PROMPT.md",
        include_str!("../../resources/agents/explore/SYSTEM_PROMPT.md"),
    ),
];

/// Writes the default agents when the directory holds no agent at all.
///
/// Only an empty (or missing) directory is seeded: deleting one agent does not
/// resurrect it on the next launch, and a directory with legacy `<id>.md`
/// files still gets the new defaults.
pub fn seed_agents(vault: &Path) -> Result<(), String> {
    let dir = agents_dir(vault);
    let has_agent_dir = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .any(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        })
        .unwrap_or(false);
    if has_agent_dir {
        return Ok(());
    }
    for (relative, content) in SEED_FILES {
        let target = dir.join(relative);
        let parent = target
            .parent()
            .ok_or_else(|| format!("INVALID_SEED_PATH: {}", relative))?;
        std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        std::fs::write(&target, content).map_err(|e| format!("WRITE_FAILED: {}", e))?;
    }
    Ok(())
}

/// Loads every `<vault>/.bnote/agents/<id>/agent.json`.
pub fn load_definitions(vault: Option<&Path>) -> (Vec<AgentDefinition>, Vec<DefError>) {
    let mut defs = Vec::new();
    let mut errors = Vec::new();
    let Some(vault) = vault else {
        return (defs, errors);
    };
    let dir = agents_dir(vault);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return (defs, errors);
    };
    let mut entries: Vec<(String, PathBuf, bool)> = rd
        .flatten()
        .map(|entry| {
            let path = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (
                entry.file_name().to_string_lossy().to_string(),
                path,
                is_dir,
            )
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, path, is_dir) in entries {
        if !is_dir {
            // The previous single-file format is no longer loaded; naming it
            // keeps a silent disappearance out of the migration.
            if name.to_lowercase().ends_with(".md") {
                errors.push(DefError {
                    id: name.trim_end_matches(".md").to_string(),
                    message: "旧格式定义已不再加载:改为 <id>/agent.json + SYSTEM_PROMPT.md".into(),
                });
            }
            continue;
        }
        if let Err(message) = valid_def_id(&name) {
            errors.push(DefError { id: name, message });
            continue;
        }
        match load_definition(&path, &name) {
            Ok(def) => defs.push(def),
            Err(message) => errors.push(DefError { id: name, message }),
        }
    }
    (defs, errors)
}

/// Directory names double as ids and as path segments: the safe subset is
/// enforced before any join.
fn valid_def_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err("目录名只能包含字母/数字/-/_,且不超过 64 字符".into())
    }
}

fn valid_prompt_file(name: &str) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(format!("prompt 文件名不能包含路径分隔符: {}", name));
    }
    let stem = name
        .strip_suffix(".md")
        .ok_or_else(|| format!("prompt 文件必须是 .md: {}", name))?;
    let upper = !stem.is_empty()
        && stem
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if !upper {
        return Err(format!(
            "prompt 文件名必须是大写字母/数字/下划线: {}",
            name
        ));
    }
    Ok(())
}

/// A tool name is valid only when the Rust registry can execute it. This is
/// the boundary the file format must not cross: agent.json references tools,
/// it never defines them.
fn known_tool(name: &str) -> bool {
    name == "mcp"
        || crate::agent::tools::tool_schemas()
            .iter()
            .any(|(registered, _, _)| *registered == name)
}

fn load_definition(dir: &Path, id: &str) -> Result<AgentDefinition, String> {
    let config_path = dir.join(AGENT_FILE);
    let config = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取 {} 失败: {}", AGENT_FILE, e))?;
    let mut def: AgentDefinition = serde_json::from_str(&config)
        .map_err(|e| format!("{} 解析失败: {}", AGENT_FILE, e))?;
    def.id = id.to_string();
    if def.name.trim().is_empty() {
        def.name = id.to_string();
    }
    def.dir = Some(dir.to_path_buf());
    validate_prompts(&def, dir)?;
    validate_tools(&def)?;
    Ok(def)
}

fn validate_prompts(def: &AgentDefinition, dir: &Path) -> Result<(), String> {
    if def.prompts.is_empty() {
        return Err(format!(
            "agent.json 缺少 prompts(至少包含 {})",
            SYSTEM_PROMPT
        ));
    }
    let mut seen = BTreeSet::new();
    for prompt in &def.prompts {
        valid_prompt_file(&prompt.file)?;
        if !seen.insert(prompt.file.clone()) {
            return Err(format!("prompt 重复: {}", prompt.file));
        }
        if !dir.join(&prompt.file).is_file() {
            return Err(format!("prompt 文件不存在: {}", prompt.file));
        }
    }
    if !seen.contains(SYSTEM_PROMPT) {
        return Err(format!("prompts 必须包含 {}", SYSTEM_PROMPT));
    }
    Ok(())
}

fn validate_tools(def: &AgentDefinition) -> Result<(), String> {
    let Some(tools) = &def.tools else {
        return Ok(());
    };
    let mut seen = BTreeSet::new();
    for tool in tools {
        if !known_tool(tool) {
            return Err(format!(
                "未知工具: {} (工具由代码注册,agent.json 只能引用)",
                tool
            ));
        }
        if !seen.insert(tool.as_str()) {
            return Err(format!("工具重复: {}", tool));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "bnote-defs-{}-{}-{}",
            tag,
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_agent(root: &Path, id: &str, config: &str, prompts: &[(&str, &str)]) {
        let dir = root.join(".bnote").join("agents").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(AGENT_FILE), config).unwrap();
        for (name, content) in prompts {
            std::fs::write(dir.join(name), content).unwrap();
        }
    }

    #[test]
    fn loads_an_agent_directory_and_keeps_prompt_order() {
        let vault = temp_dir("load");
        write_agent(
            &vault,
            "reviewer",
            r#"{
                "name": "评审员",
                "description": "代码评审",
                "model": "gpt-5",
                "max_tokens": 4096,
                "max_turns": 12,
                "tools": ["read_file", "grep", "mcp"],
                "permissions": { "bash": "deny" },
                "subagents": ["explore"],
                "prompts": [
                    { "file": "STYLE.md", "order": 70 },
                    { "file": "SYSTEM_PROMPT.md", "order": 10 }
                ]
            }"#,
            &[(SYSTEM_PROMPT, "正文提示词。"), ("STYLE.md", "风格。")],
        );
        let (defs, errors) = load_definitions(Some(&vault));
        assert!(errors.is_empty(), "{:?}", errors);
        assert_eq!(defs.len(), 1);
        let def = &defs[0];
        assert_eq!(def.id, "reviewer");
        assert_eq!(def.name, "评审员");
        assert_eq!(def.model, "gpt-5");
        assert_eq!(def.max_tokens, 4096);
        assert_eq!(def.max_turns, 12);
        assert_eq!(
            def.tools,
            Some(vec!["read_file".into(), "grep".into(), "mcp".into()])
        );
        assert_eq!(def.permissions.get("bash"), Some(&Permission::Deny));
        assert_eq!(def.prompts.len(), 2);
        assert_eq!(def.prompts[0].file, "STYLE.md");
        assert_eq!(
            def.dir.as_deref(),
            Some(vault.join(".bnote/agents/reviewer").as_path())
        );
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn an_empty_tool_list_stays_explicit() {
        let vault = temp_dir("tools");
        write_agent(
            &vault,
            "study",
            r#"{"name":"学习","tools":[],"prompts":[{"file":"SYSTEM_PROMPT.md","order":10}]}"#,
            &[(SYSTEM_PROMPT, "问答。")],
        );
        let (defs, errors) = load_definitions(Some(&vault));
        assert!(errors.is_empty(), "{:?}", errors);
        assert_eq!(defs[0].tools, Some(Vec::new()));
        assert!(defs[0].effective_tools().is_empty());
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn missing_system_prompt_is_a_config_error() {
        let vault = temp_dir("no-system");
        write_agent(
            &vault,
            "broken",
            r#"{"prompts":[{"file":"STYLE.md","order":10}]}"#,
            &[("STYLE.md", "x")],
        );
        let (defs, errors) = load_definitions(Some(&vault));
        assert!(defs.is_empty());
        assert!(
            errors[0].message.contains("SYSTEM_PROMPT.md"),
            "{:?}",
            errors
        );
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn unknown_tools_and_escaping_prompt_paths_are_rejected() {
        let vault = temp_dir("invalid");
        write_agent(
            &vault,
            "bad-tool",
            r#"{"tools":["nope"],"prompts":[{"file":"SYSTEM_PROMPT.md","order":10}]}"#,
            &[(SYSTEM_PROMPT, "x")],
        );
        write_agent(
            &vault,
            "bad-path",
            r#"{"prompts":[{"file":"../SYSTEM_PROMPT.md","order":10}]}"#,
            &[(SYSTEM_PROMPT, "x")],
        );
        write_agent(
            &vault,
            "lowercase",
            r#"{"prompts":[{"file":"System.md","order":10},{"file":"SYSTEM_PROMPT.md","order":20}]}"#,
            &[("System.md", "x"), (SYSTEM_PROMPT, "x")],
        );
        let (defs, errors) = load_definitions(Some(&vault));
        assert!(defs.is_empty());
        assert_eq!(errors.len(), 3, "{:?}", errors);
        assert!(errors.iter().any(|e| e.message.contains("未知工具")));
        assert!(errors.iter().any(|e| e.message.contains("路径分隔符")));
        assert!(errors.iter().any(|e| e.message.contains("大写字母")));
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn legacy_markdown_definitions_are_reported_not_loaded() {
        let vault = temp_dir("legacy");
        let dir = vault.join(".bnote").join("agents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("reviewer.md"), "---\nname: x\n---\n").unwrap();
        let (defs, errors) = load_definitions(Some(&vault));
        assert!(defs.is_empty());
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("旧格式"));
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn seeding_writes_the_four_agents_and_never_overwrites_edits() {
        let vault = temp_dir("seed");
        seed_agents(&vault).unwrap();
        let dir = agents_dir(&vault);
        for id in ["coding", "creative", "study", "explore"] {
            assert!(dir.join(id).join(AGENT_FILE).is_file(), "{}", id);
            assert!(dir.join(id).join(SYSTEM_PROMPT).is_file(), "{}", id);
        }
        let (defs, errors) = load_definitions(Some(&vault));
        assert!(errors.is_empty(), "{:?}", errors);
        assert_eq!(defs.len(), 4);
        assert_eq!(
            defs.iter().find(|d| d.id == "study").unwrap().tools,
            Some(Vec::new())
        );

        let coding = dir.join("coding").join(AGENT_FILE);
        std::fs::write(
            &coding,
            r#"{"name":"改过的","tools":[],"prompts":[{"file":"SYSTEM_PROMPT.md","order":10}]}"#,
        )
        .unwrap();
        seed_agents(&vault).unwrap();
        let text = std::fs::read_to_string(&coding).unwrap();
        assert!(text.contains("改过的"), "seeding must not overwrite edits");
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn invalid_directory_ids_are_skipped() {
        let vault = temp_dir("id");
        write_agent(
            &vault,
            "bad id",
            r#"{"prompts":[{"file":"SYSTEM_PROMPT.md","order":10}]}"#,
            &[(SYSTEM_PROMPT, "x")],
        );
        let (defs, errors) = load_definitions(Some(&vault));
        assert!(defs.is_empty());
        assert!(errors[0].message.contains("目录名"));
        std::fs::remove_dir_all(&vault).unwrap();
    }
}
