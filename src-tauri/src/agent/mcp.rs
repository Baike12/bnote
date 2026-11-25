//! Minimal MCP client: stdio (JSON-RPC over process stdio) and streamable HTTP.
//! Lifecycle: initialize → initialized → tools/list → tools/call.

use super::McpServerConfig;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Upper bound for one stdio request round trip. A server that accepted the
/// spawn but never answers (a wrong command, a missing runtime, a server that
/// waits on a TTY) would otherwise hang `agent_start_session` forever with no
/// way to cancel from the UI. The HTTP transport has its own timeout.
const STDIO_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Timeout of one HTTP MCP request: the server's own `timeoutsMs` (clamped to
/// something a person can wait for), 60s when unset.
fn http_timeout(timeouts_ms: Option<u64>) -> std::time::Duration {
    std::time::Duration::from_millis(timeouts_ms.unwrap_or(60_000).clamp(1_000, 600_000))
}

/// The JSON-RPC response with `id` out of a `text/event-stream` body.
///
/// SSE frames are `data:` lines (several of them join into one payload with
/// newlines) separated by blank lines, and a stream may carry heartbeats,
/// progress notifications and other requests' responses before ours. Taking
/// the last `data:` line — the old parser — read half a payload as JSON and
/// silently accepted an unrelated event, so an id has to be matched.
fn parse_sse_response(body: &str, id: u64) -> Result<Value, String> {
    let mut events: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            current.push(rest.strip_prefix(' ').unwrap_or(rest));
        } else if line.trim().is_empty() && !current.is_empty() {
            events.push(current.join("\n"));
            current.clear();
        }
        // `id:`, `retry:`, `event:` and `:` comments carry no payload.
    }
    if !current.is_empty() {
        events.push(current.join("\n"));
    }
    let mut first_error: Option<String> = None;
    for event in events {
        if event.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&event) {
            Ok(v) => v,
            Err(e) => {
                first_error.get_or_insert(e.to_string());
                continue;
            }
        };
        if value["id"] == json!(id) {
            return Ok(value);
        }
    }
    Err(match first_error {
        Some(e) => format!("parse event stream: {e}"),
        None => format!("no response for request {id} in the event stream"),
    })
}

pub struct McpTool {
    pub name: String, // fully qualified: mcp__<server>__<tool>
    pub description: String,
    pub input_schema: Value,
}

/// One row of the settings page's MCP list: the configured server, the scope
/// it was defined in, and the result of the live check that produced this
/// snapshot. `state` is `connected`, `error`, `disabled` (the entry is kept in
/// the file but not started), `untrusted` (a project-scope server whose
/// definition the user has not approved) or `unused` (the session's tool set
/// has no MCP).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub scope: String,
    pub source: String,
    pub transport: String,
    pub target: String,
    pub enabled: bool,
    /// Whether a session would be allowed to start it (see `trust.rs`).
    pub trusted: bool,
    pub state: String,
    pub tools: usize,
    pub error: Option<String>,
}

/// Upper bound on one MCP tool description. A server's descriptions travel in
/// the request's tool block, so one huge description would cost that budget on
/// every turn; the cap is the same 2 KB CC applies.
const MAX_DESCRIPTION: usize = 2048;

/// Whitespace collapsed and cut at [`MAX_DESCRIPTION`] characters, suffix
/// included, so re-running it on its own output changes nothing.
fn capped_description(description: &str) -> String {
    const SUFFIX: &str = " …[truncated]";
    let collapsed = description.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_DESCRIPTION {
        return collapsed;
    }
    let keep = MAX_DESCRIPTION.saturating_sub(SUFFIX.chars().count());
    let mut cut: String = collapsed.chars().take(keep).collect();
    cut.push_str(SUFFIX);
    cut
}

/// Sorts the catalog by qualified name, drops duplicate names (the first keeps
/// its definition), and caps every description. Two sessions against the same
/// servers then hold byte-identical catalogs, whatever order `tools/list`
/// answered in, so an unchanged server produces an unchanged tool block.
pub fn normalize_tools(mut tools: Vec<McpTool>) -> Vec<McpTool> {
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    tools.dedup_by(|left, right| left.name == right.name);
    for tool in &mut tools {
        tool.description = capped_description(&tool.description);
    }
    tools
}

/// `mcp__<server>__<tool>` split into its two halves. The server name can
/// contain a single underscore; only `__` separates.
pub fn split_name(qualified: &str) -> Option<(&str, &str)> {
    let rest = qualified.strip_prefix("mcp__")?;
    rest.split_once("__")
}

fn describe(cfg: &McpServerConfig) -> (&'static str, String) {
    match cfg {
        McpServerConfig::Stdio { command, args, .. } => {
            let mut target = command.clone();
            for arg in args {
                target.push(' ');
                target.push_str(arg);
            }
            ("stdio", target)
        }
        McpServerConfig::Http { url, .. } => ("http", url.clone()),
    }
}

