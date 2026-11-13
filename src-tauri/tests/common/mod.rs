//! Test-only replay of recorded model traffic.
//!
//! A cassette is the folder [`bnote_lib::agent::cassette`] writes: per
//! interaction a request JSON plus a response folder with frame files. The
//! server below serves those frames over a real HTTP/1.1 socket, in order, so
//! the provider exercises the same `reqwest` + SSE path it uses in production.
//!
//! Matching is by order and by path suffix, not by request body: a recorded
//! conversation contains the model's own tool calls and answers, while the
//! harness under test sends its own (slightly different) prompt. What must
//! stay fixed is the sequence of model outputs.

// Every integration-test binary includes this module but uses only one half of
// it (replay server or harness), so unused items are expected.
#![allow(dead_code)]

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub body: Value,
}

#[derive(Debug, Clone)]
struct Interaction {
    protocol: String,
    path: String,
    status: u16,
    content_type: String,
    delay_ms: u64,
    frames: Vec<Vec<u8>>,
}

fn read_interactions(dir: &Path) -> Result<Vec<Interaction>, String> {
    let mut requests: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with("-request.json"))
        })
        .collect();
    requests.sort();

    let mut out = Vec::new();
    for request_path in requests {
        let name = request_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("non-UTF-8 cassette name")?;
        let prefix = name
            .strip_suffix("-request.json")
            .ok_or("not a request file")?;
        let request: Value =
            serde_json::from_slice(&std::fs::read(&request_path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("{name}: {e}"))?;
        let url = request["url"].as_str().unwrap_or_default();
        let protocol = request["protocol"].as_str().unwrap_or_default().to_string();
        let response_dir = dir.join(format!("{prefix}-response"));
        let meta: Value = std::fs::read(response_dir.join("meta.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let mut frames: Vec<PathBuf> = std::fs::read_dir(response_dir.join("frames"))
            .map_err(|e| format!("{prefix}: {e}"))?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("sse"))
            .collect();
        frames.sort();
        out.push(Interaction {
            protocol,
            path: url_path(url),
            status: meta["status"].as_u64().unwrap_or(200) as u16,
            content_type: meta["contentType"]
                .as_str()
                .unwrap_or("text/event-stream")
                .to_string(),
            delay_ms: meta["delayMs"].as_u64().unwrap_or(0),
            frames: frames
                .into_iter()
                .map(|path| std::fs::read(&path).map_err(|e| format!("{path:?}: {e}")))
                .collect::<Result<_, _>>()?,
        });
    }
    Ok(out)
}

/// `/v1/messages?x=1` → `/v1/messages`; a host without a path → `/`.
fn url_path(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    match rest.find('/') {
        Some(index) => {
            let path = &rest[index..];
            path.split('?').next().unwrap_or(path).to_string()
        }
        None => "/".to_string(),
    }
}

pub struct MockLlmServer {
    addr: std::net::SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    task: tokio::task::JoinHandle<()>,
}

impl MockLlmServer {
    pub async fn start(dir: impl AsRef<Path>) -> MockLlmServer {
        let interactions = Arc::new(
            read_interactions(dir.as_ref())
                .unwrap_or_else(|e| panic!("cassette {}: {e}", dir.as_ref().display())),
        );
        assert!(
            !interactions.is_empty(),
            "cassette {} is empty",
            dir.as_ref().display()
        );
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the mock LLM port");
        let addr = listener.local_addr().expect("mock LLM address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let cursor = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let interactions = interactions.clone();
            let requests = requests.clone();
            async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        break;
                    };
                    let interactions = interactions.clone();
                    let requests = requests.clone();
                    let cursor = cursor.clone();
                    tokio::spawn(async move {
                        handle(stream, interactions, requests, cursor).await;
                    });
                }
            }
        });
        MockLlmServer {
            addr,
            requests,
            task,
        }
    }

    /// `http://127.0.0.1:<port>`; append `/v1` for the OpenAI-compatible client.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl Drop for MockLlmServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A headless agent session over a temporary vault and agent home.
///
/// `Session.app` is `None`: there is no window, so events are dropped and the
/// loop is observed through its history and tool effects. That is the same
/// code path the real app runs; only the event sink differs.
pub struct Harness {
    pub root: PathBuf,
    pub home: PathBuf,
    pub vault: PathBuf,
    pub session: bnote_lib::agent::session::Session,
}

