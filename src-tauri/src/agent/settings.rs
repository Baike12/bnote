//! Layered, per-mode settings (Claude Code's `settings.json` shape):
//!
//!   `<mode root>/settings.json`              the mode (and its vault)
//!   `<project>/.bnote/settings.json`         coding only: the code project
//!   `<project>/.bnote/settings.local.json`   coding only: local, not checked in
//!
//! The mode root is `<vault>/.bnote/agents/<mode>` unless `agent_roots`
//! overrides it (see `home.rs`). The mode file holds what belongs to that
//! agent: `mcpServers`, `skillDirs`, permissions, hooks, output style.
//! Credentials and the model are shared by the modes and stay in the home's
//! `agent.json`.
//!
//! Later files override earlier ones; arrays are concatenated and de-duplicated
//! (CC's merge), objects are merged key by key, scalars take the last value. A
//! malformed file is reported and skipped — it must never stop the app from
//! starting or a session from running.

use crate::agent::home::{self, AgentMode};
use crate::agent::McpServerConfig;
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
    /// Request the model's reasoning channel (Anthropic `thinking` /
    /// GLM `thinking.type` / Qwen `enable_thinking`). Default on (CC keeps
    /// thinking enabled unless the user turns it off); the streamed reasoning
    /// text feeds the transcript's thinking block.
    pub thinking: Option<bool>,
    /// MCP servers of this mode. A coding session never sees the creative
    /// mode's servers (and vice versa): the file that defines them is
    /// per-mode.
    pub mcp_servers: BTreeMap<String, McpServerConfig>,
    /// Extra skill directories for this mode, merged after the built-in roots.
    pub skill_dirs: Vec<String>,
    /// Servers that stay configured but are not connected (the settings page
    /// toggles them off without deleting the entry).
    pub disabled_mcp_servers: Vec<String>,
    /// Skills that stay on disk but are hidden from the model and the `/`
    /// completion.
    pub disabled_skills: Vec<String>,
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

pub fn project_files(project: Option<&Path>) -> Vec<PathBuf> {
    let Some(project) = project else {
        return Vec::new();
    };
    vec![
        project.join(".bnote").join("settings.json"),
        project.join(".bnote").join("settings.local.json"),
    ]
}

/// Every settings file of a session, in merge order. Only coding sessions read
/// the code project's own files; study and creative sessions are confined to
/// their mode root.
pub fn file_list(mode: AgentMode, root: &Path, project: Option<&Path>) -> Vec<PathBuf> {
    let mut files = vec![home::mode_settings_file(root)];
    if mode.reads_project() {
        files.extend(project_files(project));
    }
    files
}

pub fn load(mode: AgentMode, root: &Path, project: Option<&Path>) -> LoadedSettings {
    let mut loaded = LoadedSettings::default();
    for path in file_list(mode, root, project) {
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
    if from.thinking.is_some() {
        into.thinking = from.thinking;
    }
    for (name, server) in from.mcp_servers {
        into.mcp_servers.insert(name, server);
    }
    merge_list(&mut into.skill_dirs, from.skill_dirs);
    merge_list(&mut into.disabled_mcp_servers, from.disabled_mcp_servers);
    merge_list(&mut into.disabled_skills, from.disabled_skills);
}

/// Copies the pre-mode-root configuration at the home root into the coding
/// root, once, without overwriting anything. Before the mode roots existed the
/// user-level files sat directly in the home (`{settings.json,AGENTS.md,rules,
/// skills,output-styles}`) and the MCP/skill settings lived in `agent.json`; a
/// user who already configured them must not lose them when the default moves
/// into the mode roots. Never deletes the source, so nothing is lost if the
/// user switches back. Runs after [`home::migrate_into_vault`], which is what
/// brings those files from the machine-level home `~/.bnote` into the vault.
pub fn migrate_legacy_home(vault: &Path) {
    // Once per vault: a marker in the vault's agent directory means the
    // migration already ran, so deleting a mode file is not undone by the next
    // start.
    let agents_dir = vault.join(".bnote").join("agents");
    let marker = agents_dir.join(".mode-roots-v1");
    if marker.exists() {
        return;
    }
    let root = home::mode_root(AgentMode::Coding, Some(vault));
    if let Err(e) = home::ensure_dir(&root) {
        eprintln!("[bnote] agent root: {e}");
        return;
    }
    let legacy_home = home::home_dir();
    copy_file_if_missing(
        &home::legacy_settings_file(),
        &home::mode_settings_file(&root),
    );
    copy_file_if_missing(
        &legacy_home.join("AGENTS.md"),
        &home::mode_instructions_file(&root),
    );
    copy_dir_if_missing(&legacy_home.join("rules"), &home::mode_rules_dir(&root));
    copy_dir_if_missing(&legacy_home.join("skills"), &home::mode_skills_dir(&root));
    copy_dir_if_missing(
        &legacy_home.join("output-styles"),
        &home::mode_output_styles_dir(&root),
    );
    // Study and creative used to read the vault's single `.bnote/AGENTS.md`
    // (and creative also the vault's `.bnote/skills`). Those scopes are per
    // mode now; copy the files into the mode roots so existing instructions
    // keep working, without the two modes fighting over one file afterwards.
    for mode in [AgentMode::Creative, AgentMode::Study] {
        let mode_root = home::mode_root(mode, Some(vault));
        copy_file_if_missing(
            &vault.join(".bnote").join("AGENTS.md"),
            &home::mode_instructions_file(&mode_root),
        );
    }
    copy_dir_if_missing(
        &vault.join(".bnote").join("skills"),
        &home::mode_skills_dir(&home::mode_root(AgentMode::Creative, Some(vault))),
    );
    // MCP servers and extra skill directories were in agent.json. Fold them
    // into the mode settings file when the user has no settings file yet (or
    // when the copied one has no MCP block at all).
    let cfg = crate::agent::AgentConfig::load();
    if cfg.mcp_servers.is_empty() && cfg.skill_dirs.is_empty() {
        return;
    }
    let path = home::mode_settings_file(&root);
    let mut value: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let mut changed = false;
    if value.get("mcpServers").is_none() && !cfg.mcp_servers.is_empty() {
        if let Ok(servers) = serde_json::to_value(&cfg.mcp_servers) {
            value["mcpServers"] = servers;
            changed = true;
        }
    }
    if value.get("skillDirs").is_none() && !cfg.skill_dirs.is_empty() {
        value["skillDirs"] = serde_json::json!(cfg.skill_dirs);
        changed = true;
    }
    if changed {
        match serde_json::to_string_pretty(&value) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    eprintln!("[bnote] agent settings migration failed: {e}");
                }
            }
            Err(e) => eprintln!("[bnote] agent settings migration failed: {e}"),
        }
    }
    if let Err(e) = home::ensure_dir(&agents_dir) {
        eprintln!("[bnote] agent migration marker: {e}");
        return;
    }
    if let Err(e) = std::fs::write(
        &marker,
        "The per-mode roots were seeded from the old home layout.\n",
    ) {
        eprintln!("[bnote] agent migration marker: {e}");
    }
}