/// One real status check: spawn/initialize, list tools, then drop the
/// connection (dropping a stdio connection kills its child, so a check never
/// leaves a server running).
async fn check(name: &str, cfg: &McpServerConfig) -> (usize, Option<String>) {
    match McpConnection::connect(name, cfg).await {
        Ok(mut conn) => match conn.list_tools().await {
            Ok(tools) => (tools.len(), None),
            Err(error) => (0, Some(error)),
        },
        Err(error) => (0, Some(error)),
    }
}

/// Checks every enabled server concurrently and returns one row per configured
/// server, in name order. Concurrency matters: a dead stdio server costs the
/// full 30s handshake timeout, and a settings page that opens after N of them
/// in sequence would look frozen. An untrusted project server is never spawned
/// (`trust.rs`): the check would otherwise run a command the user has not
/// approved.
pub async fn probe_all(
    servers: &std::collections::BTreeMap<String, McpServerConfig>,
    disabled: &[String],
    sources: &std::collections::BTreeMap<String, super::settings::McpSource>,
    trust: &super::trust::TrustStore,
    mcp_enabled: bool,
) -> Vec<McpServerStatus> {
    let trusted_of = |name: &str, cfg: &McpServerConfig| {
        let scope = sources
            .get(name)
            .map(|source| source.scope)
            .unwrap_or(super::settings::McpScope::User);
        trust.is_trusted(name, cfg, scope)
    };
    let checks = servers
        .iter()
        .filter(|(name, cfg)| {
            mcp_enabled && !disabled.iter().any(|d| d == *name) && trusted_of(name, cfg)
        })
        .map(|(name, cfg)| async move {
            let (tools, error) = check(name, cfg).await;
            (name.clone(), tools, error)
        });
    let results: HashMap<String, (usize, Option<String>)> = futures::future::join_all(checks)
        .await
        .into_iter()
        .map(|(name, tools, error)| (name, (tools, error)))
        .collect();
    servers
        .iter()
        .map(|(name, cfg)| {
            let (transport, target) = describe(cfg);
            let source = sources.get(name);
            let enabled = !disabled.iter().any(|d| d == name);
            let trusted = trusted_of(name, cfg);
            // A configured-but-disabled server keeps its "disabled" state even
            // when the mode has no MCP tool; "untrusted" is what the project
            // scope needs before it may run; "unused" explains why an enabled
            // server of such a mode was never started.
            let (state, tools, error) = if !enabled {
                ("disabled", 0, None)
            } else if !trusted {
                ("untrusted", 0, None)
            } else if !mcp_enabled {
                ("unused", 0, None)
            } else {
                match results.get(name) {
                    Some((_, Some(error))) => ("error", 0, Some(error.clone())),
                    Some((tools, None)) => ("connected", *tools, None),
                    None => ("unused", 0, None),
                }
            };
            McpServerStatus {
                name: name.clone(),
                scope: source.map(|s| s.scope.id()).unwrap_or("user").to_string(),
                source: source
                    .map(|s| s.path.to_string_lossy().to_string())
                    .unwrap_or_default(),
                transport: transport.to_string(),
                target,
                enabled,
                trusted,
                state: state.to_string(),
                tools,
                error,
            }
        })
        .collect()
}

enum Transport {
    Stdio {
        child: tokio::process::Child,
        stdin: tokio::process::ChildStdin,
        reader: BufReader<tokio::process::ChildStdout>,
        next_id: u64,
        /// Set once a read times out or fails: the stream may hold a partially
        /// consumed line, so it can never be trusted again.
        dead: bool,
    },
    Http {
        url: String,
        headers: std::collections::BTreeMap<String, String>,
        next_id: u64,
        /// The `Mcp-Session-Id` the server returned at initialize. Streamable
        /// HTTP servers reject every later request without it (422 "expected
        /// initialize"), so it has to be echoed on each call — that missing
        /// header is why a configured server never connected before.
        session_id: Option<String>,
        client: reqwest::Client,
    },
}

pub struct McpConnection {
    server_name: String,
    transport: Transport,
}

