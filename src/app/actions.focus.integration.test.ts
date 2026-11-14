// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeVault } from "@/test/fakeVault";
import { setConfigSnapshot, useAppStore } from "@/state/appStore";

/**
 * The command-level seams around the editor: which single writer applies the
 * theme, which focus state is left alone, and the link panel's "the document
 * was replaced" proof. Each of these is a rule the UI cannot enforce on its
 * own, so they are asserted here rather than in a component test.
 */

const editorMock = vi.hoisted(() => ({
  view: null as unknown,
  editors: [] as unknown[],
  edits: [] as unknown[],
}));
const vimMock = vi.hoisted(() => ({
  loadVimrc: vi.fn<() => Promise<{ keys: string; to: string }[]>>(async () => []),
}));
const snippetsMock = vi.hoisted(() => ({
  applySnippetsEnabled: vi.fn(),
  snippetLoader: { load: vi.fn(async () => ({ status: "builtin" })) },
}));
const latexMock = vi.hoisted(() => ({ configureLatexSuite: vi.fn() }));
const livePreviewMock = vi.hoisted(() => ({
  configureLivePreview: vi.fn(),
  reconfigureLivePreview: vi.fn(),
}));
const setupMock = vi.hoisted(() => ({
  reconfigureTypewriter: vi.fn(),
  reconfigureVim: vi.fn(),
  loadDocument: vi.fn(),
}));

