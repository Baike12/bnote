//! ty 语言服务器客户端:每个项目一个 `ty server` 进程,stdio 上跑标准 LSP
//! (Content-Length 帧 JSON-RPC)。
//!
//! 文档模型:前端把 markdown 里所有 python 围栏拼成「行对齐虚拟文件」(与
//! markdown 逐行等长,非代码行是空行),以笔记真实路径的 file:// URI 打开。
//! 虚拟文件的行列号与 markdown 完全一致,诊断原样转发给前端,零换算。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;

use super::{ProjectRef, ProjectConfig};

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);

pub struct LspServer {
    pub project_root: PathBuf,
    pub project_name: String,
    child: AsyncMutex<tokio::process::Child>,
    stdin: AsyncMutex<tokio::process::ChildStdin>,
    next_id: AtomicU64,
    /// md_path → 已推送的虚拟文档版本(didOpen 后从 0 递增)。
    pub docs: Mutex<HashMap<String, u32>>,
    /// 文档操作串行化:避免并发的 open/change 交错。
    doc_ops: AsyncMutex<()>,
    pub alive: AtomicBool,
    /// 未应答请求:request id → oneshot(initialize 与 pull diagnostics 共用)。
    pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>,
    /// pull diagnostics 请求 id → md_path(应答到达时知道往哪发事件)。
    pending_pulls: Mutex<HashMap<u64, String>>,
}

// ---------------------------------------------------------------------------
// URI:虚拟文档用笔记真实路径的 file:// URI;诊断按 uri 反解回 md 路径。
// ---------------------------------------------------------------------------

/// file:// URI 的路径部分编码:保留 RFC 3986 unreserved 与 '/',其余按 UTF-8
/// 字节转 %XX(空格、中文都会被编码)。
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

/// [`encode_uri_path`] 的逆运算;非 file:// 或解析失败返回 None。
pub fn decode_uri_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    // file://host/path 只支持空 host(localhost/空串)。
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

pub fn path_to_uri(path: &Path) -> String {
    format!("file://{}", encode_uri_path(&path.to_string_lossy()))
}

// ---------------------------------------------------------------------------
// 帧:标准 LSP 用 Content-Length 头,不是 MCP 的换行分隔。
// ---------------------------------------------------------------------------

pub fn frame_message(msg: &Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_string(msg).map_err(|e| format!("SERIALIZE_FAILED: {}", e))?;
    Ok(format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes())
}

