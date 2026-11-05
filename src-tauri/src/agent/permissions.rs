//! Tool permissions, following Claude Code's decision shape.
//!
//! Three outcomes: `allow` runs the tool, `deny` never runs it and feeds a
//! refusal back as an `is_error` tool result, `ask` pauses the turn until the
//! user approves or rejects in the panel.
//!
//! The decision is made at **dispatch** time, not only when the tool list is
//! assembled: removing a denied tool from the advertised list is a hint to the
//! model, not a guarantee — a model that names it anyway must still be stopped.

use super::defs::{AgentDefinition, Permission};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}

/// The three modes of the composer dropdown, the same shape ZCode's permission
/// selector has: `Confirm` asks before every change, `Auto` runs autonomously
/// and asks only on a recognized dangerous command, `Full` never asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Confirm,
    Auto,
    Full,
    /// Plan mode: the agent may explore and write the plan, but not change
    /// the repository (write/edit denied, shell commands limited to readers).
    Plan,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Mode> {
        match value {
            "confirm" => Some(Mode::Confirm),
            "auto" => Some(Mode::Auto),
            "full" => Some(Mode::Full),
            "plan" => Some(Mode::Plan),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Mode::Confirm => "confirm",
            Mode::Auto => "auto",
            Mode::Full => "full",
            Mode::Plan => "plan",
        }
    }

    /// Maps a `settings.json` `permissions.defaultMode` value onto the
    /// composer's mode. `plan` and `dontAsk` (CC-only modes) fall back to the
    /// closest bnote posture until plan mode lands.
    pub fn from_settings(value: Option<&str>) -> Mode {
        match value.unwrap_or_default() {
            "acceptEdits" | "auto" => Mode::Auto,
            "bypassPermissions" | "full" => Mode::Full,
            "default" | "dontAsk" | "confirm" => Mode::Confirm,
            "plan" => Mode::Plan,
            _ => Mode::Auto,
        }
    }
}

impl Default for Mode {
    fn default() -> Self {
        // Autonomous: edits run without a prompt, a destructive shell command
        // still asks. This is the behaviour the agent had before the modes
        // existed, made explicit.
        Mode::Auto
    }
}

/// Tools that change the user's files or run a shell: the ones `Confirm` asks
/// about.
pub fn needs_approval(tool: &str) -> bool {
    matches!(tool, "write_file" | "edit_file" | "bash")
}

/// Per-tool decision. Settings rules run first (deny → ask → allow), then the
/// definition's `permissions` map, then the session mode.
pub fn decide(mode: Mode, def: &AgentDefinition, tool: &str, input: &Value) -> Decision {
    decide_with_rules(mode, def, &Rules::default(), tool, input)
}

/// Settings-level allow/ask/deny rules (`settings.json`). They are evaluated
/// before the session mode: an explicit rule expresses the user's intent and
/// the modes are only the default posture.
pub fn decide_with_rules(
    mode: Mode,
    def: &AgentDefinition,
    rules: &Rules,
    tool: &str,
    input: &Value,
) -> Decision {
    if let Some(decision) = rule_decision(rules, tool, input) {
        return decision;
    }
    let key = if tool.starts_with("mcp__") { "mcp" } else { tool };
    match def.permissions.get(key) {
        Some(Permission::Deny) => Decision::Deny,
        Some(Permission::Ask) => Decision::Ask,
        Some(Permission::Allow) => Decision::Allow,
        None => match mode {
            Mode::Full => Decision::Allow,
            Mode::Confirm => {
                if needs_approval(tool) {
                    Decision::Ask
                } else {
                    Decision::Allow
                }
            }
            Mode::Auto => {
                if tool == "bash" && dangerous_command(input["command"].as_str().unwrap_or("")).is_some() {
                    Decision::Ask
                } else {
                    Decision::Allow
                }
            }
            Mode::Plan => {
                if matches!(tool, "write_file" | "edit_file") {
                    Decision::Deny
                } else if tool == "bash"
                    && !read_only_command(input["command"].as_str().unwrap_or(""))
                {
                    Decision::Deny
                } else {
                    Decision::Allow
                }
            }
        },
    }
}

