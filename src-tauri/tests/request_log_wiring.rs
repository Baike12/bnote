//! Guard rail: the request record is fed by every path that talks to a model.
//!
//! The feature's whole value is completeness — a record that silently misses
//! the SSE stream, a retry, the compaction call or a subagent request answers
//! "does this request match what I configured?" with a lie. The unit tests in
//! `agent/request_log.rs` pin the file format; this test pins the wiring, which
//! is the part a refactor can drop without noticing.

use std::fs;

const PROVIDER: &str = "src/agent/provider.rs";
const SESSION: &str = "src/agent/session.rs";
const COMMANDS: &str = "src/commands/agent.rs";

fn read(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// One `impl` method body: from its header to the first line that is exactly
/// four spaces + `}`.
fn body_of(src: &str, header: &str) -> String {
    let start = src
        .find(header)
        .unwrap_or_else(|| panic!("{header} disappeared"));
    let rest = &src[start..];
    let end = rest.find("\n    }\n").map(|i| i + 6).unwrap_or(rest.len());
    rest[..end].to_string()
}

/// One top-level function body: from its header to the first line that is
/// exactly `}` (commands live at module level, so their inner blocks close with
/// more indentation).
fn top_body(src: &str, header: &str) -> String {
    let start = src
        .find(header)
        .unwrap_or_else(|| panic!("{header} disappeared"));
    let rest = &src[start..];
    let end = rest.find("\n}\n").map(|i| i + 3).unwrap_or(rest.len());
    rest[..end].to_string()
}

#[test]
fn both_protocols_record_the_stream_and_the_assembled_turn() {
    let src = read(PROVIDER);
    for (stream, reader, protocol) in [
        (
            "async fn stream_anthropic(",
            "async fn read_anthropic_stream(",
            "anthropic",
        ),
        (
            "async fn stream_openai(",
            "async fn read_openai_stream(",
            "openai",
        ),
    ] {
        let stream_body = body_of(&src, stream);
        assert!(
            stream_body.contains("log.begin("),
            "{protocol}: the request body is recorded before it is sent"
        );
        assert!(
            stream_body.contains(&format!("protocol: \"{protocol}\"")),
            "{protocol}: the record names the wire protocol"
        );
        assert!(
            stream_body.contains("log.response(request, status, &turn)"),
            "{protocol}: the assembled turn is recorded"
        );
        let reader_body = body_of(&src, reader);
        assert!(
            reader_body.contains("log.sse(request, &event)"),
            "{protocol}: every raw SSE event is recorded before parsing"
        );
    }
}

#[test]
fn failed_attempts_and_aborts_are_recorded() {
    let src = read(PROVIDER);
    let post = body_of(&src, "async fn post_stream(");
    assert!(
        post.contains("log.http_attempt("),
        "a retry/status failure must leave a line, not only the raised error"
    );
    assert!(
        post.contains("log.error(request, ABORTED)"),
        "a user stop must be visible in the record"
    );
}

#[test]
fn every_session_request_path_passes_the_recorder() {
    let src = read(SESSION);
    let run = body_of(&src, "async fn run_loop(");
    assert!(
        run.contains("log: self.request_log(),"),
        "a turn outside the record is a hole in the record"
    );
    assert!(
        run.contains("session: self.id.clone(),"),
        "lines must name the issuing session (subagents share the file)"
    );
    let compact = body_of(&src, "pub async fn compact(");
    assert!(
        compact.contains("purpose: \"compact\"") && compact.contains("log: self.request_log()"),
        "a compaction summary is a model request too"
    );
    let subagent = body_of(&src, "async fn run_subagent(");
    assert!(
        subagent.contains("let log = self.request_log();"),
        "the parent's recorder must be open before the child shares it"
    );
    assert!(
        subagent.contains("request_log: Mutex::new(log),"),
        "a subagent writes into its parent's conversation record"
    );
}

#[test]
fn the_record_file_is_keyed_by_the_conversation_record() {
    let src = read(SESSION);
    assert!(
        src.contains("let log_key = task_list_id.clone();"),
        "a restored conversation must append to its original file, not a new one"
    );
}

#[test]
fn the_settings_switch_reaches_open_sessions_and_the_title_request() {
    let commands = read(COMMANDS);
    let save = top_body(&commands, "pub async fn agent_save_config(");
    assert!(
        save.contains("session.set_log_requests(log_requests)"),
        "the switch is a debugging aid: it applies to the next request, not the next session"
    );
    let title = top_body(&commands, "pub async fn agent_generate_title(");
    assert!(
        title.contains("purpose: \"title\""),
        "the title request belongs to the conversation's record"
    );
    assert!(
        title.contains("session.request_log()"),
        "the title joins the session's record when recording is on"
    );
}
