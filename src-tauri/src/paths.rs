//! Path confinement shared by the vault and the agent home.
//!
//! Two stores can be written by the app: the vault (the user's notes) and
//! `~/.bnote` (the agent's own files). Both need the same check, and the check
//! must handle paths that do not exist yet (a new file resolves through its
//! nearest existing ancestor, so a symlinked `/var` → `/private/var` parent
//! does not make every legitimate new file look foreign).

use std::path::{Path, PathBuf};

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
}
