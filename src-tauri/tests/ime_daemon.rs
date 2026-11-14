//! The IME helper as a real process: this binary re-executed with
//! `--ime-helper`, talking the line protocol over pipes.
//!
//! Every operation sent here is a **no-op by construction** — reading the
//! current source, and "selecting" the source that is already active (the
//! helper returns before any TISSelectInputSource call) — so the test never
//! changes the user's input method.
//!
//! This is the native performance gate for the notes-area IME path: the whole
//! point of the helper is that a 25–100 ms TIS select (real-trace range) runs
//! in THIS process, not on the app's UI thread. The measured numbers document
//! the switch's end-to-end hand-over cost.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

/// One helper process. `stdin` is an `Option` so the EOF test can close it
/// without going through [`Drop`], which kills the child.
struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Helper {
    fn start() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bnote"))
            .arg(bnote_lib::ime_daemon::HELPER_FLAG)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn the ime helper");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        Helper {
            child,
            stdin: Some(stdin),
            stdout,
        }
    }

    fn ask(&mut self, request: Value) -> Value {
        let stdin = self.stdin.as_mut().expect("stdin");
        writeln!(stdin, "{request}").expect("write request");
        stdin.flush().expect("flush request");
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read response");
        serde_json::from_str(line.trim()).expect("response json")
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn the_helper_serves_current_select_and_list_over_the_line_protocol() {
    let mut helper = Helper::start();

    // Warm the helper (the first request pays process spawn + TIS init), then
    // measure the steady-state switch cost.
    let started = Instant::now();
    let current = helper.ask(json!({ "op": "current" }));
    println!("[ime] first round trip: {:?}", started.elapsed());
    let id = current["id"]
        .as_str()
        .expect("current must name the active source")
        .to_string();
    assert!(!id.is_empty());

    let mut durations = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        let answer = helper.ask(json!({ "op": "select", "id": id }));
        durations.push(t.elapsed());
        assert_eq!(
            answer["switched"], false,
            "selecting the active source must be a no-op: the user's input method never changes"
        );
        assert!(answer["tisMs"].as_f64().is_some(), "{answer}");
    }
    durations.sort();
    let median = durations[durations.len() / 2];
    println!(
        "[ime] no-op select x5: {:?} (median {:?})",
        durations, median
    );
    // The gate is deliberately loose: this measures spawn-less steady state on
    // a machine that may be busy. What matters architecturally is that this
    // cost lands here and not on the app's main thread.
    assert!(
        median < Duration::from_millis(150),
        "warm helper select took {median:?}"
    );

    let sources = helper
        .ask(json!({ "op": "list" }))
        .get("sources")
        .and_then(|v| v.as_array())
        .cloned()
        .expect("sources array");
    assert!(!sources.is_empty(), "this machine has selectable sources");

    // Malformed protocol lines answer with an error line, not a crash.
    let bad = helper.ask(json!({ "op": "bogus" }));
    assert_eq!(bad["error"], "unknown op", "{bad}");
    let bad = helper.ask(json!({ "op": "select" }));
    assert_eq!(bad["error"], "select: missing id", "{bad}");

    // The app never closes the pipe explicitly: it just exits, and the helper
    // shuts down on stdin EOF. Closing the pipe here simulates exactly that.
    helper.stdin = None;
    let status = helper
        .child
        .wait()
        .expect("wait for the helper after stdin EOF");
    assert!(status.success(), "helper exits 0 on EOF: {status}");
}

/// Runs one request in a fresh one-shot helper: a new process reads the live
/// system state, so it is the reference the long-lived helper must agree with.
fn one_shot(args: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_bnote"))
        .arg(bnote_lib::ime_daemon::HELPER_FLAG)
        .args(args)
        .output()
        .expect("run a one-shot helper");
    serde_json::from_slice(&out.stdout).expect("one-shot response json")
}

/// The long-lived helper must see a source change it did not make (the user's
/// own switch, macOS restoring a per-app source on activation). Before the
/// run-loop drain in `ime_tis::current_source_id` it kept reporting its own
/// last select, so `select` answered "already active" in microseconds and
/// never switched.
///
/// Ignored by default: it really switches the user's input method once and
/// restores it. Run with `cargo test --test ime_daemon -- --ignored`.
#[test]
#[ignore]
fn the_long_lived_helper_sees_switches_made_by_other_processes() {
    let mut helper = Helper::start();
    let original = helper.ask(json!({ "op": "current" }))["id"]
        .as_str()
        .expect("current must name the active source")
        .to_string();

    // A source different from the active one, so the switch below is real.
    let other = helper.ask(json!({ "op": "list" }))["sources"]
        .as_array()
        .and_then(|sources| {
            sources
                .iter()
                .filter_map(|s| s["id"].as_str())
                .find(|id| *id != original)
                .map(str::to_string)
        })
        .expect("a second selectable source");

    // Another process switches the source behind the long-lived helper's back.
    let out = one_shot(&["select", other.as_str()]);
    assert_eq!(out["switched"], true, "{out}");

    // Without the drain this reads the helper's own stale copy and the test
    // fails: the helper believed `other` was "already active".
    let seen = helper.ask(json!({ "op": "current" }))["id"]
        .as_str()
        .expect("current must name the active source")
        .to_string();
    assert_eq!(seen, other, "the helper must see switches made by others");

    // Hand the user's original source back.
    let back = one_shot(&["select", original.as_str()]);
    assert_eq!(back["switched"], true, "{back}");
    assert_eq!(helper.ask(json!({ "op": "current" }))["id"], original);
}
