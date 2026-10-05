//! Built-in tools: file access (vault-confined), URL reading, bash, skills.

use crate::commands::normalize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct ToolContext {
    pub vault: Option<PathBuf>,
    pub data_dir: PathBuf,
    /// The study-mode content the session was opened with.
    pub study_content: Arc<std::sync::RwLock<Option<StudyContent>>>,
    pub abort: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StudyContent {
    Markdown { path: String, title: String },
    Url { url: String, title: String },
}

impl ToolContext {
    /// Resolves a tool-supplied path: absolute paths pass through; relative
    /// paths anchor at the vault. Writing is confined to the vault.
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let p = Path::new(path);
        if p.is_absolute() {
            Ok(normalize(p))
        } else {
            let vault = self
                .vault
                .as_ref()
                .ok_or_else(|| "NO_VAULT: no vault is open".to_string())?;
            Ok(normalize(&vault.join(path)))
        }
    }

    fn ensure_vault_confined(&self, path: &Path) -> Result<(), String> {
        let vault = self
            .vault
            .as_ref()
            .ok_or_else(|| "NO_VAULT: no vault is open".to_string())?;
        let checked = path
            .canonicalize()
            .unwrap_or_else(|_| normalize(path));
        if checked.starts_with(vault.canonicalize().unwrap_or_else(|_| vault.clone())) {
            Ok(())
        } else {
            Err(format!("FORBIDDEN: path is outside the vault: {}", path.display()))
        }
    }
}

pub fn tool_schemas() -> &'static [(&'static str, &'static str, Value)] {
    static SCHEMAS: std::sync::OnceLock<Vec<(&'static str, &'static str, Value)>> = std::sync::OnceLock::new();
    SCHEMAS.get_or_init(|| vec![
    (
        "read_file",
        "Read a text file from the vault. Returns the file contents (truncated at ~40KB). Paths can be vault-relative or absolute.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path, vault-relative or absolute"}
            },
            "required": ["path"]
        }),
    ),
    (
        "write_file",
        "Create or overwrite a text file inside the vault (parent directories are created).",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Vault-relative or absolute path"},
                "content": {"type": "string", "description": "Full file contents"}
            },
            "required": ["path", "content"]
        }),
    ),
    (
        "list_files",
        "List every file in the vault (relative paths).",
        json!({"type": "object", "properties": {}}),
    ),
    (
        "read_url",
        "Fetch a web page and return its readable text (HTML stripped, ~40KB cap).",
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "http(s) URL"}
            },
            "required": ["url"]
        }),
    ),
    (
        "bash",
        "Run a shell command (sh -c) with the vault as working directory. Returns combined stdout+stderr and the exit code.",
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout_secs": {"type": "integer", "description": "Default 60, max 600"}
            },
            "required": ["command"]
        }),
    ),
    (
        "read_study_content",
        "Read the full content currently open in the study panel (the converted PDF markdown, or the text of the open web page).",
        json!({"type": "object", "properties": {}}),
    ),
    (
        "skill",
        "Load a skill's full instructions by name. Available skills are listed in the system prompt.",
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Skill name from the system prompt"}
            },
            "required": ["name"]
        }),
    ),
])
}

/// Executes a built-in tool. Returns (ok, output).
pub async fn execute(
    ctx: &ToolContext,
    skills: &super::skills::SkillRegistry,
    name: &str,
    input: &Value,
) -> (bool, String) {
    match name {
        "read_file" => {
            let path = input["path"].as_str().unwrap_or_default();
            match ctx.resolve(path) {
                Ok(p) => match tokio::fs::read_to_string(&p).await {
                    Ok(content) => (true, truncate(&content, 40_000)),
                    Err(e) => (false, format!("read failed: {}", e)),
                },
                Err(e) => (false, e),
            }
        }
        "write_file" => {
            let path = input["path"].as_str().unwrap_or_default();
            let content = input["content"].as_str().unwrap_or_default();
            match ctx.resolve(path) {
                Ok(p) => {
                    if let Err(e) = ctx.ensure_vault_confined(&p) {
                        return (false, e);
                    }
                    if let Some(parent) = p.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    match tokio::fs::write(&p, content).await {
                        Ok(()) => (true, format!("wrote {} ({} bytes)", p.display(), content.len())),
                        Err(e) => (false, format!("write failed: {}", e)),
                    }
                }
                Err(e) => (false, e),
            }
        }
        "list_files" => {
            let Some(vault) = ctx.vault.clone() else {
                return (false, "NO_VAULT: no vault is open".into());
            };
            let mut out = Vec::new();
            let mut stack = vec![vault.clone()];
            while let Some(dir) = stack.pop() {
                let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
                    continue;
                };
                while let Ok(Some(entry)) = rd.next_entry().await {
                    let path = entry.path();
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') {
                        continue;
                    }
                    if path.is_dir() {
                        stack.push(path);
                    } else if let Ok(rel) = path.strip_prefix(&vault) {
                        out.push(rel.to_string_lossy().to_string());
                    }
                }
            }
            out.sort();
            (true, truncate(&out.join("\n"), 20_000))
        }
        "read_url" => {
            let url = input["url"].as_str().unwrap_or_default().to_string();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return (false, "invalid url".into());
            }
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())
                .unwrap();
            match client.get(&url).send().await {
                Ok(resp) => {
                    let mime = resp
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let body = resp.text().await.unwrap_or_default();
                    if mime.contains("text/html") {
                        (true, truncate(&html_to_text(&body), 40_000))
                    } else {
                        (true, truncate(&body, 40_000))
                    }
                }
                Err(e) => (false, format!("fetch failed: {}", e)),
            }
        }
        "bash" => {
            let command = input["command"].as_str().unwrap_or_default().to_string();
            let timeout = input["timeout_secs"].as_u64().unwrap_or(60).clamp(1, 600);
            run_bash(&command, timeout, ctx).await
        }
        "read_study_content" => {
            let content = ctx.study_content.read().ok().and_then(|g| g.clone());
            match content {
                Some(StudyContent::Markdown { path, title }) => {
                    match tokio::fs::read_to_string(&path).await {
                        Ok(text) => (
                            true,
                            format!("# {}\n\n{}", title, truncate(&text, 60_000)),
                        ),
                        Err(e) => (false, format!("read failed: {}", e)),
                    }
                }
                Some(StudyContent::Url { url, title }) => {
                    let client = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(30))
                        .build()
                        .unwrap();
                    match client.get(&url).send().await {
                        Ok(resp) => {
                            let body = resp.text().await.unwrap_or_default();
                            (
                                true,
                                format!("# {}\n\n{}", title, truncate(&html_to_text(&body), 60_000)),
                            )
                        }
                        Err(e) => (false, format!("fetch failed: {}", e)),
                    }
                }
                None => (false, "no study content is open".into()),
            }
        }
        "skill" => {
            let skill_name = input["name"].as_str().unwrap_or_default();
            match skills.load(skill_name) {
                Some(content) => (true, content),
                None => (false, format!("unknown skill: {}", skill_name)),
            }
        }
        _ => (false, format!("unknown tool: {}", name)),
    }
}

