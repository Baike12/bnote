//! Per-turn git checkpoints for remote coding sessions.
//!
//! A checkpoint is the worktree state at the start of a turn: HEAD, the branch,
//! the dirty tracked state, and copies of every untracked file. Rollback is
//! therefore a git-level reset plus a file restore, never a hand-rebuilt patch.
//!
//! The dirty state is captured with `git stash create`, which produces a commit
//! without touching the worktree. That commit is unreachable from HEAD, so a
//! hidden ref under `refs/bnote/checkpoints/` pins it: `gc` would otherwise drop
//! it and a later rollback would lose the tracked changes.

use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::remote::crypto::hex_encode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub checkpoint_id: String,
    pub live_id: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub items_len: usize,
    pub created_at: u64,
}

/// What `checkpoint.json` holds. `load` exposes only the public part; rollback
/// needs the stash commit and the archived paths to put the worktree back.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    checkpoint_id: String,
    live_id: String,
    head: Option<String>,
    branch: Option<String>,
    items_len: usize,
    created_at: u64,
    #[serde(default)]
    stash: Option<String>,
    #[serde(default)]
    untracked: Vec<String>,
}

impl Record {
    fn public(&self) -> Checkpoint {
        Checkpoint {
            checkpoint_id: self.checkpoint_id.clone(),
            live_id: self.live_id.clone(),
            head: self.head.clone(),
            branch: self.branch.clone(),
            items_len: self.items_len,
            created_at: self.created_at,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ids become path components and ref components, so anything that could leave
/// its directory is refused before it reaches the filesystem.
fn safe_id(id: &str) -> Result<&str, String> {
    let valid = !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid {
        Ok(id)
    } else {
        Err(format!("BAD_ID: {id:?} is not a safe path component"))
    }
}

/// A repo-relative path is only accepted when every component is a normal
/// name and no component is `.git`; git never emits anything else, but user
/// input reaches this module and a wrong join would escape the workdir.
fn safe_relative(rel: &str) -> Option<&Path> {
    let path = Path::new(rel);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    for component in path.components() {
        match component {
            Component::Normal(name) if name != ".git" => {}
            _ => return None,
        }
    }
    Some(path)
}

fn run(workdir: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(workdir)
        .args(args)
        .output()
        .map_err(|e| format!("GIT_FAILED: git {} ({e})", args.join(" ")))
}

fn stderr_of(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

/// Runs git and returns trimmed stdout, turning a non-zero exit into an error
/// that names the command and what git said.
fn checked(workdir: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(workdir, args)?;
    if !out.status.success() {
        return Err(format!(
            "GIT_FAILED: git {} ({})",
            args.join(" "),
            stderr_of(&out)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ensure_repo(workdir: &Path) -> Result<(), String> {
    let out = run(workdir, &["rev-parse", "--git-dir"])?;
    if !out.status.success() {
        return Err(format!(
            "NOT_A_REPO: {} ({})",
            workdir.display(),
            stderr_of(&out)
        ));
    }
    Ok(())
}

fn is_oid(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `None` on an unborn HEAD: `rev-parse HEAD` fails there and prints the literal
/// "HEAD" to stdout, which must not be mistaken for a commit id.
fn read_head(workdir: &Path) -> Result<Option<String>, String> {
    let out = run(workdir, &["rev-parse", "HEAD"])?;
    if !out.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if is_oid(&text) { Some(text) } else { None })
}

/// `None` when detached. Callers must also pass `None` for an unborn HEAD,
/// because `symbolic-ref` still reports the branch name there.
fn read_branch(workdir: &Path) -> Result<Option<String>, String> {
    let out = run(workdir, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    if !out.status.success() {
        return Ok(None);
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if name.is_empty() { None } else { Some(name) })
}

/// `git stash create` prints nothing when there are no tracked changes and
/// never touches the worktree. Unborn HEAD cannot hold tracked changes, so the
/// caller skips it entirely-`stash create` fails there.
fn create_stash(workdir: &Path) -> Result<Option<String>, String> {
    let out = run(workdir, &["stash", "create"])?;
    if !out.status.success() {
        return Err(format!(
            "GIT_FAILED: git stash create ({})",
            stderr_of(&out)
        ));
    }
    let hash = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if hash.is_empty() { None } else { Some(hash) })
}

/// Repo-relative untracked paths. NUL separation keeps names with spaces or
/// newlines intact; non-UTF-8 names are dropped because the on-disk record is
/// JSON and must round-trip.
fn untracked_paths(workdir: &Path) -> Result<Vec<String>, String> {
    let out = run(
        workdir,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    if !out.status.success() {
        return Err(format!(
            "GIT_FAILED: git ls-files --others ({})",
            stderr_of(&out)
        ));
    }
    Ok(out
        .stdout
        .split(|b| *b == 0)
        .filter(|bytes| !bytes.is_empty())
        .filter_map(|bytes| std::str::from_utf8(bytes).ok())
        .filter(|rel| safe_relative(rel).is_some())
        .map(str::to_string)
        .collect())
}

fn checkpoint_dir(data_dir: &Path, live_id: &str, checkpoint_id: &str) -> PathBuf {
    data_dir
        .join("remote")
        .join("checkpoints")
        .join(live_id)
        .join(checkpoint_id)
}

/// Copies the regular, non-empty untracked files into the checkpoint. A file
/// that cannot be read is skipped: an unreadable entry must not fail the turn.
/// A failed copy is different-a checkpoint that silently lacks its archive
/// would fail the later rollback, so it fails now.
fn archive_untracked(workdir: &Path, dest: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let mut archived = Vec::new();
    for rel in paths {
        let Some(rel_path) = safe_relative(rel) else {
            continue;
        };
        let src = workdir.join(rel_path);
        let Ok(meta) = std::fs::symlink_metadata(&src) else {
            continue;
        };
        // A symlink is not a regular file; recreating it as a copy would lie.
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&src) else {
            continue;
        };
        let dst = dest.join(rel_path);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("CHECKPOINT_FAILED: {} ({e})", parent.display()))?;
        }
        std::fs::write(&dst, bytes)
            .map_err(|e| format!("CHECKPOINT_FAILED: {} ({e})", dst.display()))?;
        archived.push(rel.clone());
    }
    Ok(archived)
}

pub fn create(
    workdir: &Path,
    data_dir: &Path,
    live_id: &str,
    items_len: usize,
) -> Result<Checkpoint, String> {
    safe_id(live_id)?;
    ensure_repo(workdir)?;

    let head = read_head(workdir)?;
    let branch = if head.is_some() {
        read_branch(workdir)?
    } else {
        None
    };
    let stash = if head.is_some() {
        create_stash(workdir)?
    } else {
        None
    };

    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let checkpoint_id = hex_encode(&bytes);

    if let Some(stash) = &stash {
        let reference = format!("refs/bnote/checkpoints/{live_id}/{checkpoint_id}");
        checked(workdir, &["update-ref", &reference, stash])?;
    }

    let paths = untracked_paths(workdir)?;
    let dir = checkpoint_dir(data_dir, live_id, &checkpoint_id);
    let archived = archive_untracked(workdir, &dir.join("untracked"), &paths)?;

    let record = Record {
        checkpoint_id,
        live_id: live_id.to_string(),
        head,
        branch,
        items_len,
        created_at: now_ms(),
        stash,
        untracked: archived,
    };
    let json = serde_json::to_string_pretty(&record)
        .map_err(|e| format!("CHECKPOINT_FAILED: serialize ({e})"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("CHECKPOINT_FAILED: {} ({e})", dir.display()))?;
    let path = dir.join("checkpoint.json");
    std::fs::write(&path, json)
        .map_err(|e| format!("CHECKPOINT_FAILED: {} ({e})", path.display()))?;
    Ok(record.public())
}

/// Ids are unique per session, so the owning `live_id` directory is discovered
/// by scanning; looking for the file is cheap and keeps the on-disk layout
/// keyed by session.
fn load_record(data_dir: &Path, checkpoint_id: &str) -> Result<Record, String> {
    safe_id(checkpoint_id)?;
    let root = data_dir.join("remote").join("checkpoints");
    let entries = std::fs::read_dir(&root)
        .map_err(|e| format!("NOT_FOUND: checkpoint {checkpoint_id} ({e})"))?;
    for entry in entries.flatten() {
        let path = entry.path().join(checkpoint_id).join("checkpoint.json");
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("BAD_CHECKPOINT: {} ({e})", path.display()))?;
        let record: Record = serde_json::from_slice(&bytes)
            .map_err(|e| format!("BAD_CHECKPOINT: {} ({e})", path.display()))?;
        if record.checkpoint_id != checkpoint_id {
            return Err(format!(
                "BAD_CHECKPOINT: {} records {}",
                path.display(),
                record.checkpoint_id
            ));
        }
        return Ok(record);
    }
    Err(format!("NOT_FOUND: checkpoint {checkpoint_id}"))
}

/// The stash commit and the archived untracked paths, for the diff view.
/// A checkpoint with no tracked changes has no stash; its tree is HEAD.
pub fn diff_base(
    data_dir: &Path,
    checkpoint_id: &str,
) -> Result<(Option<String>, Vec<String>), String> {
    let record = load_record(data_dir, checkpoint_id)?;
    Ok((record.stash, record.untracked))
}

pub fn load(data_dir: &Path, checkpoint_id: &str) -> Result<Checkpoint, String> {
    Ok(load_record(data_dir, checkpoint_id)?.public())
}

/// Restores the worktree to the checkpoint. The record is re-read from disk so
/// the caller's in-memory copy can never drive a restore with stale values.
///
/// The stale check comes first and changes nothing: rollback must never mix a
/// checkpoint's files into a branch or commit it does not belong to.
pub fn rollback(workdir: &Path, data_dir: &Path, checkpoint: &Checkpoint) -> Result<(), String> {
    let record = load_record(data_dir, &checkpoint.checkpoint_id)?;

    ensure_repo(workdir).map_err(|e| format!("ROLLBACK_FAILED: {e}"))?;
    let current_head = read_head(workdir).map_err(|e| format!("ROLLBACK_FAILED: {e}"))?;
    let current_branch = if current_head.is_none() {
        None
    } else {
        read_branch(workdir).map_err(|e| format!("ROLLBACK_FAILED: {e}"))?
    };

    if let Some(expected) = &record.branch {
        if current_branch.as_deref() != Some(expected.as_str()) {
            return Err(format!(
                "CHECKPOINT_STALE: branch was {expected}, now {}",
                current_branch.as_deref().unwrap_or("detached")
            ));
        }
    }
    if let Some(expected) = &record.head {
        if current_head.as_deref() != Some(expected.as_str()) {
            return Err(format!(
                "CHECKPOINT_STALE: HEAD was {expected}, now {}",
                current_head.as_deref().unwrap_or("unborn")
            ));
        }
    }

    if let Some(head) = &record.head {
        checked(workdir, &["reset", "--hard", head])
            .map_err(|e| format!("ROLLBACK_FAILED: {e}"))?;
    }
    // `read-tree -u --reset` puts the index and worktree back to the stashed
    // tree, which is the checkpoint's dirty tracked state. It deliberately
    // resets the index: staging state is not part of a checkpoint.
    if let Some(stash) = &record.stash {
        checked(workdir, &["read-tree", "-u", "--reset", stash])
            .map_err(|e| format!("ROLLBACK_FAILED: {e}"))?;
    }

    // Files created after the checkpoint are not listed and therefore survive;
    // archived ones are written back over whatever is there now.
    let archive =
        checkpoint_dir(data_dir, &record.live_id, &record.checkpoint_id).join("untracked");
    for rel in &record.untracked {
        let Some(rel_path) = safe_relative(rel) else {
            continue;
        };
        let src = archive.join(rel_path);
        let dst = workdir.join(rel_path);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("ROLLBACK_FAILED: {} ({e})", parent.display()))?;
        }
        let bytes =
            std::fs::read(&src).map_err(|e| format!("ROLLBACK_FAILED: {} ({e})", src.display()))?;
        std::fs::write(&dst, bytes)
            .map_err(|e| format!("ROLLBACK_FAILED: {} ({e})", dst.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Unique directory per test, removed on drop. The counter is enough for
    /// uniqueness within the process; the pid keeps parallel test binaries
    /// from colliding.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new(label: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "bnote-checkpoint-{}-{n}-{label}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("scratch dir");
            Self { root }
        }

        fn data(&self) -> PathBuf {
            self.root.join("data")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn init_repo(scratch: &Scratch) -> PathBuf {
        let repo = scratch.root.join("repo");
        std::fs::create_dir_all(&repo).expect("repo dir");
        checked(&repo, &["init", "-q"]).expect("git init");
        checked(&repo, &["config", "user.email", "checkpoint@example.com"]).expect("config email");
        checked(&repo, &["config", "user.name", "Checkpoint Test"]).expect("config name");
        // A global commit.gpgsign=true would otherwise make commits fail.
        checked(&repo, &["config", "commit.gpgsign", "false"]).expect("config signing");
        repo
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent dir");
        }
        std::fs::write(path, text).expect("write file");
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).expect("read file")
    }

    fn commit(repo: &Path, message: &str) {
        checked(repo, &["add", "-A"]).expect("git add");
        checked(repo, &["commit", "-q", "-m", message]).expect("git commit");
    }

    fn status(repo: &Path) -> String {
        checked(repo, &["status", "--porcelain"]).expect("git status")
    }

    #[test]
    fn clean_repo_rolls_back_to_a_clean_tree() {
        let scratch = Scratch::new("clean");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");

        let checkpoint = create(&repo, &scratch.data(), "live", 2).expect("create");
        assert_eq!(checkpoint.items_len, 2);
        assert!(checkpoint.head.is_some());
        assert!(checkpoint.branch.is_some());
        assert_eq!(checkpoint.checkpoint_id.len(), 32);

        rollback(&repo, &scratch.data(), &checkpoint).expect("rollback");
        assert_eq!(status(&repo), "");
        assert_eq!(read(&repo.join("a.txt")), "one\n");
    }

    #[test]
    fn modified_tracked_file_is_restored() {
        let scratch = Scratch::new("modified");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        write(&repo.join("a.txt"), "two\n");

        rollback(&repo, &scratch.data(), &checkpoint).expect("rollback");
        assert_eq!(read(&repo.join("a.txt")), "one\n");
        assert_eq!(status(&repo), "");
    }

    #[test]
    fn untracked_file_is_archived_and_restored() {
        let scratch = Scratch::new("untracked");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");
        write(&repo.join("notes/scratch.md"), "keep me\n");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        let record = load_record(&scratch.data(), &checkpoint.checkpoint_id).expect("record");
        assert_eq!(record.untracked, vec!["notes/scratch.md".to_string()]);

        std::fs::remove_file(repo.join("notes/scratch.md")).expect("remove");
        rollback(&repo, &scratch.data(), &checkpoint).expect("rollback");
        assert_eq!(read(&repo.join("notes/scratch.md")), "keep me\n");
    }

    #[test]
    fn empty_untracked_file_is_not_archived() {
        let scratch = Scratch::new("empty-untracked");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");
        write(&repo.join("empty.txt"), "");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        let record = load_record(&scratch.data(), &checkpoint.checkpoint_id).expect("record");
        assert!(record.untracked.is_empty());
    }

    #[test]
    fn deleted_tracked_file_is_restored() {
        let scratch = Scratch::new("deleted");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        std::fs::remove_file(repo.join("a.txt")).expect("remove");

        rollback(&repo, &scratch.data(), &checkpoint).expect("rollback");
        assert_eq!(read(&repo.join("a.txt")), "one\n");
        assert_eq!(status(&repo), "");
    }

    #[test]
    fn rename_is_restored() {
        let scratch = Scratch::new("rename");
        let repo = init_repo(&scratch);
        write(&repo.join("old.txt"), "one\n");
        commit(&repo, "one");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        checked(&repo, &["mv", "old.txt", "new.txt"]).expect("git mv");

        rollback(&repo, &scratch.data(), &checkpoint).expect("rollback");
        assert_eq!(read(&repo.join("old.txt")), "one\n");
        assert!(!repo.join("new.txt").exists());
        assert_eq!(status(&repo), "");
    }

    #[test]
    fn staged_change_rolls_back_to_checkpoint_content() {
        let scratch = Scratch::new("staged");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");
        write(&repo.join("a.txt"), "two\n");
        checked(&repo, &["add", "a.txt"]).expect("stage");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        let record = load_record(&scratch.data(), &checkpoint.checkpoint_id).expect("record");
        assert!(record.stash.is_some(), "a staged change must be stashed");

        write(&repo.join("a.txt"), "three\n");
        rollback(&repo, &scratch.data(), &checkpoint).expect("rollback");
        assert_eq!(read(&repo.join("a.txt")), "two\n");
    }

    #[test]
    fn unborn_head_checkpoint_restores_untracked_files() {
        let scratch = Scratch::new("unborn");
        let repo = init_repo(&scratch);
        write(&repo.join("u.txt"), "first\n");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        assert!(checkpoint.head.is_none());
        assert!(checkpoint.branch.is_none());
        let record = load_record(&scratch.data(), &checkpoint.checkpoint_id).expect("record");
        assert!(record.stash.is_none());

        std::fs::remove_file(repo.join("u.txt")).expect("remove");
        rollback(&repo, &scratch.data(), &checkpoint).expect("rollback");
        assert_eq!(read(&repo.join("u.txt")), "first\n");
    }

    #[test]
    fn stale_head_is_refused_and_worktree_untouched() {
        let scratch = Scratch::new("stale");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        write(&repo.join("a.txt"), "two\n");
        commit(&repo, "two");

        let error = rollback(&repo, &scratch.data(), &checkpoint).expect_err("stale");
        assert!(error.starts_with("CHECKPOINT_STALE"), "{error}");
        assert_eq!(read(&repo.join("a.txt")), "two\n");
        assert_eq!(status(&repo), "");
    }

    #[test]
    fn stale_branch_is_refused() {
        let scratch = Scratch::new("stale-branch");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");

        let checkpoint = create(&repo, &scratch.data(), "live", 0).expect("create");
        checked(&repo, &["checkout", "-q", "-b", "other"]).expect("checkout");

        let error = rollback(&repo, &scratch.data(), &checkpoint).expect_err("stale");
        assert!(error.starts_with("CHECKPOINT_STALE"), "{error}");
    }

    #[test]
    fn load_round_trips_the_public_struct() {
        let scratch = Scratch::new("load");
        let repo = init_repo(&scratch);
        write(&repo.join("a.txt"), "one\n");
        commit(&repo, "one");

        let checkpoint = create(&repo, &scratch.data(), "live", 7).expect("create");
        let loaded = load(&scratch.data(), &checkpoint.checkpoint_id).expect("load");
        assert_eq!(loaded.checkpoint_id, checkpoint.checkpoint_id);
        assert_eq!(loaded.live_id, "live");
        assert_eq!(loaded.head, checkpoint.head);
        assert_eq!(loaded.branch, checkpoint.branch);
        assert_eq!(loaded.items_len, 7);
        assert_eq!(loaded.created_at, checkpoint.created_at);
    }

    #[test]
    fn non_repo_and_bad_ids_are_refused() {
        let scratch = Scratch::new("refused");
        let plain = scratch.root.join("plain");
        std::fs::create_dir_all(&plain).expect("plain dir");

        let error = create(&plain, &scratch.data(), "live", 0).expect_err("not a repo");
        assert!(error.starts_with("NOT_A_REPO"), "{error}");

        let repo = init_repo(&scratch);
        let error = create(&repo, &scratch.data(), "../evil", 0).expect_err("bad id");
        assert!(error.starts_with("BAD_ID"), "{error}");

        let error = load(&scratch.data(), "../evil").expect_err("bad id");
        assert!(error.starts_with("BAD_ID"), "{error}");
    }
}
