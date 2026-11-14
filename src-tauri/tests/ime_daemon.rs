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