fn copy_file_if_missing(from: &Path, to: &Path) {
    if !from.is_file() || to.exists() {
        return;
    }
    if let Some(parent) = to.parent() {
        if let Err(e) = home::ensure_dir(parent) {
            eprintln!("[bnote] agent migration: {e}");
            return;
        }
    }
    if let Err(e) = std::fs::copy(from, to) {
        eprintln!("[bnote] agent migration {}: {e}", from.display());
    }
}

fn copy_dir_if_missing(from: &Path, to: &Path) {
    if !from.is_dir() || to.exists() {
        return;
    }
    if let Err(e) = copy_tree(from, to) {
        eprintln!("[bnote] agent migration {}: {e}", from.display());
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if !target.exists() {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn merge_list(into: &mut Vec<String>, from: Vec<String>) {
    for item in from {
        if !into.iter().any(|existing| existing == &item) {
            into.push(item);
        }
    }
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
        let root = project.join(".bnote/agents/coding");
        write(
            &root.join("settings.json"),
            r#"{"permissions":{"deny":["Bash(git push:*)"]},"outputStyle":"Learning"}"#,
        );
        write(
            &project.join(".bnote/settings.json"),
            r#"{"permissions":{"deny":["Bash(rm:*)"]},"model":"x"}"#,
        );
        let loaded = load(AgentMode::Coding, &root, Some(&project));
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
    fn only_the_coding_mode_reads_the_project_files() {
        let project = temp("scope");
        write(
            &project.join(".bnote/settings.json"),
            r#"{"permissions":{"deny":["Bash(rm:*)"]}}"#,
        );
        let root = project.join(".bnote/agents/creative");
        let creative = load(AgentMode::Creative, &root, Some(&project));
        assert_eq!(creative.files.len(), 1, "creative has only its own file");
        assert!(creative.files[0]
            .path
            .ends_with("agents/creative/settings.json"));
        assert!(creative.settings.permissions.deny.is_empty());
        let coding = load(AgentMode::Coding, &root, Some(&project));
        assert_eq!(coding.files.len(), 3);
        assert_eq!(
            coding.settings.permissions.deny,
            vec!["Bash(rm:*)".to_string()]
        );
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn mcp_servers_merge_by_name_and_toggles_accumulate() {
        let project = temp("mcp");
        let root = project.join(".bnote/agents/coding");
        write(
            &root.join("settings.json"),
            r#"{"mcpServers":{"a":{"type":"stdio","command":"a"},"b":{"type":"http","url":"http://b"}},"disabledMcpServers":["b"]}"#,
        );
        write(
            &project.join(".bnote/settings.json"),
            r#"{"mcpServers":{"b":{"type":"http","url":"http://b2"}}}"#,
        );
        let s = load(AgentMode::Coding, &root, Some(&project)).settings;
        assert_eq!(s.mcp_servers.len(), 2);
        match &s.mcp_servers["b"] {
            McpServerConfig::Http { url, .. } => assert_eq!(url, "http://b2"),
            other => panic!("unexpected server: {other:?}"),
        }
        assert_eq!(s.disabled_mcp_servers, vec!["b".to_string()]);
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn a_malformed_file_is_reported_and_skipped() {
        let project = temp("bad");
        let root = project.join(".bnote/agents/coding");
        let path = root.join("settings.json");
        write(&path, "{ not json");
        let loaded = load(AgentMode::Coding, &root, None);
        let file = loaded.files.iter().find(|f| f.path == path).unwrap();
        assert!(file.error.is_some());
        assert!(loaded.settings.permissions.deny.is_empty());
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn hook_matchers_accumulate_across_layers() {
        let project = temp("hooks");
        let root = project.join(".bnote/agents/coding");
        write(
            &root.join("settings.json"),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"a"}]}]}}"#,
        );
        write(
            &project.join(".bnote/settings.json"),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"command":"b"}]}]}}"#,
        );
        let s = load(AgentMode::Coding, &root, Some(&project)).settings;
        assert_eq!(s.hooks["PreToolUse"].len(), 2);
        std::fs::remove_dir_all(&project).unwrap();
    }
}
