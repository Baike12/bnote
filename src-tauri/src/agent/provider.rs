//! LLM providers: Anthropic Messages API + OpenAI-compatible chat completions,
//! both streamed over SSE and normalized into AgentEvents.

use super::cancel::Abort;
use super::request_log::{RequestLog, RequestMeta};
use super::types::{AgentEvent, ChatItem, Content, TokenUsage, ToolDef, TurnResult};
use futures::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Connect timeout: fail fast when the endpoint is unreachable instead of hanging.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Stream idle timeout: the model stream is treated as failed when not a single
/// byte arrives within this window.
///
/// Without it, a half-open gateway/network makes `stream.next().await` never
/// return → the session stays `running` → every later send is rejected with
/// SESSION_BUSY; the front end only raises a toast that vanishes after a few
/// seconds, so the user just sees "sending again does nothing". Reasoning
/// models keep emitting thinking_delta while they think, so 180s of real
/// silence leaves exactly one explanation: a hung gateway.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(180);

/// Retries for one request, matching Claude Code's `DEFAULT_MAX_RETRIES`.
const MAX_RETRIES: usize = 10;

/// Request-body keys the builder owns. A thinking-level patch may map any
/// gateway-specific field, but not these: changing them changes *which*
/// conversation is sent, not how the reasoning channel is spelled.
const RESERVED_BODY_KEYS: [&str; 7] = [
    "model",
    "stream",
    "messages",
    "system",
    "tools",
    "max_tokens",
    "input",
];
/// The error string that means "the user stopped the turn" — the session turns
/// it into a normal turn end, not an error bubble.
pub const ABORTED: &str = "ABORTED";

/// One streaming attempt failed in a way worth repeating: nothing has been shown
/// to the user yet, so the request can be replayed from scratch.
#[derive(Debug)]
enum StreamFailure {
    Aborted,
    Retryable(String),
    Fatal(String),
}

impl From<StreamFailure> for String {
    fn from(f: StreamFailure) -> String {
        match f {
            StreamFailure::Aborted => ABORTED.to_string(),
            StreamFailure::Retryable(m) | StreamFailure::Fatal(m) => m,
        }
    }
}

/// The message of a failure without consuming it (the record writes it, then
/// the loop turns it into the user-facing error).
fn failure_message(failure: &StreamFailure) -> &str {
    match failure {
        StreamFailure::Aborted => ABORTED,
        StreamFailure::Retryable(m) | StreamFailure::Fatal(m) => m,
    }
}

/// Exponential backoff with jitter: 0.5s, 1s, 2s … capped at 32s.
fn backoff(attempt: usize) -> Duration {
    let base = 500u64.saturating_mul(1u64 << attempt.min(6));
    let capped = base.min(32_000);
    // Deterministic-enough jitter without a rand dependency.
    let jitter = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0))
        % 250;
    Duration::from_millis(capped + jitter)
}

/// Retry policy for an HTTP status: 429 and 5xx are transient, everything else
/// is a real answer from the endpoint.
fn retryable_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.as_u16() == 529 || status.is_server_error()
}

/// Fetches the next stream chunk under the idle timeout (tests inject a shorter one).
///
/// `None` = the stream ended normally; `Err` = idle timeout (no gateway response)
/// or a connection error.
async fn next_chunk_with<S, E>(
    stream: &mut S,
    idle: Duration,
) -> Result<Option<bytes::Bytes>, String>
where
    S: futures::Stream<Item = Result<bytes::Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    match tokio::time::timeout(idle, stream.next()).await {
        Ok(Some(chunk)) => chunk.map(Some).map_err(|e| format!("stream: {}", e)),
        Ok(None) => Ok(None),
        Err(_) => Err(format!(
            "模型流空闲超时({}s 没有任何数据):网关或网络无响应,请重试",
            idle.as_secs()
        )),
    }
}

async fn next_chunk<S>(stream: &mut S) -> Result<Option<bytes::Bytes>, String>
where
    S: futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin,
{
    next_chunk_with(stream, STREAM_IDLE_TIMEOUT).await
}

/// The same read, but a stop from the user wins immediately instead of waiting
/// for the idle timeout: an aborted turn must release the panel, not hang until
/// the gateway gives up.
async fn next_chunk_abort<S>(
    stream: &mut S,
    abort: &Arc<Abort>,
) -> Result<Option<bytes::Bytes>, StreamFailure>
where
    S: futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin,
{
    if abort.is_aborted() {
        return Err(StreamFailure::Aborted);
    }
    tokio::select! {
        _ = abort.wait() => Err(StreamFailure::Aborted),
        chunk = next_chunk_with(stream, STREAM_IDLE_TIMEOUT) => match chunk {
            Ok(v) => Ok(v),
            Err(e) => Err(StreamFailure::Retryable(e)),
        },
    }
}

/// Anthropic content block: the wire shape of each Text/Image/ToolUse/ToolResult variant.
fn anthropic_block(c: &Content) -> Value {
    match c {
        Content::Text { text } => json!({"type": "text", "text": text}),
        // The wire name of the thinking text is `thinking`, not `text`.
        Content::Thinking { text, signature } => {
            json!({"type": "thinking", "thinking": text, "signature": signature})
        }
        // Images only occur in user messages (see ChatItem::user_message).
        Content::Image { media_type, data } => json!({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        }),
        Content::ToolUse {
            id, name, input, ..
        } => {
            json!({"type": "tool_use", "id": id, "name": name, "input": input})
        }
        // Without images keep the plain string shape (the least common multiple of
        // the existing session records and the compatibility endpoint); with images
        // the content switches to a blocks array (text + image), the standard
        // shape for tool_result in the official Anthropic protocol.
        Content::ToolResult {
            tool_use_id,
            content,
            is_error,
            images,
        } if images.is_empty() => {
            json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error,
            })
        }
        Content::ToolResult {
            tool_use_id,
            content,
            is_error,
            images,
        } => {
            let mut blocks = Vec::with_capacity(1 + images.len());
            if !content.is_empty() {
                blocks.push(json!({"type": "text", "text": content}));
            }
            for img in images {
                blocks.push(json!({
                    "type": "image",
                    "source": {"type": "base64", "media_type": img.media_type, "data": img.data},
                }));
            }
            json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": blocks,
                "is_error": is_error,
            })
        }
    }
}

/// OpenAI user message content: without images stay a plain string (the existing
/// shape, compatible with older endpoints), with images switch to a multi-part
/// array (text + image_url data URL).
fn openai_user_content(text_parts: &[String], images: &[Content]) -> Value {
    if images.is_empty() {
        return json!(text_parts.join("\n\n"));
    }
    let mut parts: Vec<Value> = Vec::new();
    if !text_parts.is_empty() {
        parts.push(json!({"type": "text", "text": text_parts.join("\n\n")}));
    }
    for img in images {
        let Content::Image { media_type, data } = img else {
            continue;
        };
        parts.push(json!({
            "type": "image_url",
            "image_url": {"url": format!("data:{};base64,{}", media_type, data)},
        }));
    }
    json!(parts)
}

