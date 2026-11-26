//! b-todo sync commands: test the connection, own the SSE session, push and
//! pull encrypted day documents.
//!
//! Credentials arrive as arguments from the frontend (settings live in
//! config.json, the same channel the agent provider keys use), so no secret
//! is stored here; every network call goes through `normalize_server` and the
//! derived auth token — the raw key never appears on the wire.

use std::time::Duration;

use super::CmdResult;
use crate::daily_sync::client::SyncManager;
use serde::Deserialize;

/// A bare host means https: the merged service is only public behind the
/// domain's TLS endpoint. Plain http is kept for localhost development.
fn normalize_server(server: &str) -> Result<String, String> {
    let mut s = server.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err("INVALID_SERVER: 服务器地址为空".into());
    }
    if !s.starts_with("http://") && !s.starts_with("https://") {
        s = format!("https://{s}");
    }
    Ok(s)
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("NO_KEY: 同步密钥为空".into());
    }
    Ok(())
}

fn validate_date(date: &str) -> Result<(), String> {
    let bytes = date.as_bytes();
    let shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| (i == 4 || i == 7) || b.is_ascii_digit());
    if shape {
        Ok(())
    } else {
        Err(format!("INVALID_DATE: {date}"))
    }
}

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_default()
}

/// Derived per request from the user key; the enc key decrypts/encrypts the
/// document bodies.
struct KeyMaterial {
    token: String,
    enc: [u8; 32],
}

fn key_material(key: &str) -> Result<KeyMaterial, String> {
    validate_key(key)?;
    use hkdf::Hkdf;
    use sha2::Sha256;
    let hk = Hkdf::<Sha256>::new(
        Some(crate::daily_sync::crypto::KDF_SALT),
        key.trim().as_bytes(),
    );
    let mut enc = [0u8; 32];
    hk.expand(crate::daily_sync::crypto::ENC_INFO, &mut enc)
        .map_err(|_| "CRYPTO: 密钥派生失败".to_string())?;
    Ok(KeyMaterial {
        token: crate::daily_sync::crypto::auth_token(key),
        enc,
    })
}

/// Tests the (possibly unsaved) form values: GET /api/ping with the derived
/// token, mapping 401 to a key problem instead of a generic failure.
#[tauri::command]
pub async fn sync_test(server: String, key: String) -> CmdResult<String> {
    let base = normalize_server(&server)?;
    let material = key_material(&key)?;
    let url = format!("{base}/api/ping");
    let resp = client(Duration::from_secs(15))
        .get(&url)
        .bearer_auth(&material.token)
        .send()
        .await
        .map_err(|e| format!("NETWORK: 无法连接同步服务器: {e}"))?;
    match resp.status().as_u16() {
        200 => Ok("连接成功".into()),
        401 => Err("AUTH_FAILED: 密钥不正确".into()),
        s => Err(format!("SERVER_ERROR: 服务器返回 {s}")),
    }
}

/// Starts (or re-points) the SSE session; events stream back as
/// `daily-sync-status` / `daily-sync-day`. A second connect with the same
/// (server, key) is a no-op so settings saves never tear down the stream.
#[tauri::command]
pub async fn sync_connect(
    app: tauri::AppHandle,
    manager: tauri::State<'_, SyncManager>,
    server: String,
    key: String,
    device_id: String,
) -> CmdResult<bool> {
    let base = normalize_server(&server)?;
    let material = key_material(&key)?;
    // Reachability is checked once here so a typo surfaces as a command error
    // instead of a silently retrying background loop.
    let resp = client(Duration::from_secs(15))
        .get(format!("{base}/api/ping"))
        .bearer_auth(&material.token)
        .send()
        .await
        .map_err(|e| format!("NETWORK: 无法连接同步服务器: {e}"))?;
    if resp.status().as_u16() == 401 {
        return Err("AUTH_FAILED: 密钥不正确".into());
    }
    if !resp.status().is_success() {
        return Err(format!("SERVER_ERROR: 服务器返回 {}", resp.status()));
    }
    Ok(manager.connect(app, base, key.trim().to_string(), device_id))
}

#[tauri::command]
pub async fn sync_disconnect(manager: tauri::State<'_, SyncManager>) -> CmdResult<()> {
    manager.disconnect();
    Ok(())
}

#[tauri::command]
pub async fn sync_status(
    manager: tauri::State<'_, SyncManager>,
) -> CmdResult<crate::daily_sync::client::SyncStatus> {
    Ok(manager.status())
}

// ---------------------------------------------------------------- push/pull

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushDay {
    pub date: String,
    pub content: String,
    pub base_rev: i64,
    #[serde(default)]
    pub force: bool,
    /// Stamped onto the server event so the sender's own echo can be told
    /// apart from a remote edit; empty means the server records no device.
    #[serde(default)]
    pub device_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub date: String,
    pub ok: bool,
    pub rev: Option<i64>,
    /// Set when the server answered 409: the current plaintext (decrypted
    /// here) the caller merges against.
    pub conflict_rev: Option<i64>,
    pub conflict_content: Option<String>,
    pub error: Option<String>,
}

