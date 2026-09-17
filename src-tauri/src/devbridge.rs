//! Debug-only loopback HTTP bridge, so the frontend can run in a plain browser
//! against the **real** vault.
//!
//! Why this exists: the app UI has to be inspectable without touching the
//! desktop window (screenshots of the window steal the screen, and macOS has no
//! WebDriver for WKWebView — `tauri-driver` supports Windows and Linux only).
//! The page Vite serves at :1430 is the very same build the window loads, so a
//! browser tab renders identically; what it lacks is `window.__TAURI_INTERNALS__`
//! and there is no HTTP backend behind it. This module supplies one by
//! forwarding `{cmd, args}` to the same `#[tauri::command]` functions the
//! webview calls — one implementation, no drift.
//!
//! The frontend half is `src/dev/browserMode.ts` (installs the official
//! `@tauri-apps/api/mocks` interceptors and points them here); Vite proxies
//! `/__dev/*` to this port so the page never issues a cross-origin request.
//!
//! Deliberately refused here:
//!
//! - `show_study_preview` / `set_study_preview_bounds` /
//!   `set_study_preview_visible` / `close_study_preview` / `open_study_url` —
//!   these create native child webviews and windows inside the real app. A
//!   browser tab triggering them would put a native view in someone else's
//!   window.
//! - the IME commands — they change the machine's input source. A browser tab's
//!   focus says nothing about the app window's focus, so driving the system
//!   keyboard from it is wrong. They answer with benign no-ops.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Listener, Manager};

use crate::agent::tools::StudyContent;
use crate::commands::{agent, config, files, vault};
use crate::state::AppState;

/// Fixed port; `vite.config.ts` proxies `/__dev` here.
const PORT: u16 = 1439;

/// SSE subscribers (browser tabs listening for backend events).
static SUBSCRIBERS: Mutex<Vec<Sender<String>>> = Mutex::new(Vec::new());

/// Starts the bridge. Failures are logged, never fatal: the app must come up
/// even if the port is taken (a stale instance, another checkout).
pub fn spawn(app: AppHandle) {
    subscribe_events(&app);
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[bnote] devbridge: cannot bind 127.0.0.1:{} — {}", PORT, e);
                return;
            }
        };
        eprintln!("[bnote] devbridge: http://127.0.0.1:{} (browser preview)", PORT);
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let app = app.clone();
            std::thread::spawn(move || handle(app, stream));
        }
    });
}

/// Forwards backend events to every connected browser tab.
fn subscribe_events(app: &AppHandle) {
    for name in ["vault-changed", "agent-event", "ime-fallback"] {
        let label = name.to_string();
        app.listen(name, move |event| {
            let frame = format!("event: {}\ndata: {}\n\n", label, event.payload());
            SUBSCRIBERS
                .lock()
                .map(|mut subs| subs.retain(|tx| tx.send(frame.clone()).is_ok()))
                .ok();
        });
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn handle(app: AppHandle, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(peek) = stream.try_clone() else { return };
    let mut reader = BufReader::new(peek);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();

    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 {
            break;
        }
        if header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((key, value)) = header.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body).is_err() {
        return;
    }

    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    match (method.as_str(), path) {
        ("OPTIONS", _) => respond_empty(&stream, "204 No Content"),
        ("POST", "/__dev/invoke") => invoke(&app, &stream, &body),
        ("GET", "/__dev/asset") => asset(&app, &stream, query),
        ("GET", "/__dev/events") => events(stream),
        _ => respond(&stream, "404 Not Found", "text/plain", path.as_bytes()),
    }
}

fn respond(stream: &TcpStream, status: &str, ctype: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut stream = stream;
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn respond_empty(stream: &TcpStream, status: &str) {
    respond(stream, status, "text/plain", b"");
}

// ---------------------------------------------------------------------------
// /__dev/invoke
// ---------------------------------------------------------------------------

/// `Ok(v)` → JSON body; `Err(e)` → the command's error string as the body.
macro_rules! json_ok {
    ($e:expr) => {
        serde_json::to_value($e?).map_err(|e| format!("SERIALIZE_FAILED: {}", e))?
    };
}

fn invoke(app: &AppHandle, stream: &TcpStream, body: &[u8]) {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            return respond(
                stream,
                "400 Bad Request",
                "text/plain",
                format!("BAD_REQUEST: {}", e).as_bytes(),
            )
        }
    };
    let cmd = parsed.get("cmd").and_then(Value::as_str).unwrap_or("");
    let args = parsed.get("args").cloned().unwrap_or(Value::Null);

    match tauri::async_runtime::block_on(dispatch(app, cmd, &args)) {
        Ok(value) => respond(stream, "200 OK", "application/json", value.to_string().as_bytes()),
        Err(e) => respond(stream, "400 Bad Request", "text/plain", e.as_bytes()),
    }
}

