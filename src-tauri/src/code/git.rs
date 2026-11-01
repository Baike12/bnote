//! git 支持:状态、差异、暂存。
//!
//! 不引 git 库,直接调 `git` 二进制——用户本机装的 git 就是权威,行为与
//! 终端里一致(配置、credential helper、worktree 都不用自己复刻)。
//!
//! 状态解析用 **porcelain v2**:`-z` 分隔,所以路径里的空格、换行、非 ASCII
//! 都不用转义。v2 比 v1 强的地方:分支信息与上游差异在同一次调用里给出,
//! 重命名有专门的记录类型(带原路径与相似度)。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// 一个文件在 git 眼里的状态。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitFileState {
    /// 仓库相对路径。
    pub path: String,
    /// 重命名的原路径(v2 的 `2` 记录才有)。
    pub orig_path: Option<String>,
    /// 暂存区状态:`M`/`A`/`D`/`R`/`C`/`U`/`?`/`!`,无则空串。
    pub index: String,
    /// 工作区状态:同上。
    pub worktree: String,
}

/// 仓库状态总览。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// 当前目录是否在 git 仓库里。
    pub is_repo: bool,
    /// 仓库根(可能是打开目录的祖先)。
    pub root: Option<String>,
    /// 当前分支;detached 时是提交短哈希。
    pub branch: Option<String>,
    /// 上游分支名。
    pub upstream: Option<String>,
    /// 领先上游的提交数。
    pub ahead: u32,
    /// 落后上游的提交数。
    pub behind: u32,
    pub files: Vec<GitFileState>,
}

/// porcelain v2 的解析结果。
#[derive(Debug, Clone, Default)]
pub struct ParsedStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileState>,
}

/// 从 `git status --porcelain=v2 --branch -z` 的字节流里解析状态。
///
/// 记录之间用 NUL 分隔,所以路径里的空格与换行都是安全的。v2 的记录类型:
/// - `1` 普通改动:`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
/// - `2` 重命名:`2 <XY> … <X><score> <path>`,**紧跟一个 NUL 段是原路径**
/// - `u` 未合并:`u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
/// - `?` 未跟踪、`!` 已忽略(忽略的条目不进 UI,直接丢)
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
                });
            }
            Some(b'2') => {
                let f = split_n(tok, 10);
                if f.len() < 10 {
                    continue;
                }
                let (index, worktree) = split_xy(f[1]);
                // 重命名的原路径是紧随其后的一个 NUL 段。
                let orig = iter.next().map(|o| String::from_utf8_lossy(o).to_string());
                out.files.push(GitFileState {
                    path: String::from_utf8_lossy(f[9]).to_string(),
                    orig_path: orig,
                    index,
                    worktree,
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
                });
            }
            Some(b'?') => {
                out.files.push(GitFileState {
                    path: String::from_utf8_lossy(&tok[1..]).trim_start().to_string(),
                    orig_path: None,
                    index: "?".to_string(),
                    worktree: "?".to_string(),
                });
            }
            // `!` 是已忽略:不进 UI。
            _ => {}
        }
    }
    out
}

/// 头部行:`# branch.oid …` / `# branch.head …` / `# branch.upstream …` / `# branch.ab +N -M`。
fn parse_header(tok: &[u8], out: &mut ParsedStatus) {
    let text = String::from_utf8_lossy(tok);
    let rest = text.trim_start_matches("# ").trim();
    if let Some(v) = rest.strip_prefix("branch.head ") {
        out.branch = Some(v.trim().to_string());
    } else if let Some(v) = rest.strip_prefix("branch.upstream ") {
        out.upstream = Some(v.trim().to_string());
    } else if let Some(v) = rest.strip_prefix("branch.ab ") {
        // 形如 `+3 -1`。
        for part in v.split_whitespace() {
            if let Some(n) = part.strip_prefix('+') {
                out.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix('-') {
                out.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

/// `XY` 两字符:第一位是暂存区,第二位是工作区。
fn split_xy(xy: &[u8]) -> (String, String) {
    let s = String::from_utf8_lossy(xy);
    let mut chars = s.chars();
    let index = chars.next().unwrap_or(' ').to_string();
    let worktree = chars.next().unwrap_or(' ').to_string();
    (index, worktree)
}

/// 按前 n-1 个空格切,最后一段原样保留(路径里可以有空格)。
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

/// 跑一次 git,返回 stdout。允许 exit code 1(`--no-index` 有差异时就是 1)。
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

/// 目录是否在 git 仓库里,以及仓库根。
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

/// 读仓库状态。
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
    let parsed = parse_status_v2(&stdout);
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

/// 取一个文件的差异(unified diff 文本)。
///
/// - `staged = true`:暂存区 vs HEAD;
/// - `staged = false`:工作区 vs 暂存区;
/// - 文件是未跟踪的:`git diff` 什么都不给,改用 `--no-index` 与空文件比,
///   出来的就是「整文件新增」。
pub fn diff(root: &Path, path: &str, staged: bool) -> Result<String, String> {
    let Some(repo) = repo_root(root) else {
        return Ok(String::new());
    };
    let tracked = is_tracked(&repo, path);
    if !tracked {
        let abs = crate::code::project::resolve_in(&repo, path)?;
        return git(
            &repo,
            &["diff", "--no-index", "--no-color", "--", "/dev/null", &abs.to_string_lossy()],
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

/// 文件是否被 git 跟踪(未跟踪的文件在 diff 里要另走 `--no-index`)。
fn is_tracked(repo: &Path, path: &str) -> bool {
    Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", path])
        .current_dir(repo)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 把改动暂存(`git add`)。
pub fn stage(repo: &Path, path: &str) -> Result<(), String> {
    git(repo, &["add", "--", path])?;
    Ok(())
}

/// 把改动从暂存区撤回(`git restore --staged`;没暂存过就退回 `git rm --cached`)。
pub fn unstage(repo: &Path, path: &str) -> Result<(), String> {
    let out = Command::new("git")
        .args(["restore", "--staged", "--", path])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("GIT_FAILED: {}", e))?;
    if out.status.success() {
        return Ok(());
    }
    // 老版本 git 没有 restore,退回 rm --cached。
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
        // 实测形态:头部与记录都用 NUL 分隔;重命名的原路径是紧随的一段。
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
