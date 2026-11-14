import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The language server and watcher events are pushed from Rust into the store.
 * Two rules are locked here:
 *
 *   - an event of a project that is no longer open is dropped (the old
 *     server keeps running until it is stopped, and its project-relative
 *     paths collide with the new project's);
 *   - a malformed payload never reaches the store (the problems panel and the
 *     linter index `range.start`, a range-less diagnostic used to crash the
 *     render).
 *
 * The subscription is application-scoped, so every handler must be able to
 * receive an event after any number of panel remounts; the teardown returned by
 * `installCodeEvents` is what a real unmount uses, and it has to unsubscribe.
 */

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  rescan: vi.fn(),
  openProject: vi.fn(),
  gitStatus: vi.fn(),
  lspStop: vi.fn(),
  toast: vi.fn(),
  setCodeProject: vi.fn(),
  refreshDiagnostics: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return mocks.unlisten;
  },
}));

vi.mock("./api", () => ({
  codeApi: {
    rescan: mocks.rescan,
    openProject: mocks.openProject,
    gitStatus: mocks.gitStatus,
    lspStop: mocks.lspStop,
  },
  termApi: { closeAll: vi.fn(async () => {}) },
}));

vi.mock("./editor/lsp", () => ({ refreshDiagnostics: mocks.refreshDiagnostics }));

vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({ showToast: mocks.toast, setCodeProject: mocks.setCodeProject }),
  },
}));

import { installCodeEvents } from "./events";
import { useCodeStore } from "./store";
import type { CodeEntry } from "./types";

function info(root: string, entries: CodeEntry[] = []) {
  return {
    root,
    name: root.split("/").pop() ?? root,
    isGit: false,
    gitRoot: null,
    branch: null,
    tree: { entries, truncated: false },
  };
}

function emit(event: string, payload: unknown): void {
  const handler = mocks.listeners.get(event);
  expect(handler, `no handler for ${event}`).toBeDefined();
  handler?.({ payload });
}

beforeEach(async () => {
  mocks.listeners.clear();
  mocks.refreshDiagnostics.mockClear();
  mocks.rescan.mockReset();
  mocks.openProject.mockReset();
  mocks.gitStatus.mockReset();
  useCodeStore.setState({
    project: null,
    diagnostics: {},
    lspStates: {},
    lspLog: [],
    expandedDirs: new Set<string>(),
  });
  mocks.openProject.mockImplementation(async (root: string) => info(root));
  mocks.gitStatus.mockResolvedValue({
    isRepo: false,
    root: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  });
  mocks.rescan.mockImplementation(async (root: string) => info(root).tree);
});

describe("installing the subscriptions", () => {
  it("subscribes to the four event channels and unsubscribes on teardown", async () => {
    const off = await installCodeEvents();
    expect([...mocks.listeners.keys()].sort()).toEqual([
      "code-lsp-diagnostics",
      "code-lsp-log",
      "code-lsp-status",
      "code-tree-changed",
    ]);
    off();
    expect(mocks.unlisten).toHaveBeenCalledTimes(4);
  });
});

describe("a tree delta from the watcher", () => {
  it("is applied to the open project", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.setState({
      project: {
        ...useCodeStore.getState().project!,
        tree: {
          entries: [{ path: "old.ts", name: "old.ts", isDir: false, size: 1 }],
          truncated: false,
        },
      },
    });
    await installCodeEvents();
    emit("code-tree-changed", {
      root: "/repo-a",
      reset: false,
      added: [{ path: "new.ts", name: "new.ts", isDir: false, size: 2 }],
      removed: ["old.ts"],
    });
    expect(useCodeStore.getState().project?.tree.entries).toEqual([
      { path: "new.ts", name: "new.ts", isDir: false, size: 2 },
    ]);
  });

  it("a reset (the ignore rules moved) rescans instead of applying the delta", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    mocks.rescan.mockClear();
    emit("code-tree-changed", { root: "/repo-a", reset: true, added: [], removed: [] });
    expect(mocks.rescan).toHaveBeenCalledWith("/repo-a");
  });

  it("an event of another project is dropped", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    const before = useCodeStore.getState().project;
    await installCodeEvents();
    emit("code-tree-changed", {
      root: "/repo-b",
      reset: true,
      added: [{ path: "x.ts", name: "x.ts", isDir: false, size: 0 }],
      removed: [],
    });
    expect(useCodeStore.getState().project).toBe(before);
    expect(mocks.rescan).not.toHaveBeenCalled();
  });

  it("a malformed delta is dropped", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    const before = useCodeStore.getState().project;
    await installCodeEvents();
    emit("code-tree-changed", { root: "/repo-a", added: "nope", removed: 4 });
    expect(useCodeStore.getState().project).toBe(before);
  });
});