async fn dispatch(app: &AppHandle, cmd: &str, args: &Value) -> Result<Value, String> {
    let value = match cmd {
        // ---- vault ----
        "set_vault" => json_ok!(vault::set_vault(app.clone(), app.state(), arg_str(args, "path")?)),
        "get_vault" => json_ok!(vault::get_vault(app.state())),
        "read_tree" => json_ok!(vault::read_tree(app.state()).await),
        "read_dir" => json_ok!(vault::read_dir(app.state(), arg_str(args, "relPath")?).await),
        "list_files" => json_ok!(vault::list_files(app.state()).await),

        // ---- files ----
        "read_file" => json_ok!(files::read_file(app.state(), arg_str(args, "path")?).await),
        "write_file" => json_ok!(
            files::write_file(app.state(), arg_str(args, "path")?, arg_str(args, "contents")?).await
        ),
        "create_file" => json_ok!(
            files::create_file(
                app.state(),
                arg_str(args, "parent")?,
                arg_str(args, "name")?
            )
            .await
        ),
        "create_dir" => json_ok!(
            files::create_dir(
                app.state(),
                arg_str(args, "parent")?,
                arg_str(args, "name")?
            )
            .await
        ),
        "ensure_dir" => json_ok!(files::ensure_dir(app.state(), arg_str(args, "relPath")?).await),
        "rename_path" => json_ok!(
            files::rename_path(
                app.state(),
                arg_str(args, "path")?,
                arg_str(args, "newName")?
            )
            .await
        ),
        "trash_path" => json_ok!(files::trash_path(app.state(), arg_str(args, "path")?).await),
        "read_vault_file" => json_ok!(files::read_vault_file(app.state(), arg_str(args, "name")?).await),
        "write_vault_file" => json_ok!(
            files::write_vault_file(
                app.state(),
                arg_str(args, "name")?,
                arg_str(args, "contents")?
            )
            .await
        ),

        // ---- config ----
        "load_app_config" => json_ok!(config::load_app_config(app.state())),
        "save_app_config" => json_ok!(config::save_app_config(app.state(), arg_value(args, "config")?)),
        "load_keybindings" => json_ok!(config::load_keybindings(app.state())),
        "save_keybindings" => {
            json_ok!(config::save_keybindings(app.state(), arg_value(args, "keybindings")?))
        }
        "read_vimrc" => json_ok!(config::read_vimrc(app.state())),
        "save_vimrc" => json_ok!(config::save_vimrc(app.state(), arg_str(args, "contents")?)),

        // ---- input sources: refuse to touch the machine's keyboard ----
        "list_input_sources" => json!([]),
        "get_current_input_source" => json!(""),
        "set_input_source" => json!({ "switched": false, "fallbackUsed": false }),

        // ---- agent ----
        "agent_get_config" => json_ok!(agent::agent_get_config(app.state())),
        "agent_save_config" => json_ok!(agent::agent_save_config(
            app.state(),
            serde_json::from_value(arg_value(args, "config")?)
                .map_err(|e| format!("BAD_ARGS: config: {}", e))?
        )),
        "agent_start_session" => {
            let study: Option<StudyContent> = serde_json::from_value(arg_value(args, "study")?)
                .map_err(|e| format!("BAD_ARGS: study: {}", e))?;
            json_ok!(agent::agent_start_session(app.clone(), app.state(), study).await)
        }
        "agent_send" => json_ok!(
            agent::agent_send(
                app.state(),
                arg_str(args, "sessionId")?,
                arg_str(args, "text")?
            )
            .await
        ),
        "agent_abort" => json_ok!(agent::agent_abort(app.state(), arg_str(args, "sessionId")?)),
        "agent_get_history" => {
            json_ok!(agent::agent_get_history(app.state(), arg_str(args, "sessionId")?))
        }
        "agent_set_current_note" => json_ok!(agent::agent_set_current_note(
            app.state(),
            arg_opt_str(args, "path")
        )),
        "convert_pdf_to_markdown" => json_ok!(
            agent::convert_pdf_to_markdown(
                app.state(),
                arg_str(args, "pdfPath")?,
                arg_str(args, "folderRel")?
            )
            .await
        ),

        // ---- native views: no browser equivalent ----
        "show_study_preview" | "set_study_preview_bounds" | "set_study_preview_visible"
        | "close_study_preview" | "open_study_url" => {
            return Err(format!(
                "BROWSER_MODE: `{}` creates a native webview/window in the app — not available from a browser tab",
                cmd
            ))
        }

        other => return Err(format!("UNKNOWN_COMMAND: {}", other)),
    };
    Ok(value)
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("BAD_ARGS: `{}` is not a string", key))
}

