//! Code projects: open a repository, scan the file tree, read/write files,
//! full-text search.
//!
//! ## Boundary
//!
//! Code projects usually live **outside the vault** (that is the norm:
//! ~/Code/xxx), so the vault's "the path must be inside the vault" constraint
//! does not apply. The boundary is instead set by **the one directory the user
//! explicitly opened**: the project root is the sandbox boundary — everything
//! inside it may be read and written, everything outside is rejected.
//!
//! The rejection is done by [`resolve_in`]: a relative path is first
//! normalized lexically (removing `.`/`..`), then the part that exists is
//! canonicalized (resolving symlinks), and finally `starts_with` re-checks that
//! the result is still inside the root. **A symlink pointing outside the root
//! has to be blocked too** — lexical normalization alone would miss it.
//!
//! ## Scan
//!
//! The file tree is scanned once with the `ignore` crate (respecting
//! .gitignore / .ignore / the global git excludes), and the result is flattened
//! into a "relative path → entry" list that the front end folds into a tree.
//! That way:
//! - the disk is touched once, expanding a directory costs nothing;
//! - searching file names and contents needs no second traversal;
//! - the big directories .git / node_modules / target are filtered away by
//!   gitignore on their own.
//!
//! The scan has limits (entry count and depth); when one is hit `truncated` is
//! set and the front end is told honestly — it never pretends to have scanned
//! everything.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Upper bound on the number of scanned entries: the scan stops here and sets
/// `truncated`.
pub const MAX_ENTRIES: usize = 50_000;
/// Upper bound on the scan depth.
pub const MAX_DEPTH: usize = 32;
/// Upper bound on the size of a single file read in (2 MiB): anything larger is
/// treated as binary and never enters the editor.
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

/// One entry of the file tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeEntry {
    /// Path relative to the project root (posix separators).
    pub path: String,
    /// The file or directory name.
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// The scan result.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodeTree {
    pub entries: Vec<CodeEntry>,
    /// The entry limit was hit and the tree is truncated (the front end has to
    /// tell the user "the file tree is incomplete").
    pub truncated: bool,
}

/// The content of one file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFile {
    /// Path relative to the project root.
    pub path: String,
    /// LSP languageId (see [`super::lang`]); the front end picks the syntax
    /// package by it.
    pub language_id: String,
    /// The text content (empty for a binary file).
    pub content: String,
    /// Whether the file is binary (a binary file never enters the editor, it is
    /// only reported).
    pub binary: bool,
    pub size: u64,
}

/// A search hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchHit {
    /// Path relative to the project root.
    pub path: String,
    /// The line number of the hit (0-based).
    pub line: u32,
    /// The text of the matching line (the whole line; the front end highlights
    /// the fragment itself).
    pub text: String,
}

/// Resolves "project root + relative path" into an absolute path and guarantees
/// the result stays inside the project root.
///
/// A relative path may carry `..` or pass through a symlink pointing outside
/// the root — both have to be blocked:
/// 1. lexical normalization: removes `.` and `..` (no disk access, so it also
///    works for a file that does not exist);
/// 2. canonicalize the part that exists: resolves the symlinks;
/// 3. `starts_with(root)`: the final re-check.
///
/// When the file does not exist yet (canonicalize fails) it falls back to
/// "canonicalize the parent directory + the file name".
pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root_c = root
        .canonicalize()
        .map_err(|e| format!("PROJECT_INVALID: {}", e))?;
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("PATH_INVALID: 必须是项目内的相对路径".to_string());
    }
    let normalized = normalize_lexically(&root_c.join(rel_path));
    let (base, name) = match normalized.file_name() {
        Some(n) if !normalized.exists() => (
            normalized
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| root_c.clone()),
            Some(n.to_os_string()),
        ),
        _ => (normalized.clone(), None),
    };
    let base_c = base
        .canonicalize()
        .map_err(|e| format!("PATH_INVALID: {}", e))?;
    let final_path = match name {
        Some(n) => base_c.join(n),
        None => base_c,
    };
    if !final_path.starts_with(&root_c) {
        return Err("FORBIDDEN: 路径超出项目根".to_string());
    }
    Ok(final_path)
}

