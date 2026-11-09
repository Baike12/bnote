//! git support: status, diff, staging.
//!
//! No git library is pulled in — the `git` binary is called directly, so the
//! git installed on the user's machine stays authoritative and behaves exactly
//! like it does in a terminal (config, credential helper and worktree need no
//! reimplementation here).
//!
//! Status parsing uses **porcelain v2**: the records are separated with `-z`,
//! so spaces, newlines and non-ASCII characters in paths need no escaping.
//! Where v2 beats v1: branch info and the upstream difference come from a
//! single call, and renames have their own record type (with the original path
//! and a similarity score).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// The state of one file as git sees it.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitFileState {
    /// Path relative to the repository root.
    pub path: String,
    /// The original path of a rename (only present in the v2 `2` record).
    pub orig_path: Option<String>,
    /// Index state: `M`/`A`/`D`/`R`/`C`/`U`/`?`/`!`, empty when there is none.
    pub index: String,
    /// Worktree state: same set.
    pub worktree: String,
    /// Lines added in the worktree (vs the index); an untracked file counts
    /// its own lines, 0 for a binary or an oversized file.
    pub added: u32,
    /// Lines removed in the worktree (vs the index).
    pub removed: u32,
    /// Lines added in the index (vs HEAD).
    pub staged_added: u32,
    /// Lines removed in the index (vs HEAD).
    pub staged_removed: u32,
}

/// Overview of the repository state.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Whether the current directory is inside a git repository.
    pub is_repo: bool,
    /// The repository root (may be an ancestor of the opened directory).
    pub root: Option<String>,
    /// The current branch; on a detached HEAD it is the short commit hash.
    pub branch: Option<String>,
    /// The name of the upstream branch.
    pub upstream: Option<String>,
    /// Number of commits ahead of the upstream.
    pub ahead: u32,
    /// Number of commits behind the upstream.
    pub behind: u32,
    pub files: Vec<GitFileState>,
}

/// The parse result of porcelain v2.
#[derive(Debug, Clone, Default)]
pub struct ParsedStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileState>,
}

/// Parses the status out of the byte stream of
/// `git status --porcelain=v2 --branch -z`.
///
/// Records are separated by NUL, so spaces and newlines in paths are safe.
/// The v2 record types:
/// - `1` ordinary change: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
/// - `2` rename: `2 <XY> … <X><score> <path>`, **immediately followed by a NUL
///   segment holding the original path**
/// - `u` unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
/// - `?` untracked, `!` ignored (ignored entries never reach the UI, drop them)
pub fn parse_status_v2(stdout: &[u8]) -> ParsedStatus {
    let mut out = ParsedStatus::default();
    let mut iter = stdout.split(|b| *b == 0).filter(|t| !t.is_empty());
    while let Some(tok) = iter.next() {
        if tok.starts_with(b"# ") {
            parse_header(tok, &mut out);
            continue;
        }
        match tok.first() {
            Some(b'1') => {
                let f = split_n(tok, 9);
                if f.len() < 9 {
                    continue;
                }
                let (index, worktree) = split_xy(f[1]);
                out.files.push(GitFileState {
                    path: String::from_utf8_lossy(f[8]).to_string(),
                    orig_path: None,
                    index,
                    worktree,
                    ..Default::default()
                });
            }
            Some(b'2') => {
                let f = split_n(tok, 10);
                if f.len() < 10 {
                    continue;
                }
                let (index, worktree) = split_xy(f[1]);
                // The original path of a rename is the NUL segment right after it.
                let orig = iter.next().map(|o| String::from_utf8_lossy(o).to_string());
                out.files.push(GitFileState {
                    path: String::from_utf8_lossy(f[9]).to_string(),
                    orig_path: orig,
                    index,
                    worktree,
                    ..Default::default()
                });
            }
            Some(b'u') => {
                let f = split_n(tok, 11);
                if f.len() < 11 {
                    continue;
                }
                let (index, worktree) = split_xy(f[1]);
                out.files.push(GitFileState {
                    path: String::from_utf8_lossy(f[10]).to_string(),
                    orig_path: None,
                    index,
                    worktree,
                    ..Default::default()
                });
            }
            Some(b'?') => {
                out.files.push(GitFileState {
                    path: String::from_utf8_lossy(&tok[1..]).trim_start().to_string(),
                    orig_path: None,
                    index: "?".to_string(),
                    worktree: "?".to_string(),
                    ..Default::default()
                });
            }
            // `!` means ignored: it never reaches the UI.
            _ => {}
        }
    }
    out
}

