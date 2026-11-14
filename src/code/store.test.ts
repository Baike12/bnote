import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";

/**
 * The code store is the single writer of the project, tabs, buffers, git
 * status and terminal tabs. The invariants that matter to the user are the
 * ordering ones:
 *
 *   - a buffer is flushed to disk *before* it is dropped (switching or closing
 *     a project, closing a tab);
 *   - a stale disk read never steals the tab (two files clicked in a row);
 *   - a server that failed once is not retried on every file open;
 *   - a shell is scoped to the project root (switching stops it).
 *
 * The tests drive the real store; only the IPC boundary, the xterm session
 * and the toast sink are faked.
 */

const mocks = vi.hoisted(() => ({
  openProject: vi.fn(),
  rescan: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  lspStop: vi.fn(),
  lspStart: vi.fn(),
  lspSync: vi.fn(),
  lspClose: vi.fn(),
  gitStatus: vi.fn(),
  termOpen: vi.fn(),
  termClose: vi.fn(),
  termCloseAll: vi.fn(),
  termWrite: vi.fn(),
  termResize: vi.fn(),
  disposeAllTerminals: vi.fn(),
  disposeTerminal: vi.fn(),
  ensureTerminalOutputListener: vi.fn(async () => {}),
  toast: vi.fn(),
  setCodeProject: vi.fn(),
  settings: { codeLspServers: {} as Record<string, { command: string; args?: string[] }> },
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("./api", () => ({
  codeApi: {
    openProject: mocks.openProject,
    rescan: mocks.rescan,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    lspStop: mocks.lspStop,
    lspStart: mocks.lspStart,
    lspSync: mocks.lspSync,
    lspClose: mocks.lspClose,
    gitStatus: mocks.gitStatus,
  },
  termApi: {
    open: mocks.termOpen,
    write: mocks.termWrite,
    resize: mocks.termResize,
    close: mocks.termClose,
    closeAll: mocks.termCloseAll,
  },
}));

vi.mock("./term/session", () => ({
  disposeAllTerminals: mocks.disposeAllTerminals,
  disposeTerminal: mocks.disposeTerminal,
  ensureTerminalOutputListener: mocks.ensureTerminalOutputListener,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => {};
  },
}));

vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({
      showToast: mocks.toast,
      setCodeProject: mocks.setCodeProject,
      settings: mocks.settings,
    }),
  },
}));

import { detectIndent, isDirty, useCodeStore } from "./store";
import { registerCodeEditor, unregisterCodeEditor, type CodeEditorHandle } from "./editor/registry";
import type { CodeEntry, CodeFile, CodeProjectInfo, GitStatus } from "./types";

function info(root: string, entries: CodeEntry[] = []): CodeProjectInfo {
  return {
    root,
    name: root.split("/").pop() ?? root,
    isGit: true,
    gitRoot: root,
    branch: "main",
    tree: { entries, truncated: false },
  };
}

function file(path: string, content = "x\n", over: Partial<CodeFile> = {}): CodeFile {
  return {
    path,
    content,
    languageId: "plaintext",
    binary: false,
    size: content.length,
    external: false,
    ...over,
  };
}

function gitStatus(): GitStatus {
  return {
    isRepo: true,
    root: "/repo-a",
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
}

/** Reset every mutable field; the actions stay the ones the module created. */
function resetStore(): void {
  const initial = useCodeStore.getInitialState();
  useCodeStore.setState({
    ...initial,
    project: null,
    tabs: [],
    activePath: null,
    files: {},
    diagnostics: {},
    git: null,
    lspStates: {},
    lspLog: [],
    treeOpen: false,
    expandedDirs: new Set<string>(),
    treeFocus: null,
    editorFocus: 0,
    problemsOpen: false,
    diffOpen: false,
    diffStaged: false,
    gitRev: 0,
    jump: null,
    references: null,
    navBack: [],
    termOpen: false,
    terminals: [],
    activeTermId: null,
  });
}

let handle: CodeEditorHandle | null = null;

/** A real editor state; only `state` and `dom.isConnected` are read by the store. */
function registerEditor(path: string, doc = "line one\nline two\n"): EditorState {
  const state = EditorState.create({ doc });
  handle = {
    root: "/repo-a",
    path,
    language: "typescript",
    view: { state, dom: { isConnected: true } },
  } as unknown as CodeEditorHandle;
  registerCodeEditor(handle);
  return state;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  resetStore();
  for (const fn of Object.values(mocks)) {
    if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
  }
  // The `term-exit` subscription is module-scoped and installed once; keeping
  // the map is what lets a later test see it again after the reset.
  mocks.settings.codeLspServers = {};
  mocks.openProject.mockImplementation(async (root: string) => info(root));
  mocks.rescan.mockImplementation(async (root: string) => info(root).tree);
  mocks.readFile.mockImplementation(async (_root: string, path: string) => file(path));
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.lspStop.mockResolvedValue(undefined);
  mocks.lspStart.mockResolvedValue({ language: "typescript", state: "running" });
  mocks.lspSync.mockResolvedValue(true);
  mocks.lspClose.mockResolvedValue(undefined);
  mocks.gitStatus.mockResolvedValue(gitStatus());
  mocks.termOpen.mockResolvedValue({ termId: 1, title: "zsh" });
  mocks.termClose.mockResolvedValue(true);
  mocks.termCloseAll.mockResolvedValue(undefined);
  mocks.termWrite.mockResolvedValue(undefined);
  mocks.termResize.mockResolvedValue(undefined);
});

