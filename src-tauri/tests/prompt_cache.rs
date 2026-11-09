//! Guard rail: the head of a request never changes while a session lives.
//!
//! A provider's prompt cache is a linear prefix cache. Measured against the
//! configured endpoint (DeepSeek's Anthropic-compatible API, four salted probe
//! requests):
//!
//! | request | cached | hit |
//! |---------|--------|-----|
//! | unchanged prefix, next user turn | 640/801 | 79.9% |
//! | one byte changed inside the system prompt | 128/779 | 16.4% |
//! | same prompt again | 640/779 | 82.2% |
//!
//! So a single changed byte in the system prompt costs the tools and the whole
//! conversation, not just the changed segment. `refresh_dynamic_prompt` used to
//! re-assemble it before every tool round (re-running `git status` while the
//! agent edited files), which is exactly that byte. The prompt is now written
//! once, when the session is constructed, and the opening context message is
//! cached for the same reason. This test fails if either grows a second writer.

use std::fs;

const SESSION: &str = "src/agent/session.rs";

fn body_of(src: &str, header: &str) -> String {
    let start = src
        .find(header)
        .unwrap_or_else(|| panic!("{header} disappeared from {SESSION}"));
    let rest = &src[start..];
    // The function ends at the first line that is exactly four spaces + "}".
    let end = rest.find("\n    }\n").map(|i| i + 6).unwrap_or(rest.len());
    rest[..end].to_string()
}

#[test]
fn the_system_prompt_has_no_writer_after_construction() {
    let src = fs::read_to_string(SESSION).expect("session.rs");
    assert!(
        !src.contains("system_prompt.write()"),
        "the system prompt is now immutable: re-assembling it mid-session \
         invalidates the provider's cached prefix (tools and conversation too)"
    );
}

#[test]
fn refreshing_settings_does_not_touch_the_prompt() {
    let src = fs::read_to_string(SESSION).expect("session.rs");
    let body = body_of(&src, "fn refresh_dynamic_prompt(&self) {");
    assert!(
        !body.contains("assemble("),
        "refresh_dynamic_prompt runs before every model request; it must not \
         rebuild the system prompt:\n{body}"
    );
    assert!(
        !body.contains("git_status"),
        "a git snapshot inside the prompt changes on every file the agent \
         writes; it belongs in the conversation:\n{body}"
    );
}

#[test]
fn the_opening_context_is_built_once() {
    let src = fs::read_to_string(SESSION).expect("session.rs");
    let body = body_of(&src, "fn user_context(&self) -> Option<String> {");
    assert!(
        body.contains("get_or_insert_with"),
        "the context message precedes every turn; it has to be cached for the \
         session instead of re-reading instructions and memory per request:\n{body}"
    );
}
