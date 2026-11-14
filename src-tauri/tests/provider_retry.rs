//! HTTP-level retry policy, driven through the production provider.
//!
//! `retryable_status` decides whether a failed POST is replayed or reported:
//! 429 / 529 / 5xx are transient, every other status is the endpoint's real
//! verdict. The unit tests pin the classifier; this file pins the consequence —
//! a 401 reaches the user after exactly one request, while a 429 is retried and
//! announced.
//!
//! The cassettes live in a temp directory built here, not in
//! `tests/fixtures/cassettes` (those are shared, reviewed transcripts).

mod common;

use bnote_lib::agent::cancel::Abort;
use bnote_lib::agent::models::ResolvedModel;
use bnote_lib::agent::provider::{Provider, TurnOptions};
use bnote_lib::agent::types::{AgentEvent, ChatItem};
use common::MockLlmServer;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn temp_cassette(tag: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir =
        std::env::temp_dir().join(format!("bnote-retry-{tag}-{}-{stamp}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp cassette");
    dir
}

/// Writes one recorded interaction: the request metadata plus a response folder
/// with the given status and raw SSE frames.
fn interaction(dir: &Path, seq: usize, status: u16, frames: &[&str]) {
    let prefix = format!("{seq:04}");
    let request = json!({
        "seq": seq,
        "protocol": "anthropic",
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "model": "test-model",
        "session": "retry-test",
        "purpose": "turn",
        "thinking": false,
        "recordedAt": 0,
        "body": {"model": "test-model", "stream": true},
    });
    std::fs::write(
        dir.join(format!("{prefix}-request.json")),
        serde_json::to_vec(&request).expect("request json"),
    )
    .expect("write request");
    let response = dir.join(format!("{prefix}-response"));
    let frame_dir = response.join("frames");
    std::fs::create_dir_all(&frame_dir).expect("frames dir");
    std::fs::write(
        response.join("meta.json"),
        serde_json::to_vec(&json!({
            "status": status,
            "contentType": "text/event-stream",
            "frames": frames.len(),
            "completed": true,
            "finishedAt": 0,
        }))
        .expect("meta json"),
    )
    .expect("write meta");
    for (index, frame) in frames.iter().enumerate() {
        std::fs::write(
            frame_dir.join(format!("{:04}.sse", index + 1)),
            frame.as_bytes(),
        )
        .expect("write frame");
    }
}

/// The smallest stream that ends a turn with one text block.
fn ok_frames() -> Vec<&'static str> {
    vec![
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ]
}

fn provider(base_url: String) -> Provider {
    Provider::from_resolved(&ResolvedModel {
        provider_id: "retry".into(),
        provider_name: "Retry".into(),
        model_id: "test-model".into(),
        model_name: "Test Model".into(),
        protocol: "anthropic".into(),
        base_url,
        api_key: "test-key".into(),
        model: "test-model".into(),
        max_tokens: 1024,
        context_window: 200_000,
        vision: false,
        thinking_level: "off".into(),
        patch: json!({}),
        off_patch: json!({}),
    })
}

fn options() -> TurnOptions {
    TurnOptions {
        max_tokens: None,
        abort: Abort::new(),
        thinking: false,
        log: None,
        session: "retry-test".into(),
        purpose: "turn",
    }
}

#[tokio::test]
async fn a_client_error_is_reported_after_a_single_request() {
    std::env::remove_var(bnote_lib::agent::cassette::DIR_ENV);
    let dir = temp_cassette("401");
    // Exactly one interaction: if the provider retried, the server would answer
    // "cassette exhausted" with a 500 and the error would say 500 instead.
    interaction(&dir, 1, 401, &[]);
    let server = MockLlmServer::start(&dir).await;

    let events = Mutex::new(Vec::new());
    let err = provider(server.base_url())
        .stream_turn_with(
            "be brief",
            &[ChatItem::user_text("hello")],
            &[],
            &|event| events.lock().expect("events").push(event),
            &options(),
        )
        .await
        .expect_err("401 is final");

    assert!(err.contains("401"), "{err}");
    assert_eq!(server.requests().len(), 1, "no retry after a client error");
    assert!(
        !events
            .lock()
            .expect("events")
            .iter()
            .any(|e| matches!(e, AgentEvent::Notice { .. })),
        "a final answer is not announced as a retry"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_rate_limited_request_is_announced_retried_and_then_answered() {
    std::env::remove_var(bnote_lib::agent::cassette::DIR_ENV);
    let dir = temp_cassette("429");
    interaction(&dir, 1, 429, &[]);
    interaction(&dir, 2, 200, &ok_frames());
    let server = MockLlmServer::start(&dir).await;

    let events = Arc::new(Mutex::new(Vec::new()));
    let turn = provider(server.base_url())
        .stream_turn_with(
            "be brief",
            &[ChatItem::user_text("hello")],
            &[],
            &|event| events.lock().expect("events").push(event),
            &options(),
        )
        .await
        .expect("the retried attempt is answered");

    assert_eq!(turn.text, "hi");
    assert_eq!(turn.stop_reason, "end_turn");
    // The retry is announced before the wait: a silent retry chain reads as a
    // dead panel.
    let notices: Vec<String> = events
        .lock()
        .expect("events")
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Notice { text } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(
        notices[0].contains("429") && notices[0].contains("重试 1/10"),
        "the notice names the cause and the attempt: {notices:?}"
    );
    // Two requests: the rejected one and the successful replay.
    assert_eq!(server.requests().len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}