afterEach(() => {
  if (handle) unregisterCodeEditor(handle);
  handle = null;
  vi.useRealTimers();
});

describe("detectIndent", () => {
  it("turns a tab-indented file into one tab per level", () => {
    expect(detectIndent("fn main() {\n\tbody();\n}\n")).toBe("\t");
  });

  it("returns the width of the first space indentation", () => {
    expect(detectIndent("a\n  b\n")).toBe("  ");
    expect(detectIndent("a\n    b\n")).toBe("    ");
    expect(detectIndent("a\n      b\n")).toBe("      ");
  });

  it("caps the width at 8 spaces instead of copying an accidental long line", () => {
    expect(detectIndent("a\n          b\n")).toBe("        ");
  });

  it("skips blank and unindented lines before the first indented one", () => {
    expect(detectIndent("first\n\n  \nsecond\n\tthird\n")).toBe("\t");
  });

  it("falls back to two spaces when nothing is indented", () => {
    expect(detectIndent("")).toBe("  ");
    expect(detectIndent("one\ntwo\n")).toBe("  ");
  });

  it("only looks at the first 200 lines", () => {
    const filler = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(detectIndent(`${filler}\n\tlate\n`)).toBe("  ");
  });
});

describe("opening a project", () => {
  it("starts from the top level with the tree open and no folder expanded", async () => {
    useCodeStore.setState({ expandedDirs: new Set(["src"]) });
    await useCodeStore.getState().openProject("/repo-a");
    const state = useCodeStore.getState();
    expect(state.project?.root).toBe("/repo-a");
    expect(state.treeOpen).toBe(true);
    expect(state.expandedDirs.size).toBe(0);
    expect(mocks.setCodeProject).toHaveBeenCalledWith({ path: "/repo-a", title: "repo-a" });
  });

  it("reads the git status right away", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    expect(mocks.gitStatus).toHaveBeenCalledWith("/repo-a");
    expect(useCodeStore.getState().git?.branch).toBe("main");
    expect(useCodeStore.getState().gitRev).toBe(1);
  });

  it("a failed git status leaves no stale status but still moves the revision", async () => {
    mocks.gitStatus.mockRejectedValueOnce(new Error("not a repo"));
    await useCodeStore.getState().openProject("/repo-a");
    expect(useCodeStore.getState().git).toBeNull();
    expect(useCodeStore.getState().gitRev).toBe(1);
  });

  it("reopening the same root keeps the open tabs and their buffers", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().updateContent("src/a.ts", "unsaved\n");
    await useCodeStore.getState().openProject("/repo-a");
    const state = useCodeStore.getState();
    expect(state.tabs).toEqual(["src/a.ts"]);
    expect(state.files["src/a.ts"]?.content).toBe("unsaved\n");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("switching project flushes the modified buffers before clearing them", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().updateContent("src/a.ts", "dirty\n");
    await useCodeStore.getState().openProject("/repo-b");
    expect(mocks.writeFile).toHaveBeenCalledWith("/repo-a", "src/a.ts", "dirty\n");
    expect(useCodeStore.getState().files).toEqual({});
    expect(useCodeStore.getState().tabs).toEqual([]);
  });

  it("switching project stops the old language servers and shells", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openProject("/repo-b");
    expect(mocks.lspStop).toHaveBeenCalledWith("/repo-a");
    expect(mocks.termCloseAll).toHaveBeenCalledTimes(1);
    expect(mocks.disposeAllTerminals).toHaveBeenCalledTimes(1);
  });

  it("closing a project flushes, stops everything and leaves no project", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().updateContent("src/a.ts", "dirty\n");
    await useCodeStore.getState().closeProject();
    expect(mocks.writeFile).toHaveBeenCalledWith("/repo-a", "src/a.ts", "dirty\n");
    expect(mocks.lspStop).toHaveBeenCalledWith("/repo-a");
    const state = useCodeStore.getState();
    expect(state.project).toBeNull();
    expect(state.tabs).toEqual([]);
    expect(state.treeOpen).toBe(false);
    expect(mocks.setCodeProject).toHaveBeenLastCalledWith(null);
  });
});

