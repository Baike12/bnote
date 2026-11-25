//! Reads a coding session's JSONL record back into model history.
//!
//! The desktop frontend does this in `historyFromTranscript`; the remote
//! attach path needs the same result on the Mac because the phone may ask for
//! a session that is not live (the Mac restarted). Unknown line types (reset
//! markers from checkpoints) are ignored, matching the frontend.

use std::path::Path;

use serde_json::Value;

use crate::agent::models::{ModelSelection, SessionModelConfig};
use crate::agent::types::{ChatItem, Content};

const MAX_ITEMS: usize = 4000;

#[derive(Debug, Default)]
pub struct Loaded {
    pub title: String,
    pub model: Option<SessionModelConfig>,
    pub selection: Option<ModelSelection>,
    pub items: Vec<ChatItem>,
}

pub fn load(path: &Path) -> Result<Loaded, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("NOT_FOUND: {} ({e})", path.display()))?;
    let mut out = Loaded::default();
    let mut latest_model: Option<SessionModelConfig> = None;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "meta" => {
                out.title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if let Some(model) = value.get("model").cloned() {
                    if let Ok(model) = serde_json::from_value::<SessionModelConfig>(model) {
                        out.model = Some(model);
                    }
                }
            }
            "model" => {
                if let Some(model) = value.get("model").cloned() {
                    if let Ok(model) = serde_json::from_value::<SessionModelConfig>(model) {
                        latest_model = Some(model);
                    }
                }
            }
            "user" => {
                let text = value.get("text").and_then(Value::as_str).unwrap_or("");
                if !text.is_empty() {
                    out.items.push(ChatItem::user_text(text));
                }
            }
            "assistant" => {
                let mut content = Vec::new();
                if let Some(thinking) = value.get("thinking").and_then(Value::as_str) {
                    if !thinking.is_empty() {
                        content.push(Content::Thinking {
                            text: thinking.to_string(),
                            signature: value
                                .get("thinkingSignature")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            redacted: None,
                        });
                    }
                }
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        content.push(Content::Text {
                            text: text.to_string(),
                        });
                    }
                }
                let mut tool_results = Vec::new();
                if let Some(tools) = value.get("tools").and_then(Value::as_array) {
                    for tool in tools {
                        let Some(id) = tool.get("id").and_then(Value::as_str) else {
                            continue;
                        };
                        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
                        content.push(Content::ToolUse {
                            id: id.to_string(),
                            name: name.to_string(),
                            input: tool.get("input").cloned().unwrap_or(Value::Null),
                            input_error: None,
                        });
                        tool_results.push(Content::ToolResult {
                            tool_use_id: id.to_string(),
                            content: tool
                                .get("output")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            is_error: !tool.get("ok").and_then(Value::as_bool).unwrap_or(true),
                            images: Vec::new(),
                        });
                    }
                }
                if !content.is_empty() {
                    out.items.push(ChatItem::Message {
                        role: "assistant".into(),
                        content,
                    });
                }
                if !tool_results.is_empty() {
                    out.items.push(ChatItem::Message {
                        role: "user".into(),
                        content: tool_results,
                    });
                }
            }
            _ => {}
        }
        if out.items.len() > MAX_ITEMS {
            let drop = out.items.len() - MAX_ITEMS;
            out.items.drain(..drop);
        }
    }

    if let Some(model) = latest_model {
        out.model = Some(model.clone());
    }
    out.selection = out.model.as_ref().and_then(|model| {
        if model.provider_id.is_empty() || model.model_id.is_empty() {
            return None;
        }
        Some(ModelSelection {
            provider_id: model.provider_id.clone(),
            model_id: model.model_id.clone(),
            thinking: model.thinking.clone(),
        })
    });
    if out.title.is_empty() {
        out.title = out
            .items
            .iter()
            .find_map(|item| match item {
                ChatItem::Message { role, content } if role == "user" => {
                    content.iter().find_map(|c| match c {
                        Content::Text { text } if !text.trim().is_empty() => Some(
                            text.lines()
                                .next()
                                .unwrap_or("")
                                .chars()
                                .take(60)
                                .collect::<String>(),
                        ),
                        _ => None,
                    })
                }
                _ => None,
            })
            .unwrap_or_default();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bnote-remote-transcript-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("s.jsonl");
        let mut file = std::fs::File::create(&path).expect("file");
        file.write_all(body.as_bytes()).expect("write");
        path
    }

    #[test]
    fn rebuilds_user_assistant_and_tool_results() {
        let path = temp_file(
            "roundtrip",
            concat!(
                r#"{"type":"meta","at":1,"title":"修复登录","model":{"provider":"anthropic","model":"m","baseUrl":"u","maxTokens":1,"contextWindow":2,"providerId":"p","modelId":"mm","thinking":"high"}}"#,
                "\n",
                r#"{"type":"user","at":2,"text":"看看 a.rs"}"#,
                "\n",
                r#"{"type":"assistant","at":3,"text":"读一下","thinking":"想","thinkingSignature":"sig","tools":[{"id":"t1","name":"Read","input":{"path":"a.rs"},"output":"ok","ok":true}]}"#,
                "\n",
                r#"{"type":"model","at":4,"model":{"provider":"anthropic","model":"m2","baseUrl":"u","maxTokens":1,"contextWindow":2,"providerId":"p","modelId":"m3","thinking":"low"}}"#,
                "\n",
                r#"{"type":"reset","at":5,"checkpointId":"c"}"#,
                "\n",
            ),
        );
        let loaded = load(&path).expect("load");
        assert_eq!(loaded.title, "修复登录");
        assert_eq!(loaded.items.len(), 3);
        assert_eq!(loaded.model.as_ref().expect("model").model_id, "m3");
        assert_eq!(
            loaded.selection.as_ref().expect("selection").thinking,
            "low"
        );
        assert!(matches!(&loaded.items[1], ChatItem::Message { role, .. } if role == "assistant"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_file_is_not_found() {
        let err = load(Path::new("/nonexistent/bnote/s.jsonl")).unwrap_err();
        assert!(err.starts_with("NOT_FOUND"));
    }
}
