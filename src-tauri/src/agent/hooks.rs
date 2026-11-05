//! Hook commands, following Claude Code's hooks: a shell command declared in
//! `settings.json` runs at a lifecycle event, receives the event as JSON on
//! stdin, and can allow/deny a tool, add context, rewrite tool input, or block
//! a stop.
//!
//! Events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
//! `UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStart`,
//! `SubagentStop`, `PreCompact`, `PostCompact`. (`SessionEnd` has no bnote
//! equivalent: a session has no explicit close.)
//!
//! Output contract (CC's shape):
//!   - exit code 2: blocking error, stderr is fed back to the model;
//!   - exit code 0 + JSON on stdout:
//!     `{"hookSpecificOutput":{"permissionDecision":"allow|deny|ask",
//!       "permissionDecisionReason":"…","additionalContext":"…",
//!       "updatedInput":{…}}}` or `{"decision":"block","reason":"…"}`;
//!   - any other code: a non-blocking error, logged and ignored.

use super::permissions::Decision;
use super::settings::Settings;
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

const DEFAULT_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Default)]
pub struct HookOutcome {
    pub decision: Option<Decision>,
    pub reason: Option<String>,
    pub context: Vec<String>,
    pub updated_input: Option<Value>,
    /// `decision: "block"` (a Stop hook can force another turn).
    pub block: bool,
    pub stop_reason: Option<String>,
}

impl HookOutcome {
    fn absorb(&mut self, other: HookOutcome) {
        // deny > ask > allow, regardless of hook order.
        self.decision = match (self.decision, other.decision) {
            (Some(Decision::Deny), _) | (_, Some(Decision::Deny)) => Some(Decision::Deny),
            (Some(Decision::Ask), _) | (_, Some(Decision::Ask)) => Some(Decision::Ask),
            (Some(Decision::Allow), _) | (_, Some(Decision::Allow)) => Some(Decision::Allow),
            _ => None,
        };
        if other.reason.is_some() {
            self.reason = other.reason;
        }
        self.context.extend(other.context);
        if other.updated_input.is_some() {
            self.updated_input = other.updated_input;
        }
        self.block |= other.block;
        if other.stop_reason.is_some() {
            self.stop_reason = other.stop_reason;
        }
    }
}

/// Runs every hook registered for `event`. `tool` is the tool name for the
/// tool events (used by the matcher).
pub async fn run(
    settings: &Settings,
    project: Option<&Path>,
    event: &str,
    tool: Option<&str>,
    payload: Value,
) -> HookOutcome {
    let Some(matchers) = settings.hooks.get(event) else {
        return HookOutcome::default();
    };
    let mut outcome = HookOutcome::default();
    for matcher in matchers {
        if let Some(pattern) = &matcher.matcher {
            let Some(name) = tool else { continue };
            if !glob_match(pattern, name) {
                continue;
            }
        }
        for hook in &matcher.hooks {
            let command = hook.command.trim();
            if command.is_empty() {
                continue;
            }
            let timeout = Duration::from_secs(hook.timeout.unwrap_or(DEFAULT_TIMEOUT_SECS));
            match run_one(command, project, timeout, &payload).await {
                Ok(Some(one)) => outcome.absorb(one),
                Ok(None) => {}
                Err(e) => eprintln!("[bnote] hook `{command}` failed: {e}"),
            }
        }
    }
    outcome
}

async fn run_one(
    command: &str,
    project: Option<&Path>,
    timeout: Duration,
    payload: &Value,
) -> Result<Option<HookOutcome>, String> {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(project) = project {
        cmd.current_dir(project);
        cmd.env("BNOTE_PROJECT_DIR", project);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt as _;
        let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
        // A hook that does not read stdin closes the pipe: that is not an
        // error, the process simply never sees the payload.
        if let Err(e) = stdin.write_all(&body).await {
            eprintln!("[bnote] hook stdin: {e}");
        }
    }
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => {
            // kill_on_drop already killed the child when the future dropped.
            return Err(format!("timeout after {:?}", timeout));
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.code() == Some(2) {
        // Blocking error: the reason goes back to the model.
        return Ok(Some(HookOutcome {
            decision: Some(Decision::Deny),
            reason: Some(stderr.trim().to_string()).filter(|r| !r.is_empty()),
            context: vec![stderr.trim().to_string()]
                .into_iter()
                .filter(|c| !c.is_empty())
                .collect(),
            ..Default::default()
        }));
    }
    if !output.status.success() {
        if !stderr.trim().is_empty() {
            eprintln!("[bnote] hook stderr: {}", stderr.trim());
        }
        return Ok(None);
    }
    if stdout.trim().is_empty() {
        return Ok(None);
    }
    let parsed: Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[bnote] hook output is not JSON: {e}");
            return Ok(None);
        }
    };
    Ok(Some(parse_output(&parsed)))
}