/// Header lines: `# branch.oid …` / `# branch.head …` / `# branch.upstream …` /
/// `# branch.ab +N -M`.
fn parse_header(tok: &[u8], out: &mut ParsedStatus) {
    let text = String::from_utf8_lossy(tok);
    let rest = text.trim_start_matches("# ").trim();
    if let Some(v) = rest.strip_prefix("branch.head ") {
        out.branch = Some(v.trim().to_string());
    } else if let Some(v) = rest.strip_prefix("branch.upstream ") {
        out.upstream = Some(v.trim().to_string());
    } else if let Some(v) = rest.strip_prefix("branch.ab ") {
        // Shaped like `+3 -1`.
        for part in v.split_whitespace() {
            if let Some(n) = part.strip_prefix('+') {
                out.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix('-') {
                out.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

/// The two `XY` characters: the first is the index, the second the worktree.
fn split_xy(xy: &[u8]) -> (String, String) {
    let s = String::from_utf8_lossy(xy);
    let mut chars = s.chars();
    let index = chars.next().unwrap_or(' ').to_string();
    let worktree = chars.next().unwrap_or(' ').to_string();
    (index, worktree)
}

/// Splits on the first n-1 spaces and keeps the last segment verbatim (a path
/// may contain spaces).
fn split_n(tok: &[u8], n: usize) -> Vec<&[u8]> {
    let mut out = Vec::with_capacity(n);
    let mut rest = tok;
    for _ in 0..n.saturating_sub(1) {
        match rest.iter().position(|b| *b == b' ') {
            Some(i) => {
                out.push(&rest[..i]);
                rest = &rest[i + 1..];
            }
            None => break,
        }
    }
    out.push(rest);
    out
}

/// Runs git once and returns stdout. Exit code 1 is allowed (`--no-index` exits
/// with 1 when there is a difference).
fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("GIT_FAILED: {}", e))?;
    if !out.status.success() && out.status.code() != Some(1) {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("GIT_FAILED: {}", err.trim()));
    }
    Ok(out.stdout)
}

/// Whether the directory is inside a git repository, and the repository root.
pub fn repo_root(root: &Path) -> Option<PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}

/// Reads the repository status.
///
/// The per-file line counts come from `--numstat` (the same pair of calls the
/// git pane of ZCode makes): one against the index for the worktree side and
/// one against HEAD for the staged side. An untracked file is not in either
/// list, so its worktree count is its own line count.
pub fn status(root: &Path) -> Result<GitStatus, String> {
    let repo = repo_root(root);
    let Some(repo) = repo else {
        return Ok(GitStatus {
            is_repo: false,
            ..Default::default()
        });
    };
    let stdout = git(
        &repo,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    let mut parsed = parse_status_v2(&stdout);
    // A numstat failure must not lose the status: the list is still worth
    // showing without the counts, so a failed call degrades to empty stats.
    let worktree_stats = git(&repo, &["diff", "--numstat", "-z", "--find-renames", "--"])
        .map(|b| parse_numstat_z(&b))
        .unwrap_or_default();
    let staged_stats = git(
        &repo,
        &[
            "diff",
            "--cached",
            "--numstat",
            "-z",
            "--find-renames",
            "--",
        ],
    )
    .map(|b| parse_numstat_z(&b))
    .unwrap_or_default();
    for file in &mut parsed.files {
        if let Some(stat) = worktree_stats.get(&file.path) {
            file.added = stat.added;
            file.removed = stat.removed;
        } else if file.worktree == "?" {
            file.added = untracked_line_count(&repo.join(&file.path));
        }
        if let Some(stat) = staged_stats.get(&file.path) {
            file.staged_added = stat.added;
            file.staged_removed = stat.removed;
        }
    }
    Ok(GitStatus {
        is_repo: true,
        root: Some(repo.to_string_lossy().to_string()),
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        files: parsed.files,
    })
}

/// One file's line counts.
#[derive(Debug, Clone, Copy, Default)]
pub struct GitLineStat {
    pub added: u32,
    pub removed: u32,
}

/// Parses `git diff --numstat -z --find-renames`.
///
/// Records are NUL-separated `added\tremoved\tpath`; a binary file reports
/// `-` for both counts. With `-z` a rename has an **empty path field** and the
/// next two records are the old and the new path (measured against git 2.x,
/// not taken from the docs): both paths get the same counts, so a rename row
/// finds its stats whichever side it is looked up from.
pub fn parse_numstat_z(stdout: &[u8]) -> std::collections::BTreeMap<String, GitLineStat> {
    fn number(field: &[u8]) -> u32 {
        if field == b"-" {
            return 0;
        }
        String::from_utf8_lossy(field).parse().unwrap_or(0)
    }
    let records: Vec<&[u8]> = stdout
        .split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .collect();
    let mut stats = std::collections::BTreeMap::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        let fields: Vec<&[u8]> = record.splitn(3, |b| *b == b'\t').collect();
        if fields.len() < 3 {
            continue;
        }
        let stat = GitLineStat {
            added: number(fields[0]),
            removed: number(fields[1]),
        };
        if !fields[2].is_empty() {
            stats.insert(String::from_utf8_lossy(fields[2]).to_string(), stat);
            continue;
        }
        let old = records.get(index).copied().unwrap_or_default();
        let new = records.get(index + 1).copied().unwrap_or_default();
        index += 2;
        if new.is_empty() {
            continue;
        }
        stats.insert(String::from_utf8_lossy(new).to_string(), stat);
        if !old.is_empty() {
            stats.insert(String::from_utf8_lossy(old).to_string(), stat);
        }
    }
    stats
}

/// Files above this size (or this count) get no untracked line count: the
/// count is a nicety in the change list, never worth reading a huge tree for.
const UNTRACKED_STAT_MAX_BYTES: u64 = 256 * 1024;

/// The line count of an untracked file; 0 for a binary or an oversized file.
fn untracked_line_count(path: &Path) -> u32 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    if !meta.is_file() || meta.len() > UNTRACKED_STAT_MAX_BYTES {
        return 0;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return 0;
    };
    // NUL bytes mean binary: "lines" would be meaningless.
    if bytes.contains(&0) {
        return 0;
    }
    let mut lines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        lines += 1;
    }
    lines
}

