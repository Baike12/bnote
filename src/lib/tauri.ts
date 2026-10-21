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

/**
 * Middle-column content. PDFs are displayed as PDFs (the reader renders them
 * with pdf.js) — no markdown conversion happens anywhere in this flow.
 */
export type StudyContent =
  | { kind: "pdf"; path: string; title: string }
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

/** 收进 vault 的 PDF(`<vault>/pdfs/<stem>.pdf`)。 */
export interface ImportedPdf {
  pdfPath: string;
  /** vault 相对路径(历史记录展示/跨仓迁移用)。 */
  relPath: string;
  title: string;
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
  /** 把 PDF 收进 vault(`<vault>/<folderRel>/<stem>.pdf`),同名不同文件自动加序号。 */
  importPdf: (pdfPath: string, folderRel: string) =>
    invoke<ImportedPdf>("import_pdf", { pdfPath, folderRel }),
  /**
   * 中栏内嵌网页预览(主窗口的子 webview,原生视图盖在占位元素上)。
   * 首次调用创建、之后调用只更新矩形并重新导航。`annotationScript` 是页面
   * 内的批注运行时(注册成初始化脚本,每次导航都会重新安装)。
   */
  showStudyPreview: (url: string, bounds: PreviewBounds, annotationScript: string) =>
    invoke<void>("show_study_preview", { url, bounds, annotationScript }),
  /** 只更新内嵌预览的位置/尺寸(窗口缩放、拖动分隔线时)。 */
  setStudyPreviewBounds: (bounds: PreviewBounds) =>
    invoke<void>("set_study_preview_bounds", { bounds }),
  /** 原生视图永远盖在 DOM 之上,HTML 浮层打开时要把它藏起来。 */
  setStudyPreviewVisible: (visible: boolean) =>
    invoke<void>("set_study_preview_visible", { visible }),
  /** 网页批注模式开关(页面内选中文字 → 亮黄色高亮)。 */
  setStudyPreviewAnnotationMode: (enabled: boolean) =>
    invoke<void>("set_study_preview_annotation_mode", { enabled }),
  /** 把翻页步长推给页内运行时(键盘翻页与上半屏渐变共用)。 */
  setStudyPreviewReadStep: (step: number) =>
    invoke<void>("set_study_preview_read_step", { step }),
  /** 把命令层的翻页绑定推给页内运行时(网页获得焦点时也能用自定义快捷键)。 */
  setStudyPreviewReadKeys: (prev: string[], next: string[]) =>
    invoke<void>("set_study_preview_read_keys", { prev, next }),
  /** 焦点在主窗口时,把一次翻页转给内嵌网页。 */
  scrollStudyPreview: (delta: 1 | -1) =>
    invoke<void>("scroll_study_preview", { delta }),
  /** 把仓库里的锚点推回页面(页面按 id 合并,不会覆盖新数据)。 */
  mergeStudyPreviewAnnotations: (url: string, annotations: unknown[]) =>
    invoke<void>("merge_study_preview_annotations", { url, annotations }),
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
  /** 二进制读(base64):PDF 阅读器用,`read_file` 会按 UTF-8 解码而损坏 PDF。 */
  readFileBase64: (path: string) => invoke<string>("read_file_base64", { path }),
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
  /** 转发补全/hover 等只读交互请求;uri 由后端注入。项目 LSP 关着或没起时回 null。 */
  pythonLspRequest: (mdPath: string, method: string, params: unknown) =>
    invoke<unknown>("python_lsp_request", { mdPath, method, params }),
  pythonLspClose: (mdPath: string) => invoke<void>("python_lsp_close", { mdPath }),
  pythonLspStopAll: () => invoke<void>("python_lsp_stop_all"),
  pythonUvCreate: (mdPath: string) => invoke<PythonUvOutcome>("python_uv_create", { mdPath }),
};
