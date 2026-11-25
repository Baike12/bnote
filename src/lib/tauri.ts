import { invoke } from "@tauri-apps/api/core";
import type { AgentImage } from "@/study/agentImages";
import type {
  InvestBacktestRun,
  InvestBar,
  InvestDocInfo,
  InvestEvent,
  InvestFinancial,
  InvestForecast,
  InvestFundFlowDay,
  InvestGraphView,
  InvestIngestRunResult,
  InvestInstrument,
  InvestPeriod,
  InvestQuoteSummary,
  InvestScope,
  InvestSearchHit,
  InvestSector,
  InvestSkillBundle,
  InvestSnapshot,
} from "@/invest/types";

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
  /** Whether the system source moved. false when it was already active, or
   *  when the context missed and the select was deferred to the next
   *  context-ready update (the menu bar stays on the previous source). */
  switched: boolean;
  /** The TIS call itself, in ms — it runs inside the helper process, so this
   *  number names the input method's activation, not a UI freeze. 0 when the
   *  select was deferred. */
  tisMs: number;
  /** Whether the app's own input context accepted the source before the system
   *  menu bar changed. `null` means no input context existed yet; `false`
   *  means the transition failed. In both cases the system source stays
   *  unchanged and the native coordinator keeps the intent pending until
   *  AppKit exposes the next usable context. */
  contextApplied: boolean | null;
  /** Main-thread cost of the context hand-off, in ms. The normal path is one
   *  property transition; a destructive rebuild is a rare recovery path. */
  contextMs: number;
  /** The source the app's input context reported afterwards; `null` when no
   *  input context existed. Diagnostic only. */
  contextSource: string | null;
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

/** The agent shapes; the id is also the mode folder name. */
export type AgentMode = "coding" | "creative" | "study" | "invest";

/** One thinking level: its id and the RFC 7396 patch it merges into the request body. */
export interface ThinkingLevel {
  id: string;
  /** An object; a `null` value deletes that field from the request. */
  patch: Record<string, unknown>;
}

/** One model of a provider (see `src-tauri/src/agent/models.rs`). */
export interface ModelEntry {
  /** The wire model id and the key a selection refers to. */
  id: string;
  name: string;
  context_window: number;
  max_tokens: number;
  /** Accepts images (the picker shows a 「视觉」 tag). */
  vision: boolean;
  /** Ordered lowest → highest. */
  thinking: ThinkingLevel[];
  default_thinking: string;
}

export interface ProviderEntry {
  id: string;
  name: string;
  /** "anthropic" | "openai" */
  protocol: string;
  base_url: string;
  api_key: string;
  models: ModelEntry[];
}

/** What a session (or a subagent) runs on: ids, resolved against the catalog. */
export interface ModelSelection {
  provider_id: string;
  model_id: string;
  thinking: string;
}

/** The subagent model choices: a global default plus one per agent definition (absent = inherit the parent session). */
export interface SubagentModels {
  default: ModelSelection | null;
  by_definition: Record<string, ModelSelection>;
}

export interface AgentConfig {
  /** The provider → model → thinking level catalog (the source of truth). */
  providers: ProviderEntry[];
  /** The model a new session picks. */
  default_selection: ModelSelection | null;
  /** Which models subagents run on. */
  subagent_models: SubagentModels;
  /** How many subagents may run at once (1–10). Calls beyond it queue and start as slots free. */
  subagent_concurrency: number;
  /** Legacy single-model fields; mirror of the default selection (older builds read them). */
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
  /**
   * Debug switch: record every model request and response of a conversation
   * into `<vault>/.bnote/logs/requests/<session>.jsonl` (full prompt, tools,
   * raw SSE, assembled turn). Shared by the three modes.
   */
  log_requests: boolean;
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
  /** The catalog selection the session runs on (what a restore resolves again). */
  selection?: ModelSelection;
  /** The agent definition the session runs with (id/name shown in the panel). */
  definition?: { id: string; name: string; description: string; tools: string[] };
  /**
   * The todo list this session resumed from disk (a restored session shows its
   * plan at once; a fresh one gets an empty array).
   */
  todos?: AgentTodoItem[];
}

