//! 通用 LSP 客户端:一个语言服务器进程 + 一份文档表。
//!
//! 与 python 内嵌那条链的唯一差别是**文档模型**:这里的文档是真实文件
//! (URI 指向磁盘上的路径),不是 markdown 里拼出来的虚拟文档。除此之外
//! (帧、请求配对、超时、停服)都一样,所以只有这一份实现。
//!
//! 「服务器发来的消息怎么处理」交给实现方([`LspSink`]):python 的诊断事件
//! 带 `mdPath`,代码项目的带项目相对路径;对 `workspace/configuration` 的
//! 应答内容也不同。传输层不认识这些差异,也不该认识。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;

use super::{frame_message, BoxFuture};

/// 握手超时:服务器起不来(路径错、缺依赖)时不能把 UI 吊死。
pub const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
/// completion / hover 这类交互内请求的等待上限;超时直接放弃,不让 UI 干等。
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// 启动一个语言服务器需要什么。
#[derive(Clone, Debug, Default)]
pub struct ServerSpec {
    /// 语言 id(typescript / rust / go / python …):进 didOpen 的 languageId,
    /// 也用作日志前缀。
    pub language_id: String,
    /// 可执行文件名或绝对路径。
    pub command: String,
    /// 启动参数(多数服务器要 `--stdio`)。
    pub args: Vec<String>,
    /// 追加的环境变量(不覆盖继承来的同名变量之外的语义)。
    pub env: Vec<(String, String)>,
    /// 工作目录;默认用项目根。
    pub cwd: Option<PathBuf>,
    /// initialize 的 `initializationOptions`。
    pub initialization_options: Value,
    /// initialize 之后发的 `workspace/didChangeConfiguration`:`(section, value)`。
    /// section 为空表示整个 settings 就是 value。
    pub settings: Option<(String, Value)>,
    /// didChange 之后是否主动 `textDocument/diagnostic`(pull)。
    /// 会 push 诊断的服务器不需要;ty 只认 pull。
    pub pull_diagnostics: bool,
}

impl ServerSpec {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            ..Default::default()
        }
    }

    pub fn with_args(mut self, args: &[&str]) -> Self {
        self.args = args.iter().map(|s| s.to_string()).collect();
        self
    }
}

/// 服务器发来的消息怎么处理。
pub trait LspSink: Send + Sync + 'static {
    /// 处理一条来自服务器的消息。返回的 future 由读循环 await。
    fn on_message<'a>(
        &'a self,
        client: &'a LspClient,
        msg: Value,
    ) -> BoxFuture<'a, ()>;
}

/// 一个语言服务器进程。
pub struct LspClient {
    /// 语言 id(typescript / rust / go / python …),也用作日志前缀。
    pub language_id: String,
    /// 项目根:initialize 的 rootUri 与工作目录。
    pub project_root: PathBuf,
    child: AsyncMutex<tokio::process::Child>,
    stdin: AsyncMutex<tokio::process::ChildStdin>,
    next_id: AtomicU64,
    /// uri → 已推送的文档版本(didOpen 后从 0 递增)。
    pub docs: Mutex<HashMap<String, u32>>,
    /// 文档操作串行化:避免并发的 open/change 交错。
    doc_ops: AsyncMutex<()>,
    pub alive: AtomicBool,
    /// 未应答请求:request id → oneshot。
    pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>,
}

impl LspClient {
    /// 拉起进程并启动读循环。握手由调用方在拿到实例后立即 await,
    /// 失败时进程随 kill_on_drop 一并回收。
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

        // stderr 排水:不排会把服务器阻死在写满的管道上。
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

        // 读循环:解析帧 → 分发。
        // 循环用的是自己那份 clone,`client` 本身留给调用方。
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
                                break; // 空行 = 头结束
                            }
                            if let Some(v) = super::content_length_of(trimmed) {
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

    /// 写一条消息(stdio 上的 LSP 帧)。
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

    /// 发一条通知(无 id)。
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

    /// 发请求并等应答。时序契约:先在 pending 占位再发送 —— 读循环是独立
    /// 任务,应答可能先于本任务恢复执行到达,发送后再注册会漏收。
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
                // 超时把占位摘掉,否则每超时一次泄漏一条。
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!("LSP_TIMEOUT: {} 超时", method))
            }
        }
    }

    /// 发一条**不等结果**的请求:返回请求 id,由调用方自己把 id 映射到
    /// 应答的去处(pull 诊断就是这种——应答要走通知通道给前端)。
    pub async fn request_detached(&self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.alloc_id();
        self.send_request(id, method, params).await?;
        Ok(id)
    }

    /// 交互内请求(completion / hover / definition):白名单在命令层,
    /// `textDocument.uri` 由调用方注入,前端只给 position。
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

    /// initialize 握手 + initialized 通知 + 可选的初始配置。
    /// 返回服务器的 capabilities(留作特性探测)。
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

    /// 打开一个文档(真实文件或虚拟文档都一样:URI + 语言 + 内容)。
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

    /// 全量 didChange;版本号由本模块单调递增,调用方不必自己记账。
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
        self.docs
            .lock()
            .map_err(|_| "lock poisoned")?
            .remove(uri);
        self.notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": uri } }),
        )
        .await
    }

    /// 停服务器:先 exit 通知,300ms 后强杀(不掉等待优雅退出)。
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

/// 读循环的分发。
///
/// 我们自己发起的请求(在 `pending` 里等着)的应答在这里配对;其余消息
/// (通知、服务器的主动请求、以及我们自己发的裸请求的应答)一律交给 sink。
async fn dispatch<'a>(
    client: &'a Arc<LspClient>,
    sink: &'a Arc<dyn LspSink>,
    msg: Value,
) {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).map(|s| s.to_string());
    match (id, method) {
        // 服务器 → 客户端的请求:应答内容因服务器而异,交给 sink。
        (Some(_), Some(_)) => sink.on_message(client, msg).await,
        // 我们请求的应答:配对 oneshot。没配上的(如 python 的 pull 诊断)
        // 落到 sink。
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
        // 通知。
        (None, Some(_)) => sink.on_message(client, msg).await,
        _ => {}
    }
}

/// 把一条诊断(标准 LSP 的 Diagnostic)翻成前端要的形状。
///
/// LSP 的 range 用 UTF-16 码元计数,前端的 CodeMirror 用 UTF-16 码元也是
/// 一致(CodeMirror 的位置以 UTF-16 计),所以行/字符原样传;行列都是
/// 0-based,前端按需 +1。
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