/// ChatItem[] → OpenAI messages array. A non-empty system prompt goes first;
/// assistant text + tool_calls; user messages go through openai_user_content;
/// tool results become one tool message each — the OpenAI protocol only
/// accepts text parts in tool messages, so the screenshots attached to a
/// ToolResult cannot be carried (the same convention as dropping images in the
/// assistant branch); the text explanation survives, so the model does not
/// believe it saw the image.
fn openai_messages(system: &str, items: &[ChatItem]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    if !system.is_empty() {
        messages.push(json!({"role": "system", "content": system}));
    }
    for item in items {
        // ChatItem currently has only the Message variant; adding a variant later
        // fails to compile here, which forces wiring the new variant into message
        // assembly.
        let ChatItem::Message { role, content } = item;
        if role == "assistant" {
            let mut text = String::new();
            let mut thinking = String::new();
            let mut tool_calls: Vec<&Content> = Vec::new();
            for c in content {
                match c {
                    Content::Text { text: t } => text.push_str(t),
                    Content::Thinking { text: t, .. } => thinking.push_str(t),
                    Content::ToolUse { .. } => tool_calls.push(c),
                    // Images only occur in user messages by construction; should one
                    // appear here it could not be carried anyway (OpenAI assistant
                    // content rejects image parts), so drop it.
                    Content::Image { .. } => {}
                    Content::ToolResult { .. } => {}
                }
            }
            let mut msg = json!({"role": "assistant"});
            if !thinking.is_empty() {
                // MiniMax / DeepSeek convention: the reasoning rides on the
                // assistant message and must be kept when passing it back.
                msg["reasoning_content"] = json!(thinking);
            }
            if !text.is_empty() {
                msg["content"] = json!(text);
            }
            if !tool_calls.is_empty() {
                let calls: Vec<Value> = tool_calls
                    .iter()
                    .enumerate()
                    .map(|(i, c)| match c {
                        Content::ToolUse {
                            id, name, input, ..
                        } => json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": input.to_string(),
                            },
                            "index": i,
                        }),
                        _ => json!({}),
                    })
                    .collect();
                msg["tool_calls"] = json!(calls);
            }
            if text.is_empty() && tool_calls.is_empty() {
                msg["content"] = json!("");
            }
            messages.push(msg);
        } else {
            // user message or tool results
            let mut text_parts: Vec<String> = Vec::new();
            let mut images: Vec<Content> = Vec::new();
            let mut results: Vec<&Content> = Vec::new();
            for c in content {
                match c {
                    Content::Text { text } => text_parts.push(text.clone()),
                    // Thinking belongs to an assistant message; a user message
                    // never carries one, so there is nothing to drop here.
                    Content::Thinking { .. } => {}
                    Content::Image { .. } => images.push(c.clone()),
                    Content::ToolResult { .. } => results.push(c),
                    Content::ToolUse { .. } => {}
                }
            }
            if !text_parts.is_empty() || !images.is_empty() {
                messages.push(json!({
                    "role": "user",
                    "content": openai_user_content(&text_parts, &images),
                }));
            }
            for r in results {
                if let Content::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } = r
                {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_use_id,
                        "content": content,
                    }));
                }
            }
        }
    }
    messages
}

/// Anthropic `message_start` usage: input_tokens excludes cache reads and writes,
/// so the occupancy has to sum all three.
fn anthropic_start_usage(message: &Value) -> Option<TokenUsage> {
    let usage = message.get("usage")?;
    let count = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    let input = count("input_tokens")
        + count("cache_creation_input_tokens")
        + count("cache_read_input_tokens");
    let output = count("output_tokens");
    (input > 0 || output > 0).then_some(TokenUsage {
        input,
        output,
        cache_read: count("cache_read_input_tokens"),
    })
}

/// Anthropic `message_delta` carries the cumulative output_tokens. Some
/// gateways (MiniMax's Anthropic-compatible endpoint) skip the usage on
/// `message_start` entirely and put the whole picture here instead
/// (input_tokens + cache_read_input_tokens + output_tokens) — without picking
/// the input side up, the reported context occupancy degenerates to the
/// output alone. The official API keeps input on message_start only, so a
/// zero here must not clear what message_start reported.
fn anthropic_output_usage(current: Option<TokenUsage>, usage: &Value) -> Option<TokenUsage> {
    let count = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    let mut next = current.unwrap_or_default();
    let input = count("input_tokens")
        + count("cache_creation_input_tokens")
        + count("cache_read_input_tokens");
    if input > 0 {
        next.input = input;
        next.cache_read = count("cache_read_input_tokens");
    }
    let output = count("output_tokens");
    if output > 0 {
        next.output = output;
    }
    (next.input > 0 || next.output > 0).then_some(next)
}

/// Usage at the end of an OpenAI-compatible stream (the request has to carry
/// stream_options.include_usage).
/// Some gateways name the fields input/output_tokens; accept those too.
fn openai_usage(v: &Value) -> Option<TokenUsage> {
    let usage = v.get("usage")?;
    if usage.is_null() {
        return None;
    }
    let count = |keys: [&str; 2]| {
        keys.iter()
            .find_map(|k| usage.get(*k).and_then(|v| v.as_u64()))
            .unwrap_or(0)
    };
    let input = count(["prompt_tokens", "input_tokens"]);
    let output = count(["completion_tokens", "output_tokens"]);
    let cache_read = usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    (input > 0 || output > 0).then_some(TokenUsage {
        input,
        output,
        cache_read,
    })
}

/// Per-request options: the ceiling the loop may raise, and the turn's
/// cancellation token.
pub struct TurnOptions {
    pub max_tokens: Option<u32>,
    pub abort: Arc<Abort>,
    /// Request the model's reasoning channel. The wire field depends on the
    /// protocol (see [`Provider::apply_thinking`]); the streamed reasoning
    /// arrives back as ThinkingDelta events either way.
    pub thinking: bool,
    /// Debug record of this conversation (`None` = recording is off). Every
    /// attempt of this request is written to it (see [`RequestLog`]).
    pub log: Option<Arc<RequestLog>>,
    /// The session that issued the request. Recorded per line: subagents share
    /// their parent's file, so the lines must stay attributable.
    pub session: String,
    /// What the request is for, recorded in the log: turn | compact | title |
    /// subagent.
    pub purpose: &'static str,
}