/** The session-level model config snapshot (written into the first line of the session record; a restored session continues with it). */
export interface SessionModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  contextWindow: number;
  /** The thinking level the session ran on (a level id of its model). */
  thinking?: string;
  /** The catalog entry the session was resolved from (absent on records written before the catalog). */
  providerId?: string;
  modelId?: string;
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
  /** A subagent started (its deltas then arrive under that agent's own session id). `label` is the user-visible name; `agentId` is routing only and must never be rendered. */
  | {
      type: "subagent_start";
      agentId: string;
      /** The `Agent` tool call that launched it: the card is drawn at that call. */
      toolUseId: string;
      label: string;
      /** The definition id (general-purpose / explore / fork …). */
      kind: string;
      model: string;
      background: boolean;
    }
  /** A subagent finished (or failed): its final report, wall-clock duration and total tokens. */
  | {
      type: "subagent_end";
      agentId: string;
      ok: boolean;
      /** The user stopped this agent (ok is false then; the row says 已停止). */
      stopped: boolean;
      report: string;
      durationMs: number;
      tokens: number;
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
  | { type: "error"; message: string; items: number }
  /** A turn is starting (the send won the busy CAS); clears the previous error. */
  | { type: "turn_start"; items: number }
  /** A user message entered the session; the sending view ignores its own echo by `clientId`. */
  | { type: "user_message"; text: string; clientId: string }
  /** The other view answered a permission card: retract it. */
  | { type: "permission_resolved"; id: string; allow: boolean }
  /** The other view answered a question: retract it. */
  | { type: "question_resolved"; id: string }
  /** The phone took the session over; the desktop must stop writing its transcript. */
  | { type: "origin_changed"; origin: "local" | "remote" };

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
  /** `"remote"` when the backend recorded the session for a phone. */
  origin?: "local" | "remote";
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
    /** Restore/fork: the source session's model snapshot (a record from before the catalog has only this). */
    model?: SessionModelConfig,
    /** Restore/fork: the catalog selection of the source session; a fresh session passes the default of the settings. */
    selection?: ModelSelection | null,
    /** "creative" = creative mode (with tools/skill/MCP); "coding" = the code-project agent; omitted = study mode, plain question answering only. */
    mode?: AgentMode,
    /** Coding sessions: the project root (relative tool paths and bash anchor there). */
    workdir?: string,
    /** Restore: the transcript record id, so the persisted task list continues. */
    taskListId?: string,
    /** Invest sessions: the scope the session is bound to (stock:600519 / sector:801010). */
    investScope?: string,
  ) =>
    invoke<SessionInfo>("agent_start_session", {
      study,
      fork,
      history,
      model,
      selection: selection ?? null,
      mode,
      workdir,
      taskListId,
      investScope: investScope ?? null,
    }),
  /**
   * Switches the model / thinking level of an open session; the next round uses
   * it (a request already streaming finishes on the provider it started with).
   */
  setSessionModel: (sessionId: string, selection: ModelSelection) =>
    invoke<{ model: SessionModelConfig; selection: ModelSelection }>("agent_set_session_model", {
      sessionId,
      selection,
    }),
  /** The subagent definitions the settings page configures a model for. */
  listSubagents: () =>
    invoke<{ id: string; name: string; description: string }[]>("agent_list_subagents"),
  /** The thinking levels a new model of this protocol/gateway starts with. */
  defaultLevels: (protocol: string, model: string, baseUrl: string, maxTokens: number) =>
    invoke<ThinkingLevel[]>("agent_default_levels", { protocol, model, baseUrl, maxTokens }),
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
  /**
   * The settings page's MCP list: every configured server with its scope and a
   * live check result. The check really connects and lists tools, then closes.
   */
  mcpStatus: (mode: AgentMode, workdir?: string | null) =>
    invoke<McpStatusReport>("agent_mcp_status", { mode, workdir: workdir ?? null }),
  /** Approves one project-scope server's current definition (the vault records its digest). */
  trustMcpServer: (mode: AgentMode, workdir: string, name: string) =>
    invoke<void>("agent_trust_mcp_server", { mode, workdir, name }),
  send: (sessionId: string, text: string, images: AgentImage[] = []) =>
    invoke<void>("agent_send", { sessionId, text, images }),
  /**
   * Edit the last user message and resend it: a running turn is stopped first,
   * then that prompt and everything it produced leave the session history, and
   * the new text opens the next turn. Resolves with the number of history
   * entries kept — the new prompt is the entry right after them.
   */
  editUserMessage: (sessionId: string, text: string, images: AgentImage[] = []) =>
    invoke<{ keptItems: number }>("agent_edit_user_message", { sessionId, text, images }),
  /** Stops the running turn; resolves false when the session is gone (no terminal event can arrive — the caller must clear busy itself). */
  abort: (sessionId: string) => invoke<boolean>("agent_abort", { sessionId }),
  /** Stops one subagent of a session (its own abort token; the parent turn keeps running). */
  stopSubagent: (sessionId: string, agentId: string) =>
    invoke<boolean>("agent_stop_subagent", { sessionId, agentId }),
  history: (sessionId: string) => invoke<unknown>("agent_get_history", { sessionId }),
  /** Rough per-part context sizes for the composer's context card (estimated tokens; the real total comes from the usage event). */
  contextBreakdown: (sessionId: string) =>
    invoke<{ system: number; tools: number; mcpTools: number; messages: number }>(
      "agent_context_breakdown",
      { sessionId },
    ),
  /** Resolve/create the on-disk directory of one material (annotations + session records). */
  materialEnsure: (study: StudyContent) => invoke<MaterialInfo>("study_material_ensure", { study }),
  /**
   * Delete one material: its directory (annotations + session records) goes to
   * the trash and the material identity is forgotten, so opening the same page
   * again starts in a fresh directory. False when the vault never recorded it.
   */
  materialDelete: (study: StudyContent) => invoke<boolean>("study_material_delete", { study }),
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
    /** The catalog selection of the session (a current record carries it). */
    selection?: ModelSelection | null,
    /** The conversation the title belongs to: its request record joins this request. */
    sessionId?: string | null,
  ) =>
    invoke<string>("agent_generate_title", {
      text,
      model,
      selection: selection ?? null,
      sessionId: sessionId ?? null,
    }),
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
 * agent home (`<vault>/.bnote`, session records and task lists). Mode file paths are
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

