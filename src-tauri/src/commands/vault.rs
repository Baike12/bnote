use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use notify::{recommended_watcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{ensure_within, require_vault, validate_name, CmdResult};
use crate::state::AppState;

/// Directories shown in the file tree: `.bnote` is browsable so the agent
/// definitions can be edited as plain files.
const IGNORED_DIRS: &[&str] = &[".git", ".obsidian", ".DS_Store", "node_modules", ".trash"];

/// Directories excluded from the flat note index (quick switcher, wikilinks).
/// `.bnote` holds app state and agent config, not notes.
const INDEX_IGNORED_DIRS: &[&str] = &[
    ".git",
    ".bnote",
    ".obsidian",
    ".DS_Store",
    "node_modules",
    ".trash",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndex {
    /// Flat note-file paths (quick switcher / wikilinks).
    pub files: Vec<String>,
    /// Flat directory paths, including directories that contain no notes.
    pub dirs: Vec<String>,
    /// Flat media paths (images, PDFs). `![…](…)`/`![[…]]` embeds resolve
    /// against this list: Obsidian stores attachments where it likes and
    /// refers to them by bare file name, so the renderer needs the whole
    /// inventory to find one — see `resolveImageCandidates` in the frontend.
    pub assets: Vec<String>,
}

/// Extensions treated as renderable/pasteable media rather than notes.
/// `.excalidraw` scene files belong here too: a drawing embed (`![[x.excalidraw]]`)
/// is resolved by file name, so it has to be found in this inventory; its
/// preview PNG lives next to it under the same name.
fn is_asset_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".svg",
        ".bmp",
        ".avif",
        ".ico",
        ".tif",
        ".tiff",
        ".heic",
        ".pdf",
        ".excalidraw",
        ".excalidraw.md",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    /// Path relative to the vault root, using `/` separators.
    pub rel_path: String,
    pub kind: String, // "file" | "dir"
    /// Directories load lazily: null means "not read yet, call read_dir".
    pub children: Option<Vec<FileNode>>,
}

#[tauri::command]
pub fn set_vault(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<VaultInfo> {
    set_vault_blocking(&app, &state, path)
}

fn set_vault_blocking(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: String,
) -> CmdResult<VaultInfo> {
    eprintln!("[bnote] set_vault: {path}");
    let root =
        std::fs::canonicalize(&path).map_err(|e| format!("INVALID_VAULT: {} ({})", path, e))?;
    if !root.is_dir() {
        return Err(format!("INVALID_VAULT: {} is not a directory", path));
    }

    *state.vault.write().map_err(|_| "lock poisoned")? = Some(root.clone());

    // The agent's home is this vault's `.bnote` (see `agent::home`): point the
    // path helpers at it before anything reads or writes agent state, then move
    // what the old machine-level home (`$HOME/.bnote`) still holds — config
    // with the API key, prompt history, session records — into the vault. The
    // order matters: the move comes first, so every later migration reads the
    // files at their final location.
    crate::agent::home::set_vault(Some(&root));
    if let Err(e) = crate::agent::home::ensure_dir(&root.join(".bnote")) {
        eprintln!("[bnote] agent home: {e}");
    }
    match crate::agent::home::migrate_into_vault(&root) {
        Ok(0) => {}
        Ok(count) => eprintln!("[bnote] agent home moved into the vault: {count} entries"),
        Err(e) => eprintln!("[bnote] agent home migration: {e}"),
    }
    // The config used to live in the app data directory; copy it into the home
    // once (only when the vault has none — the move above may have brought one).
    crate::agent::AgentConfig::migrate_from(&state.data_dir);

    // The mode configuration used to live at the home root; the default is the
    // vault's `.bnote/agents/<mode>` now. Copy the legacy files into the mode
    // roots once (never overwriting).
    crate::agent::settings::migrate_legacy_home(&root);

    // The kanban boards used to share `.bnote/projects` with the agent's coding
    // session records; they live in `.bnote/projects-manager` now. Run before
    // the watcher starts so the first listing already sees the final layout.
    let moved = migrate_kanban_projects(&root);
    if moved > 0 {
        eprintln!("[bnote] kanban projects moved to .bnote/projects-manager: {moved}");
    }

    // Images in notes are rendered through the asset protocol. The vault is the
    // only directory this window may read, and the grant happens here rather
    // than in the static scope because a vault can live anywhere on disk.
    crate::paths::allow_asset_dir(app, &root);

    // Remember the vault for the next launch.
    super::config::persist_last_vault(state, &root.to_string_lossy())?;

    start_watcher(app, state, &root)?;

    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string());
    Ok(VaultInfo {
        path: root.to_string_lossy().to_string(),
        name,
    })
}

/// The kanban project files used to live in `.bnote/projects`, next to the
/// agent's coding session records (one directory per repository). They have
/// their own `.bnote/projects-manager` now.
///
/// Only the top-level `*.md` files are project boards; the directories in
/// `projects/` belong to the agent and stay where they are. A file that
/// already exists in the new directory is not overwritten (its old copy is
/// left in place, so nothing is lost silently).
fn migrate_kanban_projects(vault: &Path) -> usize {
    let old = vault.join(".bnote/projects");
    let new = vault.join(".bnote/projects-manager");
    let Ok(entries) = std::fs::read_dir(&old) else {
        return 0;
    };
    let mut moved = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        if !name.to_string_lossy().to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        let target = new.join(name);
        if target.exists() {
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(&new) {
            eprintln!("[bnote] projects-manager: {e}");
            return moved;
        }
        match std::fs::rename(&path, &target) {
            Ok(()) => moved += 1,
            Err(e) => eprintln!("[bnote] projects-manager: {} ({e})", path.display()),
        }
    }
    moved
}

#[tauri::command]
pub fn get_vault(state: State<'_, AppState>) -> CmdResult<Option<VaultInfo>> {
    Ok(state.vault().map(|root| {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string());
        VaultInfo {
            path: root.to_string_lossy().to_string(),
            name,
        }
    }))
}

