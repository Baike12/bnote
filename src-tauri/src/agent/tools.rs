//! Built-in tools: file access, URL reading, skills, glob/grep.
//!
//! Session-owned tools (bash, todo, task) live on the session; everything that
//! only needs the shared context runs here. `bash` moved to `shell.rs` for the
//! persistent-cwd execution model; the session's `execute_tool_shared` routes to it.

use crate::commands::normalize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use super::file_state::{FileState, FileStateCache};
use super::shell::{BgRegistry, ShellCwd};
use super::types::InlineImage;

/// Files above this size must be read with `offset`/`limit`: reading one into
/// memory only to truncate the result at [`MAX_RESULT_BYTES`] wastes both. 256
/// KB is Claude Code's default read cap.
const MAX_READ_BYTES: u64 = 256 * 1024;

/// The Read tool's output cap, in bytes of formatted text (~40k ASCII
/// characters). Long files are Read in ranges.
const MAX_RESULT_BYTES: usize = 40_000;

/// WebFetch reads at most this much of a response body. Docs pages are well
/// under it; a binary or an endless stream stops here instead of filling
/// memory.
const MAX_FETCH_BYTES: usize = 2 * 1024 * 1024;

/// One image attachment limit. Anthropic rejects a request whose image exceeds
/// 5 MB, so refusing here beats a provider error after the turn has spent its
/// tokens.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// Tool execution result. Text tools only carry `text`; a rich-output tool may
/// attach images, which the session writes into ToolResult.images: a rendered
/// preview screenshot (preview_html) or a file the agent looked at (Read).
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
    /// What the model has read in this session: path → (mtime, range). Write
    /// and Edit gate on it; Read records into it. Session-owned, never shared
    /// between a parent and its subagents — a child that was spawned without
    /// the parent's transcript has not seen those tool results either.
    pub files: Arc<FileStateCache>,
    /// The current model accepts images (the catalog's per-model flag). Read
    /// refuses to attach an image to a model that cannot see it; the session
    /// updates this on a model switch.
    pub vision: AtomicBool,
    /// Extra writable roots from `settings.permissions.additionalDirectories`.
    pub extra_roots: Vec<PathBuf>,
    /// The invest session's scope (`stock:600519` / `sector:801010`). The
    /// `read_skill` tool reads ONLY this scope's skill through
    /// `invest::skill::read` — scope isolation lives in the model, not in the
    /// prompt: the tool has no path parameter to misuse.
    pub invest_scope: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StudyContent {
    Pdf { path: String, title: String },
    Url { url: String, title: String },
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

    /// Cache key for a file: symlinked spellings of the same file share one
    /// entry. A path that does not exist yet keeps its lexical form; Write
    /// records it only after the file exists.
    fn cache_key(path: &Path) -> PathBuf {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    }

    /// The write gate shared by Write and Edit: an existing file must have been
    /// Read in this session and must not have changed on disk since. `Ok(None)`
    /// means the file does not exist; creating it needs no prior Read.
    ///
    /// Bash writes are covered without a hook: the next Write/Edit compares the
    /// disk mtime against the recorded one and refuses.
    async fn writable_mtime(&self, path: &Path) -> Result<Option<SystemTime>, String> {
        let meta = match tokio::fs::metadata(path).await {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("cannot stat {}: {e}", path.display())),
        };
        let mtime = meta
            .modified()
            .map_err(|e| format!("cannot read the mtime of {}: {e}", path.display()))?;
        let Some(state) = self.files.get(&Self::cache_key(path)) else {
            return Err(format!(
                "{} has not been read in this session: Read it before writing",
                path.display()
            ));
        };
        if mtime > state.mtime {
            return Err(format!(
                "{} changed on disk after it was read (by the user, a formatter, or a shell command): Read it again before writing",
                path.display()
            ));
        }
        Ok(Some(mtime))
    }

    /// Records a file the tool just wrote, so the next Write/Edit needs no new
    /// Read and a following Read re-sends the new content instead of a stub.
    ///
    /// A failed stat is ignored on purpose: the write already succeeded, and
    /// dropping the record only forces the model to Read again (the safe
    /// direction). Returning an error here would report a false write failure.
    async fn note_written(&self, path: &Path) {
        if let Ok(meta) = tokio::fs::metadata(path).await {
            if let Ok(mtime) = meta.modified() {
                self.files.record(
                    &Self::cache_key(path),
                    FileState {
                        mtime,
                        offset: None,
                        limit: None,
                    },
                );
            }
        }
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
    /// coding session) or the vault, plus the agent home (memory,
    /// skills, plans) and the system temp directories. The vault is *not*
    /// writable from a coding session: the repository and the notebook are
    /// unrelated stores.
    ///
    /// `mode` is the session's permission mode, and it is the outer gate:
    /// `full` ("完全访问") means no path boundary at all — a boundary here would
    /// veto a write the user already granted, which is how every `/tmp` write
    /// failed in full mode.
    fn ensure_confined(&self, path: &Path, mode: super::permissions::Mode) -> Result<(), String> {
        if mode == super::permissions::Mode::Full {
            return Ok(());
        }
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
        // Scratch space is always writable: a temporary artifact is not a
        // file the user has to approve, and the tools' own caches land here
        // too. `/tmp` is added next to `temp_dir()` because on macOS they are
        // different trees (`$TMPDIR` is `/var/folders/…`, `/tmp` is
        // `/private/tmp`), and the model writes the one it knows.
        roots.push(std::env::temp_dir());
        roots.push(PathBuf::from("/tmp"));
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

/// Legacy snake_case names map onto their Claude Code names so restored
/// transcripts and hand-written settings keep dispatching after the rename.
/// Unknown names (MCP) pass through unchanged.
pub fn canonical(name: &str) -> &str {
    match name {
        "read_file" => "Read",
        "write_file" => "Write",
        "edit_file" => "Edit",
        "list_files" => "LS",
        "glob" => "Glob",
        "grep" => "Grep",
        "bash" => "Bash",
        "bash_output" => "TaskOutput",
        "bash_kill" => "TaskStop",
        "todo" => "TodoWrite",
        "todo_read" => "TodoRead",
        "task" => "Agent",
        "task_create" => "TaskCreate",
        "task_update" => "TaskUpdate",
        "task_list" => "TaskList",
        "task_get" => "TaskGet",
        "send_message" => "SendMessage",
        "ask_user_question" => "AskUserQuestion",
        "read_url" => "WebFetch",
        "skill" => "Skill",
        _ => name,
    }
}

pub fn tool_schemas() -> &'static [(&'static str, &'static str, Value)] {
    static SCHEMAS: std::sync::OnceLock<Vec<(&'static str, &'static str, Value)>> =
        std::sync::OnceLock::new();
    SCHEMAS.get_or_init(|| vec![
    (
        "Read",
        "Reads a file from the local filesystem. Text results are returned in cat -n format with line numbers starting at 1, truncated at ~2000 lines; PNG/JPEG/GIF/WebP images are returned as image content the model can look at. Paths are relative to the working directory or absolute. You must read a file before editing it. Repeating the same offset/limit on a file that has not changed returns a short note instead of the content. Files above 256 KB must be read in ranges (pass limit).",
        json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "File path, working-directory-relative or absolute"},
                "offset": {"type": "integer", "description": "Line number to start reading from (1-based)"},
                "limit": {"type": "integer", "description": "Number of lines to read"}
            },
            "required": ["file_path"]
        }),
    ),
    (
        "Write",
        "Writes a file to the local filesystem, overwriting it if it exists (parent directories are created). Overwriting an existing file requires that Read opened it in this session and that it has not changed on disk since; otherwise the write fails. NEVER create documentation files (*.md) or README files unless explicitly requested.",
        json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Working-directory-relative or absolute path"},
                "content": {"type": "string", "description": "Full file contents"}
            },
            "required": ["file_path", "content"]
        }),
    ),
    (
        "Edit",
        "Performs exact string replacement in a file. You must use the Read tool on the file in this session before editing, and the edit fails if the file changed on disk since that read. The edit FAILS if old_string is not unique — include more surrounding context to make it unique, or use replace_all. To replace many occurrences at once set replace_all to true.",
        json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Working-directory-relative or absolute path"},
                "old_string": {"type": "string", "description": "Exact text to replace"},
                "new_string": {"type": "string", "description": "Replacement text (must differ from old_string)"},
                "replace_all": {"type": "boolean", "description": "Replace every occurrence (default false)"}
            },
            "required": ["file_path", "old_string", "new_string"]
        }),
    ),
    (
        "LS",
        "Lists every file under the working directory (relative paths, hidden entries skipped).",
        json!({"type": "object", "properties": {}}),
    ),
    (
        "WebFetch",
        "Fetches content from a URL and returns its readable text (HTML stripped, ~40 KB cap). Redirects are followed and the final URL is reported; a non-2xx response is an error; the body read is capped at 2 MB. Use it for documentation and issues instead of curl.",
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "http(s) URL"},
                "prompt": {"type": "string", "description": "What to look for; the result should be read with this question in mind"}
            },
            "required": ["url"]
        }),
    ),
    (
        "Bash",
        "Runs a shell command. The working directory persists between calls (cd is remembered); shell state does not. Returns combined stdout+stderr and the exit code; default 120s timeout, max 600s. With run_in_background=true the command runs detached and the result is a task id — read it with TaskOutput; the session is woken automatically when the task finishes. Avoid using Bash for file search (use Glob/Grep) or reading/editing files (use Read/Write/Edit) — the dedicated tools are safer and cheaper.",
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The shell command to execute"},
                "timeout": {"type": "integer", "description": "Timeout in seconds; default 120, max 600"},
                "description": {"type": "string", "description": "A one-line active-voice description of what the command does"},
                "run_in_background": {"type": "boolean", "description": "Run detached; poll with TaskOutput"}
            },
            "required": ["command"]
        }),
    ),
    (
        "TaskOutput",
        "Reads the output of a background shell task started with Bash run_in_background.",
        json!({
            "type": "object",
            "properties": {
                "task_id": {"type": "integer", "description": "The background task id"}
            },
            "required": ["task_id"]
        }),
    ),
    (
        "TaskStop",
        "Stops a running background shell task (task_id) or a subagent (agent_id). A stopped subagent reports \"stopped\"; resume it with SendMessage.",
        json!({
            "type": "object",
            "properties": {
                "task_id": {"type": "integer", "description": "The background shell task id (Bash run_in_background)"},
                "agent_id": {"type": "string", "description": "The agentId returned by the Agent tool"}
            }
        }),
    ),
    (
        "Glob",
        "Lists files whose path matches a glob pattern (e.g. src/**/*.rs, *.{ts,tsx}), relative to the working directory. Respects .gitignore; sorted; capped at 500 entries.",
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern relative to the working directory"}
            },
            "required": ["pattern"]
        }),
    ),
    (
        "Grep",
        "A powerful search tool built on a regex engine: searches file contents and returns path:line: text matches, capped at 200. Respects .gitignore. NEVER invoke grep or rg as a Bash command — use this tool.",
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regular expression"},
                "glob": {"type": "string", "description": "Optional file-name glob filter, e.g. *.rs"}
            },
            "required": ["pattern"]
        }),
    ),
    (
        "TodoWrite",
        "Replaces the session's todo list. Use it to plan multi-step work (3 or more distinct steps) and keep the user informed: one item = one step, exactly ONE task in_progress at a time, mark completed as soon as a step is done. content is imperative (what to do); active_form is the present-progress form shown while running.",
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
        "TodoRead",
        "Reads the session's current todo list back. Use it to check what is still open (after a compaction, before reporting done, or when resuming a long task); it takes no input.",
        json!({"type": "object", "properties": {}}),
    ),
    (
        "Agent",
        "Launch a new agent to handle complex, multi-step tasks autonomously. The agent has its own context window and returns a single final report, so it is the right tool for broad searches, independent sub-problems, or anything whose intermediate output would flood this conversation.\n\nWhen to use: research across many files, exploring a codebase for an answer, or independent work that can run while you continue. When NOT to use: a simple directed search (use Glob/Grep), or work that depends on what you are doing right now.\n\nUsage: launch every agent you need in ONE message (several Agent tool calls side by side) — they run in parallel. Calls beyond the user's concurrency setting queue and start as slots free up, so also give each agent a self-contained `description` (it is the row the user watches). To continue an agent you already launched (including one that stopped on an error), use SendMessage with its agentId instead of spawning a new one. Trust the report and do not duplicate the agent's work yourself. `run_in_background: true` returns immediately; you are notified when it finishes, and TaskStop with its agentId stops it. `fork: true` starts from this conversation's transcript instead of a fresh context.",
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
        "TaskCreate",
        "Create a task in the task list. Use it for work with 3+ steps: create the tasks first, then update them as you go. A task starts in status pending.",
        super::tasks::create_schema(),
    ),
    (
        "TaskUpdate",
        "Update one task of the task list: set its status, subject, description, owner, or its dependency edges (add_blocks / add_blocked_by).",
        super::tasks::update_schema(),
    ),
    (
        "TaskList",
        "List every task with its id, status and blocking edges.",
        super::tasks::list_schema(),
    ),
    (
        "TaskGet",
        "Read one task by id.",
        super::tasks::get_schema(),
    ),
    (
        "SendMessage",
        "Send a message to a subagent you spawned earlier. A running agent receives it at its next turn; an agent that already finished (including one that stopped on an error or a rate limit) is resumed in the background with its full history intact, and you are notified when it reports back. Use the agentId from the Agent tool result.",
        json!({
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "The agentId returned by the Agent tool"},
                "summary": {"type": "string", "description": "A 5-10 word summary of the message"},
                "message": {"type": "string", "description": "The message or follow-up task for the agent"}
            },
            "required": ["to", "message"]
        }),
    ),
    (
        "AskUserQuestion",
        "Ask the user a question and wait for the answer. Use it when you genuinely need a decision only the user can make (a choice between approaches, missing requirements, an ambiguity that changes the implementation) — not as a first response to friction. Provide 2-4 concrete options per question; the user may also type a custom answer. If you recommend an option, make it the first one and add \"(Recommended)\" to its label.",
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
        "Switch this session into plan mode: explore the codebase freely (Read / Glob / Grep / read-only shell) but do not change anything — Write, Edit and mutating shell commands are denied. Use it when a task needs an agreed approach before implementation. Finish by calling ExitPlanMode with the plan.",
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
        "Read the text of the web page currently open in the study panel. PDFs are not extracted into text: the user captures the reading area as a screenshot (⌘⇧E) instead.",
        json!({"type": "object", "properties": {}}),
    ),
    (
        "read_skill",
        "Read the current invest scope's prediction skill bundle: SKILL.md (the strategy rules), MEMORY.md (the verified facts and falsified hypotheses) and the version list. The scope is fixed by the session — there is no scope parameter, and no other scope's skill is reachable.",
        json!({
            "type": "object",
            "properties": {
                "part": {"type": "string", "enum": ["skill", "memory", "versions"], "description": "Which part to read; omitted = the whole bundle"}
            }
        }),
    ),
    (
        "Skill",
        "Load a skill's full instructions by name. Available skills are listed in the system prompt. When users reference a \"slash command\" or \"/<something>\", they mean a skill — load it with this tool before acting on their request.",
        json!({
            "type": "object",
            "properties": {
                "skill": {"type": "string", "description": "Skill name from the system prompt"},
                "args": {"type": "string", "description": "Optional arguments the user passed after the slash command"}
            },
            "required": ["skill"]
        }),
    ),
])
}

