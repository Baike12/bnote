//! Study-mode selection translation.
//!
//! Two paths, deliberately separated so a word can never fall through to the
//! network: exactly one English token goes to the embedded dictionary; two or
//! more tokens go to the configured model API. A missing word returns `Miss`
//! and the UI tells the user to select more words if they want the model.
//!
//! The API configuration lives in `<app_data>/translate.json`, independent of
//! the study-agent config. Requests are made from Rust so the key never enters
//! the webview. Thinking is off by default; each protocol gets its documented
//! off/on field (`think`, `thinking.type`, `enable_thinking`).

use crate::dict::{self, DictEntry};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Selections longer than this are rejected instead of being sent to the API.
pub const MAX_TRANSLATE_CHARS: usize = 4000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

const SYSTEM_PROMPT: &str = "You are a translation engine. Translate the user's English text into Simplified Chinese. Preserve the meaning, terminology, and tone. Output only the translation, with no explanations, notes, or quotation marks.";

/// API configuration persisted at `<app_data>/translate.json`.
///
/// Field names stay snake_case in JSON to match the existing `agent.json`
/// convention. `extraBody` is merged into the request body for gateways whose
/// thinking switch uses a vendor-specific field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TranslateConfig {
    /// "openai" | "deepseek" | "glm" | "qwen" | "ollama" | "anthropic" | "custom"
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// 默认关闭。开启后按协议发 think=true / thinking.enabled /
    /// enable_thinking=true。
    pub thinking: bool,
    pub timeout_ms: u64,
    /// 额外请求体（JSON 对象），用于自定义网关。不能覆盖 messages/model/stream。
    pub extra_body: Value,
}