/// Root level of the vault; directories arrive with children = null and are
/// read on expand (Obsidian-style lazy tree) so huge vaults open instantly.
#[tauri::command]
pub async fn read_tree(state: State<'_, AppState>) -> CmdResult<Vec<FileNode>> {
    let root = require_vault(&state)?;
    run_blocking(move || {
        eprintln!("[bnote] read_tree");
        Ok(build_level(&root, ""))
    })
    .await
}

/// One level of a directory inside the vault.
#[tauri::command]
pub async fn read_dir(state: State<'_, AppState>, rel_path: String) -> CmdResult<Vec<FileNode>> {
    let root = require_vault(&state)?;
    run_blocking(move || {
        for part in rel_path.split('/') {
            validate_name(part)?;
        }
        let full = root.join(&rel_path);
        ensure_within(&root, &full)?;
        Ok(build_level(&full, &rel_path))
    })
    .await
}

/// Flat list of note files and directories. A single walk without tree
/// building; fast even on big vaults (off the main thread). Directories are
/// indexed even when empty, so quick-add can suggest a newly created folder
/// before its first note exists.
#[tauri::command]
pub async fn list_files(state: State<'_, AppState>) -> CmdResult<VaultIndex> {
    let root = require_vault(&state)?;
    run_blocking(move || {
        eprintln!("[bnote] list_files");
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        let mut assets = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in rd.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                let name = entry.file_name().to_string_lossy().to_string();
                let p = entry.path();
                if ft.is_dir() {
                    if !INDEX_IGNORED_DIRS.contains(&name.as_str()) {
                        if let Ok(rel) = p.strip_prefix(&root) {
                            dirs.push(rel.to_string_lossy().replace('\\', "/"));
                        }
                        stack.push(p);
                    }
                } else if ft.is_file() {
                    if let Ok(rel) = p.strip_prefix(&root) {
                        let rel = rel.to_string_lossy().replace('\\', "/");
                        if is_note_file(&name) {
                            files.push(rel);
                        } else if is_asset_file(&name) {
                            assets.push(rel);
                        }
                    }
                }
            }
        }
        files.sort();
        dirs.sort();
        assets.sort();
        Ok(VaultIndex {
            files,
            dirs,
            assets,
        })
    })
    .await
}