pub struct Provider {
    pub kind: String, // "anthropic" | "openai"
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
    /// The catalog entry this provider was built from. Kept on the request
    /// path so a session can say which model it is running, and so a subagent
    /// can compare against it.
    pub provider_id: String,
    pub model_id: String,
    /// The selected thinking level and its merge patch (see
    /// [`super::models::ThinkingLevel`]).
    pub thinking_level: String,
    thinking_patch: Value,
    /// The model's `off` level patch: what the request needs when the
    /// reasoning channel is switched off (a gateway-specific "disabled" field,
    /// or a delete for Anthropic).
    thinking_off_patch: Value,
    client: reqwest::Client,
}

impl Provider {
    /// Builds a client for one resolved catalog entry.
    pub fn from_resolved(resolved: &super::models::ResolvedModel) -> Provider {
        let kind = resolved.protocol.clone();
        let base = if resolved.base_url.is_empty() {
            if kind == "anthropic" {
                "https://api.anthropic.com".to_string()
            } else {
                "https://api.openai.com/v1".to_string()
            }
        } else {
            resolved.base_url.trim_end_matches('/').to_string()
        };
        Provider {
            kind,
            base_url: base,
            api_key: resolved.api_key.clone(),
            model: resolved.model.clone(),
            max_tokens: resolved.max_tokens.max(1024),
            provider_id: resolved.provider_id.clone(),
            model_id: resolved.model_id.clone(),
            thinking_level: resolved.thinking_level.clone(),
            thinking_patch: resolved.patch.clone(),
            thinking_off_patch: resolved.off_patch.clone(),
            client: reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    /// The same endpoint and thinking level with a different wire model id:
    /// what an `Agent` tool `model` override means when the catalog does not
    /// list that id.
    pub fn with_model(&self, model: &str, max_tokens: u32) -> Provider {
        Provider {
            kind: self.kind.clone(),
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
            model: model.to_string(),
            max_tokens: max_tokens.max(1024),
            provider_id: self.provider_id.clone(),
            model_id: model.to_string(),
            thinking_level: self.thinking_level.clone(),
            thinking_patch: self.thinking_patch.clone(),
            thinking_off_patch: self.thinking_off_patch.clone(),
            client: self.client.clone(),
        }
    }

    /// Injects the reasoning-channel fields of the model's thinking level.
    ///
    /// The mapping is data (the settings page edits it), not a guess: the
    /// patch of the selected level is merged into the request body, and a
    /// request with the channel switched off applies the model's `off` level
    /// — the only place that knows how this gateway disables reasoning.
    fn apply_thinking(&self, body: &mut Value, thinking: bool) {
        let patch = if thinking {
            &self.thinking_patch
        } else {
            &self.thinking_off_patch
        };
        // A patch always lands on an object body; a level whose patch is not an
        // object is a configuration error that normalize already repaired.
        if patch.is_object() {
            // The patch is user data (agent.json), merged at the body root. The
            // keys below are owned by the request builder: a level that renamed
            // `model` or nulled `messages` would ship a conversation the picker
            // and the record never describe. Everything else stays free, which
            // is the point of a hand-written mapping.
            let mut safe = patch.clone();
            if let Some(map) = safe.as_object_mut() {
                for key in RESERVED_BODY_KEYS {
                    map.remove(key);
                }
            }
            super::models::merge_patch(body, &safe);
        }
    }

    /// Streams one turn with the default options (no token override, a fresh
    /// cancellation token). Used by tests and by callers that cannot be
    /// interrupted.
    pub async fn stream_turn(
        &self,
        system: &str,
        items: &[ChatItem],
        tools: &[ToolDef],
        sink: &(dyn Fn(AgentEvent) + Send + Sync),
    ) -> Result<TurnResult, String> {
        let opts = TurnOptions {
            max_tokens: None,
            abort: Abort::new(),
            thinking: false,
            log: None,
            session: String::new(),
            purpose: "turn",
        };
        self.stream_turn_with(system, items, tools, sink, &opts)
            .await
    }

    /// Streams one turn. Emits TextDelta events; returns the assembled turn.
    ///
    /// Retries the whole request (up to `MAX_RETRIES`, exponential backoff) when
    /// the failure happened before anything reached the user: a connect error,
    /// a 429/5xx, or a stream that died with no delta emitted. Once a delta is
    /// out, replaying would duplicate text, so the error surfaces instead.
    pub async fn stream_turn_with(
        &self,
        system: &str,
        items: &[ChatItem],
        tools: &[ToolDef],
        sink: &(dyn Fn(AgentEvent) + Send + Sync),
        opts: &TurnOptions,
    ) -> Result<TurnResult, String> {
        if self.kind == "anthropic" {
            self.stream_anthropic(system, items, tools, sink, opts)
                .await
        } else {
            self.stream_openai(system, items, tools, sink, opts).await
        }
    }

    /// POSTs the request, retrying transport failures and 429/5xx with backoff.
    /// A stop from the user cancels both the request and the wait.
    ///
    /// `log`/`request` are the conversation's debug record: every attempt that
    /// did not produce a stream is written there (`phase: "http"`), so a retry
    /// storm is visible after the fact. The error text is recorded in full; the
    /// user-facing message still truncates.
    async fn post_stream(
        &self,
        url: &str,
        body: &str,
        abort: &Arc<Abort>,
        anthropic: bool,
        log: Option<&RequestLog>,
        request: u64,
    ) -> Result<reqwest::Response, String> {
        let mut attempt = 0usize;
        loop {
            let sent = tokio::select! {
                _ = abort.wait() => {
                    if let Some(log) = log {
                        log.error(request, ABORTED);
                    }
                    return Err(ABORTED.to_string());
                }
                r = {
                    let mut req = self
                        .client
                        .post(url)
                        .header("content-type", "application/json")
                        .header("authorization", format!("Bearer {}", self.api_key));
                    if anthropic {
                        req = req
                            .header("anthropic-version", "2023-06-01")
                            .header("x-api-key", &self.api_key);
                    }
                    req.body(body.to_string()).send()
                } => r,
            };
            let retry_msg = match sent {
                Ok(resp) if resp.status().is_success() => return Ok(resp),
                Ok(resp) => {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    if let Some(log) = log {
                        log.http_attempt(request, attempt, Some(status.as_u16()), &text);
                    }
                    let msg = format!("HTTP {}: {}", status, truncate(&text, 500));
                    if !retryable_status(status) {
                        if let Some(log) = log {
                            log.error(request, &msg);
                        }
                        return Err(msg);
                    }
                    msg
                }
                Err(e) => {
                    let msg = format!("request: {}", e);
                    if let Some(log) = log {
                        log.http_attempt(request, attempt, None, &msg);
                    }
                    msg
                }
            };
            if attempt >= MAX_RETRIES {
                if let Some(log) = log {
                    log.error(request, &retry_msg);
                }
                return Err(retry_msg);
            }
            let delay = backoff(attempt);
            attempt += 1;
            tokio::select! {
                _ = abort.wait() => {
                    if let Some(log) = log {
                        log.error(request, ABORTED);
                    }
                    return Err(ABORTED.to_string());
                }
                _ = tokio::time::sleep(delay) => {}
            }
        }
    }

    // ------------------------------------------------------------------
    // Anthropic /v1/messages
    // ------------------------------------------------------------------
    async fn stream_anthropic(
        &self,
        system: &str,
        items: &[ChatItem],
        tools: &[ToolDef],
        sink: &(dyn Fn(AgentEvent) + Send + Sync),
        opts: &TurnOptions,
    ) -> Result<TurnResult, String> {
        let mut messages: Vec<Value> = Vec::new();
        for item in items {
            if let ChatItem::Message { role, content } = item {
                let blocks: Vec<Value> = content.iter().map(anthropic_block).collect();
                messages.push(json!({"role": role, "content": blocks}));
            }
        }
        // Claude Code caches the conversation prefix: the newest message carries
        // the breakpoint, so each turn re-reads only what it appended.
        if let Some(last) = messages.last_mut() {
            if let Some(blocks) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                if let Some(block) = blocks.last_mut() {
                    block["cache_control"] = json!({"type": "ephemeral"});
                }
            }
        }
        let mut tools_json: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();
        if let Some(last) = tools_json.last_mut() {
            last["cache_control"] = json!({"type": "ephemeral"});
        }

        let mut body = json!({
            "model": self.model,
            "max_tokens": opts.max_tokens.unwrap_or(self.max_tokens),
            "stream": true,
            "messages": messages,
        });
        self.apply_thinking(&mut body, opts.thinking);
        // A pure Q&A session has no tools: omit the tools field entirely instead of
        // sending an empty array.
        if !tools_json.is_empty() {
            body["tools"] = json!(tools_json);
        }
        if !system.is_empty() {
            // Block array (not a bare string) so the system prompt carries its own
            // cache breakpoint. The static prefix and the per-session tail are
            // separate blocks: editing the tail (environment, git status) must
            // not invalidate the cached prefix (CC's dynamic boundary).
            let (static_part, dynamic_part) = super::prompt::split_cache(system);
            let mut blocks = Vec::new();
            if !static_part.trim().is_empty() {
                blocks.push(json!({
                    "type": "text",
                    "text": static_part.trim(),
                    "cache_control": {"type": "ephemeral"},
                }));
            }
            if !dynamic_part.trim().is_empty() {
                blocks.push(json!({
                    "type": "text",
                    "text": dynamic_part.trim(),
                }));
            }
            body["system"] = json!(blocks);
        }

        let url = format!("{}/v1/messages", self.base_url);
        let body_text = body.to_string();
        let log = opts.log.as_deref();
        let mut attempt = 0usize;
        loop {
            let request = match log {
                Some(log) => log.begin(
                    &RequestMeta {
                        session: &opts.session,
                        purpose: opts.purpose,
                        url: &url,
                        protocol: "anthropic",
                        model: &self.model,
                        thinking: opts.thinking,
                    },
                    &body,
                ),
                None => 0,
            };
            let resp = self
                .post_stream(&url, &body_text, &opts.abort, true, log, request)
                .await?;
            let status = resp.status().as_u16();
            let mut turn = TurnResult::default();
            let outcome = self
                .read_anthropic_stream(resp, sink, &opts.abort, &mut turn, log, request)
                .await;
            match outcome {
                Ok(()) => {
                    // A stream that ends without `message_delta` never carried a
                    // stop reason: the gateway closed the connection mid-message
                    // (observed on long tool-loop turns). Replay is only safe
                    // while nothing reached the user; afterwards the partial
                    // output is kept and the truncation is said out loud — a
                    // silent end reads like the model ignored the task.
                    if turn.stop_reason.is_empty() {
                        let emitted = !turn.text.is_empty() || !turn.tool_calls.is_empty();
                        if !emitted {
                            let msg = "模型流提前结束(网关未发送 stop 事件)".to_string();
                            if let Some(log) = log {
                                log.error(request, &msg);
                            }
                            return Err(StreamFailure::Retryable(msg).into());
                        }
                        sink(AgentEvent::Notice {
                            text: "模型流提前中断,本轮回复可能不完整".to_string(),
                        });
                        turn.stop_reason = "stream_truncated".to_string();
                    }
                    if let Some(log) = log {
                        log.response(request, status, &turn);
                    }
                    return Ok(turn);
                }
                Err(StreamFailure::Aborted) => {
                    if let Some(log) = log {
                        log.error(request, ABORTED);
                    }
                    return Err(ABORTED.to_string());
                }
                Err(failure) => {
                    if let Some(log) = log {
                        log.error(request, failure_message(&failure));
                    }
                    let emitted = !turn.text.is_empty() || !turn.tool_calls.is_empty();
                    if emitted || attempt >= MAX_RETRIES {
                        return Err(failure.into());
                    }
                    let delay = backoff(attempt);
                    attempt += 1;
                    match &failure {
                        StreamFailure::Retryable(msg) => sink(AgentEvent::Notice {
                            text: format!(
                                "请求失败({}),{}s 后重试 {}/{}",
                                truncate(msg, 160),
                                delay.as_secs_f32(),
                                attempt,
                                MAX_RETRIES
                            ),
                        }),
                        _ => {}
                    }
                    tokio::select! {
                        _ = opts.abort.wait() => return Err(ABORTED.to_string()),
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
            }
        }
    }

    async fn read_anthropic_stream(
        &self,
        resp: reqwest::Response,
        sink: &(dyn Fn(AgentEvent) + Send + Sync),
        abort: &Arc<Abort>,
        turn: &mut TurnResult,
        log: Option<&RequestLog>,
        request: u64,
    ) -> Result<(), StreamFailure> {
        let mut state = AnthropicStreamState::default();
        let mut sse = SseParser::new();
        let mut stream = resp.bytes_stream();
        while let Some(bytes) = next_chunk_abort(&mut stream, abort).await? {
            for event in sse.feed(&bytes) {
                if let Some(log) = log {
                    log.sse(request, &event);
                }
                let v: Value = match serde_json::from_str(&event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                for out in state.apply(turn, &v)? {
                    sink(out);
                }
            }
        }
        Ok(())
    }
}

/// Incremental state of one Anthropic SSE stream. `apply` folds one parsed
/// `data:` event into the turn and returns the UI events it produces — pure
/// logic, unit-testable without an HTTP fixture.
#[derive(Default)]
struct AnthropicStreamState {
    /// The tool_use block being streamed: (id, name, partial input JSON).
    current_tool: Option<(String, String, String)>,
    /// The thinking block being streamed: (text, signature).
    current_thinking: Option<(String, String)>,
    /// Index into `blocks` of the text block being streamed (text deltas of one
    /// content block merge into it, so block boundaries survive).
    current_text: Option<usize>,
}

impl AnthropicStreamState {
    fn apply(
        &mut self,
        turn: &mut TurnResult,
        v: &Value,
    ) -> Result<Vec<AgentEvent>, StreamFailure> {
        match v["type"].as_str() {
            Some("message_start") => {
                turn.usage = anthropic_start_usage(&v["message"]);
                Ok(Vec::new())
            }
            Some("content_block_start") => {
                let block = &v["content_block"];
                match block["type"].as_str() {
                    Some("tool_use") => {
                        self.current_tool = Some((
                            block["id"].as_str().unwrap_or_default().to_string(),
                            block["name"].as_str().unwrap_or_default().to_string(),
                            String::new(),
                        ));
                    }
                    Some("thinking") => {
                        self.current_thinking = Some((String::new(), String::new()));
                    }
                    Some("text") => {
                        self.current_text = Some(turn.blocks.len());
                        turn.blocks.push(Content::Text {
                            text: String::new(),
                        });
                    }
                    _ => {}
                }
                Ok(Vec::new())
            }
            Some("content_block_delta") => {
                let delta = &v["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        let text = delta["text"].as_str().unwrap_or_default();
                        turn.text.push_str(text);
                        if let Some(index) = self.current_text {
                            if let Some(Content::Text { text: buf }) = turn.blocks.get_mut(index) {
                                buf.push_str(text);
                            }
                        }
                        Ok(vec![AgentEvent::TextDelta {
                            text: text.to_string(),
                        }])
                    }
                    // Streaming text of a thinking block; signature_delta is the
                    // block's integrity seal, needed when the block is sent back
                    // (MiniMax emits it, some gateways skip it — replayed as an
                    // empty string then).
                    Some("thinking_delta") => {
                        let text = delta["thinking"].as_str().unwrap_or_default();
                        if let Some((buf, _)) = self.current_thinking.as_mut() {
                            buf.push_str(text);
                        }
                        if text.is_empty() {
                            Ok(Vec::new())
                        } else {
                            Ok(vec![AgentEvent::ThinkingDelta {
                                text: text.to_string(),
                            }])
                        }
                    }
                    Some("signature_delta") => {
                        let sig = delta["signature"].as_str().unwrap_or_default();
                        if let Some((_, buf)) = self.current_thinking.as_mut() {
                            buf.push_str(sig);
                        }
                        Ok(Vec::new())
                    }
                    Some("input_json_delta") => {
                        if let Some((_, _, args)) = self.current_tool.as_mut() {
                            args.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        }
                        Ok(Vec::new())
                    }
                    _ => Ok(Vec::new()),
                }
            }
            Some("content_block_stop") => {
                if let Some((id, name, args)) = self.current_tool.take() {
                    let call = push_tool_call(turn, id, name, &args);
                    turn.blocks.push(call);
                }
                self.current_text = None;
                let Some((text, signature)) = self.current_thinking.take() else {
                    return Ok(Vec::new());
                };
                turn.blocks.push(Content::Thinking {
                    text,
                    signature: signature.clone(),
                });
                // The seal travels with the block boundary: the front end
                // persists both, and replays the signature on restore.
                Ok(vec![AgentEvent::ThinkingBlockEnd { signature }])
            }
            Some("message_delta") => {
                turn.stop_reason = v["delta"]["stop_reason"]
                    .as_str()
                    .unwrap_or("end_turn")
                    .to_string();
                if turn.stop_reason == "max_tokens" {
                    turn.hit_max_tokens = true;
                }
                turn.usage = anthropic_output_usage(turn.usage, &v["usage"]);
                Ok(Vec::new())
            }
            Some("error") => {
                // A stream-level error surfaces verbatim; the caller maps it to
                // a retry or a turn failure.
                Err(StreamFailure::Fatal(format!(
                    "api error: {}",
                    v["error"]["message"].as_str().unwrap_or("unknown")
                )))
            }
            _ => Ok(Vec::new()),
        }
    }
}

// ----------------------------------------------------------------------
// OpenAI-compatible /v1/chat/completions
// ----------------------------------------------------------------------
impl Provider {
    async fn stream_openai(
        &self,
        system: &str,
        items: &[ChatItem],
        tools: &[ToolDef],
        sink: &(dyn Fn(AgentEvent) + Send + Sync),
        opts: &TurnOptions,
    ) -> Result<TurnResult, String> {
        // OpenAI has a single system message: drop the cache boundary marker and
        // join the two halves with a blank line.
        let (static_part, dynamic_part) = super::prompt::split_cache(system);
        let system = match (static_part.trim(), dynamic_part.trim()) {
            (_, "") => static_part.to_string(),
            ("", tail) => tail.to_string(),
            (head, tail) => format!("{}\n\n{}", head, tail),
        };
        let messages: Vec<Value> = openai_messages(&system, items);
        let tools_json: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                })
            })
            .collect();

