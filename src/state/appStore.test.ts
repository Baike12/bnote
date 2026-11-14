import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ writes: [] as unknown[] }));

vi.mock("@/lib/tauri", () => ({
  api: {
    saveAppConfig: async (config: unknown) => {
      saved.writes.push(config);
    },
  },
}));

import {
  DEFAULT_SETTINGS,
  flushPersistConfig,
  getConfigSnapshot,
  hasPendingPersist,
  persistConfig,
  rememberCursorPosition,
  setConfigSnapshot,
  toggleCodeMode,
  toggleProjectsMode,
  toggleStudyMode,
  useAppStore,
} from "./appStore";

/**
 * Request semantics of "focus sidebar" (⌘I): a one-shot ticket, not a history
 * counter.
 *
 * A counter (tick++) would be read as "a freshly arrived request" whenever the
 * sidebar remounts — collapsing with ⌘\ and expanding again would steal the
 * editor's focus. A ticket resets to zero once consumed, so a remounted
 * sidebar only ever sees "no request".
 */

const request = () => useAppStore.getState().sidebarFocusRequest;

beforeEach(() => {
  flushPersistConfig();
  setConfigSnapshot({});
  saved.writes.length = 0;
  useAppStore.setState({
    sidebarOpen: false,
    sidebarFocusRequest: null,
    settings: { ...DEFAULT_SETTINGS },
    studyHistory: { pdfs: [], urls: [], weread: [] },
    studyContent: null,
    studyWereadBook: null,
    drawingSession: null,
    currentFile: null,
    recentFiles: [],
    vaultPath: null,
    mode: "notes",
    toast: null,
    renameRequest: null,
    recentCodeProjects: [],
    codeProject: null,
  });
});

afterEach(() => {
  flushPersistConfig();
  vi.useRealTimers();
});

describe("settings defaults", () => {
  it("select-to-translate is disabled by default", () => {
    expect(useAppStore.getState().settings.studyTranslate.enabled).toBe(false);
  });
});

describe("focusSidebar request", () => {
  it("on press it opens the sidebar and leaves a ticket to be consumed", () => {
    useAppStore.getState().focusSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(request()).not.toBe(null);
  });

  it("consuming resets it to zero: a remounted sidebar sees no historic request", () => {
    useAppStore.getState().focusSidebar();
    useAppStore.getState().clearSidebarFocus();
    expect(request()).toBe(null);
  });

  it("pressing again after a consume still yields a fresh ticket", () => {
    useAppStore.getState().focusSidebar();
    useAppStore.getState().clearSidebarFocus();
    useAppStore.getState().focusSidebar();
    expect(request()).not.toBe(null);
    // The ticket only carries "is there a pending request"; the number itself
    // takes no part in the decision
    expect(typeof request()).toBe("number");
  });

  it("pressing again without a consume does not lose the request", () => {
    useAppStore.getState().focusSidebar();
    const first = request();
    useAppStore.getState().focusSidebar();
    expect(request()).not.toBe(null);
    expect(request()).not.toBe(first);
  });

  it("consuming without a request is a no-op (no extra state write)", () => {
    let writes = 0;
    const unsub = useAppStore.subscribe(() => {
      writes++;
    });
    useAppStore.getState().clearSidebarFocus();
    expect(writes).toBe(0);
    unsub();
  });
});

describe("toggleSidebar (the mouse path of the top bar button)", () => {
  it("collapse→expand only opens and closes, it produces no focus ticket", () => {
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(request()).toBe(null);
  });

  it("expand→collapse does not touch the ticket either; an unconsumed ticket is not lost because of it", () => {
    useAppStore.getState().focusSidebar();
    const first = request();
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(false);
    expect(request()).toBe(first);
  });
});

/** The most recent config write (the mock records every call). */
function lastWrite(): unknown {
  return saved.writes[saved.writes.length - 1];
}

describe("persistConfig", () => {
  it("publishes the snapshot synchronously and debounces the disk write", async () => {
    vi.useFakeTimers();
    persistConfig({ lastVault: "/a" });
    expect(getConfigSnapshot()).toEqual({ lastVault: "/a" });
    expect(hasPendingPersist()).toBe(true);
    expect(saved.writes).toEqual([]);

    persistConfig({ lastVault: "/b" });
    expect(getConfigSnapshot()).toEqual({ lastVault: "/b" });

    await vi.advanceTimersByTimeAsync(300);
    expect(hasPendingPersist()).toBe(false);
    expect(saved.writes).toEqual([{ lastVault: "/b" }]);
  });

  it("a flush with nothing pending writes nothing", () => {
    flushPersistConfig();
    expect(saved.writes).toEqual([]);
  });
});

