//! Agent definitions: the unit of prompt assembly and capability configuration.
//!
//! A definition is one markdown file with a YAML-subset frontmatter (name,
//! tools, permissions, compaction, prompt layers) and the prompt body as the
//! markdown text below it. Three built-in definitions (study / creative /
//! coding) live in code; user definitions live in `<vault>/.bnote/agents/*.md`
//! and may override a built-in by using its id.
//!
//! The frontmatter parser accepts a strict YAML subset (flat maps, block and
//! flow lists, one level of nesting). A full YAML implementation is out of
//! scope on purpose: the writer (`serialize`) and the reader below are both
//! ours, so the settings page round-trips losslessly, and a hand-edited file
//! outside the subset fails with the offending line number instead of
//! mis-parsing silently.

use std::collections::BTreeMap;
use std::path::Path;

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

/// One extra prompt layer loaded from a file relative to the working directory
/// (the code project root for coding sessions, the vault otherwise).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PromptLayer {
    pub file: String,
    /// Sort key in the assembled system prompt; ties keep insertion order.
    #[serde(default = "default_layer_order")]
    pub order: i32,
}

fn default_layer_order() -> i32 {
    50
}

/// An agent definition. `tools` is a whitelist of built-in tool names plus the
/// pseudo-entries `mcp` (all MCP tools).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AgentDefinition {
    /// Stable id: the file stem, or the built-in id ("study" / "creative" /
    /// "coding"). The frontmatter never carries it — the loader assigns it —
    /// so deserialization must default it.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Markdown body below the frontmatter: the system prompt's identity and
    /// rules section (segment order 10).
    #[serde(default)]
    pub body: String,
    /// Tool whitelist. `None` (key absent in the file) = the general default
    /// set ([`DEFAULT_TOOLS`]); an **empty list is a deliberate "no tools"**
    /// (the study shape) — that distinction is the whole point of Option.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub permissions: BTreeMap<String, Permission>,
    #[serde(default)]
    pub compaction: CompactionCfg,
    /// Subagent definition ids the `task` tool may spawn. Empty = all
    /// definitions (built-ins and user files) are allowed.
    #[serde(default)]
    pub subagents: Vec<String>,
    #[serde(default)]
    pub prompt_layers: Vec<PromptLayer>,
    /// Model overrides; empty/0 = the global agent.json values.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub max_tokens: u32,
    /// Cap on tool-call rounds per turn; 0 = the session default (25).
    #[serde(default)]
    pub max_turns: u32,
}

/// Toolset for user definitions that leave `tools` empty: the general coding
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
        let tools = self.effective_tools();
        tools.iter().any(|t| t == name)
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

/// A definition file that failed to parse; surfaced in the settings page and
/// as a warning at session start instead of being dropped silently.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DefError {
    pub id: String,
    pub message: String,
}

/// Loads the built-in definitions plus every `<vault>/.bnote/agents/*.md`.
/// A user file whose id matches a built-in replaces it (the file is the
/// definition — no hidden merge).
pub fn load_definitions(vault: Option<&Path>) -> (Vec<AgentDefinition>, Vec<DefError>) {
    let mut defs = builtins();
    let mut errors = Vec::new();
    let Some(vault) = vault else {
        return (defs, errors);
    };
    let dir = vault.join(".bnote").join("agents");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return (defs, errors);
    };
    let mut files: Vec<std::path::PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "md").unwrap_or(false))
        .collect();
    files.sort();
    for path in files {
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                errors.push(DefError {
                    id,
                    message: format!("读取失败: {}", e),
                });
                continue;
            }
        };
        match parse_definition(&id, &content) {
            Ok(def) => {
                if let Some(slot) = defs.iter_mut().find(|d| d.id == id) {
                    *slot = def;
                } else {
                    defs.push(def);
                }
            }
            Err(e) => errors.push(DefError { id, message: e }),
        }
    }
    (defs, errors)
}

