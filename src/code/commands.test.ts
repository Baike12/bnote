import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";

/**
 * The commands of the code pane.
 *
 * A command is the single entry point both the palette and the keybinding use,
 * so what it does when it runs is user-visible behavior. The rules locked here
 * are the ones a refactor breaks silently: an explicit open records the recent
 * project (deduped, capped) and enters code mode; the tab cycle wraps; the
 * problem cycle starts from the caret, not from the file's first diagnostic;
 * vim/wrap toggles pin the value they claim to flip.
 */

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  gotoDefinition: vi.fn(),
  findReferences: vi.fn(),
  renameSymbol: vi.fn(),
  activeCodeEditor: vi.fn(),
  requestCodeUi: vi.fn(),
  startCompletion: vi.fn(),
  peekVimVisual: vi.fn(),
  setActiveKeyRegion: vi.fn(),
  dialogOpen: vi.fn(),
  lspStop: vi.fn(),
  gitStage: vi.fn(),
  gitUnstage: vi.fn(),
  toast: vi.fn(),
  recent: [] as string[],
  setRecentCodeProjects: vi.fn(),
  setMode: vi.fn(),
  patchSettings: vi.fn(),
  settings: { vim: false, codeVim: "inherit", codeWrap: true },
}));

vi.mock("./store", () => ({ useCodeStore: { getState: () => mocks.state } }));
vi.mock("./editor/goto", () => ({
  gotoDefinition: mocks.gotoDefinition,
  findReferences: mocks.findReferences,
  renameSymbol: mocks.renameSymbol,
}));
vi.mock("./editor/registry", () => ({ activeCodeEditor: mocks.activeCodeEditor }));
vi.mock("./ui", () => ({ requestCodeUi: mocks.requestCodeUi }));
vi.mock("@codemirror/autocomplete", () => ({ startCompletion: mocks.startCompletion }));
vi.mock("@/editor/vim/vim", () => ({ peekVimVisual: mocks.peekVimVisual }));
vi.mock("@/commands/globalKeys", () => ({ setActiveKeyRegion: mocks.setActiveKeyRegion }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.dialogOpen }));
vi.mock("./api", () => ({
  codeApi: {
    lspStop: mocks.lspStop,
    gitStage: mocks.gitStage,
    gitUnstage: mocks.gitUnstage,
  },
}));
vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({
      showToast: mocks.toast,
      recentCodeProjects: mocks.recent,
      setRecentCodeProjects: mocks.setRecentCodeProjects,
      setMode: mocks.setMode,
      patchSettings: mocks.patchSettings,
      settings: mocks.settings,
    }),
  },
}));

import {
  codeCommandDefs,
  confirmRename,
  focusCodeContent,
  openProjectAt,
  openProjectDialog,
  quoteCodeSelection,
  restoreCodeProject,
} from "./commands";
import type { CodeState } from "./store";
import type { CommandDef } from "@/commands/registry";

function command(id: string): CommandDef {
  const def = codeCommandDefs.find((d) => d.id === id);
  if (!def) throw new Error(`missing command ${id}`);
  return def;
}

function run(id: string): unknown {
  return command(id).run();
}

/** A fresh store snapshot per test; actions are spies the test can inspect. */
function resetState(over: Record<string, unknown> = {}): void {
  mocks.state = {
    project: { root: "/repo", name: "repo" },
    activePath: "src/a.ts",
    tabs: ["src/a.ts", "src/b.ts", "src/c.ts"],
    diagnostics: {},
    treeOpen: false,
    problemsOpen: false,
    diffOpen: false,
    diffStaged: false,
    termOpen: false,
    terminals: [],
    files: {},
    lspStates: {},
    openProject: vi.fn(async () => {}),
    closeProject: vi.fn(async () => {}),
    goBack: vi.fn(async () => true),
    saveFile: vi.fn(async () => {}),
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    navigateTo: vi.fn(async () => {}),
    refreshGit: vi.fn(async () => {}),
    setTreeOpen: vi.fn(),
    setProblemsOpen: vi.fn(),
    setTermOpen: vi.fn(),
    setDiff: vi.fn(),
    expandTo: vi.fn(),
    requestTreeFocus: vi.fn(),
    spawnTerminal: vi.fn(async () => {}),
    setLspState: vi.fn(),
    ...over,
  };
}

function editor(
  doc = "const a = 1;\nconst b = 2;\n",
  selection?: { anchor: number; head: number },
) {
  const state = EditorState.create({ doc, selection });
  const handle = {
    root: "/repo",
    path: "src/a.ts",
    language: "typescript",
    view: { state, focus: vi.fn(), dom: { isConnected: true } },
  };
  mocks.activeCodeEditor.mockReturnValue(handle);
  return handle;
}