impl McpConnection {
    pub async fn connect(
        server_name: &str,
        cfg: &McpServerConfig,
    ) -> Result<McpConnection, String> {
        let transport = match cfg {
            McpServerConfig::Stdio { command, args, env } => {
                let mut cmd = tokio::process::Command::new(command);
                cmd.args(args)
                    .envs(env)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null());
                // MCP stdio servers need plain text framing
                cmd.env("MCP_MODE", "stdio");
                let mut child = cmd
                    .spawn()
                    .map_err(|e| format!("mcp spawn {}: {}", command, e))?;
                let stdin = child.stdin.take().ok_or("no stdin")?;
                let stdout = child.stdout.take().ok_or("no stdout")?;
                let reader = BufReader::new(stdout);
                Transport::Stdio {
                    child,
                    stdin,
                    reader,
                    next_id: 1,
                    dead: false,
                }
            }
            McpServerConfig::Http {
                url,
                headers,
                timeouts_ms,
            } => {
                let timeout = http_timeout(*timeouts_ms);
                let client = reqwest::Client::builder()
                    .timeout(timeout)
                    .build()
                    .map_err(|e| format!("mcp http client: {}", e))?;
                Transport::Http {
                    url: url.clone(),
                    headers: headers.clone(),
                    next_id: 1,
                    session_id: None,
                    client,
                }
            }
        };
        let mut conn = McpConnection {
            server_name: server_name.to_string(),
            transport,
        };
        // initialize handshake
        let result = conn
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "bnote", "version": "0.1.0"}
                }),
            )
            .await;
        if let Err(e) = result {
            return Err(format!("mcp initialize: {}", e));
        }
        let _ = conn.notify("notifications/initialized", json!({})).await;
        Ok(conn)
    }

    pub async fn list_tools(&mut self) -> Result<Vec<(String, String, Value)>, String> {
        let resp = self.request("tools/list", json!({})).await?;
        let mut out = Vec::new();
        if let Some(tools) = resp["tools"].as_array() {
            for t in tools {
                out.push((
                    t["name"].as_str().unwrap_or_default().to_string(),
                    t["description"].as_str().unwrap_or_default().to_string(),
                    t["inputSchema"].clone(),
                ));
            }
        }
        Ok(out)
    }

    /// Returns `(text, is_error)`: the MCP `isError` flag is part of the
    /// protocol and must reach the model as a failed tool result, not as a
    /// success with an "error:" prefix.
    pub async fn call_tool(&mut self, tool: &str, args: &Value) -> Result<(String, bool), String> {
        let resp = self
            .request("tools/call", json!({"name": tool, "arguments": args}))
            .await?;
        if let Some(err) = resp["error"].as_object() {
            return Ok((
                format!(
                    "mcp error: {}",
                    err.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown")
                ),
                true,
            ));
        }
        let mut text = String::new();
        if let Some(content) = resp["content"].as_array() {
            for c in content {
                if c["type"] == "text" {
                    text.push_str(c["text"].as_str().unwrap_or_default());
                } else {
                    text.push_str(&format!(
                        "[{} content]",
                        c["type"].as_str().unwrap_or("other")
                    ));
                }
            }
        }
        let is_error = resp["isError"].as_bool().unwrap_or(false);
        Ok((text, is_error))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match &mut self.transport {
            Transport::Stdio {
                child,
                stdin,
                reader,
                next_id,
                dead,
            } => {
                if *dead {
                    return Err("mcp stdio: connection is dead after a failed read".into());
                }
                let id = *next_id;
                *next_id += 1;
                let req = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params,
                });
                stdin
                    .write_all(format!("{}\n", req).as_bytes())
                    .await
                    .map_err(|e| format!("write: {}", e))?;
                stdin.flush().await.map_err(|e| format!("flush: {}", e))?;
                // read lines until a response with our id (skip notifications)
                loop {
                    let mut line = String::new();
                    // A timed out `read_line` may have consumed part of a line,
                    // so the connection is retired instead of being reused.
                    let n = match tokio::time::timeout(
                        STDIO_REQUEST_TIMEOUT,
                        reader.read_line(&mut line),
                    )
                    .await
                    {
                        Ok(Ok(n)) => n,
                        Ok(Err(e)) => {
                            *dead = true;
                            let _ = child.start_kill(); // best effort: the transport is already unusable
                            return Err(format!("read: {}", e));
                        }
                        Err(_) => {
                            *dead = true;
                            let _ = child.start_kill();
                            return Err(format!(
                                "mcp stdio: no response within {}s",
                                STDIO_REQUEST_TIMEOUT.as_secs()
                            ));
                        }
                    };
                    if n == 0 {
                        return Err("server closed".into());
                    }
                    let v: Value = match serde_json::from_str(line.trim()) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if v["id"] == json!(id) {
                        if let Some(err) = v["error"].as_object() {
                            return Err(err
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("unknown error")
                                .to_string());
                        }
                        return Ok(v["result"].clone());
                    }
                    // notifications / requests from the server are ignored
                }
            }
            Transport::Http {
                url,
                headers,
                next_id,
                session_id,
                client,
            } => {
                let id = *next_id;
                *next_id += 1;
                let req = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params,
                });
                let mut rb = client
                    .post(url.as_str())
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .header("mcp-protocol-version", "2024-11-05")
                    .body(req.to_string());
                // The session the server handed out at initialize has to ride
                // on every later request: a streamable HTTP server answers
                // "422 Unexpected message, expect initialize request" without
                // it, which is how a working server looked broken.
                if let Some(sid) = session_id.as_deref() {
                    rb = rb.header("mcp-session-id", sid);
                }
                for (k, v) in headers.iter() {
                    rb = rb.header(k.as_str(), v.as_str());
                }
                let resp = rb.send().await.map_err(|e| format!("http: {}", e))?;
                let status = resp.status();
                if let Some(sid) = resp
                    .headers()
                    .get("mcp-session-id")
                    .and_then(|v| v.to_str().ok())
                {
                    *session_id = Some(sid.to_string());
                }
                let content_type = resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let body = resp.text().await.map_err(|e| format!("body: {}", e))?;
                if !status.is_success() {
                    return Err(format!("HTTP {}: {}", status, &body[..body.len().min(300)]));
                }
                let v = if content_type.contains("text/event-stream") {
                    parse_sse_response(&body, id)?
                } else {
                    let v: Value =
                        serde_json::from_str(&body).map_err(|e| format!("parse: {}", e))?;
                    if v["id"] != json!(id) {
                        return Err(format!("response id {} for request {id}", v["id"]));
                    }
                    v
                };
                if let Some(err) = v["error"].as_object() {
                    return Err(err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown")
                        .to_string());
                }
                Ok(v["result"].clone())
            }
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        match &mut self.transport {
            Transport::Stdio { stdin, .. } => {
                let note = json!({"jsonrpc": "2.0", "method": method, "params": params});
                stdin
                    .write_all(format!("{}\n", note).as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())
            }
            // `notifications/initialized` is not optional: servers gate the
            // tool list on it, and it carries the session like any other call
            // (the server answers 202 with no body, which is a success).
            Transport::Http {
                url,
                headers,
                session_id,
                client,
                ..
            } => {
                let note = json!({"jsonrpc": "2.0", "method": method, "params": params});
                let mut rb = client
                    .post(url.as_str())
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .header("mcp-protocol-version", "2024-11-05")
                    .body(note.to_string());
                if let Some(sid) = session_id.as_deref() {
                    rb = rb.header("mcp-session-id", sid);
                }
                for (k, v) in headers.iter() {
                    rb = rb.header(k.as_str(), v.as_str());
                }
                let resp = rb.send().await.map_err(|e| format!("http: {}", e))?;
                if !resp.status().is_success() {
                    return Err(format!("HTTP {} notify", resp.status()));
                }
                Ok(())
            }
        }
    }
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        if let Transport::Stdio { child, .. } = &mut self.transport {
            let _ = child.start_kill();
        }
    }
}

