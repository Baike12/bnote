//! LSP transport layer: `Content-Length` framed JSON-RPC, file:// URI
//! encoding and decoding.
//!
//! This layer only answers "how to talk": standard LSP uses `Content-Length`
//! frames over stdio (not the newline-delimited JSON of MCP), and URIs use the
//! RFC 3986 percent-encoding. What is said is up to each caller:
//!
//! - [`python::lsp`](crate::python::lsp) — the Python embedded in markdown.
//!   The document is **virtual**: its URI points at the real path of the note,
//!   while its content is assembled Python source whose line and column numbers
//!   align line by line with the markdown.
//! - [`code::lsp`](crate::code::lsp) — the **real** files of a code project.
//!
//! Both share the frames and the URIs, so the same protocol is not written
//! twice and a change cannot miss one of them.

pub mod client;

use std::path::Path;

/// Encoding of the path part of a file:// URI: the RFC 3986 unreserved
/// characters and '/' are kept, everything else becomes %XX per UTF-8 byte
/// (spaces and Chinese characters are encoded as well).
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

/// The inverse of [`encode_uri_path`]; a non-file:// URI or a parse failure
/// returns None.
pub fn decode_uri_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    // file://host/path only supports an empty host (localhost or the empty
    // string).
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

/// Absolute path → file:// URI.
pub fn path_to_uri(path: &Path) -> String {
    format!("file://{}", encode_uri_path(&path.to_string_lossy()))
}

/// Encodes one JSON-RPC message as an LSP frame (a `Content-Length` header +
/// an empty line + the body).
pub fn frame_message(msg: &serde_json::Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_string(msg).map_err(|e| format!("SERIALIZE_FAILED: {}", e))?;
    Ok(format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes())
}

/// Reads the Content-Length out of a header line (case insensitive, tolerates
/// extra headers).
pub fn content_length_of(header_line: &str) -> Option<usize> {
    let (key, value) = header_line.split_once(':')?;
    if key.trim().eq_ignore_ascii_case("content-length") {
        value.trim().parse().ok()
    } else {
        None
    }
}

/// A boxed future, only there to give the trait an async method without pulling
/// in an async-trait dependency.
///
/// The lifetime follows the borrow (`'a`): the trait methods take `&self` /
/// `&LspClient` and the returned future borrows them. The caller (the read
/// loop) awaits it immediately and never holds it across an await.
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
        // A space → %20; the first CJK character of the path is E5 BC A0 in
        // UTF-8.
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