/// Tools that may run concurrently with their neighbours in one assistant
/// message (CC's `isConcurrencySafe`). Everything else — anything that writes,
/// spawns or mutates session state — runs alone and in call order.
///
/// `Agent` is safe: each launch has its own child session, its own context
/// window and its own abort token, and the parent's shared state (children
/// map, request log) is behind a mutex. Without it, "spawn three agents in one
/// message" silently ran them one after another — the exact reason the model's
/// parallel-delegation prompt had no effect.
pub fn is_concurrency_safe(name: &str) -> bool {
    matches!(
        canonical(name),
        "Read"
            | "LS"
            | "Glob"
            | "Grep"
            | "WebFetch"
            | "read_study_content"
            | "read_skill"
            | "Skill"
            | "TaskList"
            | "TaskGet"
            | "TodoRead"
            | "Agent"
    )
}

/// Executes a built-in tool.
pub async fn execute(
    ctx: &ToolContext,
    skills: &super::skills::SkillRegistry,
    name: &str,
    input: &Value,
    mode: super::permissions::Mode,
) -> ToolOutput {
    // Tools whose result is richer than text: a rendered screenshot
    // (preview_html) or image content (Read).
    match canonical(name) {
        "preview_html" => {
            let path = input["path"].as_str().unwrap_or_default();
            return preview_html(ctx, path).await;
        }
        "Read" => return read_tool(ctx, input).await,
        _ => {}
    }
    let (ok, text) = execute_text(ctx, skills, name, input, mode).await;
    ToolOutput::text(ok, text)
}