/// Lexical normalization: removes `.` and `..` without touching the disk.
fn normalize_lexically(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// Scans the project root once and produces the flattened entry list.
///
/// Respects .gitignore / .ignore / the global git excludes; `.git` and
/// `.DS_Store` are excluded separately (the former is the repository's internal
/// structure, the latter system noise). Symlinks are not followed (they could
/// form cycles).
pub fn scan(root: &Path) -> CodeTree {
    let mut tree = CodeTree::default();
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        // Hidden files are wanted (`.github`, `.vscode` are useful); `.git` is
        // excluded separately.
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        // The gitignore rules only apply inside a real git repository.
        .require_git(true)
        .follow_links(false)
        .max_depth(Some(MAX_DEPTH));
    builder.filter_entry(|entry| {
        let name = entry.file_name().to_string_lossy();
        !(name == ".git" || name == ".DS_Store")
    });

    for result in builder.build() {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue; // the root itself is not an entry
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = if is_dir {
            0
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        tree.entries.push(CodeEntry {
            path: to_posix(rel),
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir,
            size,
        });
        if tree.entries.len() >= MAX_ENTRIES {
            tree.truncated = true;
            break;
        }
    }
    tree
}

/// Relative path → posix separators (Windows uses backslashes, the front end
/// expects `/`).
fn to_posix(p: &Path) -> String {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Reads a text file. A binary file (with NUL bytes) returns no content, only
/// the binary flag.
pub fn read_text(path: &Path) -> Result<(String, bool, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("READ_FAILED: {}", e))?;
    if meta.is_dir() {
        return Err("READ_FAILED: 是目录".to_string());
    }
    let size = meta.len();
    if size > MAX_TEXT_BYTES {
        return Ok((String::new(), true, size));
    }
    // A known binary suffix is handled as binary without sniffing the content:
    // a bitmap/font/archive is garbage even when its first 8 KiB happen to hold
    // no NUL — opened as text in the editor, the first save would corrupt the
    // original file (the image preview reads the original through the asset
    // protocol and never comes here).
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if is_binary_ext(&ext) {
        return Ok((String::new(), true, size));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("READ_FAILED: {}", e))?;
    // A NUL byte in the first 8 KiB means binary (the same idea git uses).
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return Ok((String::new(), true, size));
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok((text, false, size))
}

/// Writes a file (creates the parent directory when it is missing).
pub fn write_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
    }
    std::fs::write(path, content).map_err(|e| format!("WRITE_FAILED: {}", e))
}