/// The permission rules from one or more settings files.
#[derive(Debug, Default, Clone, Copy)]
pub struct Rules<'a> {
    pub allow: &'a [String],
    pub ask: &'a [String],
    pub deny: &'a [String],
}

/// `None` = no rule matched. Order matters: deny beats ask beats allow.
pub fn rule_decision(rules: &Rules, tool: &str, input: &Value) -> Option<Decision> {
    if rules.deny.iter().any(|rule| rule_matches(rule, tool, input)) {
        return Some(Decision::Deny);
    }
    if rules.ask.iter().any(|rule| rule_matches(rule, tool, input)) {
        return Some(Decision::Ask);
    }
    if rules
        .allow
        .iter()
        .any(|rule| rule_matches(rule, tool, input))
    {
        return Some(Decision::Allow);
    }
    None
}

/// `Bash(npm run test:*)`, `Write(/tmp/**)`, `Read`, `mcp__server__tool`.
fn rule_matches(rule: &str, tool: &str, input: &Value) -> bool {
    let rule = rule.trim();
    if rule.is_empty() {
        return false;
    }
    let (name, spec) = match rule.split_once('(') {
        Some((name, rest)) => match rest.strip_suffix(')') {
            Some(spec) => (name.trim(), Some(spec.trim())),
            None => (name.trim(), None),
        },
        None => (rule, None),
    };
    if !(name == "*" || name == tool) {
        return false;
    }
    let Some(spec) = spec else { return true };
    if spec.is_empty() {
        return true;
    }
    match tool {
        "bash" => bash_matches(spec, input["command"].as_str().unwrap_or_default()),
        "read_file" | "write_file" | "edit_file" | "glob" | "grep" | "list_files" => {
            let path = input["path"].as_str().unwrap_or_default();
            path_matches(spec, path)
        }
        "task" => input["subagent_type"]
            .as_str()
            .map(|value| glob_match(spec, value))
            .unwrap_or(false),
        "read_url" => input["url"]
            .as_str()
            .map(|value| glob_match(spec, value))
            .unwrap_or(false),
        _ => input
            .as_object()
            .map(|map| {
                map.values().any(|value| {
                    value
                        .as_str()
                        .map(|text| glob_match(spec, text))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false),
    }
}

/// `prefix:*` is a command prefix; `*` anywhere else is a wildcard; without a
/// wildcard the command must match exactly.
fn bash_matches(spec: &str, command: &str) -> bool {
    let command = command.trim();
    if let Some(prefix) = spec.strip_suffix(":*") {
        return command.starts_with(prefix.trim());
    }
    if spec.contains('*') {
        return glob_match(spec, command);
    }
    command == spec.trim()
}

fn path_matches(spec: &str, path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    // CC writes absolute path rules as `//abs/path`; the doubled slash only
    // escapes the rule syntax.
    let spec = spec
        .strip_prefix("//")
        .map(|s| format!("/{}", s))
        .unwrap_or_else(|| spec.to_string());
    if spec.contains('*') {
        return glob_match(&spec, path);
    }
    path == spec || path.starts_with(&format!("{}/", spec.trim_end_matches('/')))
}

/// Wildcard matcher: `*` matches any run of characters.
fn glob_match(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == value;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = value;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if index == 0 {
            if !rest.starts_with(part) {
                return false;
            }
            rest = &rest[part.len()..];
        } else if index == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            match rest.find(part) {
                Some(at) => rest = &rest[at + part.len()..],
                None => return false,
            }
        }
    }
    true
}

/// Whether a shell command only reads. Plan mode allows these and denies
/// everything else that could change the repository.
///
/// The check is conservative (whitespace-separated segments, every segment
/// must be a reader): a command it does not recognize is denied, the agent
/// can still read files with read_file / grep.
pub fn read_only_command(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return true;
    }
    // A pipe / chain is only as safe as its parts.
    for segment in command.split(['|', ';', '&', '\n']) {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        if !read_only_segment(segment) {
            return false;
        }
    }
    true
}

