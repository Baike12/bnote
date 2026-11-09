//! The bash tool's execution model.
//!
//! Two pieces:
//!
//! 1. **Foreground commands with a persistent working directory.** Each call
//!    spawns one `sh` process that `cd`s to the remembered directory, runs the
//!    command, prints the resulting directory through a per-call sentinel and
//!    exits with the command's code. A fresh process per call (instead of one
//!    long-lived interactive shell) keeps timeouts and aborts trivially safe —
//!    killing the process cannot corrupt a shared shell — while the sentinel
//!    replay keeps the Claude-Code semantics the model expects: `cd` persists
//!    across calls.
//!
//! 2. **Background tasks** (`run_in_background`). They run detached with their
//!    output buffered here; `bash_output` polls them, and completion fires a
//!    callback the session turns into a wakeup so the model is woken even when
//!    the turn already ended (the "event wake-up" path).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;

use super::cancel::Abort;

/// Default / max foreground timeout (seconds).
pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
pub const MAX_TIMEOUT_SECS: u64 = 600;

/// One session's remembered bash working directory. `None` = not yet resolved
/// (the next command anchors at the session's default directory).
#[derive(Default)]
pub struct ShellCwd(Mutex<Option<PathBuf>>);

impl ShellCwd {
    pub fn new() -> Self {
        Self::default()
    }

