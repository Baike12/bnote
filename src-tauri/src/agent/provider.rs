//! LLM providers: Anthropic Messages API + OpenAI-compatible chat completions,
//! both streamed over SSE and normalized into AgentEvents.

use super::types::{AgentEvent, ChatItem, Content, TokenUsage, ToolDef, TurnResult};
use futures::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;

/// 建连超时:连不上要尽快报错,而不是挂着。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 流空闲超时:模型流超过这么久没有一个字节就按失败结束。
///
/// 没有它,网关/网络半开时 `stream.next().await` 永远不返回 → 会话的
/// running 一直为 true → 之后每次发送都被 SESSION_BUSY 拒掉;前端只弹
/// 一个几秒消失的 toast,用户看到的现象就是「再次发送没有回应」。推理
/// 模型思考期间会持续发 thinking_delta,真静默 180s 只剩网关挂死一种解释。
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(180);

/// 取下一块流数据,带空闲超时(测试可注入更短的超时)。
///
/// `None` = 流正常结束;`Err` = 空闲超时(网关无响应)或连接错误。
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

/// Anthropic content block:Text/Image/ToolUse/ToolResult 各自的线上形态。
fn anthropic_block(c: &Content) -> Value {
    match c {
        Content::Text { text } => json!({"type": "text", "text": text}),
        // 图片只出现在用户消息里(见 ChatItem::user_message)。
        Content::Image { media_type, data } => json!({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        }),
        Content::ToolUse { id, name, input } => {
            json!({"type": "tool_use", "id": id, "name": name, "input": input})
        }
        Content::ToolResult { tool_use_id, content, is_error } => json!({
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": content,
            "is_error": is_error,
        }),
    }
}

/// OpenAI 用户消息的 content:无图片保持纯字符串(既有形态,兼容旧端点),
/// 有图片时换多部件数组(text + image_url data URL)。
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

/// Anthropic `message_start` 的 usage:input_tokens 不含缓存读写,占用要三项相加。
fn anthropic_start_usage(message: &Value) -> Option<TokenUsage> {
    let usage = message.get("usage")?;
    let count = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    let input = count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
    let output = count("output_tokens");
    (input > 0 || output > 0).then_some(TokenUsage { input, output })
}

/// Anthropic `message_delta` 只携带累计 output_tokens;input 沿用 message_start。
fn anthropic_output_usage(current: Option<TokenUsage>, usage: &Value) -> Option<TokenUsage> {
    let output = usage.get("output_tokens").and_then(|v| v.as_u64())?;
    let mut next = current.unwrap_or_default();
    next.output = output;
    Some(next)
}