impl Default for TranslateConfig {
    fn default() -> Self {
        TranslateConfig {
            protocol: "openai".into(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            thinking: false,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            extra_body: json!({}),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Protocol {
    Ollama,
    Anthropic,
    OpenAiCompat,
}

impl TranslateConfig {
    pub fn normalize(&mut self) {
        self.protocol = self.protocol.trim().to_ascii_lowercase();
        if !matches!(
            self.protocol.as_str(),
            "openai" | "deepseek" | "glm" | "qwen" | "ollama" | "anthropic" | "custom"
        ) {
            self.protocol = "openai".into();
        }
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        self.model = self.model.trim().to_string();
        self.api_key = self.api_key.trim().to_string();
        self.timeout_ms = self.timeout_ms.clamp(1_000, 120_000);
        if !self.extra_body.is_object() {
            self.extra_body = json!({});
        }
    }

    fn protocol(&self) -> Protocol {
        match self.protocol.as_str() {
            "ollama" => Protocol::Ollama,
            "anthropic" => Protocol::Anthropic,
            _ => Protocol::OpenAiCompat,
        }
    }

    fn base(&self) -> String {
        if !self.base_url.is_empty() {
            return self.base_url.clone();
        }
        match self.protocol.as_str() {
            "deepseek" => "https://api.deepseek.com",
            "glm" => "https://open.bigmodel.cn/api/paas/v4",
            "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "ollama" => "http://127.0.0.1:11434",
            "anthropic" => "https://api.anthropic.com",
            "custom" => "",
            _ => "https://api.openai.com/v1",
        }
        .to_string()
    }

    fn endpoint(&self) -> String {
        let base = self.base();
        if base.is_empty() {
            return String::new();
        }
        let base = base.trim_end_matches('/');
        match self.protocol() {
            Protocol::Ollama => {
                let root = base.strip_suffix("/v1").unwrap_or(base);
                format!("{}/api/chat", root)
            }
            Protocol::Anthropic => {
                if base.ends_with("/messages") {
                    base.to_string()
                } else if base.ends_with("/v1") {
                    format!("{}/messages", base)
                } else {
                    format!("{}/v1/messages", base)
                }
            }
            Protocol::OpenAiCompat => {
                if base.ends_with("/chat/completions") {
                    base.to_string()
                } else {
                    format!("{}/chat/completions", base)
                }
            }
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.model.is_empty() {
            return Err("翻译 API 未配置：请先在设置 → 翻译 里填写模型。".into());
        }
        if self.endpoint().is_empty() {
            return Err("翻译 API 未配置：请填写 Base URL。".into());
        }
        Ok(())
    }

    /// Request body for one translation. Exposed for unit tests.
    pub fn build_body(&self, text: &str) -> Value {
        let system = SYSTEM_PROMPT;
        let messages = json!([
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ]);
        let mut body = match self.protocol() {
            Protocol::Ollama => json!({
                "model": self.model,
                "messages": messages,
                "stream": false,
                "think": self.thinking,
            }),
            Protocol::Anthropic => {
                let mut body = json!({
                    "model": self.model,
                    "max_tokens": 2048,
                    "system": system,
                    "messages": [{ "role": "user", "content": text }],
                });
                if self.thinking {
                    body["thinking"] = json!({ "type": "enabled", "budget_tokens": 1024 });
                }
                body
            }
            Protocol::OpenAiCompat => {
                let mut body = json!({
                    "model": self.model,
                    "messages": messages,
                    "stream": false,
                });
                match self.protocol.as_str() {
                    "deepseek" | "glm" => {
                        body["thinking"] = json!({
                            "type": if self.thinking { "enabled" } else { "disabled" }
                        });
                    }
                    "qwen" => {
                        body["enable_thinking"] = json!(self.thinking);
                    }
                    // openai/custom: the model choice or extra_body controls
                    // thinking; unknown top-level flags make strict gateways 400.
                    _ => {}
                }
                body
            }
        };

        if let (Some(dst), Some(extra)) = (body.as_object_mut(), self.extra_body.as_object()) {
            for (key, value) in extra {
                if matches!(key.as_str(), "messages" | "model" | "stream") {
                    continue;
                }
                dst.insert(key.clone(), value.clone());
            }
        }
        // The protocol's own thinking switch and our fixed fields win over
        // extra_body, so the UI toggle is always the source of truth.
        match self.protocol() {
            Protocol::Ollama => body["think"] = json!(self.thinking),
            Protocol::Anthropic => {
                if self.thinking {
                    body["thinking"] = json!({ "type": "enabled", "budget_tokens": 1024 });
                } else if let Some(map) = body.as_object_mut() {
                    map.remove("thinking");
                }
            }
            Protocol::OpenAiCompat => match self.protocol.as_str() {
                "deepseek" | "glm" => {
                    body["thinking"] = json!({
                        "type": if self.thinking { "enabled" } else { "disabled" }
                    });
                }
                "qwen" => body["enable_thinking"] = json!(self.thinking),
                _ => {}
            },
        }
        body["model"] = json!(self.model);
        body["stream"] = json!(false);
        body
    }
}

pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("translate.json")
}

pub fn load(data_dir: &Path) -> TranslateConfig {
    let mut cfg = std::fs::read_to_string(config_path(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<TranslateConfig>(&raw).ok())
        .unwrap_or_default();
    cfg.normalize();
    cfg
}

pub fn save(data_dir: &Path, cfg: &TranslateConfig) -> Result<(), String> {
    let mut cfg = cfg.clone();
    cfg.normalize();
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(data_dir), json).map_err(|e| format!("WRITE_FAILED: {}", e))
}

/// What the selection contains. Exactly one English token is a word; anything
/// with two or more is a sentence/phrase and goes to the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionKind {
    Word(String),
    Sentence,
    None,
}

pub fn classify(text: &str) -> SelectionKind {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return SelectionKind::None;
    }
    // A bare URL is not prose; don't spend an API request on it.
    let lower = trimmed.to_ascii_lowercase();
    if !trimmed.chars().any(char::is_whitespace)
        && (lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("www."))
    {
        return SelectionKind::None;
    }
    let tokens = english_tokens(trimmed);
    match tokens.len() {
        0 => SelectionKind::None,
        1 => SelectionKind::Word(tokens[0].to_string()),
        _ => SelectionKind::Sentence,
    }
}

/// ASCII-letter tokens; digits/apostrophes/hyphens inside a token stay.
fn english_tokens(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric()
                    || matches!(bytes[i], b'\'' | b'-' | 0xE2) // ’ (UTF-8 lead)
                )
            {
                // Skip the rest of the UTF-8 curly apostrophe.
                if bytes[i] == 0xE2 && i + 2 < bytes.len() {
                    i += 3;
                } else {
                    i += 1;
                }
            }
            if let Ok(token) = std::str::from_utf8(&bytes[start..i]) {
                out.push(token.trim_end_matches(|c: char| c == '\'' || c == '-'));
            }
        } else {
            i += 1;
        }
    }
    out.into_iter().filter(|t| !t.is_empty()).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SelectionResult {
    Word { entry: DictEntry },
    Miss { word: String },
    Sentence { translation: String },
    None,
}

