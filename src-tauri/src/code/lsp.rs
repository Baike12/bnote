//! 代码项目的语言服务器:按语言起进程、按需转发请求、把诊断送回前端。
//!
//! ## 配置从哪来
//!
//! 三层,后者盖前者:
//!
//! 1. **内置默认**——常见语言用哪个服务器、怎么起(见 [`builtin_server`]);
//! 2. **全局覆盖**——用户在设置里配的(前端把这一层传进来);
//! 3. **项目内覆盖**——`<项目根>/.bnote/lsp.json`,跟着仓库走,团队共享。
//!
//! 项目内那份的形状:
//!
//! ```json
//! {
//!   "languages": {
//!     "typescript": { "command": "typescript-language-server", "args": ["--stdio"] },
//!     "go": { "command": "gopls", "args": [] }
//!   },
//!   "disabled": ["python"]
//! }
//! ```
//!
//! ## 一项目一 manager,一语言一进程
//!
//! 每个项目一个 [`LspManager`],里面按语言各挂一个客户端。同一语言不会起
//! 两个进程(并发首次请求时各自 spawn,插入前复查,只留一个活的)。
//!
//! ## 文档是真实文件
//!
//! 与 markdown 里内嵌 python 那条链不同:这里的 `didOpen` 送的是磁盘上真实
//! 文件的内容,URI 就是它的 file:// URI。服务器可以直接回读磁盘。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::lsp::client::{LspClient, LspSink, ServerSpec};
use crate::lsp::{decode_uri_path, path_to_uri, BoxFuture};

/// 语言服务器怎么起。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerConfig {
    /// 可执行文件名或绝对路径。
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// initialize 的 `initializationOptions`。
    pub init_options: Value,
}

/// `<项目根>/.bnote/lsp.json` 的形状。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectLspConfig {
    /// 语言 → 服务器配置。
    pub languages: HashMap<String, ServerConfig>,
    /// 明确关掉的语言(即便有默认配置)。
    pub disabled: Vec<String>,
}

/// 内置默认:常见语言用哪个语言服务器。
///
/// 参数是**实测过的启动方式**,不是猜的:
/// - `typescript-language-server` 要 `--stdio`;
/// - `ty` 的子命令是 `server`(不是 `--stdio`);
/// - `rust-analyzer` 直接跑就是 stdio 模式。
pub fn builtin_server(language: &str) -> Option<ServerConfig> {
    let (command, args): (&str, &[&str]) = match language {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            ("typescript-language-server", &["--stdio"])
        }
        "rust" => ("rust-analyzer", &[]),
        "go" => ("gopls", &[]),
        "python" => ("ty", &["server"]),
        "json" => ("vscode-json-language-server", &["--stdio"]),
        "html" => ("vscode-html-language-server", &["--stdio"]),
        "css" | "scss" | "less" => ("vscode-css-language-server", &["--stdio"]),
        "yaml" => ("yaml-language-server", &["--stdio"]),
        "sql" => ("sqls", &[]),
        "lua" => ("lua-language-server", &[]),
        "shellscript" => ("bash-language-server", &["start"]),
        _ => return None,
    };
    Some(ServerConfig {
        command: command.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: HashMap::new(),
        init_options: Value::Null,
    })
}

/// 读项目内的 `.bnote/lsp.json`;没有或坏了就当没有(不因为一个配置文件
/// 让整个项目打不开)。
pub fn load_project_config(root: &Path) -> ProjectLspConfig {
    let path = root.join(".bnote").join("lsp.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => ProjectLspConfig::default(),
    }
}

/// 三层配置合并后的结果。
#[derive(Debug, Clone)]
pub struct ResolvedServer {
    pub config: ServerConfig,
    /// 被项目配置明确关掉了。
    pub disabled: bool,
}

/// 合并:内置默认 < 全局覆盖 < 项目内覆盖。
///
/// `global` 是前端从设置里取的那一层(按语言给的);项目内那份由本函数
/// 自己读。返回 `None` 表示这个语言没有可用的服务器(前端据此不显示 LSP
/// 相关入口)。
pub fn resolve_server(
    root: &Path,
    language: &str,
    global: Option<&ServerConfig>,
) -> Option<ResolvedServer> {
    let project = load_project_config(root);
    if project.disabled.iter().any(|d| d == language) {
        return Some(ResolvedServer {
            config: ServerConfig::default(),
            disabled: true,
        });
    }
    let mut config = builtin_server(language)?;
    if let Some(g) = global {
        config = merge(config, g);
    }
    if let Some(p) = project.languages.get(language) {
        config = merge(config, p);
    }
    Some(ResolvedServer {
        config,
        disabled: false,
    })
}

