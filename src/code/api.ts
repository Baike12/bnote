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
 * 代码项目的 IPC 口子。
 *
 * 全部命令都在 Rust 的 `src-tauri/src/commands/code.rs`;路径边界由后端
 * 保证(项目根内才放行),前端不重复校验。
 */
export const codeApi = {
  /** 打开一个项目:扫文件树 + 看 git 状态。 */
  openProject: (root: string) =>
    invoke<CodeProjectInfo>("code_open_project", { root }),
  /** 重扫文件树。 */
  rescan: (root: string) => invoke<CodeTree>("code_rescan", { root }),
  /** 读一个文件(连同它的 languageId)。 */
  readFile: (root: string, path: string) =>
    invoke<CodeFile>("code_read_file", { root, path }),
  /** 写一个文件。 */
  writeFile: (root: string, path: string, content: string) =>
    invoke<void>("code_write_file", { root, path, content }),
  /** 搜文件内容。 */
  search: (root: string, query: string, limit?: number) =>
    invoke<CodeSearchHit[]>("code_search", { root, query, limit }),
  /** 按文件名快速搜(快速打开文件)。 */
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

  // ---- 语言服务器 ----
  /** 这个语言该用哪个服务器(null = 没有内置默认)。 */
  lspResolve: (root: string, language: string, overrides?: ServerConfig) =>
    invoke<ResolvedServerInfo | null>("code_lsp_resolve", {
      root,
      language,
      overrides: overrides ?? null,
    }),
  /** 确保服务器起着。 */
  lspStart: (root: string, language: string, overrides?: ServerConfig) =>
    invoke<{ language: string; state: string }>("code_lsp_start", {
      root,
      language,
      overrides: overrides ?? null,
    }),
  /** 停掉这个项目的所有语言服务器。 */
  lspStop: (root: string) => invoke<void>("code_lsp_stop", { root }),
  /** 当前哪些语言的服务器活着。 */
  lspStatus: (root: string) =>
    invoke<{ language: string; state: string }[]>("code_lsp_status", { root }),
  /** 把内容同步给服务器(didOpen / didChange);返回 false 表示服务器没起。 */
  lspSync: (root: string, path: string, content: string) =>
    invoke<boolean>("code_lsp_sync", { root, path, content }),
  /** 关掉一个文档。 */
  lspClose: (root: string, path: string) =>
    invoke<void>("code_lsp_close", { root, path }),
  /**
   * 转发一个语言服务器请求。
   *
   * `path` 给了就把 `textDocument.uri` 交给后端注入(前端给不了假文档);
   * 服务器没起或超时回 null。
   */
  lspRequest: (
    root: string,
    language: string,
    method: string,
    path: string | null,
    params: unknown,
  ) => invoke<unknown>("code_lsp_request", { root, language, method, path, params }),
};
