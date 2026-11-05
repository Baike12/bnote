//! The agent's runtime home (`~/.bnote`) and the per-mode configuration roots.
//!
//! Two kinds of files, two owners:
//!
//! - **Runtime state** (session records, task lists, plans, memory, prompt
//!   history) belongs to the machine and lives in `~/.bnote`: a session record
//!   is not a note, and a code project is not the notebook.
//! - **Per-mode configuration** (`settings.json`, `AGENTS.md`, `skills/`,
//!   `rules/`, `output-styles/`) belongs to the mode and the vault:
//!   `<vault>/.bnote/agents/<mode>/` by default, so it travels with the
//!   notebook. `~/.bnote/agent.json` may override each mode root
//!   (`agent_roots`), which is the only reason that file stays in the home
//!   directory: a path cannot be stored inside the directory it moves.
//!
//! Credentials and the model are machine-level (one API key per machine), so
//! they stay in `~/.bnote/agent.json` for every mode.
//!
//! `BNOTE_HOME` overrides the home directory (tests and the browser harness use
//! it). Every path helper creates nothing; callers call [`ensure_dir`] where a
//! directory must exist.

use std::path::{Path, PathBuf};

/// The three agent shapes. The id is also the definition id in
/// `defs::registry()` and the folder name under `<vault>/.bnote/agents`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMode {
    Coding,
    Creative,
    Study,
}

impl AgentMode {
    pub fn id(self) -> &'static str {
        match self {
            AgentMode::Coding => "coding",
            AgentMode::Creative => "creative",
            AgentMode::Study => "study",
        }
    }

    pub fn parse(value: &str) -> Option<AgentMode> {
        match value.trim() {
            "coding" => Some(AgentMode::Coding),
            "creative" => Some(AgentMode::Creative),
            "study" => Some(AgentMode::Study),
            _ => None,
        }
    }

    /// Whether the mode reads the code project's own configuration on top of
    /// its root (only the coding agent is projected onto a repository).
    pub fn reads_project(self) -> bool {
        self == AgentMode::Coding
    }
}

/// Environment override for the home directory.
pub const HOME_ENV: &str = "BNOTE_HOME";

/// `~/.bnote`, or `$BNOTE_HOME`.
pub fn home_dir() -> PathBuf {
    if let Ok(value) = std::env::var(HOME_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".bnote")
}

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))
}

/// `<vault>/.bnote/agents/<mode>`. Without a vault the mode root falls back to
/// `~/.bnote/agents/<mode>` so the settings page still has a real path before
/// a notebook is opened.
pub fn default_mode_root(mode: AgentMode, vault: Option<&Path>) -> PathBuf {
    match vault {
        Some(vault) => vault.join(".bnote").join("agents").join(mode.id()),
        None => home_dir().join("agents").join(mode.id()),
    }
}

/// The effective mode root: the `agent_roots` override of `~/.bnote/agent.json`
/// when set, the vault default otherwise.
pub fn mode_root(mode: AgentMode, vault: Option<&Path>) -> PathBuf {
    match crate::agent::AgentConfig::load().agent_root(mode) {
        Some(path) => path,
        None => default_mode_root(mode, vault),
    }
}

pub fn mode_settings_file(root: &Path) -> PathBuf {
    root.join("settings.json")
}

pub fn mode_instructions_file(root: &Path) -> PathBuf {
    root.join("AGENTS.md")
}

pub fn mode_skills_dir(root: &Path) -> PathBuf {
    root.join("skills")
}

pub fn mode_rules_dir(root: &Path) -> PathBuf {
    root.join("rules")
}

pub fn mode_output_styles_dir(root: &Path) -> PathBuf {
    root.join("output-styles")
}

/// `~/.agents/skills`: the Agent Skills convention shared by other tools.
pub fn shared_agents_skills() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".agents")
        .join("skills")
}

/// Claude Code's `sanitizePath` (sessionStoragePortable.ts): every character
/// that is not an ASCII letter or digit becomes `-`. Paths longer than 200
/// characters are truncated and given a stable hash suffix so two long paths
/// with the same prefix cannot collide.
pub fn sanitize_path(path: &str) -> String {
    let mapped: String = path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if mapped.chars().count() <= 200 {
        return mapped;
    }
    let head: String = mapped.chars().take(200).collect();
    format!("{}-{:016x}", head, fnv1a(path.as_bytes()))
}

/// FNV-1a 64-bit: stable across runs and platforms (no dependency).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// `~/.bnote/projects/<sanitized project root>`.
pub fn project_dir(root: &Path) -> PathBuf {
    home_dir()
        .join("projects")
        .join(sanitize_path(&root.to_string_lossy()))
}