/// Parses one definition file: frontmatter (optional) + markdown body.
pub fn parse_definition(id: &str, content: &str) -> Result<AgentDefinition, String> {
    let content = content.replace("\r\n", "\n");
    let (meta, body) = split_frontmatter(&content)?;
    let mut def: AgentDefinition = if let Some(meta) = meta {
        let value =
            parse_yaml_subset(&meta).map_err(|e| format!("frontmatter 第{}行: {}", e.0, e.1))?;
        serde_json::from_value(value).map_err(|e| format!("frontmatter 字段无效: {}", e))?
    } else {
        serde_json::from_value(serde_json::json!({})).unwrap_or_default()
    };
    def.id = id.to_string();
    if def.name.trim().is_empty() {
        def.name = id.to_string();
    }
    def.body = body.trim().to_string();
    Ok(def)
}

/// Splits `---` fenced frontmatter off the body. A file without frontmatter is
/// a valid definition (id + body only).
fn split_frontmatter(content: &str) -> Result<(Option<String>, String), String> {
    let trimmed = content.trim_start_matches('\n');
    if !trimmed.starts_with("---") {
        return Ok((None, trimmed.to_string()));
    }
    let after_open = &trimmed[3..];
    // The opening fence must end the line.
    if !after_open.starts_with('\n') {
        return Ok((None, trimmed.to_string()));
    }
    let Some(close_rel) = after_open.find("\n---") else {
        return Err("frontmatter 没有闭合的 ---".to_string());
    };
    let meta = after_open[..close_rel].to_string();
    let rest = &after_open[close_rel + 4..];
    // The rest begins with the newline that terminates the closing fence; the
    // body itself (including any leading "-" list lines) is kept untouched.
    let body = rest.strip_prefix('\n').unwrap_or(rest);
    Ok((Some(meta), body.to_string()))
}

// ---------------------------------------------------------------------------
// YAML subset parser
// ---------------------------------------------------------------------------

type ParseError = (usize, String);

/// Parses the supported subset into JSON: top-level map; values are scalars
/// (string/bool/number), block lists (`- item`, `- key: v` maps), nested maps
/// (one level), or inline flow lists `["a", "b"]`. Anything else is an error
/// naming the line.
fn parse_yaml_subset(input: &str) -> Result<serde_json::Value, ParseError> {
    let mut lines: Vec<(usize, usize, &str)> = Vec::new(); // (line_no, indent, text)
    for (i, raw) in input.lines().enumerate() {
        let line = strip_comment(raw);
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        lines.push((i + 1, indent, line.trim_start()));
    }
    let mut pos = 0usize;
    let value = parse_map(&lines, &mut pos, 0)?;
    if pos < lines.len() {
        return Err((lines[pos].0, "缩进不属于任何上层键".to_string()));
    }
    Ok(value)
}

/// Removes comments: whole-line `#…`, and a trailing ` #…` outside quotes.
fn strip_comment(line: &str) -> &str {
    let t = line.trim_start();
    if t.starts_with('#') {
        return "";
    }
    let bytes = line.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    for i in 0..bytes.len() {
        match bytes[i] {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b'#' if !in_single && !in_double && i > 0 && (bytes[i - 1] as char).is_whitespace() => {
                return &line[..i];
            }
            _ => {}
        }
    }
    line
}

