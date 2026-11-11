//! Debug record of every model request and response of one conversation.
//!
//! A session running with `logRequests` enabled writes one JSONL file per
//! conversation (see [`super::home::request_log_file`]): the exact request body
//! that went on the wire, every raw SSE event, the assembled turn, and each
//! HTTP retry or failure. This is what the user reads to check that the
//! provider sees the prompt, tools and thinking mapping they configured — so
//! the body is written verbatim instead of summarized.
//!
//! Writing is best effort: a recorder that cannot open or write its file says
//! so on stderr and is then ignored. Debug logging must never break a turn.

use super::types::{TokenUsage, TurnResult};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// One conversation's record file. Shared by the main session, its subagents,
/// its compaction and its title request: concurrent writers are serialized by
/// the file mutex, so a line is never split across two requests.
pub struct RequestLog {
    path: PathBuf,
    file: Mutex<File>,
    /// Request numbers are unique inside one recorder (one conversation).
    next: AtomicU64,
}

/// The request-level facts that are not part of the body.
pub struct RequestMeta<'a> {
    pub session: &'a str,
    /// turn | compact | title | subagent
    pub purpose: &'a str,
    pub url: &'a str,
    pub protocol: &'a str,
    pub model: &'a str,
    pub thinking: bool,
}

impl RequestLog {
    /// Opens (or appends to) the conversation's record in the agent home.
    pub fn open_key(
        key: &str,
        session: &str,
        mode: &str,
        model: &str,
    ) -> Result<Arc<RequestLog>, String> {
        RequestLog::open_at(&super::home::request_log_file(key), session, mode, model)
    }

    /// The same, at an explicit path (tests, and callers that own the path).
    pub fn open_at(
        path: &Path,
        session: &str,
        mode: &str,
        model: &str,
    ) -> Result<Arc<RequestLog>, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("WRITE_FAILED: {} ({})", parent.display(), e))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))?;
        let log = Arc::new(RequestLog {
            path: path.to_path_buf(),
            file: Mutex::new(file),
            next: AtomicU64::new(1),
        });
        // A restored conversation appends to the file its record already has:
        // this line (one per session run) separates the two runs without
        // truncating the earlier one.
        log.write(json!({
            "ts": now_ms(),
            "phase": "session",
            "session": session,
            "mode": mode,
            "model": model,
        }));
        Ok(log)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Records the request about to be sent and returns its id.
    pub fn begin(&self, meta: &RequestMeta<'_>, body: &Value) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.write(json!({
            "ts": now_ms(),
            "phase": "request",
            "request": id,
            "session": meta.session,
            "purpose": meta.purpose,
            "url": meta.url,
            "protocol": meta.protocol,
            "model": meta.model,
            "thinking": meta.thinking,
            "body": body,
        }));
        id
    }

    /// One HTTP attempt that did not produce a stream: the status and the
    /// response text, or the transport error. `attempt` starts at 0.
    pub fn http_attempt(&self, id: u64, attempt: usize, status: Option<u16>, detail: &str) {
        self.write(json!({
            "ts": now_ms(),
            "phase": "http",
            "request": id,
            "attempt": attempt,
            "status": status,
            "detail": detail,
        }));
    }

    /// One raw `data:` payload of the response stream, exactly as received
    /// (`[DONE]` and unparseable events included).
    pub fn sse(&self, id: u64, data: &str) {
        self.write(json!({
            "ts": now_ms(),
            "phase": "sse",
            "request": id,
            "data": data,
        }));
    }

    /// The turn assembled from the stream: what the loop and the history see.
    pub fn response(&self, id: u64, status: u16, turn: &TurnResult) {
        self.write(json!({
            "ts": now_ms(),
            "phase": "response",
            "request": id,
            "status": status,
            "text": turn.text,
            "thinking": turn.thinking,
            "blocks": turn.blocks,
            "stopReason": turn.stop_reason,
            "usage": turn.usage.map(usage_json),
            "hitMaxTokens": turn.hit_max_tokens,
        }));
    }

    pub fn error(&self, id: u64, message: &str) {
        self.write(json!({
            "ts": now_ms(),
            "phase": "error",
            "request": id,
            "message": message,
        }));
    }

    fn write(&self, value: Value) {
        let line = value.to_string();
        let Ok(mut file) = self.file.lock() else {
            eprintln!(
                "[bnote] request log {}: writer poisoned",
                self.path.display()
            );
            return;
        };
        if let Err(e) = writeln!(file, "{line}").and_then(|_| file.flush()) {
            eprintln!("[bnote] request log {}: {e}", self.path.display());
        }
    }
}

