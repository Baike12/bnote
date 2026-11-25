//! The transcript writer for remotely driven sessions.
//!
//! A local session's record is written by the desktop frontend
//! (`transcriptWriter.ts`). Once a phone sends to a session, ownership moves
//! here exactly once (`origin_changed`): the backend appends the user line, one
//! assistant line per provider round, model switches and reset markers. The
//! desktop stops writing the same file, so lines can never interleave.

use std::io::Write;
use std::sync::Mutex;

use serde::Serialize;

use crate::agent::session::Session;
use crate::agent::types::Content;

/// One global lock is enough: transcript appends are rare (a few per second at
/// most) and must not interleave across a turn task and an RPC task.
static APPEND: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
struct MetaLine<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    at: u64,
    title: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<crate::agent::models::SessionModelConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<&'static str>,
}

#[derive(Serialize)]
struct UserLine<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    at: u64,
    text: &'a str,
}

#[derive(Serialize)]
struct ToolLine<'a> {
    id: &'a str,
    name: &'a str,
    input: &'a serde_json::Value,
    output: &'a str,
    ok: bool,
}

#[derive(Serialize)]
struct AssistantLine<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    at: u64,
    text: &'a str,
    #[serde(skip_serializing_if = "String::is_empty")]
    thinking: String,
    #[serde(rename = "thinkingSignature", skip_serializing_if = "String::is_empty")]
    thinking_signature: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<ToolLine<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

#[derive(Serialize)]
struct ModelLine<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    at: u64,
    model: &'a crate::agent::models::SessionModelConfig,
}

#[derive(Serialize)]
struct ResetLine {
    #[serde(rename = "type")]
    kind: &'static str,
    at: u64,
    #[serde(rename = "checkpointId")]
    checkpoint_id: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn owns(session: &Session) -> bool {
    session.origin() == crate::remote::Origin::Remote && !session.is_subagent()
}

fn title_of(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    let mut out: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        out.push('…');
    }
    out
}

/// Appends one JSON line, creating the directory. Returns the error to the
/// caller so a disk failure reaches the audit log rather than vanishing.
fn append(session: &Session, line: String) -> Result<(), String> {
    let path = session
        .transcript_path()
        .ok_or_else(|| "NO_TRANSCRIPT: the session has no agent home".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("WRITE_FAILED: {} ({e})", parent.display()))?;
    }
    let _guard = APPEND.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("WRITE_FAILED: {} ({e})", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("WRITE_FAILED: {} ({e})", path.display()))
}

/// Writes the metadata line when the record is empty (a restored record keeps
/// its own meta and must not gain a second one).
fn ensure_meta(session: &Session, title: &str) -> Result<(), String> {
    let path = session
        .transcript_path()
        .ok_or_else(|| "NO_TRANSCRIPT: the session has no agent home".to_string())?;
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 0 {
            return Ok(());
        }
    }
    let line = MetaLine {
        kind: "meta",
        at: now_ms(),
        title,
        model: Some(session.model_snapshot()),
        origin: Some("remote"),
    };
    let text = serde_json::to_string(&line).map_err(|e| e.to_string())? + "\n";
    append(session, text)
}

pub fn record_user(session: &Session, text: &str) {
    if !owns(session) {
        return;
    }
    let title = title_of(text);
    if let Err(e) = ensure_meta(session, &title) {
        eprintln!("[bnote] remote transcript meta: {e}");
        return;
    }
    let line = UserLine {
        kind: "user",
        at: now_ms(),
        text,
    };
    if let Ok(text) = serde_json::to_string(&line) {
        if let Err(e) = append(session, text + "\n") {
            eprintln!("[bnote] remote transcript user: {e}");
        }
    }
}

/// One provider round: text, thinking, and that round's tool calls with their
/// outputs. `results` are the tool-result blocks appended to the history.
pub fn record_round(session: &Session, blocks: &[Content], results: &[Content]) {
    if !owns(session) {
        return;
    }
    let mut text = String::new();
    let mut thinking = String::new();
    let mut signature = String::new();
    let mut tools = Vec::new();
    for block in blocks {
        match block {
            Content::Text { text: t } => text.push_str(t),
            Content::Thinking {
                text: t,
                signature: s,
                ..
            } => {
                if !thinking.is_empty() {
                    thinking.push('\n');
                }
                thinking.push_str(t);
                if !s.is_empty() {
                    signature = s.clone();
                }
            }
            Content::ToolUse {
                id, name, input, ..
            } => {
                let result = results.iter().find_map(|r| match r {
                    Content::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                        ..
                    } if tool_use_id == id => Some((content, *is_error)),
                    _ => None,
                });
                tools.push(ToolLine {
                    id,
                    name,
                    input,
                    output: result.map(|(c, _)| c.as_str()).unwrap_or(""),
                    ok: !result.map(|(_, err)| err).unwrap_or(true),
                });
            }
            _ => {}
        }
    }
    if text.is_empty() && thinking.is_empty() && tools.is_empty() {
        return;
    }
    let line = AssistantLine {
        kind: "assistant",
        at: now_ms(),
        text: &text,
        thinking,
        thinking_signature: signature,
        tools,
        error: None,
    };
    if let Ok(text) = serde_json::to_string(&line) {
        let _ = ensure_meta(session, "");
        if let Err(e) = append(session, text + "\n") {
            eprintln!("[bnote] remote transcript round: {e}");
        }
    }
}

/// A turn that ended in an error or an abort still gets a line, so reopening
/// the conversation shows that the round failed instead of silently ending.
pub fn record_error(session: &Session, message: &str) {
    if !owns(session) {
        return;
    }
    let line = AssistantLine {
        kind: "assistant",
        at: now_ms(),
        text: "",
        thinking: String::new(),
        thinking_signature: String::new(),
        tools: Vec::new(),
        error: Some(message),
    };
    if let Ok(text) = serde_json::to_string(&line) {
        let _ = ensure_meta(session, "");
        if let Err(e) = append(session, text + "\n") {
            eprintln!("[bnote] remote transcript error: {e}");
        }
    }
}

pub fn record_model(session: &Session) {
    if !owns(session) {
        return;
    }
    let model = session.model_snapshot();
    let line = ModelLine {
        kind: "model",
        at: now_ms(),
        model: &model,
    };
    if let Ok(text) = serde_json::to_string(&line) {
        if let Err(e) = append(session, text + "\n") {
            eprintln!("[bnote] remote transcript model: {e}");
        }
    }
}

/// Marks a checkpoint rollback in the record. The parser ignores unknown line
/// types, so older desktops still restore the conversation.
pub fn record_reset(session: &Session, checkpoint_id: &str) {
    if !owns(session) {
        return;
    }
    let line = ResetLine {
        kind: "reset",
        at: now_ms(),
        checkpoint_id: checkpoint_id.to_string(),
    };
    if let Ok(text) = serde_json::to_string(&line) {
        if let Err(e) = append(session, text + "\n") {
            eprintln!("[bnote] remote transcript reset: {e}");
        }
    }
}
