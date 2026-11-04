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
}

impl Mode {
    pub fn parse(value: &str) -> Option<Mode> {
        match value {
            "confirm" => Some(Mode::Confirm),
            "auto" => Some(Mode::Auto),
            "full" => Some(Mode::Full),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Mode::Confirm => "confirm",
            Mode::Auto => "auto",
            Mode::Full => "full",
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

/// Per-tool decision. The definition's `permissions` map wins (an explicit
/// `allow` means "never ask me about this one", `ask` forces the prompt, `deny`
/// blocks); absent entries fall through to the session mode.
pub fn decide(mode: Mode, def: &AgentDefinition, tool: &str, input: &Value) -> Decision {
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
        },
    }
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

/// The approval card's headline for a dangerous command.
pub fn danger_reason(command: &str) -> Option<String> {
    dangerous_command(command).map(|label| {
        format!(
            "这条命令会执行高风险操作({label}),确认后才执行。",
        )
    })
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
    fn dangerous_commands_are_recognized_case_insensitively() {
        assert!(dangerous_command("git push --force").is_some());
        assert!(dangerous_command("sudo rm -rf /tmp/x").is_some());
        assert!(dangerous_command("ls -la").is_none());
        assert!(dangerous_command("git status").is_none());
    }
}