describe("a diagnostics push", () => {
  const diagnostic = {
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
    severity: 1,
    message: "boom",
  };

  it("lands in the store keyed by path", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-diagnostics", { root: "/repo-a", path: "src/a.ts", diagnostics: [diagnostic] });
    expect(useCodeStore.getState().diagnostics["src/a.ts"]).toEqual([
      {
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
        severity: 1,
        code: null,
        source: null,
        message: "boom",
      },
    ]);
  });

  it("a malformed element is dropped, the valid ones stay", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-diagnostics", {
      root: "/repo-a",
      path: "src/a.ts",
      diagnostics: [diagnostic, { message: "no range" }, null],
    });
    expect(useCodeStore.getState().diagnostics["src/a.ts"]).toHaveLength(1);
  });

  it("a non-array diagnostics field clears the file instead of keeping a ghost", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.getState().setDiagnostics("src/a.ts", [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        code: null,
        source: null,
        message: "old",
      },
    ]);
    await installCodeEvents();
    emit("code-lsp-diagnostics", { root: "/repo-a", path: "src/a.ts", diagnostics: "nope" });
    expect(useCodeStore.getState().diagnostics["src/a.ts"]).toEqual([]);
  });

  it("a payload without a path is dropped", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-diagnostics", { root: "/repo-a", diagnostics: [diagnostic] });
    expect(useCodeStore.getState().diagnostics).toEqual({});
  });

  it("a push from another project is dropped", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-diagnostics", { root: "/repo-b", path: "src/a.ts", diagnostics: [diagnostic] });
    expect(useCodeStore.getState().diagnostics).toEqual({});
  });
});

describe("a status push", () => {
  it("is keyed by language", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-status", { root: "/repo-a", language: "typescript", state: "running" });
    expect(useCodeStore.getState().lspStates).toEqual({ typescript: "running" });
  });

  it("a missing state is recorded as unknown instead of staying silent", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-status", { root: "/repo-a", language: "rust" });
    expect(useCodeStore.getState().lspStates.rust).toBe("unknown");
  });

  it("a payload without a language is dropped", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-status", { root: "/repo-a", state: "running" });
    expect(useCodeStore.getState().lspStates).toEqual({});
  });
});

describe("a log push", () => {
  it("keeps language, level and message", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-log", {
      root: "/repo-a",
      language: "python",
      level: 1,
      message: "cannot start ty",
    });
    expect(useCodeStore.getState().lspLog).toEqual([
      { language: "python", level: 1, message: "cannot start ty" },
    ]);
  });

  it("fills the defaults for a partial payload instead of writing undefined", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-log", { root: "/repo-a" });
    expect(useCodeStore.getState().lspLog).toEqual([{ language: "?", level: 3, message: "" }]);
  });

  it("a log from another project is dropped", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await installCodeEvents();
    emit("code-lsp-log", { root: "/repo-b", language: "python", level: 1, message: "x" });
    expect(useCodeStore.getState().lspLog).toEqual([]);
  });
});

describe("a subscription that cannot be installed", () => {
  it("outside Tauri (the browser harness) installing still resolves and drops nothing later", async () => {
    // `listen` rejects when there is no event source at all: the installer has
    // to swallow it and still return a teardown, otherwise the pane would fail
    // to mount in the browser harness.
    const listenMock = vi.fn(async () => Promise.reject(new Error("no tauri")));
    vi.resetModules();
    vi.doMock("@tauri-apps/api/event", () => ({ listen: listenMock }));
    const { installCodeEvents: install } = await import("./events");
    const off = await install();
    expect(listenMock).toHaveBeenCalledTimes(4);
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
    vi.doUnmock("@tauri-apps/api/event");
    vi.resetModules();
  });
});
