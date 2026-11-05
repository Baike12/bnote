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
///
/// `rel_path` is the file the server is resolved for: a Python venv is taken
/// from **that file's subproject**, not from the project root (see
/// [`server_root`]). An empty path means "the project root itself".
pub fn resolve_server(
    root: &Path,
    language: &str,
    rel_path: &str,
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
        apply_python_venv(&server_root(root, language, rel_path), &mut config);
    }
    Some(ResolvedServer {
        config,
        disabled: false,
    })
}

/// The workspace root the language server serving `rel_path` should use.
///
/// Every language except Python has one server per project: the project root is
/// the workspace (`rootUri`, cwd) and the sandbox rule already bounds it.
///
/// Python is the exception, because **the environment belongs to the
/// subproject, not to the folder the user opened**. A course repository holds
/// several assignments, each with its own `.venv`; opening the repository has
/// to serve all of them, and one `VIRTUAL_ENV` per process cannot. So
/// `rel_path` resolves to the nearest ancestor of the file (its own directory
/// first, the project root last) that holds a venv or a Python manifest, and
/// the manager keeps one server per (language, workspace root) — the same
/// shape Zed uses (manifest root per subproject + one server per toolchain).
pub fn server_root(root: &Path, language: &str, rel_path: &str) -> PathBuf {
    if language != "python" {
        return root.to_path_buf();
    }
    let rel = Path::new(rel_path);
    let mut current = rel.parent();
    while let Some(rel_dir) = current {
        let abs = if rel_dir.as_os_str().is_empty() {
            root.to_path_buf()
        } else {
            root.join(rel_dir)
        };
        if find_python_venv(&abs).is_some() || is_python_project(&abs) {
            return abs;
        }
        current = rel_dir.parent();
    }
    root.to_path_buf()
}

/// Manifest files that mark the root of a Python (sub)project.
const PYTHON_MANIFESTS: &[&str] = &[
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
];

fn is_python_project(dir: &Path) -> bool {
    PYTHON_MANIFESTS.iter().any(|m| dir.join(m).is_file())
}

/// The interpreter inside a venv (`bin/python` / `bin/python3`).
fn venv_interpreter(venv: &Path) -> Option<PathBuf> {
    ["bin/python", "bin/python3"]
        .iter()
        .map(|p| venv.join(p))
        .find(|p| p.is_file())
}