/// 两份配置合并:后者的非空字段盖前者。
fn merge(mut base: ServerConfig, over: &ServerConfig) -> ServerConfig {
    if !over.command.trim().is_empty() {
        base.command = over.command.clone();
    }
    if !over.args.is_empty() {
        base.args = over.args.clone();
    }
    for (k, v) in &over.env {
        base.env.insert(k.clone(), v.clone());
    }
    if !over.init_options.is_null() {
        base.init_options = over.init_options.clone();
    }
    base
}

/// 一个项目的语言服务器集合。
pub struct LspManager {
    pub root: PathBuf,
    /// 语言 → 客户端。
    clients: Mutex<HashMap<String, Arc<LspClient>>>,
}

impl LspManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// 取某个语言的客户端(没起过就是 None)。
    pub fn get(&self, language: &str) -> Option<Arc<LspClient>> {
        self.clients
            .lock()
            .ok()
            .and_then(|m| m.get(language).cloned())
    }

    /// 某个语言是否已经有活着的客户端。
    pub fn has(&self, language: &str) -> bool {
        self.get(language)
            .map(|c| c.alive.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(false)
    }

    /// 保证某个语言的服务器起着;已经活着就直接给。
    ///
    /// 并发的首次请求会各自 spawn 一个,插入前复查 map:只留一个活的,其余
    /// 立刻停掉(不留僵尸进程)。
    pub async fn ensure(
        &self,
        language: &str,
        config: &ServerConfig,
        app: tauri::AppHandle,
    ) -> Result<Arc<LspClient>, String> {
        if let Some(c) = self.get(language) {
            if c.alive.load(std::sync::atomic::Ordering::Relaxed) {
                return Ok(c);
            }
        }
        let sink = Arc::new(CodeSink {
            app: app.clone(),
            root: self.root.clone(),
        });
        let spec = ServerSpec {
            command: config.command.clone(),
            args: config.args.clone(),
            env: config.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            cwd: Some(self.root.clone()),
            language_id: language.to_string(),
            initialization_options: config.init_options.clone(),
            settings: None,
            pull_diagnostics: false,
        };
        let client = LspClient::spawn(&spec, self.root.clone(), sink).await?;
        client.initialize(&spec).await?;
        let mut map = self.clients.lock().map_err(|_| "lock poisoned")?;
        match map.get(language) {
            Some(existing) if existing.alive.load(std::sync::atomic::Ordering::Relaxed) => {
                // 别人先起来了:停掉自己起的这个,用它那份。
                client.stop();
                Ok(existing.clone())
            }
            _ => {
                map.insert(language.to_string(), client.clone());
                let _ = app.emit(
                    "code-lsp-status",
                    json!({ "root": self.root.to_string_lossy(), "language": language, "state": "running" }),
                );
                Ok(client)
            }
        }
    }

    /// 停掉所有服务器(关项目/切换项目时)。
    pub fn stop_all(&self) {
        if let Ok(mut map) = self.clients.lock() {
            for (_, client) in map.drain() {
                client.stop();
            }
        }
    }
}

/// 代码项目的消息处理:转发诊断、转发日志、应答服务器的主动请求。
struct CodeSink {
    app: tauri::AppHandle,
    root: PathBuf,
}

