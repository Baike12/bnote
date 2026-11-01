//! The ty language server: the Python embedded in markdown goes through this
//! chain.
//!
//! Document model: the front end joins all the Python fences of the markdown
//! into a "line-aligned virtual file" (as long as the markdown line by line,
//! the non-code lines being empty) and opens it under the file:// URI of the
//! real path of the note. The line and column numbers of the virtual file are
//! exactly those of the markdown, so the diagnostics are forwarded as they are
//! with zero conversion.
//!
//! The transport layer (framing, request pairing, timeouts, stopping the
//! server) is reused from [`crate::lsp::client`]; this module only adds the
//! three things specific to ty: the workspace configuration (the
//! activeEnvironment of ty), the pulled diagnostics (ty only speaks pull and
//! never pushes), and the payload shape of the diagnostic events in the front
//! end.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::lsp::client::{LspClient, LspSink, ServerSpec};
use crate::lsp::{decode_uri_path, path_to_uri, BoxFuture};

use super::{ProjectConfig, ProjectRef};

/// The message handling on the ty side: forwards diagnostics, answers the
/// configuration requests.
///
/// The sink holds the `AppHandle`: the diagnostic events are emitted from here
/// back to the front end.
struct TySink {
    app: tauri::AppHandle,
    /// The workspace configuration ty cares about (activeEnvironment).
    settings: Value,
    /// The pull diagnostic request id → the md path of the note (so the event
    /// knows where to go when the reply arrives).
    pending_pulls: Mutex<HashMap<u64, String>>,
}

impl TySink {
    /// The workspace configuration of ty: the project venv is handed over as
    /// the activeEnvironment (matching the shape of Zed); without a venv an
    /// empty configuration is given and ty probes by rootUri itself.
    fn settings_for(project_root: &Path) -> Value {
        match super::runner::venv_python(project_root) {
            Some(py) => {
                let sys_prefix = py.parent().and_then(Path::parent).unwrap_or(project_root);
                json!({
                    "pythonExtension": {
                        "activeEnvironment": {
                            "executable": {
                                "uri": path_to_uri(&py),
                                "sysPrefix": sys_prefix.to_string_lossy(),
                            }
                        }
                    }
                })
            }
            None => json!({}),
        }
    }

    /// The reply to workspace/configuration: the configuration ty cares about
    /// (activeEnvironment).
    fn server_configuration(&self, msg: &Value) -> Value {
        let items = msg
            .pointer("/params/items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Value::Array(
            items
                .iter()
                .map(|item| {
                    let section = item.get("section").and_then(Value::as_str).unwrap_or("");
                    if section.is_empty() || section == "ty" {
                        self.settings.clone()
                    } else {
                        Value::Null
                    }
                })
                .collect(),
        )
    }

    /// Turns the diagnostics (a pushed array or a pulled `{items:[...]}`) into
    /// the event for the front end.
    fn emit_diagnostics(&self, md_path: &str, result: Option<&Value>) {
        let items = match result {
            Some(Value::Array(a)) => a.clone(),
            Some(v) => match v.get("items").and_then(Value::as_array) {
                Some(a) => a.clone(),
                None => return,
            },
            None => return,
        };
        let _ = self.app.emit(
            "python-lsp-diagnostics",
            json!({ "mdPath": md_path, "diagnostics": items }),
        );
    }
}

impl LspSink for TySink {
    fn on_message<'a>(
        &'a self,
        client: &'a LspClient,
        msg: Value,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let id = msg.get("id").cloned();
            let method = msg.get("method").and_then(Value::as_str).map(|s| s.to_string());
            match (id, method) {
                // A server → client request: the configuration request gets
                // ty's configuration, the others get null, so the server never
                // waits for nothing.
                (Some(id), Some(method)) => {
                    let result = if method == "workspace/configuration" {
                        self.server_configuration(&msg)
                    } else {
                        Value::Null
                    };
                    let _ = client
                        .send(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                        .await;
                }
                // A reply: only the pulled diagnostics end up here (the replies
                // to our own requests were paired in the transport layer).
                (Some(id), None) => {
                    let id_num = match id.as_u64() {
                        Some(n) => n,
                        None => return,
                    };
                    let md = {
                        let mut pulls = match self.pending_pulls.lock() {
                            Ok(p) => p,
                            Err(_) => return,
                        };
                        pulls.remove(&id_num)
                    };
                    if let Some(md) = md {
                        self.emit_diagnostics(&md, msg.get("result"));
                    }
                }
                // A notification.
                (None, Some(method)) => {
                    if method == "textDocument/publishDiagnostics" {
                        let uri = msg
                            .pointer("/params/uri")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if let Some(md) = decode_uri_path(uri) {
                            let diags = msg.pointer("/params/diagnostics");
                            self.emit_diagnostics(
                                &md,
                                Some(&diags.cloned().unwrap_or(Value::Null)),
                            );
                        }
                    }
                }
                _ => {}
            }
        })
    }
}