/// OpenAI 兼容流末尾的 usage(需要请求里带 stream_options.include_usage)。
/// 有的网关用 input/output_tokens 命名,一并认。
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

    /// Streams one turn. Emits TextDelta events; returns the assembled turn.
    pub async fn stream_turn(
        &self,
        system: &str,
        items: &[ChatItem],
        tools: &[ToolDef],
        sink: &(dyn Fn(AgentEvent) + Send + Sync),
    ) -> Result<TurnResult, String> {
        if self.kind == "anthropic" {
            self.stream_anthropic(system, items, tools, sink).await
        } else {
            self.stream_openai(system, items, tools, sink).await
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
    ) -> Result<TurnResult, String> {
        let mut messages: Vec<Value> = Vec::new();
        for item in items {
            if let ChatItem::Message { role, content } = item {
                let blocks: Vec<Value> = content.iter().map(anthropic_block).collect();
                messages.push(json!({"role": role, "content": blocks}));
            }
        }
        let tools_json: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();

        let mut body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "stream": true,
            "messages": messages,
        });
        // 纯问答会话没有任何工具:整个不发 tools 字段,而不是发空数组。
        if !tools_json.is_empty() {
            body["tools"] = json!(tools_json);
        }
        if !system.is_empty() {
            body["system"] = json!(system);
        }

        let url = format!("{}/v1/messages", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .header("anthropic-version", "2023-06-01")
            // Auth token style (proxy) or api key style, whichever applies.
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("x-api-key", &self.api_key)
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("request: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, truncate(&text, 500)));
        }

        let mut turn = TurnResult::default();
        let mut current_tool: Option<(String, String, String)> = None; // (id, name, args)
        let mut sse = SseParser::new();
        let mut stream = resp.bytes_stream();
        while let Some(bytes) = next_chunk(&mut stream).await? {
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
                            // thinking 块的流式文本(不进历史,见 AgentEvent::ThinkingDelta);
                            // signature_delta 是块签名,只在回传时有意义,这里丢弃。
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
                            let input: Value = if args.is_empty() {
                                json!({})
                            } else {
                                serde_json::from_str(&args).unwrap_or(json!({}))
                            };
                            turn.tool_calls.push(Content::ToolUse { id, name, input });
                        }
                    }
                    Some("message_delta") => {
                        turn.stop_reason = v["delta"]["stop_reason"]
                            .as_str()
                            .unwrap_or("end_turn")
                            .to_string();
                        turn.usage = anthropic_output_usage(turn.usage, &v["usage"]);
                    }
                    Some("error") => {
                        return Err(format!(
                            "api error: {}",
                            v["error"]["message"].as_str().unwrap_or("unknown")
                        ));
                    }
                    _ => {}
                }
            }
        }
        Ok(turn)
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
    ) -> Result<TurnResult, String> {
        let mut messages: Vec<Value> = Vec::new();
        if !system.is_empty() {
            messages.push(json!({"role": "system", "content": system}));
        }
        for item in items {
            if let ChatItem::Message { role, content } = item {
                if role == "assistant" {
                    let mut text = String::new();
                    let mut tool_calls: Vec<&Content> = Vec::new();
                    for c in content {
                        match c {
                            Content::Text { text: t } => text.push_str(t),
                            Content::ToolUse { .. } => tool_calls.push(c),
                            // 图片按构造只会出现在用户消息里;真出现也带不上
                            // (OpenAI assistant content 不接受 image 部件),丢弃。
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
                                Content::ToolUse { id, name, input } => json!({
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
        }
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
            // 请求流末尾附 usage(OpenAI 规范):前端据此显示上下文占用。
            "stream_options": {"include_usage": true},
            "messages": messages,
        });
        // 纯问答会话没有任何工具:整个不发 tools 字段,而不是发空数组。
        if !tools_json.is_empty() {
            body["tools"] = json!(tools_json);
        }
        let url = format!("{}/chat/completions", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", self.api_key))
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("request: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {}: {}", status, truncate(&text, 500)));
        }

        let mut turn = TurnResult::default();
        // tool call accumulation by index
        let mut calls: Vec<(String, String, String)> = Vec::new();
        let mut sse = SseParser::new();
        let mut stream = resp.bytes_stream();
        let mut done = false;
        while !done {
            let Some(bytes) = next_chunk(&mut stream).await? else {
                break;
            };
            for event in sse.feed(&bytes) {
                if event == "[DONE]" {
                    done = true;
                    break;
                }
                let v: Value = match serde_json::from_str(&event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(usage) = openai_usage(&v) {
                    turn.usage = Some(usage);
                }
                let delta = &v["choices"][0]["delta"];
                // 推理模型(DeepSeek R1 / GLM / Qwen 等)在 openai 兼容流上的
                // 思考字段:主流是 reasoning_content,GLM 某些网关用 reasoning。
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
                }
            }
        }
        for (id, name, args) in calls {
            if name.is_empty() {
                continue;
            }
            let input: Value = if args.is_empty() {
                json!({})
            } else {
                serde_json::from_str(&args).unwrap_or(json!({}))
            };
            let id = if id.is_empty() { format!("call_{}", uuid_like()) } else { id };
            turn.tool_calls.push(Content::ToolUse { id, name, input });
        }
        if turn.stop_reason.is_empty() {
            turn.stop_reason = "stop".into();
        }
        Ok(turn)
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

    #[tokio::test]
    async fn 流空闲超时报错而不是永久挂起() {
        // 网关半开时 SSE 流不会自己结束:没有这层超时,一轮对话会永远挂着,
        // 会话的 running 也永远不复位(之后每次发送都被 SESSION_BUSY 拒掉)。
        let mut stream =
            futures::stream::pending::<Result<bytes::Bytes, std::io::Error>>();
        let err = next_chunk_with(&mut stream, Duration::from_millis(30))
            .await
            .unwrap_err();
        assert!(err.contains("空闲超时"), "{}", err);
    }

    #[tokio::test]
    async fn 流正常结束返回_none_不误报超时() {
        let mut stream = futures::stream::iter(Vec::<Result<bytes::Bytes, std::io::Error>>::new());
        assert!(next_chunk_with(&mut stream, Duration::from_millis(30))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn 流错误原样上报() {
        let mut stream = futures::stream::iter(vec![Err::<bytes::Bytes, _>(
            std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset"),
        )]);
        let err = next_chunk_with(&mut stream, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(err.contains("reset"), "{}", err);
    }

    #[test]
    fn anthropic_block_图片映射为_base64_source() {
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
    fn anthropic_message_start_usage_把缓存读写计入输入() {
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
    fn anthropic_message_delta_只更新输出_输入沿用_start() {
        let start = Some(TokenUsage { input: 420, output: 1 });
        assert_eq!(
            anthropic_output_usage(start, &json!({"output_tokens": 88})),
            Some(TokenUsage { input: 420, output: 88 })
        );
        // 没有 start 时也不能丢:输出仍要给出来。
        assert_eq!(
            anthropic_output_usage(None, &json!({"output_tokens": 5})),
            Some(TokenUsage { input: 0, output: 5 })
        );
    }

    #[test]
    fn openai_usage_认_prompt_completion_也认_input_output() {
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
    fn usage_缺失_null_或全零时返回_none() {
        assert_eq!(openai_usage(&json!({})), None);
        assert_eq!(openai_usage(&json!({"usage": null})), None);
        assert_eq!(openai_usage(&json!({"usage": {"prompt_tokens": 0, "completion_tokens": 0}})), None);
        assert_eq!(anthropic_start_usage(&json!({})), None);
    }

    #[test]
    fn openai_无图片保持纯字符串_兼容旧端点() {
        let v = openai_user_content(&["问题".to_string()], &[]);
        assert_eq!(v, json!("问题"));
    }

    #[test]
    fn openai_带图片换多部件数组_文本在前_data_url格式() {
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
    fn openai_纯图片消息_没有空文本部件() {
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
