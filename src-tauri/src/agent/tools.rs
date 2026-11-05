//! Built-in tools: file access, URL reading, skills, glob/grep.
//!
//! Session-owned tools (bash, todo, task) live on the session; everything that
//! only needs the shared context runs here. `bash` moved to `shell.rs` for the
//! persistent-cwd execution model; the session's `execute_tool` routes to it.

use crate::commands::normalize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::shell::{BgRegistry, ShellCwd};
use super::types::InlineImage;

/// Tool execution result. Text tools only carry `text`; a rich-output tool
/// (currently only preview_html) may attach a rendered screenshot, which the
/// session writes into ToolResult.images so the model can check the page
/// rendering itself.
pub struct ToolOutput {
    pub ok: bool,
    pub text: String,
    pub images: Vec<InlineImage>,
}

impl ToolOutput {
    pub fn text(ok: bool, text: impl Into<String>) -> Self {
        Self {
            ok,
            text: text.into(),
            images: Vec::new(),
        }
    }
}

pub struct ToolContext {
    pub vault: Option<PathBuf>,
    pub data_dir: PathBuf,
    /// The study-mode content the session was opened with.
    pub study_content: Arc<std::sync::RwLock<Option<StudyContent>>>,
    pub abort: Arc<super::cancel::Abort>,
    /// In creation mode preview_html has to push a "preview updated" event to the
    /// front end; the test environment has no AppHandle, and with None the
    /// preview degrades to writing the file only.
    pub app: Option<tauri::AppHandle>,
    /// Version counter of the preview_html snapshot on disk (the file name carries
    /// the version, so the child webview swaps the URL and bypasses the browser
    /// cache for a same-named file://).
    pub preview_seq: std::sync::atomic::AtomicU64,
    /// Working directory of a coding session (the code project root). Relative
    /// tool paths anchor here first; writes are confined to it as well.
    pub workdir: Option<PathBuf>,
    /// The bash tool's persistent working directory (one per session).
    pub shell: Arc<ShellCwd>,
    /// Background tasks of this session (`run_in_background`).
    pub bg: Arc<BgRegistry>,
    /// Files this session read since the last request. The session uses them to
    /// load nested instruction files (`nested_memory`), the way CC does.
    pub read_paths: std::sync::Mutex<Vec<PathBuf>>,
    /// Extra writable roots from `settings.permissions.additionalDirectories`.
    pub extra_roots: Vec<PathBuf>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StudyContent {
    Pdf {
        path: String,
        title: String,
    },
    Url {
        url: String,
        title: String,
    },
}

/// Extracts the markdown text of a PDF for the Agent.
///
/// This is a *read*: the study reader shows the PDF itself, and nothing is
/// written into the vault. pdf2md still writes figure assets into its output
/// directory, so it gets a scratch dir under the OS temp folder.
fn read_pdf_text(path: &str) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    let scratch = std::env::temp_dir()
        .join("bnote-pdf-text")
        .join(format!("{:x}", hasher.finish()));
    let opts = pdf2md::ConvertOptions::new(scratch, String::new());
    Ok(pdf2md::convert_file(path, &opts)?.markdown)
}

impl ToolContext {
    /// Records a successful read; the session turns these into nested
    /// instruction-file attachments on the next request.
    pub fn note_read(&self, path: &Path) {
        if let Ok(mut paths) = self.read_paths.lock() {
            if !paths.iter().any(|p| p == path) {
                paths.push(path.to_path_buf());
            }
        }
    }

    /// Drains the read paths recorded since the last call.
    pub fn take_read_paths(&self) -> Vec<PathBuf> {
        self.read_paths
            .lock()
            .map(|mut paths| std::mem::take(&mut *paths))
            .unwrap_or_default()
    }