describe("opening a file", () => {
  it("records the buffer and makes it the active tab", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    const state = useCodeStore.getState();
    expect(state.tabs).toEqual(["src/a.ts"]);
    expect(state.activePath).toBe("src/a.ts");
    expect(state.files["src/a.ts"]).toMatchObject({
      path: "src/a.ts",
      saved: "x\n",
      content: "x\n",
      external: false,
    });
  });

  it("pins the indent unit and the tab width from the content at open time", async () => {
    mocks.readFile.mockResolvedValueOnce(file("src/a.ts", "fn x() {\n\tbody();\n}\n"));
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    expect(useCodeStore.getState().files["src/a.ts"]).toMatchObject({
      indentUnit: "\t",
      tabSize: 4,
    });
  });

  it("switching to an already open file does not re-read the disk", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    await useCodeStore.getState().openFile("src/b.ts");
    mocks.readFile.mockClear();
    await useCodeStore.getState().openFile("src/a.ts");
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(useCodeStore.getState().activePath).toBe("src/a.ts");
    expect(useCodeStore.getState().tabs).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("a failed read is reported and leaves no tab behind", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("ENOENT"));
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/missing.ts");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("src/missing.ts"));
    expect(useCodeStore.getState().tabs).toEqual([]);
    expect(useCodeStore.getState().activePath).toBeNull();
  });

  it("the later of two rapid opens wins even when its read resolves first", async () => {
    // Two clicks race on the disk read: the first answer arrives after the
    // second one, and must not pull the caret back to the first file.
    let resolveFirst: (f: CodeFile) => void = () => {};
    mocks.readFile.mockImplementationOnce(
      (_root: string, _path: string) => new Promise<CodeFile>((r) => (resolveFirst = r)),
    );
    await useCodeStore.getState().openProject("/repo-a");
    const first = useCodeStore.getState().openFile("src/a.ts");
    const second = useCodeStore.getState().openFile("src/b.ts");
    await second;
    resolveFirst(file("src/a.ts", "late\n"));
    await first;
    const state = useCodeStore.getState();
    expect(state.activePath).toBe("src/b.ts");
    expect(state.tabs).toEqual(["src/b.ts"]);
    expect(state.files["src/a.ts"]).toBeUndefined();
  });

  it("a binary file is opened but never pushed to a language server", async () => {
    mocks.readFile.mockResolvedValueOnce(
      file("img.png", "", { languageId: "plaintext", binary: true }),
    );
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("img.png");
    await flush();
    expect(useCodeStore.getState().files["img.png"]?.binary).toBe(true);
    expect(mocks.lspStart).not.toHaveBeenCalled();
  });

  it("a text file starts its language server after landing in the tab", async () => {
    mocks.readFile.mockResolvedValueOnce(
      file("src/a.ts", "const x = 1\n", { languageId: "typescript" }),
    );
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    await vi.waitFor(() => expect(mocks.lspStart).toHaveBeenCalledTimes(1));
    expect(mocks.lspStart).toHaveBeenCalledWith("/repo-a", "typescript", "src/a.ts", undefined);
  });
});

