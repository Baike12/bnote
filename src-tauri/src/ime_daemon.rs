//! IME input-source operations, executed OUTSIDE the app's main thread.
//!
//! TIS must run on Apple's main queue (see `ime_tis`), and the app's main
//! thread is the UI thread: a synchronous `set_input_source` command froze the
//! whole app for the duration of the select — real traces show 25–104 ms per
//! switch, on every mode change, field focus and window activation. There is
//! no in-process way around that (an off-main TIS call traps with
//! dispatch_assert_queue_fail), so the select runs in a **helper process**
//! instead: this same binary re-executed with `--ime-helper`, long-lived,
//! talking a one-line-JSON-per-request protocol over stdin/stdout.
//!
//! - The helper never initializes Tauri (`main` checks the flag first), has no
//!   windows, never activates itself and carries the accessory activation
//!   policy (`hide_from_dock`), so spawning it steals no focus and adds no
//!   Dock icon.
//! - The helper is warm across switches: its TIS reference cache and the
//!   one-time TIS initialization are paid once at startup (the frontend's
//!   `imeWarmUp` list call), not on the user's first mode change.
//! - The app's main thread only writes and reads one pipe line per switch, so
//!   the UI never blocks on TIS — that is the whole point.
//! - Self-healing: a request that fails or exceeds [`READ_TIMEOUT`] discards
//!   the helper (kill; it also exits by itself on stdin EOF), and the next
//!   request spawns a fresh one. Errors propagate to the caller — the IME
//!   follow retries on the next transition instead of failing silently.

use std::io::{BufRead, BufWriter, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
use serde_json::json;

/// Argument that turns this binary into the IME helper (`main` checks it
/// before any Tauri initialization).
pub const HELPER_FLAG: &str = "--ime-helper";

/// A response may take the full cold-activation time (measured up to ~170 ms)
/// plus process startup on the first request; past this the helper is assumed
/// wedged and replaced.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// helper side (runs in the child process, no Tauri)
// ---------------------------------------------------------------------------

/// Serves one request line, writing exactly one response line. Public for the
/// protocol tests; the helper loop is the only production caller.
fn serve_request(line: &str, out: &mut dyn Write) -> std::io::Result<()> {
    let response: Result<serde_json::Value, String> = (|| {
        let req: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("bad request: {e}"))?;
        match req["op"].as_str() {
            Some("current") => {
                let id = crate::ime_tis::current_source_id();
                Ok(json!({ "id": id }))
            }
            Some("select") => {
                let id = req["id"]
                    .as_str()
                    .ok_or_else(|| "select: missing id".to_string())?;
                let started = Instant::now();
                let already = crate::ime_tis::select(id)?;
                let tis_ms = started.elapsed().as_secs_f64() * 1000.0;
                Ok(json!({ "switched": !already, "tisMs": tis_ms }))
            }
            Some("list") => {
                let sources = crate::ime_tis::selectable_sources();
                // Same warm-up as the old list path: pre-pay the cold select
                // initialization here, at startup, off the app's main thread.
                crate::ime_tis::warm_select_current();
                Ok(json!({ "sources": sources }))
            }
            _ => Err("unknown op".to_string()),
        }
    })();
    let value = match response {
        Ok(value) => value,
        Err(e) => json!({ "error": e }),
    };
    writeln!(out, "{value}")
}

/// Runs the helper: with no op argument it serves stdin lines until EOF (the
/// long-lived daemon mode); an op argument serves one request and exits.
/// Returns the process exit code.
fn run_helper(argv: &[String], out: &mut dyn Write) -> i32 {
    let flag_index = match argv.iter().position(|a| a == HELPER_FLAG) {
        Some(index) => index,
        None => return 2,
    };
    let rest: Vec<&str> = argv[flag_index + 1..].iter().map(String::as_str).collect();
    match rest.as_slice() {
        [] => {
            let stdin = std::io::stdin();
            let mut lines = stdin.lock().lines();
            loop {
                match lines.next() {
                    Some(Ok(line)) => {
                        if serve_request(&line, out).is_err() {
                            return 1;
                        }
                    }
                    // EOF (the app exited) or a read error: shut down quietly.
                    _ => return 0,
                }
            }
        }
        [op] => {
            let line = match *op {
                "current" => json!({ "op": "current" }).to_string(),
                "list" => json!({ "op": "list" }).to_string(),
                _ => {
                    eprintln!("usage: {HELPER_FLAG} [current|list]");
                    return 2;
                }
            };
            if serve_request(&line, out).is_err() {
                return 1;
            }
            0
        }
        ["select", id] => {
            let line = json!({ "op": "select", "id": id }).to_string();
            if serve_request(&line, out).is_err() {
                return 1;
            }
            0
        }
        _ => {
            eprintln!("usage: {HELPER_FLAG} [current|list|select <id>]");
            2
        }
    }
}

/// `main` calls this before any Tauri initialization: when the binary was
/// launched as the helper, the helper owns the process and this never returns.
pub fn maybe_run_helper(argv: &[String]) -> bool {
    if !argv.iter().any(|a| a == HELPER_FLAG) {
        return false;
    }
    hide_from_dock();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let code = run_helper(argv, &mut out);
    let _ = out.flush();
    std::process::exit(code);
}

/// The helper re-executes this binary and shares the app's Info.plist, so the
/// moment HIToolbox connects to the window server for TIS it checks in with
/// LaunchServices as a regular foreground application — a second bnote Dock
/// icon (observed 2026-11-14). The accessory policy withdraws that
/// registration (no Dock icon, not in Cmd-Tab) without touching TIS. Runs on
/// the helper's main thread, before any TIS call can check in.
fn hide_from_dock() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    if !app.setActivationPolicy(NSApplicationActivationPolicy::Accessory) {
        // Cosmetic only: the cost of a rejected policy is the spare Dock
        // icon, never a failed IME switch.
        eprintln!("ime helper: setActivationPolicy(accessory) rejected");
    }
}

