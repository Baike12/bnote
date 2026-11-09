import { invoke } from "@tauri-apps/api/core";
import type { AgentImage } from "@/study/agentImages";

export type { AgentImage };

export interface VaultInfo {
  path: string;
  name: string;
}

export interface FileNode {
  name: string;
  relPath: string;
  kind: "file" | "dir";
  /** null = the directory's children are not loaded yet (lazy), call readDir to get them */
  children: FileNode[] | null;
}

export interface CreatedEntry {
  path: string;
  relPath: string;
}

export interface VaultIndex {
  files: string[];
  dirs: string[];
  /** Media files such as images and PDFs (vault-relative path), used to resolve file-name references like `![[x.png]]`. */
  assets: string[];
}

/** Whitelisted per-vault config files inside `<vault>/.bnote/`. */
export type VaultConfigFile =
  "vimrc" | "snippets.js" | "keybindings.json" | "agent.md" | "AGENTS.md";

export interface InputSourceInfo {
  id: string;
  name: string;
  isCjk: boolean;
}

export interface SetImeOutcome {
  switched: boolean;
  fallbackUsed: boolean;
}

// ---------------------------------------------------------------------------
// Study mode / agent
// ---------------------------------------------------------------------------

/**
 * Middle-column content. PDFs are displayed as PDFs (the reader renders them
 * with pdf.js) — no markdown conversion happens anywhere in this flow.
 */
export type StudyContent =
  { kind: "pdf"; path: string; title: string } | { kind: "url"; url: string; title: string };

/** The three agent shapes; the id is also the mode folder name. */
export type AgentMode = "coding" | "creative" | "study";

export interface AgentConfig {
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
  max_tokens: number;
  /** The model's context window (tokens), used to show the occupancy. */
  context_window: number;
  /**
   * Per-mode configuration root overrides (mode id → absolute path). The
   * default is `<vault>/.bnote/agents/<mode>`; this is the only agent setting
   * that stays in the home directory, because a path cannot be stored inside
   * the directory it moves.
   */
  agent_roots: Record<string, string>;
}

/** One entry of the built-in dictionary (select-to-translate → word). */
export interface DictEntry {
  word: string;
  phonetic: string;
  translation: string;
  pos: string;
}

/**
 * The result of one select-to-translate. A word is only looked up in the
 * built-in dictionary; a word that is not listed is a `miss` and never falls
 * back to an API call. Only sentences/phrases go to `sentence`.
 */
export type TranslateSelection =
  | { kind: "word"; entry: DictEntry }
  | { kind: "miss"; word: string }
  | { kind: "sentence"; translation: string }
  | { kind: "none" };

/** Sentence translation API config (independent of the study assistant, stored in translate.json). */
export interface TranslateConfig {
  protocol: string;
  base_url: string;
  api_key: string;
  model: string;
  /** false by default; when enabled, think/thinking/enable_thinking is sent according to the protocol. */
  thinking: boolean;
  timeout_ms: number;
  extra_body: Record<string, unknown>;
}

/** Where a skill was found: the mode root (vault), the code project, the shared `~/.agents`, or a configured extra directory. */
export type SkillSource = "vault" | "project" | "home" | "custom";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  /** The scanned root the skill belongs to (the settings page groups by it). */
  root: string;
}

export interface SessionInfo {
  sessionId: string;
  skills: SkillInfo[];
  mcpTools: string[];
  mcpErrors: string[];
  /** The model config actually used by this session (changing the settings does not affect an open session). */
  model?: SessionModelConfig;
  /** The agent definition the session runs with (id/name shown in the panel). */
  definition?: { id: string; name: string; description: string; tools: string[] };
}

/** The session-level model config snapshot (written into the first line of the session record; a restored session continues with it). */
export interface SessionModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  contextWindow: number;
}

/**
 * Auxiliary session: forks a new session from the `items`-th history entry
 * (a prefix, including that entry) of some session. The original session is
 * left untouched; `items` comes from the backend history count carried by
 * the turn_end/error events.
 */
