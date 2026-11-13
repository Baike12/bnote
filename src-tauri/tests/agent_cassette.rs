//! Provider-level replay: a recorded cassette is served over a real HTTP
//! socket and assembled by the production SSE readers.

mod common;

use bnote_lib::agent::cancel::Abort;
use bnote_lib::agent::models::ResolvedModel;
use bnote_lib::agent::provider::{Provider, TurnOptions};
use bnote_lib::agent::types::{AgentEvent, ChatItem, Content, ToolDef};
use common::MockLlmServer;
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn cassette(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/cassettes")
        .join(name)
}

fn resolved(protocol: &str, base_url: String) -> ResolvedModel {
    ResolvedModel {
        provider_id: "test".into(),
        provider_name: "Test".into(),
        model_id: "test-model".into(),
        model_name: "Test Model".into(),
        protocol: protocol.into(),
        base_url,
        api_key: "test-key".into(),
        model: "test-model".into(),
        max_tokens: 1024,
        context_window: 200_000,
        vision: false,
        thinking_level: "off".into(),
        patch: json!({}),
        off_patch: json!({}),
    }
}

fn text_of(blocks: &[Content]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn thinking_of(blocks: &[Content]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            Content::Thinking { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn tools() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "Read".into(),
        description: "Read a file".into(),
        input_schema: json!({
            "type": "object",
            "properties": {"file_path": {"type": "string"}},
            "required": ["file_path"]
        }),
        mcp_server: None,
    }]
}

fn options(thinking: bool) -> TurnOptions {
    TurnOptions {
        max_tokens: None,
        abort: Abort::new(),
        thinking,
        log: None,
        session: "cassette-test".into(),
        purpose: "turn",
    }
}

#[tokio::test]
async fn anthropic_cassette_reassembles_thinking_text_and_tool_use() {
    std::env::remove_var(bnote_lib::agent::cassette::DIR_ENV);
    let server = MockLlmServer::start(cassette("provider-anthropic")).await;
    let provider = Provider::from_resolved(&resolved("anthropic", server.base_url()));
    let events = Mutex::new(Vec::new());

    let turn = provider
        .stream_turn_with(
            "be brief",
            &[ChatItem::user_text("read Welcome.md")],
            &tools(),
            &|event| events.lock().expect("events").push(event),
            &options(true),
        )
        .await
        .expect("the cassette stream is answered");

    assert_eq!(turn.stop_reason, "tool_use");
    assert_eq!(thinking_of(&turn.blocks), "I should read the note.");
    assert_eq!(text_of(&turn.blocks), "I'll read it.");
    assert_eq!(turn.usage.map(|u| (u.input, u.output)), Some((10, 9)));
    let kinds: Vec<&str> = turn
        .blocks
        .iter()
        .map(|block| match block {
            Content::Thinking { .. } => "thinking",
            Content::Text { .. } => "text",
            Content::ToolUse { .. } => "tool_use",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, vec!["thinking", "text", "tool_use"]);
    assert_eq!(turn.tool_calls.len(), 1);
    let Content::ToolUse { name, input, .. } = &turn.tool_calls[0] else {
        panic!("the cassette's tool call was not assembled");
    };
    assert_eq!(name, "Read");
    assert_eq!(input["file_path"], "Welcome.md");

    let events = events.into_inner().expect("events");
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::ThinkingDelta { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::TextDelta { .. })));
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::ThinkingBlockEnd { signature } if signature == "sig-1"
    )));

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/v1/messages");
    assert_eq!(requests[0].body["model"], "test-model");
    assert_eq!(requests[0].body["stream"], true);
    assert_eq!(requests[0].body["tools"][0]["name"], "Read");
    assert_eq!(requests[0].body["messages"][0]["role"], "user");
}