// ---------------------------------------------------------------------------
// client side (the app)
// ---------------------------------------------------------------------------

pub struct Client {
    child: Mutex<Child>,
    stdin: Arc<Mutex<BufWriter<ChildStdin>>>,
    stdout: Arc<Mutex<std::io::BufReader<ChildStdout>>>,
}

impl Client {
    /// Re-executes this binary as the helper. The child keeps no relation to
    /// the app besides the pipe: no Tauri, no windows, no dock icon.
    fn spawn() -> std::io::Result<Client> {
        let exe = std::env::current_exe()?;
        let mut child = Command::new(exe)
            .arg(HELPER_FLAG)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        Ok(Client {
            child: Mutex::new(child),
            stdin: Arc::new(Mutex::new(BufWriter::new(stdin))),
            stdout: Arc::new(Mutex::new(std::io::BufReader::new(stdout))),
        })
    }

    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// One protocol round trip. The write+read pair runs on a side thread with
    /// a timeout: a wedged helper must cost one discarded request, not a
    /// permanently blocked IME pipeline.
    fn request(&self, line: String) -> Result<String, String> {
        let (tx, rx) = mpsc::channel();
        let stdin = self.stdin.clone();
        let stdout = self.stdout.clone();
        std::thread::spawn(move || {
            let result = (|| -> std::io::Result<String> {
                {
                    let mut writer = stdin
                        .lock()
                        .map_err(|e| std::io::Error::other(e.to_string()))?;
                    use std::io::Write as _;
                    writeln!(writer, "{line}")?;
                    writer.flush()?;
                }
                let mut reader = stdout
                    .lock()
                    .map_err(|e| std::io::Error::other(e.to_string()))?;
                let mut answer = String::new();
                let n = reader.read_line(&mut answer)?;
                if n == 0 {
                    // The helper is gone: EOF instead of a response.
                    return Err(std::io::Error::other("helper exited"));
                }
                Ok(answer)
            })();
            let _ = tx.send(result);
        });
        match rx.recv_timeout(READ_TIMEOUT) {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(e)) => Err(format!("ime helper io: {e}")),
            Err(_) => Err("ime helper timed out".to_string()),
        }
    }

    fn call(&self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        let answer = self.request(request.to_string())?;
        let value: serde_json::Value =
            serde_json::from_str(answer.trim()).map_err(|e| format!("ime helper: {e}"))?;
        if let Some(error) = value["error"].as_str() {
            return Err(error.to_string());
        }
        Ok(value)
    }

    /// Selects a source by id. Ok when the helper reports success; the source
    /// never changes when it was already active.
    pub fn select(&self, id: &str) -> Result<(bool, f64), String> {
        let value = self.call(json!({ "op": "select", "id": id }))?;
        let switched = value["switched"]
            .as_bool()
            .ok_or("ime helper: no switched")?;
        let tis_ms = value["tisMs"].as_f64().ok_or("ime helper: no tisMs")?;
        Ok((switched, tis_ms))
    }

    pub fn current(&self) -> Result<Option<String>, String> {
        let value = self.call(json!({ "op": "current" }))?;
        Ok(value["id"].as_str().map(str::to_string))
    }

    pub fn list(&self) -> Result<Vec<crate::commands::ime::InputSourceInfo>, String> {
        let value = self.call(json!({ "op": "list" }))?;
        serde_json::from_value(value["sources"].clone()).map_err(|e| format!("ime helper: {e}"))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.kill();
    }
}

static CLIENT: OnceLock<Mutex<Option<Arc<Client>>>> = OnceLock::new();

/// Runs `f` against the long-lived helper, spawning it on first use. A failed
/// request discards the helper so the next call starts fresh; the error
/// propagates to the command, whose caller retries on the next transition.
pub fn with_client<R>(f: impl FnOnce(&Client) -> Result<R, String>) -> Result<R, String> {
    let cell = CLIENT.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().map_err(|_| "ime client mutex poisoned")?;
    if guard.is_none() {
        let client = Client::spawn().map_err(|e| format!("ime helper spawn failed: {e}"))?;
        *guard = Some(Arc::new(client));
    }
    let client = guard.as_ref().expect("just filled").clone();
    match f(&client) {
        Ok(value) => Ok(value),
        Err(e) => {
            // One broken helper must not poison every later request: discard
            // it (Drop kills the child; a fresh one is spawned on demand).
            *guard = None;
            Err(e)
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Protocol-level errors only: these never reach TIS. The data operations
    /// (current / no-op select / list) run TIS, which traps when run in-process
    /// next to a test that has initialized AppKit (dispatch_assert_queue_fail,
    /// observed as a SIGABRT under `cargo test --lib`'s default parallelism) —
    /// they live in tests/ime_daemon.rs instead, in the real helper process,
    /// which is exactly why production runs them there too.
    #[test]
    fn bad_requests_answer_with_an_error_line_not_a_crash() {
        let serve = |line: &str| {
            let mut buf = Vec::new();
            serve_request(line, &mut buf).expect("serve");
            serde_json::from_str::<serde_json::Value>(
                std::str::from_utf8(&buf).expect("utf-8").trim(),
            )
            .expect("response json")
        };
        assert!(
            serve("this is not json")["error"]
                .as_str()
                .unwrap_or_default()
                != ""
        );
        assert_eq!(
            serve(&json!({ "op": "bogus" }).to_string())["error"],
            "unknown op"
        );
        assert_eq!(
            serve(&json!({ "op": "select" }).to_string())["error"],
            "select: missing id"
        );
    }
}