/// All MCP connections for the app, keyed by server name.
pub struct McpManager {
    pub connections: HashMap<String, Arc<tokio::sync::Mutex<McpConnection>>>,
    /// The definitions the connections were built from. A transport can die
    /// under a running session (a streamable HTTP server sweeps idle sessions),
    /// and the replacement is built from the same approved definition.
    servers: std::collections::BTreeMap<String, McpServerConfig>,
    /// The catalog is not fixed for the life of the session: a reconnect
    /// replaces the reconnecting server's rows, so the next request declares
    /// the tools the server actually has now.
    tools: std::sync::RwLock<Vec<McpTool>>,
    pub errors: Vec<String>,
}

/// One catalog row for a server's tool, named the way the model calls it.
fn mcp_tool(server: &str, tool: &str, description: &str, schema: Value) -> McpTool {
    McpTool {
        name: format!("mcp__{}__{}", server, tool),
        description: if description.is_empty() {
            format!("MCP tool {} from server {}", tool, server)
        } else {
            description.to_string()
        },
        input_schema: schema,
    }
}

/// Whether an error is the transport having forgotten the session rather than
/// the server refusing the call. rmcp (the Rust MCP SDK BrowserOS serves with)
/// answers `404 Session not found` once an idle session was swept, and
/// `422 Unexpected message, expect initialize request` when the id is missing.
/// Both mean the same thing: this connection needs a new handshake.
fn is_stale_session(error: &str) -> bool {
    error.contains("Session not found") || error.contains("expect initialize request")
}

