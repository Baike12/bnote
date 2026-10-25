//! Wire types for the agent loop (modeled after codex `protocol` ResponseItem).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One content block of an assistant/user message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    Text { text: String },
    /// 用户消息里的图片附件(前端裁好的 base64)。模型侧由 provider 按
    /// Anthropic(base64 source)/ OpenAI(data URL)各自的格式映射。
    Image { media_type: String, data: String },
    ToolUse { id: String, name: String, input: Value },
    ToolResult { tool_use_id: String, content: String, is_error: bool },
}

/// A conversation item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatItem {
    Message { role: String, content: Vec<Content> },
}

/// 前端上传的一张图片(`agent_send` 的 images 参数,字段 camelCase)。
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
            content: vec![Content::Text { text: text.to_string() }],
        }
    }

    /// 用户消息 = 文本(可空) + 图片。文本为空且没有图片时得到空 content——
    /// 调用方(agent_send / Session::send)必须先拦住这种消息。
    pub fn user_message(text: &str, images: &[InlineImage]) -> ChatItem {
        let mut content = Vec::new();
        if !text.is_empty() {
            content.push(Content::Text { text: text.to_string() });
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
    /// Streaming thinking/reasoning(Anthropic thinking 块 / OpenAI 兼容的
    /// reasoning_content)。只用于前端展示,不进会话历史——纯问答不带工具,
    /// 回传 thinking 块要过签名校验,没有收益。
    ThinkingDelta { text: String },
    /// A tool call begins.
    ToolStart { id: String, name: String, input: Value },
    /// A tool finished.
    ToolEnd { id: String, ok: bool, output: String },
    /// A full turn (model response + tool runs) completed. `items` = 会话历史
    /// 此刻的条数(权威计数,前端分叉辅助会话时按它截断,免得各端猜测)。
    TurnEnd { reason: String, items: usize },
    /// The turn failed. `items` = 失败时已写入的历史条数。
    Error { message: String, items: usize },
}

/// Provider-agnostic streaming callback.
pub type EventSink<'a> = &'a (dyn Fn(AgentEvent) + Send + Sync + 'a);

/// What a provider turn produced.
#[derive(Debug, Default)]
pub struct TurnResult {
    pub text: String,
    pub tool_calls: Vec<Content>,
    pub stop_reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_文本在前_图片按传入顺序跟在后面() {
        let item = ChatItem::user_message(
            "这张图里是什么公式?",
            &[
                InlineImage { media_type: "image/png".into(), data: "AAAA".into() },
                InlineImage { media_type: "image/jpeg".into(), data: "BBBB".into() },
            ],
        );
        let ChatItem::Message { role, content } = item else {
            panic!("应为 Message");
        };
        assert_eq!(role, "user");
        assert_eq!(content.len(), 3);
        assert!(matches!(&content[0], Content::Text { text } if text.contains("公式")));
        assert!(matches!(&content[1], Content::Image { media_type, .. } if media_type == "image/png"));
        assert!(matches!(&content[2], Content::Image { media_type, .. } if media_type == "image/jpeg"));
    }

    #[test]
    fn user_message_纯图片消息_不带空文本块() {
        // Anthropic 会拒绝空 text 块之外的畸形序列;纯图片消息只允许 image 块。
        let item = ChatItem::user_message(
            "",
            &[InlineImage { media_type: "image/png".into(), data: "AAAA".into() }],
        );
        let ChatItem::Message { content, .. } = item else {
            panic!("应为 Message");
        };
        assert_eq!(content.len(), 1);
        assert!(matches!(&content[0], Content::Image { .. }));
    }

    #[test]
    fn inline_image_按_camelCase_反序列化_前端字段直进() {
        let img: InlineImage =
            serde_json::from_str(r#"{"mediaType":"image/png","data":"AAAA"}"#).unwrap();
        assert_eq!(img.media_type, "image/png");
        assert_eq!(img.data, "AAAA");
    }
}
