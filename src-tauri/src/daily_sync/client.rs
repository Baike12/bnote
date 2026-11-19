//! The long-lived sync connection: one SSE subscription to the b-todo server
//! per (server, key) pair, plus the REST push/pull helpers the commands call.
//!
//! The manager owns the connection like `TermManager` owns the terminals: the
//! task runs on the tokio runtime, reports through Tauri events
//! (`daily-sync-status` / `daily-sync-day`), and survives until `disconnect`
//! aborts it. Everything network happens here because the webview's CSP only
//! allows `self` + IPC — the frontend can never open this socket itself.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::Emitter;

use super::crypto;
use hkdf::Hkdf;
use sha2::Sha256;

/// Reconnect backoff bounds. The heartbeat keeps the proxy happy; a dead
/// network surfaces as a read error within seconds, and we retry patiently
/// instead of hammering.
const RECONNECT_MIN_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;

/// The active subscription. `fingerprint` dedupes `connect` calls with the
/// same (server, key) — the settings page re-saves on every keystroke batch,
/// and each save must not tear down a healthy stream.
pub struct SyncSession {
    pub abort: Arc<AtomicBool>,
    pub fingerprint: u64,
    pub server: String,
    pub last_seq: Arc<AtomicI64>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for SyncSession {
    fn drop(&mut self) {
        self.abort.store(true, Ordering::SeqCst);
        self.handle.abort();
    }
}

/// Owns the at-most-one active sync session. Stored in `AppState`.
#[derive(Default)]
pub struct SyncManager {
    session: Mutex<Option<SyncSession>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub connected: bool,
    pub server: Option<String>,
    pub last_seq: Option<i64>,
}

impl SyncManager {
    pub fn status(&self) -> SyncStatus {
        match self.session.lock().ok().as_ref().and_then(|g| g.as_ref()) {
            Some(s) => SyncStatus {
                connected: !s.abort.load(Ordering::SeqCst),
                server: Some(s.server.clone()),
                last_seq: Some(s.last_seq.load(Ordering::SeqCst)).filter(|v| *v >= 0),
            },
            None => SyncStatus {
                connected: false,
                server: None,
                last_seq: None,
            },
        }
    }

    /// Starts (or replaces) the SSE session. Returns false when the same
    /// (server, key) is already running, so the caller can skip the toast.
    pub fn connect(
        &self,
        app: tauri::AppHandle,
        server: String,
        key: String,
        device_id: String,
    ) -> bool {
        let fingerprint = fingerprint(&server, &key);
        {
            let guard = self.session.lock().expect("sync manager lock");
            if let Some(current) = guard.as_ref() {
                if current.fingerprint == fingerprint && !current.abort.load(Ordering::SeqCst) {
                    return false;
                }
            }
        }
        // Drop first (Drop aborts the task), then start the replacement.
        if let Some(old) = self.session.lock().expect("sync manager lock").take() {
            drop(old);
        }
        let abort = Arc::new(AtomicBool::new(false));
        let last_seq = Arc::new(AtomicI64::new(-1));
        let session = SyncSession {
            abort: abort.clone(),
            fingerprint,
            server: server.clone(),
            last_seq: last_seq.clone(),
            handle: tauri::async_runtime::spawn(event_loop(
                app, server, key, device_id, abort, last_seq,
            )),
        };
        *self.session.lock().expect("sync manager lock") = Some(session);
        true
    }