impl McpManager {
    /// Connects to every enabled server of one mode and lists their tools.
    /// A server listed in `disabled` stays in the settings file (the toggle
    /// keeps the entry) but is not started.
    pub async fn connect_all(
        servers: &std::collections::BTreeMap<String, super::McpServerConfig>,
        disabled: &[String],
    ) -> McpManager {
        let mut connections = HashMap::new();
        let mut tools = Vec::new();
        let mut errors = Vec::new();
        for (name, server_cfg) in servers {
            if disabled.iter().any(|d| d == name) {
                continue;
            }
            match McpConnection::connect(name, server_cfg).await {
                Ok(conn) => {
                    let conn = Arc::new(tokio::sync::Mutex::new(conn));
                    let mut c = conn.lock().await;
                    match c.list_tools().await {
                        Ok(list) => {
                            for (tool, desc, schema) in list {
                                tools.push(mcp_tool(name, &tool, &desc, schema));
                            }
                        }
                        Err(e) => errors.push(format!("{}: {}", name, e)),
                    }
                    connections.insert(name.clone(), conn.clone());
                }
                Err(e) => errors.push(format!("{}: {}", name, e)),
            }
        }
        McpManager {
            connections,
            servers: servers.clone(),
            tools: std::sync::RwLock::new(normalize_tools(tools)),
            errors,
        }
    }

    /// The manager of a session whose tool set has no MCP entry: no connection,
    /// no catalog, nothing to reconnect.
    pub fn empty() -> McpManager {
        McpManager {
            connections: HashMap::new(),
            servers: std::collections::BTreeMap::new(),
            tools: std::sync::RwLock::new(Vec::new()),
            errors: Vec::new(),
        }
    }

