import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FootprintBlock } from "./model";

/**
 * The module level face of the footprint store: the singleton cache, the watcher
 * entry point and the harness hooks. appStore and the IPC boundary are the only
 * outside world here, so both are faked at their real seams; the rotation and the
 * diffing behavior itself belongs to store.test.ts (FootprintCore).
 *
 * Locked rules:
 *  - every reader answers an empty result while the store is not loaded (a
 *    skeleton UI must never see a throw);
 *  - the store is rebuilt on a vault swap, and the old vault answers nothing;
 *  - `refreshFootprints` creates the store itself when nothing was loaded yet
 *    (it does not depend on the startup ordering of ensureFootprints);
 *  - the harness hooks replace the index/archive for the current vault only.
 */

const api = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<string> => {
    throw new Error("missing");
  }),
  writeFile: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
  listFiles: vi.fn(async (): Promise<{ files: string[]; truncated: boolean }> => ({
    files: [],
    truncated: false,
  })),
}));
const appState = vi.hoisted(() => ({ vaultPath: null as string | null }));

vi.mock("@/lib/tauri", () => ({ api }));
vi.mock("@/state/appStore", () => ({
  useAppStore: { getState: () => ({ vaultPath: appState.vaultPath }) },
}));

import {
  ensureFootprintDay,
  ensureFootprints,
  flushFootprintsPersist,
  footprintDay,
  footprintEntriesFor,
  footprintsFor,
  hasPendingFootprintsPersist,
  noteDirtyPaths,
  refreshFootprints,
  setFootprintHistoryForTest,
  setFootprintIndexForTest,
  todayFootprintEntries,
  onFootprintsChanged,
  footprintRevision,
} from "./store";

const DAY = "2026-09-30";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 30, 10, 0, 0) });
  api.readFile.mockReset();
  api.readFile.mockRejectedValue(new Error("missing"));
  api.writeFile.mockReset();
  api.writeFile.mockResolvedValue(undefined);
  api.listFiles.mockReset();
  api.listFiles.mockResolvedValue({ files: [], truncated: false });
  appState.vaultPath = null;
});

afterEach(() => {
  vi.useRealTimers();
});

/** A fresh vault path per test: the singleton cache is keyed by it. */
function vault(name: string): string {
  return `/v-${name}`;
}

function blocks(text: string, start = 1, end = 1): FootprintBlock[] {
  return [{ text, start, end }];
}

describe("readers before the store is loaded", () => {
  /**
   * The cache is a module singleton, so "not loaded" cannot be asserted globally
   * (another test of this file may have loaded it already). What is locked here is
   * the contract a skeleton UI depends on: a path the cache does not know answers
   * empty, and the module readers never throw — they are called from the watcher
   * and the quit hook, which may fire before the store exists.
   */
  it("a path the store does not know answers empty", () => {
    const cold = vault("cold-reader");
    expect(footprintsFor(`${cold}/none.md`)).toEqual([]);
    expect(footprintEntriesFor("2020-01-01")).toEqual([]);
  });

  it("the watcher, the quit hook and the day hook are silent no-ops without a store", async () => {
    expect(() => noteDirtyPaths(["/v-cold-unloaded/none.md"])).not.toThrow();
    expect(() => flushFootprintsPersist()).not.toThrow();
    await expect(ensureFootprintDay()).resolves.toBeUndefined();
    expect(() => noteDirtyPaths(["/v-cold-unloaded/none.md"])).not.toThrow();
  });
});