/** Where an MCP server is defined: the vault's user file or the code project's files. */
export type McpScope = "user" | "project" | "local";

/** One row of the settings page's MCP list: a live-check snapshot. */
export interface McpServerStatus {
  name: string;
  scope: McpScope;
  /** The settings file the winning definition came from. */
  source: string;
  transport: "stdio" | "http";
  /** The command line or URL (never env values or headers). */
  target: string;
  enabled: boolean;
  /**
   * Whether a session may start it: a project-scope server starts only after
   * its exact definition was approved (`agent_trust_mcp_server`); the user
   * scope always does.
   */
  trusted: boolean;
  /**
   * `connected` / `error` from the check, `disabled` from the toggle,
   * `untrusted` for a project server nobody approved, `unused` when the mode
   * has no MCP tool. `unknown` is the frontend's pre-check row.
   */
  state: "connected" | "error" | "disabled" | "untrusted" | "unused" | "unknown";
  tools: number;
  error: string | null;
}

export interface McpStatusReport {
  mode: AgentMode;
  project: string | null;
  /** Whether the mode's tool set registers `mcp` at all. */
  mcpEnabled: boolean;
  servers: McpServerStatus[];
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

/** One prompt of `.bnote/history.jsonl` in the agent home (the ↑ recall). */
export interface AgentHistoryEntry {
  display: string;
  project: string;
  sessionId: string;
  timestamp: number;
}

/** One paired phone (the Mac's device list). */
export interface RemoteDevice {
  deviceId: string;
  name: string;
  staticPublic: string;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
  revokedAt: number | null;
}

export interface RemoteStatus {
  enabled: boolean;
  status: "disabled" | "connecting" | "online" | "offline";
  lastError: string | null;
  relayUrl: string;
  room: string;
  deviceId: string;
  devices: RemoteDevice[];
  allowedProjects: string[];
  pairingExpiresAt: number | null;
}

export interface RemoteAuditEntry {
  at: number;
  deviceId: string;
  kind: "send" | "permission" | "abort" | "rollback" | "pair" | "revoke" | "system";
  summary: string;
}

export interface LiveSession {
  liveId: string;
  transcriptId: string;
  projectId: string | null;
  running: boolean;
  origin: "local" | "remote";
}

/** Remote access settings, pairing and the device list. */
export const remoteApi = {
  status: () => invoke<RemoteStatus>("remote_status"),
  setEnabled: (enabled: boolean, relayUrl?: string) =>
    invoke<RemoteStatus>("remote_set_enabled", { enabled, relayUrl: relayUrl ?? null }),
  pairingBegin: () =>
    invoke<{ payload: string; expiresAt: number; room: string }>("remote_pairing_begin"),
  pairingCancel: () => invoke<void>("remote_pairing_cancel"),
  pairApprove: (deviceId: string, allow: boolean) =>
    invoke<void>("remote_pair_approve", { deviceId, allow }),
  devices: () => invoke<{ devices: RemoteDevice[] }>("remote_devices"),
  revokeDevice: (deviceId: string) => invoke<void>("remote_revoke_device", { deviceId }),
  auditTail: (limit?: number) =>
    invoke<{ entries: RemoteAuditEntry[]; nextCursor: string | null }>("remote_audit_tail", {
      limit: limit ?? null,
    }),
  setAllowedProjects: (projects: string[]) =>
    invoke<{ allowedProjects: string[] }>("remote_set_allowed_projects", { projects }),
  todoConfig: (deviceId: string, server: string, key: string) =>
    invoke<void>("remote_todo_config", { deviceId, server, key }),
  liveSessions: () => invoke<{ sessions: LiveSession[] }>("agent_live_sessions"),
  attachSession: (transcriptId: string) =>
    invoke<{
      live: boolean;
      liveId?: string;
      transcriptId?: string;
      title?: string;
      running?: boolean;
      origin?: "local" | "remote";
      history?: AgentChatItem[];
      eventSeq?: number;
    }>("agent_attach_session", { transcriptId }),
};

export const homeApi = {
  /** Resolve (and create) the record directory of a code project. */
  workspace: (workdir: string) => invoke<{ dir: string }>("agent_home_workspace", { workdir }),
  /** The sessions saved for a code project (newest first). */
  sessionsList: (workdir: string) =>
    invoke<SavedSessionMeta[]>("agent_home_sessions_list", { workdir }),
  /** The sessions archived out of a project's main list. */
  sessionsArchived: (workdir: string) =>
    invoke<SavedSessionMeta[]>("agent_home_sessions_archived", { workdir }),
  /** Hide a session from the project list; the transcript is kept. */
  archiveSession: (workdir: string, id: string) =>
    invoke<void>("agent_home_session_archive", { workdir, id }),
  /** Restore an archived session to the project list. */
  unarchiveSession: (workdir: string, id: string) =>
    invoke<void>("agent_home_session_unarchive", { workdir, id }),
  /** Permanently delete an archived session (transcript and its runtime dir). */
  deleteSession: (workdir: string, id: string) =>
    invoke<void>("agent_home_session_delete", { workdir, id }),
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
  /** The raw text of one MCP scope's settings file (`user`, `project`, `local`). */
  readSettingsScope: (mode: AgentMode, workdir: string | null, scope: McpScope) =>
    invoke<string>("agent_read_settings_scope", { mode, workdir, scope }),
  /** Writes one MCP scope's settings file (validated as a JSON object). */
  writeSettingsScope: (
    mode: AgentMode,
    workdir: string | null,
    scope: McpScope,
    contents: string,
  ) => invoke<void>("agent_write_settings_scope", { mode, workdir, scope, contents }),
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
  /** Recent prompts from `.bnote/history.jsonl`, newest first. */
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

/** One day document handed to the sync server (plaintext here; Rust encrypts). */
export interface SyncDayPush {
  date: string;
  content: string;
  /** Server revision the content was built on; the server answers 409 when stale. */
  baseRev: number;
  /** Force overwrites the server copy (the explicit local→remote alignment). */
  force: boolean;
  /** This device's sync id; the server stamps it onto the broadcast event. */
  deviceId?: string;
}

export interface SyncPushResult {
  date: string;
  ok: boolean;
  rev: number | null;
  /** Set on a 409: the server's current revision and decrypted content. */
  conflictRev: number | null;
  conflictContent: string | null;
  error: string | null;
}

export interface SyncPulledDay {
  date: string;
  rev: number;
  updatedBy: string;
  updatedAt: number;
  content: string;
}

export interface SyncStatusInfo {
  connected: boolean;
  server: string | null;
  lastSeq: number | null;
}

/**
 * The b-todo sync client. The connection itself (SSE) and the crypto live in
 * Rust (`daily_sync/`); these wrappers only carry settings values and
 * plaintext day documents, mirroring the bblog credential-as-argument style.
 */
export const syncApi = {
  /** Tests the (possibly unsaved) form values; returns a human message. */
  test: (server: string, key: string) => invoke<string>("sync_test", { server, key }),
  /** Starts the SSE session; returns false when it was already up. */
  connect: (server: string, key: string, deviceId: string) =>
    invoke<boolean>("sync_connect", { server, key, deviceId }),
  disconnect: () => invoke<void>("sync_disconnect"),
  status: () => invoke<SyncStatusInfo>("sync_status"),
  pushDays: (server: string, key: string, days: SyncDayPush[]) =>
    invoke<SyncPushResult[]>("sync_push_days", { server, key, days }),
  /** `dates: null` pulls every stored day (list endpoint + one GET each). */
  pullDays: (server: string, key: string, dates: string[] | null) =>
    invoke<SyncPulledDay[]>("sync_pull_days", { server, key, dates }),
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

// ---------------------------------------------------------------------------
// Invest mode (the local A-share workspace)
// ---------------------------------------------------------------------------

export interface InvestImportInput extends Record<string, unknown> {
  market?: string;
  instruments?: InvestInstrument[];
  sectors?: InvestSector[];
  bars?: InvestBar[];
  code?: string;
  /** "sector" routes the bars to the sector-index table (B11). */
  barKind?: "stock" | "sector";
  financials?: InvestFinancial[];
  fundFlow?: InvestFundFlowDay[];
  snapshot?: InvestSnapshot;
}

export const investApi = {
  listInstruments: (query?: string, watchOnly?: boolean, limit?: number) =>
    invoke<InvestInstrument[]>("invest_list_instruments", {
      query: query ?? null,
      watchOnly: watchOnly ?? null,
      limit: limit ?? null,
    }),
  setWatch: (market: string, code: string, watch: boolean) =>
    invoke<boolean>("invest_set_watch", { market, code, watch }),
  klineQuery: (
    market: string,
    code: string,
    opts?: { from?: string; to?: string; limit?: number; period?: InvestPeriod },
  ) =>
    invoke<InvestBar[]>("invest_kline_query", {
      market,
      code,
      from: opts?.from ?? null,
      to: opts?.to ?? null,
      limit: opts?.limit ?? null,
      period: opts?.period ?? null,
    }),
  klineImport: (market: string, code: string, bars: InvestBar[]) =>
    invoke<number>("invest_kline_import", { market, code, bars }),
  snapshot: (market: string, code: string) =>
    invoke<InvestSnapshot | null>("invest_snapshot", { market, code }),
  snapshotRefresh: (market: string, code: string) =>
    invoke<InvestSnapshot | null>("invest_snapshot_refresh", { market, code }),
  fundFlow: (market: string, code: string, limit?: number) =>
    invoke<InvestFundFlowDay[]>("invest_fund_flow", { market, code, limit: limit ?? null }),
  financials: (market: string, code: string, limit?: number) =>
    invoke<InvestFinancial[]>("invest_financials", { market, code, limit: limit ?? null }),
  importData: (input: InvestImportInput) =>
    invoke<Record<string, number>>("invest_import_data", input),
  listSectors: () => invoke<InvestSector[]>("invest_list_sectors"),
  quoteOverview: (market?: string) =>
    invoke<InvestQuoteSummary[]>("invest_quote_overview", { market: market ?? null }),
  sectorBars: (
    code: string,
    opts?: { from?: string; to?: string; limit?: number; period?: InvestPeriod },
  ) =>
    invoke<InvestBar[]>("invest_sector_bars", {
      code,
      from: opts?.from ?? null,
      to: opts?.to ?? null,
      limit: opts?.limit ?? null,
      period: opts?.period ?? null,
    }),
  sectorMembers: (code: string) => invoke<InvestInstrument[]>("invest_sector_members", { code }),
  ensureScopeDocs: (scope: InvestScope, title: string) =>
    invoke<InvestDocInfo[]>("invest_ensure_scope_docs", { scope, title }),
  listDocs: (scope: InvestScope) => invoke<InvestDocInfo[]>("invest_list_docs", { scope }),
  readDoc: (relPath: string) => invoke<string>("invest_read_doc", { relPath }),
  writeDoc: (relPath: string, content: string, scope: InvestScope, kind?: string) =>
    invoke<void>("invest_write_doc", { relPath, content, scope, kind: kind ?? null }),
  searchKnowledge: (query: string, limit?: number) =>
    invoke<InvestSearchHit[]>("invest_search_knowledge", { query, limit: limit ?? null }),
  graphView: (name: string, kind: string) =>
    invoke<InvestGraphView | null>("invest_graph_view", { name, kind }),
  events: (scope: InvestScope, limit?: number) =>
    invoke<InvestEvent[]>("invest_events", { scope, limit: limit ?? null }),
  eventAdd: (input: {
    scope: InvestScope;
    date: string;
    kind: string;
    title: string;
    body?: string;
    sentiment?: string;
  }) => invoke<boolean>("invest_event_add", input),
  recentEvents: (limit?: number) =>
    invoke<InvestEvent[]>("invest_recent_events", { limit: limit ?? null }),
  ingestRun: () => invoke<InvestIngestRunResult>("invest_ingest_run"),
  readSources: () => invoke<string>("invest_read_sources"),
  saveSources: (yaml: string) => invoke<void>("invest_save_sources", { yaml }),
  /** H7: the pluggable quote-source spec (`quotes.yaml`); validated on save. */
  readQuotes: () => invoke<string>("invest_read_quotes"),
  saveQuotes: (yaml: string) => invoke<void>("invest_save_quotes", { yaml }),
  readSkill: (scope: InvestScope) => invoke<InvestSkillBundle>("invest_read_skill", { scope }),
  writeSkill: (scope: InvestScope, skill: string, memory: string, snapshot: boolean) =>
    invoke<number>("invest_write_skill", { scope, skill, memory, snapshot }),
  skillLearnedEdit: (scope: InvestScope, anchor: string, content: string, replace: boolean) =>
    invoke<void>("invest_skill_learned_edit", { scope, anchor, content, replace }),
  forecastReplay: (
    scope: InvestScope,
    market: string,
    code: string,
    /** Omitted → the backend anchors to the last settleable point in the data. */
    asOf?: string,
    horizon?: number,
  ) =>
    invoke<InvestForecast>("invest_forecast_replay", {
      scope,
      market,
      code,
      asOf: asOf ?? null,
      horizon: horizon ?? null,
    }),
  forecastSettle: (scope: InvestScope, market: string, code: string, horizon?: number) =>
    invoke<number>("invest_forecast_settle", { scope, market, code, horizon: horizon ?? null }),
  forecasts: (scope: InvestScope, limit?: number) =>
    invoke<InvestForecast[]>("invest_forecasts", { scope, limit: limit ?? null }),
  forecastAccuracy: (scope: InvestScope) =>
    invoke<[number, number, number] | null>("invest_forecast_accuracy", { scope }),
  backtestRun: (
    scope: InvestScope,
    market: string,
    code: string,
    strategy: "ma_cross" | "skill_signal",
    opts?: { fast?: number; slow?: number; start?: string; end?: string; initialCash?: number },
  ) =>
    invoke<InvestBacktestRun>("invest_backtest_run", {
      scope,
      market,
      code,
      strategy,
      fast: opts?.fast ?? null,
      slow: opts?.slow ?? null,
      start: opts?.start ?? null,
      end: opts?.end ?? null,
      initialCash: opts?.initialCash ?? null,
    }),
  backtestList: (scope: InvestScope, limit?: number) =>
    invoke<InvestBacktestRun[]>("invest_backtest_list", { scope, limit: limit ?? null }),
  backtestDelete: (id: number) => invoke<boolean>("invest_backtest_delete", { id }),
};
