//! bblog 客户端命令:发布对话框拉栏目树、上传 HTML/Markdown 文章。
//!
//! 认证信息(vault 的 `.bnote/bblog/auth.json`)由前端读取后作为参数传入,
//! 这里不落任何秘密;上传走 `Authorization: Bearer <token>`,对应 bblog
//! `/api/upload` 的机器令牌通道。

use super::CmdResult;
use serde_json::Value;

/// 规范化服务器地址:去空白、去末尾斜杠;没有 scheme 时默认 http://
/// (bblog 部署在无域名的 IP 上,https 需用户显式写明)。
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
