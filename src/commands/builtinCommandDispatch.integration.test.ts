import { beforeEach, describe, expect, it, vi } from "vitest";

// The command table imports the code-project commands, which pull xterm in;
// xterm probes a 2D canvas while its module evaluates, and jsdom has no
// canvas implementation. A null context is enough — no test here renders a
// terminal.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

import "@/commands/builtin";
import { fakeVault } from "@/test/fakeVault";
import { setConfigSnapshot, useAppStore } from "@/state/appStore";
import { runBoundKey, installGlobalKeybindings, setActiveKeyRegion } from "./globalKeys";
import { runCommand } from "./registry";

/**
 * "A UI control and its keybinding call the same command" is the project's
 * convention; this file proves the other half — that the command handler
 * really reaches the outside world through the real `@/lib/tauri` boundary.
 *
 * The boundary is the fake vault (see docs/TESTING.md): the handlers, the
 * stores and `src/lib/tauri.ts` are production code, only the bytes on the
 * other side of IPC are in memory. The assertions are therefore about the IPC
 * calls and the bytes that landed, not about the handler's internals.
 */

const ROOT = "/fake/vault";

beforeEach(() => {
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
    sidebarOpen: true,
    linkBack: [],
    studyContent: null,
    agentPanelCommand: null,
    mainColumn: "content",
    settings: { ...useAppStore.getState().settings, fontSize: 16, studyWebZoom: 1, vim: false },
  });
});

async function seedVault(entries: Record<string, string> = {}): Promise<void> {
  fakeVault.seed(entries);
  const info = await fakeVault.api.setVault(ROOT);
  useAppStore.getState().setVault(info);
}

describe("workspace.new-note", () => {
  it("creates Untitled.md in the current note's folder, refreshes the index and opens it", async () => {
    await seedVault({ "dir/a.md": "a" });
    useAppStore.setState({ currentFile: `${ROOT}/dir/a.md` });

    runCommand("workspace.new-note");

    await vi.waitFor(() =>
      expect(useAppStore.getState().currentFile).toBe(`${ROOT}/dir/Untitled.md`),
    );
    // The bytes exist on the fake disk, and the tree picked the new file up.
    expect(fakeVault.read("dir/Untitled.md")).toBe("");
    expect(useAppStore.getState().flatFiles).toContain("dir/Untitled.md");
    expect(
      fakeVault.writes.some((w) => w.kind === "createFile" && w.path === "dir/Untitled.md"),
    ).toBe(true);
  });

  it("dedupes against an existing file instead of overwriting it", async () => {
    await seedVault({ "Untitled.md": "first", "Untitled 2.md": "second" });

    runCommand("workspace.new-note");

    await vi.waitFor(() =>
      expect(useAppStore.getState().currentFile).toBe(`${ROOT}/Untitled 3.md`),
    );
    expect(fakeVault.read("Untitled.md")).toBe("first");
    expect(fakeVault.read("Untitled 2.md")).toBe("second");
    expect(fakeVault.read("Untitled 3.md")).toBe("");
  });

  it("does nothing without a vault: the command surface stays quiet instead of writing into a void", async () => {
    runCommand("workspace.new-note");
    await Promise.resolve();

    expect(useAppStore.getState().currentFile).toBeNull();
    expect(fakeVault.writes).toEqual([]);
  });

  it("reports a failed create as a toast the user can act on", async () => {
    await seedVault();
    fakeVault.failNext("createFile", "磁盘已满");

    runCommand("workspace.new-note");

    await vi.waitFor(() => expect(useAppStore.getState().toast).toContain("新建笔记失败"));
    expect(useAppStore.getState().currentFile).toBeNull();
  });
});

describe("workspace.open-daily", () => {
  it("creates today's note with the previous day's unfinished todos and opens it", async () => {
    vi.useFakeTimers({ now: new Date(2026, 0, 5, 10, 0, 0) });
    await seedVault({
      "Daily/2026-01-04.md":
        "# 2026-01-04\n\n- [ ] carried\n  - [ ] child\n- [x] finished\n- [ ] second\n",
    });

    runCommand("workspace.open-daily");

    await vi.waitFor(() =>
      expect(useAppStore.getState().currentFile).toBe(`${ROOT}/Daily/2026-01-05.md`),
    );
    // Rollover keeps the unfinished blocks with their subtree and drops the
    // completed one; the file is written once through the write IPC.
    expect(fakeVault.read("Daily/2026-01-05.md")).toBe(
      "# 2026-01-05\n\n- [ ] carried\n  - [ ] child\n- [ ] second\n",
    );
    expect(fakeVault.writes.filter((w) => w.kind === "write")).toHaveLength(1);
  });

  it("opens an existing daily note untouched instead of scaffolding over it", async () => {
    vi.useFakeTimers({ now: new Date(2026, 0, 5, 10, 0, 0) });
    const existing = "# 2026-01-05\n\n手写的内容\n";
    await seedVault({ "Daily/2026-01-05.md": existing });

    runCommand("workspace.open-daily");

    await vi.waitFor(() =>
      expect(useAppStore.getState().currentFile).toBe(`${ROOT}/Daily/2026-01-05.md`),
    );
    expect(fakeVault.read("Daily/2026-01-05.md")).toBe(existing);
    expect(fakeVault.writes).toEqual([]);
  });

  it("from inside today's note it jumps back to the file it was opened from", async () => {
    vi.useFakeTimers({ now: new Date(2026, 0, 5, 10, 0, 0) });
    await seedVault({ "note.md": "note", "Daily/2026-01-05.md": "# 2026-01-05\n" });
    useAppStore.setState({ currentFile: `${ROOT}/note.md` });

    runCommand("workspace.open-daily");
    await vi.waitFor(() =>
      expect(useAppStore.getState().currentFile).toBe(`${ROOT}/Daily/2026-01-05.md`),
    );

    runCommand("workspace.open-daily");
    await vi.waitFor(() => expect(useAppStore.getState().currentFile).toBe(`${ROOT}/note.md`));
  });

  it("says so when there is no vault to open a daily note in", async () => {
    runCommand("workspace.open-daily");

    await vi.waitFor(() => expect(useAppStore.getState().toast).toBe("没有打开仓库"));
    expect(fakeVault.writes).toEqual([]);
  });
});

