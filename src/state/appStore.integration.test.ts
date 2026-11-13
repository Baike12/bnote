import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeVault } from "@/test/fakeVault";
import {
  flushPersistConfig,
  getConfigSnapshot,
  hasPendingPersist,
  persistConfig,
  setConfigSnapshot,
  useAppStore,
} from "./appStore";

/**
 * Config persistence is a single writer with a debounce. The failure shape is
 * subtle: a later partial save (cursor position) must not roll back fields an
 * earlier save changed, and a quit must flush the last 300ms instead of
 * dropping it. These tests drive the real module through the fake IPC
 * boundary, not a copy of its logic.
 */

const ROOT = "/fake/vault";

beforeEach(() => {
  vi.useFakeTimers();
  flushPersistConfig();
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
    mode: "notes",
    sidebarOpen: true,
    linkBack: [],
    dailyBackFrom: null,
    modal: null,
  });
  fakeVault.reset();
});

describe("persistConfig", () => {
  it("debounces and writes only the latest snapshot", async () => {
    persistConfig({ lastVault: "/one" });
    persistConfig({ lastVault: "/two" });
    expect(hasPendingPersist()).toBe(true);
    expect(fakeVault.writes.filter((w) => w.kind === "saveConfig")).toEqual([]);

    await vi.advanceTimersByTimeAsync(300);

    const writes = fakeVault.writes.filter((w) => w.kind === "saveConfig");
    expect(writes).toHaveLength(1);
    expect((writes[0] as { config: unknown }).config).toEqual({ lastVault: "/two" });
    expect(hasPendingPersist()).toBe(false);
  });

  it("flushPersistConfig writes immediately and cancels the timer", async () => {
    persistConfig({ lastVault: ROOT });
    flushPersistConfig();
    expect(hasPendingPersist()).toBe(false);
    await Promise.resolve();
    expect(fakeVault.writes.filter((w) => w.kind === "saveConfig")).toEqual([
      { kind: "saveConfig", config: { lastVault: ROOT } },
    ]);

    await vi.advanceTimersByTimeAsync(300);
    expect(fakeVault.writes.filter((w) => w.kind === "saveConfig")).toHaveLength(1);
  });

  it("a failing write is reported to the console, not thrown into the UI", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeVault.failAlways("saveAppConfig", "DISK_FULL");
    persistConfig({ lastVault: ROOT });
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("persist failed", expect.any(Error));
    warn.mockRestore();
    fakeVault.clearFailures();
  });
});

describe("openFile", () => {
  it("records the MRU and the per-vault restore point, then persists them", async () => {
    useAppStore.setState({ vaultPath: ROOT, vaultName: "vault" });
    useAppStore.getState().openFile(`${ROOT}/a.md`);
    useAppStore.getState().openFile(`${ROOT}/b.md`);
    useAppStore.getState().openFile(`${ROOT}/a.md`);

    expect(useAppStore.getState().recentFiles).toEqual([`${ROOT}/a.md`, `${ROOT}/b.md`]);
    const snapshot = getConfigSnapshot();
    expect(snapshot.lastFileByVault?.[ROOT]).toBe(`${ROOT}/a.md`);

    await vi.advanceTimersByTimeAsync(300);
    const writes = fakeVault.writes.filter((w) => w.kind === "saveConfig");
    expect(writes).toHaveLength(1);
    expect((writes[0] as { config: unknown }).config).toMatchObject({
      lastFileByVault: { [ROOT]: `${ROOT}/a.md` },
    });
  });

  it("opening the same file twice does not wake subscribers", () => {
    useAppStore.setState({ vaultPath: ROOT });
    useAppStore.getState().openFile(`${ROOT}/a.md`);
    const writes = vi.fn();
    const unsub = useAppStore.subscribe(writes);
    useAppStore.getState().openFile(`${ROOT}/a.md`);
    expect(writes).not.toHaveBeenCalled();
    unsub();
  });
});

describe("settings persistence", () => {
  it("patchSettings merges and persists the whole settings object", async () => {
    useAppStore.getState().patchSettings({ vim: true });
    await vi.advanceTimersByTimeAsync(300);
    const writes = fakeVault.writes.filter((w) => w.kind === "saveConfig");
    expect((writes[0] as { config: { settings?: { vim?: boolean } } }).config.settings?.vim).toBe(
      true,
    );
  });
});

describe("link back chain", () => {
  it("pops only while the landing is still the current file", () => {
    useAppStore.setState({ currentFile: `${ROOT}/a.md` });
    useAppStore.getState().pushLinkBack(`${ROOT}/start.md`, `${ROOT}/a.md`);
    useAppStore.setState({ currentFile: `${ROOT}/elsewhere.md` });
    expect(useAppStore.getState().popLinkBack()).toBeNull();
    expect(useAppStore.getState().linkBack).toEqual([]);
  });

  it("returns the source when the chain is intact", () => {
    useAppStore.setState({ currentFile: `${ROOT}/a.md` });
    useAppStore.getState().pushLinkBack(`${ROOT}/start.md`, `${ROOT}/a.md`);
    expect(useAppStore.getState().popLinkBack()).toBe(`${ROOT}/start.md`);
    expect(useAppStore.getState().linkBack).toEqual([]);
  });
});

describe("mode switches", () => {
  it("entering a full-screen shape collapses the sidebar; leaving does not expand it", () => {
    useAppStore.setState({ sidebarOpen: true });
    useAppStore.getState().setMode("study");
    expect(useAppStore.getState().sidebarOpen).toBe(false);
    useAppStore.getState().setMode("notes");
    expect(useAppStore.getState().sidebarOpen).toBe(false);
  });
});