/// Searches the contents of the already scanned files (literal, case
/// insensitive).
///
/// Only suffixes known to be text are searched, so a binary never drags the
/// search through garbage. The number of hits is capped — a single search
/// dumping the whole repository is meaningless.
pub fn search_contents(
    root: &Path,
    entries: &[CodeEntry],
    query: &str,
    limit: usize,
) -> Vec<CodeSearchHit> {
    if query.is_empty() {
        return Vec::new();
    }
    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    for entry in entries {
        if entry.is_dir || hits.len() >= limit {
            continue;
        }
        let ext = Path::new(&entry.path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if is_binary_ext(&ext) {
            continue;
        }
        let path = match resolve_in(root, &entry.path) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let (text, binary, _) = match read_text(&path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if binary {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(CodeSearchHit {
                    path: entry.path.clone(),
                    line: i as u32,
                    text: line.chars().take(400).collect(),
                });
                if hits.len() >= limit {
                    return hits;
                }
            }
        }
    }
    hits
}

/// Binary/large-file suffixes excluded by extension.
fn is_binary_ext(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif"
            | "pdf" | "zip" | "gz" | "bz2" | "xz" | "zst" | "7z" | "rar" | "tar"
            | "woff" | "woff2" | "ttf" | "otf" | "eot"
            | "mp3" | "mp4" | "mov" | "wav" | "flac" | "ogg" | "webm"
            | "so" | "dylib" | "dll" | "exe" | "bin" | "o" | "a" | "class"
            | "wasm" | "pyc" | "rlib" | "node"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bnote-code-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_rejects_parent_escape() {
        let root = tmpdir("escape");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let err = resolve_in(&root, "../a.txt").unwrap_err();
        assert!(err.contains("FORBIDDEN") || err.contains("PATH_INVALID"), "got {}", err);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_rejects_absolute_path() {
        let root = tmpdir("abs");
        assert!(resolve_in(&root, "/etc/passwd").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_accepts_inner_path_and_missing_file() {
        let root = tmpdir("inner");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn main(){}").unwrap();
        let p = resolve_in(&root, "src/a.rs").unwrap();
        assert!(p.ends_with("src/a.rs"));
        // A file that does not exist yet (a new one) must be resolvable too.
        let p = resolve_in(&root, "src/new.rs").unwrap();
        assert!(p.ends_with("src/new.rs"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_rejects_symlink_pointing_outside_root() {
        let root = tmpdir("symlink");
        let outside = tmpdir("symlink-outside");
        std::fs::write(outside.join("secret.txt"), "s3cret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let err = resolve_in(&root, "link/secret.txt").unwrap_err();
        assert!(err.contains("FORBIDDEN"), "got {}", err);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn scan_lists_files_and_dirs_relative_to_root() {
        let root = tmpdir("scan");
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn a(){}").unwrap();
        std::fs::write(root.join("src/deep/b.rs"), "fn b(){}").unwrap();
        std::fs::write(root.join("README.md"), "hi").unwrap();
        let tree = scan(&root);
        let paths: Vec<&str> = tree.entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"src/a.rs"), "{:?}", paths);
        assert!(paths.contains(&"src/deep/b.rs"), "{:?}", paths);
        assert!(paths.contains(&"README.md"), "{:?}", paths);
        assert!(paths.contains(&"src"), "{:?}", paths);
        assert!(!tree.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_skips_gitignored_and_dot_git() {
        let root = tmpdir("ignore");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::fs::write(root.join("node_modules/pkg.js"), "x").unwrap();
        std::fs::write(root.join("keep.js"), "x").unwrap();
        // Without a git repository the gitignore rules do not apply
        // (require_git), but `.git` still has to be blocked.
        let tree = scan(&root);
        let paths: Vec<&str> = tree.entries.iter().map(|e| e.path.as_str()).collect();
        assert!(!paths.iter().any(|p| p.starts_with(".git/")), "{:?}", paths);
        assert!(paths.contains(&"keep.js"), "{:?}", paths);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_text_detects_binary() {
        let root = tmpdir("bin");
        let p = root.join("b.bin");
        std::fs::write(&p, [0u8, 1, 2, 3]).unwrap();
        let (text, binary, size) = read_text(&p).unwrap();
        assert!(binary);
        assert_eq!(text, "");
        assert_eq!(size, 4);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_text_treats_image_extension_as_binary_even_if_utf8() {
        // A "png whose first 8 KiB hold no NUL": content sniffing would treat
        // it as text and the first save would corrupt the image. A suffix in
        // the known-binary table must take the binary path.
        let root = tmpdir("imgext");
        let p = root.join("fake.png");
        std::fs::write(&p, b"plain utf8 text, no nul").unwrap();
        let (text, binary, size) = read_text(&p).unwrap();
        assert!(binary);
        assert_eq!(text, "");
        assert_eq!(size, 23);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_finds_case_insensitive_matches() {
        let root = tmpdir("search");
        std::fs::write(root.join("a.ts"), "const Foo = 1;\nfoo()\n").unwrap();
        let tree = scan(&root);
        let hits = search_contents(&root, &tree.entries, "FOO", 10);
        assert_eq!(hits.len(), 2, "{:?}", hits);
        assert_eq!(hits[0].path, "a.ts");
        assert_eq!(hits[0].line, 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
