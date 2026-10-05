//! Debug-only loopback HTTP bridge, so the frontend can run in a plain browser
//! against the **real** vault.
//!
//! Why this exists: the app UI has to be inspectable without touching the
//! desktop window (screenshots of the window steal the screen, and macOS has no
//! WebDriver for WKWebView — `tauri-driver` supports Windows and Linux only).
//! The page Vite serves at :1430 is the very same build the window loads, so a
//! browser tab renders identically; what it lacks is `window.__TAURI_INTERNALS__`
//! and there is no HTTP backend behind it. This module supplies one by
//! forwarding `{cmd, args}` to the same bnote-core functions the webview
//! calls — one implementation, no drift.
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
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bnote_core::agent::tools::StudyContent;
use bnote_core::commands::{agent, config, files, python, vault};
use bnote_core::state::AppState;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

/// Fixed port; `vite.config.ts` proxies `/__dev` here.
const PORT: u16 = 1439;

/// SSE subscribers (browser tabs listening for backend events).
static SUBSCRIBERS: Mutex<Vec<Sender<String>>> = Mutex::new(Vec::new());

/// Starts the bridge. Failures are logged, never fatal: the app must come up
/// even if the port is taken (a stale instance, another checkout).
pub fn spawn(app: AppHandle, rx: tokio::sync::broadcast::Receiver<bnote_core::AppEvent>) {
    subscribe_events(rx);
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

/// Forwards backend events (core's broadcast bus) to every connected browser
/// tab. Polling `try_recv` on a plain thread keeps this debug bridge free of
/// any runtime coupling; sub-100ms latency is fine for dev tooling.
fn subscribe_events(mut rx: tokio::sync::broadcast::Receiver<bnote_core::AppEvent>) {
    std::thread::spawn(move || loop {
        match rx.try_recv() {
            Ok(ev) => {
                let frame = format!(
                    "event: {}\ndata: {}\n\n",
                    ev.name,
                    ev.payload.to_string()
                );
                SUBSCRIBERS
                    .lock()
                    .map(|mut subs| subs.retain(|tx| tx.send(frame.clone()).is_ok()))
                    .ok();
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                eprintln!("[bnote] devbridge: dropped {} events", n);
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => return,
        }
    });
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

    let state = app.state::<Arc<AppState>>();
    match dispatch(&state, cmd, &args) {
        Ok(value) => respond(stream, "200 OK", "application/json", value.to_string().as_bytes()),
        Err(e) => respond(stream, "400 Bad Request", "text/plain", e.as_bytes()),
    }
}

/// Core functions are synchronous and blocking. This runs on a per-connection
/// plain thread (not inside any async runtime), so blocking here is fine.
fn dispatch(state: &Arc<AppState>, cmd: &str, args: &Value) -> Result<Value, String> {
    let value = match cmd {
        // ---- vault ----
        "set_vault" => json_ok!(vault::set_vault(state, arg_str(args, "path")?)),
        "get_vault" => json_ok!(vault::get_vault(state)),
        "read_tree" => json_ok!(vault::read_tree(state)),
        "read_dir" => json_ok!(vault::read_dir(state, arg_str(args, "relPath")?)),
        "list_files" => json_ok!(vault::list_files(state)),

        // ---- files ----
        "read_file" => json_ok!(files::read_file(state, arg_str(args, "path")?)),
        "write_file" => json_ok!(
            files::write_file(state, arg_str(args, "path")?, arg_str(args, "contents")?)
        ),
        "write_file_base64" => json_ok!(
            files::write_file_base64(
                state,
                arg_str(args, "path")?,
                arg_str(args, "contentsBase64")?
            )
        ),
        "create_file" => json_ok!(
            files::create_file(
                state,
                arg_str(args, "parent")?,
                arg_str(args, "name")?
            )
        ),
        "create_dir" => json_ok!(
            files::create_dir(
                state,
                arg_str(args, "parent")?,
                arg_str(args, "name")?
            )
        ),
        "ensure_dir" => json_ok!(files::ensure_dir(state, arg_str(args, "relPath")?)),
        "rename_path" => json_ok!(
            files::rename_path(
                state,
                arg_str(args, "path")?,
                arg_str(args, "newName")?
            )
        ),
        "trash_path" => json_ok!(files::trash_path(state, arg_str(args, "path")?)),
        "read_vault_file" => json_ok!(files::read_vault_file(state, arg_str(args, "name")?)),
        "write_vault_file" => json_ok!(
            files::write_vault_file(
                state,
                arg_str(args, "name")?,
                arg_str(args, "contents")?
            )
        ),

        // ---- config ----
        "load_app_config" => json_ok!(config::load_app_config(state)),
        "save_app_config" => {
            json_ok!(config::save_app_config(state, arg_value(args, "config")?))
        }
        "load_keybindings" => json_ok!(config::load_keybindings(state)),
        "save_keybindings" => {
            json_ok!(config::save_keybindings(state, arg_value(args, "keybindings")?))
        }
        "read_vimrc" => json_ok!(config::read_vimrc(state)),
        "save_vimrc" => json_ok!(config::save_vimrc(state, arg_str(args, "contents")?)),

        // ---- input sources: refuse to touch the machine's keyboard ----
        "list_input_sources" => json!([]),
        "get_current_input_source" => json!(""),
        "set_input_source" => json!({ "switched": false, "fallbackUsed": false }),

        // ---- agent ----
        "agent_get_config" => json_ok!(agent::agent_get_config(state)),
        "agent_save_config" => json_ok!(agent::agent_save_config(
            state,
            serde_json::from_value(arg_value(args, "config")?)
                .map_err(|e| format!("BAD_ARGS: config: {}", e))?
        )),
        "agent_start_session" => {
            let study: Option<StudyContent> = serde_json::from_value(arg_value(args, "study")?)
                .map_err(|e| format!("BAD_ARGS: study: {}", e))?;
            json_ok!(agent::agent_start_session(state, study))
        }
        "agent_send" => json_ok!(
            agent::agent_send(
                state,
                arg_str(args, "sessionId")?,
                arg_str(args, "text")?
            )
        ),
        "agent_abort" => json_ok!(agent::agent_abort(state, arg_str(args, "sessionId")?)),
        "agent_get_history" => {
            json_ok!(agent::agent_get_history(state, arg_str(args, "sessionId")?))
        }
        "agent_set_current_note" => json_ok!(agent::agent_set_current_note(
            state,
            arg_opt_str(args, "path")
        )),
        "convert_pdf_to_markdown" => json_ok!(
            agent::convert_pdf_to_markdown(
                state,
                arg_str(args, "pdfPath")?,
                arg_str(args, "folderRel")?
            )
        ),

        // ---- python:嵌入代码块运行 / LSP / uv ----
        "python_run" => json_ok!(
            python::python_run(
                state,
                arg_str(args, "mdPath")?,
                arg_str(args, "code")?
            )
        ),
        "python_run_cancel" => {
            json_ok!(python::python_run_cancel(state, arg_str(args, "mdPath")?))
        }
        "python_get_info" => {
            json_ok!(python::python_get_info(state, arg_str(args, "mdPath")?))
        }
        "python_set_project_config" => json_ok!(
            python::python_set_project_config(
                state,
                arg_str(args, "mdPath")?,
                arg_opt_str(args, "lsp"),
                arg_opt_str(args, "python"),
                arg_opt_str(args, "tyPath"),
            )
        ),
        "python_lsp_sync" => json_ok!(
            python::python_lsp_sync(
                state,
                arg_str(args, "mdPath")?,
                arg_str(args, "text")?
            )
        ),
        "python_lsp_close" => {
            json_ok!(python::python_lsp_close(state, arg_str(args, "mdPath")?))
        }
        "python_lsp_request" => json_ok!(
            python::python_lsp_request(
                state,
                arg_str(args, "mdPath")?,
                arg_str(args, "method")?,
                arg_value(args, "params").unwrap_or_else(|_| serde_json::Value::Null),
            )
        ),
        "python_lsp_stop_all" => json_ok!(python::python_lsp_stop_all(state)),
        "python_uv_create" => {
            json_ok!(python::python_uv_create(state, arg_str(args, "mdPath")?))
        }

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

    let state = app.state::<Arc<AppState>>();
    let allowed = state
        .vault()
        .map(|v| bnote_core::commands::ensure_within(&v, &path).is_ok())
        == Some(true)
        || bnote_core::commands::ensure_within(&state.data_dir(), &path).is_ok();
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