async fn run_blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

fn build_level(dir: &Path, rel_prefix: &str) -> Vec<FileNode> {
    let mut nodes: Vec<(bool, FileNode)> = Vec::new();

    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(ft) = entry.file_type() else { continue };
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix, name)
        };
        if ft.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            nodes.push((
                true,
                FileNode {
                    name,
                    rel_path: rel,
                    kind: "dir".into(),
                    children: None,
                },
            ));
        } else if ft.is_file() && is_tree_file(&name) {
            nodes.push((
                false,
                FileNode {
                    name,
                    rel_path: rel,
                    kind: "file".into(),
                    children: None,
                },
            ));
        }
    }

    nodes.sort_by_key(|(_, n)| n.name.to_lowercase());
    let mut dirs: Vec<FileNode> = Vec::new();
    let mut files: Vec<FileNode> = Vec::new();
    for (is_dir, node) in nodes {
        if is_dir {
            dirs.push(node);
        } else {
            files.push(node);
        }
    }
    dirs.extend(files);
    dirs
}

/// The Excalidraw plugin's markdown wrapper holds a drawing, not a note: were
/// it listed as a note, quick switch would open it as a note (a screenful of
/// JSON). They belong to the asset inventory instead, via is_asset_file.
/// Files the sidebar tree shows: notes plus JSON files under `.bnote` (project
/// files, settings). The flat index stays notes-only (`is_note_file`).
fn is_tree_file(name: &str) -> bool {
    is_note_file(name) || name.to_lowercase().ends_with(".json")
}

fn is_note_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.ends_with(".excalidraw.md") {
        return false;
    }
    [".md", ".markdown", ".txt"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Watches the vault with plain notify (FSEvents registration is O(1)) and a
/// hand-rolled debouncer, then emits `vault-changed` to the UI. Unlike
/// notify-debouncer-full this avoids the initial full-tree file-id scan that
/// froze large vaults.
fn start_watcher(app: &AppHandle, state: &State<'_, AppState>, root: &PathBuf) -> CmdResult<()> {
    let mut guard = state.watcher.lock().map_err(|_| "lock poisoned")?;
    // Signal the previous debounce thread to stop, then unregister its watch.
    if let Some(old) = guard.take() {
        old.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        drop(old);
    }

    let app_handle = app.clone();
    let (tx, rx) = mpsc::channel::<std::result::Result<notify::Event, notify::Error>>();
    let mut watcher = recommended_watcher(tx).map_err(|e| format!("WATCHER_FAILED: {}", e))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("WATCHER_FAILED: {}", e))?;

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_thread = stop.clone();

    std::thread::spawn(move || {
        let mut pending: std::collections::HashSet<String> = std::collections::HashSet::new();
        loop {
            if stop_thread.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            // Batch events; emit once the stream stays quiet for 300ms.
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(Ok(event)) => {
                    for p in event.paths {
                        pending.insert(p.to_string_lossy().to_string());
                    }
                }
                Ok(Err(e)) => {
                    eprintln!("[bnote] watch error: {e}");
                }
                Err(_timeout) => {
                    if !pending.is_empty() {
                        let paths: Vec<String> = pending.drain().collect();
                        let _ = app_handle.emit("vault-changed", paths);
                    }
                }
            }
        }
    });

    *guard = Some(crate::state::WatcherHandle {
        _watcher: watcher,
        stop,
    });
    Ok(())
}