    pub fn disconnect(&self) {
        if let Some(session) = self.session.lock().expect("sync manager lock").take() {
            drop(session); // Drop aborts the task
        }
    }
}

fn fingerprint(server: &str, key: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    server.hash(&mut h);
    key.hash(&mut h);
    h.finish()
}

async fn event_loop(
    app: tauri::AppHandle,
    server: String,
    key: String,
    _device_id: String,
    abort: Arc<AtomicBool>,
    last_seq: Arc<AtomicI64>,
) {
    let token = crypto::auth_token(&key);
    // No total timeout here: reqwest's `timeout` is a hard deadline on the
    // WHOLE response body, which for an endless SSE stream would kill the
    // connection every 30s. Dead-network detection relies on the OS TCP layer
    // plus the server's 25s heartbeat instead.
    let client = reqwest::Client::builder()
        .build()
        .expect("reqwest client with static config");
    let mut backoff = RECONNECT_MIN_MS;
    emit_status(&app, &server, false, "连接中");

    loop {
        if abort.load(Ordering::SeqCst) {
            return;
        }
        let mut request = client
            .get(format!("{server}/api/events"))
            .header("Accept", "text/event-stream")
            .bearer_auth(&token);
        let cursor = last_seq.load(Ordering::SeqCst);
        if cursor >= 0 {
            request = request.header("Last-Event-ID", cursor.to_string());
        }
        match request.send().await {
            Err(e) => {
                emit_status(&app, &server, false, &format!("连接失败: {e}"));
            }
            Ok(resp) if !resp.status().is_success() => {
                emit_status(
                    &app,
                    &server,
                    false,
                    &format!("服务器拒绝({})", resp.status()),
                );
                // A rejected key does not heal by retrying faster; park long.
                backoff = RECONNECT_MAX_MS;
            }
            Ok(resp) => {
                backoff = RECONNECT_MIN_MS;
                emit_status(&app, &server, true, "已连接");
                match read_stream(resp, |frame| {
                    if abort.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Some(event) = parse_frame(&frame) {
                        last_seq.store(event.seq, Ordering::SeqCst);
                        emit_day(&app, &key, event);
                    }
                })
                .await
                {
                    Ok(()) => emit_status(&app, &server, false, "连接断开"),
                    Err(e) => emit_status(&app, &server, false, &format!("读取失败: {e}")),
                }
            }
        }
        // Exponential backoff with a plain sleep: the abort flag is checked at
        // the top of the loop, so a stop request cuts the wait short at the
        // next check; 30s max keeps a reconnect attempt from outliving quit.
        for _ in 0..(backoff / 100) {
            if abort.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        backoff = (backoff * 2).min(RECONNECT_MAX_MS);
    }
}

fn emit_status(app: &tauri::AppHandle, server: &str, connected: bool, detail: &str) {
    let _ = app.emit(
        "daily-sync-status",
        serde_json::json!({ "server": server, "connected": connected, "detail": detail }),
    );
}

/// One decrypted SSE day event for the frontend.
#[derive(Deserialize)]
struct RawEvent {
    seq: i64,
    #[serde(rename = "kind")]
    _kind: String,
    date: String,
    rev: i64,
    device: String,
    n: String,
    c: String,
}

#[derive(Clone, serde::Serialize)]
struct DayEvent {
    date: String,
    rev: i64,
    device: String,
    content: String,
}

fn emit_day(app: &tauri::AppHandle, key: &str, raw: RawEvent) {
    // Decrypt here so the frontend never touches key material; a broken box
    // (wrong key on the server, corrupted row) is logged once, not crashed on.
    let mut enc = [0u8; 32];
    let hk = Hkdf::<Sha256>::new(Some(crypto::KDF_SALT), key.as_bytes());
    if hk.expand(crypto::ENC_INFO, &mut enc).is_err() {
        return;
    }
    match crypto::open_day(&enc, &raw.date, &raw.n, &raw.c) {
        Ok(content) => {
            let _ = app.emit(
                "daily-sync-day",
                DayEvent {
                    date: raw.date,
                    rev: raw.rev,
                    device: raw.device,
                    content,
                },
            );
        }
        Err(e) => {
            let _ = app.emit(
                "daily-sync-status",
                serde_json::json!({ "server": "", "connected": true, "detail": format!("一天无法解密: {e}") }),
            );
        }
    }
}

/// Parses one SSE frame (`id:` + `data:` lines) into its JSON payload.
fn parse_frame(frame: &str) -> Option<RawEvent> {
    let data = frame
        .lines()
        .find_map(|l| l.strip_prefix("data:"))?
        .trim_start();
    serde_json::from_str(data).ok()
}

/// Reads the SSE body frame by frame (blank-line separated). Returns when the
/// server closes the stream or the network fails.
async fn read_stream(
    resp: reqwest::Response,
    mut on_frame: impl FnMut(&str),
) -> Result<(), String> {
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream: {e}"))?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = find_double_newline(&buf) {
            let frame: Vec<u8> = buf.drain(..pos + 2).collect();
            let text = String::from_utf8_lossy(&frame);
            if !text.trim().is_empty() {
                on_frame(text.trim_end_matches(['\n', '\r']));
            }
        }
    }
    Ok(())
}

/// The server (and our own nginx) terminate frames with `\n\n`; a `\r\n\r\n`
/// variant would need a 4-byte window and a different drain offset, so it is
/// deliberately not guessed at.
fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}
