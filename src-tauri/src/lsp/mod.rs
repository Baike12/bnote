//! LSP 传输层:Content-Length 帧 JSON-RPC、file:// URI 编解码。
//!
//! 这一层只回答「怎么说话」:标准 LSP 走 stdio 上的 `Content-Length` 帧
//! (不是 MCP 的换行分隔 JSON),URI 用 RFC 3986 百分号编码。「说什么」由
//! 各自的调用方决定:
//!
//! - [`python::lsp`](crate::python::lsp)——markdown 里内嵌的 python。文档是
//!   **虚拟**的:URI 指向笔记真实路径,内容却是拼出来的 python 源码,行列号
//!   与 markdown 逐行对齐。
//! - [`code::lsp`](crate::code::lsp)——代码项目里的**真实**文件。
//!
//! 两者共用帧与 URI,免得同一套协议写两遍、改一处漏一处。

pub mod client;

use std::path::Path;

/// file:// URI 的路径部分编码:保留 RFC 3986 unreserved 与 '/',其余按 UTF-8
/// 字节转 %XX(空格、中文都会被编码)。
pub fn encode_uri_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// [`encode_uri_path`] 的逆运算;非 file:// 或解析失败返回 None。
pub fn decode_uri_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    // file://host/path 只支持空 host(localhost/空串)。
    let path = match rest.split_once('/') {
        Some((host, p)) if host.is_empty() || host == "localhost" => format!("/{}", p),
        None if rest.starts_with('/') => rest.to_string(),
        _ => return None,
    };
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// 绝对路径 → file:// URI。
pub fn path_to_uri(path: &Path) -> String {
    format!("file://{}", encode_uri_path(&path.to_string_lossy()))
}

/// 把一条 JSON-RPC 消息编成 LSP 帧(`Content-Length` 头 + 空行 + body)。
pub fn frame_message(msg: &serde_json::Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_string(msg).map_err(|e| format!("SERIALIZE_FAILED: {}", e))?;
    Ok(format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes())
}

/// 从响应头行里取 Content-Length(大小写不敏感,容忍多余头)。
pub fn content_length_of(header_line: &str) -> Option<usize> {
    let (key, value) = header_line.split_once(':')?;
    if key.trim().eq_ignore_ascii_case("content-length") {
        value.trim().parse().ok()
    } else {
        None
    }
}

/// 盒装 future:只为给 trait 的异步方法用,不为此引入 async-trait 依赖。
///
/// 生命周期跟着借用走(`'a`):trait 方法拿 `&self` / `&LspClient`,返回的
/// future 借用它们。调用方(读循环)立刻 await,不跨 await 持有。
pub type BoxFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uri_roundtrip_with_cjk_and_spaces() {
        let p = "/Users/张三/my vault/笔记 01.md";
        let uri = path_to_uri(Path::new(p));
        // 空␣格 → %20;「张」UTF-8 = E5 BC A0。
        assert!(uri.starts_with("file:///Users/%E5%BC%A0"));
        assert!(uri.contains("my%20vault"));
        assert_eq!(decode_uri_path(&uri).as_deref(), Some(p));
    }

    #[test]
    fn decode_rejects_non_file_uris() {
        assert!(decode_uri_path("https://example.com/a.md").is_none());
        assert!(decode_uri_path("bnote-md:/x").is_none());
    }

    #[test]
    fn framing_matches_content_length() {
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "x" });
        let bytes = frame_message(&msg).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let len: usize = head
            .lines()
            .find_map(content_length_of)
            .expect("frame must carry content-length");
        assert_eq!(len, body.len());
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(parsed, msg);
    }

    #[test]
    fn content_length_is_case_insensitive_and_tolerates_other_headers() {
        assert_eq!(content_length_of("Content-Length: 42"), Some(42));
        assert_eq!(content_length_of("content-length: 7"), Some(7));
        assert_eq!(content_length_of("CONTENT-LENGTH: 0"), Some(0));
        assert_eq!(content_length_of("Content-Type: application/vscode-jsonrpc"), None);
    }
}