vi.mock("@/editor/api", () => ({
  getView: () => editorMock.view,
  activeEditors: () => editorMock.editors,
}));
vi.mock("@/editor/ops", () => ({
  insertWikilinkText: (view: unknown, text: string) => editorMock.edits.push({ view, text }),
  wikilinkTargetOnLine: () => null,
}));
vi.mock("@/editor/vim/loader", () => ({ loadVimrc: vimMock.loadVimrc }));
vi.mock("@/editor/snippets/load", () => ({
  applySnippetsEnabled: snippetsMock.applySnippetsEnabled,
  snippetLoader: snippetsMock.snippetLoader,
}));
vi.mock("@/editor/snippets/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/snippets/config")>();
  return { ...actual, configureLatexSuite: latexMock.configureLatexSuite };
});
vi.mock("@/editor/livePreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/livePreview")>();
  return { ...actual, configureLivePreview: livePreviewMock.configureLivePreview };
});
vi.mock("@/editor/setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/setup")>();
  return {
    ...actual,
    reconfigureLivePreview: livePreviewMock.reconfigureLivePreview,
    reconfigureTypewriter: setupMock.reconfigureTypewriter,
    reconfigureVim: setupMock.reconfigureVim,
    loadDocument: setupMock.loadDocument,
  };
});
vi.mock("@/editor/loadedFile", () => ({ loadedFile: { current: null } }));
vi.mock("@/editor/cursorMemory", () => ({
  flushCursorSave: () => {
    flushCalls.push("flush");
  },
  restoreSavedCursor: () => {},
}));
vi.mock("@/editor/jsonDocument", () => ({ saveJsonFile: vi.fn(async () => {}) }));
vi.mock("@/daily/links", () => ({
  ensureLinks: async () => ({ forFile: () => [] }),
  flushLinksPersist: () => {},
}));
vi.mock("@/footprint/store", () => ({
  ensureFootprints: async () => undefined,
  flushFootprintsPersist: () => {},
}));
vi.mock("@/study/annotationMigration", () => ({ migrateLegacyAnnotations: async () => undefined }));
vi.mock("@/commands/keybindingOverrides", () => ({ loadKeymap: async () => undefined }));
vi.mock("@/templates/template", () => ({
  normalizeTemplateDir: (p: string) => p,
  renderTemplate: (text: string) => text,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

const flushCalls: string[] = [];

import {
  applySettingsToEditor,
  goBackLink,
  insertPickedLink,
  linkShortcut,
  newNote,
  reloadSnippetsFromVault,
  restoreEditorFocus,
  switchRecentVault,
} from "./actions";

function resetStore(): void {
  setConfigSnapshot({});
  useAppStore.setState({
    vaultPath: null,
    vaultName: "",
    tree: [],
    flatFiles: [],
    flatAssets: [],
    folders: [],
    recentFiles: [],
    currentFile: null,
    dirty: false,
    toast: null,
    modal: null,
    mode: "notes",
    linkBack: [],
    linkSuggest: null,
    sidebarOpen: true,
  });
}

function fakeView(connected = true) {
  return {
    dom: { isConnected: connected },
    state: { doc: { toString: () => "" } },
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
}

beforeEach(() => {
  resetStore();
  editorMock.view = null;
  editorMock.editors = [];
  editorMock.edits = [];
  flushCalls.length = 0;
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--editor-font-size");
  vi.clearAllMocks();
  fakeVault.reset();
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("applySettingsToEditor: the theme has one writer", () => {
  it("writes the data-theme attribute and the anti-flash localStorage copy", async () => {
    useAppStore.getState().patchSettings({ theme: "light" });
    await applySettingsToEditor();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("bnote.theme")).toBe("light");
  });

  it("dark removes the attribute and records the choice", async () => {
    document.documentElement.dataset.theme = "light";
    useAppStore.getState().patchSettings({ theme: "dark" });
    await applySettingsToEditor();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("bnote.theme")).toBe("dark");
  });

  it("the font size is published as a CSS variable", async () => {
    useAppStore.getState().patchSettings({ fontSize: 19 });
    await applySettingsToEditor();
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("19px");
  });

  it("with no live editor it stops after the document-level settings", async () => {
    await applySettingsToEditor();
    expect(snippetsMock.applySnippetsEnabled).not.toHaveBeenCalled();
    expect(latexMock.configureLatexSuite).not.toHaveBeenCalled();
  });

  it("every connected editor is reconfigured (the project view runs several)", async () => {
    const first = fakeView();
    const second = fakeView();
    editorMock.editors = [first, second, fakeView(false)];
    useAppStore.getState().patchSettings({ vim: false, livePreview: true, typewriter: true });

    await applySettingsToEditor();

    expect(livePreviewMock.reconfigureLivePreview).toHaveBeenCalledTimes(2);
    expect(setupMock.reconfigureTypewriter).toHaveBeenCalledTimes(2);
    expect(setupMock.reconfigureVim).toHaveBeenCalledTimes(2);
    expect(livePreviewMock.reconfigureLivePreview).toHaveBeenCalledWith(first, true);
    expect(setupMock.reconfigureTypewriter).toHaveBeenCalledWith(second, true);
  });

  it("vim on loads the vimrc once and hands the mappings to every view", async () => {
    const mappings = [{ keys: "jk", to: "<Esc>" }];
    vimMock.loadVimrc.mockResolvedValue(mappings);
    const view = fakeView();
    editorMock.editors = [view];
    useAppStore.getState().patchSettings({ vim: true });

    await applySettingsToEditor();

    expect(vimMock.loadVimrc).toHaveBeenCalledTimes(1);
    expect(setupMock.reconfigureVim).toHaveBeenCalledWith(view, true, mappings);
  });

  it("a failed vimrc load falls back to the default mappings instead of failing the settings save", async () => {
    vimMock.loadVimrc.mockRejectedValue("no vimrc");
    const view = fakeView();
    editorMock.editors = [view];
    useAppStore.getState().patchSettings({ vim: true });

    await applySettingsToEditor();

    expect(setupMock.reconfigureVim).toHaveBeenCalledWith(view, true, []);
  });

  it("a target view that is no longer connected is not reconfigured", async () => {
    await applySettingsToEditor(fakeView(false) as never);
    expect(livePreviewMock.reconfigureLivePreview).not.toHaveBeenCalled();
  });

  it("a connected target view is the only one reconfigured", async () => {
    const target = fakeView();
    editorMock.editors = [fakeView()];
    await applySettingsToEditor(target as never);
    expect(livePreviewMock.reconfigureLivePreview).toHaveBeenCalledTimes(1);
    expect(livePreviewMock.reconfigureLivePreview).toHaveBeenCalledWith(target, true);
  });
});

describe("restoreEditorFocus", () => {
  it("focuses the editor when the focus fell back to <body>", () => {
    const view = fakeView();
    editorMock.view = view;
    document.body.focus();

    restoreEditorFocus();

    expect(view.focus).toHaveBeenCalledTimes(1);
  });

  it("never yanks the focus out of an open modal", () => {
    const view = fakeView();
    editorMock.view = view;
    useAppStore.setState({ modal: "settings" });

    restoreEditorFocus();

    expect(view.focus).not.toHaveBeenCalled();
  });

  it("never yanks the focus out of a focused input", () => {
    const view = fakeView();
    editorMock.view = view;
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    restoreEditorFocus();

    expect(view.focus).not.toHaveBeenCalled();
    input.remove();
  });
});

describe("linkShortcut", () => {
  it("asks for a note first when nothing is open", () => {
    const view = fakeView();
    linkShortcut(view as never);
    expect(useAppStore.getState().toast).toBe("先打开一篇笔记，再插入链接");
  });

  it("does nothing while a modal owns the foreground", () => {
    useAppStore.setState({ currentFile: "/v/a.md", modal: "palette" });
    const view = fakeView();
    linkShortcut(view as never);
    expect(useAppStore.getState().linkSuggest).toBeNull();
  });

  it("pressing again collapses an open panel instead of opening another", () => {
    useAppStore.setState({
      currentFile: "/v/a.md",
      linkSuggest: { left: 0, top: 0, bottom: 0 },
    });
    linkShortcut(fakeView() as never);
    expect(useAppStore.getState().linkSuggest).toBeNull();
  });
});

describe("insertPickedLink", () => {
  it("writes the wikilink only when the document is unchanged since the panel opened", () => {
    const view = {
      state: { doc: { toString: () => "" } },
      dispatch: vi.fn(),
      focus: vi.fn(),
    };
    editorMock.view = view;
    useAppStore.setState({
      flatFiles: ["a.md"],
      currentFile: "/v/a.md",
      linkSuggest: { left: 0, top: 0, bottom: 0 },
    });

    // The state was never captured (no linkShortcut ran), so the write is
    // dropped instead of landing on an unknown document.
    insertPickedLink("a.md");

    expect(editorMock.edits).toEqual([]);
    expect(useAppStore.getState().linkSuggest).toBeNull();
  });
});

describe("goBackLink", () => {
  it("explains that there is nothing to go back to", () => {
    goBackLink();
    expect(useAppStore.getState().toast).toBe("没有可回退的链接跳转");
  });
});

describe("reloadSnippetsFromVault", () => {
  it("returns null without a vault (nothing to load)", async () => {
    expect(await reloadSnippetsFromVault()).toBeNull();
    expect(snippetsMock.snippetLoader.load).not.toHaveBeenCalled();
  });

  it("loads the vault snippets.js when it exists", async () => {
    const info = await fakeVault.api.setVault("/fake/vault");
    useAppStore.getState().setVault(info);
    fakeVault.seed({ ".bnote/snippets.js": "export const a = 1" });
    snippetsMock.snippetLoader.load.mockResolvedValue({ status: "vault" });

    const outcome = await reloadSnippetsFromVault();

    expect(outcome).toMatchObject({ status: "vault" });
    expect(snippetsMock.snippetLoader.load).toHaveBeenCalledWith("export const a = 1", true);
  });

  it("a read failure falls back to the builtin snippets and still reports an outcome", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = await fakeVault.api.setVault("/fake/vault");
    useAppStore.getState().setVault(info);
    fakeVault.failNext("readVaultFile", "ENOENT");
    snippetsMock.snippetLoader.load.mockResolvedValue({ status: "builtin" });

    const outcome = await reloadSnippetsFromVault();

    expect(outcome).toMatchObject({ status: "builtin" });
    expect(snippetsMock.snippetLoader.load).toHaveBeenCalledWith(null, true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("applySettingsToEditor: the document-wide switches", () => {
  it("with an editor open, every document-wide switch is applied once", async () => {
    editorMock.editors = [fakeView()];
    useAppStore.getState().patchSettings({ snippets: false, mathPreview: false });

    await applySettingsToEditor();

    expect(snippetsMock.applySnippetsEnabled).toHaveBeenCalledWith(false);
    expect(livePreviewMock.configureLivePreview).toHaveBeenCalledWith({ mathPreview: false });
    expect(latexMock.configureLatexSuite).toHaveBeenCalledWith(
      useAppStore.getState().settings.latex,
    );
  });
});

describe("newNote", () => {
  it("does nothing without an open vault", async () => {
    await newNote();
    expect(fakeVault.writes).toEqual([]);
  });

  it("creates the note next to the current one", async () => {
    fakeVault.seed({ "dir/a.md": "a" });
    const info = await fakeVault.api.setVault("/fake/vault");
    useAppStore.getState().setVault(info);
    useAppStore.setState({ currentFile: "/fake/vault/dir/a.md" });

    await newNote();

    expect(fakeVault.exists("dir/Untitled.md")).toBe(true);
  });
});

describe("switchRecentVault", () => {
  it("refuses while a canvas session is open (the drawing would lose its fill-back)", async () => {
    useAppStore.setState({
      vaultPath: "/a",
      drawingSession: { path: "/a/d.excalidraw", isNew: true, originNote: "/a/n.md", originPos: 0 },
    });
    setConfigSnapshot({ recentVaults: ["/b", "/a"] });

    await switchRecentVault();

    expect(useAppStore.getState().toast).toContain("画布还没收尾");
    expect(useAppStore.getState().vaultPath).toBe("/a");
  });

  it("explains that there is no other vault", async () => {
    useAppStore.setState({ vaultPath: "/a", drawingSession: null, toast: null });
    setConfigSnapshot({ recentVaults: ["/a"] });

    await switchRecentVault();

    expect(useAppStore.getState().toast).toBe("没有其他最近打开的仓库");
  });
});