    fn current(&self, default_dir: &Path) -> PathBuf {
        self.0
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| default_dir.to_path_buf())
    }

    fn set(&self, p: PathBuf) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(p);
        }
    }

    /// Back to "anchor at the default directory next time" (a failed cd).
    fn reset(&self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

/// Output of one foreground command.
pub struct ShellOutput {
    pub ok: bool,
    pub text: String,
}

/// Runs `command` in the session's persistent directory. `default_dir` is the
/// anchor before the first `cd` (vault for study/creative, project root for
/// coding). `abort` kills the process between polls.
pub async fn run_command(
    command: &str,
    timeout_secs: u64,
    cwd: &ShellCwd,
    default_dir: &Path,
    abort: &Arc<Abort>,
) -> ShellOutput {
    let timeout = timeout_secs.clamp(1, MAX_TIMEOUT_SECS);
    // Per-call sentinel: a command that echoes a decoy cannot forge the cwd line.
    let marker = format!(
        "__BNOTE_CWD_{}__",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    // The anchor goes through a variable: embedding a quoted path inside the
    // printf format string would break the quoting. Explicit positional args:
    // a `{}` inside the printf would silently swallow the anchor. On cd
    // failure the script prints a BARE marker and exits 97 — `$PWD` there is
    // the inherited environment value, not the shell's real directory — and
    // the Rust side resets the anchor instead.
    let script = format!(
        "__bnote_anchor={0}\ncd \"$__bnote_anchor\" || {{ printf '{1}\\n'; exit 97; }}\n{2}\n__bnote_ec=$?\nprintf '{3}%s\\n' \"$PWD\"\nexit $__bnote_ec\n",
        shell_quote(&cwd.current(default_dir)),
        marker,
        command,
        marker,
    );
    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&script)
        .current_dir(default_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Err(e) => {
            return ShellOutput {
                ok: false,
                text: format!("spawn failed: {}", e),
            }
        }
        Ok(c) => c,
    };
    // Both pipes were requested on spawn; a missing one means the child died
    // immediately — report instead of unwrapping.
    let Some(mut stdout) = child.stdout.take() else {
        return ShellOutput {
            ok: false,
            text: "spawn produced no stdout".into(),
        };
    };
    let Some(mut stderr) = child.stderr.take() else {
        return ShellOutput {
            ok: false,
            text: "spawn produced no stderr".into(),
        };
    };
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let (ok, text) = loop {
        tokio::select! {
            n = stdout.read_buf(&mut out_buf), if stdout_open => {
                match n {
                    Ok(0) | Err(_) => stdout_open = false,
                    Ok(_) => {}
                }
            }
            n = stderr.read_buf(&mut err_buf), if stderr_open => {
                match n {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(_) => {}
                }
            }
            status = child.wait() => {
                let _ = stdout.read_to_end(&mut out_buf).await;
                let _ = stderr.read_to_end(&mut err_buf).await;
                match status {
                    Ok(st) => {
                        let code = st.code().unwrap_or(-1);
                        break (st.success(), format_output(code, &out_buf, &err_buf));
                    }
                    Err(e) => break (false, format!("wait failed: {}", e)),
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                let _ = child.kill().await;
                let mut text = String::from_utf8_lossy(&out_buf).to_string();
                text.push_str(&stderr_tail(&err_buf));
                break (false, format!("timeout after {}s\n{}", timeout, truncate(&text, 5_000)));
            }
            // The abort branch must stay enabled: a `select!` precondition is
            // evaluated once, when the select is entered, so `if abort.is_aborted()`
            // froze to “disabled” for a command that was not aborted yet, and a
            // silent command (no read ever ready) kept that select open until it
            // exited on its own — the stop button did nothing. The branch waits
            // on the token instead, so a later abort always wakes it.
            _ = abort.wait() => {
                let _ = child.kill().await;
                let mut text = String::from_utf8_lossy(&out_buf).to_string();
                text.push_str(&stderr_tail(&err_buf));
                break (false, format!("aborted by user\n{}", truncate(&text, 5_000)));
            }
        }
        if out_buf.len() + err_buf.len() > 1_000_000 {
            let _ = child.kill().await;
            break (false, "output too large".into());
        }
    };
    // Split off the sentinel line and remember the resulting directory. A
    // bare marker line = the cd failed (exit 97): reset to the anchor.
    let mut new_cwd: Option<PathBuf> = None;
    let mut cd_failed = false;
    let mut cleaned = String::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(&marker) {
            let p = rest.trim();
            if p.is_empty() {
                cd_failed = true;
            } else {
                new_cwd = Some(PathBuf::from(p));
            }
            continue;
        }
        cleaned.push_str(line);
        cleaned.push('\n');
    }
    if let Some(p) = new_cwd {
        cwd.set(p);
    } else if cd_failed {
        cwd.reset();
    }
    ShellOutput {
        ok,
        text: cleaned.trim_end().to_string(),
    }
}

fn stderr_tail(err_buf: &[u8]) -> String {
    let errs = String::from_utf8_lossy(err_buf);
    if errs.trim().is_empty() {
        String::new()
    } else {
        format!("\n[stderr]\n{}", errs)
    }
}

fn format_output(code: i32, out_buf: &[u8], err_buf: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(out_buf).to_string();
    text.push_str(&stderr_tail(err_buf));
    format!("exit: {}\n{}", code, truncate(&text, 30_000))
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut out = s.chars().take(n).collect::<String>();
        out.push_str("\n…[truncated]");
        out
    }
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum BgStatus {
    Running,
    Done { ok: bool, code: i32 },
}

pub struct BgTask {
    pub id: u64,
    pub command: String,
    /// Rolling buffer, capped to keep a runaway task from eating memory.
    output: Mutex<String>,
    status: Mutex<BgStatus>,
    /// Asks the supervising task to kill the child. `None` once fired: a second
    /// `bash_kill` must not look like a fresh signal that never arrives.
    kill: Mutex<Option<oneshot::Sender<()>>>,
}

impl BgTask {
    pub fn status(&self) -> BgStatus {
        self.status
            .lock()
            .map(|g| g.clone())
            .unwrap_or(BgStatus::Running)
    }

    fn push_output(&self, bytes: &[u8]) {
        const CAP: usize = 200_000;
        if let Ok(mut out) = self.output.lock() {
            out.push_str(&String::from_utf8_lossy(bytes));
            if out.len() > CAP {
                let mut cut = out.len() - CAP;
                while !out.is_char_boundary(cut) {
                    cut += 1;
                }
                out.drain(..cut);
            }
        }
    }

    pub fn output(&self) -> String {
        self.output.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Signals the process to die. The supervising task kills the child and the
    /// ordinary completion path reports the result.
    pub fn kill(&self) {
        if let Ok(mut slot) = self.kill.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(());
            }
        }
    }
}

/// All background tasks of one session, keyed by id.
#[derive(Default)]
pub struct BgRegistry {
    next_id: AtomicU64,
    tasks: Mutex<HashMap<u64, Arc<BgTask>>>,
}