beforeEach(() => {
  resetState();
  for (const fn of [
    mocks.gotoDefinition,
    mocks.findReferences,
    mocks.renameSymbol,
    mocks.activeCodeEditor,
    mocks.requestCodeUi,
    mocks.startCompletion,
    mocks.peekVimVisual,
    mocks.setActiveKeyRegion,
    mocks.dialogOpen,
    mocks.lspStop,
    mocks.gitStage,
    mocks.gitUnstage,
    mocks.toast,
    mocks.setRecentCodeProjects,
    mocks.setMode,
    mocks.patchSettings,
  ]) {
    fn.mockReset();
  }
  mocks.settings = { vim: false, codeVim: "inherit", codeWrap: true };
  mocks.activeCodeEditor.mockReturnValue(null);
  mocks.peekVimVisual.mockReturnValue(null);
  mocks.dialogOpen.mockResolvedValue(null);
  mocks.lspStop.mockResolvedValue(undefined);
  mocks.gitStage.mockResolvedValue(undefined);
  mocks.gitUnstage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the command table", () => {
  it("every id is unique and every command has a title", () => {
    const ids = codeCommandDefs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of codeCommandDefs) {
      expect(def.title.length, def.id).toBeGreaterThan(0);
      expect(def.category).toBe("代码");
    }
  });

  it("commands that need a project are unavailable without one", () => {
    resetState({ project: null });
    for (const id of ["code.lsp-restart", "code.close-project", "code.toggle-tree"]) {
      expect(command(id).when?.(), id).toBe(false);
    }
  });

  it("commands that need a file are unavailable without an open tab", () => {
    resetState({ project: null });
    for (const id of ["code.go-to-definition", "code.find-references", "code.save-file"]) {
      expect(command(id).when?.(), id).toBe(false);
    }
  });
});