    /// The catalog a request declares. A read guard, so a caller that only
    /// needs the names does not copy the schemas.
    pub fn tools(&self) -> std::sync::RwLockReadGuard<'_, Vec<McpTool>> {
        self.tools.read().unwrap_or_else(|e| e.into_inner())
    }

    /// A manager holding a fixed catalog, for tests that only need the tool
    /// definitions (no connection, no server).
    #[cfg(test)]
    pub fn with_tools(tools: Vec<McpTool>) -> McpManager {
        let mut manager = McpManager::empty();
        manager.tools = std::sync::RwLock::new(normalize_tools(tools));
        manager
    }

    pub async fn call(
        &self,
        server: &str,
        tool: &str,
        args: &Value,
    ) -> Result<(String, bool), String> {
        let conn = self
            .connections
            .get(server)
            .ok_or_else(|| format!("unknown mcp server: {}", server))?;
        let mut c = conn.lock().await;
        match c.call_tool(tool, args).await {
            Err(error) if is_stale_session(&error) => {
                // The session is server state with its own lifetime; the client
                // owns it. Re-handshake, take the server's current catalog (its
                // tools may have changed with the process), then retry the same
                // call once. Without this the whole session stays broken after
                // one idle sweep: every later call re-sends the dead id.
                let Some(cfg) = self.servers.get(server) else {
                    return Err(error);
                };
                let mut fresh = match McpConnection::connect(server, cfg).await {
                    Ok(conn) => conn,
                    Err(e) => return Err(format!("{}; 重连 {} 失败: {}", error, server, e)),
                };
                match fresh.list_tools().await {
                    Ok(list) => self.replace_server_tools(server, list),
                    Err(e) => return Err(format!("{}; 重连后取工具列表失败: {}", error, e)),
                }
                *c = fresh;
                c.call_tool(tool, args).await
            }
            other => other,
        }
    }

    /// Swap one server's rows for the catalog a fresh `tools/list` returned.
    /// Rows keep the module's stability rule (sorted, deduplicated, capped) so
    /// an unchanged server still produces identical bytes.
    fn replace_server_tools(&self, server: &str, list: Vec<(String, String, Value)>) {
        let prefix = format!("mcp__{}__", server);
        let mut tools = self.tools.write().unwrap_or_else(|e| e.into_inner());
        tools.retain(|tool| !tool.name.starts_with(&prefix));
        for (tool, desc, schema) in list {
            tools.push(mcp_tool(server, &tool, &desc, schema));
        }
        *tools = normalize_tools(std::mem::take(&mut *tools));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn the_sse_parser_matches_the_response_id_not_the_last_data_line() {
        // BrowserOS's real shape: an empty heartbeat event first, then the reply.
        let body = "data: \nid: 0\nretry: 3000\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
        let v = parse_sse_response(body, 7).expect("the reply is in the second event");
        assert_eq!(v["result"]["ok"], true);
    }

    #[test]
    fn the_sse_parser_joins_multi_line_data_and_skips_notifications() {
        let body = concat!(
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n",
            "data: {\"jsonrpc\":\"2.0\",\n",
            "data: \"id\":9,\"result\":{\"tools\":[]}}\n\n",
        );
        let v = parse_sse_response(body, 9).expect("multi-line data is one payload");
        assert!(v["result"]["tools"].is_array());
    }

    #[test]
    fn the_sse_parser_refuses_a_stream_without_our_response() {
        let e = parse_sse_response("data: {\"id\":1}\n\n", 4).unwrap_err();
        assert!(e.contains("no response for request 4"), "{e}");
    }

    #[test]
    fn the_per_server_timeout_is_honoured_and_clamped() {
        assert_eq!(http_timeout(None), std::time::Duration::from_secs(60));
        assert_eq!(
            http_timeout(Some(120_000)),
            std::time::Duration::from_secs(120)
        );
        assert_eq!(http_timeout(Some(0)), std::time::Duration::from_secs(1));
    }

    /// Reads one HTTP/1.1 request: the head plus `content-length` bytes of body.
    async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<(String, String)> {
        let mut buf = Vec::new();
        loop {
            let mut chunk = [0u8; 4096];
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(pos) = text.find("\r\n\r\n") {
                let head = text[..pos].to_string();
                let len = head
                    .lines()
                    .find_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        if k.eq_ignore_ascii_case("content-length") {
                            v.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                let body_start = pos + 4;
                while text.len() < body_start + len {
                    let mut more = [0u8; 4096];
                    let n = stream.read(&mut more).await.ok()?;
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&more[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if text.len() >= body_start + len {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&buf).to_string();
                let body = text.get(body_start..).unwrap_or("").to_string();
                return Some((head, body));
            }
        }
    }

    async fn respond(
        stream: &mut tokio::net::TcpStream,
        status: &str,
        content_type: &str,
        extra: &str,
        body: &str,
    ) {
        let resp = format!(
            "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes()).await;
        let _ = stream.flush().await;
    }

    /// A fake streamable-HTTP MCP server that behaves like the real thing: it
    /// hands out a session at initialize and answers 422 to anything that does
    /// not echo it back.
    async fn fake_mcp_server() -> (String, Arc<std::sync::Mutex<Vec<(String, bool)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let seen: Arc<std::sync::Mutex<Vec<(String, bool)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let Some((head, body)) = read_request(&mut stream).await else {
                    continue;
                };
                let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let method = value["method"].as_str().unwrap_or_default().to_string();
                let has_session = head
                    .to_ascii_lowercase()
                    .contains("mcp-session-id: test-session");
                log.lock()
                    .map(|mut g| g.push((method.clone(), has_session)))
                    .unwrap_or(());
                match method.as_str() {
                    "initialize" => {
                        let body = "data: \nid: 0\nretry: 3000\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{}}}}\n\n";
                        respond(
                            &mut stream,
                            "200 OK",
                            "text/event-stream",
                            "mcp-session-id: test-session\r\n",
                            body,
                        )
                        .await;
                    }
                    _ if !has_session => {
                        respond(
                            &mut stream,
                            "422 Unprocessable Entity",
                            "text/plain",
                            "",
                            "Unexpected message, expect initialize request",
                        )
                        .await;
                    }
                    "notifications/initialized" => {
                        respond(&mut stream, "202 Accepted", "text/plain", "", "").await;
                    }
                    "tools/list" => {
                        let id = value["id"].clone();
                        let body = format!("data: {{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"tools\":[{{\"name\":\"tabs\",\"description\":\"tabs\",\"inputSchema\":{{\"type\":\"object\"}}}}]}}}}\n\n");
                        respond(
                            &mut stream,
                            "200 OK",
                            "text/event-stream",
                            "mcp-session-id: test-session\r\n",
                            &body,
                        )
                        .await;
                    }
                    _ => {
                        respond(&mut stream, "200 OK", "application/json", "", "{}").await;
                    }
                }
            }
        });
        (format!("http://{addr}/mcp"), seen)
    }

    #[tokio::test]
    async fn the_probe_checks_live_servers_and_reports_scope_disabled_and_unused() {
        use crate::agent::settings::{McpScope, McpSource};
        let (url, seen) = fake_mcp_server().await;
        let mut servers = std::collections::BTreeMap::new();
        servers.insert(
            "live".to_string(),
            McpServerConfig::Http {
                url,
                headers: std::collections::BTreeMap::new(),
                timeouts_ms: Some(5_000),
            },
        );
        // Port 1 refuses at once, so a dead server costs no timeout here.
        servers.insert(
            "dead".to_string(),
            McpServerConfig::Http {
                url: "http://127.0.0.1:1/mcp".to_string(),
                headers: std::collections::BTreeMap::new(),
                timeouts_ms: Some(1_000),
            },
        );
        servers.insert(
            "off".to_string(),
            McpServerConfig::Stdio {
                command: "true".to_string(),
                args: Vec::new(),
                env: std::collections::BTreeMap::new(),
            },
        );
        let mut sources = std::collections::BTreeMap::new();
        for (name, scope) in [
            ("live", McpScope::User),
            ("dead", McpScope::Project),
            ("off", McpScope::Local),
        ] {
            sources.insert(
                name.to_string(),
                McpSource {
                    scope,
                    path: std::path::PathBuf::from(format!("/{name}/settings.json")),
                },
            );
        }
        let trust = crate::agent::trust::TrustStore::load_from(
            std::path::Path::new("/tmp/bnote-mcp-probe"),
            None,
        );
        let rows = probe_all(&servers, &["off".to_string()], &sources, &trust, true).await;
        let row = |name: &str| rows.iter().find(|r| r.name == name).expect(name);
        assert_eq!(row("live").state, "connected");
        assert_eq!(row("live").tools, 1);
        assert_eq!(row("live").scope, "user");
        assert_eq!(row("dead").state, "error");
        assert!(row("dead").error.is_some());
        assert_eq!(row("dead").scope, "project");
        assert_eq!(row("off").state, "disabled");
        assert!(!row("off").enabled);
        assert_eq!(row("off").scope, "local");
        let seen = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert!(
            !seen.is_empty(),
            "a live server must be checked, the disabled one must not be started"
        );
    }

    #[tokio::test]
    async fn the_probe_connects_nothing_when_the_mode_has_no_mcp_tool() {
        use crate::agent::settings::{McpScope, McpSource};
        let (url, seen) = fake_mcp_server().await;
        let mut servers = std::collections::BTreeMap::new();
        servers.insert(
            "live".to_string(),
            McpServerConfig::Http {
                url,
                headers: std::collections::BTreeMap::new(),
                timeouts_ms: Some(5_000),
            },
        );
        let mut sources = std::collections::BTreeMap::new();
        sources.insert(
            "live".to_string(),
            McpSource {
                scope: McpScope::User,
                path: std::path::PathBuf::from("/v/settings.json"),
            },
        );
        let trust = crate::agent::trust::TrustStore::load_from(
            std::path::Path::new("/tmp/bnote-mcp-probe"),
            None,
        );
        let rows = probe_all(&servers, &[], &sources, &trust, false).await;
        assert_eq!(rows[0].state, "unused");
        assert!(rows[0].enabled);
        let seen = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert!(seen.is_empty(), "no MCP tool, no connection: {seen:?}");
    }

    fn tool(name: &str, description: &str) -> McpTool {
        McpTool {
            name: name.to_string(),
            description: description.to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }
    }

    #[test]
    fn the_catalog_is_sorted_deduped_and_capped() {
        let long = "x ".repeat(2_000);
        let catalog = normalize_tools(vec![
            tool("mcp__b__z", "second server"),
            tool("mcp__a__y", &long),
            tool("mcp__a__y", "duplicate name, later definition"),
            tool("mcp__a__x", "first tool"),
        ]);
        let names: Vec<&str> = catalog.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["mcp__a__x", "mcp__a__y", "mcp__b__z"]);
        assert_eq!(
            catalog[1].description.chars().count(),
            MAX_DESCRIPTION,
            "a huge description is cut to the cap"
        );
        assert_eq!(
            catalog[1].description,
            normalize_tools(vec![tool("mcp__a__y", &long)])[0].description,
            "normalization is idempotent, so the bytes are stable"
        );
    }

    #[test]
    fn a_qualified_name_splits_into_server_and_tool() {
        assert_eq!(
            split_name("mcp__github__create_issue"),
            Some(("github", "create_issue"))
        );
        assert_eq!(split_name("mcp__my_server__t"), Some(("my_server", "t")));
        assert_eq!(split_name("mcp__broken"), None);
        assert_eq!(split_name("Read"), None);
    }

    #[tokio::test]
    async fn an_unapproved_project_server_is_reported_but_never_started() {
        use crate::agent::settings::{McpScope, McpSource};
        let (url, seen) = fake_mcp_server().await;
        let mut servers = std::collections::BTreeMap::new();
        servers.insert(
            "repo".to_string(),
            McpServerConfig::Http {
                url,
                headers: std::collections::BTreeMap::new(),
                timeouts_ms: Some(5_000),
            },
        );
        let mut sources = std::collections::BTreeMap::new();
        sources.insert(
            "repo".to_string(),
            McpSource {
                scope: McpScope::Project,
                path: std::path::PathBuf::from("/p/.mcp.json"),
            },
        );
        let tag = format!("bnote-mcp-untrusted-{}", std::process::id());
        let home = std::env::temp_dir().join(&tag);
        let trust =
            crate::agent::trust::TrustStore::load_from(&home, Some(std::path::Path::new("/p")));
        let rows = probe_all(&servers, &[], &sources, &trust, true).await;
        assert_eq!(rows[0].state, "untrusted");
        assert!(!rows[0].trusted);
        let seen = seen.lock().map(|g| g.clone()).unwrap_or_default();
        assert!(
            seen.is_empty(),
            "an unapproved server must not be spawned: {seen:?}"
        );
    }

    #[tokio::test]
    async fn an_http_server_connects_and_its_session_rides_on_every_later_request() {
        // The reported failure: the settings held a reachable streamable-HTTP
        // server, yet the panel said the connection failed. The transport never
        // kept the session id, so initialize succeeded and everything after it
        // was rejected with 422.
        let (url, seen) = fake_mcp_server().await;
        let cfg = McpServerConfig::Http {
            url,
            headers: std::collections::BTreeMap::new(),
            timeouts_ms: Some(5_000),
        };
        let mut conn = McpConnection::connect("fake", &cfg).await.expect("connect");
        let tools = conn.list_tools().await.expect("tools/list");
        assert_eq!(tools.len(), 1, "the tool list came back");
        let seen = seen.lock().map(|g| g.clone()).unwrap_or_default();
        let methods: Vec<&str> = seen.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(
            methods,
            vec!["initialize", "notifications/initialized", "tools/list"],
            "the handshake sends initialized and then lists tools"
        );
        assert!(
            seen.iter().skip(1).all(|(_, has)| *has),
            "every request after initialize must echo the session id: {seen:?}"
        );
    }

    #[tokio::test]
    async fn a_swept_session_is_rehandshaked_and_the_call_retried_once() {
        // What BrowserOS neo does after `CLAW_SESSION_IDLE_MS` of silence: the
        // session is swept and the next request with that id answers 404
        // "Session not found". The manager must own the session lifecycle —
        // otherwise one idle sweep breaks every later call in the session.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let methods: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = methods.clone();
        tokio::spawn(async move {
            let mut sessions = 0u32;
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let Some((head, body)) = read_request(&mut stream).await else {
                    continue;
                };
                let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let method = value["method"].as_str().unwrap_or_default().to_string();
                log.lock().map(|mut g| g.push(method.clone())).unwrap_or(());
                let lower = head.to_ascii_lowercase();
                let carries_first = lower.contains("mcp-session-id: session-1");
                match method.as_str() {
                    "initialize" => {
                        sessions += 1;
                        let head = format!("mcp-session-id: session-{}\r\n", sessions);
                        respond(
                            &mut stream,
                            "200 OK",
                            "text/event-stream",
                            &head,
                            "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{}}}}\n\n",
                        )
                        .await;
                    }
                    "tools/call" if carries_first => {
                        // Only the newest session is alive: the first one was
                        // swept, exactly like an idle eviction. The handshake
                        // and the first tools/list had already succeeded.
                        respond(
                            &mut stream,
                            "404 Not Found",
                            "text/plain",
                            "",
                            "Not Found: Session not found",
                        )
                        .await;
                    }
                    "notifications/initialized" => {
                        respond(&mut stream, "202 Accepted", "text/plain", "", "").await
                    }
                    "tools/list" => {
                        let id = value["id"].clone();
                        // The second handshake meets a server that now has two
                        // tools: the catalog must follow.
                        let extra = if sessions > 1 {
                            ",{\"name\":\"run\",\"description\":\"run\",\"inputSchema\":{\"type\":\"object\"}}"
                        } else {
                            ""
                        };
                        let body = format!("data: {{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"tools\":[{{\"name\":\"tabs\",\"description\":\"tabs\",\"inputSchema\":{{\"type\":\"object\"}}}}{extra}]}}}}\n\n");
                        respond(&mut stream, "200 OK", "text/event-stream", "", &body).await;
                    }
                    "tools/call" => {
                        let id = value["id"].clone();
                        let body = format!("data: {{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}]}}}}\n\n");
                        respond(&mut stream, "200 OK", "text/event-stream", "", &body).await;
                    }
                    _ => respond(&mut stream, "200 OK", "text/event-stream", "", "").await,
                }
            }
        });
        let cfg = McpServerConfig::Http {
            url: format!("http://{addr}/mcp"),
            headers: std::collections::BTreeMap::new(),
            timeouts_ms: Some(5_000),
        };
        let mut servers = std::collections::BTreeMap::new();
        servers.insert("svc".to_string(), cfg);
        let manager = McpManager::connect_all(&servers, &[]).await;
        assert_eq!(manager.tools().len(), 1);

        let (text, is_error) = manager
            .call("svc", "tabs", &json!({"action": "list"}))
            .await
            .expect("the retried call succeeds");
        assert_eq!(text, "ok");
        assert!(!is_error);

        let names: Vec<String> = manager.tools().iter().map(|t| t.name.clone()).collect();
        assert_eq!(
            names,
            vec!["mcp__svc__run", "mcp__svc__tabs"],
            "the catalog follows the reconnected server"
        );
        let methods = methods.lock().map(|g| g.clone()).unwrap_or_default();
        assert_eq!(
            methods,
            vec![
                "initialize",
                "notifications/initialized",
                "tools/list",
                "tools/call",
                "initialize",
                "notifications/initialized",
                "tools/list",
                "tools/call",
            ],
            "one re-handshake, then exactly one retry"
        );
    }
}
