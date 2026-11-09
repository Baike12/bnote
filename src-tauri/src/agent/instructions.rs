//! Instruction files (`AGENTS.md`) discovery, following Claude Code's
//! `claudemd.ts`. Each file is expanded with `@import` and the result travels
//! as a `<system-reminder>` user message — not inside the system prompt — so
//! editing a file reaches the model on the very next request without
//! invalidating the cached prefix.
//!
//! Scope:
//!   - every mode reads its own root's `AGENTS.md` + `rules/*.md`
//!     (`<vault>/.bnote/agents/<mode>/`);
//!   - coding sessions additionally read the repository, walking from the git
//!     root down to the project root (AGENTS.md / CLAUDE.md /
//!     .bnote/AGENTS.md / .bnote/rules / AGENTS.local.md);
//!   - study/creative sessions read nothing else (a repository's files have
//!     nothing to do with the notebook).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Cap on `@import` recursion (Claude Code's `MAX_INCLUDE_DEPTH`).
const MAX_IMPORT_DEPTH: usize = 5;

const PREAMBLE: &str = "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

#[derive(Debug, Clone, PartialEq)]
pub struct InstructionFile {
    pub path: PathBuf,
    pub content: String,
    /// The parenthesised description CC appends to `Contents of <path>`.
    pub description: &'static str,
}

const USER_DESC: &str = " (agent instructions for this mode)";
const PROJECT_DESC: &str = " (project instructions, checked into the codebase)";
const LOCAL_DESC: &str = " (user's private project instructions, not checked in)";
const RULE_DESC: &str = " (project rule)";

/// Collects the effective instruction files.
///
/// `root` is the mode root (`<vault>/.bnote/agents/<mode>`): its `AGENTS.md`
/// (plus `rules/*.md`) is the mode's own instructions for every mode, so the
/// study agent reads `…/agents/study/AGENTS.md` and the creative agent reads
/// `…/agents/creative/AGENTS.md`. Only coding sessions additionally walk the
/// repository hierarchy; the other modes never read a repository's files.
pub fn collect(
    root: Option<&Path>,
    project: Option<&Path>,
    include_project: bool,
    excludes: &[String],
) -> Vec<InstructionFile> {
    let mut out = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let excluded = Excludes::new(excludes);

    if let Some(root) = root {
        let file = crate::agent::home::mode_instructions_file(root);
        push(&mut out, &mut seen, &excluded, &file, USER_DESC);
        if out.is_empty() {
            // The pre-AGENTS.md name, read only while the new file does not exist.
            push(
                &mut out,
                &mut seen,
                &excluded,
                &root.join("agent.md"),
                USER_DESC,
            );
        }
        for file in rules_in(&crate::agent::home::mode_rules_dir(root)) {
            push(&mut out, &mut seen, &excluded, &file, RULE_DESC);
        }
    }

    let Some(project) = project else {
        return out;
    };
    if !include_project {
        return out;
    }

    // Root first, then each level down to the project: the last file is the
    // highest priority and the model reads them in that order.
    let mut dirs = ancestors_to_git_root(project);
    dirs.reverse();
    for dir in dirs {
        push(
            &mut out,
            &mut seen,
            &excluded,
            &dir.join("AGENTS.md"),
            PROJECT_DESC,
        );
        push(
            &mut out,
            &mut seen,
            &excluded,
            &dir.join("CLAUDE.md"),
            PROJECT_DESC,
        );
        push(
            &mut out,
            &mut seen,
            &excluded,
            &dir.join(".bnote").join("AGENTS.md"),
            PROJECT_DESC,
        );
        for file in rules_in(&dir.join(".bnote").join("rules")) {
            push(&mut out, &mut seen, &excluded, &file, RULE_DESC);
        }
        push(
            &mut out,
            &mut seen,
            &excluded,
            &dir.join("AGENTS.local.md"),
            LOCAL_DESC,
        );
    }
    out
}