fn parse_map(
    lines: &[(usize, usize, &str)],
    pos: &mut usize,
    indent: usize,
) -> Result<serde_json::Value, ParseError> {
    let mut map = serde_json::Map::new();
    while *pos < lines.len() {
        let (line_no, line_indent, text) = lines[*pos];
        if line_indent < indent {
            break;
        }
        if line_indent > indent {
            return Err((line_no, "意外的缩进".to_string()));
        }
        let Some((key, rest)) = split_key(text) else {
            return Err((line_no, format!("无法解析的键值行: {}", text)));
        };
        *pos += 1;
        if rest.is_empty() {
            // Block value: a nested map or list at a deeper indent.
            if *pos < lines.len() && lines[*pos].1 > indent {
                let child_indent = lines[*pos].1;
                if lines[*pos].2.starts_with("- ") || lines[*pos].2 == "-" {
                    let list = parse_list(lines, pos, child_indent)?;
                    map.insert(key, list);
                } else {
                    let nested = parse_map(lines, pos, child_indent)?;
                    map.insert(key, nested);
                }
            } else {
                map.insert(key, serde_json::Value::Null);
            }
        } else if rest.starts_with('[') {
            let list = parse_flow_list(rest).map_err(|e| (line_no, e))?;
            map.insert(key, list);
        } else {
            map.insert(key, parse_scalar(rest));
        }
    }
    Ok(serde_json::Value::Object(map))
}

fn parse_list(
    lines: &[(usize, usize, &str)],
    pos: &mut usize,
    indent: usize,
) -> Result<serde_json::Value, ParseError> {
    let mut items = Vec::new();
    while *pos < lines.len() && lines[*pos].1 == indent {
        let (line_no, _, text) = lines[*pos];
        let item_text = text.strip_prefix('-').unwrap_or(text).trim();
        if text != "-" && !text.starts_with("- ") {
            return Err((line_no, format!("列表项应以 - 开头: {}", text)));
        }
        *pos += 1;
        if item_text.is_empty() {
            // Bare "-" with the item content on following lines: not supported.
            return Err((line_no, "空列表项".to_string()));
        }
        if let Some((key, rest)) = split_key(item_text) {
            // Map item: `- key: v` plus sibling keys indented two more spaces.
            let mut item = serde_json::Map::new();
            if rest.is_empty() {
                if *pos < lines.len() && lines[*pos].1 > indent {
                    let nested = parse_map(lines, pos, lines[*pos].1)?;
                    if let serde_json::Value::Object(o) = nested {
                        for (k, v) in o {
                            item.insert(k, v);
                        }
                    }
                } else {
                    item.insert(key, serde_json::Value::Null);
                }
            } else {
                item.insert(key, parse_scalar(rest));
            }
            while *pos < lines.len() && lines[*pos].1 == indent + 2 {
                let (line_no2, _, text2) = lines[*pos];
                let Some((k2, rest2)) = split_key(text2) else {
                    return Err((line_no2, format!("无法解析的键值行: {}", text2)));
                };
                *pos += 1;
                item.insert(
                    k2,
                    if rest2.is_empty() {
                        serde_json::Value::Null
                    } else {
                        parse_scalar(rest2)
                    },
                );
            }
            items.push(serde_json::Value::Object(item));
        } else {
            items.push(parse_scalar(item_text));
        }
    }
    Ok(serde_json::Value::Array(items))
}

fn parse_flow_list(text: &str) -> Result<serde_json::Value, String> {
    let inner = text
        .strip_prefix('[')
        .and_then(|t| t.strip_suffix(']'))
        .ok_or_else(|| format!("无法解析的列表: {}", text))?;
    let mut items = Vec::new();
    if inner.trim().is_empty() {
        return Ok(serde_json::Value::Array(items));
    }
    for part in inner.split(',') {
        items.push(parse_scalar(part.trim()));
    }
    Ok(serde_json::Value::Array(items))
}

/// Splits `key: value` / `key:`; the key is the text before the first `:` that
/// ends the line or is followed by a space.
fn split_key(text: &str) -> Option<(String, &str)> {
    let bytes = text.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b':' && (i + 1 == bytes.len() || bytes[i + 1] == b' ') {
            let key = text[..i].trim().to_string();
            if key.is_empty() {
                return None;
            }
            let rest = text[i + 1..].trim();
            return Some((key, rest));
        }
    }
    None
}