        let mut body = json!({
            "model": self.model,
            "stream": true,
            // Attach usage at the end of the request stream (OpenAI spec): the front
            // end uses it to show the context occupancy.
            "stream_options": {"include_usage": true},
            "messages": messages,
        });
        // The configured ceiling reaches both protocols: the OpenAI surface only
        // applies it when the body carries it, so an unset override still sends the
        // configured value (otherwise the gateway's own default applies and the
        // setting would do nothing here).
        body["max_tokens"] = json!(opts.max_tokens.unwrap_or(self.max_tokens));
        self.apply_thinking(&mut body, opts.thinking);
        // A pure Q&A session has no tools: omit the tools field entirely instead of
        // sending an empty array.
        if !tools_json.is_empty() {
            body["tools"] = json!(tools_json);
        }
        let url = format!("{}/chat/completions", self.base_url);
        let body_text = body.to_string();
        let log = opts.log.as_deref();
        let mut attempt = 0usize;
        loop {
            let request = match log {
                Some(log) => log.begin(
                    &RequestMeta {
                        session: &opts.session,
                        purpose: opts.purpose,
                        url: &url,
                        protocol: "openai",
                        model: &self.model,
                        thinking: opts.thinking,
                    },
                    &body,
                ),
                None => 0,
            };
            let resp = self
                .post_stream(&url, &body_text, &opts.abort, false, log, request)
                .await?;
            let status = resp.status().as_u16();
            let mut turn = TurnResult::default();
            let mut calls: Vec<(String, String, String)> = Vec::new();
            let outcome = self
                .read_openai_stream(resp, sink, &opts.abort, &mut turn, &mut calls, log, request)
                .await;
            match outcome {
                Ok(()) => {
                    finish_openai_turn(&mut turn, calls);
                    if let Some(log) = log {
                        log.response(request, status, &turn);
                    }
                    return Ok(turn);
                }
                Err(StreamFailure::Aborted) => {
                    if let Some(log) = log {
                        log.error(request, ABORTED);
                    }
                    return Err(ABORTED.to_string());
                }
                Err(failure) => {
                    if let Some(log) = log {
                        log.error(request, failure_message(&failure));
                    }
                    let emitted = !turn.text.is_empty();
                    if emitted || attempt >= MAX_RETRIES {
                        return Err(failure.into());
                    }
                    let delay = backoff(attempt);
                    attempt += 1;
                    if let StreamFailure::Retryable(msg) = &failure {
                        sink(AgentEvent::Notice {
                            text: format!(
                                "请求失败({}),{}s 后重试 {}/{}",
                                truncate(msg, 160),
                                delay.as_secs_f32(),
                                attempt,
                                MAX_RETRIES
                            ),
                        });
                    }
                    tokio::select! {
                        _ = opts.abort.wait() => return Err(ABORTED.to_string()),
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
            }
        }
    }

    async fn read_openai_stream(
        &self,
        resp: reqwest::Response,
        sink: &(dyn Fn(AgentEvent) + Send + Sync),
        abort: &Arc<Abort>,
        turn: &mut TurnResult,
        calls: &mut Vec<(String, String, String)>,
        log: Option<&RequestLog>,
        request: u64,
    ) -> Result<(), StreamFailure> {
        let mut sse = SseParser::new();
        let mut stream = resp.bytes_stream();
        while let Some(bytes) = next_chunk_abort(&mut stream, abort).await? {
            for event in sse.feed(&bytes) {
                if let Some(log) = log {
                    log.sse(request, &event);
                }
                if event == "[DONE]" {
                    return Ok(());
                }
                let v: Value = match serde_json::from_str(&event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(usage) = openai_usage(&v) {
                    turn.usage = Some(usage);
                }
                let delta = &v["choices"][0]["delta"];
                // Reasoning models (DeepSeek R1 / GLM / Qwen and friends) expose
                // their thinking field on the OpenAI-compatible stream: the common
                // name is reasoning_content, some GLM gateways use reasoning. It
                // accumulates into the turn so the next request carries it back
                // (the vendor contract for MiniMax's OpenAI endpoint).
                if let Some(text) = delta["reasoning_content"]
                    .as_str()
                    .or_else(|| delta["reasoning"].as_str())
                {
                    if !text.is_empty() {
                        turn.thinking.push_str(text);
                        sink(AgentEvent::ThinkingDelta {
                            text: text.to_string(),
                        });
                    }
                }
                if let Some(text) = delta["content"].as_str() {
                    if !text.is_empty() {
                        turn.text.push_str(text);
                        sink(AgentEvent::TextDelta {
                            text: text.to_string(),
                        });
                    }
                }
                if let Some(tcs) = delta["tool_calls"].as_array() {
                    for tc in tcs {
                        let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                        while calls.len() <= idx {
                            calls.push((String::new(), String::new(), String::new()));
                        }
                        if let Some(id) = tc["id"].as_str() {
                            calls[idx].0 = id.to_string();
                        }
                        if let Some(name) = tc["function"]["name"].as_str() {
                            calls[idx].1.push_str(name);
                        }
                        if let Some(args) = tc["function"]["arguments"].as_str() {
                            calls[idx].2.push_str(args);
                        }
                    }
                }
                if let Some(reason) = v["choices"][0]["finish_reason"].as_str() {
                    turn.stop_reason = reason.to_string();
                    if reason == "length" {
                        turn.hit_max_tokens = true;
                    }
                }
            }
        }
        Ok(())
    }
}

/// A parsed tool call goes into the turn and is returned for the ordered
/// `blocks` list. A malformed `input_json` is recorded as `input_error` instead
/// of silently becoming `{}`: the session answers that call with an
/// InputValidationError and the model gets a chance to retry.
fn push_tool_call(turn: &mut TurnResult, id: String, name: String, args: &str) -> Content {
    // The API tool name is the Claude Code-aligned one; a legacy name from an
    // old gateway or a replayed history is normalized here once, so events,
    // history and permissions all downstream see a single vocabulary.
    let name = super::tools::canonical(&name).to_string();
    let call = match parse_tool_input(args) {
        Ok(input) => Content::ToolUse {
            id,
            name,
            input,
            input_error: None,
        },
        Err(error) => Content::ToolUse {
            id,
            name,
            input: json!({}),
            input_error: Some(error),
        },
    };
    turn.tool_calls.push(call.clone());
    call
}

fn parse_tool_input(args: &str) -> Result<Value, String> {
    if args.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(args).map_err(|e| format!("invalid JSON in tool input: {}", e))
}

/// The OpenAI path accumulates calls by index; the same validation applies.
/// The ordered blocks are assembled here too: reasoning first, then text, then
/// the tool calls (the OpenAI stream carries reasoning on `reasoning_content`
/// and the MiniMax contract requires it back on the next request).
fn finish_openai_turn(turn: &mut TurnResult, calls: Vec<(String, String, String)>) {
    for (id, name, args) in calls {
        if name.is_empty() {
            continue;
        }
        let id = if id.is_empty() {
            format!("call_{}", uuid_like())
        } else {
            id
        };
        let call = push_tool_call(turn, id, name, &args);
        turn.blocks.push(call);
    }
    if !turn.text.is_empty() {
        // Text arrives as deltas; one message becomes one text block.
        let text = std::mem::take(&mut turn.text);
        turn.blocks.insert(0, Content::Text { text });
    }
    if !turn.thinking.is_empty() {
        let thinking = std::mem::take(&mut turn.thinking);
        turn.blocks.insert(
            0,
            Content::Thinking {
                text: thinking,
                signature: String::new(),
            },
        );
    }
    if turn.stop_reason.is_empty() {
        turn.stop_reason = "stop".into();
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut out = s.chars().take(n).collect::<String>();
        out.push('…');
        out
    }
}

fn uuid_like() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0)
        .to_string()
}

