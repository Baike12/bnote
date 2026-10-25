//! LLM providers: Anthropic Messages API + OpenAI-compatible chat completions,
//! both streamed over SSE and normalized into AgentEvents.

use super::types::{AgentEvent, ChatItem, Content, ToolDef, TurnResult};
use futures::StreamExt;
use serde_json::{json, Value};

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
            client: reqwest::Client::new(),
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
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("stream: {}", e))?;
            for event in sse.feed(&bytes) {
                let v: Value = match serde_json::from_str(&event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match v["type"].as_str() {
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
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("stream: {}", e))?;
            for event in sse.feed(&bytes) {
                if event == "[DONE]" {
                    break;
                }
                let v: Value = match serde_json::from_str(&event) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let delta = &v["choices"][0]["delta"];
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