fn rules_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// `project` plus its ancestors up to and including the git root (or the home
/// directory / filesystem root when there is no repository).
fn ancestors_to_git_root(project: &Path) -> Vec<PathBuf> {
    // `$HOME` itself, not the agent home: the walk stops at the user's home
    // directory regardless of where the vault (and its `.bnote`) lives.
    let home = Some(crate::agent::home::user_home());
    let mut dirs = Vec::new();
    let mut cur = Some(project.to_path_buf());
    while let Some(dir) = cur {
        dirs.push(dir.clone());
        if dir.join(".git").exists() {
            break;
        }
        if home.as_ref().is_some_and(|h| dir == *h) {
            break;
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    dirs
}

/// Reads one file and expands its `@import`s into separate entries.
fn push(
    out: &mut Vec<InstructionFile>,
    seen: &mut HashSet<PathBuf>,
    excluded: &Excludes,
    path: &Path,
    description: &'static str,
) {
    let Some(content) = read_instruction(path, excluded, seen) else {
        return;
    };
    out.push(InstructionFile {
        path: path.to_path_buf(),
        content,
        description,
    });
    // Imports follow the including file, depth-first.
    let mut imports = Vec::new();
    collect_imports(path, 0, seen, excluded, &mut imports);
    out.extend(imports);
}

fn read_instruction(
    path: &Path,
    excluded: &Excludes,
    seen: &mut HashSet<PathBuf>,
) -> Option<String> {
    if excluded.matches(path) {
        return None;
    }
    let key = path.canonicalize().ok()?;
    if !seen.insert(key) {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    if content.trim().is_empty() {
        return None;
    }
    Some(content)
}

fn collect_imports(
    from: &Path,
    depth: usize,
    seen: &mut HashSet<PathBuf>,
    excluded: &Excludes,
    out: &mut Vec<InstructionFile>,
) {
    if depth >= MAX_IMPORT_DEPTH {
        return;
    }
    let Ok(content) = std::fs::read_to_string(from) else {
        return;
    };
    for target in imports_in(&content) {
        let resolved = resolve_import(from, &target);
        let Some(resolved) = resolved else { continue };
        if !is_text_file(&resolved) {
            continue;
        }
        let Some(text) = read_instruction(&resolved, excluded, seen) else {
            continue;
        };
        out.push(InstructionFile {
            path: resolved.clone(),
            content: text,
            description: PROJECT_DESC,
        });
        collect_imports(&resolved, depth + 1, seen, excluded, out);
    }
}

fn resolve_import(from: &Path, target: &str) -> Option<PathBuf> {
    let target = target.trim();
    let unescaped = target.replace("\\ ", " ");
    let without_fragment = unescaped.split('#').next().unwrap_or(&unescaped);
    if without_fragment.is_empty() {
        return None;
    }
    if let Some(rest) = without_fragment.strip_prefix("~/") {
        let home = std::env::var("HOME").ok()?;
        return Some(PathBuf::from(home).join(rest));
    }
    let path = PathBuf::from(without_fragment);
    if path.is_absolute() {
        return Some(path);
    }
    from.parent().map(|dir| dir.join(path))
}

fn is_text_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some(
            "md" | "markdown"
                | "txt"
                | "json"
                | "yaml"
                | "yml"
                | "toml"
                | "xml"
                | "csv"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "css"
                | "html"
        )
    )
}

/// `@path` tokens outside code fences and HTML comments.
fn imports_in(content: &str) -> Vec<String> {
    static COMMENT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let comment = COMMENT.get_or_init(|| regex::Regex::new(r"(?s)<!--.*?-->").unwrap());
    let stripped = comment.replace_all(content, "");
    let mut out = Vec::new();
    let mut fenced = false;
    for raw in stripped.lines() {
        let line = raw.trim_start();
        if line.starts_with("```") || line.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        scan_imports(raw, &mut out);
    }
    out
}

fn scan_imports(text: &str, out: &mut Vec<String>) {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'@' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() {
            let c = bytes[end] as char;
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '~' | '\\' | '-') {
                end += 1;
            } else {
                break;
            }
        }
        if end > start {
            let token = &text[start..end];
            // A bare `@` in an email-like string or a decorator is not a path:
            // the token must contain a path separator or a dot.
            if token.contains('/') || token.contains('.') {
                out.push(token.to_string());
            }
        }
        index = end.max(index + 1);
    }
}

struct Excludes {
    set: Option<globset::GlobSet>,
}

impl Excludes {
    fn new(patterns: &[String]) -> Excludes {
        if patterns.is_empty() {
            return Excludes { set: None };
        }
        let mut builder = globset::GlobSetBuilder::new();
        for pattern in patterns {
            if let Ok(glob) = globset::Glob::new(pattern) {
                builder.add(glob);
            }
        }
        Excludes {
            set: builder.build().ok(),
        }
    }

    fn matches(&self, path: &Path) -> bool {
        self.set.as_ref().is_some_and(|set| set.is_match(path))
    }
}

/// The text that goes into the `<system-reminder>` in front of the
/// conversation. Empty when there is no instruction file.
pub fn render(files: &[InstructionFile]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut out = String::from(PREAMBLE);
    for file in files {
        out.push_str(&format!(
            "\n\nContents of {}{}:\n\n{}",
            file.path.display(),
            file.description,
            file.content.trim()
        ));
    }
    out
}

/// One instruction file formatted the way CC renders it.
pub fn render_one(file: &InstructionFile) -> String {
    format!(
        "Contents of {}{}:\n\n{}",
        file.path.display(),
        file.description,
        file.content.trim()
    )
}