describe("closing a tab", () => {
  it("flushes the buffer to disk before it disappears", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().updateContent("src/a.ts", "unsaved\n");
    useCodeStore.getState().closeTab("src/a.ts");
    await flush();
    expect(mocks.writeFile).toHaveBeenCalledWith("/repo-a", "src/a.ts", "unsaved\n");
  });

  it("closing the active tab lands on the last remaining tab", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    await useCodeStore.getState().openFile("src/b.ts");
    useCodeStore.getState().setActiveTab("src/b.ts");
    useCodeStore.getState().closeTab("src/b.ts");
    expect(useCodeStore.getState().activePath).toBe("src/a.ts");
    expect(useCodeStore.getState().tabs).toEqual(["src/a.ts"]);
  });

  it("closing the last tab clears the active path", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().closeTab("src/a.ts");
    expect(useCodeStore.getState().activePath).toBeNull();
    expect(useCodeStore.getState().tabs).toEqual([]);
  });

  it("tells the server to close the document so it stops pushing ghost diagnostics", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().closeTab("src/a.ts");
    await flush();
    expect(mocks.lspClose).toHaveBeenCalledWith("/repo-a", "src/a.ts");
  });
});

describe("saving a file", () => {
  it("writes the buffer and clears the dirty state", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().updateContent("src/a.ts", "edited\n");
    expect(isDirty(useCodeStore.getState(), "src/a.ts")).toBe(true);
    await useCodeStore.getState().saveFile("src/a.ts");
    expect(mocks.writeFile).toHaveBeenCalledWith("/repo-a", "src/a.ts", "edited\n");
    expect(isDirty(useCodeStore.getState(), "src/a.ts")).toBe(false);
  });

  it("re-reads the git status after a successful write", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    const before = useCodeStore.getState().gitRev;
    await useCodeStore.getState().saveFile("src/a.ts");
    expect(useCodeStore.getState().gitRev).toBe(before + 1);
  });

  it("a binary file is never written back as an empty document", async () => {
    mocks.readFile.mockResolvedValueOnce(file("img.png", "", { binary: true }));
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("img.png");
    await useCodeStore.getState().saveFile("img.png");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("a failed write is reported and the buffer stays dirty", async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error("EACCES"));
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().updateContent("src/a.ts", "edited\n");
    await useCodeStore.getState().saveFile("src/a.ts");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(isDirty(useCodeStore.getState(), "src/a.ts")).toBe(true);
  });

  it("saving an unknown path does nothing", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().saveFile("src/never-opened.ts");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});

describe("buffer edits", () => {
  it("an identical content write leaves the state object alone", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    const files = useCodeStore.getState().files;
    useCodeStore.getState().updateContent("src/a.ts", "x\n");
    expect(useCodeStore.getState().files).toBe(files);
  });

  it("an edit to an unopened path is ignored", () => {
    const files = useCodeStore.getState().files;
    useCodeStore.getState().updateContent("ghost.ts", "x");
    expect(useCodeStore.getState().files).toBe(files);
  });

  it("replacing the content after a rename marks it saved", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    useCodeStore.getState().replaceContent("src/a.ts", "renamed\n");
    expect(isDirty(useCodeStore.getState(), "src/a.ts")).toBe(false);
    expect(useCodeStore.getState().files["src/a.ts"]?.content).toBe("renamed\n");
  });
});

