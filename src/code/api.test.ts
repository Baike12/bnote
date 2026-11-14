import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The IPC surface of the code project and the terminal.
 *
 * Nowhere else does the frontend spell a Rust command name for this domain, and
 * nothing typechecks the pair. A renamed command, a dropped payload field or a
 * wrapper that forgot the `null` default for `overrides` fails at runtime with
 * "command not found", long after the change landed. This test executes every
 * wrapper against a recording `invoke` and pins command name + payload.
 */

const invokeMock = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown) => null));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { codeApi, termApi } from "./api";

type Call = { command: string; args: Record<string, unknown> };

async function record(run: () => Promise<unknown>): Promise<Call> {
  invokeMock.mockClear();
  await run();
  expect(invokeMock).toHaveBeenCalledTimes(1);
  const [command, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
  return { command, args };
}

beforeEach(() => {
  invokeMock.mockClear();
});

describe("the project commands", () => {
  it("openProject / rescan carry the root", async () => {
    expect(await record(() => codeApi.openProject("/repo"))).toEqual({
      command: "code_open_project",
      args: { root: "/repo" },
    });
    expect(await record(() => codeApi.rescan("/repo"))).toEqual({
      command: "code_rescan",
      args: { root: "/repo" },
    });
  });

  it("readFile / writeFile carry root and path", async () => {
    expect(await record(() => codeApi.readFile("/repo", "src/a.ts"))).toEqual({
      command: "code_read_file",
      args: { root: "/repo", path: "src/a.ts" },
    });
    expect(await record(() => codeApi.writeFile("/repo", "src/a.ts", "x\n"))).toEqual({
      command: "code_write_file",
      args: { root: "/repo", path: "src/a.ts", content: "x\n" },
    });
  });

  it("search passes the optional limit through, and omits nothing", async () => {
    expect(await record(() => codeApi.search("/repo", "foo", 20))).toEqual({
      command: "code_search",
      args: { root: "/repo", query: "foo", limit: 20 },
    });
    expect(await record(() => codeApi.search("/repo", "foo"))).toEqual({
      command: "code_search",
      args: { root: "/repo", query: "foo", limit: undefined },
    });
  });

  it("searchFiles carries the quick-open query", async () => {
    expect(await record(() => codeApi.searchFiles("/repo", "store"))).toEqual({
      command: "code_search_files",
      args: { root: "/repo", query: "store" },
    });
  });
});

describe("the git commands", () => {
  it("status / diff / stage / unstage", async () => {
    expect(await record(() => codeApi.gitStatus("/repo"))).toEqual({
      command: "code_git_status",
      args: { root: "/repo" },
    });
    expect(await record(() => codeApi.gitDiff("/repo", "src/a.ts", true))).toEqual({
      command: "code_git_diff",
      args: { root: "/repo", path: "src/a.ts", staged: true },
    });
    expect(await record(() => codeApi.gitStage("/repo", "src/a.ts"))).toEqual({
      command: "code_git_stage",
      args: { root: "/repo", path: "src/a.ts" },
    });
    expect(await record(() => codeApi.gitUnstage("/repo", "src/a.ts"))).toEqual({
      command: "code_git_unstage",
      args: { root: "/repo", path: "src/a.ts" },
    });
  });
});

describe("the language server commands", () => {
  it("resolve / start send null when there is no override", async () => {
    expect(await record(() => codeApi.lspResolve("/repo", "typescript", "src/a.ts"))).toEqual({
      command: "code_lsp_resolve",
      args: { root: "/repo", language: "typescript", path: "src/a.ts", overrides: null },
    });
    expect(await record(() => codeApi.lspStart("/repo", "python", "sub/a.py"))).toEqual({
      command: "code_lsp_start",
      args: { root: "/repo", language: "python", path: "sub/a.py", overrides: null },
    });
  });

  it("an explicit override reaches the backend as given", async () => {
    const overrides = { command: "ty", args: ["server"] };
    expect(await record(() => codeApi.lspStart("/repo", "python", "a.py", overrides))).toEqual({
      command: "code_lsp_start",
      args: { root: "/repo", language: "python", path: "a.py", overrides },
    });
  });

  it("stop / status / sync / close", async () => {
    expect(await record(() => codeApi.lspStop("/repo"))).toEqual({
      command: "code_lsp_stop",
      args: { root: "/repo" },
    });
    expect(await record(() => codeApi.lspStatus("/repo"))).toEqual({
      command: "code_lsp_status",
      args: { root: "/repo" },
    });
    expect(await record(() => codeApi.lspSync("/repo", "src/a.ts", "x"))).toEqual({
      command: "code_lsp_sync",
      args: { root: "/repo", path: "src/a.ts", content: "x" },
    });
    expect(await record(() => codeApi.lspClose("/repo", "src/a.ts"))).toEqual({
      command: "code_lsp_close",
      args: { root: "/repo", path: "src/a.ts" },
    });
  });

  it("a request passes the method and the params, with null for a document-less request", async () => {
    const params = { position: { line: 1, character: 2 } };
    expect(
      await record(() =>
        codeApi.lspRequest("/repo", "typescript", "textDocument/hover", "src/a.ts", params),
      ),
    ).toEqual({
      command: "code_lsp_request",
      args: {
        root: "/repo",
        language: "typescript",
        method: "textDocument/hover",
        path: "src/a.ts",
        params,
      },
    });
    // `workspace/symbol` addresses no document: the backend must not inject a
    // textDocument.uri for it.
    expect(
      await record(() =>
        codeApi.lspRequest("/repo", "typescript", "workspace/symbol", null, { query: "x" }),
      ),
    ).toEqual({
      command: "code_lsp_request",
      args: {
        root: "/repo",
        language: "typescript",
        method: "workspace/symbol",
        path: null,
        params: { query: "x" },
      },
    });
  });
});

describe("the terminal commands", () => {
  it("open carries the root and the initial grid", async () => {
    expect(await record(() => termApi.open("/repo", 80, 24))).toEqual({
      command: "term_open",
      args: { root: "/repo", cols: 80, rows: 24 },
    });
  });

  it("write / resize / close / closeAll", async () => {
    expect(await record(() => termApi.write(7, "bHM="))).toEqual({
      command: "term_write",
      args: { termId: 7, data: "bHM=" },
    });
    expect(await record(() => termApi.resize(7, 120, 30))).toEqual({
      command: "term_resize",
      args: { termId: 7, cols: 120, rows: 30 },
    });
    expect(await record(() => termApi.close(7))).toEqual({
      command: "term_close",
      args: { termId: 7 },
    });
    expect(await record(() => termApi.closeAll())).toEqual({
      command: "term_close_all",
      args: undefined,
    });
  });
});
