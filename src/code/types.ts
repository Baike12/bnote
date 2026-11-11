/**
 * Data shapes of the code project.
 *
 * They mirror the Rust side `src-tauri/src/code/` one to one (field names are
 * camelCase; Rust uses `rename_all = "camelCase"`).
 */

/** One entry of the file tree (relative to the project root, posix separators). */
export interface CodeEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

/** One scan of the file tree. */
export interface CodeTree {
  entries: CodeEntry[];
  /** The entry limit was hit — the file tree is incomplete and the user must be told. */
  truncated: boolean;
}

/**
 * The visible difference the backend's project watcher reports.
 *
 * It is applied to the entries the store already holds: the whole tree is
 * never sent again (a large repository is tens of thousands of entries, far
 * too much to ship with every file change).
 */
export interface CodeTreeDelta {
  /** Project root the delta belongs to (stale events are dropped by it). */
  root: string;
  /** Entries that were not in the previous snapshot. */
  added: CodeEntry[];
  /** Relative paths that no longer exist (a directory covers its subtree). */
  removed: string[];
  /** A `.gitignore` / `.ignore` changed: rescan instead of applying the delta. */
  reset: boolean;
}

/** The content of a file. */
export interface CodeFile {
  /** Relative inside the project, absolute for a file outside it. */
  path: string;
  /** LSP languageId (decided by the backend from the extension). */
  languageId: string;
  content: string;
  binary: boolean;
  size: number;
  /**
   * Outside the project root: opened read-only. A jump can land in
   * `node_modules` or a type-declaration cache, and those files are readable
   * but never written (the backend's write path stays inside the root).
   */
  external: boolean;
}

/** Info about the open project. */
export interface CodeProjectInfo {
  root: string;
  name: string;
  isGit: boolean;
  gitRoot: string | null;
  branch: string | null;
  tree: CodeTree;
}

/** A search hit. */
export interface CodeSearchHit {
  path: string;
  /** 0-based line number. */
  line: number;
  text: string;
}

/** The git status of one file. */
export interface GitFileState {
  path: string;
  /** The original path of a rename. */
  origPath: string | null;
  /** Index status: M/A/D/R/C/U/?/!. */
  index: string;
  /** Worktree status: same set. */
  worktree: string;
  /** Lines added in the worktree (vs the index); an untracked file counts its own lines. */
  added: number;
  /** Lines removed in the worktree (vs the index). */
  removed: number;
  /** Lines added in the index (vs HEAD). */
  stagedAdded: number;
  /** Lines removed in the index (vs HEAD). */
  stagedRemoved: number;
}

/** Repository status. */
export interface GitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileState[];
}

/** Position of an LSP diagnostic (0-based, characters counted in UTF-16 code units like CodeMirror). */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** One diagnostic. severity: 1=Error 2=Warning 3=Info 4=Hint. */
export interface LspDiagnostic {
  range: LspRange;
  severity: number;
  code: string | number | null;
  source: string | null;
  message: string;
}

/** Startup configuration of a language server (overrides the built-in default). */
export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  initOptions?: unknown;
}

/** The resolved language server info. */
export interface ResolvedServerInfo {
  command: string;
  args: string[];
  disabled: boolean;
}

/** An LSP position (a jump target). */
export interface LspLocation {
  uri: string;
  range: LspRange;
}
