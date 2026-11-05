//! Generic LSP client: one language server process + one document table.
//!
//! The only difference from the Python chain embedded in markdown is the
//! **document model**: here a document is a real file (its URI points at a path
//! on disk), not a virtual document assembled inside markdown. Everything else
//! (framing, request pairing, timeouts, stopping the server) is the same, so
//! there is only this one implementation.
//!
//! "How a message coming from the server is handled" is left to the implementor
//! ([`LspSink`]): the Python diagnostic event carries an `mdPath`, the code
//! project one carries a project-relative path; the reply to
//! `workspace/configuration` differs as well. The transport layer knows none of
//! these differences, and should not.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;

use super::{frame_message, BoxFuture};

/// Handshake timeout: when the server cannot start (wrong path, missing
/// dependency) the UI must not hang.
pub const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound for an interactive request such as completion / hover; on
/// timeout it is given up on, so the UI never waits for nothing.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// What it takes to start a language server.
#[derive(Clone, Debug, Default)]
pub struct ServerSpec {
    /// The language id (typescript / rust / go / python …): it becomes the
    /// languageId in didOpen and doubles as the log prefix.
    pub language_id: String,
    /// The executable name or an absolute path.
    pub command: String,
    /// The startup arguments (most servers need `--stdio`).
    pub args: Vec<String>,
    /// Extra environment variables (they only add to the inherited ones).
    pub env: Vec<(String, String)>,
    /// The working directory; defaults to the project root.
    pub cwd: Option<PathBuf>,
    /// The `initializationOptions` of the initialize request.
    pub initialization_options: Value,
    /// The `workspace/didChangeConfiguration` sent after initialize:
    /// `(section, value)`. An empty section means the whole settings is value.
    pub settings: Option<(String, Value)>,
    /// Whether to pull `textDocument/diagnostic` after a didChange. Servers
    /// that push diagnostics do not need it; ty only speaks pull.
    pub pull_diagnostics: bool,
}

impl ServerSpec {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            ..Default::default()
        }
    }
}

/// How a message coming from the server is handled.
pub trait LspSink: Send + Sync + 'static {
    /// Handles one message from the server. The read loop awaits the returned
    /// future.
    fn on_message<'a>(&'a self, client: &'a LspClient, msg: Value) -> BoxFuture<'a, ()>;
}

/// One language server process.
pub struct LspClient {
    /// The language id (typescript / rust / go / python …), also the log prefix.
    pub language_id: String,
    /// The project root: the rootUri of initialize and the working directory.
    pub project_root: PathBuf,
    child: AsyncMutex<tokio::process::Child>,
    stdin: AsyncMutex<tokio::process::ChildStdin>,
    next_id: AtomicU64,
    /// uri → the version of the document already pushed (counted up from 0 after
    /// didOpen).
    pub docs: Mutex<HashMap<String, u32>>,
    /// Serializes the document operations so that concurrent open/change calls
    /// cannot interleave.
    doc_ops: AsyncMutex<()>,
    pub alive: AtomicBool,
    /// The unanswered requests: request id → oneshot.
    pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>,
}

impl LspClient {
    /// Starts the process and the read loop. The caller awaits the handshake
    /// right after it gets the instance; on failure the process is reclaimed
    /// together with kill_on_drop.
    pub async fn spawn(
        spec: &ServerSpec,
        project_root: PathBuf,
        sink: Arc<dyn LspSink>,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = tokio::process::Command::new(&spec.command);
        cmd.args(&spec.args)
            .current_dir(spec.cwd.clone().unwrap_or_else(|| project_root.clone()))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("LSP_SPAWN_FAILED: {} — {}", spec.command, e))?;
        let stdin = child.stdin.take().ok_or("LSP_PIPE: no stdin")?;
        let stdout = child.stdout.take().ok_or("LSP_PIPE: no stdout")?;
        let stderr = child.stderr.take().ok_or("LSP_PIPE: no stderr")?;

        let client = Arc::new(Self {
            language_id: spec.language_id.clone(),
            project_root,
            child: AsyncMutex::new(child),
            stdin: AsyncMutex::new(stdin),
            next_id: AtomicU64::new(1),
            docs: Mutex::new(HashMap::new()),
            doc_ops: AsyncMutex::new(()),
            alive: AtomicBool::new(true),
            pending: Mutex::new(HashMap::new()),
        });

