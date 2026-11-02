//! Language servers for code projects: spawn one process per language, forward
//! requests on demand, push diagnostics back to the front end.
//!
//! ## Where the configuration comes from
//!
//! Three layers, each overriding the previous one:
//!
//! 1. **built-in defaults** — which server to use for a common language and how
//!    to start it (see [`builtin_server`]);
//! 2. **global overrides** — what the user configured in the settings (the
//!    front end passes this layer in);
//! 3. **project overrides** — `<project root>/.bnote/lsp.json`, which travels
//!    with the repository and is shared by the team.
//!
//! The shape of the project file:
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
//! ## One manager per project, one process per language
//!
//! Every project owns an [`LspManager`] that holds one client per language. The
//! same language never spawns two processes (concurrent first requests each
//! spawn one, the map is re-checked before insertion and only the live one
//! survives).
//!
//! ## The documents are real files
//!
//! Unlike the Python chain embedded in markdown, the `didOpen` here carries the
//! content of a real file on disk and its URI is that file's file:// URI, so the
//! server can read it back from disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::lsp::client::{LspClient, LspSink, ServerSpec};
use crate::lsp::{decode_uri_path, path_to_uri, BoxFuture};

/// How to start a language server.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerConfig {
    /// The executable name or an absolute path.
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// The `initializationOptions` of the initialize request.
    pub init_options: Value,
}

/// The shape of `<project root>/.bnote/lsp.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectLspConfig {
    /// Language → server configuration.
    pub languages: HashMap<String, ServerConfig>,
    /// Languages explicitly turned off (even when a default configuration exists).
    pub disabled: Vec<String>,
}

/// Built-in defaults: which language server a common language uses.
///
/// The arguments are **measured startup invocations**, not guesses:
/// - `typescript-language-server` needs `--stdio`;
/// - the subcommand of `ty` is `server` (not `--stdio`);
/// - `rust-analyzer` speaks stdio when run directly.
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

/// Reads the project's `.bnote/lsp.json`; a missing or broken file counts as
/// absent (one config file must not keep the whole project from opening).
pub fn load_project_config(root: &Path) -> ProjectLspConfig {
    let path = root.join(".bnote").join("lsp.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => ProjectLspConfig::default(),
    }
}

/// The result of merging the three configuration layers.
#[derive(Debug, Clone)]
pub struct ResolvedServer {
    pub config: ServerConfig,
    /// Turned off by the project configuration.
    pub disabled: bool,
}

/// Merge: built-in defaults < global overrides < project overrides.
///
/// `global` is the layer the front end reads from the settings (given per
/// language); the project file is read by this function itself. `None` means
/// the language has no usable server (the front end then shows no LSP entry
/// points for it).
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
    if language == "python" {
        apply_python_venv(root, &mut config);
    }
    Some(ResolvedServer {
        config,
        disabled: false,
    })
}

/// The virtual environment of a Python project: `.venv` / `venv` under the root
/// (only counted when it holds `bin/python`).
///
/// The same rule as the Python extension of Zed: the venv is looked up only at
/// the workspace root and not recursively (a subproject is opened with its own
/// root); `bin/python` has to exist, otherwise it is just a directory with the
/// same name.
pub fn find_python_venv(root: &Path) -> Option<PathBuf> {
    for name in [".venv", "venv"] {
        let dir = root.join(name);
        if dir.join("bin/python").is_file() || dir.join("bin/python3").is_file() {
            return Some(dir);
        }
    }
    None
}

/// Hand the venv to the language server: **`VIRTUAL_ENV` + `PATH` with bin
/// prepended**.
///
/// ty / pyright / pylsp all pick the interpreter from these two variables
/// (not from the presence of a `.venv` directory in the project root), so they
/// have to be injected into the child process environment. The env the user
/// configured explicitly wins (`entry` does not overwrite an existing key, and
/// the `PATH` entry is only added when the configuration has none).
fn apply_python_venv(root: &Path, config: &mut ServerConfig) {
    let Some(venv) = find_python_venv(root) else {
        return;
    };
    let bin = venv.join("bin");
    config
        .env
        .entry("VIRTUAL_ENV".to_string())
        .or_insert_with(|| venv.to_string_lossy().to_string());
    if !config.env.contains_key("PATH") {
        let base = std::env::var("PATH").unwrap_or_default();
        let mut paths = vec![bin];
        paths.extend(std::env::split_paths(&base));
        if let Ok(joined) = std::env::join_paths(paths) {
            config
                .env
                .insert("PATH".to_string(), joined.to_string_lossy().to_string());
        }
    }
}

/// Merges two configurations: the non-empty fields of the second override the
/// first.
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