impl Harness {
    pub fn cleanup(self) {
        std::env::remove_var(bnote_lib::agent::home::HOME_ENV);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub async fn harness(provider: Arc<bnote_lib::agent::Provider>) -> Harness {
    use bnote_lib::agent::cancel::Abort;
    use bnote_lib::agent::defs;
    use bnote_lib::agent::mcp::McpManager;
    use bnote_lib::agent::models::ModelSelection;
    use bnote_lib::agent::permissions;
    use bnote_lib::agent::session::{create_session, SessionMode, SessionSeed};
    use bnote_lib::agent::shell::{BgRegistry, ShellCwd};
    use bnote_lib::agent::skills::SkillRegistry;
    use bnote_lib::agent::tools::ToolContext;
    use std::sync::atomic::AtomicU64;
    use std::sync::RwLock;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = std::env::temp_dir().join(format!("bnote-harness-{}-{stamp}", std::process::id()));
    let home = root.join("home");
    let vault = root.join("vault");
    std::fs::create_dir_all(vault.join("Notes")).expect("harness vault");
    std::fs::write(
        vault.join("Notes/Second.md"),
        "# Second note\n\nreplayed content\n",
    )
    .expect("harness note");
    std::env::set_var(bnote_lib::agent::home::HOME_ENV, &home);

    let ctx = Arc::new(ToolContext {
        vault: Some(vault.clone()),
        data_dir: home.clone(),
        study_content: Arc::new(RwLock::new(None)),
        abort: Abort::new(),
        app: None,
        preview_seq: AtomicU64::new(0),
        workdir: Some(vault.clone()),
        shell: Arc::new(ShellCwd::new()),
        bg: Arc::new(BgRegistry::new()),
        read_paths: Mutex::new(Vec::new()),
        extra_roots: Vec::new(),
    });
    let selection = ModelSelection {
        provider_id: provider.provider_id.clone(),
        model_id: provider.model_id.clone(),
        thinking: provider.thinking_level.clone(),
    };
    let seed = SessionSeed {
        id: "cassette-harness".into(),
        mode: SessionMode::Coding,
        def: Arc::new(defs::definition("coding").expect("coding definition")),
        vault_name: "CassetteVault".into(),
        current_note: None,
        mcp_names: Vec::new(),
        skills: Arc::new(SkillRegistry { skills: Vec::new() }),
        mcp: Arc::new(McpManager::connect_all(&std::collections::BTreeMap::new(), &[]).await),
        provider,
        selection,
        ctx,
        app: None,
        context_window: 200_000,
        permission_mode: Some(permissions::Mode::Auto),
        task_list_id: Some("cassette-harness".into()),
        log_requests: false,
        mode_root: None,
        subagent_concurrency: 2,
    };
    let session = create_session(seed);
    Harness {
        root,
        home,
        vault,
        session,
    }
}

async fn handle(
    mut stream: TcpStream,
    interactions: Arc<Vec<Interaction>>,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    cursor: Arc<AtomicUsize>,
) {
    let Some((method, path, body)) = read_request(&mut stream).await else {
        return;
    };
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if let Ok(mut requests) = requests.lock() {
        requests.push(RecordedRequest {
            method,
            path: path.clone(),
            body,
        });
    }

    let index = cursor.fetch_add(1, Ordering::SeqCst);
    let Some(interaction) = interactions.get(index) else {
        let message = format!(
            "cassette exhausted: request {} but only {} interactions recorded",
            index + 1,
            interactions.len()
        );
        write_plain(&mut stream, 500, "text/plain", message.as_bytes()).await;
        return;
    };
    if !path_matches(&interaction.path, &path) {
        let message = format!(
            "cassette request {} is {} but the client sent {path}",
            index + 1,
            interaction.path
        );
        write_plain(&mut stream, 500, "text/plain", message.as_bytes()).await;
        return;
    }
    if !(200..300).contains(&interaction.status) {
        let message = format!(
            "recorded {} for {}",
            interaction.status, interaction.protocol
        );
        write_plain(
            &mut stream,
            interaction.status,
            "application/json",
            message.as_bytes(),
        )
        .await;
        return;
    }

    let head = format!(
        "HTTP/1.1 {} OK\r\ncontent-type: {}\r\ncache-control: no-cache\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
        interaction.status, interaction.content_type
    );
    if stream.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    for frame in &interaction.frames {
        let size = format!("{:x}\r\n", frame.len());
        if stream.write_all(size.as_bytes()).await.is_err()
            || stream.write_all(frame).await.is_err()
            || stream.write_all(b"\r\n").await.is_err()
        {
            return;
        }
        let _ = stream.flush().await;
        if interaction.delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(interaction.delay_ms)).await;
        }
    }
    let _ = stream.write_all(b"0\r\n\r\n").await;
    let _ = stream.flush().await;
}

/// A recording made through a gateway may carry a path prefix the replay
/// client does not know; the suffix is the endpoint contract.
fn path_matches(recorded: &str, actual: &str) -> bool {
    recorded == actual || recorded.ends_with(actual) || actual.ends_with(recorded)
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    while find_head_end(&buffer).is_none() {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if buffer.len() > 16 * 1024 * 1024 {
            return None;
        }
    }
    let head_end = find_head_end(&buffer)?;
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let mut body = buffer[head_end + 4..].to_vec();
    let mut lines = head.lines();
    let first = lines.next()?;
    let mut first = first.split_whitespace();
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let mut content_length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        if name == "content-length" {
            content_length = value.parse().unwrap_or(0);
        }
    }
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some((method, path, body))
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n")
}

async fn write_plain(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} ERROR\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_path_keeps_the_endpoint_and_drops_the_query() {
        assert_eq!(
            url_path("https://api.anthropic.com/v1/messages?beta=1"),
            "/v1/messages"
        );
        assert_eq!(
            url_path("http://127.0.0.1:4010/v1/chat/completions"),
            "/v1/chat/completions"
        );
        assert_eq!(url_path("http://example.test"), "/");
    }

    #[test]
    fn a_recorded_gateway_prefix_still_matches_the_endpoint() {
        assert!(path_matches(
            "/proxy/openai/v1/chat/completions",
            "/v1/chat/completions"
        ));
        assert!(path_matches("/v1/messages", "/v1/messages"));
        assert!(!path_matches("/v1/messages", "/v1/chat/completions"));
    }
}