impl BgRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: u64) -> Option<Arc<BgTask>> {
        self.tasks.lock().ok().and_then(|g| g.get(&id).cloned())
    }

    /// Spawns a detached command anchored at `cwd`. Output streams into the
    /// task's buffer; `on_done` fires once with (id, ok, exit code) when the
    /// process exits.
    pub fn spawn(
        &self,
        command: String,
        cwd: PathBuf,
        on_done: Arc<dyn Fn(u64, bool, i32) + Send + Sync>,
    ) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (kill_tx, kill_rx) = oneshot::channel();
        let task = Arc::new(BgTask {
            id,
            command: command.clone(),
            output: Mutex::new(String::new()),
            status: Mutex::new(BgStatus::Running),
            kill: Mutex::new(Some(kill_tx)),
        });
        let script = format!(
            "cd {} || exit 97\n{}\nexit $?\n",
            shell_quote(&cwd),
            command
        );
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&script)
            .current_dir(&cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn failed: {}", e))?;
        let Some(mut stdout) = child.stdout.take() else {
            return Err("spawn produced no stdout".into());
        };
        let Some(mut stderr) = child.stderr.take() else {
            return Err("spawn produced no stderr".into());
        };
        self.tasks
            .lock()
            .map_err(|_| "registry poisoned")?
            .insert(id, task.clone());
        tauri::async_runtime::spawn(async move {
            // Two buffers: one read cell shared by both streams would borrow
            // `buf` twice inside the same select.
            let mut out_buf = [0u8; 8192];
            let mut err_buf = [0u8; 8192];
            let mut stdout_open = true;
            let mut stderr_open = true;
            let mut kill_rx = kill_rx;
            let mut killed = false;
            while stdout_open || stderr_open {
                tokio::select! {
                    _ = &mut kill_rx, if !killed => {
                        killed = true;
                        let _ = child.kill().await;
                    }
                    n = stdout.read(&mut out_buf), if stdout_open => {
                        match n {
                            Ok(0) | Err(_) => stdout_open = false,
                            Ok(n) => task.push_output(&out_buf[..n]),
                        }
                    }
                    n = stderr.read(&mut err_buf), if stderr_open => {
                        match n {
                            Ok(0) | Err(_) => stderr_open = false,
                            Ok(n) => task.push_output(&err_buf[..n]),
                        }
                    }
                }
            }
            let done = child.wait().await;
            let (ok, code) = match done {
                Ok(st) => (st.success(), st.code().unwrap_or(-1)),
                Err(_) => (false, -1),
            };
            if let Ok(mut slot) = task.status.lock() {
                *slot = BgStatus::Done { ok, code };
            }
            on_done(id, ok, code);
        });
        Ok(id)
    }
}

