//! Layered settings, following Claude Code's `settings.json`:
//!
//!   `~/.bnote/settings.json`                 user
//!   `<project>/.bnote/settings.json`         project
//!   `<project>/.bnote/settings.local.json`   local (private, not checked in)
//!
//! Later files override earlier ones; arrays are concatenated and de-duplicated
//! (CC's merge), objects are merged key by key, scalars take the last value. A
//! malformed file is reported and skipped — it must never stop the app from
//! starting or a session from running.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Permissions {
    pub allow: Vec<String>,
    pub ask: Vec<String>,
    pub deny: Vec<String>,
    /// `default` | `acceptEdits` | `bypassPermissions` | `plan` | `dontAsk`
    pub default_mode: Option<String>,
    pub additional_directories: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HookMatcher {
    /// Tool-name pattern (`*` wildcard); absent = every tool.
    pub matcher: Option<String>,
    pub hooks: Vec<HookCommand>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HookCommand {
    pub command: String,
    /// Seconds; default 60.
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub model: Option<String>,
    pub env: BTreeMap<String, String>,
    pub permissions: Permissions,
    /// Event name -> matchers. Events: PreToolUse, PostToolUse,
    /// PostToolUseFailure, UserPromptSubmit, SessionStart, Stop,
    /// SubagentStart, SubagentStop, PreCompact, PostCompact.
    pub hooks: BTreeMap<String, Vec<HookMatcher>>,
    pub output_style: Option<String>,
    /// Glob patterns excluded from instruction-file discovery.
    pub instructions_excludes: Vec<String>,
    pub cleanup_period_days: Option<u32>,
    pub plans_directory: Option<String>,
    pub auto_memory_enabled: Option<bool>,
    pub auto_memory_directory: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SettingsFile {
    pub path: PathBuf,
    pub exists: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LoadedSettings {
    pub settings: Settings,
    /// The files that were consulted, in merge order (the settings UI shows
    /// them; a parse error is surfaced there too).
    pub files: Vec<SettingsFile>,
}

pub fn user_file() -> PathBuf {
    crate::agent::home::settings_file()
}

pub fn project_files(project: Option<&Path>) -> Vec<PathBuf> {
    let Some(project) = project else {
        return Vec::new();
    };
    vec![
        project.join(".bnote").join("settings.json"),
        project.join(".bnote").join("settings.local.json"),
    ]
}

/// Every settings file for a project, in merge order.
pub fn file_list(project: Option<&Path>) -> Vec<PathBuf> {
    let mut files = vec![user_file()];
    files.extend(project_files(project));
    files
}

pub fn load(project: Option<&Path>) -> LoadedSettings {
    let mut loaded = LoadedSettings::default();
    for path in file_list(project) {
        let exists = path.is_file();
        let mut file = SettingsFile {
            path: path.clone(),
            exists,
            error: None,
        };
        if exists {
            match std::fs::read_to_string(&path) {
                Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
                    Ok(settings) => merge(&mut loaded.settings, settings),
                    Err(e) => file.error = Some(e.to_string()),
                },
                Err(e) => file.error = Some(e.to_string()),
            }
        }
        loaded.files.push(file);
    }
    loaded
}

fn merge(into: &mut Settings, from: Settings) {
    if from.model.is_some() {
        into.model = from.model;
    }
    for (key, value) in from.env {
        into.env.insert(key, value);
    }
    merge_list(&mut into.permissions.allow, from.permissions.allow);
    merge_list(&mut into.permissions.ask, from.permissions.ask);
    merge_list(&mut into.permissions.deny, from.permissions.deny);
    merge_list(
        &mut into.permissions.additional_directories,
        from.permissions.additional_directories,
    );
    if from.permissions.default_mode.is_some() {
        into.permissions.default_mode = from.permissions.default_mode;
    }
    // Hook matchers accumulate: a project hook does not replace the user hook.
    for (event, matchers) in from.hooks {
        into.hooks.entry(event).or_default().extend(matchers);
    }
    if from.output_style.is_some() {
        into.output_style = from.output_style;
    }
    merge_list(&mut into.instructions_excludes, from.instructions_excludes);
    if from.cleanup_period_days.is_some() {
        into.cleanup_period_days = from.cleanup_period_days;
    }
    if from.plans_directory.is_some() {
        into.plans_directory = from.plans_directory;
    }
    if from.auto_memory_enabled.is_some() {
        into.auto_memory_enabled = from.auto_memory_enabled;
    }
    if from.auto_memory_directory.is_some() {
        into.auto_memory_directory = from.auto_memory_directory;
    }
}

fn merge_list(into: &mut Vec<String>, from: Vec<String>) {
    for item in from {
        if !into.iter().any(|existing| existing == &item) {
            into.push(item);
        }
    }
}

/// `chmod 0o700` on the settings file is overkill here; the home directory is
/// already private. Only the write path matters: the UI writes the user file.
pub fn write_user(contents: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(contents)
        .map_err(|e| format!("INVALID_JSON: {}", e))?;
    let path = user_file();
    if let Some(parent) = path.parent() {
        crate::agent::home::ensure_dir(parent)?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(tag: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "bnote-settings-{}-{}-{}",
            tag,
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".bnote")).unwrap();
        dir
    }

    fn write(path: &Path, raw: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, raw).unwrap();
    }

    #[test]
    fn project_settings_override_and_arrays_merge() {
        let project = temp("merge");
        write(
            &project.join(".bnote/settings.json"),
            r#"{"permissions":{"deny":["Bash(git push:*)"]},"outputStyle":"Learning"}"#,
        );
        write(
            &project.join(".bnote/settings.local.json"),
            r#"{"permissions":{"deny":["Bash(rm:*)"]},"model":"x"}"#,
        );
        let loaded = load(Some(&project));
        let s = &loaded.settings;
        assert_eq!(
            s.permissions.deny,
            vec!["Bash(git push:*)".to_string(), "Bash(rm:*)".to_string()]
        );
        assert_eq!(s.output_style.as_deref(), Some("Learning"));
        assert_eq!(s.model.as_deref(), Some("x"));
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn a_malformed_file_is_reported_and_skipped() {
        let project = temp("bad");
        let path = project.join(".bnote/settings.json");
        write(&path, "{ not json");
        let loaded = load(Some(&project));
        let file = loaded
            .files
            .iter()
            .find(|f| f.path == path)
            .unwrap();
        assert!(file.error.is_some());
        assert!(loaded.settings.permissions.deny.is_empty());
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn hook_matchers_accumulate_across_layers() {
        let project = temp("hooks");
        write(
            &project.join(".bnote/settings.json"),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"a"}]}]}}"#,
        );
        write(
            &project.join(".bnote/settings.local.json"),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"command":"b"}]}]}}"#,
        );
        let s = load(Some(&project)).settings;
        assert_eq!(s.hooks["PreToolUse"].len(), 2);
        std::fs::remove_dir_all(&project).unwrap();
    }
}