/// Resolves a selection: one word consults only the embedded dictionary;
/// two or more call the configured model; a missing word never falls back.
pub async fn translate_selection(data_dir: &Path, text: &str) -> Result<SelectionResult, String> {
    if text.chars().count() > MAX_TRANSLATE_CHARS {
        return Err(format!(
            "选中内容过长（{} 字符），一次最多 {} 字符。",
            text.chars().count(),
            MAX_TRANSLATE_CHARS
        ));
    }
    match classify(text) {
        SelectionKind::None => Ok(SelectionResult::None),
        SelectionKind::Word(word) => Ok(match dict::lookup(&word) {
            Some(entry) => SelectionResult::Word { entry },
            None => SelectionResult::Miss { word },
        }),
        SelectionKind::Sentence => {
            let cfg = load(data_dir);
            cfg.validate()?;
            let translation = translate_sentence(&cfg, text).await?;
            Ok(SelectionResult::Sentence { translation })
        }
    }
}

/// Sends one sentence/phrase to the configured API. Public so the settings
/// "test connection" button can exercise unsaved form values.
pub async fn translate_sentence(cfg: &TranslateConfig, text: &str) -> Result<String, String> {
    cfg.validate()?;
    let url = cfg.endpoint();
    let body = cfg.build_body(text);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(cfg.timeout_ms))
        .build()
        .map_err(|e| format!("翻译请求初始化失败：{}", e))?;

    let mut req = client
        .post(&url)
        .header("content-type", "application/json");
    match cfg.protocol() {
        Protocol::Anthropic => {
            if !cfg.api_key.is_empty() {
                req = req.header("x-api-key", &cfg.api_key);
            }
            req = req.header("anthropic-version", "2023-06-01");
        }
        _ => {
            if !cfg.api_key.is_empty() {
                req = req.header("authorization", format!("Bearer {}", cfg.api_key));
            }
        }
    }

    let resp = req
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("翻译超时（{} 秒）。", cfg.timeout_ms / 1000)
            } else {
                format!("翻译请求失败：{}", e)
            }
        })?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "翻译请求失败（HTTP {}）：{}",
            status,
            truncate(&raw, 500)
        ));
    }
    let json: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("翻译接口返回的不是 JSON：{}（{}）", e, truncate(&raw, 300)))?;
    let text = match cfg.protocol() {
        Protocol::Ollama => ollama_text(&json),
        Protocol::Anthropic => anthropic_text(&json),
        Protocol::OpenAiCompat => openai_text(&json),
    }
    .ok_or_else(|| {
        let reasoning = json["choices"][0]["message"]["reasoning_content"]
            .as_str()
            .or_else(|| json["message"]["thinking"].as_str())
            .or_else(|| json["reasoning_content"].as_str());
        match reasoning {
            Some(r) if !r.trim().is_empty() => {
                "模型只返回了思考内容，没有译文；请关闭思考模式或更换模型。".to_string()
            }
            _ => format!("翻译接口没有返回译文：{}", truncate(&raw, 300)),
        }
    })?;
    Ok(clean_output(&text))
}

