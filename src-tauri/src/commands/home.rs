//! Home file commands for the agent panel.
//!
//! A coding session's transcript lives in the agent home — the vault's
//! `.bnote` — under `projects/<project>/`. The panel writes and reads those
//! files through these commands, which are the only way the frontend can touch
//! the home directory; every path is confined to it.

use super::materials::{summarize_session, SessionMeta};
use super::CmdResult;
use crate::agent::home;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeWorkspace {
    /// `<agent home>/projects/<sanitized project root>`.
    pub dir: String,
}

/// Resolves (and creates) the record directory of a code project.
#[tauri::command]
pub async fn agent_home_workspace(workdir: String) -> CmdResult<HomeWorkspace> {
    let root = PathBuf::from(&workdir);
    if !root.is_dir() {
        return Err(format!("INVALID_WORKDIR: {} 不是目录", workdir));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = home::project_dir(&root);
        home::ensure_dir(&dir)?;
        Ok(HomeWorkspace {
            dir: dir.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Lists the session records of a code project (newest first).
#[tauri::command]
pub async fn agent_home_sessions_list(workdir: String) -> CmdResult<Vec<SessionMeta>> {
    let root = PathBuf::from(&workdir);
    if !root.is_dir() {
        return Err(format!("INVALID_WORKDIR: {} 不是目录", workdir));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = home::project_dir(&root);
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(out);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(meta) = summarize_session(&path) {
                out.push(meta);
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

fn confined(path: &str) -> Result<PathBuf, String> {
    let full = Path::new(path);
    if !full.is_absolute() {
        return Err(format!("INVALID_PATH: {}", path));
    }
    home::ensure_within_home(full)?;
    Ok(full.to_path_buf())
}

#[tauri::command]
pub async fn agent_home_read_file(path: String) -> CmdResult<Option<String>> {
    let full = confined(&path)?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&full) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_home_write_file(path: String, contents: String) -> CmdResult<()> {
    let full = confined(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        std::fs::write(&full, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_home_append_file(path: String, contents: String) -> CmdResult<()> {
    let full = confined(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&full)
            .map_err(|e| format!("WRITE_FAILED: {}", e))?;
        use std::io::Write as _;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Writes the model-generated title back into the metadata line of a coding
/// session record (the same rewrite the vault sessions get).
#[tauri::command]
pub async fn agent_home_set_session_title(
    workdir: String,
    id: String,
    title: String,
) -> CmdResult<()> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("BAD_ARGS: title".into());
    }
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("INVALID_ID: {}", id));
    }
    let root = PathBuf::from(&workdir);
    if !root.is_dir() {
        return Err(format!("INVALID_WORKDIR: {} 不是目录", workdir));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = home::project_dir(&root);
        let path = dir.join(format!("{}.jsonl", id));
        home::ensure_within_home(&path)?;
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("IO: {}", e))?;
        let next = super::materials::retitle_transcript(&raw, &title);
        if next == raw {
            return Ok(());
        }
        let tmp = dir.join(format!(".{}.jsonl.tmp", id));
        std::fs::write(&tmp, next).map_err(|e| format!("IO: {}", e))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("IO: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFileInfo {
    pub path: String,
    pub exists: bool,
    /// A parse error of that file (the UI surfaces it instead of pretending
    /// the file is fine).
    pub error: Option<String>,
    /// `mode` | `project` | `local` (merge order, first wins for display).
    pub kind: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRootInfo {
    pub path: String,
    pub source: String,
    pub exists: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModePaths {
    pub mode: String,
    /// The effective root the mode reads and writes.
    pub root: String,
    /// The vault default, so the UI can show what the override replaces.
    pub default_root: String,
    /// The `agent_roots` override; null = the vault default is in use.
    pub override_path: Option<String>,
    /// Settings files in merge order, with their parse state.
    pub files: Vec<SettingsFileInfo>,
    /// The `AGENTS.md` of the mode root.
    pub instructions: String,
    pub instructions_exists: bool,
    /// The mode's own skills directory.
    pub skills_dir: String,
    /// Every scanned skills root with its source label (empty dirs included).
    pub skill_roots: Vec<SkillRootInfo>,
}

fn mode_paths(
    mode: home::AgentMode,
    root: &std::path::Path,
    default_root: &std::path::Path,
    workdir: Option<&std::path::Path>,
) -> AgentModePaths {
    let project = workdir.filter(|p| p.is_dir());
    let settings_project = if mode.reads_project() { project } else { None };
    let loaded = crate::agent::settings::load(mode, root, settings_project);
    let files = loaded
        .files
        .iter()
        .enumerate()
        .map(|(index, file)| SettingsFileInfo {
            path: file.path.to_string_lossy().to_string(),
            exists: file.exists,
            error: file.error.clone(),
            kind: match index {
                0 => "mode",
                1 => "project",
                _ => "local",
            }
            .to_string(),
        })
        .collect();
    let skill_roots =
        crate::agent::skills::roots_for(mode, root, project, &loaded.settings.skill_dirs)
            .into_iter()
            .map(|r| SkillRootInfo {
                exists: r.path.is_dir(),
                path: r.path.to_string_lossy().to_string(),
                source: r.source.to_string(),
            })
            .collect();
    let instructions = home::mode_instructions_file(root);
    AgentModePaths {
        mode: mode.id().to_string(),
        root: root.to_string_lossy().to_string(),
        default_root: default_root.to_string_lossy().to_string(),
        override_path: crate::agent::AgentConfig::load()
            .agent_root(mode)
            .map(|p| p.to_string_lossy().to_string()),
        files,
        instructions_exists: instructions.is_file(),
        instructions: instructions.to_string_lossy().to_string(),
        skills_dir: home::mode_skills_dir(root).to_string_lossy().to_string(),
        skill_roots,
    }
}

fn mode_from(value: &str) -> Result<home::AgentMode, String> {
    home::AgentMode::parse(value).ok_or_else(|| format!("INVALID_MODE: {value}"))
}

/// The effective paths of one mode: root, settings files, AGENTS.md, skills
/// roots. Everything the settings page shows about "where things live" comes
/// from here, so the UI cannot disagree with the filesystem.
#[tauri::command]
pub async fn agent_mode_paths(
    state: State<'_, AppState>,
    mode: String,
    workdir: Option<String>,
) -> CmdResult<AgentModePaths> {
    let mode = mode_from(&mode)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let root = home::mode_root(mode, vault.as_deref());
        let default_root = home::default_mode_root(mode, vault.as_deref());
        let project = workdir.map(PathBuf::from);
        Ok(mode_paths(mode, &root, &default_root, project.as_deref()))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// The raw text of the mode's `settings.json` (empty when it does not exist).
#[tauri::command]
pub async fn agent_read_mode_settings(
    state: State<'_, AppState>,
    mode: String,
) -> CmdResult<String> {
    let mode = mode_from(&mode)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let root = home::mode_root(mode, vault.as_deref());
        Ok(std::fs::read_to_string(home::mode_settings_file(&root)).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Writes the mode's `settings.json` after checking it is a JSON object: a
/// broken file would silently disable permissions and hooks, so it is rejected
/// before it reaches the disk.
#[tauri::command]
pub async fn agent_write_mode_settings(
    state: State<'_, AppState>,
    mode: String,
    contents: String,
) -> CmdResult<()> {
    let mode = mode_from(&mode)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = contents.trim();
        let value: serde_json::Value = if trimmed.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(trimmed).map_err(|e| format!("INVALID_JSON: {}", e))?
        };
        if !value.is_object() {
            return Err("INVALID_JSON: settings.json must be an object".to_string());
        }
        let root = home::mode_root(mode, vault.as_deref());
        home::ensure_dir(&root)?;
        let path = home::mode_settings_file(&root);
        std::fs::write(&path, format!("{}\n", trimmed)).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// The mode's `AGENTS.md` (null when absent).
#[tauri::command]
pub async fn agent_read_mode_instructions(
    state: State<'_, AppState>,
    mode: String,
) -> CmdResult<Option<String>> {
    let mode = mode_from(&mode)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let root = home::mode_root(mode, vault.as_deref());
        let path = home::mode_instructions_file(&root);
        if !path.is_file() {
            return Ok(None);
        }
        std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("READ_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn agent_write_mode_instructions(
    state: State<'_, AppState>,
    mode: String,
    contents: String,
) -> CmdResult<()> {
    let mode = mode_from(&mode)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let root = home::mode_root(mode, vault.as_deref());
        home::ensure_dir(&root)?;
        let path = home::mode_instructions_file(&root);
        std::fs::write(&path, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Moves one mode's configuration root. `None` (or an empty string) restores
/// the vault default. The directory is created so the settings page can write
/// into it immediately.
#[tauri::command]
pub async fn agent_set_mode_root(
    state: State<'_, AppState>,
    mode: String,
    path: Option<String>,
) -> CmdResult<()> {
    let mode = mode_from(&mode)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cfg = crate::agent::AgentConfig::load();
        let next = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        if let Some(dir) = &next {
            let dir = PathBuf::from(dir);
            if !dir.is_absolute() {
                return Err(format!("INVALID_PATH: {} is not absolute", dir.display()));
            }
            home::ensure_dir(&dir)?;
        }
        if !cfg.set_agent_root(mode, next.as_deref()) {
            return Ok(());
        }
        cfg.save()?;
        let root = home::mode_root(mode, vault.as_deref());
        home::ensure_dir(&root)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Every output style available for a mode (built-ins first, then the mode
/// root's files, then the code project's files).
#[tauri::command]
pub async fn agent_output_styles(
    state: State<'_, AppState>,
    mode: String,
    project: Option<String>,
) -> CmdResult<Vec<crate::agent::output_style::StyleInfo>> {
    let mode = mode_from(&mode)?;
    let vault = state.vault();
    tauri::async_runtime::spawn_blocking(move || {
        let root = home::mode_root(mode, vault.as_deref());
        let project = project
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .filter(|_| mode.reads_project());
        Ok(
            crate::agent::output_style::discover(Some(&root), project.as_deref())
                .into_iter()
                .map(|style| style.info())
                .collect(),
        )
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// One prompt of `history.jsonl` in the agent home, newest first.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub display: String,
    pub project: String,
    pub session_id: String,
    pub timestamp: u64,
}

/// Recent prompts for the ↑ recall. `project` filters to prompts submitted
/// from that project (a coding session's repository); None = everything.
#[tauri::command]
pub async fn agent_history(
    project: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Vec<HistoryEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = home::history_file();
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Ok(Vec::new());
        };
        let limit = limit.unwrap_or(50).clamp(1, 500) as usize;
        let mut out: Vec<HistoryEntry> = Vec::new();
        for line in raw.lines().rev() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(display) = value.get("display").and_then(|v| v.as_str()) else {
                continue;
            };
            let entry_project = value
                .get("project")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if let Some(wanted) = project.as_deref() {
                if entry_project != wanted {
                    continue;
                }
            }
            out.push(HistoryEntry {
                display: display.to_string(),
                project: entry_project.to_string(),
                session_id: value
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                timestamp: value.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0),
            });
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::block_on;

    #[test]
    fn only_the_three_known_mode_ids_parse() {
        assert_eq!(mode_from("coding").expect("coding").id(), "coding");
        // Surrounding whitespace is tolerated: the value crosses IPC.
        assert_eq!(mode_from("  study\n").expect("study").id(), "study");
        for bad in ["", "review", "CODING", "coding2"] {
            let err = mode_from(bad).expect_err("unknown mode must be rejected");
            assert!(err.starts_with("INVALID_MODE"), "{err}");
        }
    }

    #[test]
    fn a_session_title_must_not_be_blank() {
        let err = block_on(agent_home_set_session_title(
            "/tmp".into(),
            "s1".into(),
            "   ".into(),
        ))
        .expect_err("blank title");
        assert_eq!(err, "BAD_ARGS: title");
    }

    /// The id becomes a file name under the project directory: a separator or
    /// a parent component would let the caller write outside it.
    #[test]
    fn a_session_id_cannot_carry_a_path() {
        for id in ["../x", "a/b", "a\\b", ""] {
            let err = block_on(agent_home_set_session_title(
                "/tmp".into(),
                id.into(),
                "title".into(),
            ))
            .expect_err("invalid id must be rejected");
            assert!(err.starts_with("INVALID_ID"), "{id}: {err}");
        }
    }

    #[test]
    fn home_file_paths_must_be_absolute_and_inside_the_home() {
        // `confined` is the only gate between the panel and the agent home, and
        // both halves are checked before any read or write happens.
        let err = confined("relative/note.md").expect_err("relative path");
        assert!(err.starts_with("INVALID_PATH"), "{err}");
        // An absolute path outside the home is refused no matter what the home
        // currently resolves to (the check runs against the live home root).
        let err = confined("/etc/hosts").expect_err("outside the home");
        assert!(err.starts_with("FORBIDDEN"), "{err}");
    }

    #[test]
    fn a_workdir_that_is_not_a_directory_is_rejected_before_touching_the_home() {
        // These commands never reach the home directory with a bad workdir, so
        // a relative or missing path cannot read the machine-level fallback.
        let missing = "/nonexistent-bnote-workdir";
        match block_on(agent_home_workspace(missing.into())) {
            Ok(_) => panic!("a missing workdir must be rejected"),
            Err(err) => assert!(err.starts_with("INVALID_WORKDIR"), "{err}"),
        }
        assert!(block_on(agent_home_sessions_list("/etc/hosts".into()))
            .expect_err("a file is not a workdir")
            .starts_with("INVALID_WORKDIR"));
        assert!(block_on(agent_home_set_session_title(
            missing.into(),
            "s1".into(),
            "title".into(),
        ))
        .expect_err("missing workdir")
        .starts_with("INVALID_WORKDIR"));
    }
}
