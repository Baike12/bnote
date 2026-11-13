//! The agent's home and the per-mode configuration roots.
//!
//! **The home is the open vault's `.bnote`.** Everything the agent keeps —
//! session records, task lists, plans, memory, prompt history, its own config
//! (`agent.json`, the API key) — lives next to the notes, so a notebook is the
//! single directory the app writes to. `$HOME/.bnote` is only the fallback
//! when no vault is open, and the source of the one-time migration into the
//! vault (`migrate_into_vault`).
//!
//! Two kinds of files under the home:
//!
//! - **Runtime state** (session records, task lists, plans, memory, prompt
//!   history) belongs to the agent: `projects/<sanitized project>/`,
//!   `tasks/`, `plans/`, `history.jsonl`, `agent.json`.
//! - **Per-mode configuration** (`settings.json`, `AGENTS.md`, `skills/`,
//!   `rules/`, `output-styles/`) lives in `<home>/agents/<mode>/`, so it
//!   travels with the notebook and every mode keeps its own instructions.
//!   `agent.json` may override a mode root (`agent_roots`).
//!
//! `BNOTE_HOME` overrides the home directory (tests and the browser harness use
//! it). Every path helper creates nothing; callers call [`ensure_dir`] where a
//! directory must exist.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

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

/// The vault whose `.bnote` is the agent home.
///
/// Process-wide because the path helpers below are free functions reached from
/// tool calls, hooks and subagents; threading the vault through every one of
/// them would only move the same fact into a parameter on every signature. It
/// has one writer: `set_vault` in `commands/vault.rs`.
static VAULT: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Points the agent home at the open vault (`None` = the machine-level
/// fallback, which is where the one-time migration reads from).
pub fn set_vault(vault: Option<&Path>) {
    if let Ok(mut slot) = VAULT.write() {
        *slot = vault.map(Path::to_path_buf);
    }
}

fn current_vault() -> Option<PathBuf> {
    VAULT.read().ok().and_then(|slot| slot.clone())
}

/// `$HOME`: the user's home directory (the instruction walk stops here).
pub fn user_home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
}

/// `$HOME/.bnote`: the machine-level home. Only the pre-vault fallback and the
/// one-time migration read it now.
pub fn machine_home() -> PathBuf {
    user_home().join(".bnote")
}

/// The agent home: the open vault's `.bnote`, else `$HOME/.bnote`.
pub fn home_dir() -> PathBuf {
    resolve_home(
        std::env::var(HOME_ENV).ok().as_deref(),
        current_vault(),
        machine_home(),
    )
}

/// The resolution itself, pure so it is testable without process-wide state:
/// the env override wins, then the vault, then the machine home.
fn resolve_home(env: Option<&str>, vault: Option<PathBuf>, machine: PathBuf) -> PathBuf {
    if let Some(value) = env.map(str::trim) {
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }
    match vault {
        Some(vault) => vault.join(".bnote"),
        None => machine,
    }
}

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))
}

/// The marker the one-time migration leaves in the vault's `.bnote`.
const HOME_MARKER: &str = ".home-v1";

/// `EXDEV`: the two paths sit on different volumes, so a rename cannot work.
const EXDEV: i32 = 18;

/// Where a file the vault already has is parked instead of being overwritten.
const CONFLICTS_DIR: &str = ".home-v1-conflicts";

/// Moves the machine-level home into the vault, once.
///
/// The agent home used to be `$HOME/.bnote` for every vault; it is the open
/// vault's `.bnote` now. Everything the old layout left behind — the config
/// with the API key, the prompt history, the coding session records, task
/// lists, plans — is moved there as-is: the relative layout does not change, so
/// a record keeps its name and the session list finds it again.
///
/// Merged, not bulleted: a directory both sides have (`projects/` holds the
/// session records here and the kanban project notes there) keeps the vault's
/// entries and receives the machine's. A *file* both sides have is genuinely
/// ambiguous, so the vault's copy wins and the machine's is parked in
/// [`CONFLICTS_DIR`] — the home ends up empty either way, and nothing is lost.
///
/// All-or-nothing: a failure undoes every move and leaves the marker unwritten,
/// because a half-moved home would silently drop the rest of the history on the
/// next launch.
pub fn migrate_into_vault(vault: &Path) -> Result<usize, String> {
    migrate_home(&machine_home(), &vault.join(".bnote"))
}