describe("view and editor toggles", () => {
  it("view.zoom-in stops at 28px and the new size reaches the persisted config", async () => {
    await seedVault();
    for (let i = 0; i < 20; i += 1) runCommand("view.zoom-in");

    expect(useAppStore.getState().settings.fontSize).toBe(28);
    await vi.waitFor(() =>
      expect(fakeVault.writes.some((w) => w.kind === "saveConfig")).toBe(true),
    );
    const saved = fakeVault.writes.find((w) => w.kind === "saveConfig");
    expect((saved as { config: { settings: { fontSize: number } } }).config.settings.fontSize).toBe(
      28,
    );
  });

  it("view.zoom-out stops at 12px", async () => {
    await seedVault();
    for (let i = 0; i < 20; i += 1) runCommand("view.zoom-out");
    expect(useAppStore.getState().settings.fontSize).toBe(12);
  });

  it("view.zoom-reset returns to the default size", async () => {
    await seedVault();
    runCommand("view.zoom-in");
    runCommand("view.zoom-reset");
    expect(useAppStore.getState().settings.fontSize).toBe(16);
  });

  it("editor.toggle-vim flips the setting exactly once per press", async () => {
    await seedVault();
    runCommand("editor.toggle-vim");
    expect(useAppStore.getState().settings.vim).toBe(true);
    runCommand("editor.toggle-vim");
    expect(useAppStore.getState().settings.vim).toBe(false);
  });

  it("web zoom only takes the key while a web page is open, and stays inside 50%–300%", async () => {
    await seedVault();
    runCommand("study.web-zoom-in");
    expect(useAppStore.getState().settings.studyWebZoom).toBe(1);

    useAppStore.getState().setStudyContent({ kind: "url", url: "https://example.com", title: "x" });
    for (let i = 0; i < 20; i += 1) runCommand("study.web-zoom-in");
    expect(useAppStore.getState().settings.studyWebZoom).toBe(3);

    useAppStore.getState().patchSettings({ studyWebZoom: 1 });
    for (let i = 0; i < 20; i += 1) runCommand("study.web-zoom-out");
    expect(useAppStore.getState().settings.studyWebZoom).toBe(0.5);
  });
});

describe("keybinding dispatch runs the same handlers", () => {
  it("⌘P in the reading region opens the real palette, exactly as the menu item does", async () => {
    await seedVault();
    expect(runBoundKey("Mod-p", "notes")).toBe(true);
    expect(useAppStore.getState().modal).toBe("palette");
  });

  it("⌘N means a new note in the notes region: the key path reaches the same create IPC", async () => {
    await seedVault();

    expect(runBoundKey("Mod-n", "notes")).toBe(true);

    await vi.waitFor(() => expect(useAppStore.getState().currentFile).toBe(`${ROOT}/Untitled.md`));
    expect(fakeVault.writes.some((w) => w.kind === "createFile")).toBe(true);
  });

  it("a notes-region binding does not fire in the agent region: ⌘B cannot reach the editor from the panel", async () => {
    await seedVault();
    useAppStore.setState({ mode: "study" });

    // ⌘N is global (it works everywhere by definition); ⌘B belongs to the
    // notes region only, so the panel must not claim it for the editor.
    expect(runBoundKey("Mod-b", "agent")).toBe(false);
    expect(fakeVault.writes).toEqual([]);
  });
});

function region(name: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-key-region", name);
  // jsdom has no layout, so a mounted region reports no client rects. The
  // region model treats "no rects" as "not on screen"; a test region that is
  // meant to be visible has to say so.
  Object.defineProperty(el, "getClientRects", {
    configurable: true,
    value: () => [{ width: 100, height: 100 }],
  });
  document.body.append(el);
  return el;
}

describe("the window level keydown listener", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    installGlobalKeybindings();
  });

  it("a key pressed inside a region resolves against that region and consumes the event", async () => {
    await seedVault();
    const notes = region("notes");
    setActiveKeyRegion("notes");

    const event = new KeyboardEvent("keydown", {
      key: "n",
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    notes.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(useAppStore.getState().currentFile).toBe(`${ROOT}/Untitled.md`));
  });

  it("the same physical key is not taken from a region it does not belong to", async () => {
    await seedVault();
    const reading = region("reading");
    setActiveKeyRegion("reading");

    // ⌘B is the notes region's bold; the reading pane has no binding for it,
    // so the event is left for the page and no command runs.
    const event = new KeyboardEvent("keydown", {
      key: "b",
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    reading.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(useAppStore.getState().toast).toBeNull();
  });

  it("an unbound key passes through untouched, so ordinary typing is never swallowed", async () => {
    await seedVault();
    const notes = region("notes");
    setActiveKeyRegion("notes");

    const event = new KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true });
    notes.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
