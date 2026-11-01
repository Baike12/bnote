//! 代码项目:打开仓库、扫描文件树、读写文件、全文搜。
//!
//! ## 边界
//!
//! 代码项目通常**不在 vault 里**(那才是它的常态:~/Code/xxx),所以不能套用
//! vault 那套「路径必须在 vault 内」的约束。边界改由**用户显式打开的那一个
//! 目录**来定:项目根就是沙箱边界,根内的一切可读写,根外的一切拒绝。
//!
//! 拒绝靠 [`resolve_in`]:相对路径先做词法规范化(消掉 `.`/`..`),再把
//! 已存在的部分 canonicalize(解符号链接),最后用 `starts_with` 复查是否
//! 仍在根内。**符号链接指向根外也要挡住**——只做词法规范化会漏掉它。
//!
//! ## 扫描
//!
//! 文件树用 `ignore` crate 扫一遍(尊重 .gitignore / .ignore / git 全局排除),
//! 结果拍平成「相对路径 → 条目」的列表,前端自己折叠成树。这样:
//! - 只扫一次,展开目录不再碰磁盘;
//! - 搜索文件名/内容不用再遍历;
//! - .git / node_modules / target 这些大目录由 gitignore 天然挡掉。
//!
//! 扫描有上限(条目数与深度),超了标 `truncated` 并如实告诉前端——不假装
//! 扫全了。

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// 扫描条目数上限:超过就停,并把 `truncated` 置真。
pub const MAX_ENTRIES: usize = 50_000;
/// 扫描深度上限。
pub const MAX_DEPTH: usize = 32;
/// 单个文件读入的大小上限(2 MiB):再大的当二进制,不进编辑器。
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

/// 文件树里的一个条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeEntry {
    /// 项目根相对路径(posix 分隔符)。
    pub path: String,
    /// 文件/目录名。
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 扫描结果。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodeTree {
    pub entries: Vec<CodeEntry>,
    /// 命中上限被截断(前端要如实告诉用户「文件树不完整」)。
    pub truncated: bool,
}

/// 一个文件的内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFile {
    /// 项目根相对路径。
    pub path: String,
    /// LSP languageId(见 [`super::lang`]);前端据此挑语法包。
    pub language_id: String,
    /// 文本内容(二进制文件为空串)。
    pub content: String,
    /// 是不是二进制(二进制不进编辑器,只提示)。
    pub binary: bool,
    pub size: u64,
}

/// 搜索命中。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchHit {
    /// 项目根相对路径。
    pub path: String,
    /// 命中的行号(0-based)。
    pub line: u32,
    /// 命中行的文本(整行,前端自己高亮片段)。
    pub text: String,
}

/// 把「项目根 + 相对路径」解析成绝对路径,并保证结果落在项目根内。
///
/// 相对路径可能带 `..`,也可能经过符号链接指向根外 —— 两种都要挡住:
/// 1. 词法规范化:消掉 `.` 与 `..`(不碰磁盘,文件不存在也能算);
/// 2. canonicalize 已存在的部分:解掉符号链接;
/// 3. `starts_with(root)`:最终复查。
///
/// 文件还不存在时(canonicalize 失败)退回「父目录 canonicalize + 文件名」。
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

/// 词法规范化:消掉 `.` 与 `..`,不碰磁盘。
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

/// 扫一遍项目根,产出拍平的条目列表。
///
/// 尊重 .gitignore / .ignore / git 全局排除;`.git` 与 `.DS_Store` 单独排除
/// (前者是仓库内部结构,后者是系统噪音)。不跟随符号链接(避免环)。
pub fn scan(root: &Path) -> CodeTree {
    let mut tree = CodeTree::default();
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        // 隐藏文件要(`.github`、`.vscode` 有用),`.git` 单独排除。
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        // 只在真的 git 仓库里才尊重 gitignore 规则。
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
            continue; // 根目录本身不进列表
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

/// 相对路径 → posix 分隔符(Windows 上是反斜杠,前端要的是 `/`)。
fn to_posix(p: &Path) -> String {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// 读一个文本文件。二进制(有 NUL 字节)不返回内容,只标 binary。
pub fn read_text(path: &Path) -> Result<(String, bool, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("READ_FAILED: {}", e))?;
    if meta.is_dir() {
        return Err("READ_FAILED: 是目录".to_string());
    }
    let size = meta.len();
    if size > MAX_TEXT_BYTES {
        return Ok((String::new(), true, size));
    }
    // 已知的二进制后缀直接按二进制处理,不做内容嗅探:位图/字体/压缩包即便
    // 前 8 KiB 恰好没有 NUL,解出来也是乱码——当成文本开进编辑器,一保存就
    // 把原文件写坏(图片预览走 asset 协议读原文件,不经过这里)。
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if is_binary_ext(&ext) {
        return Ok((String::new(), true, size));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("READ_FAILED: {}", e))?;
    // 前 8 KiB 里有 NUL 就是二进制(和 git 判二进制一个思路)。
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return Ok((String::new(), true, size));
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok((text, false, size))
}

/// 写一个文件(父目录不存在就建)。
pub fn write_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
    }
    std::fs::write(path, content).map_err(|e| format!("WRITE_FAILED: {}", e))
}

/// 在已扫描出的文件里搜内容(字面量,忽略大小写)。
///
/// 只搜已知是文本的后缀,免得把二进制拖进来翻半天。命中数有上限——
/// 一次搜索把整个仓库吐出来没有意义。
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

/// 按扩展名直接排除的二进制/大文件后缀。
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
        // 文件还不存在(新建)也要能算出来。
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
        // 没有 git 仓库时 gitignore 不生效(require_git),但 .git 一定要挡掉。
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
        // 「前 8 KiB 里没有 NUL 的 png」:按内容嗅探会当成文本,保存就把图
        // 写坏。后缀在已知二进制表里就必须走二进制通道。
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
