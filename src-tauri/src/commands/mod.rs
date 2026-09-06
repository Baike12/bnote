pub mod config;
pub mod files;
pub mod ime;
pub mod vault;

use std::path::{Path, PathBuf};

/// Error type for all commands: converted to a string on the JS side.
pub type CmdResult<T> = Result<T, String>;

/// Returns the vault root, or an error if no vault is open.
pub fn require_vault(state: &crate::state::AppState) -> Result<PathBuf, String> {
    state
        .vault()
        .ok_or_else(|| "NO_VAULT: no vault is open".to_string())
}

/// Ensures `path` lies inside `root` (after canonicalization when the file exists).
pub fn ensure_within(root: &Path, path: &Path) -> Result<(), String> {
    let checked = path
        .canonicalize()
        .unwrap_or_else(|_| normalize(path));
    if checked.starts_with(root) {
        Ok(())
    } else {
        Err(format!(
            "FORBIDDEN: path is outside the vault: {}",
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

/// Rejects path separators / traversal in user-supplied file or folder names.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(format!("INVALID_NAME: {}", name));
    }
    Ok(())
}