fn read_only_segment(segment: &str) -> bool {
    let mut parts = segment.split_whitespace();
    let Some(head) = parts.next() else { return true };
    let head = head.trim_start_matches('(').trim();
    const READERS: &[&str] = &[
        "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "stat", "file",
        "tree", "rg", "grep", "find", "fd", "sort", "uniq", "cut", "tr", "diff", "cmp",
        "sed", "awk", "jq", "basename", "dirname", "realpath", "which", "type",
        "du", "df", "date", "uname", "env", "printenv", "cd", "test", "true", "false",
    ];
    if READERS.contains(&head) {
        // `sed -i` and `awk -i inplace` write; treat the in-place forms as writes.
        let rest: Vec<&str> = parts.collect();
        if head == "sed" && rest.iter().any(|a| *a == "-i" || a.starts_with("-i")) {
            return false;
        }
        if head == "awk" && rest.iter().any(|a| a.contains("inplace")) {
            return false;
        }
        return true;
    }
    if head == "git" {
        let sub = parts.next().unwrap_or_default();
        // `git config` without a value only reads; the writing form needs one.
        if sub == "config" {
            return false;
        }
        return matches!(
            sub,
            "status" | "diff" | "log" | "show" | "branch" | "rev-parse" | "ls-files"
                | "remote" | "describe" | "blame" | "grep" | "tag"
        );
    }
    if head == "cargo" {
        // `cargo check` compiles into target/: not a reader.
        return matches!(parts.next().unwrap_or_default(), "metadata" | "tree" | "search");
    }
    false
}

/// Recognized destructive shell commands (ZCode's guarded matcher, trimmed to
/// the patterns that lose work): everything else runs without a prompt.
pub fn dangerous_command(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    let patterns: &[(&str, &str)] = &[
        ("rm -rf", "rm -rf"),
        ("rm -fr", "rm -fr"),
        ("rm -r ", "rm -r"),
        ("git reset --hard", "git reset --hard"),
        ("git push --force", "git push --force"),
        ("git push -f", "git push -f"),
        ("git clean -f", "git clean -f"),
        ("git checkout -- .", "git checkout -- ."),
        ("sudo ", "sudo"),
        ("mkfs", "mkfs"),
        ("dd if=", "dd"),
        ("shutdown", "shutdown"),
        ("reboot", "reboot"),
        ("killall", "killall"),
        ("pkill -9", "pkill -9"),
        ("chmod -r 777", "chmod -R 777"),
        ("chmod -r 777", "chmod -R 777"),
        ("truncate -s 0", "truncate -s 0"),
        ("drop table", "DROP TABLE"),
        ("drop database", "DROP DATABASE"),
        ("/dev/sd", "write to /dev/sdX"),
    ];
    patterns
        .iter()
        .find(|(needle, _)| lower.contains(needle))
        .map(|(_, label)| *label)
}

/// What the model is told when a tool is refused. The guidance is the part that
/// matters: a refusal is not a signal to route around the user's intent.
pub const DENIAL_WORKAROUND_GUIDANCE: &str = "This tool use was rejected, so its effect did NOT happen (no file was written, no command ran). \
Try a different approach that achieves the user's actual goal, or report the limitation and ask how to proceed. \
Do NOT try to accomplish the same effect through another tool in order to get around this denial; \
if the capability is essential, stop and explain that to the user.";

/// Denial text for a blocked tool (CC `AUTO_REJECT_MESSAGE` shape).
pub fn denial_message(tool: &str) -> String {
    format!(
        "Permission to use {} has been denied. {}",
        tool, DENIAL_WORKAROUND_GUIDANCE
    )
}

