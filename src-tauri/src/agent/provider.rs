//! LLM providers: Anthropic Messages API + OpenAI-compatible chat completions,
//! both streamed over SSE and normalized into AgentEvents.

use super::cancel::Abort;
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
/// The error string that means "the user stopped the turn" — the session turns
/// it into a normal turn end, not an error bubble.
pub const ABORTED: &str = "ABORTED";

/// One streaming attempt failed in a way worth repeating: nothing has been shown
/// to the user yet, so the request can be replayed from scratch.
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
async fn next_chunk_with<S, E>(stream: &mut S, idle: Duration) -> Result<Option<bytes::Bytes>, String>
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
        // Images only occur in user messages (see ChatItem::user_message).
        Content::Image { media_type, data } => json!({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        }),
        Content::ToolUse { id, name, input, .. } => {
            json!({"type": "tool_use", "id": id, "name": name, "input": input})
        }
        // Without images keep the plain string shape (the least common multiple of
        // the existing session records and the compatibility endpoint); with images
        // the content switches to a blocks array (text + image), the standard
        // shape for tool_result in the official Anthropic protocol.
        Content::ToolResult { tool_use_id, content, is_error, images } if images.is_empty() => {
            json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error,
            })
        }
        Content::ToolResult { tool_use_id, content, is_error, images } => {
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
            let mut tool_calls: Vec<&Content> = Vec::new();
            for c in content {
                match c {
                    Content::Text { text: t } => text.push_str(t),
                    Content::ToolUse { .. } => tool_calls.push(c),
                    // Images only occur in user messages by construction; should one
                    // appear here it could not be carried anyway (OpenAI assistant
                    // content rejects image parts), so drop it.
                    Content::Image { .. } => {}
                    Content::ToolResult { .. } => {}
                }
            }
            let mut msg = json!({"role": "assistant"});
            if !text.is_empty() {
                msg["content"] = json!(text);
            }
            if !tool_calls.is_empty() {
                let calls: Vec<Value> = tool_calls
                    .iter()
                    .enumerate()
                    .map(|(i, c)| match c {
                        Content::ToolUse { id, name, input, .. } => json!({
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
                if let Content::ToolResult { tool_use_id, content, .. } = r {
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
    let input = count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
    let output = count("output_tokens");
    (input > 0 || output > 0).then_some(TokenUsage { input, output })
}

/// Anthropic `message_delta` carries only the cumulative output_tokens; the input
/// side is inherited from message_start.
fn anthropic_output_usage(current: Option<TokenUsage>, usage: &Value) -> Option<TokenUsage> {
    let output = usage.get("output_tokens").and_then(|v| v.as_u64())?;
    let mut next = current.unwrap_or_default();
    next.output = output;
    Some(next)
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
    (input > 0 || output > 0).then_some(TokenUsage { input, output })
}

/// Per-request options: the ceiling the loop may raise, and the turn's
/// cancellation token.
pub struct TurnOptions {
    pub max_tokens: Option<u32>,
    pub abort: Arc<Abort>,
}

pub struct Provider {
    pub kind: String, // "anthropic" | "openai"
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
    client: reqwest::Client,
}

impl Provider {
    pub fn new(kind: &str, base_url: &str, api_key: &str, model: &str, max_tokens: u32) -> Provider {
        let kind = kind.to_string();
        let base = if base_url.is_empty() {
            if kind == "anthropic" {
                "https://api.anthropic.com".to_string()
            } else {
                "https://api.openai.com/v1".to_string()
            }
        } else {
            base_url.trim_end_matches('/').to_string()
        };
        Provider {
            kind,
            base_url: base,
            api_key: api_key.to_string(),
            model: model.to_string(),
            max_tokens: max_tokens.max(1024),
            client: reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
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
        };
        self.stream_turn_with(system, items, tools, sink, &opts).await
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
            self.stream_anthropic(system, items, tools, sink, opts).await
        } else {
            self.stream_openai(system, items, tools, sink, opts).await
        }
    }

    /// POSTs the request, retrying transport failures and 429/5xx with backoff.
    /// A stop from the user cancels both the request and the wait.
    async fn post_stream(
        &self,
        url: &str,
        body: &str,
        abort: &Arc<Abort>,
        anthropic: bool,
    ) -> Result<reqwest::Response, String> {
        let mut attempt = 0usize;
        loop {
            let sent = tokio::select! {
                _ = abort.wait() => return Err(ABORTED.to_string()),
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
                    let msg = format!("HTTP {}: {}", status, truncate(&text, 500));
                    if !retryable_status(status) {
                        return Err(msg);
                    }
                    msg
                }
                Err(e) => format!("request: {}", e),
            };
            if attempt >= MAX_RETRIES {
                return Err(retry_msg);
            }
            let delay = backoff(attempt);
            attempt += 1;
            tokio::select! {
                _ = abort.wait() => return Err(ABORTED.to_string()),
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
        let mut attempt = 0usize;
        loop {
            let resp = self
                .post_stream(&url, &body_text, &opts.abort, true)
                .await?;
            let mut turn = TurnResult::default();
            let outcome = self
                .read_anthropic_stream(resp, sink, &opts.abort, &mut turn)
                .await;
            match outcome {
                Ok(()) => return Ok(turn),
                Err(StreamFailure::Aborted) => return Err(ABORTED.to_string()),
                Err(failure) => {
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
    ) -> Result<(), StreamFailure> {
        let mut current_tool: Option<(String, String, String)> = None; // (id, name, args)
        let mut sse = SseParser::new();
        let mut stream = resp.bytes_stream();
        while let Some(bytes) = next_chunk_abort(&mut stream, abort).await? {
            for event in sse.feed(&bytes) {
                let v: Value = match serde_json::from_str(&event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match v["type"].as_str() {
                    Some("message_start") => {
                        turn.usage = anthropic_start_usage(&v["message"]);
                    }
                    Some("content_block_start") => {
                        let block = &v["content_block"];
                        if block["type"] == "tool_use" {
                            current_tool = Some((
                                block["id"].as_str().unwrap_or_default().to_string(),
                                block["name"].as_str().unwrap_or_default().to_string(),
                                String::new(),
                            ));
                        }
                    }
                    Some("content_block_delta") => {
                        let delta = &v["delta"];
                        match delta["type"].as_str() {
                            Some("text_delta") => {
                                let text = delta["text"].as_str().unwrap_or_default();
                                turn.text.push_str(text);
                                sink(AgentEvent::TextDelta { text: text.to_string() });
                            }
                            // Streaming text of a thinking block (never enters the
                            // history, see AgentEvent::ThinkingDelta); signature_delta
                            // is the block signature, only meaningful when sent back,
                            // so it is dropped here.
                            Some("thinking_delta") => {
                                let text = delta["thinking"].as_str().unwrap_or_default();
                                if !text.is_empty() {
                                    sink(AgentEvent::ThinkingDelta { text: text.to_string() });
                                }
                            }
                            Some("input_json_delta") => {
                                if let Some((_, _, args)) = current_tool.as_mut() {
                                    args.push_str(delta["partial_json"].as_str().unwrap_or_default());
                                }
                            }
                            _ => {}
                        }
                    }
                    Some("content_block_stop") => {
                        if let Some((id, name, args)) = current_tool.take() {
                            push_tool_call(turn, id, name, &args);
                        }
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
                    }
                    Some("error") => {
                        return Err(StreamFailure::Fatal(format!(
                            "api error: {}",
                            v["error"]["message"].as_str().unwrap_or("unknown")
                        )));
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // OpenAI-compatible /v1/chat/completions
    // ------------------------------------------------------------------
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
        if let Some(max_tokens) = opts.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        // A pure Q&A session has no tools: omit the tools field entirely instead of
        // sending an empty array.
        if !tools_json.is_empty() {
            body["tools"] = json!(tools_json);
        }
        let url = format!("{}/chat/completions", self.base_url);
        let body_text = body.to_string();
        let mut attempt = 0usize;
        loop {
            let resp = self
                .post_stream(&url, &body_text, &opts.abort, false)
                .await?;
            let mut turn = TurnResult::default();
            let mut calls: Vec<(String, String, String)> = Vec::new();
            let outcome = self
                .read_openai_stream(resp, sink, &opts.abort, &mut turn, &mut calls)
                .await;
            match outcome {
                Ok(()) => {
                    finish_openai_turn(&mut turn, calls);
                    return Ok(turn);
                }
                Err(StreamFailure::Aborted) => return Err(ABORTED.to_string()),
                Err(failure) => {
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
    ) -> Result<(), StreamFailure> {
        let mut sse = SseParser::new();
        let mut stream = resp.bytes_stream();
        while let Some(bytes) = next_chunk_abort(&mut stream, abort).await? {
            for event in sse.feed(&bytes) {
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
                // name is reasoning_content, some GLM gateways use reasoning.
                if let Some(text) = delta["reasoning_content"]
                    .as_str()
                    .or_else(|| delta["reasoning"].as_str())
                {
                    if !text.is_empty() {
                        sink(AgentEvent::ThinkingDelta { text: text.to_string() });
                    }
                }
                if let Some(text) = delta["content"].as_str() {
                    if !text.is_empty() {
                        turn.text.push_str(text);
                        sink(AgentEvent::TextDelta { text: text.to_string() });
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

/// A parsed tool call goes into the turn. A malformed `input_json` is recorded
/// as `input_error` instead of silently becoming `{}`: the session answers that
/// call with an InputValidationError and the model gets a chance to retry.
fn push_tool_call(turn: &mut TurnResult, id: String, name: String, args: &str) {
    match parse_tool_input(args) {
        Ok(input) => turn.tool_calls.push(Content::ToolUse {
            id,
            name,
            input,
            input_error: None,
        }),
        Err(error) => turn.tool_calls.push(Content::ToolUse {
            id,
            name,
            input: json!({}),
            input_error: Some(error),
        }),
    }
}

fn parse_tool_input(args: &str) -> Result<Value, String> {
    if args.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(args).map_err(|e| format!("invalid JSON in tool input: {}", e))
}

/// The OpenAI path accumulates calls by index; the same validation applies.
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
        push_tool_call(turn, id, name, &args);
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

    #[tokio::test]
    async fn stream_idle_timeout_errors_instead_of_hanging_forever() {
        // With a half-open gateway the SSE stream never ends on its own: without
        // this timeout a turn hangs forever and the session's running flag never
        // resets (every later send is rejected with SESSION_BUSY).
        let mut stream =
            futures::stream::pending::<Result<bytes::Bytes, std::io::Error>>();
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
        let mut stream = futures::stream::iter(vec![Err::<bytes::Bytes, _>(
            std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset"),
        )]);
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
            images: vec![InlineImage { media_type: "image/png".into(), data: "AAAA".into() }],
        });
        assert_eq!(with_img["type"], "tool_result");
        let blocks = with_img["content"].as_array().expect("content must be an array with images");
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
                images: vec![InlineImage { media_type: "image/png".into(), data: "AAAA".into() }],
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
            Some(TokenUsage { input: 420, output: 1 })
        );
    }

    #[test]
    fn anthropic_message_delta_updates_only_the_output_and_keeps_the_input_from_start() {
        let start = Some(TokenUsage { input: 420, output: 1 });
        assert_eq!(
            anthropic_output_usage(start, &json!({"output_tokens": 88})),
            Some(TokenUsage { input: 420, output: 88 })
        );
        // Without a start event it must not be lost either: the output still has to
        // be reported.
        assert_eq!(
            anthropic_output_usage(None, &json!({"output_tokens": 5})),
            Some(TokenUsage { input: 0, output: 5 })
        );
    }

    #[test]
    fn openai_usage_accepts_prompt_completion_and_input_output() {
        assert_eq!(
            openai_usage(&json!({"usage": {"prompt_tokens": 61_800, "completion_tokens": 10_000}})),
            Some(TokenUsage { input: 61_800, output: 10_000 })
        );
        assert_eq!(
            openai_usage(&json!({"usage": {"input_tokens": 7, "output_tokens": 3}})),
            Some(TokenUsage { input: 7, output: 3 })
        );
    }

    #[test]
    fn usage_returns_none_when_missing_null_or_all_zero() {
        assert_eq!(openai_usage(&json!({})), None);
        assert_eq!(openai_usage(&json!({"usage": null})), None);
        assert_eq!(openai_usage(&json!({"usage": {"prompt_tokens": 0, "completion_tokens": 0}})), None);
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
        assert_eq!(
            parts[1]["image_url"]["url"],
            "data:image/jpeg;base64,BBBB"
        );
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
