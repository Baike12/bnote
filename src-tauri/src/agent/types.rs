//! Wire types for the agent loop (modeled after codex `protocol` ResponseItem).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One content block of an assistant/user message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    Text {
        text: String,
    },
    /// Image attachment in a user message (base64, cropped by the front end).
    /// The provider maps it to the format of each protocol: Anthropic
    /// (base64 source) / OpenAI (data URL).
    Image {
        media_type: String,
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
        /// Set when the streamed `input_json` could not be parsed. The call is
        /// still recorded (so the transcript keeps the pairing), but dispatch
        /// answers with an InputValidationError instead of running the tool on
        /// an empty object — a silent `{}` used to read zero bytes and report
        /// success.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_error: Option<String>,
    },
    /// Tool result. `images` are the rendered screenshots sent back to the model
    /// with the result (currently only preview_html); older session records have
    /// no such field, so deserialization fills an empty one.
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<InlineImage>,
    },
}

/// A conversation item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatItem {
    Message { role: String, content: Vec<Content> },
}

/// One image uploaded by the front end (the images argument of `agent_send`,
/// camelCase fields).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InlineImage {
    pub media_type: String,
    pub data: String,
}

impl ChatItem {
    pub fn user_text(text: &str) -> ChatItem {
        ChatItem::Message {
            role: "user".into(),
            content: vec![Content::Text {
                text: text.to_string(),
            }],
        }
    }

    /// A user message = text (may be empty) + images. With no text and no image
    /// the content is empty — the callers (agent_send / Session::send) have to
    /// reject such a message first.
    pub fn user_message(text: &str, images: &[InlineImage]) -> ChatItem {
        let mut content = Vec::new();
        if !text.is_empty() {
            content.push(Content::Text {
                text: text.to_string(),
            });
        }
        for img in images {
            content.push(Content::Image {
                media_type: img.media_type.clone(),
                data: img.data.clone(),
            });
        }
        ChatItem::Message {
            role: "user".into(),
            content,
        }
    }
}

/// A tool exposed to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// MCP tools carry their origin so results can be routed back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_server: Option<String>,
}

/// Streaming events pushed from backend to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Streaming text of the assistant reply.
    TextDelta { text: String },
    /// Streaming thinking/reasoning (an Anthropic thinking block / the
    /// OpenAI-compatible reasoning_content). Shown in the front end only, never
    /// enters the session history — a pure Q&A turn carries no tools, and echoing
    /// the thinking block back would require a signature check for no gain.
    ThinkingDelta { text: String },
    /// A tool call begins.
    ToolStart {
        id: String,
        name: String,
        input: Value,
    },
    /// A tool finished. `images` are the screenshots handed to the model with the
    /// result (e.g. the preview render); the front end uses them for display
    /// only. The field is omitted when empty to avoid per-tool-event overhead.
    ToolEnd {
        id: String,
        ok: bool,
        output: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<InlineImage>,
    },
    /// Token usage of one model request (context occupancy = input + output;
    /// input already includes cache reads). Anthropic reports it in
    /// message_start / message_delta; OpenAI-compatible endpoints only report
    /// usage at the end of the stream when the request carries stream_options.
    /// The front end keeps only the latest one: it is the context occupancy of
    /// the current session.
    Usage {
        input: u64,
        output: u64,
        #[serde(rename = "cacheRead")]
        cache_read: u64,
    },
    /// A system-level notice the panel renders as a dim status line:
    /// compaction happened, a subagent started/finished, a background task
    /// completed. Never enters the session history.
    Notice { text: String },
    /// The todo tool's list after a `todo` call (the panel's rendering source;
    /// the tool result text is only the one-line summary).
    Todos { todos: Vec<super::todo::TodoItem> },
    /// The v2 task list after any task tool call.
    Tasks { tasks: Vec<super::tasks::TaskItem> },
    /// Plan mode was switched by EnterPlanMode / ExitPlanMode (the panel shows
    /// a "计划中" chip and re-reads the shield's mode).
    PlanMode { enabled: bool },
    /// A tool needs the user's approval (the definition marks it `ask`). The
    /// turn is parked until `agent_permission_reply` answers this id.
    PermissionRequest {
        id: String,
        tool: String,
        input: Value,
    },
    /// The `ask_user_question` tool is waiting for an answer. The turn is parked
    /// until `agent_question_reply` answers this id.
    Question { id: String, questions: Value },
    /// A full turn (model response + tool runs) completed. `items` = the current
    /// number of session history entries (the authoritative count; the front end
    /// truncates by it when forking a helper session instead of guessing).
    TurnEnd { reason: String, items: usize },
    /// The turn failed. `items` = the number of history entries written before
    /// the failure.
    Error { message: String, items: usize },
}