impl CodeSink {
    /// 绝对路径 → 项目相对路径(posix)。项目外的文件返回 None(不显示)。
    fn relative(&self, abs: &str) -> Option<String> {
        let p = Path::new(abs);
        let rel = p.strip_prefix(&self.root).ok()?;
        Some(
            rel.components()
                .filter_map(|c| match c {
                    std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/"),
        )
    }

    /// `workspace/configuration` 的应答:按 items 的条数回等长的 null 数组
    /// (少一条会让服务器按下标取值时越界)。
    fn configuration_reply(msg: &Value) -> Value {
        let count = msg
            .pointer("/params/items")
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0);
        Value::Array(vec![Value::Null; count])
    }

    /// `workspace/workspaceFolders` 的应答。
    fn workspace_folders(&self) -> Value {
        json!([{
            "uri": path_to_uri(&self.root),
            "name": self.root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        }])
    }
}

impl LspSink for CodeSink {
    fn on_message<'a>(
        &'a self,
        client: &'a LspClient,
        msg: Value,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let id = msg.get("id").cloned();
            let method = msg.get("method").and_then(Value::as_str).map(|s| s.to_string());
            match (id, method) {
                // 服务器 → 客户端的请求:挨个回它该回的东西。
                (Some(id), Some(method)) => {
                    let result = match method.as_str() {
                        "workspace/configuration" => Self::configuration_reply(&msg),
                        "workspace/workspaceFolders" => self.workspace_folders(),
                        "workspace/applyEdit" => json!({ "applied": false }),
                        _ => Value::Null,
                    };
                    let _ = client
                        .send(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                        .await;
                }
                // 通知。
                (None, Some(method)) => match method.as_str() {
                    // 服务器进程退出了:把状态报回去,前端才不会以为它还活着。
                    "$bnote/serverExit" => {
                        let _ = self.app.emit(
                            "code-lsp-status",
                            json!({
                                "root": self.root.to_string_lossy(),
                                "language": client.language_id,
                                "state": "stopped",
                            }),
                        );
                    }
                    "textDocument/publishDiagnostics" => {
                        let uri = msg
                            .pointer("/params/uri")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let Some(abs) = decode_uri_path(uri) else {
                            return;
                        };
                        let Some(path) = self.relative(&abs) else {
                            return; // 项目外的诊断(依赖目录)不显示
                        };
                        let items = msg
                            .pointer("/params/diagnostics")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let diagnostics: Vec<Value> = items
                            .iter()
                            .map(crate::lsp::client::diagnostic_to_json)
                            .collect();
                        let _ = self.app.emit(
                            "code-lsp-diagnostics",
                            json!({
                                "root": self.root.to_string_lossy(),
                                "path": path,
                                "diagnostics": diagnostics,
                            }),
                        );
                    }
                    "window/logMessage" => {
                        let message = msg
                            .pointer("/params/message")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let level = msg
                            .pointer("/params/type")
                            .and_then(Value::as_u64)
                            .unwrap_or(3);
                        let _ = self.app.emit(
                            "code-lsp-log",
                            json!({
                                "root": self.root.to_string_lossy(),
                                "language": client.language_id,
                                "level": level,
                                "message": message,
                            }),
                        );
                    }
                    _ => {}
                },
                _ => {}
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bnote-codelsp-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn builtin_covers_the_four_core_languages() {
        assert_eq!(builtin_server("typescript").unwrap().command, "typescript-language-server");
        assert_eq!(builtin_server("typescript").unwrap().args, vec!["--stdio".to_string()]);
        assert_eq!(builtin_server("rust").unwrap().command, "rust-analyzer");
        assert_eq!(builtin_server("go").unwrap().command, "gopls");
        assert_eq!(builtin_server("python").unwrap().command, "ty");
        assert_eq!(builtin_server("python").unwrap().args, vec!["server".to_string()]);
        assert!(builtin_server("cobol").is_none());
    }

    #[test]
    fn project_config_overrides_builtin() {
        let root = tmpdir("override");
        std::fs::create_dir_all(root.join(".bnote")).unwrap();
        std::fs::write(
            root.join(".bnote/lsp.json"),
            r#"{"languages":{"go":{"command":"/opt/gopls","args":["-x"]}}}"#,
        )
        .unwrap();
        let r = resolve_server(&root, "go", None).unwrap();
        assert_eq!(r.config.command, "/opt/gopls");
        assert_eq!(r.config.args, vec!["-x".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn global_overrides_builtin_but_project_overrides_global() {
        let root = tmpdir("layers");
        std::fs::create_dir_all(root.join(".bnote")).unwrap();
        std::fs::write(
            root.join(".bnote/lsp.json"),
            r#"{"languages":{"go":{"command":"project-go"}}}"#,
        )
        .unwrap();
        let global = ServerConfig {
            command: "global-go".to_string(),
            ..Default::default()
        };
        // 项目内那层最高。
        let r = resolve_server(&root, "go", Some(&global)).unwrap();
        assert_eq!(r.config.command, "project-go");
        // 没被项目覆盖的语言吃全局那层。
        let r = resolve_server(&root, "rust", Some(&global)).unwrap();
        assert_eq!(r.config.command, "global-go");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disabled_language_resolves_to_disabled() {
        let root = tmpdir("disabled");
        std::fs::create_dir_all(root.join(".bnote")).unwrap();
        std::fs::write(root.join(".bnote/lsp.json"), r#"{"disabled":["python"]}"#).unwrap();
        let r = resolve_server(&root, "python", None).unwrap();
        assert!(r.disabled);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_project_config_is_ignored() {
        let root = tmpdir("broken");
        std::fs::create_dir_all(root.join(".bnote")).unwrap();
        std::fs::write(root.join(".bnote/lsp.json"), "{ not json").unwrap();
        let r = resolve_server(&root, "rust", None).unwrap();
        assert_eq!(r.config.command, "rust-analyzer");
        let _ = std::fs::remove_dir_all(&root);
    }
}