fn parse_output(value: &Value) -> HookOutcome {
    let mut out = HookOutcome::default();
    if let Some(specific) = value.get("hookSpecificOutput") {
        if let Some(decision) = specific.get("permissionDecision").and_then(|v| v.as_str()) {
            out.decision = Some(match decision {
                "allow" => Decision::Allow,
                "deny" => Decision::Deny,
                "ask" => Decision::Ask,
                _ => return out,
            });
        }
        if let Some(reason) = specific
            .get("permissionDecisionReason")
            .and_then(|v| v.as_str())
        {
            out.reason = Some(reason.to_string());
        }
        if let Some(context) = specific.get("additionalContext").and_then(|v| v.as_str()) {
            out.context.push(context.to_string());
        }
        if let Some(input) = specific.get("updatedInput") {
            out.updated_input = Some(input.clone());
        }
    }
    if let Some(decision) = value.get("decision").and_then(|v| v.as_str()) {
        if decision == "block" {
            out.block = true;
            out.reason = value
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or(out.reason);
        }
    }
    if let Some(reason) = value.get("stopReason").and_then(|v| v.as_str()) {
        out.stop_reason = Some(reason.to_string());
    }
    out
}

/// Tool-name matcher: `*` wildcards, otherwise an exact match.
fn glob_match(pattern: &str, name: &str) -> bool {
    if pattern == "*" || pattern.is_empty() {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == name;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut rest = name;
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

/// The JSON body a hook receives. `cwd` is the project root; the caller adds
/// the event-specific fields.
pub fn payload(event: &str, project: Option<&Path>, extra: Value) -> Value {
    let mut base = json!({
        "hook_event_name": event,
        "cwd": project.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
    });
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::settings::{HookCommand, HookMatcher};

    fn settings_with(event: &str, matcher: &str, command: &str) -> Settings {
        let mut settings = Settings::default();
        settings.hooks.insert(
            event.to_string(),
            vec![HookMatcher {
                matcher: Some(matcher.to_string()),
                hooks: vec![HookCommand {
                    command: command.to_string(),
                    timeout: Some(5),
                }],
            }],
        );
        settings
    }

    async fn run_event(settings: &Settings, event: &str, tool: &str) -> HookOutcome {
        run(
            settings,
            None,
            event,
            Some(tool),
            payload(event, None, json!({"tool_name": tool})),
        )
        .await
    }

    #[tokio::test]
    async fn a_pre_tool_use_hook_can_deny() {
        let settings = settings_with(
            "PreToolUse",
            "Bash",
            r#"printf '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no"}}'"#,
        );
        let out = run_event(&settings, "PreToolUse", "Bash").await;
        assert_eq!(out.decision, Some(Decision::Deny));
        assert_eq!(out.reason.as_deref(), Some("no"));
    }

    #[tokio::test]
    async fn the_matcher_limits_which_tool_the_hook_sees() {
        let settings = settings_with(
            "PreToolUse",
            "Write",
            r#"printf '{"hookSpecificOutput":{"permissionDecision":"deny"}}'"#,
        );
        let out = run_event(&settings, "PreToolUse", "Bash").await;
        assert_eq!(out.decision, None);
    }

    #[tokio::test]
    async fn exit_code_two_blocks_with_stderr_as_the_reason() {
        let settings = settings_with("PreToolUse", "*", "echo blocked >&2; exit 2");
        let out = run_event(&settings, "PreToolUse", "Bash").await;
        assert_eq!(out.decision, Some(Decision::Deny));
        assert!(out.reason.unwrap().contains("blocked"));
    }

    #[tokio::test]
    async fn a_hook_receives_the_event_json_on_stdin() {
        let settings = settings_with(
            "PreToolUse",
            "*",
            r#"read line; if printf '%s' "$line" | grep -q PreToolUse; then printf '{"hookSpecificOutput":{"additionalContext":"saw-event"}}'; fi"#,
        );
        let out = run_event(&settings, "PreToolUse", "Bash").await;
        assert_eq!(out.context, vec!["saw-event".to_string()]);
    }

    #[tokio::test]
    async fn a_hanging_hook_times_out_without_blocking_the_turn() {
        let mut settings = Settings::default();
        settings.hooks.insert(
            "PreToolUse".into(),
            vec![HookMatcher {
                matcher: Some("*".into()),
                hooks: vec![HookCommand {
                    command: "sleep 10".into(),
                    timeout: Some(1),
                }],
            }],
        );
        let started = std::time::Instant::now();
        let out = run_event(&settings, "PreToolUse", "Bash").await;
        assert_eq!(out.decision, None);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "elapsed {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_stop_hook_can_block() {
        let settings = settings_with(
            "Stop",
            "*",
            r#"printf '{"decision":"block","reason":"keep going"}'"#,
        );
        let out = run_event(&settings, "Stop", "Stop").await;
        assert!(out.block);
        assert_eq!(out.reason.as_deref(), Some("keep going"));
    }
}