    /// Resolves a tool-supplied path: absolute paths pass through; relative
    /// paths anchor at the working directory (coding sessions: the project
    /// root) and fall back to the vault. Writing is confined to both roots
    /// (see ensure_confined).
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let p = Path::new(path);
        if p.is_absolute() {
            return Ok(normalize(p));
        }
        if let Some(workdir) = &self.workdir {
            return Ok(normalize(&workdir.join(path)));
        }
        let vault = self
            .vault
            .as_ref()
            .ok_or_else(|| "NO_VAULT: no vault is open".to_string())?;
        Ok(normalize(&vault.join(path)))
    }

    /// The directory relative paths and `list_files`/`glob`/`grep` anchor at.
    fn root(&self) -> Result<PathBuf, String> {
        if let Some(workdir) = &self.workdir {
            return Ok(workdir.clone());
        }
        self.vault
            .clone()
            .ok_or_else(|| "NO_VAULT: no vault is open".to_string())
    }

    /// Writes are confined to the working directory (the code project for a
    /// coding session) or the vault, plus the agent home `~/.bnote` (memory,
    /// skills, plans). The vault is *not* writable from a coding session: the
    /// repository and the notebook are unrelated stores.
    fn ensure_confined(&self, path: &Path) -> Result<(), String> {
        // A path that does not exist yet (a new file) resolves through its
        // deepest existing ancestor: comparing the raw lexical form against
        // the canonicalized roots fails on symlinked parents (/var →
        // /private/var on macOS) and would forbid every legitimate new file.
        let checked = match path.canonicalize() {
            Ok(p) => p,
            Err(_) => {
                let name = path.file_name().ok_or_else(|| {
                    format!(
                        "FORBIDDEN: path is outside the writable roots: {}",
                        path.display()
                    )
                })?;
                let mut dir = path.parent();
                loop {
                    match dir {
                        Some(d) => match d.canonicalize() {
                            Ok(base) => break base.join(name),
                            Err(_) => dir = d.parent(),
                        },
                        None => {
                            return Err(format!(
                                "FORBIDDEN: path is outside the writable roots: {}",
                                path.display()
                            ));
                        }
                    }
                }
            }
        };
        let mut roots: Vec<PathBuf> = Vec::new();
        match &self.workdir {
            Some(workdir) => roots.push(workdir.clone()),
            None => {
                if let Some(vault) = &self.vault {
                    roots.push(vault.clone());
                }
            }
        }
        roots.push(super::home::home_dir());
        roots.extend(self.extra_roots.iter().cloned());
        let roots = roots
            .iter()
            .map(|r| r.canonicalize().unwrap_or_else(|_| r.clone()));
        for root in roots {
            if checked.starts_with(root) {
                return Ok(());
            }
        }
        Err(format!(
            "FORBIDDEN: path is outside the writable roots: {}",
            path.display()
        ))
    }
}