describe("rememberCursorPosition", () => {
  it("records the position and persists the merged snapshot", async () => {
    vi.useFakeTimers();
    setConfigSnapshot({ lastVault: "/v", cursorPositions: { "/v/a.md": { pos: 1, scroll: 0 } } });
    rememberCursorPosition("/v/b.md", 42, 100);

    expect(getConfigSnapshot().cursorPositions).toEqual({
      "/v/a.md": { pos: 1, scroll: 0 },
      "/v/b.md": { pos: 42, scroll: 100 },
    });
    expect(getConfigSnapshot().lastVault).toBe("/v");

    await vi.advanceTimersByTimeAsync(300);
    expect(saved.writes).toHaveLength(1);
  });

  it("an unchanged position is a no-op: no snapshot write, no persist", () => {
    setConfigSnapshot({ cursorPositions: { "/v/a.md": { pos: 5, scroll: 9 } } });
    const before = getConfigSnapshot();
    rememberCursorPosition("/v/a.md", 5, 9);
    expect(getConfigSnapshot()).toBe(before);
    expect(hasPendingPersist()).toBe(false);
  });

  it("keeps the map bounded: the oldest entry is dropped past the cap", () => {
    const cursorPositions: Record<string, { pos: number; scroll: number }> = {};
    for (let i = 0; i < 300; i++) cursorPositions[`/v/${i}.md`] = { pos: i, scroll: 0 };
    setConfigSnapshot({ cursorPositions });

    rememberCursorPosition("/v/next.md", 0, 0);

    const keys = Object.keys(getConfigSnapshot().cursorPositions ?? {});
    expect(keys).toHaveLength(300);
    expect(keys[0]).toBe("/v/1.md");
    expect(keys).toContain("/v/next.md");
  });
});

describe("study history recording", () => {
  it("records a PDF newest-first, deduplicates and persists", async () => {
    vi.useFakeTimers();
    const store = useAppStore.getState();
    store.recordStudyPdf({ path: "/v/a.pdf", relPath: "a.pdf", title: "A" });
    store.recordStudyPdf({ path: "/v/b.pdf", relPath: "b.pdf", title: "B" });
    store.recordStudyPdf({ path: "/v/a.pdf", relPath: "a.pdf", title: "A again" });

    expect(useAppStore.getState().studyHistory.pdfs.map((e) => e.path)).toEqual([
      "/v/a.pdf",
      "/v/b.pdf",
    ]);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastWrite()).toMatchObject({
      studyHistory: { pdfs: [{ path: "/v/a.pdf", title: "A again" }, { path: "/v/b.pdf" }] },
    });
  });

  it("opening the same web page again keeps the user's name", () => {
    const store = useAppStore.getState();
    store.recordStudyUrl({ url: "https://x.dev", title: "x.dev" });
    store.renameStudyUrl("https://x.dev", "我的资料");
    store.recordStudyUrl({ url: "https://x.dev", title: "x.dev" });

    const entry = useAppStore.getState().studyHistory.urls[0];
    expect(entry?.name).toBe("我的资料");
    // Fetched when it is shown: the derived title was refreshed, the name wins.
    expect(entry?.title).toBe("x.dev");
  });

  it("renaming a page updates the open page's header title as well", () => {
    const store = useAppStore.getState();
    store.recordStudyUrl({ url: "https://x.dev", title: "x.dev" });
    store.setStudyContent({ kind: "url", url: "https://x.dev", title: "x.dev" });

    store.renameStudyUrl("https://x.dev", "资料");

    expect(useAppStore.getState().studyContent).toEqual({
      kind: "url",
      url: "https://x.dev",
      title: "资料",
    });
  });

  it("renaming an unknown or unrelated URL leaves the open content alone", () => {
    const store = useAppStore.getState();
    store.setStudyContent({ kind: "url", url: "https://other.dev", title: "other" });
    const before = useAppStore.getState().studyHistory;

    store.renameStudyUrl("https://missing.dev", "x");

    expect(useAppStore.getState().studyHistory).toBe(before);
    expect(useAppStore.getState().studyContent).toEqual({
      kind: "url",
      url: "https://other.dev",
      title: "other",
    });
  });

  it("recording a weread book deduplicates by reader URL", () => {
    const store = useAppStore.getState();
    store.recordWereadBook({ url: "https://weread/reader/1", title: "第一版" });
    store.recordWereadBook({ url: "https://weread/reader/1", title: "更好的标题" });

    expect(useAppStore.getState().studyHistory.weread).toEqual([
      expect.objectContaining({ url: "https://weread/reader/1", title: "更好的标题" }),
    ]);
  });

  it("opening new study content drops the previous book (the book belongs to the old material)", () => {
    const store = useAppStore.getState();
    store.setStudyWereadBook({ url: "https://weread/reader/1", title: "书" });
    store.setStudyContent({ kind: "url", url: "https://x.dev", title: "x.dev" });
    expect(useAppStore.getState().studyWereadBook).toBeNull();
  });
});