/// `.../projects/<key>/<session id>` — the per-session runtime directory.
pub fn session_dir(root: &Path, session_id: &str) -> PathBuf {
    project_dir(root).join(sanitize_path(session_id))
}

/// `.../projects/<key>/<session id>.jsonl` — the main transcript.
pub fn session_transcript(root: &Path, session_id: &str) -> PathBuf {
    project_dir(root).join(format!("{}.jsonl", sanitize_path(session_id)))
}

pub fn subagents_dir(root: &Path, session_id: &str) -> PathBuf {
    session_dir(root, session_id).join("subagents")
}

pub fn tool_results_dir(root: &Path, session_id: &str) -> PathBuf {
    session_dir(root, session_id).join("tool-results")
}

/// `~/.bnote/tasks/<list id>` (Claude Code's `getTasksDir`).
pub fn tasks_dir(list_id: &str) -> PathBuf {
    home_dir().join("tasks").join(sanitize_path(list_id))
}

pub fn plans_dir() -> PathBuf {
    home_dir().join("plans")
}

/// `~/.bnote/projects/<key>/memory` — the project's long-term memory.
pub fn memory_dir(root: &Path) -> PathBuf {
    project_dir(root).join("memory")
}

/// The pre-mode-root settings file. Kept only as the one-time migration source
/// for the coding root; nothing reads it at runtime any more.
pub fn legacy_settings_file() -> PathBuf {
    home_dir().join("settings.json")
}

pub fn history_file() -> PathBuf {
    home_dir().join("history.jsonl")
}

/// The agent configuration file (provider/model/api key/MCP).
pub fn config_file() -> PathBuf {
    home_dir().join("agent.json")
}

/// Confines a caller-supplied path to the home directory (the path may not
/// exist yet).
pub fn ensure_within_home(path: &Path) -> Result<(), String> {
    crate::paths::ensure_within(&home_dir(), path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_every_non_alphanumeric_character() {
        assert_eq!(
            sanitize_path("/Users/a/CodeRepo/bnote"),
            "-Users-a-CodeRepo-bnote"
        );
        assert_eq!(sanitize_path("a_b.c"), "a-b-c");
    }

    #[test]
    fn long_paths_are_truncated_with_a_stable_hash() {
        let long = "a".repeat(300);
        let first = sanitize_path(&long);
        let second = sanitize_path(&long);
        assert_eq!(first, second);
        assert_eq!(first.chars().count(), 200 + 1 + 16);
        let other = sanitize_path(&format!("{long}b"));
        assert_ne!(first, other, "the hash separates equal prefixes");
    }

    #[test]
    fn project_paths_live_under_projects() {
        let dir = project_dir(Path::new("/tmp/proj"));
        assert!(dir.ends_with("projects/-tmp-proj"));
        assert!(session_transcript(Path::new("/tmp/proj"), "s1")
            .ends_with("projects/-tmp-proj/s1.jsonl"));
        assert!(subagents_dir(Path::new("/tmp/proj"), "s1")
            .ends_with("projects/-tmp-proj/s1/subagents"));
    }

    #[test]
    fn the_mode_root_defaults_to_the_vault_and_falls_back_to_home() {
        let vault = Path::new("/notes/mine");
        assert_eq!(
            default_mode_root(AgentMode::Coding, Some(vault)),
            PathBuf::from("/notes/mine/.bnote/agents/coding")
        );
        assert_eq!(
            default_mode_root(AgentMode::Creative, Some(vault)),
            PathBuf::from("/notes/mine/.bnote/agents/creative")
        );
        assert_eq!(
            default_mode_root(AgentMode::Study, Some(vault)),
            PathBuf::from("/notes/mine/.bnote/agents/study")
        );
        assert!(default_mode_root(AgentMode::Study, None).ends_with("agents/study"));
    }

    #[test]
    fn mode_files_hang_off_the_root() {
        let root = Path::new("/tmp/agents/coding");
        assert_eq!(mode_settings_file(root), root.join("settings.json"));
        assert_eq!(mode_instructions_file(root), root.join("AGENTS.md"));
        assert_eq!(mode_skills_dir(root), root.join("skills"));
        assert_eq!(mode_rules_dir(root), root.join("rules"));
        assert_eq!(mode_output_styles_dir(root), root.join("output-styles"));
    }

    #[test]
    fn the_home_override_changes_every_path() {
        std::env::set_var(HOME_ENV, "/tmp/bnote-home-test");
        assert_eq!(home_dir(), PathBuf::from("/tmp/bnote-home-test"));
        assert_eq!(
            tasks_dir("s1"),
            PathBuf::from("/tmp/bnote-home-test/tasks/s1")
        );
        std::env::remove_var(HOME_ENV);
    }
}