describe("language server state", () => {
  it("has no server without a project, without a language, or for plaintext", async () => {
    expect(await useCodeStore.getState().ensureLsp("typescript", "src/a.ts")).toBe(false);
    await useCodeStore.getState().openProject("/repo-a");
    expect(await useCodeStore.getState().ensureLsp("", "src/a.ts")).toBe(false);
    expect(await useCodeStore.getState().ensureLsp("plaintext", "src/a.ts")).toBe(false);
    expect(mocks.lspStart).not.toHaveBeenCalled();
  });

  it("a server that failed once is not retried on every open", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.setState({ lspStates: { typescript: "off" } });
    expect(await useCodeStore.getState().ensureLsp("typescript", "src/a.ts")).toBe(false);
    expect(mocks.lspStart).not.toHaveBeenCalled();
  });

  it("a success marks the language running and opens the documents of that language", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.setState({
      files: {
        "src/a.ts": {
          path: "src/a.ts",
          saved: "a\n",
          content: "a\n",
          languageId: "typescript",
          binary: false,
          size: 2,
          indentUnit: "  ",
          tabSize: 2,
          external: false,
        },
        "src/b.py": {
          path: "src/b.py",
          saved: "b\n",
          content: "b\n",
          languageId: "python",
          binary: false,
          size: 2,
          indentUnit: "  ",
          tabSize: 2,
          external: false,
        },
      },
    });
    expect(await useCodeStore.getState().ensureLsp("typescript", "src/a.ts")).toBe(true);
    expect(useCodeStore.getState().lspStates.typescript).toBe("running");
    expect(mocks.lspSync).toHaveBeenCalledWith("/repo-a", "src/a.ts", "a\n");
    expect(mocks.lspSync).not.toHaveBeenCalledWith("/repo-a", "src/b.py", expect.anything());
  });

  it("a failure marks the language off so no open retries it", async () => {
    mocks.lspStart.mockRejectedValueOnce(new Error("not installed"));
    await useCodeStore.getState().openProject("/repo-a");
    expect(await useCodeStore.getState().ensureLsp("typescript", "src/a.ts")).toBe(false);
    expect(useCodeStore.getState().lspStates.typescript).toBe("off");
    expect(await useCodeStore.getState().ensureLsp("typescript", "src/a.ts")).toBe(false);
    expect(mocks.lspStart).toHaveBeenCalledTimes(1);
  });

  it("an explicit override wins over the global settings", async () => {
    mocks.settings.codeLspServers = { typescript: { command: "global", args: ["g"] } };
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().ensureLsp("typescript", "src/a.ts", {
      command: "explicit",
      args: ["e"],
    });
    expect(mocks.lspStart).toHaveBeenCalledWith("/repo-a", "typescript", "src/a.ts", {
      command: "explicit",
      args: ["e"],
    });
  });

  it("the settings layer is used when the caller gives none", async () => {
    mocks.settings.codeLspServers = { typescript: { command: "global" } };
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().ensureLsp("typescript", "src/a.ts");
    expect(mocks.lspStart).toHaveBeenCalledWith("/repo-a", "typescript", "src/a.ts", {
      command: "global",
      args: [],
    });
  });

  it("a settings entry without args becomes an empty argument list", async () => {
    mocks.settings.codeLspServers = { python: { command: "ty", args: ["server"] } };
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().ensureLsp("python", "sub/a.py");
    expect(mocks.lspStart).toHaveBeenCalledWith("/repo-a", "python", "sub/a.py", {
      command: "ty",
      args: ["server"],
    });
  });
});

describe("diagnostics and the language server log", () => {
  it("diagnostics are keyed by file", () => {
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      code: null,
      source: null,
      message: "boom",
    };
    useCodeStore.getState().setDiagnostics("src/a.ts", [diagnostic]);
    useCodeStore.getState().setDiagnostics("src/b.ts", []);
    expect(useCodeStore.getState().diagnostics["src/a.ts"]).toEqual([diagnostic]);
    expect(useCodeStore.getState().diagnostics["src/b.ts"]).toEqual([]);
  });

  it("the log is bounded so a long session cannot grow without end", () => {
    for (let i = 0; i < 205; i++) {
      useCodeStore.getState().appendLspLog("typescript", 3, `m${i}`);
    }
    const log = useCodeStore.getState().lspLog;
    expect(log).toHaveLength(200);
    expect(log[0].message).toBe("m5");
    expect(log[199].message).toBe("m204");
  });
});

describe("the file tree drawer state", () => {
  it("toggling a directory adds and removes it", () => {
    useCodeStore.getState().toggleDir("src");
    expect([...useCodeStore.getState().expandedDirs]).toEqual(["src"]);
    useCodeStore.getState().toggleDir("src");
    expect(useCodeStore.getState().expandedDirs.size).toBe(0);
  });

  it("expanding to a file opens every ancestor and leaves a top-level file alone", () => {
    useCodeStore.getState().expandTo("src/code/store.ts");
    expect([...useCodeStore.getState().expandedDirs].sort()).toEqual(["src", "src/code"]);
    const before = useCodeStore.getState().expandedDirs;
    useCodeStore.getState().expandTo("README.md");
    expect(useCodeStore.getState().expandedDirs).toBe(before);
  });

  it("a focus request carries a new sequence number every time", () => {
    useCodeStore.getState().requestTreeFocus("src/a.ts");
    const first = useCodeStore.getState().treeFocus;
    useCodeStore.getState().requestTreeFocus("src/a.ts");
    const second = useCodeStore.getState().treeFocus;
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);
    expect(second?.path).toBe("src/a.ts");
    useCodeStore.getState().clearTreeFocus();
    expect(useCodeStore.getState().treeFocus).toBeNull();
  });

  it("the diff pane keeps its side unless a new one is given", () => {
    useCodeStore.getState().setDiff(true);
    expect(useCodeStore.getState()).toMatchObject({ diffOpen: true, diffStaged: false });
    useCodeStore.getState().setDiff(true, true);
    expect(useCodeStore.getState().diffStaged).toBe(true);
    useCodeStore.getState().setDiff(false);
    expect(useCodeStore.getState()).toMatchObject({ diffOpen: false, diffStaged: true });
    useCodeStore.getState().toggleDiffStaged();
    expect(useCodeStore.getState().diffStaged).toBe(false);
  });
});