/// Executes a built-in tool. Returns (ok, output).
async fn execute_text(
    ctx: &ToolContext,
    skills: &super::skills::SkillRegistry,
    name: &str,
    input: &Value,
    mode: super::permissions::Mode,
) -> (bool, String) {
    // The canonical dispatch name: legacy names in restored histories land here
    // through the same table the schema list uses.
    let name = canonical(name);
    // CC-style param names with the legacy keys as fallbacks.
    let path_param = || {
        input["file_path"]
            .as_str()
            .or_else(|| input["path"].as_str())
            .unwrap_or_default()
            .to_string()
    };
    match name {
        "Write" => {
            let path = path_param();
            let content = input["content"].as_str().unwrap_or_default();
            match ctx.resolve(&path) {
                Ok(p) => {
                    if let Err(e) = ctx.ensure_confined(&p, mode) {
                        return (false, e);
                    }
                    if let Err(e) = ctx.writable_mtime(&p).await {
                        return (false, e);
                    }
                    if let Some(parent) = p.parent() {
                        if let Err(e) = tokio::fs::create_dir_all(parent).await {
                            return (false, format!("cannot create {}: {e}", parent.display()));
                        }
                    }
                    match tokio::fs::write(&p, content).await {
                        Ok(()) => {
                            ctx.note_written(&p).await;
                            (
                                true,
                                format!("wrote {} ({} bytes)", p.display(), content.len()),
                            )
                        }
                        Err(e) => (false, format!("write failed: {}", e)),
                    }
                }
                Err(e) => (false, e),
            }
        }
        "LS" => {
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
        "Glob" => {
            let pattern = input["pattern"].as_str().unwrap_or_default().to_string();
            if pattern.trim().is_empty() {
                return (false, "pattern must not be empty".into());
            }
            match ctx.root() {
                Ok(root) => match super::search::glob(&root, &pattern).await {
                    Ok(text) => (true, text),
                    Err(e) => (false, e),
                },
                Err(e) => (false, e),
            }
        }
        "Grep" => {
            let pattern = input["pattern"].as_str().unwrap_or_default().to_string();
            if pattern.trim().is_empty() {
                return (false, "pattern must not be empty".into());
            }
            // `glob` is the CC name; `include` is the legacy key.
            let include = input["glob"]
                .as_str()
                .or_else(|| input["include"].as_str())
                .map(|s| s.to_string());
            match ctx.root() {
                Ok(root) => match super::search::grep(&root, &pattern, include).await {
                    Ok(text) => (true, text),
                    Err(e) => (false, e),
                },
                Err(e) => (false, e),
            }
        }
        "WebFetch" => {
            let url = input["url"].as_str().unwrap_or_default().to_string();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return (false, "invalid url".into());
            }
            match fetch_url(&url).await {
                Ok(text) => (true, text),
                Err(e) => (false, e),
            }
        }
        "Edit" => {
            let path = path_param();
            let old = input["old_string"].as_str().unwrap_or_default();
            let new = input["new_string"].as_str().unwrap_or_default();
            let replace_all = input["replace_all"].as_bool().unwrap_or(false);
            if old.is_empty() {
                return (
                    false,
                    "old_string must not be empty (use Write for a new file)".into(),
                );
            }
            match ctx.resolve(&path) {
                Ok(p) => {
                    if let Err(e) = ctx.ensure_confined(&p, mode) {
                        return (false, e);
                    }
                    if let Err(e) = ctx.writable_mtime(&p).await {
                        return (false, e);
                    }
                    match tokio::fs::read_to_string(&p).await {
                        Ok(content) => {
                            let hits = content.matches(old).count();
                            if hits == 0 {
                                (false, "old_string does not exist in the file (Read it first; check whitespace and line endings)".into())
                            } else if hits > 1 && !replace_all {
                                (false, format!("old_string occurs {hits} times: add more surrounding context to make it unique, or set replace_all: true"))
                            } else {
                                let updated = if replace_all {
                                    content.replace(old, new)
                                } else {
                                    content.replacen(old, new, 1)
                                };
                                match tokio::fs::write(&p, updated).await {
                                    Ok(()) => {
                                        ctx.note_written(&p).await;
                                        (
                                            true,
                                            format!(
                                                "edited {} ({} replacement{})",
                                                p.display(),
                                                if replace_all { hits } else { 1 },
                                                if replace_all && hits > 1 { "s" } else { "" }
                                            ),
                                        )
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
        "read_skill" => {
            // The scope comes from the session, never from the tool input:
            // one session sees exactly one scope's bundle.
            let Some(scope) = ctx.invest_scope.as_deref() else {
                return (
                    false,
                    "no invest scope: this session is not scoped to an instrument".into(),
                );
            };
            let Some(vault) = ctx.vault.as_deref() else {
                return (false, "no vault is open".into());
            };
            let part = input["part"].as_str().unwrap_or("all");
            match super::super::invest::skill::read_bundle(std::path::Path::new(vault), scope) {
                Ok(bundle) => {
                    let text = match part {
                        "skill" => bundle.skill,
                        "memory" => bundle.memory,
                        "versions" => {
                            if bundle.versions.is_empty() {
                                "（还没有版本快照）".to_string()
                            } else {
                                bundle
                                    .versions
                                    .iter()
                                    .map(|v| format!("v{} — {}", v.version, v.file))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            }
                        }
                        _ => format!(
                            "# SKILL.md\n\n{}\n\n# MEMORY.md\n\n{}\n\n# versions\n\n{}",
                            bundle.skill,
                            if bundle.memory.trim().is_empty() {
                                "（空）"
                            } else {
                                &bundle.memory
                            },
                            bundle
                                .versions
                                .iter()
                                .map(|v| format!("v{} — {}", v.version, v.file))
                                .collect::<Vec<_>>()
                                .join("\n")
                        ),
                    };
                    (true, text)
                }
                Err(e) => (false, format!("skill read failed: {}", e)),
            }
        }
        "read_study_content" => {
            let content = ctx.study_content.read().ok().and_then(|g| g.clone());
            match content {
                Some(StudyContent::Pdf { .. }) => (
                    false,
                    "PDF 文本不再提取:请用阅读区截图(⌘⇧E)把页面发给助手".into(),
                ),
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
        "Skill" => {
            let skill_name = input["skill"]
                .as_str()
                .or_else(|| input["name"].as_str())
                .unwrap_or_default();
            match skills.load(skill_name) {
                Some(content) => (true, content),
                None => (false, format!("unknown skill: {}", skill_name)),
            }
        }
        _ => (false, format!("unknown tool: {}", name)),
    }
}

/// The Read tool: text through [`read_text`], images as provider-visible
/// content. An image is its own result shape (`ToolOutput.images`), which the
/// session stores in the tool result and the provider layer delivers.
async fn read_tool(ctx: &ToolContext, input: &Value) -> ToolOutput {
    let path = input["file_path"]
        .as_str()
        .or_else(|| input["path"].as_str())
        .unwrap_or_default()
        .to_string();
    let resolved = match ctx.resolve(&path) {
        Ok(p) => p,
        Err(e) => return ToolOutput::text(false, e),
    };
    if let Some(declared) = image_media_type(&resolved) {
        return read_image(ctx, &resolved, declared).await;
    }
    let offset = input["offset"].as_u64().unwrap_or(1).max(1);
    let limit = input["limit"].as_u64();
    let (ok, text) = read_text(ctx, &resolved, offset, limit).await;
    ToolOutput::text(ok, text)
}

/// The media type a Read should attach, chosen by extension. The content is
/// verified against the magic bytes before it is sent.
fn image_media_type(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

/// The true format of an image, from its first bytes: a text file renamed to
/// `.png` must not be handed to the provider as an image block.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// An image Read: the image goes to the model only when the model can see it,
/// and only when the bytes really are the format the name claims.
async fn read_image(ctx: &ToolContext, path: &Path, declared: &str) -> ToolOutput {
    if !ctx.vision.load(Ordering::SeqCst) {
        return ToolOutput::text(
            false,
            format!(
                "{} is an image, but the current model cannot view images (no vision). Switch to a vision model to Read it",
                path.display()
            ),
        );
    }
    let meta = match tokio::fs::metadata(path).await {
        Ok(meta) => meta,
        Err(e) => return ToolOutput::text(false, format!("read failed: {e}")),
    };
    if meta.len() > MAX_IMAGE_BYTES {
        return ToolOutput::text(
            false,
            format!(
                "{} is {} bytes, above the {} MB image limit; shrink it first",
                path.display(),
                meta.len(),
                MAX_IMAGE_BYTES / (1024 * 1024)
            ),
        );
    }
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(e) => return ToolOutput::text(false, format!("read failed: {e}")),
    };
    let Some(media_type) = sniff_image(&bytes) else {
        return ToolOutput::text(
            false,
            format!(
                "{} has the extension of a {} file but its content is not PNG/JPEG/GIF/WebP",
                path.display(),
                declared.trim_start_matches("image/").to_uppercase()
            ),
        );
    };
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    ToolOutput {
        ok: true,
        text: format!(
            "Read image {} ({}, {:.1} KB). It is attached below.",
            path.display(),
            media_type,
            bytes.len() as f64 / 1024.0
        ),
        images: vec![InlineImage {
            media_type: media_type.to_string(),
            data,
        }],
    }
}

/// WebFetch: a bounded read with honest status handling, then HTML → text.
async fn fetch_url(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        // No default UA gets a 403 from many documentation sites.
        .user_agent("bnote-agent/0.1")
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    let status = resp.status();
    // Redirects are followed by the client; report where the content came from
    // so the model cites the right URL.
    let final_url = resp.url().to_string();
    if !status.is_success() {
        return Err(format!("fetch failed: HTTP {status} from {final_url}"));
    }
    let mime = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if let Some(len) = resp.content_length() {
        if len > MAX_FETCH_BYTES as u64 {
            return Err(format!(
                "fetch failed: {final_url} is {len} bytes, above the {} MB fetch cap",
                MAX_FETCH_BYTES / (1024 * 1024)
            ));
        }
    }
    let mut body: Vec<u8> = Vec::new();
    let mut capped = false;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?
    {
        if body.len() + chunk.len() > MAX_FETCH_BYTES {
            body.extend_from_slice(&chunk[..MAX_FETCH_BYTES - body.len()]);
            capped = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    let raw = String::from_utf8_lossy(&body);
    let text = if mime.contains("html") {
        html_to_text(&raw)
    } else {
        raw.into_owned()
    };
    let note = if capped {
        "\n\n[truncated at 2 MB]"
    } else {
        ""
    };
    Ok(format!(
        "{final_url}\n\n{}{}",
        truncate(&text, MAX_RESULT_BYTES),
        note
    ))
}

/// The Read tool: mtime-keyed dedupe, the byte guard, then `cat -n` output.
///
/// The state is recorded from the stat taken *before* the content, so a file
/// that changes during the read is stored with the older mtime; the next
/// Write/Edit then refuses it as stale instead of accepting content the model
/// never saw.
async fn read_text(
    ctx: &ToolContext,
    path: &Path,
    offset: u64,
    limit: Option<u64>,
) -> (bool, String) {
    let meta = match tokio::fs::metadata(path).await {
        Ok(meta) => meta,
        Err(e) => return (false, format!("read failed: {e}")),
    };
    let mtime = match meta.modified() {
        Ok(mtime) => mtime,
        Err(e) => {
            return (
                false,
                format!(
                    "read failed: cannot read the mtime of {}: {e}",
                    path.display()
                ),
            );
        }
    };
    // An unbounded read of a large file pulls the whole thing into memory only
    // to cut the result short; make the model page through it instead.
    if limit.is_none() && meta.len() > MAX_READ_BYTES {
        return (
            false,
            format!(
                "{} is {} bytes: Read it with offset and limit instead of in one result",
                path.display(),
                meta.len()
            ),
        );
    }
    let key = ToolContext::cache_key(path);
    if let Some(state) = ctx.files.get(&key) {
        if state.mtime == mtime && state.covers(offset, limit) {
            return (
                true,
                format!(
                    "{} is unchanged since the last Read in this session: the earlier content is still in the conversation",
                    path.display()
                ),
            );
        }
    }
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        // A binary that is not a supported image: say what Read can take, not
        // the bare "stream did not contain valid UTF-8".
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            return (
                false,
                format!(
                    "{} is not UTF-8 text; Read handles text files and PNG/JPEG/GIF/WebP images",
                    path.display()
                ),
            );
        }
        Err(e) => return (false, format!("read failed: {e}")),
    };
    ctx.note_read(path);
    // cat -n format (CC's Read): line numbers starting at 1, honoring
    // offset/limit when given (2000 lines when the model gave no limit).
    let lines: Vec<&str> = content.lines().collect();
    let start = (offset as usize - 1).min(lines.len());
    let end = (start + limit.unwrap_or(2000) as usize).min(lines.len());
    let mut out = String::new();
    for (i, line) in lines[start..end].iter().enumerate() {
        out.push_str(&format!("{:>6}\t{}\n", start + i + 1, line));
    }
    let truncated = out.len() > MAX_RESULT_BYTES;
    ctx.files.record(
        &key,
        FileState {
            mtime,
            // A result cut by the output cap did not show the whole range, so
            // a repeat must re-send it: recording no range makes `covers` false.
            offset: (!truncated).then_some(offset),
            limit,
        },
    );
    (true, truncate(&out, MAX_RESULT_BYTES))
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
    // A model without vision gets no screenshot: the OpenAI wire would drop it
    // and a strict gateway would reject the turn.
    if ctx.vision.load(Ordering::SeqCst) && ctx.app.is_some() && cfg!(target_os = "macos") {
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

    use super::super::permissions::Mode;

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
            files: Arc::new(FileStateCache::new()),
            vision: AtomicBool::new(true),
            extra_roots: Vec::new(),
            invest_scope: None,
        }
    }

    fn skills() -> super::super::skills::SkillRegistry {
        super::super::skills::SkillRegistry { skills: vec![] }
    }

    /// Runs a tool under `mode`; a confinement decision depends on the mode,
    /// so the mode is part of every call.
    async fn run(c: &ToolContext, mode: Mode, name: &str, input: Value) -> ToolOutput {
        execute(c, &skills(), name, &input, mode).await
    }

    /// A directory outside every writable root that the test process can still
    /// write to (sticky, world-writable): "forbidden" is then proven by the
    /// tool's own boundary, not by an OS permission error.
    ///
    /// One directory per call: the tests run in parallel and each one cleans up
    /// after itself.
    fn outside_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let base = if Path::new("/private/var/tmp").is_dir() {
            PathBuf::from("/private/var/tmp")
        } else {
            PathBuf::from("/var/tmp")
        };
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        base.join(format!("bnote-outside-{}-{}", std::process::id(), n))
    }

    #[tokio::test]
    async fn edit_file_replaces_the_exact_match_once() {
        let vault = std::env::temp_dir().join("bnote-edit-test-1");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let file = vault.join("post.html");
        std::fs::write(&file, "<h1>旧标题</h1>\n<p>正文</p>\n").unwrap();
        let c = ctx(&vault, &vault);
        let out = run(&c, Mode::Auto, "Read", json!({"file_path": "post.html"})).await;
        assert!(out.ok, "{}", out.text);
        let out = run(
            &c,
            Mode::Auto,
            "Edit",
            json!({"file_path": "post.html", "old_string": "<h1>旧标题</h1>", "new_string": "<h1>新标题</h1>"}),
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
        let out = run(&c, Mode::Auto, "Read", json!({"file_path": "post.md"})).await;
        assert!(out.ok, "{}", out.text);
        let out = run(
            &c,
            Mode::Auto,
            "Edit",
            json!({"file_path": "post.md", "old_string": "xyz", "new_string": "q"}),
        )
        .await;
        assert!(
            !out.ok && out.text.contains("does not exist"),
            "{}",
            out.text
        );
        let out = run(
            &c,
            Mode::Auto,
            "Edit",
            json!({"file_path": "post.md", "old_string": "a", "new_string": "q"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("2 times"), "{}", out.text);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "a b a",
            "the file must be unchanged"
        );
    }

    #[tokio::test]
    async fn edit_file_refuses_a_path_outside_the_roots_in_autonomous_mode() {
        let vault = std::env::temp_dir().join("bnote-edit-test-3");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let c = ctx(&vault, &vault);
        let outside = outside_dir();
        std::fs::create_dir_all(&outside).unwrap();
        let file = outside.join("note.md");
        std::fs::write(&file, "x").unwrap();
        let out = run(
            &c,
            Mode::Auto,
            "Edit",
            json!({"file_path": file, "old_string": "x", "new_string": "y"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("FORBIDDEN"), "{}", out.text);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn full_access_writes_anywhere_without_a_path_boundary() {
        // "完全访问" is the composer's label for `full`: a write the user
        // granted must not be vetoed by the path boundary (the `/tmp` failure).
        let vault = std::env::temp_dir().join("bnote-full-test");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let c = ctx(&vault, &vault);
        let outside = outside_dir();
        std::fs::create_dir_all(&outside).unwrap();
        let file = outside.join("anywhere.md");
        let out = run(
            &c,
            Mode::Full,
            "Write",
            json!({"file_path": file, "content": "ok"}),
        )
        .await;
        assert!(out.ok, "{}", out.text);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "ok");
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn temp_directories_are_writable_in_every_mode() {
        // Scratch space is not a file the user has to approve: another tool
        // wrote /tmp/f.html successfully while Write refused it, which is the
        // inconsistency this test locks shut.
        let vault = std::env::temp_dir().join("bnote-temp-test");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let c = ctx(&vault, &vault);
        for mode in [Mode::Auto, Mode::Confirm] {
            let name = format!("bnote-temp-{:?}.html", mode).to_lowercase();
            // `$TMPDIR` and the literal `/tmp` are different trees on macOS.
            for dir in [std::env::temp_dir(), PathBuf::from("/tmp")] {
                let file = dir.join(&name);
                let out = run(
                    &c,
                    mode,
                    "Write",
                    json!({"file_path": file, "content": "x"}),
                )
                .await;
                assert!(out.ok, "{:?} {}: {}", mode, file.display(), out.text);
                let _ = std::fs::remove_file(&file);
            }
        }
    }

    #[tokio::test]
    async fn a_workdir_anchors_relative_paths_and_is_writable() {
        // Coding session: the project root is the anchor for relative paths and
        // part of the writable boundary — without this the coding agent could
        // not touch the project it was opened for.
        //
        // The vault sits outside every root here: `$TMPDIR` is itself a
        // writable root (scratch space), so a vault inside it could not prove
        // the "a coding session does not write the notebook" rule.
        let outside = outside_dir();
        let _ = std::fs::remove_dir_all(&outside);
        let vault = outside.join("vault");
        let project = std::env::temp_dir().join("bnote-workdir-project");
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let mut c = ctx(&vault, &vault);
        c.workdir = Some(project.clone());
        let out = run(
            &c,
            Mode::Auto,
            "Write",
            json!({"file_path": "src/lib.rs", "content": "fn a() {}"}),
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
        let out = run(
            &c,
            Mode::Auto,
            "Write",
            json!({"file_path": format!("{}/v.md", vault.display()), "content": "x"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("FORBIDDEN"), "{}", out.text);
        assert!(!vault.join("v.md").exists());
        // Outside every root stays forbidden.
        let file = outside.join("keep.md");
        std::fs::write(&file, "keep").unwrap();
        let out = run(
            &c,
            Mode::Auto,
            "Write",
            json!({"file_path": file, "content": "y"}),
        )
        .await;
        assert!(!out.ok && out.text.contains("FORBIDDEN"), "{}", out.text);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(&outside);
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
        let out = run(&c, Mode::Auto, "preview_html", json!({"path": "page.html"})).await;
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
        let out = run(&c, Mode::Auto, "preview_html", json!({"path": "page.md"})).await;
        assert!(!out.ok && out.text.contains(".html"), "{}", out.text);
    }

    /// Reads through the tool, so the session records the state a later
    /// Write/Edit gates on.
    async fn read(c: &ToolContext, path: &str) -> ToolOutput {
        run(c, Mode::Auto, "Read", json!({"file_path": path})).await
    }

    /// Rewrites a file behind the agent's back (the user, a formatter, or a
    /// shell command). Sleeps first: the gate compares mtimes, and a
    /// coarse-grained filesystem would otherwise report the two writes as one.
    fn external_write(path: &Path, content: &str) {
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(path, content).unwrap();
    }

    #[tokio::test]
    async fn write_refuses_an_existing_file_that_was_not_read() {
        let vault = std::env::temp_dir().join("bnote-write-gate-test-1");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let file = vault.join("note.md");
        std::fs::write(&file, "user text").unwrap();
        let c = ctx(&vault, &vault);
        let out = run(
            &c,
            Mode::Auto,
            "Write",
            json!({"file_path": "note.md", "content": "agent text"}),
        )
        .await;
        assert!(
            !out.ok && out.text.contains("has not been read"),
            "{}",
            out.text
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "user text",
            "the refused write must not touch the file"
        );
        let out = read(&c, "note.md").await;
        assert!(out.ok, "{}", out.text);
        let out = run(
            &c,
            Mode::Auto,
            "Write",
            json!({"file_path": "note.md", "content": "agent text"}),
        )
        .await;
        assert!(out.ok, "{}", out.text);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "agent text");
    }

    #[tokio::test]
    async fn write_and_edit_refuse_a_file_changed_since_the_read() {
        let vault = std::env::temp_dir().join("bnote-write-gate-test-2");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let file = vault.join("note.md");
        std::fs::write(&file, "one").unwrap();
        let c = ctx(&vault, &vault);
        let out = read(&c, "note.md").await;
        assert!(out.ok, "{}", out.text);
        external_write(&file, "two");
        let out = run(
            &c,
            Mode::Auto,
            "Edit",
            json!({"file_path": "note.md", "old_string": "two", "new_string": "three"}),
        )
        .await;
        assert!(
            !out.ok && out.text.contains("changed on disk"),
            "{}",
            out.text
        );
        let out = run(
            &c,
            Mode::Auto,
            "Write",
            json!({"file_path": "note.md", "content": "x"}),
        )
        .await;
        assert!(
            !out.ok && out.text.contains("changed on disk"),
            "{}",
            out.text
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        // Reading again is the documented recovery: the gate then opens.
        let out = read(&c, "note.md").await;
        assert!(out.ok, "{}", out.text);
        let out = run(
            &c,
            Mode::Auto,
            "Edit",
            json!({"file_path": "note.md", "old_string": "two", "new_string": "three"}),
        )
        .await;
        assert!(out.ok, "{}", out.text);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "three");
    }

    #[tokio::test]
    async fn a_file_the_agent_wrote_can_be_edited_without_reading_it_again() {
        let vault = std::env::temp_dir().join("bnote-write-gate-test-3");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let c = ctx(&vault, &vault);
        let out = run(
            &c,
            Mode::Auto,
            "Write",
            json!({"file_path": "fresh.md", "content": "a b"}),
        )
        .await;
        assert!(out.ok, "{}", out.text);
        let out = run(
            &c,
            Mode::Auto,
            "Edit",
            json!({"file_path": "fresh.md", "old_string": "b", "new_string": "c"}),
        )
        .await;
        assert!(out.ok, "{}", out.text);
        assert_eq!(
            std::fs::read_to_string(vault.join("fresh.md")).unwrap(),
            "a c"
        );
    }

    #[tokio::test]
    async fn reading_the_same_range_twice_returns_a_stub() {
        let vault = std::env::temp_dir().join("bnote-read-dedupe-test");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let file = vault.join("note.md");
        std::fs::write(&file, "alpha\nbeta\n").unwrap();
        let c = ctx(&vault, &vault);
        let out = read(&c, "note.md").await;
        assert!(out.ok && out.text.contains("alpha"), "{}", out.text);
        let out = read(&c, "note.md").await;
        assert!(
            out.ok && out.text.contains("unchanged since the last Read"),
            "{}",
            out.text
        );
        // A changed file is read again in full, not stubbed.
        external_write(&file, "gamma\n");
        let out = read(&c, "note.md").await;
        assert!(out.ok && out.text.contains("gamma"), "{}", out.text);
    }

    #[tokio::test]
    async fn a_large_file_must_be_read_in_ranges() {
        let vault = std::env::temp_dir().join("bnote-read-size-test");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let file = vault.join("big.txt");
        std::fs::write(&file, "x".repeat(300 * 1024)).unwrap();
        let c = ctx(&vault, &vault);
        let out = read(&c, "big.txt").await;
        assert!(
            !out.ok && out.text.contains("offset and limit"),
            "{}",
            out.text
        );
        let out = run(
            &c,
            Mode::Auto,
            "Read",
            json!({"file_path": "big.txt", "limit": 3}),
        )
        .await;
        assert!(out.ok, "{}", out.text);
    }

    /// Serves exactly one HTTP response and returns its URL. The tool's client
    /// is the real one; the test only owns the wire bytes.
    async fn serve_once(status: &'static str, content_type: &'static str, body: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        tokio::spawn(async move {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let _ = sock.write_all(response.as_bytes()).await;
        });
        format!("http://{addr}/")
    }

    #[tokio::test]
    async fn webfetch_returns_stripped_text_and_reports_the_fetch_url() {
        let vault = std::env::temp_dir().join("bnote-webfetch-test");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let c = ctx(&vault, &vault);
        let url = serve_once(
            "200 OK",
            "text/html; charset=utf-8",
            "<html><body><h1>Docs</h1><p>Hello</p></body></html>".to_string(),
        )
        .await;
        let out = run(&c, Mode::Auto, "WebFetch", json!({"url": url})).await;
        assert!(out.ok, "{}", out.text);
        assert!(
            out.text.contains("Docs") && out.text.contains("Hello"),
            "{}",
            out.text
        );
        assert!(
            out.text.starts_with("http://127.0.0.1:"),
            "the final URL heads the result: {}",
            out.text
        );
        assert!(!out.text.contains("<h1>"), "HTML must be stripped");
    }

    #[tokio::test]
    async fn webfetch_treats_a_non_2xx_response_as_an_error() {
        let vault = std::env::temp_dir().join("bnote-webfetch-404-test");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let c = ctx(&vault, &vault);
        let url = serve_once(
            "404 Not Found",
            "text/html",
            "<html><body>missing</body></html>".to_string(),
        )
        .await;
        let out = run(&c, Mode::Auto, "WebFetch", json!({"url": url})).await;
        assert!(!out.ok && out.text.contains("404"), "{}", out.text);
    }

    #[tokio::test]
    async fn read_returns_an_image_as_image_content() {
        let vault = std::env::temp_dir().join("bnote-read-image-test");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        // The canonical 1x1 transparent PNG: the reader sniffs the signature.
        const PNG_1PX: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        std::fs::write(vault.join("shot.png"), PNG_1PX).unwrap();
        let c = ctx(&vault, &vault);
        let out = read(&c, "shot.png").await;
        assert!(out.ok, "{}", out.text);
        assert_eq!(out.images.len(), 1);
        assert_eq!(out.images[0].media_type, "image/png");
        assert!(out.text.contains("Read image"), "{}", out.text);

        // A model without vision must not be handed an image block.
        c.vision.store(false, Ordering::SeqCst);
        let out = read(&c, "shot.png").await;
        assert!(!out.ok && out.text.contains("no vision"), "{}", out.text);
        assert!(out.images.is_empty());

        // The extension alone does not make a file an image.
        let c = ctx(&vault, &vault);
        std::fs::write(vault.join("fake.png"), "plain text").unwrap();
        let out = read(&c, "fake.png").await;
        assert!(
            !out.ok && out.text.contains("not PNG/JPEG/GIF/WebP"),
            "{}",
            out.text
        );
    }

    #[tokio::test]
    async fn read_names_what_it_supports_for_a_binary_file() {
        let vault = std::env::temp_dir().join("bnote-read-binary-test");
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join("blob.bin"), [0xFFu8, 0xFE, 0x00, 0x01]).unwrap();
        let c = ctx(&vault, &vault);
        let out = read(&c, "blob.bin").await;
        assert!(
            !out.ok && out.text.contains("not UTF-8 text"),
            "{}",
            out.text
        );
    }

    #[test]
    fn task_stop_accepts_an_agent_id_without_a_task_id() {
        let schema = tool_schemas()
            .iter()
            .find(|(name, _, _)| *name == "TaskStop")
            .map(|(_, _, schema)| schema)
            .expect("TaskStop must be registered");
        assert!(crate::agent::schema::validate(
            schema,
            &json!({"agent_id": "s1-7-agent-1700000000000-1"})
        )
        .is_ok());
        assert!(crate::agent::schema::validate(schema, &json!({"task_id": 3})).is_ok());
    }

    #[tokio::test]
    async fn read_study_content_sends_pdfs_to_the_screenshot_workflow() {
        let vault = std::env::temp_dir().join("bnote-study-content-test");
        let c = ctx(&vault, &vault);
        *c.study_content.write().unwrap() = Some(StudyContent::Pdf {
            path: "/tmp/paper.pdf".into(),
            title: "paper".into(),
        });
        let out = run(&c, Mode::Auto, "read_study_content", json!({})).await;
        // PDF text extraction was removed together with pdf2md: the tool must
        // point at the reading-area screenshot instead of failing silently.
        assert!(!out.ok, "{}", out.text);
        assert!(out.text.contains("⌘⇧E"), "{}", out.text);
        assert!(out.text.contains("截图"), "{}", out.text);
    }
}