/// 从响应头行里取 Content-Length(大小写不敏感,容忍多余头)。
pub fn content_length_of(header_line: &str) -> Option<usize> {
    let (key, value) = header_line.split_once(':')?;
    if key.trim().eq_ignore_ascii_case("content-length") {
        value.trim().parse().ok()
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// 服务器生命周期与消息
// ---------------------------------------------------------------------------

impl LspServer {
    /// spawn `ty server` 并启动读循环;握手由调用方在拿到实例后立即 await,
    /// 失败时进程随 kill_on_drop 一并回收。
    pub async fn spawn(
        project: &ProjectRef,
        program: String,
        app: tauri::AppHandle,
    ) -> Result<std::sync::Arc<Self>, String> {
        let mut cmd = tokio::process::Command::new(&program);
        cmd.arg("server")
            .current_dir(&project.root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("LSP_SPAWN_FAILED: {} — {}", program, e))?;
        let stdin = child.stdin.take().ok_or("LSP_PIPE: no stdin")?;
        let stdout = child.stdout.take().ok_or("LSP_PIPE: no stdout")?;
        let stderr = child.stderr.take().ok_or("LSP_PIPE: no stderr")?;

        let server = std::sync::Arc::new(Self {
            project_root: project.root.clone(),
            project_name: project.name.clone(),
            child: AsyncMutex::new(child),
            stdin: AsyncMutex::new(stdin),
            next_id: AtomicU64::new(1),
            docs: Mutex::new(HashMap::new()),
            doc_ops: AsyncMutex::new(()),
            alive: AtomicBool::new(true),
            pending: Mutex::new(HashMap::new()),
            pending_pulls: Mutex::new(HashMap::new()),
        });

        // stderr 排水:不排会把 ty 阻死在写满的管道上。
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => eprint!("[ty:stderr] {}", line),
                }
            }
        });

        // 读循环:解析帧 → 分发。
        let srv = server.clone();
        let app_reader = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut length: Option<usize> = None;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => {
                            srv.alive.store(false, Ordering::Relaxed);
                            let _ = app_reader.emit(
                                "python-lsp-status",
                                json!({ "project": srv.project_name, "state": "stopped" }),
                            );
                            return;
                        }
                        Ok(_) => {
                            let trimmed = line.trim_end();
                            if trimmed.is_empty() {
                                break; // 空行 = 头结束
                            }
                            if let Some(v) = content_length_of(trimmed) {
                                length = Some(v);
                            }
                        }
                    }
                }
                let len = match length {
                    Some(l) => l,
                    None => continue, // 没有 Content-Length 的帧只能丢弃
                };
                let mut buf = vec![0u8; len];
                if reader.read_exact(&mut buf).await.is_err() {
                    srv.alive.store(false, Ordering::Relaxed);
                    break;
                }
                let msg: Value = match serde_json::from_slice(&buf) {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("[bnote] lsp: bad frame: {}", e);
                        continue;
                    }
                };
                handle_message(&srv, &app_reader, msg).await;
            }
        });

        Ok(server)
    }

    pub async fn send(&self, msg: Value) -> Result<(), String> {
        let bytes = frame_message(&msg)?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("LSP_WRITE: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("LSP_WRITE: {}", e))
    }

    async fn request(&self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;
        Ok(id)
    }

    /// initialize 握手 + initialized 通知 + 初始配置(指向项目 venv,若有)。
    /// 返回服务器的 capabilities(留作特性探测)。
    pub async fn initialize(&self) -> Result<Value, String> {
        let id = self.request(
            "initialize",
            json!({
                "processId": null,
                "rootUri": path_to_uri(&self.project_root),
                "workspaceFolders": [{
                    "uri": path_to_uri(&self.project_root),
                    "name": self.project_name,
                }],
                "capabilities": {},
                "initializationOptions": {},
                "clientInfo": { "name": "bnote", "version": "0.1.0" },
            }),
        )
        .await?;
        let rx = {
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.pending
                .lock()
                .map_err(|_| "lock poisoned")?
                .insert(id, tx);
            rx
        };
        let result = tokio::time::timeout(INITIALIZE_TIMEOUT, rx)
            .await
            .map_err(|_| "LSP_TIMEOUT: initialize 超时(15s)")?
            .map_err(|_| "LSP_DIED: 服务器在握手期间退出".to_string())?;
        self.send(json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} })).await?;
        let settings = ty_configuration_value(&self.project_root);
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "workspace/didChangeConfiguration",
            "params": { "settings": { "ty": settings } },
        }))
        .await?;
        Ok(result)
    }

    pub async fn open_doc(&self, md_path: &str, text: &str) -> Result<(), String> {
        let _guard = self.doc_ops.lock().await;
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": doc_uri(md_path),
                    "languageId": "python",
                    "version": 0,
                    "text": text,
                }
            },
        }))
        .await
    }

    /// 全量 didChange;随后发一次 pull diagnostics(ty 若支持 push 会自己再推,
    /// 前端以最后一次到达为准,内容一致)。
    pub async fn change_doc(&self, md_path: &str, version: u32, text: &str) -> Result<(), String> {
        let _guard = self.doc_ops.lock().await;
        let uri = doc_uri(md_path);
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didChange",
            "params": {
                "textDocument": { "uri": uri, "version": version },
                "contentChanges": [{ "text": text }],
            },
        }))
        .await?;
        // pull diagnostics,不等结果(读循环里应答)。
        let id = self
            .request("textDocument/diagnostic", json!({ "textDocument": { "uri": uri } }))
            .await?;
        if let Ok(mut pulls) = self.pending_pulls.lock() {
            pulls.insert(id, md_path.to_string());
        }
        Ok(())
    }

    pub async fn close_doc(&self, md_path: &str) -> Result<(), String> {
        let _guard = self.doc_ops.lock().await;
        self.docs.lock().map_err(|_| "lock poisoned")?.remove(md_path);
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didClose",
            "params": { "textDocument": { "uri": doc_uri(md_path) } },
        }))
        .await
    }

    /// 停服务器:先 exit 通知,300ms 后强杀(不掉等待优雅退出,ty 无状态)。
    pub fn stop(self: &std::sync::Arc<Self>) {
        if !self.alive.swap(false, Ordering::Relaxed) {
            return;
        }
        let srv = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = srv
                .send(json!({ "jsonrpc": "2.0", "method": "exit", "params": null }))
                .await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let _ = srv.child.lock().await.start_kill();
        });
    }
}

/// 文档 URI:md 真实路径。ty 只在 didOpen/didChange 收内容,不回读磁盘。
fn doc_uri(md_path: &str) -> String {
    path_to_uri(Path::new(md_path))
}