/// Incremental SSE parser: yields complete `data:` payloads.
struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    fn new() -> SseParser {
        SseParser { buf: Vec::new() }
    }

    fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let Some(pos) = find_double_newline(&self.buf) else {
                break;
            };
            let block = String::from_utf8_lossy(&self.buf[..pos]).to_string();
            self.buf.drain(..pos + 2);
            let mut data = String::new();
            for line in block.lines() {
                if let Some(rest) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(rest.trim_start());
                }
            }
            if !data.is_empty() {
                out.push(data);
            }
        }
        out
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len().saturating_sub(1) {
        if buf[i] == b'\n' && buf[i + 1] == b'\n' {
            return Some(i);
        }
        if i + 3 < buf.len() && &buf[i..i + 4] == b"\r\n\r\n" {
            return Some(i + 1);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::InlineImage;

    /// Feeds a raw SSE byte stream into the anthropic event state, the same way
    /// `read_anthropic_stream` does, without an HTTP fixture.
    fn feed_anthropic(turn: &mut TurnResult, sse: &str) {
        feed_anthropic_events(turn, sse);
    }

    /// The same fold as `feed_anthropic`, keeping the UI events so a test can
    /// assert what the stream announced.
    fn feed_anthropic_events(turn: &mut TurnResult, sse: &str) -> Vec<AgentEvent> {
        let mut state = AnthropicStreamState::default();
        let mut parser = SseParser::new();
        let mut out = Vec::new();
        for event in parser.feed(sse.as_bytes()) {
            let v: Value = serde_json::from_str(&event).unwrap();
            out.extend(state.apply(turn, &v).unwrap());
        }
        out
    }

    /// A thinking-level patch is user data merged at the request-body root. The
    /// keys the request builder owns stay untouched; a level that renamed
    /// `model` or nulled `messages` would ship a conversation the picker and the
    /// session record never describe.
    #[test]
    fn a_thinking_level_cannot_rewrite_the_request_it_lands_on() {
        let provider = Provider {
            kind: "openai".into(),
            base_url: "https://example.test/v1".into(),
            api_key: "k".into(),
            model: "m".into(),
            max_tokens: 8_192,
            provider_id: "p".into(),
            model_id: "m".into(),
            thinking_level: "high".into(),
            thinking_patch: json!({
                "model": "other",
                "stream": false,
                "messages": null,
                "max_tokens": 1,
                "reasoning_effort": "high"
            }),
            thinking_off_patch: json!({}),
            client: reqwest::Client::new(),
        };
        let mut body = json!({
            "model": "m",
            "stream": true,
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 8_192
        });
        provider.apply_thinking(&mut body, true);
        assert_eq!(body["model"], "m");
        assert_eq!(body["stream"], true);
        assert!(body["messages"].is_array());
        assert_eq!(body["max_tokens"], 8_192);
        assert_eq!(body["reasoning_effort"], "high");
    }

    #[test]
    fn anthropic_stream_keeps_thinking_blocks_in_order_and_round_trips_them() {
        // MiniMax-M3.1's interleaved shape: thinking(+signature) → text →
        // tool_use → thinking → tool_use inside ONE message. The blocks must
        // replay in exactly this order — the vendor contract requires the full
        // response back, and dropping thinking broke long tool loops.
        let sse = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"step one\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig1\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Let me look.\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Read\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a.ts\\\"}\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"thinking\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"step two\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":3}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":4,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"Grep\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":4,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":4}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":9}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let mut turn = TurnResult::default();
        let events = feed_anthropic_events(&mut turn, sse);
        assert_eq!(turn.stop_reason, "tool_use");
        assert_eq!(turn.text, "Let me look.");
        assert_eq!(turn.tool_calls.len(), 2);
        let kinds: Vec<&str> = turn
            .blocks
            .iter()
            .map(|c| match c {
                Content::Thinking { .. } => "thinking",
                Content::Text { .. } => "text",
                Content::ToolUse { .. } => "tool_use",
                _ => "other",
            })
            .collect();
        assert_eq!(
            kinds,
            vec!["thinking", "text", "tool_use", "thinking", "tool_use"]
        );
        // The wire round-trip: the thinking block goes back with `thinking` as
        // the text field name plus its signature, ready for the next request.
        let wire: Vec<Value> = turn.blocks.iter().map(anthropic_block).collect();
        assert_eq!(wire[0]["type"], "thinking");
        assert_eq!(wire[0]["thinking"], "step one");
        assert_eq!(wire[0]["signature"], "sig1");
        assert_eq!(wire[3]["thinking"], "step two");
        assert_eq!(wire[2]["type"], "tool_use");
        assert_eq!(wire[2]["id"], "t1");
        // Every thinking block boundary reaches the front end with its seal, so
        // the session record can store the signature and replay it on restore.
        // A block without a signature_delta still announces the boundary (with
        // an empty seal), which is what keeps two blocks from being merged.
        let seals: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ThinkingBlockEnd { signature } => Some(signature.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(seals, vec!["sig1", ""]);
    }

    #[test]
    fn openai_assistant_history_carries_reasoning_content_back() {
        let items = vec![ChatItem::Message {
            role: "assistant".into(),
            content: vec![
                Content::Thinking {
                    text: "why".into(),
                    signature: String::new(),
                },
                Content::Text {
                    text: "answer".into(),
                },
                Content::ToolUse {
                    id: "t1".into(),
                    name: "Read".into(),
                    input: json!({}),
                    input_error: None,
                },
            ],
        }];
        let messages = openai_messages("", &items);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["reasoning_content"], "why");
        assert_eq!(messages[0]["content"], "answer");
        assert_eq!(messages[0]["tool_calls"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn openai_turn_assembles_blocks_in_reasoning_text_tool_order() {
        let mut turn = TurnResult::default();
        turn.text = "hi".into();
        turn.thinking = "hmm".into();
        finish_openai_turn(&mut turn, vec![("t1".into(), "Read".into(), "{}".into())]);
        let kinds: Vec<&str> = turn
            .blocks
            .iter()
            .map(|c| match c {
                Content::Thinking { .. } => "thinking",
                Content::Text { .. } => "text",
                Content::ToolUse { .. } => "tool_use",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["thinking", "text", "tool_use"]);
    }

    #[tokio::test]
    async fn stream_idle_timeout_errors_instead_of_hanging_forever() {
        // With a half-open gateway the SSE stream never ends on its own: without
        // this timeout a turn hangs forever and the session's running flag never
        // resets (every later send is rejected with SESSION_BUSY).
        let mut stream = futures::stream::pending::<Result<bytes::Bytes, std::io::Error>>();
        let err = next_chunk_with(&mut stream, Duration::from_millis(30))
            .await
            .unwrap_err();
        assert!(err.contains("空闲超时"), "{}", err);
    }

    #[tokio::test]
    async fn stream_ending_normally_returns_none_without_a_timeout_error() {
        let mut stream = futures::stream::iter(Vec::<Result<bytes::Bytes, std::io::Error>>::new());
        assert!(next_chunk_with(&mut stream, Duration::from_millis(30))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn stream_error_is_reported_unchanged() {
        let mut stream = futures::stream::iter(vec![Err::<bytes::Bytes, _>(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "reset",
        ))]);
        let err = next_chunk_with(&mut stream, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(err.contains("reset"), "{}", err);
    }

    #[test]
    fn anthropic_block_maps_an_image_to_a_base64_source() {
        let v = anthropic_block(&Content::Image {
            media_type: "image/png".into(),
            data: "AAAA".into(),
        });
        assert_eq!(v["type"], "image");
        assert_eq!(v["source"]["type"], "base64");
        assert_eq!(v["source"]["media_type"], "image/png");
        assert_eq!(v["source"]["data"], "AAAA");
    }

    #[test]
    fn anthropic_tool_result_stays_a_string_without_images_and_becomes_a_blocks_array() {
        let plain = anthropic_block(&Content::ToolResult {
            tool_use_id: "t1".into(),
            content: "preview updated".into(),
            is_error: false,
            images: vec![],
        });
        assert_eq!(plain["type"], "tool_result");
        assert_eq!(plain["content"], "preview updated");
        assert_eq!(plain["tool_use_id"], "t1");

        let with_img = anthropic_block(&Content::ToolResult {
            tool_use_id: "t2".into(),
            content: "preview updated: page.html".into(),
            is_error: false,
            images: vec![InlineImage {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            }],
        });
        assert_eq!(with_img["type"], "tool_result");
        let blocks = with_img["content"]
            .as_array()
            .expect("content must be an array with images");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "preview updated: page.html");
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["source"]["media_type"], "image/png");
        assert_eq!(blocks[1]["source"]["data"], "AAAA");
    }

    #[test]
    fn openai_tool_result_message_carries_text_only_and_keeps_images_out() {
        // The OpenAI protocol only accepts text in tool messages: a result that
        // carries images serializes with content still plain text, the
        // tool_call_id matches, and no image_url part is included.
        let items = vec![ChatItem::Message {
            role: "user".into(),
            content: vec![Content::ToolResult {
                tool_use_id: "t1".into(),
                content: "preview updated".into(),
                is_error: false,
                images: vec![InlineImage {
                    media_type: "image/png".into(),
                    data: "AAAA".into(),
                }],
            }],
        }];
        let messages = openai_messages("", &items);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "tool");
        assert_eq!(messages[0]["tool_call_id"], "t1");
        assert_eq!(messages[0]["content"], "preview updated");
        assert!(messages[0].get("content").unwrap().is_string());
    }

    #[test]
    fn anthropic_message_start_usage_counts_cache_reads_and_writes_as_input() {
        let message = json!({
            "usage": {
                "input_tokens": 100,
                "cache_creation_input_tokens": 20,
                "cache_read_input_tokens": 300,
                "output_tokens": 1,
            }
        });
        assert_eq!(
            anthropic_start_usage(&message),
            Some(TokenUsage {
                input: 420,
                output: 1,
                cache_read: 300,
            })
        );
    }

    #[test]
    fn anthropic_message_delta_updates_only_the_output_and_keeps_the_input_from_start() {
        let start = Some(TokenUsage {
            input: 420,
            output: 1,
            cache_read: 300,
        });
        assert_eq!(
            anthropic_output_usage(start, &json!({"output_tokens": 88})),
            Some(TokenUsage {
                input: 420,
                output: 88,
                cache_read: 300,
            })
        );
        // Without a start event it must not be lost either: the output still has to
        // be reported.
        assert_eq!(
            anthropic_output_usage(None, &json!({"output_tokens": 5})),
            Some(TokenUsage {
                input: 0,
                output: 5,
                cache_read: 0,
            })
        );
    }

    #[test]
    fn anthropic_message_delta_carries_the_input_when_the_gateway_skips_message_start() {
        // MiniMax's Anthropic-compatible endpoint sends no usage on
        // message_start and the whole picture only on message_delta: without
        // picking the input up here, the context occupancy degenerates to the
        // output alone.
        let usage = anthropic_output_usage(
            None,
            &json!({
                "input_tokens": 9,
                "cache_read_input_tokens": 197,
                "output_tokens": 32,
            }),
        );
        assert_eq!(
            usage,
            Some(TokenUsage {
                input: 206,
                output: 32,
                cache_read: 197,
            })
        );
        // A gateway that reports the input on both events must not double count:
        // the delta replaces, never adds.
        let started = Some(TokenUsage {
            input: 206,
            output: 0,
            cache_read: 197,
        });
        assert_eq!(
            anthropic_output_usage(started, &json!({"input_tokens": 9, "output_tokens": 32})),
            Some(TokenUsage {
                input: 9,
                output: 32,
                cache_read: 0,
            })
        );
    }

    #[test]
    fn openai_usage_accepts_prompt_completion_and_input_output() {
        assert_eq!(
            openai_usage(&json!({"usage": {"prompt_tokens": 61_800, "completion_tokens": 10_000}})),
            Some(TokenUsage {
                input: 61_800,
                output: 10_000,
                cache_read: 0,
            })
        );
        assert_eq!(
            openai_usage(&json!({"usage": {"input_tokens": 7, "output_tokens": 3}})),
            Some(TokenUsage {
                input: 7,
                output: 3,
                cache_read: 0,
            })
        );
        assert_eq!(
            openai_usage(&json!({
                "usage": {
                    "prompt_tokens": 500,
                    "completion_tokens": 40,
                    "prompt_tokens_details": {"cached_tokens": 384},
                }
            })),
            Some(TokenUsage {
                input: 500,
                output: 40,
                cache_read: 384,
            })
        );
    }

    #[test]
    fn usage_returns_none_when_missing_null_or_all_zero() {
        assert_eq!(openai_usage(&json!({})), None);
        assert_eq!(openai_usage(&json!({"usage": null})), None);
        assert_eq!(
            openai_usage(&json!({"usage": {"prompt_tokens": 0, "completion_tokens": 0}})),
            None
        );
        assert_eq!(anthropic_start_usage(&json!({})), None);
    }

    #[test]
    fn openai_keeps_a_plain_string_without_images_for_older_endpoints() {
        let v = openai_user_content(&["问题".to_string()], &[]);
        assert_eq!(v, json!("问题"));
    }

    #[test]
    fn openai_switches_to_a_multi_part_array_with_the_text_first_and_a_data_url() {
        let v = openai_user_content(
            &["这是什么".to_string()],
            vec![Content::Image {
                media_type: "image/jpeg".into(),
                data: "BBBB".into(),
            }]
            .as_slice(),
        );
        let parts = v.as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/jpeg;base64,BBBB");
    }

    #[test]
    fn openai_image_only_message_has_no_empty_text_part() {
        let v = openai_user_content(
            &[],
            vec![Content::Image {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            }]
            .as_slice(),
        );
        let parts = v.as_array().unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "image_url");
    }
}
