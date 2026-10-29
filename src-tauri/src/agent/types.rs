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
    /// 工具结果。`images` 是随结果回传给模型的渲染截图(目前仅
    /// preview_html),旧会话记录没有该字段,反序列化时补空。
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
    /// A tool finished. `images` 是随结果给模型的截图(如预览渲染图),
    /// 前端只用于展示;没有时不带字段,避免每条工具事件的空开销。
    ToolEnd {
        id: String,
        ok: bool,
        output: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<InlineImage>,
    },
    /// 一次模型请求的 token 用量(上下文占用 = input + output)。Anthropic 在
    /// message_start / message_delta 里给,OpenAI 兼容端点需要 stream_options
    /// 才会在流末尾给 usage。前端只保留最新一条:它就是当前会话的上下文占用。
    Usage { input: u64, output: u64 },
    /// A full turn (model response + tool runs) completed. `items` = 会话历史
    /// 此刻的条数(权威计数,前端分叉辅助会话时按它截断,免得各端猜测)。
    TurnEnd { reason: String, items: usize },
    /// The turn failed. `items` = 失败时已写入的历史条数。
    Error { message: String, items: usize },
}

/// Token usage of one model request.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
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

    #[test]
    fn tool_result_旧会话记录缺_images_字段时补空() {
        // 落盘的历史会话没有 images 字段:反序列化必须补空,不能报错,
        // 否则升级后旧会话全部恢复失败。
        let content: Content = serde_json::from_str(
            r#"{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}"#,
        )
        .unwrap();
        let Content::ToolResult { tool_use_id, images, .. } = content else {
            panic!("应为 ToolResult");
        };
        assert_eq!(tool_use_id, "t1");
        assert!(images.is_empty());
    }

    #[test]
    fn tool_result_带图序列化_camel_case_空图不写字段() {
        let with_img = Content::ToolResult {
            tool_use_id: "t1".into(),
            content: "preview updated".into(),
            is_error: false,
            images: vec![InlineImage { media_type: "image/png".into(), data: "AAAA".into() }],
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
        assert!(v.get("images").is_none(), "空 images 不该序列化出来");
    }
}