fn arg_opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn arg_value(args: &Value, key: &str) -> Result<Value, String> {
    args.get(key)
        .cloned()
        .ok_or_else(|| format!("BAD_ARGS: `{}` is missing", key))
}

// ---------------------------------------------------------------------------
// /__dev/asset — the browser's stand-in for `asset://localhost/…`
// ---------------------------------------------------------------------------

/// Serves a file from the open vault or the app data dir (nothing else — this
/// port is unauthenticated loopback).
fn asset(app: &AppHandle, stream: &TcpStream, query: &str) {
    let Some(raw) = query_param(query, "p") else {
        return respond(stream, "400 Bad Request", "text/plain", b"MISSING p");
    };
    let path = std::path::PathBuf::from(raw);

    let state = app.state::<AppState>();
    let allowed = state.vault().map(|v| crate::commands::ensure_within(&v, &path).is_ok())
        == Some(true)
        || crate::commands::ensure_within(&state.data_dir(), &path).is_ok();
    if !allowed {
        return respond(stream, "403 Forbidden", "text/plain", b"OUTSIDE_VAULT");
    }

    match std::fs::read(&path) {
        Ok(bytes) => respond(stream, "200 OK", mime_of(&path), &bytes),
        Err(e) => respond(
            stream,
            "404 Not Found",
            "text/plain",
            format!("READ_FAILED: {}", e).as_bytes(),
        ),
    }
}

fn mime_of(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// `a=1&p=%2Ftmp%2Fx` → the value of `p`, percent-decoded.
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

/// Decodes `%XX` — `encodeURIComponent` output, so `+` stays a literal plus.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// /__dev/events — SSE, the browser's stand-in for `listen()`
// ---------------------------------------------------------------------------

fn events(mut stream: TcpStream) {
    let (tx, rx) = channel::<String>();
    if SUBSCRIBERS.lock().map(|mut s| s.push(tx)).is_err() {
        return;
    }
    // Chunked, not `Connection: keep-alive` with no length: Vite's dev proxy
    // buffers a body it cannot size and never forwards a byte (measured: 0
    // bytes through :1430, headers delivered when hitting :1439 directly).
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\
                Access-Control-Allow-Origin: *\r\nTransfer-Encoding: chunked\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();
    for frame in rx {
        let chunk = format!("{:x}\r\n{}\r\n", frame.len(), frame);
        if stream.write_all(chunk.as_bytes()).is_err() {
            break;
        }
        let _ = stream.flush();
    }
}
