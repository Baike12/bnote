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

pub struct McpTool {
    pub name: String, // fully qualified: mcp__<server>__<tool>
    pub description: String,
    pub input_schema: Value,
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
            McpServerConfig::Http { url, headers } => Transport::Http {
                url: url.clone(),
                headers: headers.clone(),
                next_id: 1,
            },
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
            } => {
                let id = *next_id;
                *next_id += 1;
                let req = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params,
                });
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(60))
                    .build()
                    .map_err(|e| e.to_string())?;
                let url_owned = url.clone();
                let mut rb = client
                    .post(url_owned)
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .header("mcp-protocol-version", "2024-11-05")
                    .body(req.to_string());
                for (k, v) in headers.iter() {
                    rb = rb.header(k.as_str(), v.as_str());
                }
                let resp = rb.send().await.map_err(|e| format!("http: {}", e))?;
                let status = resp.status();
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
                let payload = if content_type.contains("text/event-stream") {
                    // parse the last data: line
                    let mut data = String::new();
                    for line in body.lines() {
                        if let Some(rest) = line.strip_prefix("data:") {
                            data = rest.trim().to_string();
                        }
                    }
                    data
                } else {
                    body
                };
                let v: Value =
                    serde_json::from_str(&payload).map_err(|e| format!("parse: {}", e))?;
                if v["id"] == json!(id) {
                    if let Some(err) = v["error"].as_object() {
                        return Err(err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown")
                            .to_string());
                    }
                    Ok(v["result"].clone())
                } else {
                    Ok(Value::Null)
                }
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
            Transport::Http { .. } => Ok(()), // HTTP notifications are optional
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
    pub tools: Vec<McpTool>,
    pub errors: Vec<String>,
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
                                tools.push(McpTool {
                                    name: format!("mcp__{}__{}", name, tool),
                                    description: if desc.is_empty() {
                                        format!("MCP tool {} from server {}", tool, name)
                                    } else {
                                        desc
                                    },
                                    input_schema: schema,
                                });
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
            tools,
            errors,
        }
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
        c.call_tool(tool, args).await
    }
}