describe("ensureFootprints", () => {
  it("loads the vault once and answers the day from the clock", async () => {
    appState.vaultPath = vault("load");
    await ensureFootprints(vault("load"));
    expect(footprintDay()).toBe(DAY);
    expect(api.readFile).toHaveBeenCalledWith(`${vault("load")}/.bnote/daily-footprints.json`);
    // The rotation wrote its baseline once (debounced by 300ms)
    await vi.advanceTimersByTimeAsync(301);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it("the same vault is not re-read; a vault swap rebuilds the store and the old vault stops answering", async () => {
    const first = vault("first");
    const second = vault("second");
    await ensureFootprints(first);
    setFootprintIndexForTest(first, new Map([[`${first}/a.md`, blocks("甲")]]));
    expect(footprintsFor(`${first}/a.md`)).toEqual(blocks("甲"));

    await ensureFootprints(second);
    expect(footprintDay()).toBe(DAY);
    // The injection belonged to the first vault
    expect(footprintsFor(`${first}/a.md`)).toEqual([]);

    const reads = api.readFile.mock.calls.length;
    await ensureFootprints(second);
    expect(api.readFile.mock.calls.length).toBe(reads); // cache hit
  });

  it("an init failure (metadata read throws) is logged, the store still answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lost = vault("lost");
    api.readFile.mockRejectedValueOnce(new Error("metadata unreadable"));
    api.listFiles.mockRejectedValueOnce(new Error("vault unreadable"));
    await ensureFootprints(lost);
    expect(warn).toHaveBeenCalledWith("footprint init failed", expect.any(Error));
    expect(todayFootprintEntries()).toEqual([]);
    warn.mockRestore();
  });
});

describe("noteDirtyPaths", () => {
  it("feeds the core of the current vault and is a silent no-op without one", async () => {
    const root = vault("dirty");
    appState.vaultPath = root;
    api.listFiles.mockResolvedValue({ files: ["a.md"], truncated: false });
    api.readFile.mockImplementation(async (p: string) => {
      if (p !== `${root}/a.md`) throw new Error("missing");
      return "基线";
    });
    await ensureFootprints(root);

    api.readFile.mockImplementation(async (p: string) => {
      if (p !== `${root}/a.md`) throw new Error("missing");
      return "基线\n\n今天的段";
    });
    noteDirtyPaths([`${root}/a.md`]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(footprintsFor(`${root}/a.md`)).toEqual([{ text: "今天的段", start: 3, end: 3 }]);
  });
});

describe("refreshFootprints", () => {
  it("without a vault it does nothing", async () => {
    await refreshFootprints();
    expect(api.listFiles).not.toHaveBeenCalled();
  });

  it("creates the store itself when nothing was loaded and rebuilds the index", async () => {
    const root = vault("refresh");
    appState.vaultPath = root;
    api.listFiles.mockResolvedValue({ files: ["a.md"], truncated: false });
    // The baseline is taken when the store loads; the offline edit happens after
    let reads = 0;
    api.readFile.mockImplementation(async (p: string) => {
      if (p !== `${root}/a.md`) throw new Error("missing");
      reads++;
      return reads === 1 ? "基线" : "基线\n\n离线写的";
    });

    await refreshFootprints();
    expect(footprintDay()).toBe(DAY);
    expect(footprintsFor(`${root}/a.md`)).toEqual([{ text: "离线写的", start: 3, end: 3 }]);
  });
});

describe("harness hooks", () => {
  it("setFootprintIndexForTest creates the store when none is loaded and broadcasts", () => {
    const root = vault("hook");
    const before = footprintRevision();
    setFootprintIndexForTest(root, new Map([[`${root}/a.md`, blocks("注入")]]));
    expect(footprintsFor(`${root}/a.md`)).toEqual(blocks("注入"));
    expect(footprintRevision()).toBeGreaterThan(before);
  });

  it("setFootprintHistoryForTest installs an archive the historical day then reads", async () => {
    const root = vault("history");
    appState.vaultPath = root;
    await ensureFootprints(root); // the store knows its baseline day
    setFootprintHistoryForTest(root, "2026-09-20", new Map([[`${root}/a.md`, blocks("旧")]]));
    expect(footprintEntriesFor("2026-09-20")).toEqual([
      { path: `${root}/a.md`, blocks: blocks("旧") },
    ]);
    // The current day still reads the live index, not the archive
    expect(footprintEntriesFor(DAY)).toEqual([]);
  });

  it("setFootprintHistoryForTest with nothing loaded creates an unrotated store: the archive waits for the day", () => {
    const root = vault("history-cold");
    setFootprintHistoryForTest(root, "2026-09-20", new Map([[`${root}/a.md`, blocks("旧")]]));
    // Without a rotation the baseline day is the empty string, so every day reads
    // the live index and the injected archive stays invisible until a rotation
    expect(footprintDay()).toBe("");
    expect(footprintEntriesFor("2026-09-20")).toEqual([]);
  });

  it("the harness subscriptions receive the broadcast; unsubscribing stops it", () => {
    const root = vault("listen");
    setFootprintIndexForTest(root, new Map());
    let hits = 0;
    const off = onFootprintsChanged(() => {
      hits++;
    });
    setFootprintIndexForTest(root, new Map());
    expect(hits).toBe(1);
    off();
    setFootprintIndexForTest(root, new Map());
    expect(hits).toBe(1);
  });
});

describe("quit/hide persistence", () => {
  it("a pending baseline write is flushed on demand and the debounce does not fire twice", async () => {
    const root = vault("flush");
    appState.vaultPath = root;
    await ensureFootprints(root);
    expect(hasPendingFootprintsPersist()).toBe(true);
    flushFootprintsPersist();
    expect(hasPendingFootprintsPersist()).toBe(false);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });
});