/// ty 的工作区配置:把项目 venv 作为 activeEnvironment 交给它(对齐 zed 的
/// 形状);没有 venv 就给空配置,ty 自己按 rootUri 探测。
pub fn ty_configuration_value(project_root: &Path) -> Value {
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

/// 发现 ty:项目配置的 tyPath > 项目 venv 里的 ty > PATH 上的 ty。
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

/// 读循环的分发:应答 → oneshot / pull 诊断;服务器请求 → 通用应答;
/// publishDiagnostics → 转发事件。
async fn handle_message(srv: &std::sync::Arc<LspServer>, app: &tauri::AppHandle, msg: Value) {
    let id = msg.get("id").cloned();
    match (id, msg.get("method").and_then(Value::as_str)) {
        // 服务器 → 客户端的请求:一律给个空应答,避免服务器干等。
        (Some(id), Some(_method)) => {
            let result = if msg.get("method").and_then(Value::as_str)
                == Some("workspace/configuration")
            {
                server_configuration(srv, &msg)
            } else {
                Value::Null
            };
            let _ = srv.send(json!({ "jsonrpc": "2.0", "id": id, "result": result })).await;
        }
        // 我们请求的应答。
        (Some(id), None) => {
            let id_num = id.as_u64();
            if let (Some(id_num), Ok(mut pulls)) = (id_num, srv.pending_pulls.lock()) {
                if let Some(md) = pulls.remove(&id_num) {
                    emit_diagnostics(app, &md, msg.get("result"));
                }
            }
            if let Ok(mut pending) = srv.pending.lock() {
                if let Some(id_num) = id_num {
                    if let Some(tx) = pending.remove(&id_num) {
                        let _ = tx.send(msg.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
            }
        }
        // 通知。
        (None, Some(method)) => {
            if method == "textDocument/publishDiagnostics" {
                let uri = msg
                    .pointer("/params/uri")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(md) = decode_uri_path(uri) {
                    let diags = msg.pointer("/params/diagnostics");
                    emit_diagnostics(app, &md, Some(&diags.cloned().unwrap_or(Value::Null)));
                }
            }
        }
        _ => {}
    }
}

/// workspace/configuration 应答:ty 关心的配置(activeEnvironment)。
fn server_configuration(srv: &LspServer, msg: &Value) -> Value {
    let settings = ty_configuration_value(&srv.project_root);
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
                    settings.clone()
                } else {
                    Value::Null
                }
            })
            .collect(),
    )
}

fn emit_diagnostics(app: &tauri::AppHandle, md_path: &str, result: Option<&Value>) {
    let items = match result {
        Some(Value::Array(a)) => a.clone(),
        Some(v) => match v.get("items").and_then(Value::as_array) {
            Some(a) => a.clone(),
            None => return,
        },
        None => return,
    };
    let _ = app.emit(
        "python-lsp-diagnostics",
        json!({ "mdPath": md_path, "diagnostics": items }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_roundtrip_with_cjk_and_spaces() {
        let p = "/Users/张三/my vault/笔记 01.md";
        let uri = path_to_uri(Path::new(p));
        // 空␣格 → %20;「张」UTF-8 = E5 BC A0。
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
        let parsed: Value = serde_json::from_str(body).unwrap();
        assert_eq!(parsed, msg);
    }

    #[test]
    fn content_length_is_case_insensitive_and_tolerates_other_headers() {
        assert_eq!(content_length_of("Content-Length: 42"), Some(42));
        assert_eq!(content_length_of("content-length: 7"), Some(7));
        assert_eq!(content_length_of("CONTENT-LENGTH: 0"), Some(0));
        assert_eq!(content_length_of("Content-Type: application/vscode-jsonrpc"), None);
    }

    #[test]
    fn ty_configuration_points_at_venv_when_present() {
        let dir = std::env::temp_dir().join(format!("bnote-lsp-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // 没有 venv → 空配置。
        assert_eq!(ty_configuration_value(&dir), json!({}));
        // 有 venv → executable.uri 指向 venv 的 python,sysPrefix 指向 venv。
        let bin = super::super::runner::venv_bin(&dir.join(".venv"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("python"), "").unwrap();
        let cfg = ty_configuration_value(&dir);
        let uri = cfg.pointer("/pythonExtension/activeEnvironment/executable/uri").unwrap();
        assert!(uri.as_str().unwrap().starts_with("file://"));
        let prefix = cfg.pointer("/pythonExtension/activeEnvironment/executable/sysPrefix").unwrap();
        assert_eq!(prefix.as_str().unwrap(), dir.join(".venv").to_string_lossy().to_string());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