        // Drain stderr: not draining it blocks the server on a full pipe.
        let language_id = spec.language_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => eprint!("[lsp:{}:stderr] {}", language_id, line),
                }
            }
        });

        // The read loop: parse frames → dispatch. The loop works on its own
        // clone, `client` itself stays with the caller.
        let loop_client = client.clone();
        tauri::async_runtime::spawn(async move {
            let client = loop_client;
            let mut reader = BufReader::new(stdout);
            loop {
                let mut length: Option<usize> = None;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => {
                            client.alive.store(false, Ordering::Relaxed);
                            sink.on_message(
                                &client,
                                json!({ "method": "$bnote/serverExit", "params": {} }),
                            )
                            .await;
                            return;
                        }
                        Ok(_) => {
                            let trimmed = line.trim_end();
                            if trimmed.is_empty() {
                                break; // an empty line ends the header
                            }
                            if let Some(v) = super::content_length_of(trimmed) {
                                length = Some(v);
                            }
                        }
                    }
                }
                let len = match length {
                    Some(l) => l,
                    None => continue, // a frame without Content-Length can only be dropped
                };
                let mut buf = vec![0u8; len];
                if reader.read_exact(&mut buf).await.is_err() {
                    client.alive.store(false, Ordering::Relaxed);
                    break;
                }
                let msg: Value = match serde_json::from_slice(&buf) {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("[bnote] lsp: bad frame: {}", e);
                        continue;
                    }
                };
                dispatch(&client, &sink, msg).await;
            }
        });

        Ok(client)
    }

    /// Writes one message (an LSP frame on stdio).
    pub async fn send(&self, msg: Value) -> Result<(), String> {
        let bytes = frame_message(&msg)?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("LSP_WRITE: {}", e))?;
        stdin.flush().await.map_err(|e| format!("LSP_WRITE: {}", e))
    }

    /// Sends a notification (no id).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn send_request(&self, id: u64, method: &str, params: Value) -> Result<(), String> {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await
    }

    /// Sends a request and waits for the reply. Ordering contract: reserve the
    /// slot in `pending` before sending — the read loop is an independent task
    /// and the reply may arrive before this task is scheduled again, so
    /// registering after the send would lose it.
    pub async fn request_await(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.alloc_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "lock poisoned")?
            .insert(id, tx);
        if let Err(e) = self.send_request(id, method, params).await {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err("LSP_DIED: 服务器在请求期间退出".to_string()),
            Err(_) => {
                // A timeout drops the slot, otherwise every timeout leaks one
                // entry.
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!("LSP_TIMEOUT: {} 超时", method))
            }
        }
    }

    /// Sends a request **without waiting for the result**: returns the request
    /// id, and the caller maps that id to where the reply belongs (a pulled
    /// diagnostic is exactly that — its reply goes to the front end through
    /// the notification channel).
    pub async fn request_detached(&self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.alloc_id();
        self.send_request(id, method, params).await?;
        Ok(id)
    }

    /// An interactive request (completion / hover / definition): the whitelist
    /// lives in the command layer, `textDocument.uri` is injected by the
    /// caller, and the front end only supplies the position.
    pub async fn interaction_request(
        &self,
        method: &str,
        mut params: Value,
    ) -> Result<Value, String> {
        if !params.is_object() {
            params = json!({});
        }
        self.request_await(method, params, REQUEST_TIMEOUT).await
    }

    /// The initialize handshake + the initialized notification + the optional
    /// initial configuration. Returns the server capabilities (kept for feature
    /// detection).
    pub async fn initialize(&self, spec: &ServerSpec) -> Result<Value, String> {
        let result = self
            .request_await(
                "initialize",
                json!({
                    "processId": null,
                    "rootUri": super::path_to_uri(&self.project_root),
                    "workspaceFolders": [{
                        "uri": super::path_to_uri(&self.project_root),
                        "name": self.project_root.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default(),
                    }],
                    "capabilities": {
                        "textDocument": {
                            "completion": { "completionItem": { "snippetSupport": true } },
                            "hover": { "contentFormat": ["markdown", "plaintext"] },
                            "publishDiagnostics": { "relatedInformation": true },
                        },
                        "workspace": { "workspaceFolders": true },
                    },
                    "initializationOptions": spec.initialization_options,
                    "clientInfo": { "name": "bnote", "version": "0.1.0" },
                }),
                INITIALIZE_TIMEOUT,
            )
            .await?;
        self.notify("initialized", json!({})).await?;
        if let Some((section, value)) = &spec.settings {
            let settings = if section.is_empty() {
                value.clone()
            } else {
                json!({ section.clone(): value.clone() })
            };
            self.notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": settings }),
            )
            .await?;
        }
        Ok(result)
    }

    /// Opens a document (a real file and a virtual document are the same here:
    /// URI + language + content).
    pub async fn did_open(&self, uri: &str, language_id: &str, text: &str) -> Result<(), String> {
        let _guard = self.doc_ops.lock().await;
        self.docs
            .lock()
            .map_err(|_| "lock poisoned")?
            .insert(uri.to_string(), 0);
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": 0,
                    "text": text,
                }
            }),
        )
        .await
    }

    /// A full didChange; the version number is incremented monotonically here,
    /// so the caller need not keep its own counter.
    pub async fn did_change(&self, uri: &str, text: &str) -> Result<(), String> {
        let _guard = self.doc_ops.lock().await;
        let version = {
            let mut docs = self.docs.lock().map_err(|_| "lock poisoned")?;
            let entry = docs.entry(uri.to_string()).or_insert(0);
            *entry += 1;
            *entry
        };
        self.notify(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri, "version": version },
                "contentChanges": [{ "text": text }],
            }),
        )
        .await
    }

    pub async fn did_close(&self, uri: &str) -> Result<(), String> {
        let _guard = self.doc_ops.lock().await;
        self.docs.lock().map_err(|_| "lock poisoned")?.remove(uri);
        self.notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": uri } }),
        )
        .await
    }

    /// Stops the server: an exit notification first, then a hard kill after
    /// 300ms (the graceful exit is never waited for).
    pub fn stop(self: &Arc<Self>) {
        if !self.alive.swap(false, Ordering::Relaxed) {
            return;
        }
        let srv = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = srv.notify("exit", Value::Null).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let _ = srv.child.lock().await.start_kill();
        });
    }
}

