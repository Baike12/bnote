//! Live cassette recording (ignored by default).
//!
//! Run with a real Anthropic-compatible endpoint:
//!
//! ```bash
//! BNOTE_RECORD_API_KEY=... BNOTE_RECORD_BASE_URL=https://... \
//! BNOTE_RECORD_MODEL=claude-sonnet-4-5 \
//! cargo test --test agent_record -- --ignored --nocapture
//! ```
//!
//! Without the variables the test falls back to `~/.claude/settings.json`
//! (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`).
//! The recorded folder defaults to `tests/fixtures/cassettes/agent-real` and can
//! be redirected with `BNOTE_RECORD_DIR`. Recording writes to a sibling
//! `.recording` folder and replaces the fixture only after every assertion
//! passed, so a failed run cannot destroy a good cassette.
//!
//! The prompt asks the model to exercise the features the replay tests care
//! about: thinking blocks, TodoWrite/TodoRead, Read/Write and one explore
//! subagent. Every request and every raw SSE frame is recorded.

mod common;

use bnote_lib::agent::cassette;
use bnote_lib::agent::models::ResolvedModel;
use bnote_lib::agent::provider::Provider;
use bnote_lib::agent::types::{ChatItem, Content};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn setting(name: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let raw = std::fs::read_to_string(format!("{home}/.claude/settings.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value["env"][name]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn env_or(name: &str, fallback: Option<String>, default: &str) -> String {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or(fallback)
        .unwrap_or_else(|| default.to_string())
}

fn real_model() -> ResolvedModel {
    let api_key = env_or("BNOTE_RECORD_API_KEY", setting("ANTHROPIC_AUTH_TOKEN"), "");
    assert!(
        !api_key.is_empty(),
        "set BNOTE_RECORD_API_KEY or ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN"
    );
    let base_url = env_or(
        "BNOTE_RECORD_BASE_URL",
        setting("ANTHROPIC_BASE_URL"),
        "https://api.anthropic.com",
    );
    let model = env_or(
        "BNOTE_RECORD_MODEL",
        setting("ANTHROPIC_DEFAULT_SONNET_MODEL"),
        "claude-sonnet-4-5",
    );
    ResolvedModel {
        provider_id: "record".into(),
        provider_name: "Recording endpoint".into(),
        model_id: model.clone(),
        model_name: model.clone(),
        protocol: "anthropic".into(),
        base_url: base_url.trim_end_matches('/').to_string(),
        api_key,
        model,
        max_tokens: 32_000,
        context_window: 200_000,
        vision: true,
        thinking_level: "high".into(),
        patch: json!({"thinking": {"type": "enabled", "budget_tokens": 8192}}),
        off_patch: json!({"thinking": null}),
    }
}

fn target_dir() -> PathBuf {
    match std::env::var("BNOTE_RECORD_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir.trim()),
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cassettes/agent-real"),
    }
}

/// Records into a staging folder and only replaces the fixture after every
/// assertion passed: a failed or thinking-less recording must not destroy the
/// cassette the replay tests already depend on.
fn promote(staging: &Path, target: &Path) {
    let mut retired_name = target
        .file_name()
        .expect("the cassette target names a folder")
        .to_os_string();
    retired_name.push(".retired");
    let retired = target.with_file_name(retired_name);
    let _ = std::fs::remove_dir_all(&retired);
    if target.exists() {
        std::fs::rename(target, &retired).expect("the old cassette moves aside");
    }
    std::fs::rename(staging, target).expect("the new cassette is promoted");
    let _ = std::fs::remove_dir_all(&retired);
}

fn count_requests(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| name.ends_with("-request.json"))
                })
                .count()
        })
        .unwrap_or(0)
}

#[tokio::test]
#[ignore = "records real model traffic; run explicitly with credentials"]
async fn record_anthropic_cassette_with_thinking_tools_todo_and_a_subagent() {
    let target = target_dir();
    let mut staging_name = target
        .file_name()
        .expect("the cassette target names a folder")
        .to_os_string();
    staging_name.push(".recording");
    let dir = target.with_file_name(staging_name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("cassette folder");
    std::env::set_var(cassette::DIR_ENV, &dir);

    let provider = Arc::new(Provider::from_resolved(&real_model()));
    let harness = common::harness(provider).await;
    let prompt = "\
Execute this checklist now with the tools. Do not ask questions and do not stop at a plan. \
Think through each step before you act.\n\
1. Call TodoWrite with exactly three todos: \"Read Notes/Second.md\", \"Write Created/FromCassette.md\", \
\"Ask an explore subagent for the note title\". Mark the first one in_progress.\n\
2. Call TodoRead.\n\
3. Call Read on Notes/Second.md.\n\
4. Call Write to create Created/FromCassette.md with exactly: # From cassette followed by a blank \
line and the line \"written by the replay harness\".\n\
5. Launch exactly one Agent with subagent_type \"explore\" and prompt \"Read Notes/Second.md and \
report its title only\".\n\
6. Mark every todo completed with TodoWrite, then answer with one short paragraph starting \"Done:\".";
    harness.session.send(prompt, Vec::new()).await;

    let history = harness.session.history();
    let tool_uses: Vec<String> = history
        .iter()
        .flat_map(|item| {
            let ChatItem::Message { content, .. } = item;
            content.as_slice()
        })
        .filter_map(|block| match block {
            Content::ToolUse { name, .. } => Some(name.clone()),
            _ => None,
        })
        .collect();
    let thinking = history
        .iter()
        .flat_map(|item| {
            let ChatItem::Message { content, .. } = item;
            content.as_slice()
        })
        .filter_map(|block| match block {
            Content::Thinking { redacted, .. } => Some(redacted.is_some()),
            _ => None,
        })
        .fold((0usize, 0usize), |(visible, redacted), is_redacted| {
            if is_redacted {
                (visible, redacted + 1)
            } else {
                (visible + 1, redacted)
            }
        });
    let requests = count_requests(&dir);
    println!(
        "[record] {} requests, tools: {:?}, thinking: {} visible + {} redacted, dir: {}",
        requests,
        tool_uses,
        thinking.0,
        thinking.1,
        dir.display()
    );

    assert!(requests > 0, "no model request was recorded");
    assert!(
        tool_uses.iter().any(|name| name == "TodoWrite"),
        "the recording must contain a TodoWrite call: {tool_uses:?}"
    );
    assert!(
        tool_uses.iter().any(|name| name == "TodoRead"),
        "the recording must contain a TodoRead call: {tool_uses:?}"
    );
    assert!(
        tool_uses.iter().any(|name| name == "Read"),
        "the recording must contain a Read call: {tool_uses:?}"
    );
    assert!(
        tool_uses.iter().any(|name| name == "Write"),
        "the recording must contain a Write call: {tool_uses:?}"
    );
    assert!(
        tool_uses.iter().any(|name| name == "Agent"),
        "the recording must contain an Agent call: {tool_uses:?}"
    );
    assert!(
        thinking.0 + thinking.1 > 0,
        "the recording must contain at least one thinking block; the endpoint emitted none, \
         so it cannot serve as a thinking fixture"
    );

    std::env::remove_var(cassette::DIR_ENV);
    harness.cleanup();
    promote(&dir, &target);
    println!("[record] promoted to {}", target.display());
}