async fn run_bash(command: &str, timeout_secs: u64, ctx: &ToolContext) -> (bool, String) {
    use tokio::io::AsyncReadExt;
    let cwd = ctx.vault.clone().unwrap_or_else(|| ctx.data_dir.clone());
    let mut cmd = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    match &mut cmd {
        Err(e) => (false, format!("spawn failed: {}", e)),
        Ok(child) => {
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let mut out_buf = Vec::new();
            let mut err_buf = Vec::new();
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
            loop {
                tokio::select! {
                    n1 = stdout.read_buf(&mut out_buf) => {
                        if let Ok(0) = n1 { break; }
                    }
                    n2 = stderr.read_buf(&mut err_buf) => {
                        if let Ok(0) = n2 { break; }
                    }
                    status = child.wait() => {
                        match status {
                            Ok(st) => {
                                let _ = stdout.read_to_end(&mut out_buf).await;
                                let _ = stderr.read_to_end(&mut err_buf).await;
                                let mut text = String::from_utf8_lossy(&out_buf).to_string();
                                let errs = String::from_utf8_lossy(&err_buf);
                                if !errs.is_empty() {
                                    text.push_str("\n[stderr]\n");
                                    text.push_str(&errs);
                                }
                                let ok = st.success();
                                text = format!("exit: {}\n{}", st.code().unwrap_or(-1), truncate(&text, 30_000));
                                return (ok, text);
                            }
                            Err(e) => return (false, format!("wait failed: {}", e)),
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        let _ = child.kill().await;
                        return (false, format!("timeout after {}s\n{}", timeout_secs, truncate(&String::from_utf8_lossy(&out_buf), 5_000)));
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(50)), if ctx.abort.load(std::sync::atomic::Ordering::Relaxed) => {
                        let _ = child.kill().await;
                        return (false, "aborted by user".into());
                    }
                }
                if out_buf.len() + err_buf.len() > 200_000 {
                    let _ = child.kill().await;
                    return (false, "output too large".into());
                }
            }
            (false, "stream ended".into())
        }
    }
}

/// Very small DOM-based HTML→text (keeps block structure, drops scripts/styles).
pub fn html_to_text(html: &str) -> String {
    let fragment = scraper::Html::parse_fragment(html);
    let root = fragment.tree.root();
    let mut out = String::new();
    walk_html(root, &mut out);
    // collapse blank lines
    let mut compact = String::new();
    let mut blank = 0;
    for line in out.lines() {
        let t = line.trim_end();
        if t.is_empty() {
            blank += 1;
            if blank <= 2 {
                compact.push('\n');
            }
        } else {
            blank = 0;
            compact.push_str(t);
            compact.push('\n');
        }
    }
    compact
}

const SKIP_TAGS: &[&str] = &["script", "style", "noscript", "svg", "head", "template"];

fn walk_html(node: ego_tree::NodeRef<scraper::Node>, out: &mut String) {
    match node.value() {
        scraper::Node::Text(t) => {
            let text = t.trim();
            if !text.is_empty() {
                out.push_str(text);
                out.push(' ');
            }
        }
        scraper::Node::Element(el) => {
            if SKIP_TAGS.contains(&el.name()) {
                return;
            }
            let name = el.name();
            if name == "br" {
                out.push('\n');
            }
            let block = matches!(
                name,
                "p" | "div" | "li" | "tr" | "section" | "article" | "pre"
                    | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "table"
            );
            if block {
                out.push('\n');
            }
            for child in node.children() {
                walk_html(child, out);
            }
            if block {
                out.push('\n');
            }
        }
        _ => {
            for child in node.children() {
                walk_html(child, out);
            }
        }
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut out = s.chars().take(n).collect::<String>();
        out.push_str("\n…[truncated]");
        out
    }
}