/// The dispatch of the read loop.
///
/// The replies to the requests we initiated ourselves (the ones waiting in
/// `pending`) are paired here; every other message (notifications, requests
/// the server initiates, and the replies to our own detached requests) goes to
/// the sink.
async fn dispatch<'a>(client: &'a Arc<LspClient>, sink: &'a Arc<dyn LspSink>, msg: Value) {
    let id = msg.get("id").cloned();
    let method = msg
        .get("method")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    match (id, method) {
        // A server → client request: the reply content depends on the server,
        // so it goes to the sink.
        (Some(_), Some(_)) => sink.on_message(client, msg).await,
        // A reply to one of our requests: pair the oneshot. An unmatched one
        // (e.g. the pull diagnostic of Python) falls through to the sink.
        (Some(id), None) => {
            let mut handled = false;
            if let Some(id_num) = id.as_u64() {
                if let Ok(mut pending) = client.pending.lock() {
                    if let Some(tx) = pending.remove(&id_num) {
                        let _ = tx.send(msg.get("result").cloned().unwrap_or(Value::Null));
                        handled = true;
                    }
                }
            }
            if !handled {
                sink.on_message(client, msg).await;
            }
        }
        // A notification.
        (None, Some(_)) => sink.on_message(client, msg).await,
        _ => {}
    }
}

/// Turns one diagnostic (a standard LSP Diagnostic) into the shape the front
/// end wants.
///
/// The LSP range counts UTF-16 code units, and CodeMirror in the front end
/// counts UTF-16 code units as well (CodeMirror positions are UTF-16 based), so
/// line/character are passed through unchanged; both are 0-based and the front
/// end adds 1 where it needs 1-based values.
pub fn diagnostic_to_json(d: &Value) -> Value {
    let severity = d.get("severity").and_then(Value::as_u64).unwrap_or(1);
    let range = d.get("range").cloned().unwrap_or(Value::Null);
    json!({
        "range": range,
        "severity": severity,
        "code": d.get("code").cloned().unwrap_or(Value::Null),
        "source": d.get("source").cloned().unwrap_or(Value::Null),
        "message": d.get("message").and_then(Value::as_str).unwrap_or(""),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_shape_is_flat_and_has_message() {
        let d = json!({
            "range": {
                "start": { "line": 3, "character": 5 },
                "end": { "line": 3, "character": 9 },
            },
            "severity": 2,
            "message": "expected `;`",
            "source": "rustc",
        });
        let out = diagnostic_to_json(&d);
        assert_eq!(out["severity"], 2);
        assert_eq!(out["message"], "expected `;`");
        assert_eq!(out["source"], "rustc");
        assert_eq!(out["range"]["start"]["line"], 3);
        assert_eq!(out["range"]["start"]["character"], 5);
    }

    #[test]
    fn diagnostic_without_optional_fields_still_has_message() {
        let d = json!({ "range": { "start": {"line":0,"character":0}, "end": {"line":0,"character":1} } });
        let out = diagnostic_to_json(&d);
        assert_eq!(out["message"], "");
        assert_eq!(out["severity"], 1);
        assert!(out["code"].is_null());
    }
}