describe("opening a project", () => {
  it("a picked folder opens, is recorded first and enters code mode", async () => {
    mocks.dialogOpen.mockResolvedValue("/new/repo");
    resetState({ project: null });
    await openProjectDialog();
    expect(mocks.state.openProject).toHaveBeenCalledWith("/new/repo");
    expect(mocks.setRecentCodeProjects).toHaveBeenCalledWith(["/new/repo"]);
    expect(mocks.setMode).toHaveBeenCalledWith("code");
  });

  it("a cancelled picker does nothing", async () => {
    mocks.dialogOpen.mockResolvedValue(null);
    await openProjectDialog();
    expect(mocks.state.openProject).not.toHaveBeenCalled();
  });

  it("the dialog asks for a directory", async () => {
    mocks.dialogOpen.mockResolvedValue(null);
    await openProjectDialog();
    expect(mocks.dialogOpen).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  });

  it("the recent list moves the project to the front, dedupes and keeps ten", async () => {
    mocks.recent = ["/old", "/repo"];
    mocks.dialogOpen.mockResolvedValue("/repo");
    await openProjectDialog();
    expect(mocks.setRecentCodeProjects).toHaveBeenCalledWith(["/repo", "/old"]);
  });

  it("the recent list is capped at ten entries", async () => {
    mocks.recent = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    mocks.dialogOpen.mockResolvedValue("/new");
    await openProjectDialog();
    const kept = mocks.setRecentCodeProjects.mock.calls[0][0] as string[];
    expect(kept).toHaveLength(10);
    expect(kept[0]).toBe("/new");
    expect(kept).not.toContain("/p9");
  });

  it("a failed open is reported and not recorded", async () => {
    resetState({ openProject: vi.fn(async () => Promise.reject(new Error("moved"))) });
    expect(await openProjectAt("/gone")).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("moved"));
    expect(mocks.setRecentCodeProjects).not.toHaveBeenCalled();
    expect(mocks.setMode).not.toHaveBeenCalled();
  });

  it("restoring a project at startup does not switch modes", async () => {
    await restoreCodeProject("/repo");
    expect(mocks.state.openProject).toHaveBeenCalledWith("/repo");
    expect(mocks.setMode).not.toHaveBeenCalled();
  });

  it("a moved repository is swallowed on restore: the empty state offers the recent list", async () => {
    resetState({ openProject: vi.fn(async () => Promise.reject(new Error("gone"))) });
    await expect(restoreCodeProject("/gone")).resolves.toBeUndefined();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe("the pane toggles", () => {
  it("the tree, problems and terminal toggles flip the current value", () => {
    resetState({ treeOpen: true, problemsOpen: false, termOpen: true });
    run("code.toggle-tree");
    run("code.toggle-problems");
    run("code.toggle-terminal");
    expect(mocks.state.setTreeOpen).toHaveBeenCalledWith(false);
    expect(mocks.state.setProblemsOpen).toHaveBeenCalledWith(true);
    expect(mocks.state.setTermOpen).toHaveBeenCalledWith(false);
  });

  it("focusing the tree opens it, expands to the active file and asks for the row", () => {
    run("code.focus-tree");
    expect(mocks.state.setTreeOpen).toHaveBeenCalledWith(true);
    expect(mocks.state.expandTo).toHaveBeenCalledWith("src/a.ts");
    expect(mocks.state.requestTreeFocus).toHaveBeenCalledWith("src/a.ts");
  });

  it("with no active file the tree focus lands on the first row", () => {
    resetState({ activePath: null });
    run("code.focus-tree");
    expect(mocks.state.expandTo).not.toHaveBeenCalled();
    expect(mocks.state.requestTreeFocus).toHaveBeenCalledWith(null);
  });

  it("the diff pane is toggled from the current state", () => {
    resetState({ diffOpen: true });
    run("code.git-diff");
    expect(mocks.state.setDiff).toHaveBeenCalledWith(false);
  });
});

describe("the jump commands", () => {
  it("definition, type definition and implementation ask different LSP methods", () => {
    run("code.go-to-definition");
    run("code.go-to-type-definition");
    run("code.go-to-implementation");
    expect(mocks.gotoDefinition.mock.calls.map((c) => c[0])).toEqual([
      "textDocument/definition",
      "textDocument/typeDefinition",
      "textDocument/implementation",
    ]);
  });

  it("references, rename and go-back delegate to their action", () => {
    run("code.find-references");
    run("code.rename-symbol");
    run("code.go-back");
    expect(mocks.findReferences).toHaveBeenCalledTimes(1);
    expect(mocks.requestCodeUi).toHaveBeenCalledWith({ kind: "rename" });
    expect(mocks.state.goBack).toHaveBeenCalledTimes(1);
  });

  it("quick open and find-in-files go through the panel request channel", () => {
    run("code.quick-open");
    run("code.find-in-files");
    expect(mocks.requestCodeUi).toHaveBeenCalledWith({ kind: "quick-open" });
    expect(mocks.requestCodeUi).toHaveBeenCalledWith({ kind: "find-in-files" });
  });

  it("triggering completion starts it on the editor's view and focuses the editor", () => {
    const handle = editor();
    run("code.trigger-completion");
    expect(mocks.startCompletion).toHaveBeenCalledWith(handle.view);
    expect(handle.view.focus).toHaveBeenCalledTimes(1);
  });

  it("triggering completion without an editor does nothing", () => {
    run("code.trigger-completion");
    expect(mocks.startCompletion).not.toHaveBeenCalled();
  });
});

describe("the tab commands", () => {
  it("next and previous wrap around the tab list", () => {
    resetState({ activePath: "src/c.ts" });
    run("code.next-tab");
    expect(mocks.state.setActiveTab).toHaveBeenLastCalledWith("src/a.ts");
    resetState({ activePath: "src/a.ts" });
    run("code.prev-tab");
    expect(mocks.state.setActiveTab).toHaveBeenLastCalledWith("src/c.ts");
  });

  it("a single tab is not a cycle", () => {
    resetState({ tabs: ["src/a.ts"], activePath: "src/a.ts" });
    run("code.next-tab");
    run("code.prev-tab");
    expect(mocks.state.setActiveTab).not.toHaveBeenCalled();
  });

  it("no active tab starts the cycle at the first (next) or the second (previous) tab", () => {
    // `indexOf(null)` is -1: the arithmetic wraps to 0 going forward and to 1
    // going backward. What matters is that it lands on a real tab instead of
    // `tabs[-1]`.
    resetState({ activePath: null });
    run("code.next-tab");
    expect(mocks.state.setActiveTab).toHaveBeenLastCalledWith("src/a.ts");
    resetState({ activePath: null });
    run("code.prev-tab");
    expect(mocks.state.setActiveTab).toHaveBeenLastCalledWith("src/b.ts");
  });
});

describe("the problem cycle", () => {
  const diagnostic = (line: number) => ({
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    severity: 1,
    code: null,
    source: null,
    message: "boom",
  });

  it("starts from the caret, so the second problem of a file is reachable", () => {
    resetState({
      diagnostics: { "src/a.ts": [diagnostic(1), diagnostic(5)], "src/b.ts": [diagnostic(0)] },
    });
    editor("a\nb\nc\nd\ne\nf\n", { anchor: 0, head: 0 });
    run("code.next-problem");
    // The caret is on line 0, so the first problem after it is line 1 — the
    // old rule always returned the file's first diagnostic.
    expect(mocks.state.navigateTo).toHaveBeenCalledWith("src/a.ts", { line: 1, character: 0 });
  });

  it("crosses to the next file when the current one has no later problem", () => {
    resetState({
      diagnostics: { "src/a.ts": [diagnostic(1)], "src/b.ts": [diagnostic(3)] },
    });
    editor("a\nb\nc\nd\ne\nf\n", { anchor: 6, head: 6 });
    run("code.next-problem");
    expect(mocks.state.navigateTo).toHaveBeenCalledWith("src/b.ts", { line: 3, character: 0 });
  });

  it("without diagnostics nothing moves", () => {
    run("code.next-problem");
    expect(mocks.state.navigateTo).not.toHaveBeenCalled();
  });

  it("with no editor the cycle falls back to the active path", () => {
    resetState({ diagnostics: { "src/a.ts": [diagnostic(1)] } });
    run("code.next-problem");
    expect(mocks.state.navigateTo).toHaveBeenCalledWith("src/a.ts", { line: 1, character: 0 });
  });
});

describe("saving and closing", () => {
  it("saves the active tab", () => {
    run("code.save-file");
    expect(mocks.state.saveFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("closes the active tab", () => {
    run("code.close-tab");
    expect(mocks.state.closeTab).toHaveBeenCalledWith("src/a.ts");
  });

  it("without an active path neither does anything", () => {
    resetState({ activePath: null });
    run("code.save-file");
    run("code.close-tab");
    expect(mocks.state.saveFile).not.toHaveBeenCalled();
    expect(mocks.state.closeTab).not.toHaveBeenCalled();
  });
});

describe("git staging", () => {
  it("stages the active file and re-reads the status", async () => {
    run("code.git-stage");
    await vi.waitFor(() => expect(mocks.state.refreshGit).toHaveBeenCalledTimes(1));
    expect(mocks.gitStage).toHaveBeenCalledWith("/repo", "src/a.ts");
  });

  it("unstages the active file and re-reads the status", async () => {
    run("code.git-unstage");
    await vi.waitFor(() => expect(mocks.state.refreshGit).toHaveBeenCalledTimes(1));
    expect(mocks.gitUnstage).toHaveBeenCalledWith("/repo", "src/a.ts");
  });
});

describe("the language server restart", () => {
  it("stops every server and clears the failed bookkeeping", async () => {
    resetState({ lspStates: { typescript: "off", python: "running" } });
    run("code.lsp-restart");
    await vi.waitFor(() => expect(mocks.state.setLspState).toHaveBeenCalledTimes(2));
    expect(mocks.lspStop).toHaveBeenCalledWith("/repo");
    expect(mocks.state.setLspState).toHaveBeenCalledWith("typescript", "");
    expect(mocks.state.setLspState).toHaveBeenCalledWith("python", "");
  });
});

describe("pinning the code editor's vim mode", () => {
  it("an inherited on becomes an explicit off", () => {
    mocks.settings = { vim: true, codeVim: "inherit", codeWrap: true };
    run("code.toggle-vim");
    expect(mocks.patchSettings).toHaveBeenCalledWith({ codeVim: "off" });
  });

  it("an inherited off becomes an explicit on", () => {
    mocks.settings = { vim: false, codeVim: "inherit", codeWrap: true };
    run("code.toggle-vim");
    expect(mocks.patchSettings).toHaveBeenCalledWith({ codeVim: "on" });
  });

  it("an explicit value flips", () => {
    mocks.settings = { vim: false, codeVim: "off", codeWrap: true };
    run("code.toggle-vim");
    expect(mocks.patchSettings).toHaveBeenCalledWith({ codeVim: "on" });
  });

  it("wrap flips the stored value", () => {
    run("code.toggle-wrap");
    expect(mocks.patchSettings).toHaveBeenCalledWith({ codeWrap: false });
  });
});

describe("focusing the content area", () => {
  it("leaves the change list, claims the region and focuses on the next frame", () => {
    const handle = editor();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      frames.push(fn);
      return 0;
    });
    resetState({ diffOpen: true });
    focusCodeContent();
    expect(mocks.state.setDiff).toHaveBeenCalledWith(false);
    expect(mocks.setActiveKeyRegion).toHaveBeenCalledWith("code");
    expect(handle.view.focus).not.toHaveBeenCalled();
    const pending = frames.shift();
    pending?.(0);
    expect(handle.view.focus).toHaveBeenCalledTimes(1);
  });

  it("a frame with no editor (bitmap, empty pane) is harmless", () => {
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      fn(0);
      return 0;
    });
    expect(() => focusCodeContent()).not.toThrow();
  });
});

describe("quoting a code selection", () => {
  it("names the file and the 1-based inclusive line range", () => {
    resetState({ files: { "src/a.ts": { languageId: "typescript" } } });
    editor("one\ntwo\nthree\nfour\n", { anchor: 4, head: 13 });
    expect(quoteCodeSelection()).toBe("src/a.ts:2-3\n```typescript\ntwo\nthree\n```\n");
  });

  it("a selection that swallowed the line break ends on the last selected character", () => {
    resetState({ files: { "src/a.ts": { languageId: "typescript" } } });
    // From "two" up to the start of "three": the end offset sits on the next
    // line's column 0, but the last selected character is still on line 2.
    editor("one\ntwo\nthree\n", { anchor: 4, head: 8 });
    expect(quoteCodeSelection()).toContain("src/a.ts:2\n");
  });

  it("the vim engine's selection is authoritative in visual mode", () => {
    resetState({ files: { "src/a.ts": { languageId: "typescript" } } });
    editor("one\ntwo\nthree\n", { anchor: 0, head: 0 });
    mocks.peekVimVisual.mockReturnValue({ text: "two\n", from: 4, to: 8 });
    expect(quoteCodeSelection()).toBe("src/a.ts:2\n```typescript\ntwo\n```\n");
  });

  it("an empty caret has nothing to quote", () => {
    editor("one\n", { anchor: 0, head: 0 });
    expect(quoteCodeSelection()).toBeNull();
  });

  it("no editor has nothing to quote", () => {
    expect(quoteCodeSelection()).toBeNull();
  });

  it("the file's languageId wins over the handle's language", () => {
    resetState({ files: { "src/a.ts": { languageId: "typescriptreact" } } });
    editor("one\ntwo\n", { anchor: 0, head: 3 });
    expect(quoteCodeSelection()).toContain("```typescriptreact\n");
  });
});

describe("confirmRename", () => {
  it("delegates to the rename action and reports its success", async () => {
    mocks.renameSymbol.mockResolvedValue(true);
    expect(await confirmRename("value")).toBe(true);
    expect(mocks.renameSymbol).toHaveBeenCalledWith("value");
    mocks.renameSymbol.mockResolvedValue(false);
    expect(await confirmRename("value")).toBe(false);
  });
});

/**
 * The type is imported only so `resetState` is checked against the store's
 * actual shape: a renamed action fails here instead of at runtime.
 */
export type _StateShape = Pick<CodeState, "openProject" | "navigateTo" | "saveFile">;

describe("the commands that only forward to an action", () => {
  it("opening a project from the palette goes through the native picker", async () => {
    run("code.open-project");
    await vi.waitFor(() => expect(mocks.dialogOpen).toHaveBeenCalledTimes(1));
  });

  it("closing the project calls the store's close", async () => {
    run("code.close-project");
    await vi.waitFor(() => expect(mocks.state.closeProject).toHaveBeenCalledTimes(1));
  });

  it("a new terminal spawns a shell without touching the drawer flag", async () => {
    run("code.new-terminal");
    await vi.waitFor(() => expect(mocks.state.spawnTerminal).toHaveBeenCalledTimes(1));
  });

  it("the previous problem asks for the diagnostic before the caret", () => {
    resetState({
      diagnostics: {
        "src/a.ts": [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
            severity: 1,
            code: null,
            source: null,
            message: "a",
          },
          {
            range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } },
            severity: 1,
            code: null,
            source: null,
            message: "b",
          },
        ],
      },
    });
    editor("a\nb\nc\nd\ne\nf\n", { anchor: 12, head: 12 });
    run("code.prev-problem");
    // The caret sits at the end of the file: the last diagnostic is the
    // nearest one before it (a single file wraps for the backward direction).
    expect(mocks.state.navigateTo).toHaveBeenCalledWith("src/a.ts", { line: 5, character: 0 });
  });
});

describe("focus availability", () => {
  it("is available while the change list covers the file, even with no editor", () => {
    resetState({ diffOpen: true });
    expect(command("code.focus-editor").when?.()).toBe(true);
  });

  it("is unavailable with neither an editor nor a change list", () => {
    resetState({ diffOpen: false });
    expect(command("code.focus-editor").when?.()).toBe(false);
  });
});
