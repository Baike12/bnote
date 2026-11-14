//! Path confinement shared by the vault and the agent home.
//!
//! Two stores can be written by the app: the vault (the user's notes) and
//! the vault's `.bnote` (the agent's own files). Both need the same check, and the check
//! must handle paths that do not exist yet (a new file resolves through its
//! nearest existing ancestor, so a symlinked `/var` → `/private/var` parent
//! does not make every legitimate new file look foreign).

use std::path::{Path, PathBuf};

use tauri::Manager;

/// Resolves to a comparable absolute path: the part that exists goes through
/// canonicalize (symlinks resolved), and a nonexistent tail is resolved via its
/// nearest existing ancestor and then appended lexically.
pub fn resolve_for_compare(path: &Path) -> PathBuf {
    if let Ok(p) = path.canonicalize() {
        return p;
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path;
    while let Some(parent) = cur.parent() {
        let Some(name) = cur.file_name() else {
            return normalize(path);
        };
        suffix.push(name.to_os_string());
        if let Ok(base) = parent.canonicalize() {
            let mut out = base;
            for part in suffix.iter().rev() {
                out.push(part);
            }
            return normalize(&out);
        }
        cur = parent;
    }
    normalize(path)
}

/// Ensures `path` lies inside `root` (after canonicalization when it exists).
pub fn ensure_within(root: &Path, path: &Path) -> Result<(), String> {
    let root_checked = resolve_for_compare(root);
    let checked = resolve_for_compare(path);
    if checked.starts_with(&root_checked) {
        Ok(())
    } else {
        Err(format!(
            "FORBIDDEN: path is outside the writable root: {}",
            path.display()
        ))
    }
}

/// Grants the webview read access to one directory through the asset protocol.
///
/// The static scope in `tauri.conf.json` deliberately stays minimal: a vault or
/// a code project can live anywhere on disk (an external volume included), so
/// the directory is granted at the moment the user opens it. Widening the
/// static scope to `**` would let the webview read every file on the machine,
/// which is exactly what [`ensure_within`] and `code::project::resolve_in` exist
/// to prevent.
///
/// A failed grant only breaks image previews, so it is logged instead of
/// failing the open.
pub fn allow_asset_dir(app: &tauri::AppHandle, dir: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        eprintln!("[bnote] asset scope {}: {e}", dir.display());
    }
}

/// Lexical normalization (no symlink resolution), enough for nonexistent paths.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nonexistent_file_under_an_existing_root_is_allowed() {
        let root = std::env::temp_dir().join(format!("bnote-paths-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(ensure_within(&root, &root.join("a/b/c.txt")).is_ok());
        let outside = std::env::temp_dir().join("bnote-paths-outside.txt");
        assert!(ensure_within(&root, &outside).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn parent_components_are_normalized_before_comparing() {
        let root = std::env::temp_dir().join(format!("bnote-paths-n-{}", std::process::id()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        assert!(ensure_within(&root, &root.join("sub/../sub/x")).is_ok());
        assert!(ensure_within(&root, &root.join("sub/../../x")).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_pointing_outside_the_root_is_rejected() {
        // The whole point of canonicalizing the existing part: a symlink inside
        // the root must not become a read/write path to the outside world.
        let root = std::env::temp_dir().join(format!("bnote-paths-link-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("bnote-paths-target-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        assert!(ensure_within(&root, &root.join("link/secret.md")).is_err());
        // A symlink staying inside is still fine.
        std::os::unix::fs::symlink(root.join("inside"), root.join("inner")).ok();
        std::fs::create_dir_all(root.join("inside")).unwrap();
        std::os::unix::fs::symlink(root.join("inside"), root.join("inner")).ok();
        assert!(ensure_within(&root, &root.join("inner/new.md")).is_ok());

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn a_nonexistent_tail_resolves_through_its_nearest_existing_ancestor() {
        let root = std::env::temp_dir().join(format!("bnote-paths-tail-{}", std::process::id()));
        std::fs::create_dir_all(root.join("a")).unwrap();
        // The tail itself does not exist; resolution must still be absolute and
        // end with the requested components.
        let resolved = resolve_for_compare(&root.join("a/b/c/d.md"));
        assert!(resolved.ends_with("a/b/c/d.md"), "{}", resolved.display());
        assert!(resolved.is_absolute());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn normalization_removes_cur_and_parent_components_lexically() {
        assert_eq!(normalize(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        // Popping past the root cannot escape it: PathBuf drops nothing there.
        assert_eq!(normalize(Path::new("/../a")), PathBuf::from("/a"));
        assert_eq!(normalize(Path::new("a/b")), PathBuf::from("a/b"));
    }

    #[test]
    fn the_root_itself_is_within_itself() {
        let root = std::env::temp_dir().join(format!("bnote-paths-self-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(ensure_within(&root, &root).is_ok());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