/// The set of language servers of one project.
pub struct LspManager {
    pub root: PathBuf,
    /// Language → client.
    clients: Mutex<HashMap<String, Arc<LspClient>>>,
}

impl LspManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// Gets the client of a language (None when it was never started).
    pub fn get(&self, language: &str) -> Option<Arc<LspClient>> {
        self.clients
            .lock()
            .ok()
            .and_then(|m| m.get(language).cloned())
    }

    /// Whether the language already has a live client.
    pub fn has(&self, language: &str) -> bool {
        self.get(language)
            .map(|c| c.alive.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(false)
    }

    /// Makes sure the server of a language is running; returns the live one
    /// right away if it already is.
    ///
    /// Concurrent first requests each spawn one process, so the map is
    /// re-checked before insertion: only the live one is kept, the others are
    /// stopped immediately (no zombie processes left behind).
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
                // Somebody else won the race: stop the one we started and use
                // theirs.
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

    /// Stops every server (when a project is closed or switched).
    pub fn stop_all(&self) {
        if let Ok(mut map) = self.clients.lock() {
            for (_, client) in map.drain() {
                client.stop();
            }
        }
    }
}

/// Message handling for a code project: forwards diagnostics, forwards logs,
/// answers the requests the server initiates.
struct CodeSink {
    app: tauri::AppHandle,
    root: PathBuf,
}

impl CodeSink {
    /// Absolute path → path relative to the project (posix). Files outside the
    /// project return None (they are not shown).
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

    /// Reply to `workspace/configuration`: an array of nulls with as many
    /// entries as there are items (one entry less would let the server read out
    /// of bounds by index).
    fn configuration_reply(msg: &Value) -> Value {
        let count = msg
            .pointer("/params/items")
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0);
        Value::Array(vec![Value::Null; count])
    }

    /// Reply to `workspace/workspaceFolders`.
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
                // A server → client request: answer each with what it expects.
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
                // A notification.
                (None, Some(method)) => match method.as_str() {
                    // The server process exited: report the state back, otherwise
                    // the front end keeps believing it is alive.
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
                            return; // a diagnostic outside the project is not shown
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
        // The project layer wins.
        let r = resolve_server(&root, "go", Some(&global)).unwrap();
        assert_eq!(r.config.command, "project-go");
        // A language the project does not override takes the global layer.
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

    #[test]
    fn python_uses_root_venv_when_present() {
        let root = tmpdir("venv");
        std::fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::fs::write(root.join(".venv/bin/python"), "").unwrap();
        let r = resolve_server(&root, "python", None).unwrap();
        let venv = root.join(".venv").to_string_lossy().to_string();
        assert_eq!(r.config.env.get("VIRTUAL_ENV"), Some(&venv));
        let path = r.config.env.get("PATH").expect("PATH must be prefixed with the venv bin");
        assert_eq!(
            std::env::split_paths(path).next(),
            Some(root.join(".venv/bin"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn python_falls_back_to_venv_dir_and_ignores_empty_dirs() {
        let root = tmpdir("venv2");
        // A .venv without bin/python is not a virtual environment.
        std::fs::create_dir_all(root.join(".venv")).unwrap();
        std::fs::create_dir_all(root.join("venv/bin")).unwrap();
        std::fs::write(root.join("venv/bin/python3"), "").unwrap();
        let r = resolve_server(&root, "python", None).unwrap();
        assert_eq!(
            r.config.env.get("VIRTUAL_ENV"),
            Some(&root.join("venv").to_string_lossy().to_string())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn python_without_venv_gets_no_env_override() {
        let root = tmpdir("novenv");
        let r = resolve_server(&root, "python", None).unwrap();
        assert!(r.config.env.is_empty());
        // Other languages never touch the venv (it is not injected even when the
        // venv directory exists).
        std::fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::fs::write(root.join(".venv/bin/python"), "").unwrap();
        let r = resolve_server(&root, "rust", None).unwrap();
        assert!(r.config.env.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn user_env_wins_over_detected_venv() {
        let root = tmpdir("venvuser");
        std::fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::fs::write(root.join(".venv/bin/python"), "").unwrap();
        std::fs::create_dir_all(root.join(".bnote")).unwrap();
        std::fs::write(
            root.join(".bnote/lsp.json"),
            r#"{"languages":{"python":{"env":{"VIRTUAL_ENV":"/opt/py"}}}}"#,
        )
        .unwrap();
        let r = resolve_server(&root, "python", None).unwrap();
        assert_eq!(r.config.env.get("VIRTUAL_ENV").map(String::as_str), Some("/opt/py"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