describe("tree deltas from the watcher", () => {
  const before = (): CodeEntry[] => useCodeStore.getState().project?.tree.entries ?? [];

  it("an added entry that changes nothing visible keeps the array reference", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    mocks.rescan.mockResolvedValueOnce({
      entries: [{ path: "a.ts", name: "a.ts", isDir: false, size: 1 }],
      truncated: false,
    });
    await useCodeStore.getState().rescan();
    const entries = before();
    useCodeStore.getState().applyTreeDelta({
      added: [{ path: "a.ts", name: "a.ts", isDir: false, size: 1 }],
      removed: [],
    });
    expect(before()).toBe(entries);
  });

  it("a new file lands in the tree and schedules a git refresh", async () => {
    vi.useFakeTimers();
    await useCodeStore.getState().openProject("/repo-a");
    mocks.gitStatus.mockClear();
    useCodeStore.getState().applyTreeDelta({
      added: [{ path: "new.ts", name: "new.ts", isDir: false, size: 0 }],
      removed: [],
    });
    expect(before().map((e) => e.path)).toEqual(["new.ts"]);
    expect(mocks.gitStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.gitStatus).toHaveBeenCalledTimes(1);
  });

  it("a burst of deltas produces one git read", async () => {
    vi.useFakeTimers();
    await useCodeStore.getState().openProject("/repo-a");
    mocks.gitStatus.mockClear();
    for (let i = 0; i < 5; i++) {
      useCodeStore.getState().applyTreeDelta({
        added: [{ path: `f${i}.ts`, name: `f${i}.ts`, isDir: false, size: 0 }],
        removed: [],
      });
    }
    await vi.advanceTimersByTimeAsync(299);
    expect(mocks.gitStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.gitStatus).toHaveBeenCalledTimes(1);
  });

  it("with no project a delta is dropped", () => {
    useCodeStore.getState().applyTreeDelta({
      added: [{ path: "a.ts", name: "a.ts", isDir: false, size: 0 }],
      removed: [],
    });
    expect(useCodeStore.getState().project).toBeNull();
  });
});

describe("jumping and going back", () => {
  it("records where the caret was and asks the editor to place it at the target", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    registerEditor("src/a.ts", "one\ntwo\nthree\n");
    await useCodeStore.getState().navigateTo("src/b.ts", { line: 2, character: 1 });
    expect(useCodeStore.getState().navBack).toEqual([
      { path: "src/a.ts", position: { line: 0, character: 0 } },
    ]);
    expect(useCodeStore.getState().jump).toEqual({
      path: "src/b.ts",
      position: { line: 2, character: 1 },
    });
  });

  it("a jump to the caret's own position is not a jump", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    registerEditor("src/a.ts");
    mocks.readFile.mockClear();
    await useCodeStore.getState().navigateTo("src/a.ts", { line: 0, character: 0 });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(useCodeStore.getState().navBack).toEqual([]);
    expect(useCodeStore.getState().jump).toBeNull();
  });

  it("with no editor the jump still opens the file, without a history entry", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().navigateTo("src/b.ts", { line: 1, character: 0 });
    expect(useCodeStore.getState().activePath).toBe("src/b.ts");
    expect(useCodeStore.getState().navBack).toEqual([]);
    expect(useCodeStore.getState().jump).not.toBeNull();
  });

  it("going back with an empty history says so", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    expect(await useCodeStore.getState().goBack()).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith("没有可返回的位置");
  });

  it("going back reopens the origin and drops it from the history", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().openFile("src/a.ts");
    registerEditor("src/a.ts");
    await useCodeStore.getState().navigateTo("src/b.ts", { line: 2, character: 1 });
    unregisterCodeEditor(handle!);
    handle = null;
    expect(await useCodeStore.getState().goBack()).toBe(true);
    expect(useCodeStore.getState().activePath).toBe("src/a.ts");
    expect(useCodeStore.getState().navBack).toEqual([]);
    expect(useCodeStore.getState().jump).toEqual({
      path: "src/a.ts",
      position: { line: 0, character: 0 },
    });
  });

  it("a failed reopen keeps the origin so the next press retries", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.setState({
      navBack: [{ path: "src/gone.ts", position: { line: 0, character: 0 } }],
    });
    mocks.readFile.mockRejectedValueOnce(new Error("ENOENT"));
    expect(await useCodeStore.getState().goBack()).toBe(false);
    expect(useCodeStore.getState().navBack).toHaveLength(1);
  });

  it("a jump that ran while the target opened keeps the newer history", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.setState({ navBack: [{ path: "src/a.ts", position: { line: 0, character: 0 } }] });
    let release: (f: CodeFile) => void = () => {};
    mocks.readFile.mockImplementationOnce(() => new Promise<CodeFile>((r) => (release = r)));
    const back = useCodeStore.getState().goBack();
    await flush();
    // A newer origin lands while the reopen is in flight.
    useCodeStore.setState({
      navBack: [
        { path: "src/a.ts", position: { line: 0, character: 0 } },
        { path: "src/c.ts", position: { line: 5, character: 0 } },
      ],
    });
    release(file("src/a.ts"));
    expect(await back).toBe(false);
    expect(useCodeStore.getState().navBack).toHaveLength(2);
  });
});

