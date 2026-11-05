//! The agent's user-level home: `~/.bnote`.
//!
//! This is bnote's equivalent of Claude Code's `~/.claude`: the agent's own
//! files (configuration, instructions, skills, session records, task lists,
//! plans, tool results) live here, **not** inside the vault. The vault is the
//! user's notebook; a code project is an unrelated repository — neither is
//! where the agent keeps its state.
//!
//! `BNOTE_HOME` overrides the location (tests and the browser harness use it).
//! Every path helper creates nothing; callers call [`ensure_dir`] where a
//! directory must exist.

use std::path::{Path, PathBuf};

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

pub fn skills_dirs() -> Vec<PathBuf> {
    vec![home_dir().join("skills")]
}

pub fn settings_file() -> PathBuf {
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
