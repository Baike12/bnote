//! Integrated terminal sessions for the code pane.
//!
//! The emulation lives in the frontend (xterm.js); this module owns only the
//! real PTY: one shell per session, bytes out, keystrokes in, and its size. A
//! shell must run on a PTY rather than a pipe — job control, line editing and
//! cursor addressing all come from the terminal driver.
//!
//! Output is batched (>= 16 KiB or 8 ms idle) before it crosses the IPC
//! boundary: a single `ls -la` would otherwise turn into one event per 8 KiB
//! read and flood the window. The batching policy follows `python::runner`, but
//! the payload is base64 instead of text: a terminal stream may cut a UTF-8
//! sequence across two chunks, and xterm reassembles bytes correctly while a
//! trimmed string would lose them.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Chunks accumulated before a flush is forced.
const FLUSH_BYTES: usize = 16 * 1024;
/// How long a pending chunk may wait for more output before it is sent.
const FLUSH_IDLE: Duration = Duration::from_millis(8);
/// Exit polling interval. `Child::kill` needs `&mut self`, so no thread may
/// park inside `wait()` while holding the child lock (a close would deadlock).
const EXIT_POLL: Duration = Duration::from_millis(300);

const MIN_COLS: u16 = 2;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 2;
const MAX_ROWS: u16 = 400;

/// What `term_open` hands back: the session id plus the shell name as a title
/// (the frontend numbers the duplicates, see `src/code/term/tabs.ts`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenReply {
    pub term_id: u64,
    pub title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermOutput {
    term_id: u64,
    /// Base64: arbitrary bytes, reassembled by xterm.
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermExit {
    term_id: u64,
    exit_code: u32,
}

/// One live shell: the PTY pair's master side plus the child process.
pub struct TermSession {
    pub id: u64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

impl TermSession {
    fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "TERM_POISONED".to_string())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|e| format!("TERM_WRITE: {e}"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self
            .master
            .lock()
            .map_err(|_| "TERM_POISONED".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("TERM_RESIZE: {e}"))
    }
}

/// All live terminals of this app run, keyed by session id.
#[derive(Default)]
pub struct TermManager {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Arc<TermSession>>>,
}

impl TermManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a login shell in `root` on a fresh PTY.
    pub fn open(
        &self,
        app: &AppHandle,
        root: &str,
        cols: u16,
        rows: u16,
    ) -> Result<OpenReply, String> {
        let spawn = spawn_shell(&shell_path(), root, cols, rows)?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let session = Arc::new(TermSession {
            id,
            master: Mutex::new(spawn.master),
            writer: Mutex::new(spawn.writer),
            child: Mutex::new(spawn.child),
        });
        self.sessions
            .lock()
            .map_err(|_| "TERM_POISONED".to_string())?
            .insert(id, Arc::clone(&session));

        spawn_pump(app.clone(), id, spawn.reader);
        spawn_exit_watch(app.clone(), session);

        Ok(OpenReply {
            term_id: id,
            title: spawn.title,
        })
    }

    pub fn write(&self, id: u64, data: &[u8]) -> Result<(), String> {
        self.get(id)?.write(data)
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = clamp_size(cols, rows);
        self.get(id)?.resize(cols, rows)
    }

    /// Kill one shell. Returns false when the id is already gone (a repeated
    /// close is not an error).
    pub fn close(&self, id: u64) -> bool {
        let removed = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&id));
        let Some(session) = removed else {
            return false;
        };
        if let Ok(mut child) = session.child.lock() {
            if let Err(e) = child.kill() {
                // The shell may have exited on its own a moment ago; log it and
                // let the exit watcher report the code.
                eprintln!("[term] kill {id} failed: {e}");
            }
        }
        true
    }

    pub fn close_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut map| std::mem::take(&mut *map))
            .unwrap_or_default();
        for (_, session) in sessions {
            if let Ok(mut child) = session.child.lock() {
                if let Err(e) = child.kill() {
                    eprintln!("[term] kill {} on exit failed: {e}", session.id);
                }
            }
        }
    }

    fn get(&self, id: u64) -> Result<Arc<TermSession>, String> {
        self.sessions
            .lock()
            .map_err(|_| "TERM_POISONED".to_string())?
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("TERM_NOT_FOUND: {id}"))
    }
}

/// The user's shell, falling back to the macOS default.
fn shell_path() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty() && Path::new(s).is_file())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

/// Everything one PTY session is made of, before it gets an id.
struct ShellSpawn {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
    title: String,
}