/// Resolves a relative path against the vault, for read_vault_file etc.
pub(crate) fn vault_join(state: &AppState, rel: &str) -> CmdResult<PathBuf> {
    let root = require_vault(state)?;
    for part in rel.split('/') {
        validate_name(part)?;
    }
    let full = root.join(rel);
    ensure_within(&root, &full)?;
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{app_with_vault, block_on, vault_root};
    use std::path::{Path, PathBuf};

    fn put(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, body).expect("write");
    }

    fn temp_vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bnote-vault-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".bnote/projects")).expect("temp vault");
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, text).expect("write");
    }

    #[test]
    fn kanban_boards_move_but_session_directories_stay() {
        let vault = temp_vault("projects-move");
        let old = vault.join(".bnote/projects");
        write(&old.join("读书.md"), "- [ ] a");
        write(&old.join("-Users-me-repo/s1.jsonl"), "{}\n");

        assert_eq!(migrate_kanban_projects(&vault), 1);
        assert_eq!(
            std::fs::read_to_string(vault.join(".bnote/projects-manager/读书.md")).expect("moved"),
            "- [ ] a"
        );
        assert!(!old.join("读书.md").exists());
        assert!(old.join("-Users-me-repo/s1.jsonl").exists());
        // Idempotent: a second run finds no board left to move.
        assert_eq!(migrate_kanban_projects(&vault), 0);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_existing_board_is_not_overwritten() {
        let vault = temp_vault("projects-conflict");
        let old = vault.join(".bnote/projects");
        write(&old.join("读书.md"), "- [ ] old");
        write(&vault.join(".bnote/projects-manager/读书.md"), "- [ ] new");

        assert_eq!(migrate_kanban_projects(&vault), 0);
        assert_eq!(
            std::fs::read_to_string(vault.join(".bnote/projects-manager/读书.md")).expect("kept"),
            "- [ ] new"
        );
        assert!(old.join("读书.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn note_extensions_are_recognized_case_insensitively() {
        for name in ["a.md", "A.MD", "b.markdown", "c.txt"] {
            assert!(is_note_file(name), "{name} must count as a note");
        }
        for name in ["a.png", "b.json", "c.pdf", "d"] {
            assert!(!is_note_file(name), "{name} is not a note");
        }
    }

    #[test]
    fn an_excalidraw_wrapper_is_an_asset_not_a_note() {
        // The wrapper is a screenful of JSON; listing it as a note made quick
        // switch open it in the editor.
        assert!(!is_note_file("drawing.excalidraw.md"));
        assert!(!is_note_file("DRAWING.EXCALIDRAW.MD"));
        assert!(is_asset_file("drawing.excalidraw.md"));
        assert!(is_asset_file("drawing.excalidraw"));
    }

    #[test]
    fn media_extensions_are_assets_while_notes_are_not() {
        for name in ["a.png", "b.JPG", "c.jpeg", "d.svg", "e.pdf", "f.heic"] {
            assert!(is_asset_file(name), "{name} must count as an asset");
        }
        for name in ["a.md", "b.txt", "c.rs"] {
            assert!(!is_asset_file(name), "{name} is not an asset");
        }
    }

    #[test]
    fn the_tree_shows_json_but_the_note_index_does_not() {
        // `.bnote` settings and project files are editable from the sidebar,
        // while wikilinks/quick switch stay notes-only.
        assert!(is_tree_file("settings.json"));
        assert!(is_tree_file("note.md"));
        assert!(!is_tree_file("image.png"));
        assert!(!is_tree_file("drawing.excalidraw.md"));
    }

    #[test]
    fn one_tree_level_lists_directories_before_files_sorted_case_insensitively() {
        let vault = temp_vault("tree-level");
        put(&vault, "zeta.md", "");
        put(&vault, "Alpha.md", "");
        put(&vault, "sub/inner.md", "");
        put(&vault, ".git/config", "");
        put(&vault, "node_modules/pkg/i.js", "");
        put(&vault, "image.png", "");
        put(&vault, "settings.json", "{}");

        let nodes = build_level(&vault, "");
        let names: Vec<(&str, &str)> = nodes
            .iter()
            .map(|n| (n.name.as_str(), n.kind.as_str()))
            .collect();
        // Directories first, then files; each group sorted by lowercase name.
        // `.bnote` stays browsable (its agent definitions are edited as plain
        // files) while `.git` and `node_modules` are hidden.
        assert_eq!(
            names,
            vec![
                (".bnote", "dir"),
                ("sub", "dir"),
                ("Alpha.md", "file"),
                ("settings.json", "file"),
                ("zeta.md", "file"),
            ]
        );
        // Directories arrive unread: the UI calls read_dir on expand.
        assert!(nodes.iter().all(|n| n.children.is_none()));
        assert_eq!(nodes[1].rel_path, "sub");

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_nested_level_prefixes_every_relative_path() {
        let vault = temp_vault("tree-nested");
        put(&vault, "a/b/c.md", "");
        put(&vault, "a/b/d/e.md", "");

        let nodes = build_level(&vault.join("a/b"), "a/b");
        let rels: Vec<&str> = nodes.iter().map(|n| n.rel_path.as_str()).collect();
        // A directory sorts before a file even when its name is later.
        assert_eq!(rels, vec!["a/b/d", "a/b/c.md"]);
        // An unreadable directory yields an empty level instead of an error:
        // the tree stays usable when one folder disappears mid-click.
        assert!(build_level(&vault.join("missing"), "missing").is_empty());

        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_flat_index_sorts_notes_directories_and_assets_and_skips_app_state() {
        let fixture = app_with_vault("vault-index");
        let root = vault_root(&fixture);
        put(&root, "b.md", "");
        put(&root, "a/deep/c.md", "");
        put(&root, "z.png", "");
        put(&root, "a/pic.jpg", "");
        put(&root, ".bnote/agent.md", "");
        put(&root, ".git/config", "");
        put(&root, "node_modules/pkg/i.js", "");

        let index = block_on(list_files(fixture.state())).expect("index");
        assert_eq!(index.files, vec!["a/deep/c.md", "b.md"]);
        // Directories are indexed even when they hold no notes, so quick-add
        // can offer a folder created a moment ago.
        assert_eq!(index.dirs, vec!["a", "a/deep"]);
        assert_eq!(index.assets, vec!["a/pic.jpg", "z.png"]);
        // `.bnote` holds app state and agent config: not notes, not assets.
        assert!(!index.files.iter().any(|p| p.starts_with(".bnote")));
        assert!(!index.dirs.iter().any(|p| p.starts_with(".bnote")));
    }

    #[test]
    fn read_tree_requires_a_vault_and_reads_the_root_level() {
        let no_vault = crate::commands::test_support::app("vault-no-tree");
        match block_on(read_tree(no_vault.state())) {
            Ok(_) => panic!("read_tree must require an open vault"),
            Err(err) => assert!(err.starts_with("NO_VAULT"), "{err}"),
        }

        let fixture = app_with_vault("vault-tree");
        put(&vault_root(&fixture), "note.md", "");
        let nodes = block_on(read_tree(fixture.state())).expect("tree");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].rel_path, "note.md");
    }

    #[test]
    fn read_dir_rejects_a_traversing_relative_path() {
        let fixture = app_with_vault("vault-read-dir");
        match block_on(read_dir(fixture.state(), "../..".into())) {
            Ok(_) => panic!("traversal must be rejected"),
            Err(err) => assert!(err.starts_with("INVALID_NAME"), "{err}"),
        }
    }

    #[test]
    fn vault_join_confines_every_relative_path_it_resolves() {
        let fixture = app_with_vault("vault-join");
        let root = vault_root(&fixture);
        let joined = vault_join(&fixture.state(), ".bnote/vimrc").expect("inside");
        assert_eq!(joined, root.join(".bnote/vimrc"));
        assert!(vault_join(&fixture.state(), "../outside").is_err());
        // Every segment is validated first, so `..` is refused even when the
        // normalized result would still be inside.
        assert!(vault_join(&fixture.state(), "a/../b").is_err());
        assert!(vault_join(&fixture.state(), "a/b/c").is_ok());
    }

    #[test]
    fn get_vault_reports_the_root_and_its_directory_name() {
        let fixture = app_with_vault("vault-info");
        let info = get_vault(fixture.state()).expect("vault").expect("open");
        assert_eq!(info.name, "vault");
        assert!(info.path.ends_with("vault"));
    }
}