/// Rejection text when the user answers "no" in the approval dialog.
pub fn reject_message(feedback: Option<&str>) -> String {
    let base = "The user doesn't want to proceed with this tool use. The tool use was rejected \
                (e.g. if it was a file edit, the new_string was NOT written to the file). \
                STOP what you are doing and wait for the user to tell you how to proceed.";
    match feedback.map(str::trim).filter(|f| !f.is_empty()) {
        Some(reason) => format!("{}\nTo tell you how to proceed, the user said:\n{}", base, reason),
        None => base.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn def_with(entries: &[(&str, Permission)]) -> AgentDefinition {
        let mut permissions = BTreeMap::new();
        for (tool, perm) in entries {
            permissions.insert((*tool).to_string(), *perm);
        }
        AgentDefinition {
            permissions,
            ..Default::default()
        }
    }

    fn no_input() -> Value {
        serde_json::json!({})
    }

    #[test]
    fn per_tool_allow_wins_over_the_mode() {
        let def = def_with(&[("bash", Permission::Allow)]);
        assert_eq!(
            decide(Mode::Confirm, &def, "bash", &no_input()),
            Decision::Allow
        );
    }

    #[test]
    fn ask_and_deny_are_reported_as_such() {
        let def = def_with(&[("bash", Permission::Ask), ("write_file", Permission::Deny)]);
        assert_eq!(decide(Mode::Full, &def, "bash", &no_input()), Decision::Ask);
        assert_eq!(
            decide(Mode::Full, &def, "write_file", &no_input()),
            Decision::Deny
        );
    }

    #[test]
    fn every_mcp_tool_shares_the_mcp_entry() {
        let def = def_with(&[("mcp", Permission::Deny)]);
        assert_eq!(
            decide(Mode::Auto, &def, "mcp__github__create_issue", &no_input()),
            Decision::Deny
        );
        assert_eq!(
            decide(Mode::Auto, &def, "read_file", &no_input()),
            Decision::Allow
        );
    }

    #[test]
    fn confirm_asks_before_writes_and_shell_but_not_reads() {
        let def = def_with(&[]);
        for tool in ["write_file", "edit_file", "bash"] {
            assert_eq!(decide(Mode::Confirm, &def, tool, &no_input()), Decision::Ask);
        }
        for tool in ["read_file", "grep", "todo", "task_list"] {
            assert_eq!(
                decide(Mode::Confirm, &def, tool, &no_input()),
                Decision::Allow
            );
        }
    }

    #[test]
    fn auto_runs_edits_and_asks_only_for_a_dangerous_shell_command() {
        let def = def_with(&[]);
        assert_eq!(
            decide(Mode::Auto, &def, "write_file", &no_input()),
            Decision::Allow
        );
        assert_eq!(
            decide(Mode::Auto, &def, "bash", &serde_json::json!({"command": "ls -la"})),
            Decision::Allow
        );
        assert_eq!(
            decide(Mode::Auto, &def, "bash", &serde_json::json!({"command": "rm -rf build"})),
            Decision::Ask
        );
    }

    #[test]
    fn full_never_asks_unless_the_definition_says_so() {
        let def = def_with(&[]);
        assert_eq!(
            decide(Mode::Full, &def, "bash", &serde_json::json!({"command": "rm -rf /"})),
            Decision::Allow
        );
    }

    #[test]
    fn plan_mode_refuses_writes_and_allows_readers() {
        let def = def_with(&[]);
        for tool in ["write_file", "edit_file"] {
            assert_eq!(
                decide(Mode::Plan, &def, tool, &no_input()),
                Decision::Deny
            );
        }
        assert_eq!(
            decide(Mode::Plan, &def, "read_file", &no_input()),
            Decision::Allow
        );
        assert_eq!(
            decide(
                Mode::Plan,
                &def,
                "bash",
                &serde_json::json!({"command": "git status && grep -rn foo src"})
            ),
            Decision::Allow
        );
        for command in ["touch x", "rm -rf build", "git commit -am x", "sed -i s/a/b/ f"] {
            assert_eq!(
                decide(
                    Mode::Plan,
                    &def,
                    "bash",
                    &serde_json::json!({"command": command})
                ),
                Decision::Deny,
                "{command}"
            );
        }
    }

    #[test]
    fn dangerous_commands_are_recognized_case_insensitively() {
        assert!(dangerous_command("git push --force").is_some());
        assert!(dangerous_command("sudo rm -rf /tmp/x").is_some());
        assert!(dangerous_command("ls -la").is_none());
        assert!(dangerous_command("git status").is_none());
    }
}