fn migrate_home(source: &Path, target: &Path) -> Result<usize, String> {
    let marker = target.join(HOME_MARKER);
    if marker.exists() || !source.is_dir() {
        return Ok(0);
    }
    ensure_dir(target)?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    if let Err(error) = move_contents(source, target, &mut moved) {
        for (from, to) in moved.iter().rev() {
            let _ = move_entry(to, from);
        }
        return Err(error);
    }
    std::fs::write(&marker, format!("entries: {}\n", moved.len()))
        .map_err(|e| format!("WRITE_FAILED: {} ({e})", marker.display()))?;
    // Dot files (`.DS_Store`, editor swap files) are not agent state and may
    // keep the directory; give it back when nothing is left.
    let _ = std::fs::remove_dir(source);
    Ok(moved.len())
}

/// Moves every entry of `source` into `target`, merging directories.
fn move_contents(
    source: &Path,
    target: &Path,
    moved: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(source)
        .map_err(|e| format!("READ_FAILED: {} ({e})", source.display()))?;
    let mut names: Vec<std::ffi::OsString> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name())
        .filter(|name| !name.to_string_lossy().starts_with('.'))
        .collect();
    names.sort();
    for name in names {
        let from = source.join(&name);
        let to = target.join(&name);
        if from.is_dir() && to.is_dir() {
            move_contents(&from, &to, moved)?;
            continue;
        }
        // A file both sides have (or a directory the other side has as a file):
        // the vault's entry stays, the machine's is parked.
        let destination = if to.exists() {
            conflict_path(target, &name)
        } else {
            to
        };
        move_entry(&from, &destination).map_err(|e| {
            format!(
                "MOVE_FAILED: {} → {} ({e})",
                from.display(),
                destination.display()
            )
        })?;
        moved.push((destination, from));
    }
    Ok(())
}

/// `<target>/.home-v1-conflicts/<name>`, with a counter when the name is taken.
fn conflict_path(target: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let dir = target.join(CONFLICTS_DIR);
    let mut path = dir.join(name);
    let stem = Path::new(name);
    let mut index = 1;
    while path.exists() {
        let renamed = match (stem.file_stem(), stem.extension()) {
            (Some(base), Some(ext)) => {
                let mut base = base.to_os_string();
                base.push(format!(".{index}"));
                base.push(".");
                base.push(ext);
                base
            }
            _ => {
                let mut base = name.to_os_string();
                base.push(format!(".{index}"));
                base
            }
        };
        path = dir.join(renamed);
        index += 1;
    }
    path
}

fn move_entry(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(EXDEV) => {
            copy_tree(from, to)?;
            remove_tree(from)
        }
        Err(error) => Err(error),
    }
}

/// Copies a file, a symlink or a whole directory (the cross-volume path of the
/// migration; a rename covers the same-volume case).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else if meta.is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

fn remove_tree(from: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(from)
    } else {
        std::fs::remove_file(from)
    }
}

/// `<vault>/.bnote/agents/<mode>`. Without a vault the mode root falls back to
/// `<home>/agents/<mode>` so the settings page still has a real path before a
/// notebook is opened.
pub fn default_mode_root(mode: AgentMode, vault: Option<&Path>) -> PathBuf {
    match vault {
        Some(vault) => vault.join(".bnote").join("agents").join(mode.id()),
        None => home_dir().join("agents").join(mode.id()),
    }
}

/// The effective mode root: the `agent_roots` override of `<home>/agent.json`
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

/// `<home>/projects/<sanitized project root>`.
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

/// `<home>/tasks/<list id>` (Claude Code's `getTasksDir`).
pub fn tasks_dir(list_id: &str) -> PathBuf {
    home_dir().join("tasks").join(sanitize_path(list_id))
}

/// One session's todo list: `<agent home>/todos/<session list id>.json`. Keyed
/// like the task list (the record id of the session), so a restore finds it.
pub fn todo_file(list_id: &str) -> PathBuf {
    home_dir()
        .join("todos")
        .join(format!("{}.json", sanitize_path(list_id)))
}

pub fn plans_dir() -> PathBuf {
    home_dir().join("plans")
}

/// `<home>/projects/<key>/memory` — the project's long-term memory.
pub fn memory_dir(root: &Path) -> PathBuf {
    project_dir(root).join("memory")
}

/// The pre-mode-root settings file at the home root. Kept only as the one-time
/// migration source for the coding root; nothing reads it at runtime any more.
pub fn legacy_settings_file() -> PathBuf {
    home_dir().join("settings.json")
}

pub fn history_file() -> PathBuf {
    home_dir().join("history.jsonl")
}

/// `<home>/logs/requests` — the debug records of model requests (one file per
/// conversation, written only while the `logRequests` setting is on).
pub fn request_log_dir() -> PathBuf {
    home_dir().join("logs").join("requests")
}