/// Allocate the PTY and start the shell on it.
///
/// Split out of `TermManager::open` so the PTY itself can be exercised without
/// a window (`cargo test --lib term::`): that is where the platform risk lives
/// (a login shell, the controlling terminal, the cwd), not in the bookkeeping.
fn spawn_shell(shell: &str, root: &str, cols: u16, rows: u16) -> Result<ShellSpawn, String> {
    let cwd = Path::new(root);
    if !cwd.is_dir() {
        return Err(format!("TERM_CWD: not a directory: {root}"));
    }
    let (cols, rows) = clamp_size(cols, rows);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("TERM_OPENPTY: {e}"))?;

    let mut cmd = CommandBuilder::new(shell);
    // A login shell sources .zprofile / .bash_profile, which is where Homebrew
    // and version managers put PATH on macOS. Terminal.app does the same.
    cmd.arg("-l");
    cmd.cwd(cwd);
    // Forward the app's own environment explicitly: the shell must see the same
    // LANG / PATH the app was started with, regardless of what the PTY crate
    // decided to inherit.
    for (key, value) in std::env::vars_os() {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("TERM_SPAWN: {e}"))?;
    // The slave must close in the parent, otherwise the master never reports EOF
    // when the shell exits.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("TERM_READER: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("TERM_WRITER: {e}"))?;
    let title = Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("shell")
        .to_string();

    Ok(ShellSpawn {
        master: pair.master,
        writer,
        reader,
        child,
        title,
    })
}

/// Keep the PTY size sane: a bogus grid makes the kernel or the shell reject
/// the ioctl, and 0×0 makes curses programs divide by zero.
fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (
        cols.clamp(MIN_COLS, MAX_COLS),
        rows.clamp(MIN_ROWS, MAX_ROWS),
    )
}

/// Reader thread → channel → throttled flusher. The reader blocks on the PTY
/// (no timeout available on a file descriptor), so the two duties stay on two
/// threads: the flusher is the only one that emits.
fn spawn_pump(app: AppHandle, id: u64, mut reader: Box<dyn Read + Send>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                // On macOS the master read fails with EIO once the last slave
                // closes; that is the normal end of a session.
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
        loop {
            // Idle: block (no wakeups). Pending: wait briefly so a burst still
            // reaches xterm within a frame.
            let next = if pending.is_empty() {
                rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
            } else {
                rx.recv_timeout(FLUSH_IDLE)
            };
            match next {
                Ok(chunk) => {
                    pending.extend_from_slice(&chunk);
                    if pending.len() >= FLUSH_BYTES {
                        flush(&app, id, &mut pending);
                    }
                }
                Err(RecvTimeoutError::Timeout) => flush(&app, id, &mut pending),
                Err(RecvTimeoutError::Disconnected) => {
                    flush(&app, id, &mut pending);
                    break;
                }
            }
        }
    });
}

fn flush(app: &AppHandle, id: u64, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&pending[..]);
    pending.clear();
    // A window that is gone has no terminal to feed; there is nothing to
    // recover, and failing here must not break the pump.
    let _ = app.emit("term-output", TermOutput { term_id: id, data });
}

fn spawn_exit_watch(app: AppHandle, session: Arc<TermSession>) {
    std::thread::spawn(move || loop {
        {
            let Ok(mut child) = session.child.lock() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    drop(child);
                    let _ = app.emit(
                        "term-exit",
                        TermExit {
                            term_id: session.id,
                            exit_code: status.exit_code(),
                        },
                    );
                    return;
                }
                Ok(None) => {}
                // A child we cannot poll is a child we cannot report; stop
                // watching instead of spinning.
                Err(_) => return,
            }
        }
        std::thread::sleep(EXIT_POLL);
    });
}

#[cfg(test)]
mod tests {
    use super::{clamp_size, spawn_shell, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS};
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn zero_sized_grids_are_clamped_up() {
        assert_eq!(clamp_size(0, 0), (MIN_COLS, MIN_ROWS));
    }

    #[test]
    fn absurd_grids_are_clamped_down() {
        assert_eq!(clamp_size(65_535, 65_535), (MAX_COLS, MAX_ROWS));
    }

    #[test]
    fn a_normal_grid_passes_through() {
        assert_eq!(clamp_size(80, 24), (80, 24));
    }

    /// The real risk of this feature is the platform part: a login shell on a
    /// freshly allocated PTY, started in the project root, with the app's
    /// environment. Everything above that (ids, batching, events) is bookkeeping.
    /// `/bin/sh` keeps the test fast and free of user dotfiles.
    #[test]
    fn a_shell_runs_on_the_pty_in_the_given_directory() {
        let root = std::env::temp_dir().join(format!("bnote-term-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create the temp root");
        let root_text = root.to_string_lossy().to_string();

        let spawn = spawn_shell("/bin/sh", &root_text, 80, 24).expect("spawn the shell");
        let crate::term::ShellSpawn {
            master,
            mut writer,
            reader,
            mut child,
            title,
        } = spawn;
        assert_eq!(title, "sh");

        // The master must stay open: dropping it hangs up the session.
        let _master = master;
        writer
            .write_all(b"pwd\necho \"TERM=$TERM\"\nexit\n")
            .expect("write to the shell");
        writer.flush().expect("flush");

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Bounded: a broken PTY must fail the test, not hang the suite.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut text = String::new();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(chunk) => text.push_str(&String::from_utf8_lossy(&chunk)),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if text.contains(&root_text) && text.contains("TERM=xterm-256color") {
                break;
            }
        }

        let _ = child.kill();
        drop(writer);
        std::fs::remove_dir_all(&root).ok();

        assert!(
            text.contains(&root_text),
            "the shell did not start in {root_text}; output was: {text:?}"
        );
        assert!(
            text.contains("TERM=xterm-256color"),
            "TERM was not forwarded; output was: {text:?}"
        );
    }
}
