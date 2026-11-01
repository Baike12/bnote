import { invoke } from "@tauri-apps/api/core";
import type {
  CodeFile,
  CodeProjectInfo,
  CodeSearchHit,
  CodeTree,
  GitStatus,
  ResolvedServerInfo,
  ServerConfig,
} from "./types";

/**
 * IPC surface of the code project.
 *
 * Every command lives in Rust `src-tauri/src/commands/code.rs`; the path
 * boundary is enforced by the backend (only paths inside the project root
 * pass), so the frontend never revalidates it.
 */
export const codeApi = {
  /** Open a project: scan the file tree and read the git status. */
  openProject: (root: string) =>
    invoke<CodeProjectInfo>("code_open_project", { root }),
  /** Rescan the file tree. */
  rescan: (root: string) => invoke<CodeTree>("code_rescan", { root }),
  /** Read a file together with its languageId. */
  readFile: (root: string, path: string) =>
    invoke<CodeFile>("code_read_file", { root, path }),
  /** Write a file. */
  writeFile: (root: string, path: string, content: string) =>
    invoke<void>("code_write_file", { root, path, content }),
  /** Search file contents. */
  search: (root: string, query: string, limit?: number) =>
    invoke<CodeSearchHit[]>("code_search", { root, query, limit }),
  /** Fuzzy-search file names (quick open). */
  searchFiles: (root: string, query: string) =>
    invoke<import("./types").CodeEntry[]>("code_search_files", { root, query }),

  // ---- git ----
  gitStatus: (root: string) => invoke<GitStatus>("code_git_status", { root }),
  gitDiff: (root: string, path: string, staged: boolean) =>
    invoke<string>("code_git_diff", { root, path, staged }),
  gitStage: (root: string, path: string) =>
    invoke<GitStatus>("code_git_stage", { root, path }),
  gitUnstage: (root: string, path: string) =>
    invoke<GitStatus>("code_git_unstage", { root, path }),

  // ---- language servers ----
  /** Which server handles this language (null = no built-in default). */
  lspResolve: (root: string, language: string, overrides?: ServerConfig) =>
    invoke<ResolvedServerInfo | null>("code_lsp_resolve", {
      root,
      language,
      overrides: overrides ?? null,
    }),
  /** Make sure the server is running. */
  lspStart: (root: string, language: string, overrides?: ServerConfig) =>
    invoke<{ language: string; state: string }>("code_lsp_start", {
      root,
      language,
      overrides: overrides ?? null,
    }),
  /** Stop every language server of this project. */
  lspStop: (root: string) => invoke<void>("code_lsp_stop", { root }),
  /** Which language servers are alive right now. */
  lspStatus: (root: string) =>
    invoke<{ language: string; state: string }[]>("code_lsp_status", { root }),
  /** Sync content to the server (didOpen / didChange); false means it is not running. */
  lspSync: (root: string, path: string, content: string) =>
    invoke<boolean>("code_lsp_sync", { root, path, content }),
  /** Close a document. */
  lspClose: (root: string, path: string) =>
    invoke<void>("code_lsp_close", { root, path }),
  /**
   * Forward a language server request.
   *
   * When `path` is given the backend injects `textDocument.uri` (the frontend
   * cannot invent a document); a server that is down or times out returns null.
   */
  lspRequest: (
    root: string,
    language: string,
    method: string,
    path: string | null,
    params: unknown,
  ) => invoke<unknown>("code_lsp_request", { root, language, method, path, params }),
};