describe("drawing session", () => {
  it("opens and closes, and closing twice does not wake subscribers", () => {
    useAppStore.getState().openDrawingSession({
      path: "/v/Excalidraw/d.excalidraw",
      isNew: true,
      originNote: "/v/a.md",
      originPos: 3,
    });
    expect(useAppStore.getState().drawingSession?.path).toBe("/v/Excalidraw/d.excalidraw");

    let writes = 0;
    const unsub = useAppStore.subscribe(() => {
      writes++;
    });
    useAppStore.getState().closeDrawingSession();
    useAppStore.getState().closeDrawingSession();
    expect(writes).toBe(1);
    expect(useAppStore.getState().drawingSession).toBeNull();
    unsub();
  });
});

describe("agent panel requests", () => {
  it("each command gets a fresh sequence number and carries its payload", () => {
    const store = useAppStore.getState();
    store.runAgentPanelCommand("new");
    const first = useAppStore.getState().agentPanelCommand;
    store.runAgentPanelCommand("focus-input", { insert: "quoted" });

    expect(first?.seq).toBe(1);
    expect(useAppStore.getState().agentPanelCommand).toMatchObject({
      seq: 2,
      kind: "focus-input",
      insert: "quoted",
    });
  });

  it("the config version and the session-switch signal only ever increase", () => {
    const before = useAppStore.getState();
    before.bumpAgentConfigVersion();
    before.bumpAgentSwitchSessionSignal();
    expect(useAppStore.getState().agentConfigVersion).toBe(before.agentConfigVersion + 1);
    expect(useAppStore.getState().agentSwitchSessionSignal).toBe(
      before.agentSwitchSessionSignal + 1,
    );
  });
});

describe("mode toggles", () => {
  it("toggleMode enters the target and leaves it on the second press", () => {
    useAppStore.getState().toggleMode("projects");
    expect(useAppStore.getState().mode).toBe("projects");
    useAppStore.getState().toggleMode("projects");
    expect(useAppStore.getState().mode).toBe("notes");
  });

  it("entering another shape from a shape switches directly", () => {
    useAppStore.getState().toggleMode("projects");
    useAppStore.getState().toggleMode("study");
    expect(useAppStore.getState().mode).toBe("study");
  });
});

describe("mainColumn", () => {
  it("only writes on a real transition", () => {
    useAppStore.setState({ mainColumn: "content" });
    let writes = 0;
    const unsub = useAppStore.subscribe(() => {
      writes++;
    });
    useAppStore.getState().setMainColumn("content");
    expect(writes).toBe(0);
    useAppStore.getState().setMainColumn("agent");
    expect(writes).toBe(1);
    expect(useAppStore.getState().mainColumn).toBe("agent");
    unsub();
  });
});

describe("vault reset", () => {
  it("setVault clears the per-vault state in one write", () => {
    useAppStore.setState({
      currentFile: "/old/a.md",
      dirty: true,
      tree: [{ name: "a.md", relPath: "a.md", kind: "file", children: null }],
      flatFiles: ["a.md"],
      linkBack: [{ from: "/old/x.md", to: "/old/a.md" }],
      dailyBackFrom: "/old/x.md",
    });

    useAppStore.getState().setVault({ path: "/new", name: "new" });

    const state = useAppStore.getState();
    expect(state).toMatchObject({
      vaultPath: "/new",
      vaultName: "new",
      tree: [],
      flatFiles: [],
      currentFile: null,
      dirty: false,
      linkBack: [],
      dailyBackFrom: null,
    });
  });

  it("closeVault leaves no vault and no open file behind", () => {
    useAppStore.getState().setVault({ path: "/v", name: "v" });
    useAppStore.setState({ currentFile: "/v/a.md", dirty: true });

    useAppStore.getState().closeVault();

    expect(useAppStore.getState()).toMatchObject({
      vaultPath: null,
      vaultName: "",
      currentFile: null,
      dirty: false,
    });
  });
});

