import { invoke } from "@tauri-apps/api/core";

export interface VaultInfo {
  path: string;
  name: string;
}

export interface FileNode {
  name: string;
  relPath: string;
  kind: "file" | "dir";
  /** null = 目录子层尚未加载（懒加载），调用 readDir 获取 */
  children: FileNode[] | null;
}

export interface CreatedEntry {
  path: string;
  relPath: string;
}

export interface VaultIndex {
  files: string[];
  dirs: string[];
  /** 图片/PDF 等媒体文件(vault 相对路径),供 `![[x.png]]` 这类按文件名引用解析。 */
  assets: string[];
}

/** Whitelisted per-vault config files inside `<vault>/.bnote/`. */
export type VaultConfigFile = "vimrc" | "snippets.js" | "keybindings.json";

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

export type StudyContent =
  | { kind: "markdown"; path: string; title: string }
  | { kind: "url"; url: string; title: string };

export interface AgentConfig {
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
  max_tokens: number;
  mcp_servers: Record<string, unknown>;
  skill_dirs: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface SessionInfo {
  sessionId: string;
  skills: SkillInfo[];
  mcpTools: string[];
  mcpErrors: string[];
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; output: string }
  | { type: "turn_end"; reason: string }
  | { type: "error"; message: string };

export interface ConvertResult {
  mdPath: string;
  /** 原文在 vault 里的副本(`<vault>/pdfs/<stem>.pdf`)。 */
  pdfPath: string;
  title: string;
  pages: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Python:markdown 内嵌代码块运行 / ty LSP / uv 环境
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

/** 后端推流事件(python-run-output)。 */
export interface PythonRunOutputEvent {
  runId: number;
  mdPath: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** 后端收尾事件(python-run-exit)。 */
export interface PythonRunExitEvent {
  runId: number;
  mdPath: string;
  exitCode: number | null;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
}

/** ty 转发的原始 LSP 诊断(python-lsp-diagnostics),行列是 UTF-16 单位。 */
export interface PythonLspDiagnosticEvent {
  mdPath: string;
  diagnostics: unknown[];
}

/** 中栏内嵌网页预览的占位矩形(逻辑像素,相对窗口内容区左上角)。 */
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const agentApi = {
  getConfig: () => invoke<AgentConfig>("agent_get_config"),
  saveConfig: (config: AgentConfig) => invoke<void>("agent_save_config", { config }),
  startSession: (study: StudyContent | null) =>
    invoke<SessionInfo>("agent_start_session", { study }),
  send: (sessionId: string, text: string) =>
    invoke<void>("agent_send", { sessionId, text }),
  abort: (sessionId: string) => invoke<void>("agent_abort", { sessionId }),
  history: (sessionId: string) => invoke<unknown>("agent_get_history", { sessionId }),
  setCurrentNote: (path: string | null) =>
    invoke<void>("agent_set_current_note", { path }),
  convertPdf: (pdfPath: string, folderRel: string) =>
    invoke<ConvertResult>("convert_pdf_to_markdown", { pdfPath, folderRel }),
  /**
   * 中栏内嵌网页预览(主窗口的子 webview,原生视图盖在占位元素上)。
   * 首次调用创建、之后调用只更新矩形并重新导航。
   */
  showStudyPreview: (url: string, bounds: PreviewBounds) =>
    invoke<void>("show_study_preview", { url, bounds }),
  /** 只更新内嵌预览的位置/尺寸(窗口缩放、拖动分隔线时)。 */
  setStudyPreviewBounds: (bounds: PreviewBounds) =>
    invoke<void>("set_study_preview_bounds", { bounds }),
  /** 原生视图永远盖在 DOM 之上,HTML 浮层打开时要把它藏起来。 */
  setStudyPreviewVisible: (visible: boolean) =>
    invoke<void>("set_study_preview_visible", { visible }),
  /** 关掉内嵌预览(离开学习模式 / 换内容)。 */
  closeStudyPreview: () => invoke<void>("close_study_preview"),
  /** Opens/reuses the standalone study-mode preview window (backend-created so
   *  that failures come back as errors instead of a swallowed `tauri://error`). */
  openStudyUrl: (url: string) => invoke<void>("open_study_url", { url }),
};

export const api = {
  setVault: (path: string) => invoke<VaultInfo>("set_vault", { path }),
  getVault: () => invoke<VaultInfo | null>("get_vault"),
  readTree: () => invoke<FileNode[]>("read_tree"),
  readDir: (relPath: string) => invoke<FileNode[]>("read_dir", { relPath }),
  listFiles: () => invoke<VaultIndex>("list_files"),

  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, contents: string) =>
    invoke<void>("write_file", { path, contents }),
  /** 二进制写盘(画布导出的 PNG 预览);base64 编码走 JSON,UTF-8 文本请用 writeFile。 */
  writeFileBase64: (path: string, contentsBase64: string) =>
    invoke<void>("write_file_base64", { path, contentsBase64 }),
  createFile: (parent: string, name: string) =>
    invoke<CreatedEntry>("create_file", { parent, name }),
  createDir: (parent: string, name: string) =>
    invoke<CreatedEntry>("create_dir", { parent, name }),
  /** mkdir -p for a vault-relative path; missing directories only, no dedup. */
  ensureDir: (relPath: string) => invoke<void>("ensure_dir", { relPath }),
  renamePath: (path: string, newName: string) =>
    invoke<string>("rename_path", { path, newName }),
  trashPath: (path: string) => invoke<void>("trash_path", { path }),
  readVaultFile: (name: VaultConfigFile) =>
    invoke<string | null>("read_vault_file", { name }),
  writeVaultFile: (name: VaultConfigFile, contents: string) =>
    invoke<void>("write_vault_file", { name, contents }),