export interface AgentForkSpec {
  from: string;
  items: number;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** A thinking block closed; `signature` is its integrity seal (empty when the gateway sends none). */
  | { type: "thinking_block_end"; signature: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; output: string; images?: AgentImage[] }
  /**
   * Token usage of one model request (the current context occupancy) plus the
   * session totals every request accumulated — the token-weighted cache hit
   * rate is computed from the totals, never from the latest request alone.
   */
  | {
      type: "usage";
      input: number;
      output: number;
      cacheRead: number;
      sessionInput: number;
      sessionCacheRead: number;
      sessionRequests: number;
    }
  /** A dim status line: compaction, subagent start/finish, background task done. Never enters the history. */
  | { type: "notice"; text: string }
  /** The todo tool's list after a `todo` call (the rendering source). */
  | { type: "todos"; todos: AgentTodoItem[] }
  /** The v2 task list after any task tool call. */
  | { type: "tasks"; tasks: AgentTaskItem[] }
  /** EnterPlanMode / ExitPlanMode switched plan mode (the panel shows a chip). */
  | { type: "plan_mode"; enabled: boolean }
  /** A tool marked `ask` needs the user's approval; answer with agentApi.permissionReply. */
  | { type: "permission_request"; id: string; tool: string; input: unknown }
  /** `ask_user_question` is waiting; answer with agentApi.questionReply. */
  | { type: "question"; id: string; questions: unknown }
  | { type: "turn_end"; reason: string; items: number }
  | { type: "error"; message: string; items: number };

/** One task of the v2 task list (CC's TaskCreate shape). */
export interface AgentTaskItem {
  id: string;
  subject: string;
  description: string;
  active_form: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blocks: string[];
  blocked_by: string[];
}

/** One item of the todo tool's list (Claude Code's TodoWrite schema). */
export interface AgentTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  active_form: string;
}