/// The virtual environment of a Python (sub)project: `.venv` / `venv` under
/// the given directory (only counted when it holds an interpreter).
///
/// The caller passes the **subproject root** (see [`server_root`]), so the
/// lookup itself stays one directory deep — the same rule as Zed's Python
/// extension. `bin/python` has to exist, otherwise it is just a directory with
/// the same name.
pub fn find_python_venv(root: &Path) -> Option<PathBuf> {
    [".venv", "venv"]
        .iter()
        .map(|name| root.join(name))
        .find(|dir| venv_interpreter(dir).is_some())
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

/// One language server instance: its language plus the workspace root it was
/// started in (the project root for every language but Python, the subproject
/// for Python — see [`server_root`]).
type ClientKey = (String, PathBuf);

/// The set of language servers of one project.
pub struct LspManager {
    pub root: PathBuf,
    /// (language, workspace root) → client.
    ///
    /// One entry per language for everything but Python. Python gets one per
    /// subproject, because each subproject has its own virtual environment and
    /// a process can only carry one `VIRTUAL_ENV`. The map is shared with the
    /// sinks (`Arc`), which use it to answer "is this language still served"
    /// when one instance exits.
    clients: Arc<Mutex<HashMap<ClientKey, Arc<LspClient>>>>,
}

impl LspManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Gets the client of (language, workspace root), if it was ever started.
    pub fn get(&self, language: &str, workspace: &Path) -> Option<Arc<LspClient>> {
        self.clients.lock().ok().and_then(|m| {
            m.get(&(language.to_string(), workspace.to_path_buf()))
                .cloned()
        })
    }

    /// Any live client of this language.
    ///
    /// For requests that carry no document (`workspace/symbol`): with a server
    /// per subproject there may be several, and any of them answers a
    /// workspace-wide symbol search.
    pub fn live_of(&self, language: &str) -> Option<Arc<LspClient>> {
        let map = self.clients.lock().ok()?;
        map.iter()
            .find(|((lang, _), client)| {
                lang == language && client.alive.load(std::sync::atomic::Ordering::Relaxed)
            })
            .map(|(_, client)| client.clone())
    }

    /// Whether the language has at least one live client.
    pub fn has_any(&self, language: &str) -> bool {
        self.live_of(language).is_some()
    }

    /// Makes sure the server serving `workspace` is running; returns the live
    /// one right away if it already is.
    ///
    /// Concurrent first requests each spawn one process, so the map is
    /// re-checked before insertion: only the live one is kept, the others are
    /// stopped immediately (no zombie processes left behind).
    pub async fn ensure(
        &self,
        language: &str,
        workspace: &Path,
        config: &ServerConfig,
        app: tauri::AppHandle,
    ) -> Result<Arc<LspClient>, String> {
        let key: ClientKey = (language.to_string(), workspace.to_path_buf());
        if let Some(c) = self.get(language, workspace) {
            if c.alive.load(std::sync::atomic::Ordering::Relaxed) {
                return Ok(c);
            }
        }
        let sink = Arc::new(CodeSink {
            app: app.clone(),
            // Diagnostics stay relative to the project: the front end keys
            // them by project-relative path.
            root: self.root.clone(),
            workspace: workspace.to_path_buf(),
            settings: python_environment_settings(language, workspace),
            clients: self.clients.clone(),
        });
        let spec = ServerSpec {
            command: config.command.clone(),
            args: config.args.clone(),
            env: config
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            cwd: Some(workspace.to_path_buf()),
            language_id: language.to_string(),
            initialization_options: config.init_options.clone(),
            settings: None,
            pull_diagnostics: false,
        };
        // The client's project_root is the workspace: rootUri and
        // workspaceFolders decide where the server looks for first-party code,
        // and ty searched the opened folder (not the subproject) before.
        let client = LspClient::spawn(&spec, workspace.to_path_buf(), sink).await?;
        client.initialize(&spec).await?;
        let mut map = self.clients.lock().map_err(|_| "lock poisoned")?;
        match map.get(&key) {
            Some(existing) if existing.alive.load(std::sync::atomic::Ordering::Relaxed) => {
                // Somebody else won the race: stop the one we started and use
                // theirs.
                client.stop();
                Ok(existing.clone())
            }
            _ => {
                map.insert(key, client.clone());
                let _ = app.emit(
                    "code-lsp-status",
                    json!({
                        "root": self.root.to_string_lossy(),
                        "language": language,
                        "workspace": workspace.to_string_lossy(),
                        "state": "running",
                    }),
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

/// The workspace configuration handed to ty: the subproject's virtual
/// environment as `pythonExtension.activeEnvironment` (the shape Zed uses, and
/// the same one the markdown-embedded Python chain already sends).
///
/// `VIRTUAL_ENV` in the child environment says the same thing; this makes it
/// explicit in the protocol and keeps working when the server is started from
/// a workspace whose root is not the venv's parent.
fn python_environment_settings(language: &str, workspace: &Path) -> Value {
    if language != "python" {
        return Value::Null;
    }
    let Some(venv) = find_python_venv(workspace) else {
        return json!({});
    };
    let Some(python) = venv_interpreter(&venv) else {
        return json!({});
    };
    let sys_prefix = python.parent().and_then(Path::parent).unwrap_or(&venv);
    json!({
        "pythonExtension": {
            "activeEnvironment": {
                "executable": {
                    "uri": crate::lsp::path_to_uri(&python),
                    "sysPrefix": sys_prefix.to_string_lossy(),
                }
            }
        }
    })
}

/// Message handling for a code project: forwards diagnostics, forwards logs,
/// answers the requests the server initiates.
struct CodeSink {
    app: tauri::AppHandle,
    /// The project root (the sandbox): diagnostics are reported relative to it.
    root: PathBuf,
    /// The workspace root this server was started in (Python: the subproject).
    workspace: PathBuf,
    /// The `workspace/configuration` payload this server needs (ty's
    /// activeEnvironment); `Null` for every language that needs none.
    settings: Value,
    /// The live clients, shared with the manager: "stopped" may only be
    /// reported once no other server of the same language is alive (Python
    /// runs one per subproject).
    clients: Arc<Mutex<HashMap<ClientKey, Arc<LspClient>>>>,
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

    /// Reply to `workspace/configuration`: one entry per requested item (one
    /// entry less would let the server read out of bounds by index). Only the
    /// `ty` section carries anything (the activeEnvironment); everything else
    /// stays null, as before.
    fn configuration_reply(&self, msg: &Value) -> Value {
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
                    if (section.is_empty() || section == "ty") && !self.settings.is_null() {
                        self.settings.clone()
                    } else {
                        Value::Null
                    }
                })
                .collect(),
        )
    }

    /// Reply to `workspace/workspaceFolders`: the workspace this server was
    /// started in (the subproject for Python).
    fn workspace_folders(&self) -> Value {
        json!([{
            "uri": path_to_uri(&self.workspace),
            "name": self.workspace
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        }])
    }

    /// The state the front end should show for this language after one of its
    /// servers exited: "running" while another instance of the same language is
    /// still alive (Python runs one per subproject), otherwise "stopped".
    ///
    /// Dead entries are dropped on the way: the map must not keep corpses that
    /// `get` would hand out.
    fn state_after_exit(&self, language: &str) -> &'static str {
        let Ok(mut map) = self.clients.lock() else {
            return "stopped";
        };
        map.retain(|_, client| client.alive.load(std::sync::atomic::Ordering::Relaxed));
        if map.keys().any(|(lang, _)| lang == language) {
            "running"
        } else {
            "stopped"
        }
    }
}

impl LspSink for CodeSink {
    fn on_message<'a>(&'a self, client: &'a LspClient, msg: Value) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let id = msg.get("id").cloned();
            let method = msg
                .get("method")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            match (id, method) {
                // A server → client request: answer each with what it expects.
                (Some(id), Some(method)) => {
                    let result = match method.as_str() {
                        "workspace/configuration" => self.configuration_reply(&msg),
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
                    // the front end keeps believing it is alive. With a server
                    // per subproject the language may still be served by
                    // another instance.
                    "$bnote/serverExit" => {
                        let _ = self.app.emit(
                            "code-lsp-status",
                            json!({
                                "root": self.root.to_string_lossy(),
                                "language": client.language_id,
                                "workspace": self.workspace.to_string_lossy(),
                                "state": self.state_after_exit(&client.language_id),
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
        let dir =
            std::env::temp_dir().join(format!("bnote-codelsp-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn builtin_covers_the_four_core_languages() {
        assert_eq!(
            builtin_server("typescript").unwrap().command,
            "typescript-language-server"
        );
        assert_eq!(
            builtin_server("typescript").unwrap().args,
            vec!["--stdio".to_string()]
        );
        assert_eq!(builtin_server("rust").unwrap().command, "rust-analyzer");
        assert_eq!(builtin_server("go").unwrap().command, "gopls");
        assert_eq!(builtin_server("python").unwrap().command, "ty");
        assert_eq!(
            builtin_server("python").unwrap().args,
            vec!["server".to_string()]
        );
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
        let r = resolve_server(&root, "go", "", None).unwrap();
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
        let r = resolve_server(&root, "go", "", Some(&global)).unwrap();
        assert_eq!(r.config.command, "project-go");
        // A language the project does not override takes the global layer.
        let r = resolve_server(&root, "rust", "", Some(&global)).unwrap();
        assert_eq!(r.config.command, "global-go");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disabled_language_resolves_to_disabled() {
        let root = tmpdir("disabled");
        std::fs::create_dir_all(root.join(".bnote")).unwrap();
        std::fs::write(root.join(".bnote/lsp.json"), r#"{"disabled":["python"]}"#).unwrap();
        let r = resolve_server(&root, "python", "", None).unwrap();
        assert!(r.disabled);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_project_config_is_ignored() {
        let root = tmpdir("broken");
        std::fs::create_dir_all(root.join(".bnote")).unwrap();
        std::fs::write(root.join(".bnote/lsp.json"), "{ not json").unwrap();
        let r = resolve_server(&root, "rust", "", None).unwrap();
        assert_eq!(r.config.command, "rust-analyzer");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn python_uses_root_venv_when_present() {
        let root = tmpdir("venv");
        std::fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::fs::write(root.join(".venv/bin/python"), "").unwrap();
        let r = resolve_server(&root, "python", "", None).unwrap();
        let venv = root.join(".venv").to_string_lossy().to_string();
        assert_eq!(r.config.env.get("VIRTUAL_ENV"), Some(&venv));
        let path = r
            .config
            .env
            .get("PATH")
            .expect("PATH must be prefixed with the venv bin");
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
        let r = resolve_server(&root, "python", "", None).unwrap();
        assert_eq!(
            r.config.env.get("VIRTUAL_ENV"),
            Some(&root.join("venv").to_string_lossy().to_string())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn python_without_venv_gets_no_env_override() {
        let root = tmpdir("novenv");
        let r = resolve_server(&root, "python", "", None).unwrap();
        assert!(r.config.env.is_empty());
        // Other languages never touch the venv (it is not injected even when the
        // venv directory exists).
        std::fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::fs::write(root.join(".venv/bin/python"), "").unwrap();
        let r = resolve_server(&root, "rust", "", None).unwrap();
        assert!(r.config.env.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The repository of several assignments, each with its own venv: opening
    /// the parent has to serve every subproject (the reported torch bug).
    fn multi_project(name: &str) -> PathBuf {
        let root = tmpdir(name);
        for (dir, module) in [("assignment1", "torch"), ("assignment2", "einops")] {
            let venv = root.join(dir).join(".venv/bin");
            std::fs::create_dir_all(&venv).unwrap();
            std::fs::write(venv.join("python"), "").unwrap();
            std::fs::write(root.join(dir).join("pyproject.toml"), "").unwrap();
            std::fs::create_dir_all(root.join(dir).join("pkg")).unwrap();
            std::fs::write(root.join(dir).join("pkg").join(format!("{module}.py")), "").unwrap();
        }
        root
    }

    #[test]
    fn a_file_resolves_to_its_own_subproject() {
        let root = multi_project("subproject");
        // A file two levels down still resolves to the assignment that owns it.
        assert_eq!(
            server_root(&root, "python", "assignment1/pkg/torch.py"),
            root.join("assignment1")
        );
        assert_eq!(
            server_root(&root, "python", "assignment2/pkg/einops.py"),
            root.join("assignment2")
        );
        // The venv handed to ty is that subproject's, not the project's.
        let r = resolve_server(&root, "python", "assignment2/pkg/einops.py", None).unwrap();
        assert_eq!(
            r.config.env.get("VIRTUAL_ENV"),
            Some(&root.join("assignment2/.venv").to_string_lossy().to_string())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_without_a_manifest_or_venv_above_falls_back_to_the_project() {
        let root = multi_project("fallback");
        std::fs::write(root.join("loose.py"), "").unwrap();
        assert_eq!(server_root(&root, "python", "loose.py"), root);
        // A directory that is neither a project nor holds a venv does not stop
        // the walk: the nearest ancestor that qualifies wins.
        std::fs::create_dir_all(root.join("scratch")).unwrap();
        assert_eq!(server_root(&root, "python", "scratch/try.py"), root);
        // Other languages never split: one server per project.
        assert_eq!(
            server_root(&root, "typescript", "assignment1/pkg/a.ts"),
            root
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_root_venv_still_wins_for_files_at_the_root() {
        let root = multi_project("rootvenv");
        let venv = root.join(".venv/bin");
        std::fs::create_dir_all(&venv).unwrap();
        std::fs::write(venv.join("python"), "").unwrap();
        assert_eq!(server_root(&root, "python", "run.py"), root);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ty_gets_the_subproject_environment_as_active_environment() {
        let root = multi_project("activeenv");
        let settings = python_environment_settings("python", &root.join("assignment1"));
        let env = settings
            .pointer("/pythonExtension/activeEnvironment/executable/uri")
            .and_then(Value::as_str)
            .expect("the activeEnvironment must name the interpreter");
        assert!(env.ends_with("assignment1/.venv/bin/python"), "{}", env);
        assert_eq!(
            settings
                .pointer("/pythonExtension/activeEnvironment/executable/sysPrefix")
                .and_then(Value::as_str),
            Some(root.join("assignment1/.venv").to_string_lossy().as_ref())
        );
        // No venv, no configuration: ty probes the workspace itself.
        assert_eq!(python_environment_settings("python", &root), json!({}));
        // Non-Python servers get nothing at all.
        assert!(python_environment_settings("rust", &root.join("assignment1")).is_null());
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
        let r = resolve_server(&root, "python", "", None).unwrap();
        assert_eq!(
            r.config.env.get("VIRTUAL_ENV").map(String::as_str),
            Some("/opt/py")
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