describe("the terminal drawer", () => {
  it("without a project nothing is spawned", async () => {
    await useCodeStore.getState().openTerminal();
    expect(mocks.termOpen).not.toHaveBeenCalled();
  });

  it("opening with a live shell only reveals the drawer", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.setState({
      terminals: [{ id: 4, title: "zsh", exited: false }],
      activeTermId: null,
    });
    await useCodeStore.getState().openTerminal();
    expect(mocks.termOpen).not.toHaveBeenCalled();
    expect(useCodeStore.getState()).toMatchObject({ termOpen: true, activeTermId: 4 });
  });

  it("opening with only exited shells spawns a fresh one", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.setState({
      terminals: [{ id: 4, title: "zsh", exited: true }],
      activeTermId: 4,
    });
    await useCodeStore.getState().openTerminal();
    expect(mocks.termOpen).toHaveBeenCalledWith("/repo-a", 80, 24);
    expect(useCodeStore.getState().terminals.map((t) => t.id)).toEqual([4, 1]);
    expect(useCodeStore.getState().activeTermId).toBe(1);
  });

  it("a new shell gets a numbered title and becomes the active tab", async () => {
    mocks.termOpen
      .mockResolvedValueOnce({ termId: 1, title: "zsh" })
      .mockResolvedValueOnce({ termId: 2, title: "zsh" });
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().spawnTerminal();
    await useCodeStore.getState().spawnTerminal();
    expect(useCodeStore.getState().terminals.map((t) => t.title)).toEqual(["zsh", "zsh 2"]);
    expect(useCodeStore.getState().activeTermId).toBe(2);
    expect(useCodeStore.getState().termOpen).toBe(true);
  });

  it("a spawn failure is reported and leaves no tab", async () => {
    mocks.termOpen.mockRejectedValueOnce(new Error("no shell"));
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().spawnTerminal();
    expect(useCodeStore.getState().terminals).toEqual([]);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("no shell"));
  });

  it("closing the last shell closes the drawer; closing a background one keeps the focus", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.setState({
      termOpen: true,
      terminals: [
        { id: 1, title: "zsh", exited: false },
        { id: 2, title: "zsh 2", exited: false },
      ],
      activeTermId: 2,
    });
    await useCodeStore.getState().closeTerminal(1);
    expect(useCodeStore.getState().activeTermId).toBe(2);
    expect(mocks.disposeTerminal).toHaveBeenCalledWith(1);
    expect(mocks.termClose).toHaveBeenCalledWith(1);
    await useCodeStore.getState().closeTerminal(2);
    expect(useCodeStore.getState().termOpen).toBe(false);
    expect(useCodeStore.getState().terminals).toEqual([]);
  });

  it("closing an unknown shell does nothing", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().closeTerminal(99);
    expect(mocks.termClose).not.toHaveBeenCalled();
  });

  it("the exit event marks the shell without closing its tab", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().spawnTerminal();
    const exit = mocks.listeners.get("term-exit");
    expect(exit).toBeDefined();
    exit?.({ payload: { termId: 1, exitCode: 0 } });
    expect(useCodeStore.getState().terminals).toEqual([{ id: 1, title: "zsh", exited: true }]);
  });

  it("opening an empty drawer is a request for a shell", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    useCodeStore.getState().setTermOpen(true);
    await vi.waitFor(() => expect(mocks.termOpen).toHaveBeenCalledTimes(1));
  });

  it("opening a drawer that has tabs just reveals it", async () => {
    useCodeStore.setState({
      terminals: [{ id: 3, title: "zsh", exited: false }],
      activeTermId: null,
    });
    useCodeStore.getState().setTermOpen(true);
    expect(useCodeStore.getState()).toMatchObject({ termOpen: true, activeTermId: 3 });
    expect(mocks.termOpen).not.toHaveBeenCalled();
    useCodeStore.getState().setTermOpen(false);
    expect(useCodeStore.getState().termOpen).toBe(false);
  });

  it("restarting closes the active shell and spawns a new one", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().spawnTerminal();
    mocks.termOpen.mockResolvedValueOnce({ termId: 2, title: "zsh" });
    await useCodeStore.getState().restartTerminal();
    expect(mocks.termClose).toHaveBeenCalledWith(1);
    expect(useCodeStore.getState().terminals.map((t) => t.id)).toEqual([2]);
    expect(useCodeStore.getState().activeTermId).toBe(2);
  });

  it("closing the project drops the shells", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    await useCodeStore.getState().spawnTerminal();
    await useCodeStore.getState().closeProject();
    expect(useCodeStore.getState().terminals).toEqual([]);
    expect(useCodeStore.getState().activeTermId).toBeNull();
    expect(mocks.termCloseAll).toHaveBeenCalled();
  });
});

