//! bblog client commands: fetch the section tree for the publish dialog and
//! upload HTML/Markdown articles.
//!
//! Credentials (the vault's `.bnote/bblog/auth.json`) are read by the frontend
//! and passed in as arguments, so no secret is stored here; the upload uses
//! `Authorization: Bearer <token>`, i.e. bblog's machine-token channel at
//! `/api/upload`.

use super::CmdResult;
use serde_json::Value;

/// Normalizes the server address: trims whitespace and trailing slashes;
/// defaults to http:// when no scheme is given (bblog is often deployed on a
/// bare IP address, so https has to be spelled out by the user).
fn normalize_server(server: &str) -> Result<String, String> {
    let mut s = server.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err("INVALID_SERVER: 服务器地址为空".into());
    }
    if !s.starts_with("http://") && !s.starts_with("https://") {
        s = format!("http://{s}");
    }
    Ok(s)
}

async fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn bblog_sections(server: String) -> CmdResult<Value> {
    let base = normalize_server(&server)?;
    let url = format!("{base}/blog/api/sections");
    let resp = http_client()
        .await
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("NETWORK: 请求 bblog 失败: {e}"))?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("BAD_RESPONSE: bblog 返回的不是 JSON: {e}"))?;
    if !status.is_success() {
        let msg = body["error"]["message"]
            .as_str()
            .unwrap_or("未知错误")
            .to_string();
        return Err(format!("BBLOG_ERROR: {msg}"));
    }
    Ok(body)
}

#[tauri::command]
pub async fn bblog_publish(
    server: String,
    token: String,
    category: String,
    topic: String,
    filename: String,
    content: String,
) -> CmdResult<Value> {
    let base = normalize_server(&server)?;
    if token.trim().is_empty() {
        return Err("NO_TOKEN: 上传令牌为空(检查 .bnote/bblog/auth.json)".into());
    }
    if category.trim().is_empty() || topic.trim().is_empty() {
        return Err("INVALID_TARGET: 必须选择栏目和主题".into());
    }
    let url = format!("{base}/blog/api/upload");
    let body = serde_json::json!({
        "category": category.trim(),
        "topic": topic.trim(),
        "filename": filename.trim(),
        "content": content,
    });
    let resp = http_client()
        .await
        .post(&url)
        .header("Authorization", format!("Bearer {}", token.trim()))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("NETWORK: 上传失败: {e}"))?;
    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| format!("BAD_RESPONSE: bblog 返回的不是 JSON: {e}"))?;
    if !status.is_success() {
        let msg = payload["error"]["message"]
            .as_str()
            .unwrap_or("未知错误")
            .to_string();
        let code = match status.as_u16() {
            401 => "AUTH_FAILED: 认证被拒绝(令牌不正确或已失效)",
            _ => "BBLOG_ERROR",
        };
        return Err(format!("{code}: {msg}"));
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_gets_http_and_trailing_slashes_are_dropped() {
        // bblog is often deployed on a bare IP, so no scheme means http.
        assert_eq!(
            normalize_server("192.168.1.9:8080").expect("bare"),
            "http://192.168.1.9:8080"
        );
        assert_eq!(
            normalize_server("  http://blog.local/  ").expect("trim"),
            "http://blog.local"
        );
        assert_eq!(
            normalize_server("https://blog.example.com/").expect("https"),
            "https://blog.example.com"
        );
    }

    #[test]
    fn an_empty_server_is_rejected_before_any_request() {
        let err = normalize_server("   ").expect_err("empty");
        assert!(err.starts_with("INVALID_SERVER"), "{err}");
    }

    #[test]
    fn publishing_checks_its_arguments_before_the_network() {
        // Each guard runs before `http_client`, so the test never opens a
        // socket: an unreachable server would fail with NETWORK instead.
        let err = tauri::async_runtime::block_on(bblog_publish(
            "   ".into(),
            "t".into(),
            "c".into(),
            "t".into(),
            "f.md".into(),
            "body".into(),
        ))
        .expect_err("empty server");
        assert!(err.starts_with("INVALID_SERVER"), "{err}");

        let err = tauri::async_runtime::block_on(bblog_publish(
            "127.0.0.1:1".into(),
            "  ".into(),
            "c".into(),
            "t".into(),
            "f.md".into(),
            "body".into(),
        ))
        .expect_err("empty token");
        assert!(err.starts_with("NO_TOKEN"), "{err}");

        for (category, topic) in [("", "t"), ("c", ""), ("  ", "  ")] {
            let err = tauri::async_runtime::block_on(bblog_publish(
                "127.0.0.1:1".into(),
                "tok".into(),
                category.into(),
                topic.into(),
                "f.md".into(),
                "body".into(),
            ))
            .expect_err("empty target");
            assert!(err.starts_with("INVALID_TARGET"), "{err}");
        }
    }
}