describe("closeFile", () => {
  it("clears this vault's restore point so the next open does not chase a deleted path", async () => {
    vi.useFakeTimers();
    setConfigSnapshot({ lastFileByVault: { "/v": "/v/a.md", "/other": "/other/b.md" } });
    useAppStore.setState({ vaultPath: "/v", currentFile: "/v/a.md" });

    useAppStore.getState().closeFile();

    expect(getConfigSnapshot().lastFileByVault).toEqual({ "/other": "/other/b.md" });
    expect(useAppStore.getState().currentFile).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(lastWrite()).toMatchObject({ lastFileByVault: { "/other": "/other/b.md" } });
  });

  it("without a restore point for this vault nothing is persisted", () => {
    setConfigSnapshot({ lastFileByVault: { "/other": "/other/b.md" } });
    useAppStore.setState({ vaultPath: "/v" });
    useAppStore.getState().closeFile();
    expect(hasPendingPersist()).toBe(false);
  });
});

describe("replacement of the settings object", () => {
  it("replaceSettings writes the whole object and persists it", async () => {
    vi.useFakeTimers();
    const next = { ...DEFAULT_SETTINGS, vim: true, fontSize: 18 };
    useAppStore.getState().replaceSettings(next);
    expect(useAppStore.getState().settings).toBe(next);

    await vi.advanceTimersByTimeAsync(300);
    expect(lastWrite()).toMatchObject({ settings: { vim: true, fontSize: 18 } });
  });

  it("patchSettings keeps the untouched fields", () => {
    useAppStore.getState().patchSettings({ theme: "light" });
    const settings = useAppStore.getState().settings;
    expect(settings.theme).toBe("light");
    expect(settings.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(settings.ime).toEqual(DEFAULT_SETTINGS.ime);
  });
});

describe("settings modal target", () => {
  it("openSettings shows the modal on the requested section", () => {
    useAppStore.getState().openSettings("models");
    expect(useAppStore.getState().modal).toBe("settings");
    expect(useAppStore.getState().settingsTab).toBe("models");
  });

  it("setSettingsTab can clear the one-shot target", () => {
    useAppStore.getState().openSettings("models");
    useAppStore.getState().setSettingsTab(null);
    expect(useAppStore.getState().settingsTab).toBeNull();
  });
});

describe("small one-shot writers", () => {
  it("markDirty does not wake subscribers when the flag is unchanged", () => {
    useAppStore.setState({ dirty: false });
    let writes = 0;
    const unsub = useAppStore.subscribe(() => {
      writes++;
    });
    useAppStore.getState().markDirty(false);
    expect(writes).toBe(0);
    useAppStore.getState().markDirty(true);
    expect(writes).toBe(1);
    unsub();
  });

  it("requestRename expands a collapsed sidebar so the row exists to rename", () => {
    useAppStore.setState({ sidebarOpen: false, renameRequest: null });
    useAppStore.getState().requestRename("dir/a.md");
    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(useAppStore.getState().renameRequest).toBe("dir/a.md");
  });

  it("clearing a rename request without one is a no-op", () => {
    useAppStore.setState({ renameRequest: null });
    let writes = 0;
    const unsub = useAppStore.subscribe(() => {
      writes++;
    });
    useAppStore.getState().clearRenameRequest();
    expect(writes).toBe(0);
    unsub();
  });

  it("toasts replace each other and can be cleared", () => {
    useAppStore.getState().showToast("first");
    useAppStore.getState().showToast("second");
    expect(useAppStore.getState().toast).toBe("second");
    useAppStore.getState().clearToast();
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("the recent code-project list is persisted with the config", async () => {
    vi.useFakeTimers();
    useAppStore.getState().setRecentCodeProjects(["/repo/a"]);
    expect(useAppStore.getState().recentCodeProjects).toEqual(["/repo/a"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastWrite()).toMatchObject({ recentCodeProjects: ["/repo/a"] });
  });

  it("the code project is persisted so the mode restores it", async () => {
    vi.useFakeTimers();
    useAppStore.getState().setCodeProject({ path: "/repo/a", title: "a" });
    await vi.advanceTimersByTimeAsync(300);
    expect(lastWrite()).toMatchObject({ codeProject: { path: "/repo/a", title: "a" } });
  });

  it("the mode toggle helpers all enter their own shape", () => {
    toggleStudyMode();
    expect(useAppStore.getState().mode).toBe("study");
    toggleCodeMode();
    expect(useAppStore.getState().mode).toBe("code");
    toggleProjectsMode();
    expect(useAppStore.getState().mode).toBe("projects");
  });
});