/// The ty server: it wraps the generic client and adds what is specific to the
/// Python side.
///
/// The method names stay the same as in the old implementation (`sync_doc` /
/// `close_doc` / `interaction_request`), so the caller (`commands/python.rs`)
/// changes as little as possible.
pub struct LspServer {
    inner: Arc<LspClient>,
    sink: Arc<TySink>,
    pub project_name: String,
}

impl LspServer {
    /// Spawns `ty server` and starts the read loop; the caller awaits the
    /// handshake right after it gets the instance; on failure the process is
    /// reclaimed together with kill_on_drop.
    pub async fn spawn(
        project: &ProjectRef,
        program: String,
        app: tauri::AppHandle,
    ) -> Result<Arc<Self>, String> {
        let settings = TySink::settings_for(&project.root);
        let sink = Arc::new(TySink {
            app: app.clone(),
            settings: settings.clone(),
            pending_pulls: Mutex::new(HashMap::new()),
        });
        let spec = ServerSpec {
            command: program,
            args: vec!["server".to_string()],
            language_id: "python".to_string(),
            settings: Some(("ty".to_string(), settings)),
            pull_diagnostics: true,
            ..Default::default()
        };
        let inner = LspClient::spawn(&spec, project.root.clone(), sink.clone()).await?;
        Ok(Arc::new(Self {
            inner,
            sink,
            project_name: project.name.clone(),
        }))
    }

    /// Whether the process is still alive.
    pub fn alive(&self) -> bool {
        self.inner.alive.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The initialize handshake + the initialized notification + the initial
    /// configuration of ty.
    pub async fn initialize(&self) -> Result<Value, String> {
        let spec = ServerSpec {
            command: String::new(),
            args: Vec::new(),
            language_id: "python".to_string(),
            settings: Some(("ty".to_string(), self.sink.settings.clone())),
            pull_diagnostics: true,
            ..Default::default()
        };
        self.inner.initialize(&spec).await
    }

    /// Opens or updates a document: didChange when it was opened before,
    /// didOpen otherwise. The version number is incremented monotonically by the
    /// client, so the caller need not keep its own counter.
    pub async fn sync_doc(&self, md_path: &str, text: &str) -> Result<(), String> {
        let uri = doc_uri(md_path);
        let known = self
            .inner
            .docs
            .lock()
            .map_err(|_| "lock poisoned")?
            .contains_key(&uri);
        if known {
            self.inner.did_change(&uri, text).await?;
            // Pulled diagnostics: ty only speaks pull, so the request is sent
            // without waiting for the result (the sink handles the reply).
            let id = self
                .inner
                .request_detached(
                    "textDocument/diagnostic",
                    json!({ "textDocument": { "uri": uri } }),
                )
                .await?;
            if let Ok(mut pulls) = self.sink.pending_pulls.lock() {
                pulls.insert(id, md_path.to_string());
            }
        } else {
            self.inner.did_open(&uri, "python", text).await?;
        }
        Ok(())
    }

    /// An interactive request (completion / hover): forwarded to ty and awaited.
    /// The textDocument.uri is injected here from the md path, and the front end
    /// only supplies the position.
    pub async fn interaction_request(
        &self,
        method: &str,
        md_path: &str,
        mut params: Value,
    ) -> Result<Value, String> {
        if !params.is_object() {
            params = json!({});
        }
        params["textDocument"] = json!({ "uri": doc_uri(md_path) });
        self.inner.interaction_request(method, params).await
    }

    pub async fn close_doc(&self, md_path: &str) -> Result<(), String> {
        self.inner.did_close(&doc_uri(md_path)).await
    }

    /// Stops the server: an exit notification first, then a hard kill after
    /// 300ms (the graceful exit is never waited for; ty is stateless).
    pub fn stop(self: &Arc<Self>) {
        self.inner.stop();
    }
}

/// The document URI: the real path of the md file. ty only receives the
/// content in didOpen/didChange and never reads it back from disk.
fn doc_uri(md_path: &str) -> String {
    path_to_uri(Path::new(md_path))
}

/// Finds ty: the tyPath of the project configuration > the ty in the project
/// venv > the ty on the PATH.
pub fn find_ty(project_root: &Path, cfg: &ProjectConfig) -> Result<String, String> {
    if let Some(t) = cfg.ty_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(t.to_string());
    }
    if let Some(py) = super::runner::venv_python(project_root) {
        if let Some(bin) = py.parent() {
            let ty = bin.join("ty");
            if ty.exists() {
                return Ok(ty.to_string_lossy().to_string());
            }
        }
    }
    if let Some(t) = super::runner::find_on_path("ty") {
        return Ok(t.to_string_lossy().to_string());
    }
    Err(
        "ty 未找到:先安装(uv tool install ty 或 pipx install ty),\
         或在 <vault>/.bnote/python.json 的 projects.<目录>.tyPath 里指定路径"
            .to_string(),
    )
}