/// Pushes day documents one PUT per day, sequentially: a diary edit touches
/// one or two days, and the revision gate makes order matter (a conflict
/// resolved against rev N must not race a rev N+1 push of the same day).
#[tauri::command]
pub async fn sync_push_days(
    server: String,
    key: String,
    days: Vec<PushDay>,
) -> CmdResult<Vec<PushResult>> {
    let base = normalize_server(&server)?;
    let material = key_material(&key)?;
    let http = client(Duration::from_secs(30));
    let mut out = Vec::with_capacity(days.len());
    for day in days {
        validate_date(&day.date)?;
        let (nonce, ct) =
            crate::daily_sync::crypto::seal_day(&material.enc, &day.date, &day.content)?;
        let body = serde_json::json!({
            "baseRev": day.base_rev,
            "force": day.force,
            "n": nonce,
            "c": ct,
            "deviceId": day.device_id,
            "deviceName": "bnote",
        });
        let resp = http
            .put(format!("{base}/api/days/{}", day.date))
            .bearer_auth(&material.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("NETWORK: 推送失败: {e}"))?;
        let status = resp.status().as_u16();
        let payload: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("BAD_RESPONSE: 服务器返回的不是 JSON: {e}"))?;
        let mut result = PushResult {
            date: day.date.clone(),
            ok: false,
            rev: None,
            conflict_rev: None,
            conflict_content: None,
            error: None,
        };
        match status {
            200 => {
                result.ok = true;
                result.rev = payload["rev"].as_i64();
            }
            409 => {
                result.conflict_rev = payload["rev"].as_i64();
                if let (Some(n), Some(c)) = (payload["n"].as_str(), payload["c"].as_str()) {
                    result.conflict_content = Some(crate::daily_sync::crypto::open_day(
                        &material.enc,
                        &day.date,
                        n,
                        c,
                    )?);
                }
            }
            401 => result.error = Some("AUTH_FAILED: 密钥不正确".into()),
            s => {
                result.error = Some(format!(
                    "SERVER_ERROR: {}",
                    payload["error"]["message"].as_str().unwrap_or("未知错误")
                ));
                let _ = s;
            }
        }
        out.push(result);
    }
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledDay {
    pub date: String,
    pub rev: i64,
    pub updated_by: String,
    pub updated_at: i64,
    pub content: String,
}

/// Pulls day documents: `None` dates = every stored day (the list endpoint
/// plus one GET each, decrypted here so the frontend handles plaintext only).
#[tauri::command]
pub async fn sync_pull_days(
    server: String,
    key: String,
    dates: Option<Vec<String>>,
) -> CmdResult<Vec<PulledDay>> {
    let base = normalize_server(&server)?;
    let material = key_material(&key)?;
    let http = client(Duration::from_secs(30));

    let wanted: Vec<String> = match dates {
        Some(list) => {
            for d in &list {
                validate_date(d)?;
            }
            list
        }
        None => {
            let resp = http
                .get(format!("{base}/api/days"))
                .bearer_auth(&material.token)
                .send()
                .await
                .map_err(|e| format!("NETWORK: 拉取列表失败: {e}"))?;
            if resp.status().as_u16() == 401 {
                return Err("AUTH_FAILED: 密钥不正确".into());
            }
            let list: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("BAD_RESPONSE: 服务器返回的不是 JSON: {e}"))?;
            list.as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|d| d["date"].as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default()
        }
    };

    let mut out = Vec::with_capacity(wanted.len());
    for date in wanted {
        let resp = http
            .get(format!("{base}/api/days/{date}"))
            .bearer_auth(&material.token)
            .send()
            .await
            .map_err(|e| format!("NETWORK: 拉取 {date} 失败: {e}"))?;
        let status = resp.status().as_u16();
        if status == 404 {
            continue;
        }
        if status == 401 {
            return Err("AUTH_FAILED: 密钥不正确".into());
        }
        if !resp.status().is_success() {
            return Err(format!("SERVER_ERROR: 拉取 {date} 返回 {status}"));
        }
        let doc: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("BAD_RESPONSE: 服务器返回的不是 JSON: {e}"))?;
        let (n, c) = (
            doc["n"].as_str().unwrap_or_default(),
            doc["c"].as_str().unwrap_or_default(),
        );
        let content = crate::daily_sync::crypto::open_day(&material.enc, &date, n, c)?;
        out.push(PulledDay {
            date,
            rev: doc["rev"].as_i64().unwrap_or_default(),
            updated_by: doc["updatedBy"].as_str().unwrap_or_default().to_string(),
            updated_at: doc["updatedAt"].as_i64().unwrap_or_default(),
            content,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_gets_https_and_trailing_slashes_are_dropped() {
        assert_eq!(
            normalize_server("  realbaike.tech/bnote/todo/  ").unwrap(),
            "https://realbaike.tech/bnote/todo"
        );
        assert_eq!(
            normalize_server("http://x.local/b-todo/").unwrap(),
            "http://x.local/b-todo"
        );
        assert!(normalize_server("   ")
            .unwrap_err()
            .starts_with("INVALID_SERVER"));
    }

    #[test]
    fn an_empty_key_is_rejected_before_the_network() {
        assert!(validate_key("  ").unwrap_err().starts_with("NO_KEY"));
    }

    #[test]
    fn dates_are_shape_checked() {
        assert!(validate_date("2026-11-19").is_ok());
        for bad in ["2026-11-1", "2026-1-19", "not-a-date", "2026/11/19"] {
            assert!(validate_date(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn key_material_derives_the_stable_token() {
        let m = key_material("b-todo-golden-key-01").expect("material");
        assert_eq!(m.token, "G/XSdSTZajIoHaHB04oXsZ7uxL4LnMomCH92alVBmUI");
    }
}
