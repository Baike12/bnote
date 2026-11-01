//! ty 语言服务器:markdown 里内嵌的 python 走这条链。
//!
//! 文档模型:前端把 markdown 里所有 python 围栏拼成「行对齐虚拟文件」(与
//! markdown 逐行等长,非代码行是空行),以笔记真实路径的 file:// URI 打开。
//! 虚拟文件的行列号与 markdown 完全一致,诊断原样转发给前端,零换算。
//!
//! 传输层(帧、请求配对、超时、停服)复用 [`crate::lsp::client`],这里只补
//! ty 特有的三件事:工作区配置(ty 的 activeEnvironment)、pull 诊断(ty 只
//! 认 pull,不会 push)、以及诊断事件的前端载荷形状。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::lsp::client::{LspClient, LspSink, ServerSpec};
use crate::lsp::{decode_uri_path, path_to_uri, BoxFuture};

use super::{ProjectConfig, ProjectRef};

/// ty 这一侧的消息处理:转发诊断、应答配置请求。
///
/// sink 持有 `AppHandle`:诊断事件要从这里发回前端。
struct TySink {
    app: tauri::AppHandle,
    /// ty 关心的 workspace 配置(activeEnvironment)。
    settings: Value,
    /// pull 诊断请求 id → 笔记 md 路径(应答到达时知道往哪发事件)。
    pending_pulls: Mutex<HashMap<u64, String>>,
}

impl TySink {
    /// ty 的工作区配置:把项目 venv 作为 activeEnvironment 交给它(对齐 zed 的
    /// 形状);没有 venv 就给空配置,ty 自己按 rootUri 探测。
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

    /// workspace/configuration 应答:ty 关心的配置(activeEnvironment)。
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

    /// 把诊断(推的数组或拉的 `{items:[...]}`)转成前端事件发出去。
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
                // 服务器 → 客户端的请求:配置请求回 ty 的配置,其余回 null,
                // 避免服务器干等。
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
                // 应答:只有 pull 诊断的会走到这里(我们自己的请求已在传输层配对)。
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
                // 通知。
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

/// ty 的服务器:包住通用客户端,补上 python 这一侧特有的东西。
///
/// 方法名与旧的实现保持一致(`sync_doc` / `close_doc` / `interaction_request`),
/// 调用方(`commands/python.rs`)改动最小。
pub struct LspServer {
    inner: Arc<LspClient>,
    sink: Arc<TySink>,
    pub project_name: String,
}

impl LspServer {
    /// spawn `ty server` 并启动读循环;握手由调用方在拿到实例后立即 await,
    /// 失败时进程随 kill_on_drop 一并回收。
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

    /// 进程还活着吗。
    pub fn alive(&self) -> bool {
        self.inner.alive.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// initialize 握手 + initialized 通知 + ty 的初始配置。
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

    /// 打开或更新一个文档:已开过就 didChange,否则 didOpen。
    /// 版本号由客户端单调递增,调用方不必自己记账。
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
            // pull 诊断:ty 只认 pull,发完不等结果(应答由 sink 处理)。
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

    /// 交互内请求(completion / hover):转发给 ty 并等应答。
    /// textDocument.uri 由这里按 md 路径统一注入,前端只给 position。
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

    /// 停服务器:先 exit 通知,300ms 后强杀(不掉等待优雅退出,ty 无状态)。
    pub fn stop(self: &Arc<Self>) {
        self.inner.stop();
    }
}

/// 文档 URI:md 真实路径。ty 只在 didOpen/didChange 收内容,不回读磁盘。
fn doc_uri(md_path: &str) -> String {
    path_to_uri(Path::new(md_path))
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