fn parse_scalar(text: &str) -> serde_json::Value {
    let t = text.trim();
    if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
    {
        return serde_json::Value::String(t[1..t.len() - 1].to_string());
    }
    if t == "true" {
        return serde_json::Value::Bool(true);
    }
    if t == "false" {
        return serde_json::Value::Bool(false);
    }
    if t == "null" || t == "~" {
        return serde_json::Value::Null;
    }
    if let Ok(n) = t.parse::<i64>() {
        return serde_json::Value::Number(n.into());
    }
    if let Ok(f) = t.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(f) {
            return serde_json::Value::Number(n);
        }
    }
    serde_json::Value::String(t.to_string())
}

// ---------------------------------------------------------------------------
// Canonical serializer (the settings page writes through this, so everything
// it produces is guaranteed to parse)
// ---------------------------------------------------------------------------

fn yaml_str(s: &str) -> String {
    let needs_quotes = s.is_empty()
        || s.starts_with([
            '"', '\'', '[', ']', '{', '#', '-', '&', '*', '?', '|', '>', '%', '@', '`',
        ])
        || s.contains(": ")
        || s.ends_with(':')
        || s.contains('#')
        || s.trim() != s
        || s.parse::<i64>().is_ok()
        || s.parse::<f64>().is_ok()
        || s == "true"
        || s == "false";
    if needs_quotes {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

fn yaml_flow_list(items: &[String]) -> String {
    let inner: Vec<String> = items.iter().map(|s| yaml_str(s)).collect();
    format!("[{}]", inner.join(", "))
}

/// Renders a definition back to its canonical file form.
pub fn serialize_definition(def: &AgentDefinition) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", yaml_str(def.display_name())));
    out.push_str(&format!("description: {}\n", yaml_str(&def.description)));
    if !def.model.is_empty() {
        out.push_str(&format!("model: {}\n", yaml_str(&def.model)));
    }
    if def.max_tokens > 0 {
        out.push_str(&format!("max_tokens: {}\n", def.max_tokens));
    }
    if def.max_turns > 0 {
        out.push_str(&format!("max_turns: {}\n", def.max_turns));
    }
    if let Some(list) = &def.tools {
        out.push_str(&format!("tools: {}\n", yaml_flow_list(list)));
    }
    if !def.permissions.is_empty() {
        out.push_str("permissions:\n");
        for (tool, perm) in &def.permissions {
            let word = match perm {
                Permission::Allow => "allow",
                Permission::Deny => "deny",
            };
            out.push_str(&format!("  {}: {}\n", tool, word));
        }
    }
    out.push_str(&format!(
        "compaction:\n  enabled: {}\n  threshold: {}\n",
        def.compaction.enabled, def.compaction.threshold
    ));
    if !def.subagents.is_empty() {
        out.push_str(&format!("subagents: {}\n", yaml_flow_list(&def.subagents)));
    }
    if !def.prompt_layers.is_empty() {
        out.push_str("prompt_layers:\n");
        for layer in &def.prompt_layers {
            out.push_str(&format!("  - file: {}\n", yaml_str(&layer.file)));
            out.push_str(&format!("    order: {}\n", layer.order));
        }
    }
    out.push_str("---\n\n");
    out.push_str(def.body.trim());
    out.push('\n');
    out
}

// ---------------------------------------------------------------------------
// Built-in definitions
// ---------------------------------------------------------------------------

pub const STUDY_BODY: &str = "You are bnote's study assistant, embedded in a markdown note-taking app. \
The user is studying material (a PDF paper or a web page) shown in the \
center panel while their own notes stay in the right pane. Answer in the user's language. \
Use markdown and $...$ / $$...$$ LaTeX math. Answer questions directly from your \
own knowledge.

## 回答方式(必须遵守)

- 结论先行:第一句直接回答问题,再给最短必要的解释。不要复述问题、不要寒暄、不要绕圈子。
- 直击本质:先给一句话核心(这个概念到底在解决什么问题),再给细节;细节只保留影响理解的部分。
- 符合认知科学:组块化——把内容组织成 3~5 个要点,每个要点一个概念;先框架后细节;新概念用已有概念类比;对比易混概念时给出明确的判别标准。
- 控制长度:默认不超过 200 字或 5 个要点;只有用户明确要求展开、或问题确实复杂时才写长。
- 结构服务理解:能用一个公式说清就不用三段文字;步骤用有序列表;并列要点用无序列表;重要对比用表格。
- 不确定就说不确定,并指出验证路径;不要编造论文里没有的内容。";

pub const CREATIVE_BODY: &str = "You are bnote's creation assistant, embedded in a markdown note-taking \
app. The user curates notes in a vault; you help them create, transform and \
polish content — essays, blog posts, documentation, and HTML pages derived \
from those notes. Answer and write in the user's language.

## 沟通方式(必须遵守)

- 结论先行:第一句先给交付物或结论(写完了什么/改了哪里/还差什么),再给必要的解释。不要复述需求、不要寒暄。
- 简洁:正文默认不超过 200 字;用户要求展开或交付长文时才写长。对话里用 markdown。
- 忠实汇报:工具失败或文件不存在要如实说明;不确定就说不确定并指出验证路径;不编造没读过的文件内容。

## 创作守则

- 内容优先:动笔前先确认受众、结构与要点;用户已给结构时照做,不自作主张换框架。
- 忠于素材:改写与扩写忠于原文事实,不擅自增删用户的主张与数据;引用用户笔记时以文件内容为准。
- 产物落盘:交付的文章/HTML 用 write_file 写进仓库,不要只贴在对话里;写完用 preview_html 推到中栏预览(仅 HTML)。
- HTML 的结构、样式与产物路径由用户调用的 skill 决定;本提示词不规定 HTML 的具体形态。没有合适 skill 时先问用户要,或按用户明说的要求来。";

pub const CODING_BODY: &str = "You are bnote's coding agent, working on a code project opened in the \
center panel. The project root is your working directory; it may live outside \
the vault. Answer and report in the user's language.

## 沟通方式(必须遵守)

- 结论先行:第一句先给结果(改了什么/跑通了什么/卡在哪),再给必要的解释。不要复述需求、不要寒暄。
- 简洁:正文默认不超过 200 字;只有用户要求展开时才写长。对话里用 markdown。
- 忠实汇报:命令失败、测试不过、文件不存在都要如实说明;不确定就说不确定并指出验证路径;不编造没读过的代码。

## 编码守则

- 先读后改:动任何文件前先 read_file / grep 确认现状;改动用 edit_file 精确替换,重写整篇才用 write_file。
- 按仓库现有风格写代码:命名、注释密度、习惯用法向周边代码看齐。
- 验证闭环:改完尽量跑得起验证(测试/构建/lint),把真实输出贴进结论;跑不了要说清为什么。
- 多个相互独立的工具调用放在同一轮并行发出;有依赖的调用等上一轮结果。
- 用 todo 工具维护多步任务清单:开工前列计划,完成一项更新一项。
- 复杂探索或独立子任务交给 task 子代理,避免把主会话上下文塞满中间结果。";

pub const EXPLORE_BODY: &str =
    "You are a read-only exploration subagent. A parent agent handed you a \
question about a codebase; you answer it by reading code — you cannot and must \
not modify anything. Be fast and precise: prefer glob/grep to locate, read_file \
to confirm, and answer with file paths and line numbers.

## 回答方式(必须遵守)

- 直接给结论和证据:答案 + 支撑它的文件:行号;不写过程流水账。
- 不确定就说不确定,并列出你查过什么;不要猜没读过的内容。
- 200 字以内;只有问题确实需要时才列更多细节。";

pub const EXPLORE_TOOLS: &[&str] = &["read_file", "list_files", "glob", "grep"];

/// Tools of the three built-in definitions. Kept next to the bodies so the
/// prompt's tool rules and the registered tool list stay in sync.
pub const STUDY_TOOLS: &[&str] = &[];
pub const CREATIVE_TOOLS: &[&str] = &[
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
];
pub const CODING_TOOLS: &[&str] = &[
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
];

pub fn builtins() -> Vec<AgentDefinition> {
    vec![
        AgentDefinition {
            id: "study".into(),
            name: "学习助手".into(),
            description: "围绕当前 PDF / 网页 / 代码项目的纯问答助手,不注册任何工具。".into(),
            body: STUDY_BODY.into(),
            tools: Some(STUDY_TOOLS.iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        },
        AgentDefinition {
            id: "creative".into(),
            name: "创作助手".into(),
            description: "创作模式:工具 + 技能 + MCP,产出文章与 HTML 并实时预览。".into(),
            body: CREATIVE_BODY.into(),
            tools: Some(CREATIVE_TOOLS.iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        },
        AgentDefinition {
            id: "coding".into(),
            name: "编码助手".into(),
            description: "代码项目的 coding agent:bash/glob/grep/todo/task/压缩全套能力。".into(),
            body: CODING_BODY.into(),
            tools: Some(CODING_TOOLS.iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        },
        AgentDefinition {
            id: "explore".into(),
            name: "探索子代理".into(),
            description: "只读探索子代理:找代码、读文件、报告位置与结构,不改动任何东西。".into(),
            body: EXPLORE_BODY.into(),
            tools: Some(EXPLORE_TOOLS.iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_full_user_definition_file() {
        let src = "---\nname: 评审员\ndescription: 代码评审子代理\nmodel: gpt-5\nmax_tokens: 4096\nmax_turns: 12\ntools:\n  - read_file\n  - grep\n  - mcp\npermissions:\n  bash: deny\ncompaction:\n  enabled: false\n  threshold: 0.7\nsubagents: [explore]\nprompt_layers:\n  - file: AGENTS.md\n    order: 40\n  - file: docs/style.md\n    order: 90\n---\n\n正文提示词。\n";
        let def = parse_definition("reviewer", src).unwrap();
        assert_eq!(def.name, "评审员");
        assert_eq!(def.model, "gpt-5");
        assert_eq!(def.max_tokens, 4096);
        assert_eq!(def.max_turns, 12);
        assert_eq!(
            def.tools,
            Some(vec!["read_file".into(), "grep".into(), "mcp".into()])
        );
        assert_eq!(def.permissions.get("bash"), Some(&Permission::Deny));
        assert!(!def.compaction.enabled);
        assert!((def.compaction.threshold - 0.7).abs() < 1e-9);
        assert_eq!(def.subagents, vec!["explore"]);
        assert_eq!(def.prompt_layers.len(), 2);
        assert_eq!(def.prompt_layers[0].order, 40);
        assert_eq!(def.body, "正文提示词。");
        assert!(!def.tool_enabled("bash"), "deny removes the tool");
        assert!(def.mcp_enabled());
    }

    #[test]
    fn parses_flow_lists_and_defaults() {
        let src = "---\ntools: [read_file, \"write_file\"]\n---\nbody only";
        let def = parse_definition("x", src).unwrap();
        assert_eq!(
            def.tools,
            Some(vec!["read_file".into(), "write_file".into()])
        );
        assert!(def.compaction.enabled, "compaction defaults on");
        assert_eq!(def.prompt_layers.len(), 0);
        assert_eq!(def.body, "body only");
    }

    #[test]
    fn a_file_without_frontmatter_is_a_valid_body_only_definition() {
        let def = parse_definition("plain", "只有正文").unwrap();
        assert_eq!(def.body, "只有正文");
        assert_eq!(
            def.effective_tools(),
            DEFAULT_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn errors_carry_the_offending_line_number() {
        let src = "---\ntools:\n    - a\n  - b\n---\nx";
        let err = parse_definition("bad", src).unwrap_err();
        assert!(err.contains("缩进"), "{}", err);

        let src2 = "---\npermissions:\n  bash: maybe\n---\nx";
        let err2 = parse_definition("bad2", src2).unwrap_err();
        assert!(err2.contains("无效"), "{}", err2);
    }

    #[test]
    fn comments_and_quoted_values_round_trip() {
        let src = "---\n# 整行注释\nname: \"my: agent\" # 行尾注释\nsubagents: # 空值跟随列表\n  - a\n  - b\n---\nbody";
        let def = parse_definition("c", src).unwrap();
        assert_eq!(def.name, "my: agent");
        assert_eq!(def.subagents, vec!["a", "b"]);
    }

    #[test]
    fn serialization_round_trips_through_the_parser() {
        let def = AgentDefinition {
            id: "r".into(),
            name: "测试".into(),
            description: "带 # 与: 冒号".into(),
            body: "正文\n\n第二段".into(),
            tools: Some(vec!["read_file".into(), "grep".into()]),
            permissions: [("bash".to_string(), Permission::Deny)]
                .into_iter()
                .collect(),
            compaction: CompactionCfg {
                enabled: false,
                threshold: 0.6,
            },
            subagents: vec!["explore".into()],
            prompt_layers: vec![PromptLayer {
                file: "AGENTS.md".into(),
                order: 40,
            }],
            model: "m1".into(),
            max_tokens: 4096,
            max_turns: 10,
        };
        let text = serialize_definition(&def);
        let back = parse_definition("r", &text).unwrap();
        assert_eq!(back.name, "测试");
        assert_eq!(back.description, "带 # 与: 冒号");
        assert_eq!(back.tools, def.tools);
        assert_eq!(back.permissions, def.permissions);
        assert!(!back.compaction.enabled);
        assert_eq!(back.prompt_layers, def.prompt_layers);
        assert_eq!(back.body, def.body);
    }

    #[test]
    fn user_files_override_builtins_with_the_same_id() {
        let dir = std::env::temp_dir().join("bnote-defs-override");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".bnote/agents")).unwrap();
        std::fs::write(
            dir.join(".bnote/agents/study.md"),
            "---\nname: 自定义学习\n---\n覆盖正文",
        )
        .unwrap();
        std::fs::write(
            dir.join(".bnote/agents/broken.md"),
            "---\nname: [未闭合\n---\nx",
        )
        .unwrap();
        let (defs, errors) = load_definitions(Some(&dir));
        let study = defs.iter().find(|d| d.id == "study").unwrap();
        assert_eq!(study.name, "自定义学习");
        assert!(defs.iter().any(|d| d.id == "coding"), "builtins stay");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].id, "broken");
    }

    #[test]
    fn builtins_carry_the_expected_toolsets() {
        let defs = builtins();
        let study = defs.iter().find(|d| d.id == "study").unwrap();
        assert!(study.effective_tools().is_empty());
        let creative = defs.iter().find(|d| d.id == "creative").unwrap();
        assert!(creative.mcp_enabled());
        assert!(creative.tool_enabled("preview_html"));
        let coding = defs.iter().find(|d| d.id == "coding").unwrap();
        for t in ["bash", "grep", "todo", "task", "mcp"] {
            assert!(coding.tool_enabled(t), "coding must enable {}", t);
        }
        let explore = defs.iter().find(|d| d.id == "explore").unwrap();
        assert!(explore.tool_enabled("grep"));
        for t in ["write_file", "edit_file", "bash", "task"] {
            assert!(
                !explore.tool_enabled(t),
                "explore must be read-only ({})",
                t
            );
        }
    }

    #[test]
    fn deny_wins_over_the_whitelist() {
        let mut def = serde_json::from_value::<AgentDefinition>(json!({
            "id": "x",
            "tools": ["read_file", "bash"],
            "permissions": {"read_file": "deny"}
        }))
        .unwrap();
        assert!(!def.tool_enabled("read_file"));
        assert!(def.tool_enabled("bash"));
        def.permissions.insert("mcp".into(), Permission::Deny);
        assert!(!def.mcp_enabled());
    }
}