/// Token usage of one model request.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TokenUsage {
    /// Prompt side, **including** cache reads and cache writes (the whole
    /// context the request carried); `output` is the completion.
    pub input: u64,
    pub output: u64,
    /// The share of `input` the provider served from its prompt cache
    /// (Anthropic cache_read_input_tokens, OpenAI cached_tokens). Reported so
    /// the UI can show a cache hit rate; it is a subset of `input`, never
    /// added on top of it.
    pub cache_read: u64,
}

/// Provider-agnostic streaming callback.
pub type EventSink<'a> = &'a (dyn Fn(AgentEvent) + Send + Sync + 'a);

/// What a provider turn produced.
#[derive(Debug, Default)]
pub struct TurnResult {
    pub text: String,
    pub tool_calls: Vec<Content>,
    pub stop_reason: String,
    pub usage: Option<TokenUsage>,
    /// The model's output hit the token ceiling: the loop may raise the ceiling
    /// once, then hand the model a "resume" message (see session.rs).
    pub hit_max_tokens: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_puts_the_text_first_and_the_images_after_it_in_the_given_order() {
        let item = ChatItem::user_message(
            "这张图里是什么公式?",
            &[
                InlineImage {
                    media_type: "image/png".into(),
                    data: "AAAA".into(),
                },
                InlineImage {
                    media_type: "image/jpeg".into(),
                    data: "BBBB".into(),
                },
            ],
        );
        let ChatItem::Message { role, content } = item else {
            panic!("expected a Message");
        };
        assert_eq!(role, "user");
        assert_eq!(content.len(), 3);
        assert!(matches!(&content[0], Content::Text { text } if text.contains("公式")));
        assert!(
            matches!(&content[1], Content::Image { media_type, .. } if media_type == "image/png")
        );
        assert!(
            matches!(&content[2], Content::Image { media_type, .. } if media_type == "image/jpeg")
        );
    }

    #[test]
    fn user_message_with_only_images_has_no_empty_text_block() {
        // Anthropic rejects malformed sequences other than an empty text block;
        // an image-only message may only contain image blocks.
        let item = ChatItem::user_message(
            "",
            &[InlineImage {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            }],
        );
        let ChatItem::Message { content, .. } = item else {
            panic!("expected a Message");
        };
        assert_eq!(content.len(), 1);
        assert!(matches!(&content[0], Content::Image { .. }));
    }

    #[test]
    fn inline_image_deserializes_the_camel_case_fields_sent_by_the_frontend() {
        let img: InlineImage =
            serde_json::from_str(r#"{"mediaType":"image/png","data":"AAAA"}"#).unwrap();
        assert_eq!(img.media_type, "image/png");
        assert_eq!(img.data, "AAAA");
    }

    #[test]
    fn tool_result_fills_an_empty_image_list_when_an_old_record_has_no_images_field() {
        // Persisted session history has no images field: deserialization must
        // fill an empty one instead of failing, otherwise every old session
        // fails to restore after the upgrade.
        let content: Content = serde_json::from_str(
            r#"{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}"#,
        )
        .unwrap();
        let Content::ToolResult {
            tool_use_id,
            images,
            ..
        } = content
        else {
            panic!("expected a ToolResult");
        };
        assert_eq!(tool_use_id, "t1");
        assert!(images.is_empty());
    }

    #[test]
    fn tool_result_serializes_images_in_camel_case_and_omits_the_field_when_empty() {
        let with_img = Content::ToolResult {
            tool_use_id: "t1".into(),
            content: "preview updated".into(),
            is_error: false,
            images: vec![InlineImage {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            }],
        };
        let v = serde_json::to_value(&with_img).unwrap();
        assert_eq!(v["images"][0]["mediaType"], "image/png");

        let plain = Content::ToolResult {
            tool_use_id: "t2".into(),
            content: "ok".into(),
            is_error: false,
            images: vec![],
        };
        let v = serde_json::to_value(&plain).unwrap();
        assert!(
            v.get("images").is_none(),
            "an empty images list must not be serialized"
        );
    }
}