fn usage_json(usage: TokenUsage) -> Value {
    json!({"input": usage.input, "output": usage.output, "cacheRead": usage.cache_read})
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bnote-request-log-{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn read_lines(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .expect("record file")
            .lines()
            .map(|line| serde_json::from_str(line).expect("json line"))
            .collect()
    }

    fn meta<'a>(session: &'a str, url: &'a str) -> RequestMeta<'a> {
        RequestMeta {
            session,
            purpose: "turn",
            url,
            protocol: "openai",
            model: "m1",
            thinking: true,
        }
    }

    #[test]
    fn records_the_request_stream_and_response_in_order() {
        let dir = temp_dir("order");
        let path = dir.join("s1.jsonl");
        let log = RequestLog::open_at(&path, "s1", "coding", "m1").expect("open");
        let body = json!({
            "model": "m1",
            "messages": [{"role": "user", "content": "hi"}],
        });
        let id = log.begin(&meta("s1", "https://example/v1/chat/completions"), &body);
        log.sse(id, "{\"choices\":[]}");
        let turn = TurnResult {
            text: "hello".into(),
            thinking: "reasoning".into(),
            stop_reason: "stop".into(),
            usage: Some(TokenUsage {
                input: 10,
                output: 2,
                cache_read: 4,
            }),
            ..Default::default()
        };
        log.response(id, 200, &turn);

        let lines = read_lines(&path);
        assert_eq!(lines[0]["phase"], "session");
        assert_eq!(lines[0]["mode"], "coding");
        assert_eq!(lines[1]["phase"], "request");
        assert_eq!(lines[1]["body"], body, "the body is recorded verbatim");
        assert_eq!(lines[2]["phase"], "sse");
        assert_eq!(lines[2]["data"], "{\"choices\":[]}");
        assert_eq!(lines[3]["phase"], "response");
        assert_eq!(lines[3]["text"], "hello");
        assert_eq!(lines[3]["thinking"], "reasoning");
        assert_eq!(lines[3]["usage"]["cacheRead"], 4);
    }

    #[test]
    fn records_every_failed_attempt() {
        let dir = temp_dir("attempts");
        let path = dir.join("s2.jsonl");
        let log = RequestLog::open_at(&path, "s2", "study", "m1").expect("open");
        let id = log.begin(&meta("s2", "https://example/v1/messages"), &json!({}));
        log.http_attempt(id, 0, Some(529), "HTTP 529: overloaded");
        log.http_attempt(id, 1, None, "request: connection reset");
        log.error(id, "HTTP 529: overloaded");

        let lines = read_lines(&path);
        assert_eq!(lines[1]["phase"], "request");
        assert_eq!(lines[2]["phase"], "http");
        assert_eq!(lines[2]["status"], 529);
        assert_eq!(lines[3]["attempt"], 1);
        assert_eq!(lines[3]["status"], Value::Null);
        assert_eq!(lines[4]["phase"], "error");
    }

    #[test]
    fn a_restored_conversation_appends_instead_of_truncating() {
        let dir = temp_dir("append");
        let path = dir.join("conv.jsonl");
        let first = RequestLog::open_at(&path, "run-1", "coding", "m1").expect("open");
        first.error(1, "ABORTED");
        drop(first);
        let second = RequestLog::open_at(&path, "run-2", "coding", "m2").expect("open");
        second.error(1, "ABORTED");

        let lines = read_lines(&path);
        assert_eq!(lines.len(), 4, "two session headers + one error each");
        assert_eq!(lines[0]["session"], "run-1");
        assert_eq!(lines[2]["session"], "run-2");
        assert_eq!(lines[2]["model"], "m2");
    }
    #[test]
    fn an_unwritable_record_does_not_take_the_turn_down() {
        // The recorder is built from the body alone; credentials live in
        // post_stream and never reach this module. A path that cannot be opened
        // is reported to the caller, and every write after that is best effort.
        let dir = temp_dir("missing");
        let path = dir.join("no").join("s3.jsonl");
        let log = RequestLog::open_at(&path, "s3", "study", "m1").expect("open creates parents");
        log.error(1, "still writable");
        assert!(path.is_file());
    }
}
