use serde::Serialize;
use tauri::State;

use super::{ensure_within, require_vault, validate_name, CmdResult};
use crate::commands::vault::vault_join;
use crate::state::AppState;

/// Files inside `<vault>/.bnote/` that the app reads as configuration.
const VAULT_CONFIG_FILES: &[&str] = &[
    "vimrc",
    "snippets.js",
    "keybindings.json",
    "agent.md",
    "AGENTS.md",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEntry {
    pub path: String,
    pub rel_path: String,
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        eprintln!("[bnote] read_file: {}", full.display());
        std::fs::read_to_string(&full).map_err(|e| format!("READ_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Reads a binary file (the PDF study reader) as base64.
///
/// JSON IPC cannot carry raw bytes, and `read_file` decodes UTF-8 — a PDF read
/// through it fails or corrupts. Base64 is the same round-trip the drawing
/// canvas already uses for binary writes.
#[tauri::command]
pub async fn read_file_base64(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    use base64::Engine as _;
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&full).map_err(|e| format!("READ_FAILED: {}", e))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> CmdResult<()> {
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        std::fs::write(&full, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Appends one line per call (agent session jsonl), creating the file when it
/// does not exist. Kept separate from `write_file` because a whole-file
/// rewrite would drop the turns already written in a streaming conversation.
#[tauri::command]
pub async fn append_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> CmdResult<()> {
    use std::io::Write as _;
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&full)
            .map_err(|e| format!("WRITE_FAILED: {}", e))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Binary writes via base64 (the drawing canvas exports its PNG preview through
/// this — a text round-trip would corrupt the bytes).
#[tauri::command]
pub async fn write_file_base64(
    state: State<'_, AppState>,
    path: String,
    contents_base64: String,
) -> CmdResult<()> {
    use base64::Engine as _;
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&contents_base64)
            .map_err(|e| format!("DECODE_FAILED: {}", e))?;
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        std::fs::write(&full, bytes).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Creates `parent/name.md`, deduplicating as "name 2.md", "name 3.md", …
/// Returns the actual created path.
#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> CmdResult<CreatedEntry> {
    let root = require_vault(&state)?;
    validate_name(&name)?;
    let parent_path = if parent.is_empty() || parent == "/" {
        root.clone()
    } else {
        let p = root.join(&parent);
        ensure_within(&root, &p)?;
        p
    };

    tauri::async_runtime::spawn_blocking(move || {
        let stem = strip_extension(&name);
        let ext = extension_of(&name);
        let mut candidate = parent_path.join(&name);
        let mut counter = 2;
        while candidate.exists() {
            candidate = parent_path.join(format!("{} {}.{}", stem, counter, ext));
            counter += 1;
        }
        std::fs::write(&candidate, "").map_err(|e| format!("CREATE_FAILED: {}", e))?;
        Ok(created(&root, &candidate))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn create_dir(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> CmdResult<CreatedEntry> {
    let root = require_vault(&state)?;
    validate_name(&name)?;
    let parent_path = if parent.is_empty() || parent == "/" {
        root.clone()
    } else {
        let p = root.join(&parent);
        ensure_within(&root, &p)?;
        p
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut candidate = parent_path.join(&name);
        let mut counter = 2;
        while candidate.exists() {
            candidate = parent_path.join(format!("{} {}", name, counter));
            counter += 1;
        }
        std::fs::create_dir_all(&candidate).map_err(|e| format!("CREATE_FAILED: {}", e))?;
        Ok(created(&root, &candidate))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// mkdir -p for a vault-relative folder path. Unlike `create_dir` there is no
/// "name 2" dedup: quick-add target folders are created only when missing.
#[tauri::command]
pub async fn ensure_dir(state: State<'_, AppState>, rel_path: String) -> CmdResult<()> {
    let root = require_vault(&state)?;
    let rel = rel_path.trim().trim_matches('/').to_string();
    tauri::async_runtime::spawn_blocking(move || {
        if !rel.is_empty() {
            for part in rel.split('/') {
                validate_name(part)?;
            }
            let full = root.join(&rel);
            ensure_within(&root, &full)?;
            std::fs::create_dir_all(&full).map_err(|e| format!("CREATE_FAILED: {}", e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> CmdResult<String> {
    let root = require_vault(&state)?;
    validate_name(&new_name)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        let target = full
            .parent()
            .ok_or("RENAME_FAILED: no parent")?
            .join(&new_name);
        if target.exists() {
            return Err(format!("RENAME_FAILED: {} already exists", new_name));
        }
        std::fs::rename(&full, &target).map_err(|e| format!("RENAME_FAILED: {}", e))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn trash_path(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let root = require_vault(&state)?;
    let full = std::path::PathBuf::from(&path);
    ensure_within(&root, &full)?;
    tauri::async_runtime::spawn_blocking(move || {
        trash::delete(&full).map_err(|e| format!("TRASH_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Reads `<vault>/.bnote/<name>` for name in the whitelist; None when absent.
#[tauri::command]
pub async fn read_vault_file(
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<Option<String>> {
    if !VAULT_CONFIG_FILES.contains(&name.as_str()) {
        return Err(format!("INVALID_NAME: {}", name));
    }
    let path = vault_join(&state, &format!(".bnote/{}", name))?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn write_vault_file(
    state: State<'_, AppState>,
    name: String,
    contents: String,
) -> CmdResult<()> {
    if !VAULT_CONFIG_FILES.contains(&name.as_str()) {
        return Err(format!("INVALID_NAME: {}", name));
    }
    let path = vault_join(&state, &format!(".bnote/{}", name))?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        }
        std::fs::write(&path, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

fn created(root: &std::path::Path, full: &std::path::Path) -> CreatedEntry {
    CreatedEntry {
        path: full.to_string_lossy().to_string(),
        rel_path: full
            .strip_prefix(root)
            .unwrap_or(full)
            .to_string_lossy()
            .replace('\\', "/"),
    }
}

fn strip_extension(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name.to_string(),
    }
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_string(),
        _ => "md".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{app, app_with_vault, block_on, vault_root};

    fn write(root: &std::path::Path, rel: &str, body: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, body).expect("write");
    }

    #[test]
    fn a_name_without_an_extension_gets_md_as_its_extension() {
        assert_eq!(strip_extension("note"), "note");
        assert_eq!(extension_of("note"), "md");
        assert_eq!(strip_extension("note.md"), "note");
        assert_eq!(extension_of("note.md"), "md");
        // A leading dot is a hidden file name, not an extension separator.
        assert_eq!(strip_extension(".hidden"), ".hidden");
        assert_eq!(extension_of(".hidden"), "md");
        assert_eq!(strip_extension("a.b.md"), "a.b");
        assert_eq!(extension_of("a.b.md"), "md");
    }

    #[test]
    fn a_created_file_lands_under_the_vault_with_a_relative_path() {
        let fixture = app_with_vault("files-create");
        let root = vault_root(&fixture);
        let entry = block_on(create_file(
            fixture.state(),
            String::new(),
            "note.md".into(),
        ))
        .expect("create");
        assert_eq!(entry.rel_path, "note.md");
        assert!(std::path::Path::new(&entry.path).is_file());
        assert!(entry.path.starts_with(root.to_string_lossy().as_ref()));

        // The "/" parent means the vault root.
        let entry =
            block_on(create_file(fixture.state(), "/".into(), "other.md".into())).expect("create");
        assert_eq!(entry.rel_path, "other.md");
    }

    #[test]
    fn creating_a_note_twice_deduplicates_with_a_counter() {
        let fixture = app_with_vault("files-dedup");
        for expected in ["note.md", "note 2.md", "note 3.md"] {
            let entry = block_on(create_file(
                fixture.state(),
                String::new(),
                "note.md".into(),
            ))
            .expect("create");
            assert_eq!(entry.rel_path, expected);
        }
        // Dedup applies to folders too, and never touches what is already
        // inside the first one.
        let first = block_on(create_dir(fixture.state(), String::new(), "folder".into()))
            .expect("create dir");
        assert_eq!(first.rel_path, "folder");
        write(&vault_root(&fixture), "folder/keep.md", "x");
        for expected in ["folder 2", "folder 3"] {
            let entry = block_on(create_dir(fixture.state(), String::new(), "folder".into()))
                .expect("create dir");
            assert_eq!(entry.rel_path, expected);
        }
        assert_eq!(
            std::fs::read_to_string(vault_root(&fixture).join("folder/keep.md")).expect("kept"),
            "x"
        );
    }

    #[test]
    fn an_extensionless_name_creates_a_markdown_note_on_dedup() {
        let fixture = app_with_vault("files-dedup-ext");
        assert_eq!(
            block_on(create_file(fixture.state(), String::new(), "note".into()))
                .expect("create")
                .rel_path,
            "note"
        );
        // The second copy gains the default `.md` extension from extension_of.
        assert_eq!(
            block_on(create_file(fixture.state(), String::new(), "note".into()))
                .expect("create")
                .rel_path,
            "note 2.md"
        );
    }

    #[test]
    fn names_with_separators_or_traversal_are_rejected() {
        let fixture = app_with_vault("files-name");
        for name in ["../escape.md", "a/b.md", "a\\b.md", ".", "..", ""] {
            assert!(
                block_on(create_file(fixture.state(), String::new(), name.into())).is_err(),
                "{name} must be rejected"
            );
        }
    }

    #[test]
    fn a_parent_outside_the_vault_is_rejected() {
        let fixture = app_with_vault("files-parent");
        let outside = fixture.dir.join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        let result = block_on(create_file(
            fixture.state(),
            "../outside".into(),
            "note.md".into(),
        ));
        match result {
            Ok(_) => panic!("escaping parent must fail"),
            Err(err) => assert!(
                err.starts_with("INVALID_NAME") || err.starts_with("FORBIDDEN"),
                "{err}"
            ),
        }
        assert!(!outside.join("note.md").exists());
    }

    #[test]
    fn file_commands_require_an_open_vault() {
        let fixture = app("files-no-vault");
        // Every file command starts with the same guard, so no fixture dir can
        // be read or written while no vault is open.
        let errors = vec![
            block_on(read_file(fixture.state(), "/tmp/a.md".into()))
                .err()
                .unwrap_or_default(),
            block_on(write_file(fixture.state(), "/tmp/a.md".into(), "x".into()))
                .err()
                .unwrap_or_default(),
            match block_on(create_file(fixture.state(), String::new(), "a.md".into())) {
                Ok(_) => String::new(),
                Err(e) => e,
            },
            block_on(ensure_dir(fixture.state(), "Daily".into()))
                .err()
                .unwrap_or_default(),
        ];
        for err in errors {
            assert!(err.starts_with("NO_VAULT"), "{err}");
        }
    }

    #[test]
    fn reading_and_writing_round_trip_through_the_command() {
        let fixture = app_with_vault("files-rw");
        let path = vault_root(&fixture).join("sub/note.md");
        let path_str = path.to_string_lossy().to_string();

        block_on(write_file(
            fixture.state(),
            path_str.clone(),
            "hello\n".into(),
        ))
        .expect("write creates the parent directory");
        assert_eq!(
            block_on(read_file(fixture.state(), path_str.clone())).expect("read"),
            "hello\n"
        );

        block_on(append_file(
            fixture.state(),
            path_str.clone(),
            "second\n".into(),
        ))
        .expect("append");
        assert_eq!(
            block_on(read_file(fixture.state(), path_str.clone())).expect("read"),
            "hello\nsecond\n"
        );
    }

    #[test]
    fn base64_round_trips_binary_bytes() {
        let fixture = app_with_vault("files-b64");
        let path = vault_root(&fixture).join("drawing.png");
        let path_str = path.to_string_lossy().to_string();
        // Not valid UTF-8: the text path would corrupt these bytes.
        let bytes: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe];

        block_on(write_file_base64(fixture.state(), path_str.clone(), {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        }))
        .expect("write");
        assert_eq!(std::fs::read(&path).expect("bytes"), bytes);
        assert_eq!(
            block_on(read_file_base64(fixture.state(), path_str)).expect("read"),
            {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            }
        );
    }

    #[test]
    fn writing_outside_the_vault_is_forbidden() {
        let fixture = app_with_vault("files-confine");
        let outside = fixture.dir.join("outside.md");
        let err = block_on(write_file(
            fixture.state(),
            outside.to_string_lossy().to_string(),
            "x".into(),
        ))
        .expect_err("outside the vault must fail");
        assert!(err.starts_with("FORBIDDEN"), "{err}");
        assert!(!outside.exists());
    }

    #[test]
    fn renaming_refuses_to_overwrite_an_existing_name() {
        let fixture = app_with_vault("files-rename");
        let root = vault_root(&fixture);
        write(&root, "a.md", "a");
        write(&root, "b.md", "b");

        let err = block_on(rename_path(
            fixture.state(),
            root.join("a.md").to_string_lossy().to_string(),
            "b.md".into(),
        ))
        .expect_err("an existing target must not be overwritten");
        assert!(err.starts_with("RENAME_FAILED"), "{err}");
        assert_eq!(std::fs::read_to_string(root.join("b.md")).expect("b"), "b");

        let new_path = block_on(rename_path(
            fixture.state(),
            root.join("a.md").to_string_lossy().to_string(),
            "c.md".into(),
        ))
        .expect("rename");
        assert!(new_path.ends_with("c.md"));
        assert!(!root.join("a.md").exists());
    }

    #[test]
    fn ensure_dir_creates_a_nested_folder_and_is_idempotent() {
        let fixture = app_with_vault("files-ensure");
        block_on(ensure_dir(fixture.state(), "/Daily/2026/".into())).expect("mkdir -p");
        assert!(vault_root(&fixture).join("Daily/2026").is_dir());
        // A second call is a no-op rather than "Daily/2026 2".
        block_on(ensure_dir(fixture.state(), "Daily/2026".into())).expect("idempotent");
        assert!(vault_root(&fixture).join("Daily/2026").is_dir());
        // The empty path is accepted and does nothing.
        block_on(ensure_dir(fixture.state(), String::new())).expect("empty is a no-op");
    }

    #[test]
    fn ensure_dir_rejects_a_traversing_segment() {
        let fixture = app_with_vault("files-ensure-bad");
        assert!(block_on(ensure_dir(fixture.state(), "ok/../escape".into())).is_err());
    }

    #[test]
    fn vault_config_files_are_whitelisted() {
        let fixture = app_with_vault("files-config-name");
        // Arbitrary names must not be reachable: the whitelist is the boundary.
        let err = block_on(read_vault_file(fixture.state(), "../config.json".into()))
            .expect_err("not on the whitelist");
        assert!(err.starts_with("INVALID_NAME"), "{err}");

        assert_eq!(
            block_on(read_vault_file(fixture.state(), "vimrc".into())).expect("absent"),
            None
        );
        block_on(write_vault_file(
            fixture.state(),
            "snippets.js".into(),
            "// s\n".into(),
        ))
        .expect("write");
        assert_eq!(
            block_on(read_vault_file(fixture.state(), "snippets.js".into())).expect("read"),
            Some("// s\n".to_string())
        );
        assert!(vault_root(&fixture).join(".bnote/snippets.js").is_file());
        assert!(block_on(write_vault_file(
            fixture.state(),
            "not-listed.json".into(),
            "{}".into()
        ))
        .is_err());
    }

    #[test]
    fn trashing_removes_the_entry_from_the_vault() {
        let fixture = app_with_vault("files-trash");
        let root = vault_root(&fixture);
        write(&root, "gone.md", "x");
        block_on(trash_path(
            fixture.state(),
            root.join("gone.md").to_string_lossy().to_string(),
        ))
        .expect("trash");
        assert!(!root.join("gone.md").exists());
    }
}