/// Gets the diff of one file (unified diff text).
///
/// - `staged = true`: index vs HEAD;
/// - `staged = false`: worktree vs index;
/// - the file is untracked: `git diff` yields nothing, so `--no-index` compares
///   it against the empty file, which reads as "the whole file is new".
pub fn diff(root: &Path, path: &str, staged: bool) -> Result<String, String> {
    let Some(repo) = repo_root(root) else {
        return Ok(String::new());
    };
    let tracked = is_tracked(&repo, path);
    if !tracked {
        let abs = crate::code::project::resolve_in(&repo, path)?;
        return git(
            &repo,
            &[
                "diff",
                "--no-index",
                "--no-color",
                "--",
                "/dev/null",
                &abs.to_string_lossy(),
            ],
        )
        .map(|b| String::from_utf8_lossy(&b).to_string());
    }
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    let stdout = git(&repo, &args)?;
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

/// Whether the file is tracked by git (an untracked file has to take the
/// `--no-index` path in a diff).
fn is_tracked(repo: &Path, path: &str) -> bool {
    Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", path])
        .current_dir(repo)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Stages the change (`git add`).
pub fn stage(repo: &Path, path: &str) -> Result<(), String> {
    git(repo, &["add", "--", path])?;
    Ok(())
}

/// Unstages the change (`git restore --staged`; when it was never staged it
/// falls back to `git rm --cached`).
pub fn unstage(repo: &Path, path: &str) -> Result<(), String> {
    let out = Command::new("git")
        .args(["restore", "--staged", "--", path])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("GIT_FAILED: {}", e))?;
    if out.status.success() {
        return Ok(());
    }
    // Older git has no restore, fall back to rm --cached.
    git(repo, &["rm", "--cached", "--", path])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bnote-git-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_init(dir: &Path) {
        let run = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {:?} failed", args);
        };
        run(&["init", "-q", "."]);
        run(&["config", "user.email", "t@e.st"]);
        run(&["config", "user.name", "t"]);
    }

    #[test]
    fn parses_ordinary_untracked_and_rename_records() {
        // Measured shape: header and records are separated by NUL; the original
        // path of a rename is the segment right after it.
        let raw = b"# branch.oid abc\0# branch.head main\0\
2 RM N... 100644 100644 100644 h1 h2 R100 renamed.txt\0a.txt\0\
? new.txt\0";
        let s = parse_status_v2(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.files.len(), 2);
        assert_eq!(s.files[0].path, "renamed.txt");
        assert_eq!(s.files[0].orig_path.as_deref(), Some("a.txt"));
        assert_eq!(s.files[0].index, "R");
        assert_eq!(s.files[0].worktree, "M");
        assert_eq!(s.files[1].path, "new.txt");
        assert_eq!(s.files[1].index, "?");
    }

    #[test]
    fn parses_branch_ab_header() {
        let raw = b"# branch.ab +3 -1\0";
        let s = parse_status_v2(raw);
        assert_eq!(s.ahead, 3);
        assert_eq!(s.behind, 1);
    }

    #[test]
    fn path_with_spaces_is_not_split() {
        let raw = b"1 .M N... 100644 100644 100644 h1 h2 my file name.txt\0";
        let s = parse_status_v2(raw);
        assert_eq!(s.files[0].path, "my file name.txt");
    }

    #[test]
    fn status_of_real_repo_reports_modified_and_untracked() {
        let dir = tmpdir("status");
        git_init(&dir);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(&dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(&dir)
            .output()
            .unwrap();
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        std::fs::write(dir.join("new.txt"), "x\n").unwrap();

        let st = status(&dir).unwrap();
        assert!(st.is_repo);
        assert_eq!(st.branch.as_deref(), Some("main"));
        let paths: Vec<&str> = st.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"), "{:?}", paths);
        assert!(paths.contains(&"new.txt"), "{:?}", paths);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_of_modified_file_has_hunk() {
        let dir = tmpdir("diff");
        git_init(&dir);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(&dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(&dir)
            .output()
            .unwrap();
        std::fs::write(dir.join("a.txt"), "one\nTWO\n").unwrap();
        let d = diff(&dir, "a.txt", false).unwrap();
        assert!(d.contains("@@"), "{}", d);
        assert!(d.contains("-two"), "{}", d);
        assert!(d.contains("+TWO"), "{}", d);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_numstat_records_including_binary_and_rename_shapes() {
        // Measured shapes (git 2.x, -z): `added\tremoved\tpath`, `-` for a
        // binary, and for a rename an empty path field followed by old and new.
        let raw = b"2\t1\tf.txt\0-\t-\timage.png\01\t0\t\0g.txt\0h.txt\0";
        let stats = parse_numstat_z(raw);
        assert_eq!(
            stats.get("f.txt").map(|s| (s.added, s.removed)),
            Some((2, 1))
        );
        assert_eq!(
            stats.get("image.png").map(|s| (s.added, s.removed)),
            Some((0, 0)),
            "a binary file reports - for both counts"
        );
        // Both sides of the rename resolve to the same counts.
        assert_eq!(stats.get("h.txt").map(|s| s.added), Some(1));
        assert_eq!(stats.get("g.txt").map(|s| s.added), Some(1));
    }

    #[test]
    fn status_carries_worktree_staged_and_untracked_line_counts() {
        let dir = tmpdir("numstat-status");
        git_init(&dir);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("s.txt"), "x\n").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(&dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(&dir)
            .output()
            .unwrap();
        // Worktree change: one line replaced, one added.
        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        // Staged addition.
        std::fs::write(dir.join("s.txt"), "x\ny\n").unwrap();
        Command::new("git")
            .args(["add", "s.txt"])
            .current_dir(&dir)
            .output()
            .unwrap();
        // Untracked: its own line count is the added count.
        std::fs::write(dir.join("fresh.txt"), "brand new\nfile\n").unwrap();

        let st = status(&dir).unwrap();
        let find = |path: &str| st.files.iter().find(|f| f.path == path).unwrap();
        let a = find("a.txt");
        assert_eq!((a.added, a.removed), (2, 1), "worktree vs index");
        let s = find("s.txt");
        assert_eq!((s.staged_added, s.staged_removed), (1, 0), "index vs HEAD");
        let fresh = find("fresh.txt");
        assert_eq!(
            (fresh.added, fresh.removed),
            (2, 0),
            "untracked counts its lines"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_of_untracked_file_shows_it_as_added() {
        let dir = tmpdir("diff-untracked");
        git_init(&dir);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(&dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(&dir)
            .output()
            .unwrap();
        std::fs::write(dir.join("fresh.txt"), "brand new\n").unwrap();
        let d = diff(&dir, "fresh.txt", false).unwrap();
        assert!(d.contains("+brand new"), "{}", d);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
