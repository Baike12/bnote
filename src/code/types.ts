/**
 * 代码项目的数据形状。
 *
 * 与 Rust 侧 `src-tauri/src/code/` 一一对应(字段名走 camelCase,
 * Rust 那边是 `rename_all = "camelCase"`)。
 */

/** 文件树里的一个条目(相对项目根,posix 分隔符)。 */
export interface CodeEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

/** 一次扫描的文件树。 */
export interface CodeTree {
  entries: CodeEntry[];
  /** 命中条目上限被截断——文件树不完整,要如实告诉用户。 */
  truncated: boolean;
}

/** 一个文件的内容。 */
export interface CodeFile {
  path: string;
  /** LSP languageId(后端按扩展名判定)。 */
  languageId: string;
  content: string;
  binary: boolean;
  size: number;
}

/** 打开的项目信息。 */
export interface CodeProjectInfo {
  root: string;
  name: string;
  isGit: boolean;
  gitRoot: string | null;
  branch: string | null;
  tree: CodeTree;
}

/** 搜索命中。 */
export interface CodeSearchHit {
  path: string;
  /** 0-based 行号。 */
  line: number;
  text: string;
}

/** 一个文件在 git 眼里的状态。 */
export interface GitFileState {
  path: string;
  /** 重命名的原路径。 */
  origPath: string | null;
  /** 暂存区状态:M/A/D/R/C/U/?/!。 */
  index: string;
  /** 工作区状态:同上。 */
  worktree: string;
}

/** 仓库状态。 */
export interface GitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileState[];
}

/** LSP 诊断的位置(0-based,字符按 UTF-16 码元计,与 CodeMirror 一致)。 */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** 一条诊断。severity:1=Error 2=Warning 3=Info 4=Hint。 */
export interface LspDiagnostic {
  range: LspRange;
  severity: number;
  code: string | number | null;
  source: string | null;
  message: string;
}

/** 语言服务器的启动配置(覆盖内置默认)。 */
export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  initOptions?: unknown;
}

/** 解析出来的语言服务器信息。 */
export interface ResolvedServerInfo {
  command: string;
  args: string[];
  disabled: boolean;
}

/** LSP 的一个位置(跳转目标)。 */
export interface LspLocation {
  uri: string;
  range: LspRange;
}