/** A PDF imported into the vault (`<vault>/pdfs/<stem>.pdf`). */
export interface ImportedPdf {
  pdfPath: string;
  /** Vault-relative path (for the history list / cross-vault migration). */
  relPath: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Python: markdown embedded code block runs / ty LSP / uv environments
// ---------------------------------------------------------------------------

export type PythonEnvKind = "config" | "venv" | "uv" | "system";

export interface PythonResolvedEnv {
  kind: PythonEnvKind;
  program: string;
  python: string | null;
  venvDir: string | null;
  detail: string;
}

export interface PythonRunStarted {
  runId: number;
  command: string;
  envKind: PythonEnvKind;
  program: string;
  cwd: string;
}

export interface PythonInfo {
  projectRoot: string | null;
  projectName: string;
  /** "off" | "ty" */
  lsp: string;
  pythonOverride: string | null;
  tyPath: string | null;
  venvExists: boolean;
  hasPyproject: boolean;
  env: PythonResolvedEnv | null;
  uvAvailable: boolean;
  tyAvailable: boolean;
}

export interface PythonProjectConfig {
  lsp?: string;
  python?: string;
  tyPath?: string;
}

export interface PythonLspSyncResult {
  enabled: boolean;
}

export interface PythonUvOutcome {
  log: string;
  ranInit: boolean;
}

/** The backend's streaming event (python-run-output). */
export interface PythonRunOutputEvent {
  runId: number;
  mdPath: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** The backend's finishing event (python-run-exit). */
export interface PythonRunExitEvent {
  runId: number;
  mdPath: string;
  exitCode: number | null;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
}

/** The raw LSP diagnostics forwarded by ty (python-lsp-diagnostics); line and column are in UTF-16 units. */
export interface PythonLspDiagnosticEvent {
  mdPath: string;
  diagnostics: unknown[];
}

/** The placeholder rectangle of the embedded web preview in the middle column (logical pixels, relative to the top-left of the window's content area). */
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The private directory of one study material (`<vault>/.bnote/materials/...`). */
export interface MaterialInfo {
  kind: "pdfs" | "webpages" | "wxreads";
  dir: string;
  relDir: string;
  title: string;
}

/** One saved session (file metadata; the body is read on demand). */
export interface SavedSessionMeta {
  id: string;
  title: string;
  /** The file id of the session this one was forked from; null for the main session (the session family is restored from it). */
  parent: string | null;
  /** The summary of the source message of an auxiliary session. */
  basedOn: string | null;
  /** The number of prefix entries copied over when forking; the session's own messages count from this one on. */
  forkAt: number | null;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

/** A model-side history entry; sent back to the backend when a session is restored (`agent_start_session.history`). */
export interface AgentChatItem {
  type: "message";
  role: "user" | "assistant";
  content: AgentContentBlock[];
}

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

/** The bblog blog service (the publishing target of creative mode). */
export const bblogApi = {
  /** The section tree (public; hand-made directories and front-end created sections have the same weight). */
  sections: (server: string) => invoke<BblogSections>("bblog_sections", { server }),
  publish: (input: {
    server: string;
    token: string;
    category: string;
    topic: string;
    filename: string;
    content: string;
  }) => invoke<BblogPublishResult>("bblog_publish", input),
};

export interface BblogTopic {
  name: string;
  count: number;
}

export interface BblogCategory {
  name: string;
  topics: BblogTopic[];
}

export interface BblogSections {
  categories: BblogCategory[];
}

export interface BblogPublishResult {
  ok: boolean;
  url: string;
  slug: string;
}

export const agentApi = {
  getConfig: () => invoke<AgentConfig>("agent_get_config"),
  saveConfig: (config: AgentConfig) => invoke<void>("agent_save_config", { config }),
  startSession: (
    study: StudyContent | null,
    fork?: AgentForkSpec,
    history?: AgentChatItem[],
    /** Restore/fork: keep the model config of the source session; when omitted, the currently saved config is used. */
    model?: SessionModelConfig,
    /** "creative" = creative mode (with tools/skill/MCP); "coding" = the code-project agent; omitted = study mode, plain question answering only. */
    mode?: "study" | "creative" | "coding",
    /** Coding sessions: the project root (relative tool paths and bash anchor there). */
    workdir?: string,
    /** Restore: the transcript record id, so the persisted task list continues. */
    taskListId?: string,
  ) =>
    invoke<SessionInfo>("agent_start_session", {
      study,
      fork,
      history,
      model,
      mode,
      workdir,
      taskListId,
    }),
  /** Stores one inline HTML preview document; returns the URL its iframe loads (see commands/preview.rs). */
  putPreview: (html: string) => invoke<string>("agent_preview_put", { html }),
  /** Sets the session's permission mode (confirm / auto / full / plan). */
  setPermissionMode: (sessionId: string, mode: "confirm" | "auto" | "full" | "plan") =>
    invoke<void>("agent_set_permission_mode", { sessionId, mode }),
  /** Answers a pending tool-approval request (a definition marked the tool `ask`). */
  permissionReply: (sessionId: string, requestId: string, allow: boolean, feedback?: string) =>
    invoke<void>("agent_permission_reply", { sessionId, requestId, allow, feedback }),
  /** Answers a pending ask_user_question call. */
  questionReply: (sessionId: string, requestId: string, answer: string) =>
    invoke<void>("agent_question_reply", { sessionId, requestId, answer }),
  /** Manual compaction (/compact): replaces the session history with a summary. */
  compact: (sessionId: string) => invoke<void>("agent_compact", { sessionId }),
  /** The list of skills currently available on disk (settings page and input field / completion). */
  listSkills: (mode: AgentMode, workdir?: string | null) =>
    invoke<SkillInfo[]>("agent_list_skills", { mode, workdir: workdir ?? null }),
  /** The SKILL.md body of one skill (the `/name` expansion, CC's processPromptSlashCommand). */
  readSkill: (mode: AgentMode, workdir: string | null, name: string) =>
    invoke<string>("agent_read_skill", { mode, workdir, name }),
  /** The code project's file index for the `@` completion (gitignore respected, capped at 2000). */
  listProjectFiles: (workdir: string) => invoke<string[]>("agent_list_project_files", { workdir }),
  send: (sessionId: string, text: string, images: AgentImage[] = []) =>
    invoke<void>("agent_send", { sessionId, text, images }),
  /** Stops the running turn; resolves false when the session is gone (no terminal event can arrive — the caller must clear busy itself). */
  abort: (sessionId: string) => invoke<boolean>("agent_abort", { sessionId }),
  history: (sessionId: string) => invoke<unknown>("agent_get_history", { sessionId }),
  /** Rough per-part context sizes for the composer's context card (estimated tokens; the real total comes from the usage event). */
  contextBreakdown: (sessionId: string) =>
    invoke<{ system: number; tools: number; mcpTools: number; messages: number }>(
      "agent_context_breakdown",
      { sessionId },
    ),
  /** Resolve/create the on-disk directory of one material (annotations + session records). */
  materialEnsure: (study: StudyContent) => invoke<MaterialInfo>("study_material_ensure", { study }),
  /** The sessions saved under one material (newest first). */
  sessionsList: (relDir: string) => invoke<SavedSessionMeta[]>("study_sessions_list", { relDir }),
  /** Write the model-generated title back into the metadata line of the session record's first line. */
  setSessionTitle: (relDir: string, id: string, title: string) =>
    invoke<void>("study_session_set_title", { relDir, id, title }),
  /**
   * Let the model name the session from its own first sentence (one short
   * request; it registers no session and enters no history). On failure the
   * caller keeps the locally truncated title.
   */
  generateTitle: (
    text: string,
    /** The session's model config snapshot (a restored session continues with it, and the title uses it too). */
    model?: SessionModelConfig,
  ) => invoke<string>("agent_generate_title", { text, model }),
  setCurrentNote: (path: string | null) => invoke<void>("agent_set_current_note", { path }),
  /**
   * Import the PDF into the materials directory
   * (`.bnote/materials/pdfs/<pinyin-dir>/<original-file-name>`), next to its
   * annotations/sessions; importing the same file again opens the existing
   * copy.
   */
  importPdf: (pdfPath: string, title?: string) =>
    invoke<ImportedPdf>("study_import_pdf", { pdfPath, title }),
  /**
   * The embedded web preview of the middle column (a child webview of the
   * main window, with the native view covering the placeholder element).
   * The first call creates it, later calls only update the rectangle and
   * navigate again. `annotationScript` is the in-page annotation runtime
   * (registered as an initialization script, so it is reinstalled on every
   * navigation).
   */
  showStudyPreview: (url: string, bounds: PreviewBounds, annotationScript: string) =>
    invoke<void>("show_study_preview", { url, bounds, annotationScript }),
  /** Only update the position/size of the embedded preview (window resize, dragging the splitter). */
  setStudyPreviewBounds: (bounds: PreviewBounds) =>
    invoke<void>("set_study_preview_bounds", { bounds }),
  /** The native view always covers the DOM, so it has to be hidden while an HTML overlay is open. */
  setStudyPreviewVisible: (visible: boolean) =>
    invoke<void>("set_study_preview_visible", { visible }),
  /** The web annotation tool: highlight / text note; null exits (the page switches between cursor and selection behaviour). */
  setStudyPreviewAnnotationMode: (mode: "highlight" | "note" | null) =>
    invoke<void>("set_study_preview_annotation_mode", { mode }),
  /** The master switch for select-to-translate in the web page (annotation mode wins: once annotating, the page no longer responds to translation). */
  setStudyPreviewTranslate: (enabled: boolean) =>
    invoke<void>("set_study_preview_translate", { enabled }),
  /** Push the paging step to the in-page runtime (shared by keyboard paging and the top-half fade). */
  setStudyPreviewReadStep: (step: number) => invoke<void>("set_study_preview_read_step", { step }),
  /** Push the command layer's paging bindings to the in-page runtime (so custom keybindings work while the web page has focus). */
  setStudyPreviewReadKeys: (prev: string[], next: string[]) =>
    invoke<void>("set_study_preview_read_keys", { prev, next }),
  /** Push the reading region's keybindings that "have to go back to the main window" to the in-page runtime (the keys of the native child webview do not bubble: the page matches them and reports over the title channel). */
  setStudyPreviewShortcuts: (keys: string[]) =>
    invoke<void>("set_study_preview_shortcuts", { keys }),
  /** The page zoom of the embedded web page (1 = 100%; browser-level zoom, text reflows). */
  setStudyPreviewZoom: (zoom: number) => invoke<void>("set_study_preview_zoom", { zoom }),
  /** Hand the keyboard focus to the embedded web page (used when switching to the reading region). */
  focusStudyPreview: () => invoke<void>("focus_study_preview"),
  /** Forward one page turn to the embedded web page while the focus is in the main window. */
  scrollStudyPreview: (delta: 1 | -1) => invoke<void>("scroll_study_preview", { delta }),
  /** Push the vault's anchors back into the page (the page merges them by id and does not overwrite new data). */
  mergeStudyPreviewAnnotations: (url: string, annotations: unknown[]) =>
    invoke<void>("merge_study_preview_annotations", { url, annotations }),
  /** Close the embedded preview (leaving study mode / changing the content). */
  closeStudyPreview: () => invoke<void>("close_study_preview"),
  /** Creative mode: the live preview of the middle column (the native child webview loads the snapshot written by preview_html).
   *  The first call creates it, later calls reload on a new URL and update the rectangle. */
  showCreativePreview: (url: string, bounds: PreviewBounds) =>
    invoke<void>("show_creative_preview", { url, bounds }),
  setCreativePreviewBounds: (bounds: PreviewBounds) =>
    invoke<void>("set_creative_preview_bounds", { bounds }),
  /** The native view covers the DOM: it has to be hidden while an HTML overlay (settings / publish dialog) is open. */
  setCreativePreviewVisible: (visible: boolean) =>
    invoke<void>("set_creative_preview_visible", { visible }),
  closeCreativePreview: () => invoke<void>("close_creative_preview"),
  /** Opens/reuses the standalone study-mode preview window (backend-created so
   *  that failures come back as errors instead of a swallowed `tauri://error`). */
  openStudyUrl: (url: string) => invoke<void>("open_study_url", { url }),
};

/**
 * The per-mode configuration roots (`<vault>/.bnote/agents/<mode>`) and the
 * agent home (`~/.bnote`, session records and task lists). Mode file paths are
 * reported by the backend so the UI never guesses where a file lives.
 */
/** One settings layer (the mode file and, for coding, the project's two files). */
export interface AgentSettingsPathInfo {
  path: string;
  exists: boolean;
  error: string | null;
  /** `mode` | `project` | `local` — the layer of the merge. */
  kind: string;
}

export interface AgentSkillRootInfo {
  path: string;
  source: SkillSource;
  exists: boolean;
}

/** Everything the settings page shows about where a mode's files live. */
export interface AgentModePaths {
  mode: AgentMode;
  root: string;
  defaultRoot: string;
  overridePath: string | null;
  files: AgentSettingsPathInfo[];
  instructions: string;
  instructionsExists: boolean;
  skillsDir: string;
  skillRoots: AgentSkillRootInfo[];
}

export interface AgentOutputStyle {
  id: string;
  name: string;
  description: string;
  keepCodingInstructions: boolean;
  source: "builtin" | "user" | "project";
}

/** One prompt of `~/.bnote/history.jsonl` (the ↑ recall). */
export interface AgentHistoryEntry {
  display: string;
  project: string;
  sessionId: string;
  timestamp: number;
}

export const homeApi = {
  /** Resolve (and create) the record directory of a code project. */
  workspace: (workdir: string) => invoke<{ dir: string }>("agent_home_workspace", { workdir }),
  /** The sessions saved for a code project (newest first). */
  sessionsList: (workdir: string) =>
    invoke<SavedSessionMeta[]>("agent_home_sessions_list", { workdir }),
  readFile: (path: string) => invoke<string | null>("agent_home_read_file", { path }),
  writeFile: (path: string, contents: string) =>
    invoke<void>("agent_home_write_file", { path, contents }),
  appendFile: (path: string, contents: string) =>
    invoke<void>("agent_home_append_file", { path, contents }),
  /** Write the model-generated title back into the metadata line of a coding session record. */
  setSessionTitle: (workdir: string, id: string, title: string) =>
    invoke<void>("agent_home_set_session_title", { workdir, id, title }),
  /**
   * The effective paths of one mode: root (with its override), settings files
   * and their parse state, AGENTS.md, every scanned skills root.
   */
  modePaths: (mode: AgentMode, workdir?: string | null) =>
    invoke<AgentModePaths>("agent_mode_paths", { mode, workdir: workdir ?? null }),
  /** The raw text of `<mode root>/settings.json`. */
  readModeSettings: (mode: AgentMode) => invoke<string>("agent_read_mode_settings", { mode }),
  writeModeSettings: (mode: AgentMode, contents: string) =>
    invoke<void>("agent_write_mode_settings", { mode, contents }),
  readModeInstructions: (mode: AgentMode) =>
    invoke<string | null>("agent_read_mode_instructions", { mode }),
  writeModeInstructions: (mode: AgentMode, contents: string) =>
    invoke<void>("agent_write_mode_instructions", { mode, contents }),
  /** Moves the mode root; null restores the vault default. */
  setModeRoot: (mode: AgentMode, path: string | null) =>
    invoke<void>("agent_set_mode_root", { mode, path }),
  /** The output styles available for a mode (built-ins, mode root, code project). */
  outputStyles: (mode: AgentMode, project: string | null) =>
    invoke<AgentOutputStyle[]>("agent_output_styles", { mode, project }),
  /** Recent prompts from `~/.bnote/history.jsonl`, newest first. */
  history: (project: string | null, limit = 50) =>
    invoke<AgentHistoryEntry[]>("agent_history", { project, limit }),
};

/**
 * Select-to-translate. The word/sentence split and the "an unlisted word
 * never falls back to the API" rule are decided by Rust; the front end only
 * sends the selected text and gets a discriminated union back.
 */
export const translateApi = {
  selection: (text: string) => invoke<TranslateSelection>("translate_selection", { text }),
  getConfig: () => invoke<TranslateConfig>("translate_get_config"),
  saveConfig: (config: TranslateConfig) => invoke<void>("translate_save_config", { config }),
  /** Test the connection with the current form values (nothing is written to disk). */
  test: (config: TranslateConfig) => invoke<string>("translate_test", { config }),
};

export const api = {
  setVault: (path: string) => invoke<VaultInfo>("set_vault", { path }),
  getVault: () => invoke<VaultInfo | null>("get_vault"),
  readTree: () => invoke<FileNode[]>("read_tree"),
  readDir: (relPath: string) => invoke<FileNode[]>("read_dir", { relPath }),
  listFiles: () => invoke<VaultIndex>("list_files"),

  readFile: (path: string) => invoke<string>("read_file", { path }),
  /** Binary read (base64): used by the PDF reader, because `read_file` decodes as UTF-8 and would corrupt the PDF. */
  readFileBase64: (path: string) => invoke<string>("read_file_base64", { path }),
  writeFile: (path: string, contents: string) => invoke<void>("write_file", { path, contents }),
  /** Append to a file (session records): the existing content is not cleared, and the file is created when it does not exist. */
  appendFile: (path: string, contents: string) => invoke<void>("append_file", { path, contents }),
  /** Binary write (the PNG preview exported by the canvas); the base64 payload travels as JSON, use writeFile for UTF-8 text. */
  writeFileBase64: (path: string, contentsBase64: string) =>
    invoke<void>("write_file_base64", { path, contentsBase64 }),
  createFile: (parent: string, name: string) =>
    invoke<CreatedEntry>("create_file", { parent, name }),
  createDir: (parent: string, name: string) => invoke<CreatedEntry>("create_dir", { parent, name }),
  /** mkdir -p for a vault-relative path; missing directories only, no dedup. */
  ensureDir: (relPath: string) => invoke<void>("ensure_dir", { relPath }),
  renamePath: (path: string, newName: string) => invoke<string>("rename_path", { path, newName }),
  trashPath: (path: string) => invoke<void>("trash_path", { path }),
  readVaultFile: (name: VaultConfigFile) => invoke<string | null>("read_vault_file", { name }),
  writeVaultFile: (name: VaultConfigFile, contents: string) =>
    invoke<void>("write_vault_file", { name, contents }),

  loadAppConfig: () => invoke<unknown>("load_app_config"),
  saveAppConfig: (config: unknown) => invoke<void>("save_app_config", { config }),
  loadKeybindings: () => invoke<unknown>("load_keybindings"),
  saveKeybindings: (keybindings: unknown) => invoke<void>("save_keybindings", { keybindings }),
  readVimrc: () => invoke<string | null>("read_vimrc"),
  saveVimrc: (contents: string) => invoke<void>("save_vimrc", { contents }),

  listInputSources: () => invoke<InputSourceInfo[]>("list_input_sources"),
  getCurrentInputSource: () => invoke<string>("get_current_input_source"),
  setInputSource: (id: string) => invoke<SetImeOutcome>("set_input_source", { id }),

  // ---- python ----
  /** Run the virtual python text of a note (the line alignment and the main guard are synthesized by the front end). */
  pythonRun: (mdPath: string, code: string) =>
    invoke<PythonRunStarted>("python_run", { mdPath, code }),
  pythonRunCancel: (mdPath: string) => invoke<boolean>("python_run_cancel", { mdPath }),
  pythonGetInfo: (mdPath: string) => invoke<PythonInfo>("python_get_info", { mdPath }),
  /** Merge one project config; a field passed as null stays untouched, an empty string clears it. */
  pythonSetProjectConfig: (mdPath: string, patch: PythonProjectConfig) =>
    invoke<PythonProjectConfig>("python_set_project_config", {
      mdPath,
      lsp: patch.lsp ?? null,
      python: patch.python ?? null,
      tyPath: patch.tyPath ?? null,
    }),
  pythonLspSync: (mdPath: string, text: string) =>
    invoke<PythonLspSyncResult>("python_lsp_sync", { mdPath, text }),
  /** Forward read-only interaction requests such as completion/hover; the uri is injected by the backend. When the project LSP is off or not running, null comes back. */
  pythonLspRequest: (mdPath: string, method: string, params: unknown) =>
    invoke<unknown>("python_lsp_request", { mdPath, method, params }),
  pythonLspClose: (mdPath: string) => invoke<void>("python_lsp_close", { mdPath }),
  pythonLspStopAll: () => invoke<void>("python_lsp_stop_all"),
  pythonUvCreate: (mdPath: string) => invoke<PythonUvOutcome>("python_uv_create", { mdPath }),
};

/** The native state of focus mode (fake full-screen lock + hard lock). The field names match the Rust side. */
export interface FocusStatus {
  /** Whether the fake full-screen lock is on. */
  locked: boolean;
  /** Whether the hard lock is armed (the user turned the switch on, meaning "swallow system-level shortcuts during focus"). */
  hard_lock: boolean;
  /** Whether the hard lock is currently intercepting: only true while a pomodoro is running. */
  hard_active: boolean;
  /** Whether the accessibility permission has been granted — the prerequisite of the hard lock. */
  trusted: boolean;
  /** The number of key events the hard lock's tap has seen (proof that the tap is alive). */
  seen: number;
  /** The number of key events swallowed by the hard lock. */
  swallowed: number;
}

export const focusApi = {
  status: () => invoke<FocusStatus>("focus_status"),
  /** Enter the lock: fake full-screen + exclusive window level + focus taken back. */
  lock: () => invoke<FocusStatus>("focus_lock"),
  /** Leave the lock: put the window's level / decorations / geometry back exactly as they were. */
  unlock: () => invoke<FocusStatus>("focus_unlock"),
  /** Arm/disarm the hard lock. It is only an intention: the real interception happens while the pomodoro runs. */
  setHardLock: (enabled: boolean) => invoke<FocusStatus>("focus_set_hard_lock", { enabled }),
  /** Start/stop the real interception (on when the pomodoro starts, off when it stops). */
  setHardLockActive: (active: boolean) =>
    invoke<FocusStatus>("focus_set_hard_lock_active", { active }),
};
