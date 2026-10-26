pub mod agent;
pub mod config;
pub mod files;
pub mod ime;
pub mod materials;
pub mod pen_cursor;
pub mod python;
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

/// 解析成可比较的绝对路径:存在的部分走 canonicalize(符号链接被解析),
/// 不存在的尾段用最近的已存在祖先解析后按词法接上——这样 `/var/...`
/// (指向 `/private/var/...`)这类 vault 路径与它下面还没建出来的文件
/// 能落在同一个前缀下比较。
fn resolve_for_compare(path: &Path) -> PathBuf {
    if let Ok(p) = path.canonicalize() {
        return p;
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path;
    while let Some(parent) = cur.parent() {
        let Some(name) = cur.file_name() else {
            // 含 `..` / `.` 的词法片段:交给 normalize,不做符号链接解析。
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

/// Ensures `path` lies inside `root` (after canonicalization when the file exists).
pub fn ensure_within(root: &Path, path: &Path) -> Result<(), String> {
    let root_checked = resolve_for_compare(root);
    let checked = resolve_for_compare(path);
    if checked.starts_with(&root_checked) {
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
