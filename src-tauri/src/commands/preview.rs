//! Inline HTML previews of the agent panel.
//!
//! An `html` code block in an agent reply renders as a sandboxed iframe. The
//! framed document cannot come from `srcdoc`, `blob:` or `data:`: the packaged
//! CSP is `script-src 'self' blob:` (no `unsafe-inline`) and WebKit inherits
//! the parent policy into every document loaded from a *local* scheme --
//! measured in an offscreen WKWebView, an inline `<script>` inside those frames
//! is blocked with no error anywhere, which leaves every interactive demo dead.
//!
//! A custom scheme is the way out: `agent-preview://localhost/<id>` is not a
//! local scheme, so the framed document carries no inherited policy and its
//! inline scripts run. It still cannot reach the app: the iframe is rendered
//! with `sandbox="allow-scripts"` and without `allow-same-origin`, so the page
//! gets an opaque origin -- no access to the main document, the vault or IPC.
//!
//! The store is in-memory and bounded. Preview URLs are derived from a fresh id
//! each time a message renders, so eviction costs at most one reload.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use super::CmdResult;

/// Scheme shared by the iframe URL built here and the handler registered in
/// `lib.rs`.
pub const SCHEME: &str = "agent-preview";

/// How many previews stay addressable; older ids fall out of the store.
const MAX_PREVIEWS: usize = 64;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Documents by id, oldest first; the cap evicts from the front. A Vec keeps
/// the static const-constructible and a linear scan over ≤64 entries is free.
static STORE: Mutex<Vec<(u64, String)>> = Mutex::new(Vec::new());

/// Stores one preview document and returns the URL the iframe should load.
#[tauri::command]
pub fn agent_preview_put(html: String) -> CmdResult<String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut store = STORE.lock().unwrap_or_else(|e| e.into_inner());
    store.push((id, html));
    while store.len() > MAX_PREVIEWS {
        store.remove(0);
    }
    Ok(format!("{SCHEME}://localhost/{id}"))
}

/// The `agent-preview` protocol handler: `/<id>` serves the stored document.
pub fn serve(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, HeaderValue, StatusCode};

    let html = request
        .uri()
        .path()
        .trim_start_matches('/')
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .and_then(|id| {
            let store = STORE.lock().unwrap_or_else(|e| e.into_inner());
            store
                .iter()
                .rev()
                .find(|(stored, _)| *stored == id)
                .map(|(_, html)| html.clone())
        });
    let mut response = match html {
        Some(html) => {
            let mut response = tauri::http::Response::new(html.into_bytes());
            *response.status_mut() = StatusCode::OK;
            if let Ok(value) = HeaderValue::from_str("text/html; charset=utf-8") {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            response
        }
        None => {
            let mut response = tauri::http::Response::new(b"preview not found".to_vec());
            *response.status_mut() = StatusCode::NOT_FOUND;
            if let Ok(value) = HeaderValue::from_str("text/plain; charset=utf-8") {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            response
        }
    };
    if let Ok(value) = HeaderValue::from_str("no-store") {
        response.headers_mut().insert(header::CACHE_CONTROL, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_serve_and_eviction_round_trip() {
        // One sequential test: the tests share the static store, and parallel
        // runs would evict each other's ids.
        let html = "<p>hello</p>";
        let url = agent_preview_put(html.to_string()).expect("put");
        let prefix = format!("{SCHEME}://localhost/");
        let id = url.strip_prefix(&prefix).expect("scheme prefix");

        let request = tauri::http::Request::builder()
            .uri(format!("{SCHEME}://localhost/{id}"))
            .body(Vec::new())
            .expect("request");
        let response = serve(&request);
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.body().as_slice(), html.as_bytes());

        for i in 0..(MAX_PREVIEWS + 5) {
            agent_preview_put(format!("<p>{i}</p>")).expect("put");
        }
        let store = STORE.lock().unwrap_or_else(|e| e.into_inner());
        assert!(store.len() <= MAX_PREVIEWS);
        drop(store);
        // The round-tripped id has been evicted by the flood above.
        assert_eq!(serve(&request).status(), tauri::http::StatusCode::NOT_FOUND);

        let bad = tauri::http::Request::builder()
            .uri(format!("{SCHEME}://localhost/not-a-number"))
            .body(Vec::new())
            .expect("request");
        assert_eq!(serve(&bad).status(), tauri::http::StatusCode::NOT_FOUND);
    }
}