#[tokio::test]
async fn openai_cassette_reassembles_reasoning_text_and_tool_calls() {
    std::env::remove_var(bnote_lib::agent::cassette::DIR_ENV);
    let server = MockLlmServer::start(cassette("provider-openai")).await;
    let base_url = format!("{}/v1", server.base_url());
    let provider = Provider::from_resolved(&resolved("openai", base_url));
    let events = Mutex::new(Vec::new());

    let turn = provider
        .stream_turn_with(
            "be brief",
            &[ChatItem::user_text("read Welcome.md")],
            &tools(),
            &|event| events.lock().expect("events").push(event),
            &options(true),
        )
        .await
        .expect("the cassette stream is answered");

    assert_eq!(turn.stop_reason, "tool_calls");
    assert_eq!(thinking_of(&turn.blocks), "The note is small.");
    assert_eq!(text_of(&turn.blocks), "Let me read it.");
    assert_eq!(turn.usage.map(|u| (u.input, u.output)), Some((20, 7)));
    let kinds: Vec<&str> = turn
        .blocks
        .iter()
        .map(|block| match block {
            Content::Thinking { .. } => "thinking",
            Content::Text { .. } => "text",
            Content::ToolUse { .. } => "tool_use",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, vec!["thinking", "text", "tool_use"]);
    let Content::ToolUse { name, input, .. } = &turn.tool_calls[0] else {
        panic!("the cassette's tool call was not assembled");
    };
    assert_eq!(name, "Read");
    assert_eq!(input["file_path"], "Welcome.md");

    let requests = server.requests();
    assert_eq!(requests[0].path, "/v1/chat/completions");
    assert_eq!(requests[0].body["stream_options"]["include_usage"], true);
    assert_eq!(requests[0].body["messages"][0]["role"], "system");
}

fn history_text(history: &[ChatItem]) -> String {
    history
        .iter()
        .map(|item| {
            let ChatItem::Message { content, .. } = item;
            content
                .iter()
                .filter_map(|block| match block {
                    Content::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_results(history: &[ChatItem]) -> Vec<String> {
    history
        .iter()
        .flat_map(|item| {
            let ChatItem::Message { content, .. } = item;
            content.as_slice()
        })
        .filter_map(|block| match block {
            Content::ToolResult { content, .. } => Some(content.clone()),
            _ => None,
        })
        .collect()
}

fn tool_uses(history: &[ChatItem]) -> Vec<String> {
    history
        .iter()
        .flat_map(|item| {
            let ChatItem::Message { content, .. } = item;
            content.as_slice()
        })
        .filter_map(|block| match block {
            Content::ToolUse { name, .. } => Some(name.clone()),
            _ => None,
        })
        .collect()
}

fn signatures(history: &[ChatItem]) -> Vec<String> {
    history
        .iter()
        .flat_map(|item| {
            let ChatItem::Message { content, .. } = item;
            content.as_slice()
        })
        .filter_map(|block| match block {
            Content::Thinking { signature, .. } => Some(signature.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn the_harness_runs_recorded_thinking_tools_todo_and_a_subagent() {
    let server = MockLlmServer::start(cassette("agent-harness")).await;
    let provider = Arc::new(Provider::from_resolved(&resolved(
        "anthropic",
        server.base_url(),
    )));
    let harness = common::harness(provider).await;
    let session = &harness.session;
    session.send("Run the cassette scenario.", Vec::new()).await;

    let history = session.history();
    assert_eq!(
        tool_uses(&history),
        vec!["TodoWrite", "TodoRead", "Read", "Write", "Agent"]
    );
    let sigs = signatures(&history);
    assert!(sigs.contains(&"sig-todo-write".to_string()), "{sigs:?}");
    assert!(sigs.contains(&"sig-final".to_string()), "{sigs:?}");
    let final_text = history_text(&history);
    assert!(
        final_text.contains("Done: todos tracked"),
        "final answer missing: {final_text}"
    );

    let results = tool_results(&history);
    assert!(
        results.iter().any(|r| r.contains("Read the second note")),
        "TodoRead result missing: {results:?}"
    );
    assert!(
        results.iter().any(|r| r.contains("replayed content")),
        "Read result missing: {results:?}"
    );
    assert!(
        results.iter().any(|r| r.contains("Second note")),
        "subagent report missing: {results:?}"
    );

    let todos = session.todos.lock().expect("todos");
    assert_eq!(todos.len(), 3);
    assert!(todos.iter().all(|todo| todo.content.contains("the")));
    drop(todos);

    let written = std::fs::read_to_string(harness.vault.join("Created/FromCassette.md"))
        .expect("the recorded Write tool ran");
    assert_eq!(
        written,
        "# From cassette\n\nwritten by the replay harness\n"
    );

    let children = session.children.lock().expect("children");
    assert_eq!(children.len(), 1);
    let child = children.values().next().expect("child");
    assert!(history_text(&child.history()).contains("Second note"));
    drop(children);
    assert!(!session.running.load(std::sync::atomic::Ordering::SeqCst));

    let requests = server.requests();
    assert_eq!(requests.len(), 7, "one request per scripted model turn");
    assert!(
        requests
            .iter()
            .all(|request| request.path == "/v1/messages"),
        "every turn spoke the Anthropic Messages protocol"
    );
    assert!(
        requests[2]
            .body
            .to_string()
            .contains("Read the second note"),
        "the TodoRead result reached the next request"
    );
    assert!(
        requests[3].body.to_string().contains("replayed content"),
        "the Read result reached the next request"
    );
    assert!(
        requests[6].body.to_string().contains("Second note"),
        "the subagent report reached the parent's next request"
    );

    harness.cleanup();
}

#[tokio::test]
async fn the_harness_replays_the_real_anthropic_recording() {
    let server = MockLlmServer::start(cassette("agent-real")).await;
    let provider = Arc::new(Provider::from_resolved(&resolved(
        "anthropic",
        server.base_url(),
    )));
    let harness = common::harness(provider).await;
    let session = &harness.session;
    session
        .send("Replay the recorded conversation.", Vec::new())
        .await;

    let history = session.history();
    assert_eq!(
        tool_uses(&history),
        vec![
            "TodoWrite",
            "TodoRead",
            "Read",
            "Write",
            "Agent",
            "TodoWrite"
        ],
        "the recorded Anthropic tool sequence is replayed in order"
    );
    let redacted = history
        .iter()
        .flat_map(|item| {
            let ChatItem::Message { content, .. } = item;
            content.as_slice()
        })
        .filter_map(|block| match block {
            Content::Thinking { redacted, .. } => redacted.as_deref(),
            _ => None,
        })
        .count();
    assert!(
        redacted > 0,
        "a redacted_thinking block from the real stream must survive parsing"
    );

    let final_text = history_text(&history);
    assert!(final_text.contains("Done:"), "final text: {final_text}");

    let todos = session.todos.lock().expect("todos");
    assert_eq!(todos.len(), 3);
    assert!(
        todos.iter().all(|todo| todo.status == "completed"),
        "the last recorded TodoWrite marks every item completed: {todos:?}"
    );
    drop(todos);

    let written = std::fs::read_to_string(harness.vault.join("Created/FromCassette.md"))
        .expect("the recorded Write tool ran");
    assert_eq!(
        written,
        "# From cassette\n\nwritten by the replay harness\n"
    );

    let children = session.children.lock().expect("children");
    assert_eq!(children.len(), 1);
    let child = children.values().next().expect("child");
    let child_history = child.history();
    assert_eq!(tool_uses(&child_history), vec!["Read"]);
    assert!(
        history_text(&child_history).contains("Second note"),
        "the child report: {}",
        history_text(&child_history)
    );
    drop(children);

    let requests = server.requests();
    assert_eq!(requests.len(), 9, "the recording has nine model turns");
    assert!(requests
        .iter()
        .all(|request| request.path == "/v1/messages"));
    assert!(
        requests[2]
            .body
            .to_string()
            .contains("Read Notes/Second.md"),
        "the TodoRead result reached the next parent request"
    );
    assert!(
        requests[3].body.to_string().contains("replayed content"),
        "the parent's Read result reached the next request"
    );
    assert!(
        requests[8].body.to_string().contains("Second note"),
        "the child report reached the parent's final request"
    );

    harness.cleanup();
}