fn openai_text(json: &Value) -> Option<String> {
    let content = &json["choices"][0]["message"]["content"];
    if let Some(s) = content.as_str() {
        return (!s.trim().is_empty()).then(|| s.to_string());
    }
    let mut out = String::new();
    if let Some(blocks) = content.as_array() {
        for block in blocks {
            if let Some(t) = block["text"].as_str() {
                out.push_str(t);
            }
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

fn ollama_text(json: &Value) -> Option<String> {
    json["message"]["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

fn anthropic_text(json: &Value) -> Option<String> {
    let mut out = String::new();
    for block in json["content"].as_array()? {
        if block["type"].as_str() == Some("text") {
            if let Some(t) = block["text"].as_str() {
                out.push_str(t);
            }
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

fn clean_output(text: &str) -> String {
    let mut out = text.trim();
    for (open, close) in [('"', '"'), ('“', '”'), ('「', '」')] {
        if out.starts_with(open) && out.ends_with(close) && out.chars().count() >= 2 {
            out = out
                .trim_start_matches(open)
                .trim_end_matches(close)
                .trim();
            break;
        }
    }
    out.to_string()
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(protocol: &str) -> TranslateConfig {
        let mut cfg = TranslateConfig {
            protocol: protocol.into(),
            model: "test-model".into(),
            ..Default::default()
        };
        cfg.normalize();
        cfg
    }

    #[test]
    fn classify_separates_words_from_sentences() {
        assert_eq!(classify("hello"), SelectionKind::Word("hello".into()));
        assert_eq!(classify("hello, world!"), SelectionKind::Sentence);
        assert_eq!(classify("don't"), SelectionKind::Word("don't".into()));
        assert_eq!(
            classify("state-of-the-art"),
            SelectionKind::Word("state-of-the-art".into())
        );
        assert_eq!(classify("你好"), SelectionKind::None);
        assert_eq!(classify(""), SelectionKind::None);
        assert_eq!(classify("https://example.com"), SelectionKind::None);
        assert_eq!(classify("3.14"), SelectionKind::None);
    }

    #[test]
    fn deepseek_thinking_is_disabled_by_default() {
        let body = cfg("deepseek").build_body("hi");
        assert_eq!(body["thinking"]["type"], "disabled");
        let mut on = cfg("deepseek");
        on.thinking = true;
        assert_eq!(on.build_body("hi")["thinking"]["type"], "enabled");
    }

    #[test]
    fn qwen_uses_enable_thinking() {
        let body = cfg("qwen").build_body("hi");
        assert_eq!(body["enable_thinking"], false);
        let mut on = cfg("qwen");
        on.thinking = true;
        assert_eq!(on.build_body("hi")["enable_thinking"], true);
    }

    #[test]
    fn ollama_uses_native_chat_and_think() {
        let mut c = cfg("ollama");
        c.base_url = "http://127.0.0.1:11434/v1".into();
        c.normalize();
        assert_eq!(c.endpoint(), "http://127.0.0.1:11434/api/chat");
        assert_eq!(c.build_body("hi")["think"], false);
        c.thinking = true;
        assert_eq!(c.build_body("hi")["think"], true);
    }

    #[test]
    fn anthropic_omits_thinking_when_off() {
        let c = cfg("anthropic");
        let body = c.build_body("hi");
        assert!(body.get("thinking").is_none());
        assert_eq!(body["system"], SYSTEM_PROMPT);
        let mut on = cfg("anthropic");
        on.thinking = true;
        assert_eq!(on.build_body("hi")["thinking"]["type"], "enabled");
    }

    #[test]
    fn extra_body_cannot_replace_messages() {
        let mut c = cfg("custom");
        c.extra_body = json!({ "temperature": 0.1, "messages": "nope" });
        let body = c.build_body("hi");
        assert_eq!(body["temperature"], 0.1);
        assert!(body["messages"].is_array());
    }

    #[test]
    fn response_parsers() {
        let openai = json!({"choices": [{"message": {"content": "你好"}}]});
        assert_eq!(openai_text(&openai).as_deref(), Some("你好"));
        let ollama = json!({"message": {"content": "你好"}});
        assert_eq!(ollama_text(&ollama).as_deref(), Some("你好"));
        let anthropic = json!({"content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": "你好"}]});
        assert_eq!(anthropic_text(&anthropic).as_deref(), Some("你好"));
    }

    #[test]
    fn word_path_never_requires_api_config() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let dir = std::env::temp_dir().join(format!(
            "bnote-translate-word-test-{}",
            std::process::id()
        ));
        let word = rt
            .block_on(translate_selection(&dir, "ubiquitous"))
            .unwrap();
        assert!(matches!(word, SelectionResult::Word { .. }));
        let miss = rt
            .block_on(translate_selection(&dir, "tokenization"))
            .unwrap();
        assert!(matches!(miss, SelectionResult::Miss { .. }));
    }

    #[test]
    fn sentence_without_config_errors_before_network() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let dir = std::env::temp_dir().join(format!(
            "bnote-translate-empty-config-test-{}",
            std::process::id()
        ));
        let err = rt
            .block_on(translate_selection(&dir, "hello world"))
            .unwrap_err();
        assert!(err.contains("未配置"), "{}", err);
    }

    #[test]
    fn overlong_selection_is_rejected_before_lookup_or_network() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let dir = std::env::temp_dir().join(format!(
            "bnote-translate-too-long-test-{}",
            std::process::id()
        ));
        let text = "a".repeat(MAX_TRANSLATE_CHARS + 1);
        let err = rt
            .block_on(translate_selection(&dir, &text))
            .unwrap_err();
        assert!(err.contains("过长"), "{}", err);
    }

    #[test]
    fn missing_word_never_falls_back_to_the_api() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let dir = std::env::temp_dir().join(format!(
            "bnote-translate-no-fallback-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // 把 API 指向一个必然拒绝连接的端口:如果单词路径错误地降级到
        // 模型,这里会得到 Err 而不是 Miss。
        let mut cfg = TranslateConfig {
            protocol: "custom".into(),
            base_url: "http://127.0.0.1:9".into(),
            model: "m".into(),
            ..Default::default()
        };
        cfg.normalize();
        save(&dir, &cfg).unwrap();
        let result = rt
            .block_on(translate_selection(&dir, "tokenization"))
            .unwrap();
        assert!(matches!(result, SelectionResult::Miss { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }
}