describe("rescanning", () => {
  it("swaps in the fresh tree and re-reads the git status", async () => {
    await useCodeStore.getState().openProject("/repo-a");
    mocks.rescan.mockResolvedValueOnce({
      entries: [{ path: "b.ts", name: "b.ts", isDir: false, size: 3 }],
      truncated: true,
    });
    mocks.gitStatus.mockClear();
    await useCodeStore.getState().rescan();
    expect(useCodeStore.getState().project?.tree).toEqual({
      entries: [{ path: "b.ts", name: "b.ts", isDir: false, size: 3 }],
      truncated: true,
    });
    expect(mocks.gitStatus).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a project", async () => {
    await useCodeStore.getState().rescan();
    expect(mocks.rescan).not.toHaveBeenCalled();
  });
});

describe("the remaining one-line setters", () => {
  it("the tree, problems and terminal toggles write their own flag", () => {
    useCodeStore.getState().setTreeOpen(true);
    useCodeStore.getState().setProblemsOpen(true);
    expect(useCodeStore.getState()).toMatchObject({ treeOpen: true, problemsOpen: true });
    useCodeStore.getState().setTreeOpen(false);
    useCodeStore.getState().setProblemsOpen(false);
    expect(useCodeStore.getState()).toMatchObject({ treeOpen: false, problemsOpen: false });
  });

  it("a jump request is consumed exactly once", () => {
    useCodeStore.setState({ jump: { path: "src/a.ts", position: { line: 0, character: 0 } } });
    useCodeStore.getState().clearJump();
    expect(useCodeStore.getState().jump).toBeNull();
  });

  it("the reference list is replaced, null included", () => {
    useCodeStore
      .getState()
      .setReferences([{ path: "src/a.ts", position: { line: 1, character: 0 }, external: false }]);
    expect(useCodeStore.getState().references).toHaveLength(1);
    useCodeStore.getState().setReferences(null);
    expect(useCodeStore.getState().references).toBeNull();
  });

  it("choosing a terminal tab opens the drawer on it", () => {
    useCodeStore.getState().setActiveTerminal(7);
    expect(useCodeStore.getState()).toMatchObject({ activeTermId: 7, termOpen: true });
  });

  it("an exit event for an unknown shell leaves the tabs alone", () => {
    const tabs = [{ id: 1, title: "zsh", exited: false }];
    useCodeStore.setState({ terminals: tabs });
    useCodeStore.getState().markTermExited(99);
    expect(useCodeStore.getState().terminals).toEqual(tabs);
  });

  it("a git refresh with no project does nothing", async () => {
    await useCodeStore.getState().refreshGit();
    expect(mocks.gitStatus).not.toHaveBeenCalled();
    expect(useCodeStore.getState().gitRev).toBe(0);
  });
});