/// Instruction files between a read file and the project root that were not
/// loaded yet (CC's `nested_memory` attachment).
pub fn nested(target: &Path, project: &Path, loaded: &HashSet<PathBuf>) -> Vec<InstructionFile> {
    let mut out = Vec::new();
    let root = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf());
    let mut seen = loaded.clone();
    let excluded = Excludes::new(&[]);
    // Both sides go through canonicalize: `/var` is `/private/var` on macOS,
    // and comparing the raw forms would end the walk immediately.
    let start = target
        .parent()
        .unwrap_or(target)
        .canonicalize()
        .unwrap_or_else(|_| target.parent().unwrap_or(target).to_path_buf());
    let mut dir = Some(start);
    let mut dirs = Vec::new();
    while let Some(current) = dir {
        if !current.starts_with(&root) {
            break;
        }
        dirs.push(current.clone());
        if current == root {
            break;
        }
        dir = current.parent().map(|p| p.to_path_buf());
    }
    for dir in dirs {
        for name in ["AGENTS.md", ".bnote/AGENTS.md", "CLAUDE.md"] {
            let path = dir.join(name);
            if let Some(content) = read_instruction(&path, &excluded, &mut seen) {
                out.push(InstructionFile {
                    path,
                    content,
                    description: PROJECT_DESC,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(tag: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "bnote-instr-{}-{}-{}",
            tag,
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_mode_reads_its_own_root_and_never_the_repository() {
        let vault = temp("vault");
        let root = vault.join(".bnote/agents/creative");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("AGENTS.md"), "creative rules").unwrap();
        std::fs::write(vault.join("AGENTS.md"), "repo rules").unwrap();
        let files = collect(Some(&root), Some(&vault), false, &[]);
        assert_eq!(files.len(), 1);
        assert!(files[0].content.contains("creative rules"));
        assert!(files[0].path.ends_with("agents/creative/AGENTS.md"));
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn the_coding_scope_reads_root_first_and_local_last() {
        let root = temp("repo");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("AGENTS.md"), "root rules").unwrap();
        let nested = root.join("src/deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("AGENTS.md"), "nested rules").unwrap();
        std::fs::write(nested.join("AGENTS.local.md"), "local rules").unwrap();
        let files = collect(None, Some(&nested), true, &[]);
        let project_files: Vec<&InstructionFile> = files
            .iter()
            .filter(|f| f.description == PROJECT_DESC || f.description == LOCAL_DESC)
            .collect();
        assert!(project_files[0].content.contains("root rules"));
        assert!(project_files
            .iter()
            .any(|f| f.content.contains("nested rules")));
        assert_eq!(
            project_files.last().unwrap().description,
            LOCAL_DESC,
            "AGENTS.local.md comes last"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn imports_are_expanded_once_and_fenced_code_is_ignored() {
        let root = temp("imports");
        std::fs::write(
            root.join("AGENTS.md"),
            "see @docs/a.md\n```\n@docs/ignored.md\n```",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.md"), "imported @b.md").unwrap();
        std::fs::write(root.join("docs/b.md"), "second level").unwrap();
        std::fs::write(root.join("docs/ignored.md"), "must not load").unwrap();
        let files = collect(None, Some(&root), false, &[]);
        // The mode-root scope finds nothing here, so use the nested helper to
        // exercise the import walker.
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        let excluded = Excludes::new(&[]);
        let first = read_instruction(&root.join("AGENTS.md"), &excluded, &mut seen).unwrap();
        out.push(InstructionFile {
            path: root.join("AGENTS.md"),
            content: first,
            description: PROJECT_DESC,
        });
        collect_imports(&root.join("AGENTS.md"), 0, &mut seen, &excluded, &mut out);
        assert!(out.iter().any(|f| f.content.contains("imported")));
        assert!(out.iter().any(|f| f.content.contains("second level")));
        assert!(!out.iter().any(|f| f.content.contains("must not load")));
        assert!(files.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn excludes_skip_a_file() {
        let root = temp("exclude");
        let mode_root = root.join(".bnote/agents/study");
        std::fs::create_dir_all(&mode_root).unwrap();
        std::fs::write(mode_root.join("AGENTS.md"), "keep").unwrap();
        let files = collect(
            Some(&mode_root),
            None,
            false,
            &[format!("{}**", mode_root.display())],
        );
        assert!(files.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn nested_files_stop_at_the_project_root() {
        let root = temp("nested");
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::write(root.join("AGENTS.md"), "root").unwrap();
        std::fs::write(root.join("src/AGENTS.md"), "src").unwrap();
        std::fs::write(root.join("src/deep/file.rs"), "").unwrap();
        let files = nested(&root.join("src/deep/file.rs"), &root, &HashSet::new());
        assert_eq!(files.len(), 2, "{:?}", files);
        assert!(files.iter().any(|f| f.content == "root"));
        assert!(files.iter().any(|f| f.content == "src"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