  loadAppConfig: () => invoke<unknown>("load_app_config"),
  saveAppConfig: (config: unknown) => invoke<void>("save_app_config", { config }),
  loadKeybindings: () => invoke<unknown>("load_keybindings"),
  saveKeybindings: (keybindings: unknown) =>
    invoke<void>("save_keybindings", { keybindings }),
  readVimrc: () => invoke<string | null>("read_vimrc"),
  saveVimrc: (contents: string) => invoke<void>("save_vimrc", { contents }),

  listInputSources: () => invoke<InputSourceInfo[]>("list_input_sources"),
  getCurrentInputSource: () => invoke<string>("get_current_input_source"),
  setInputSource: (id: string) => invoke<SetImeOutcome>("set_input_source", { id }),

  // ---- python ----
  /** 运行一篇笔记的虚拟 python 文本(行对齐 + main 守卫由前端合成)。 */
  pythonRun: (mdPath: string, code: string) =>
    invoke<PythonRunStarted>("python_run", { mdPath, code }),
  pythonRunCancel: (mdPath: string) => invoke<boolean>("python_run_cancel", { mdPath }),
  pythonGetInfo: (mdPath: string) => invoke<PythonInfo>("python_get_info", { mdPath }),
  /** 合并单项目配置;传 null 的字段不动,空串清除。 */
  pythonSetProjectConfig: (mdPath: string, patch: PythonProjectConfig) =>
    invoke<PythonProjectConfig>("python_set_project_config", {
      mdPath,
      lsp: patch.lsp ?? null,
      python: patch.python ?? null,
      tyPath: patch.tyPath ?? null,
    }),
  pythonLspSync: (mdPath: string, text: string) =>
    invoke<PythonLspSyncResult>("python_lsp_sync", { mdPath, text }),
  pythonLspClose: (mdPath: string) => invoke<void>("python_lsp_close", { mdPath }),
  pythonLspStopAll: () => invoke<void>("python_lsp_stop_all"),
  pythonUvCreate: (mdPath: string) => invoke<PythonUvOutcome>("python_uv_create", { mdPath }),
};