pub fn tool_schemas() -> &'static [(&'static str, &'static str, Value)] {
    static SCHEMAS: std::sync::OnceLock<Vec<(&'static str, &'static str, Value)>> =
        std::sync::OnceLock::new();
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
        "Run a shell command. The working directory persists across calls (cd is remembered). Returns combined stdout+stderr and the exit code; default 120s timeout, max 600s. With run_in_background=true the command runs detached and the result is a task id — poll it with bash_output; the session is woken automatically when the task finishes. Do NOT use bash to read or edit files — dedicated tools (read_file / write_file / edit_file / grep) are safer and cheaper.",
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout_secs": {"type": "integer", "description": "Default 120, max 600"},
                "run_in_background": {"type": "boolean", "description": "Run detached; poll with bash_output"}
            },
            "required": ["command"]
        }),
    ),
    (
        "bash_output",
        "Read the output of a background task started with bash run_in_background.",
        json!({
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "The background task id"}
            },
            "required": ["id"]
        }),
    ),
    (
        "bash_kill",
        "Kill a background task started with bash run_in_background.",
        json!({
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "The background task id"}
            },
            "required": ["id"]
        }),
    ),
    (
        "glob",
        "List files whose path matches a glob pattern (e.g. src/**/*.rs, *.{ts,tsx}), relative to the working directory. Respects .gitignore; sorted; capped at 500 entries.",
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern relative to the working directory"}
            },
            "required": ["pattern"]
        }),
    ),
    (
        "grep",
        "Search file contents with a regex (Rust syntax). Returns path:line: text matches, capped at 200. Respects .gitignore.",
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regular expression"},
                "include": {"type": "string", "description": "Optional file-name glob filter, e.g. *.rs"}
            },
            "required": ["pattern"]
        }),
    ),
    (
        "todo",
        "Replace the session's todo list. Use it to plan multi-step work and keep the user informed: one item = one step, exactly one item in_progress at a time, mark completed as soon as it is done.",
        json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string", "description": "Imperative form: what to do"},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                            "active_form": {"type": "string", "description": "Present-progress form shown while running"}
                        },
                        "required": ["content", "status"]
                    }
                }
            },
            "required": ["todos"]
        }),
    ),
    (
        "task",
        "Launch a new agent to handle complex, multi-step tasks autonomously. The agent has its own context window and returns a single final report, so it is the right tool for broad searches, independent sub-problems, or anything whose intermediate output would flood this conversation.\n\nWhen to use: research across many files, exploring a codebase for an answer, or independent work that can run while you continue. When NOT to use: a simple directed search (use glob/grep), or work that depends on what you are doing right now.\n\nUsage: launch several agents in one message when the tasks are independent. To continue an agent you already launched (including one that stopped on an error), use send_message with its agentId instead of spawning a new one. Trust the report and do not duplicate the agent's work yourself. `run_in_background: true` returns immediately; you are notified when it finishes. `fork: true` starts from this conversation's transcript instead of a fresh context.",
        json!({
            "type": "object",
            "properties": {
                "description": {"type": "string", "description": "A short (3-5 word) description of the task"},
                "prompt": {"type": "string", "description": "The task for the agent to perform; self-contained, with all the context it needs"},
                "subagent_type": {"type": "string", "description": "Agent definition id to launch (default: general-purpose)"},
                "model": {"type": "string", "description": "Optional model override for this agent"},
                "run_in_background": {"type": "boolean", "description": "Run in the background and notify when done"},
                "fork": {"type": "boolean", "description": "Inherit this conversation's transcript (a forked worker)"}
            },
            "required": ["prompt"]
        }),
    ),
    (
        "task_create",
        "Create a task in the task list. Use it for work with 3+ steps: create the tasks first, then update them as you go. A task starts in status pending.",
        super::tasks::create_schema(),
    ),
    (
        "task_update",
        "Update one task of the task list: set its status, subject, description, owner, or its dependency edges (add_blocks / add_blocked_by).",
        super::tasks::update_schema(),
    ),
    (
        "task_list",
        "List every task with its id, status and blocking edges.",
        super::tasks::list_schema(),
    ),
    (
        "task_get",
        "Read one task by id.",
        super::tasks::get_schema(),
    ),
    (
        "send_message",
        "Send a message to a subagent you spawned earlier. A running agent receives it at its next turn; an agent that already finished (including one that stopped on an error or a rate limit) is resumed in the background with its full history intact, and you are notified when it reports back. Use the agentId from the task tool result.",
        json!({
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "The agentId returned by the task tool"},
                "summary": {"type": "string", "description": "A 5-10 word summary of the message"},
                "message": {"type": "string", "description": "The message or follow-up task for the agent"}
            },
            "required": ["to", "message"]
        }),
    ),
    (
        "ask_user_question",
        "Ask the user a question and wait for the answer. Use it when you genuinely need a decision only the user can make (a choice between approaches, missing requirements, an ambiguity that changes the implementation) — not as a first response to friction. Provide 2-4 concrete options per question; the user may also type a custom answer.",
        json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "1-4 questions, asked together",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string", "description": "The full question, ending with a question mark"},
                            "header": {"type": "string", "description": "Very short label (max 12 chars)"},
                            "multiSelect": {"type": "boolean", "description": "Allow several answers"},
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {"type": "string"},
                                        "description": {"type": "string"}
                                    },
                                    "required": ["label"]
                                }
                            }
                        },
                        "required": ["question", "options"]
                    }
                }
            },
            "required": ["questions"]
        }),
    ),
    (
        "EnterPlanMode",
        "Switch this session into plan mode: explore the codebase freely (read_file / glob / grep / read-only shell) but do not change anything — write_file, edit_file and mutating shell commands are denied. Use it when a task needs an agreed approach before implementation. Finish by calling ExitPlanMode with the plan.",
        json!({
            "type": "object",
            "properties": {}
        }),
    ),
    (
        "ExitPlanMode",
        "Present the finished plan for the user's approval. Only valid in plan mode. The plan must be self-contained markdown: goal, the files to touch, the steps in order, and how it will be verified. On approval you leave plan mode and start implementing; on rejection you stay in plan mode and revise.",
        json!({
            "type": "object",
            "properties": {
                "plan": {"type": "string", "description": "The complete plan in markdown"}
            },
            "required": ["plan"]
        }),
    ),
    (
        "edit_file",
        "Replace an exact string in an existing text file inside the vault. Read the file first with read_file. old_string must match exactly (including whitespace) and appear exactly once — for multiple occurrences call it repeatedly with larger context, or rewrite the whole file with write_file.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Vault-relative or absolute path"},
                "old_string": {"type": "string", "description": "Exact text to replace"},
                "new_string": {"type": "string", "description": "Replacement text"}
            },
            "required": ["path", "old_string", "new_string"]
        }),
    ),
    (
        "preview_html",
        "Show a vault HTML file in the middle column live preview (creation mode). Call it after write_file/edit_file so the user sees the current version; call again after every change. The result includes a screenshot of the rendered page — look at it and fix layout problems before delivering. Do NOT pass HTML content here — write the file first, then preview it.",
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Vault-relative or absolute path of an .html file inside the vault"}
            },
            "required": ["path"]
        }),
    ),
    (
        "read_study_content",
        "Read the full content currently open in the study panel (the extracted text of the PDF, or the text of the open web page).",
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

/// Tools that may run concurrently with their neighbours in one assistant
/// message (CC's `isConcurrencySafe`). Everything else — anything that writes,
/// spawns or mutates session state — runs alone and in call order.
pub fn is_concurrency_safe(name: &str) -> bool {
    matches!(
        name,
        "read_file"
            | "list_files"
            | "glob"
            | "grep"
            | "read_url"
            | "read_study_content"
            | "skill"
            | "task_list"
            | "task_get"
    )
}

/// Executes a built-in tool.
pub async fn execute(
    ctx: &ToolContext,
    skills: &super::skills::SkillRegistry,
    name: &str,
    input: &Value,
) -> ToolOutput {
    // Rich-output tool: besides the text it returns a rendered screenshot
    // (see preview_html).
    if name == "preview_html" {
        let path = input["path"].as_str().unwrap_or_default();
        return preview_html(ctx, path).await;
    }
    let (ok, text) = execute_text(ctx, skills, name, input).await;
    ToolOutput::text(ok, text)
}

/// Executes a built-in tool. Returns (ok, output).
async fn execute_text(
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
                    Ok(content) => {
                        ctx.note_read(&p);
                        (true, truncate(&content, 40_000))
                    }
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
                    if let Err(e) = ctx.ensure_confined(&p) {
                        return (false, e);
                    }
                    if let Some(parent) = p.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    match tokio::fs::write(&p, content).await {
                        Ok(()) => (
                            true,
                            format!("wrote {} ({} bytes)", p.display(), content.len()),
                        ),
                        Err(e) => (false, format!("write failed: {}", e)),
                    }
                }
                Err(e) => (false, e),
            }
        }
        "list_files" => {
            let root = match ctx.root() {
                Ok(r) => r,
                Err(e) => return (false, e),
            };
            let mut out = Vec::new();
            let mut stack = vec![root.clone()];
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
                    } else if let Ok(rel) = path.strip_prefix(&root) {
                        out.push(rel.to_string_lossy().to_string());
                    }
                }
            }
            out.sort();
            (true, truncate(&out.join("\n"), 20_000))
        }
        "glob" => {
            let pattern = input["pattern"].as_str().unwrap_or_default().to_string();
            if pattern.trim().is_empty() {
                return (false, "pattern 不能为空".into());
            }
            match ctx.root() {
                Ok(root) => match super::search::glob(&root, &pattern).await {
                    Ok(text) => (true, text),
                    Err(e) => (false, e),
                },
                Err(e) => (false, e),
            }
        }
        "grep" => {
            let pattern = input["pattern"].as_str().unwrap_or_default().to_string();
            if pattern.trim().is_empty() {
                return (false, "pattern 不能为空".into());
            }
            let include = input["include"].as_str().map(|s| s.to_string());
            match ctx.root() {
                Ok(root) => match super::search::grep(&root, &pattern, include).await {
                    Ok(text) => (true, text),
                    Err(e) => (false, e),
                },
                Err(e) => (false, e),
            }
        }
        "read_url" => {
            let url = input["url"].as_str().unwrap_or_default().to_string();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return (false, "invalid url".into());
            }
            let client = match reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
            {
                Ok(c) => c,
                Err(e) => return (false, format!("http client init failed: {}", e)),
            };
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
        "edit_file" => {
            let path = input["path"].as_str().unwrap_or_default();
            let old = input["old_string"].as_str().unwrap_or_default();
            let new = input["new_string"].as_str().unwrap_or_default();
            if old.is_empty() {
                return (false, "old_string 不能为空(整篇新建请用 write_file)".into());
            }
            match ctx.resolve(path) {
                Ok(p) => {
                    if let Err(e) = ctx.ensure_confined(&p) {
                        return (false, e);
                    }
                    match tokio::fs::read_to_string(&p).await {
                        Ok(content) => {
                            let hits = content.matches(old).count();
                            if hits == 0 {
                                (false, "old_string 在文件中不存在(先 read_file 核对原文,注意空白与换行)".into())
                            } else if hits > 1 {
                                (false, format!("old_string 出现 {hits} 次:带上更多上下文让它唯一,或用 write_file 重写全文件"))
                            } else {
                                let updated = content.replacen(old, new, 1);
                                match tokio::fs::write(&p, updated).await {
                                    Ok(()) => {
                                        (true, format!("edited {} (1 replacement)", p.display()))
                                    }
                                    Err(e) => (false, format!("write failed: {}", e)),
                                }
                            }
                        }
                        Err(e) => (false, format!("read failed: {}", e)),
                    }
                }
                Err(e) => (false, e),
            }
        }
        "read_study_content" => {
            let content = ctx.study_content.read().ok().and_then(|g| g.clone());
            match content {
                Some(StudyContent::Pdf { path, title }) => {
                    match tokio::task::spawn_blocking(move || read_pdf_text(&path)).await {
                        Ok(Ok(text)) => {
                            (true, format!("# {}\n\n{}", title, truncate(&text, 60_000)))
                        }
                        Ok(Err(e)) => (false, format!("read failed: {}", e)),
                        Err(e) => (false, format!("join failed: {}", e)),
                    }
                }
                Some(StudyContent::Url { url, title }) => {
                    let client = match reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(30))
                        .build()
                    {
                        Ok(c) => c,
                        Err(e) => return (false, format!("http client init failed: {}", e)),
                    };
                    match client.get(&url).send().await {
                        Ok(resp) => {
                            let body = resp.text().await.unwrap_or_default();
                            (
                                true,
                                format!(
                                    "# {}\n\n{}",
                                    title,
                                    truncate(&html_to_text(&body), 60_000)
                                ),
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
                "p" | "div"
                    | "li"
                    | "tr"
                    | "section"
                    | "article"
                    | "pre"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "blockquote"
                    | "table"
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

/// preview_html: copies a versioned snapshot of the vault HTML file into the
/// app data directory, then pushes a `creative-preview-updated` event (with the
/// snapshot's file:// URL) to the front end, which drives the native child
/// webview in the center column.
///
/// Why copy instead of previewing the source file: the child webview only
/// reloads when its URL changes, and reloading a same-named file:// URL has
/// unreliable cache behaviour on WKWebView/WebView2. A separate versioned file
/// turns "change the URL" into a reliable reload signal. Leaving the snapshot
/// on disk is harmless (the next preview overwrites it) and helps debugging.
async fn preview_html(ctx: &ToolContext, path: &str) -> ToolOutput {
    if !path.to_ascii_lowercase().ends_with(".html") {
        return ToolOutput::text(false, "preview_html 只接受 .html 文件");
    }
    let source = match ctx.resolve(path) {
        Ok(p) => p,
        Err(e) => return ToolOutput::text(false, e),
    };
    let content = match tokio::fs::read_to_string(&source).await {
        Ok(c) => c,
        Err(e) => return ToolOutput::text(false, format!("read failed: {}", e)),
    };
    let version = ctx
        .preview_seq
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = ctx.data_dir.join("creative-preview");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return ToolOutput::text(false, format!("prepare preview dir failed: {}", e));
    }
    let snapshot = dir.join(format!("preview-{version}.html"));
    if let Err(e) = tokio::fs::write(&snapshot, content).await {
        return ToolOutput::text(false, format!("write preview failed: {}", e));
    }
    let file_url = match tauri::Url::from_file_path(&snapshot) {
        Ok(url) => url.to_string(),
        Err(_) => return ToolOutput::text(false, "无法构造预览 URL"),
    };
    if let Some(app) = &ctx.app {
        use tauri::Emitter;
        let _ = app.emit(
            "creative-preview-updated",
            serde_json::json!({ "url": file_url, "source": path, "version": version }),
        );
    }
    // Rendered screenshot: the native layer takes the PNG once the preview
    // webview has loaded this snapshot, and it is fetched back by version here.
    // A missing screenshot (unsupported platform / timeout) only degrades to
    // plain text; the preview itself is unaffected.
    let mut images = Vec::new();
    if ctx.app.is_some() && cfg!(target_os = "macos") {
        if let Some(png) =
            crate::commands::agent::wait_preview_shot(version, std::time::Duration::from_secs(4))
                .await
        {
            use base64::Engine as _;
            images.push(InlineImage {
                media_type: "image/png".into(),
                data: base64::engine::general_purpose::STANDARD.encode(&png),
            });
        }
    }
    let text = if images.is_empty() {
        format!("preview updated: {path}\n[no screenshot this time — the render is on the middle column for the user]")
    } else {
        format!("preview updated: {path}\n[attached] screenshot of the rendered page — check the layout before delivering")
    };
    ToolOutput {
        ok: true,
        text,
        images,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn ctx(vault: &Path, data_dir: &Path) -> ToolContext {
        ToolContext {
            vault: Some(vault.to_path_buf()),
            data_dir: data_dir.to_path_buf(),
            study_content: Arc::new(std::sync::RwLock::new(None)),
            abort: crate::agent::cancel::Abort::new(),
            app: None,
            preview_seq: std::sync::atomic::AtomicU64::new(0),
            workdir: None,
            shell: Arc::new(crate::agent::shell::ShellCwd::new()),
            bg: Arc::new(crate::agent::shell::BgRegistry::new()),
            read_paths: std::sync::Mutex::new(Vec::new()),
            extra_roots: Vec::new(),
        }
    }

    #[tokio::test]
    async fn edit_file_replaces_the_exact_match_once() {
        let vault = std::env::temp_dir().join("bnote-edit-test-1");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let file = vault.join("post.html");
        std::fs::write(&file, "<h1>旧标题</h1>\n<p>正文</p>\n").unwrap();
        let c = ctx(&vault, &vault);
        let out = execute(
            &c,
            &super::super::skills::SkillRegistry { skills: vec![] },
            "edit_file",
            &json!({"path": "post.html", "old_string": "<h1>旧标题</h1>", "new_string": "<h1>新标题</h1>"}),
        )
        .await;
        assert!(out.ok, "{}", out.text);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "<h1>新标题</h1>\n<p>正文</p>\n"
        );
    }

    #[tokio::test]
    async fn edit_file_rejects_a_missing_old_string_and_a_repeated_one() {
        let vault = std::env::temp_dir().join("bnote-edit-test-2");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let file = vault.join("post.md");
        std::fs::write(&file, "a b a").unwrap();
        let c = ctx(&vault, &vault);
        let skills = super::super::skills::SkillRegistry { skills: vec![] };
        let out = execute(
            &c,
            &skills,
            "edit_file",
            &json!({"path": "post.md", "old_string": "xyz", "new_string": "q"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("不存在"), "{}", out.text);
        let out = execute(
            &c,
            &skills,
            "edit_file",
            &json!({"path": "post.md", "old_string": "a", "new_string": "q"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("2 次"), "{}", out.text);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "a b a",
            "the file must be unchanged"
        );
    }

    #[tokio::test]
    async fn edit_file_refuses_to_write_outside_the_repository() {
        let vault = std::env::temp_dir().join("bnote-edit-test-3");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let c = ctx(&vault, &vault);
        let outside = std::env::temp_dir().join("bnote-edit-outside.md");
        std::fs::write(&outside, "x").unwrap();
        let out = execute(
            &c,
            &super::super::skills::SkillRegistry { skills: vec![] },
            "edit_file",
            &json!({"path": outside, "old_string": "x", "new_string": "y"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("FORBIDDEN"), "{}", out.text);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "x");
    }

    #[tokio::test]
    async fn a_workdir_anchors_relative_paths_and_is_writable() {
        // Coding session: the project root is the anchor for relative paths and
        // part of the writable boundary — without this the coding agent could
        // not touch the project it was opened for.
        let vault = std::env::temp_dir().join("bnote-workdir-vault");
        let project = std::env::temp_dir().join("bnote-workdir-project");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let mut c = ctx(&vault, &vault);
        c.workdir = Some(project.clone());
        let skills = super::super::skills::SkillRegistry { skills: vec![] };
        let out = execute(
            &c,
            &skills,
            "write_file",
            &json!({"path": "src/lib.rs", "content": "fn a() {}"}),
        )
        .await;
        assert!(out.ok, "{}", out.text);
        assert!(
            project.join("src/lib.rs").is_file(),
            "relative paths anchor at the workdir"
        );
        // A vault write from a coding session is refused: the repository and
        // the notebook are unrelated stores, so the project root alone is the
        // boundary.
        let out = execute(
            &c,
            &skills,
            "write_file",
            &json!({"path": format!("{}/v.md", vault.display()), "content": "x"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("FORBIDDEN"), "{}", out.text);
        assert!(!vault.join("v.md").exists());
        // Outside both roots stays forbidden.
        let outside = std::env::temp_dir().join("bnote-workdir-outside.md");
        std::fs::write(&outside, "keep").unwrap();
        let out = execute(
            &c,
            &skills,
            "write_file",
            &json!({"path": outside, "content": "y"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("FORBIDDEN"), "{}", out.text);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
    }

    #[tokio::test]
    async fn preview_html_writes_a_versioned_snapshot_and_rejects_non_html_files() {
        let vault = std::env::temp_dir().join("bnote-preview-test");
        let data = std::env::temp_dir().join("bnote-preview-data");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join("page.html"), "<p>hi</p>").unwrap();
        let c = ctx(&vault, &data);
        let skills = super::super::skills::SkillRegistry { skills: vec![] };
        let out = execute(&c, &skills, "preview_html", &json!({"path": "page.html"})).await;
        assert!(out.ok, "{}", out.text);
        let snapshot = data.join("creative-preview").join("preview-0.html");
        assert_eq!(std::fs::read_to_string(&snapshot).unwrap(), "<p>hi</p>");
        // The test environment has no AppHandle: no screenshot is awaited, the
        // result degrades to plain text and says so.
        assert!(
            out.images.is_empty(),
            "there must be no images without an app handle"
        );
        assert!(out.text.contains("no screenshot"), "{}", out.text);
        // A non-.html file is rejected
        let out = execute(&c, &skills, "preview_html", &json!({"path": "page.md"})).await;
        assert!(!out.ok && out.text.contains(".html"), "{}", out.text);
    }
}