/// `.../logs/requests/<key>.jsonl`. The key is the conversation's transcript
/// record id, so a restored conversation appends to the same file.
pub fn request_log_file(key: &str) -> PathBuf {
    request_log_dir().join(format!("{}.jsonl", sanitize_path(key)))
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
        assert_eq!(
            request_log_file("s1"),
            PathBuf::from("/tmp/bnote-home-test/logs/requests/s1.jsonl")
        );
        std::env::remove_var(HOME_ENV);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bnote-home-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn the_home_is_the_vault_unless_the_environment_says_otherwise() {
        let machine = PathBuf::from("/Users/u/.bnote");
        assert_eq!(
            resolve_home(
                Some("/tmp/override"),
                Some(PathBuf::from("/notes")),
                machine.clone()
            ),
            PathBuf::from("/tmp/override")
        );
        assert_eq!(
            resolve_home(None, Some(PathBuf::from("/notes")), machine.clone()),
            PathBuf::from("/notes/.bnote")
        );
        assert_eq!(resolve_home(Some("  "), None, machine.clone()), machine);
    }

    #[test]
    fn the_migration_moves_every_entry_and_marks_the_vault() {
        let base = temp_dir("migrate");
        let source = base.join("home");
        let target = base.join("vault/.bnote");
        std::fs::create_dir_all(source.join("projects/-p")).expect("source");
        std::fs::write(source.join("projects/-p/s1.jsonl"), "{}\n").expect("record");
        std::fs::write(source.join("agent.json"), "{}").expect("config");
        std::fs::write(source.join(".DS_Store"), "junk").expect("dot file");

        assert_eq!(migrate_home(&source, &target).expect("migrate"), 2);
        assert_eq!(
            std::fs::read_to_string(target.join("projects/-p/s1.jsonl")).expect("moved record"),
            "{}\n"
        );
        assert!(target.join("agent.json").exists());
        assert!(target.join(HOME_MARKER).exists(), "marker written last");
        assert!(!source.join("agent.json").exists(), "source cleared");
        assert!(
            source.join(".DS_Store").exists(),
            "dot files are not agent state"
        );

        // Once only: a later launch must not touch the home again.
        std::fs::write(source.join("history.jsonl"), "{}\n").expect("new file");
        assert_eq!(migrate_home(&source, &target).expect("second run"), 0);
        assert!(source.join("history.jsonl").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_file_the_vault_already_has_is_parked_not_overwritten() {
        let base = temp_dir("collide");
        let source = base.join("home");
        let target = base.join("vault/.bnote");
        std::fs::create_dir_all(&source).expect("source");
        std::fs::create_dir_all(&target).expect("target");
        std::fs::write(source.join("agent.json"), "{\"old\":true}").expect("source config");
        std::fs::write(target.join("agent.json"), "{\"new\":true}").expect("vault config");

        assert_eq!(migrate_home(&source, &target).expect("migrate"), 1);
        assert_eq!(
            std::fs::read_to_string(target.join("agent.json")).expect("vault config"),
            "{\"new\":true}"
        );
        assert_eq!(
            std::fs::read_to_string(target.join(CONFLICTS_DIR).join("agent.json"))
                .expect("parked config"),
            "{\"old\":true}"
        );
        assert!(!source.join("agent.json").exists(), "the home is emptied");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_directory_both_sides_have_is_merged() {
        let base = temp_dir("merge");
        let source = base.join("home");
        let target = base.join("vault/.bnote");
        std::fs::create_dir_all(source.join("projects/-Users-me-proj")).expect("source");
        std::fs::create_dir_all(target.join("projects")).expect("target");
        std::fs::write(source.join("projects/-Users-me-proj/s1.jsonl"), "{}\n").expect("record");
        std::fs::write(target.join("projects/board.md"), "- [ ] task\n").expect("kanban");

        assert_eq!(migrate_home(&source, &target).expect("migrate"), 1);
        assert!(target.join("projects/-Users-me-proj/s1.jsonl").exists());
        assert!(
            target.join("projects/board.md").exists(),
            "the vault's own entries stay"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_todo_file_of_one_session_is_keyed_by_its_list_id() {
        let path = todo_file("s1794549391820-1");
        assert!(
            path.ends_with("todos/s1794549391820-1.json"),
            "{}",
            path.display()
        );
        // The id reaches a file name: everything outside [A-Za-z0-9] is folded,
        // so a slash or a dot can never escape the directory.
        let unsafe_path = todo_file("../a/b:c");
        assert!(
            unsafe_path.ends_with("todos/---a-b-c.json"),
            "{}",
            unsafe_path.display()
        );
    }
}