/// Formats the polling answer for `bash_output`.
pub fn format_bg_status(task: &BgTask) -> String {
    let head = match task.status() {
        BgStatus::Running => format!("background task {} still running", task.id),
        BgStatus::Done { ok, code } => format!(
            "background task {} finished, exit: {} ({})",
            task.id,
            code,
            if ok { "ok" } else { "failed" }
        ),
    };
    let out = task.output();
    if out.trim().is_empty() {
        head
    } else {
        format!("{}\n{}", head, truncate(&out, 20_000))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cd_persists_across_calls() {
        let dir = std::env::temp_dir().join("bnote-shell-cwd");
        let _ = std::fs::remove_dir_all(&dir);
        let a = dir.join("a");
        let b = dir.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let cwd = ShellCwd::new();
        let abort = Abort::new();
        let out = run_command("cd ../b", 10, &cwd, &a, &abort).await;
        assert!(out.ok, "{}", out.text);
        assert_eq!(cwd.current(&a), b, "cd must be remembered");
        let out = run_command("pwd", 10, &cwd, &a, &abort).await;
        assert!(out.ok, "{}", out.text);
        assert!(
            out.text.contains("/b"),
            "pwd must run in the remembered dir:\n{}",
            out.text
        );
        // The sentinel line never leaks into the model-visible output.
        assert!(!out.text.contains("__BNOTE_CWD_"), "{}", out.text);
    }

    #[tokio::test]
    async fn a_deleted_cwd_resets_to_the_anchor_instead_of_wedging() {
        let dir = std::env::temp_dir().join("bnote-shell-gone");
        let _ = std::fs::remove_dir_all(&dir);
        let a = dir.join("anchor");
        let gone = dir.join("gone");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&gone).unwrap();
        let cwd = ShellCwd::new();
        cwd.set(gone.clone());
        std::fs::remove_dir_all(&gone).unwrap();
        let abort = Abort::new();
        let out = run_command("echo hi", 10, &cwd, &a, &abort).await;
        assert!(!out.ok, "the command must fail when the anchor is gone");
        assert_eq!(cwd.current(&a), a, "a failed cd resets the anchor");
    }

    #[tokio::test]
    async fn timeout_and_exit_code_are_reported() {
        let dir = std::env::temp_dir().join("bnote-shell-timeout");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = ShellCwd::new();
        let abort = Abort::new();
        let out = run_command("sleep 5", 1, &cwd, &dir, &abort).await;
        assert!(!out.ok);
        assert!(out.text.contains("timeout after 1s"), "{}", out.text);
        let out = run_command("exit 3", 10, &cwd, &dir, &abort).await;
        assert!(!out.ok);
        assert!(out.text.starts_with("exit: 3"), "{}", out.text);
    }

    #[tokio::test]
    async fn abort_kills_the_running_command() {
        let dir = std::env::temp_dir().join("bnote-shell-abort");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = ShellCwd::new();
        let abort = Abort::new();
        abort.abort();
        let out = run_command("sleep 5", 30, &cwd, &dir, &abort).await;
        assert!(!out.ok);
        assert!(out.text.contains("aborted"), "{}", out.text);
    }

    #[tokio::test]
    async fn abort_that_arrives_while_a_silent_command_runs_still_kills_it() {
        // The stop button's real shape: the user presses it after the command
        // started. A silent command (no output for its whole life) never wakes
        // the reads, so an abort check written as a `select!` precondition is
        // evaluated once and disabled for the rest of that select — the child
        // then runs to completion and the model's turn keeps going. `find ~`
        // took 50s under exactly this shape.
        let dir = std::env::temp_dir().join("bnote-shell-abort-late");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = ShellCwd::new();
        let abort = Abort::new();
        let started = std::time::Instant::now();
        let flag = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            flag.abort();
        });
        let out = run_command("sleep 5", 30, &cwd, &dir, &abort).await;
        let elapsed = started.elapsed();
        assert!(!out.ok, "{}", out.text);
        assert!(out.text.contains("aborted"), "{}", out.text);
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "the kill must land right after the abort, not at the command's own end: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn stderr_is_captured_with_the_exit_code() {
        let dir = std::env::temp_dir().join("bnote-shell-stderr");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = ShellCwd::new();
        let abort = Abort::new();
        let out = run_command("echo out; echo err >&2; exit 1", 10, &cwd, &dir, &abort).await;
        assert!(!out.ok);
        assert!(out.text.contains("out"), "{}", out.text);
        assert!(
            out.text.contains("[stderr]") && out.text.contains("err"),
            "{}",
            out.text
        );
    }

    #[tokio::test]
    async fn background_tasks_buffer_output_and_finish() {
        let dir = std::env::temp_dir().join("bnote-shell-bg");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let registry = BgRegistry::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Arc::new(Mutex::new(tx));
        let tx2 = tx.clone();
        let id = registry
            .spawn(
                "echo bg-hello".into(),
                dir.clone(),
                Arc::new(move |id, ok, code| {
                    tx2.lock().unwrap().send((id, ok, code)).unwrap();
                }),
            )
            .unwrap();
        let task = registry.get(id).unwrap();
        for _ in 0..100 {
            if task.status() != BgStatus::Running {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            matches!(task.status(), BgStatus::Done { ok: true, code: 0 }),
            "{:?}",
            task.status()
        );
        assert!(task.output().contains("bg-hello"), "{}", task.output());
        let (got_id, ok, code) = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        assert_eq!(got_id, id);
        assert!(ok && code == 0);
        let text = format_bg_status(&task);
        assert!(text.contains("finished"), "{}", text);
    }
}
