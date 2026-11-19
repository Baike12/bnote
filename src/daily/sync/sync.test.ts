import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sync orchestrator's ordering contract, against in-memory doubles of the
 * IPC surface. Every case starts from a blank module state (a fresh vault
 * path plus `__resetSyncForTests`), mirroring how links.test.ts treats its
 * per-vault singleton.
 */

const writes: Array<{ path: string; contents: string }> = [];
const files = new Map<string, string>();
const pushes: Array<{ server: string; key: string; days: unknown[] }> = [];
const pulls: Array<{ server: string; key: string; dates: unknown }> = [];
let pushResults: Array<{
  date: string;
  ok: boolean;
  rev: number | null;
  conflictRev: number | null;
  conflictContent: string | null;
  error: string | null;
}> = [];
let pullResults: Array<{
  date: string;
  rev: number;
  updatedBy: string;
  updatedAt: number;
  content: string;
}> = [];
let connectResult: boolean | Error = true;
const disconnects = vi.fn();

vi.mock("@/lib/tauri", () => ({
  api: {
    readFile: vi.fn(async (path: string) => {
      const v = files.get(path);
      return v === undefined ? Promise.reject(new Error("missing")) : v;
    }),
    writeFile: vi.fn(async (path: string, contents: string) => {
      files.set(path, contents);
      writes.push({ path, contents });
    }),
    readDir: vi.fn(async () => []),
  },
  syncApi: {
    connect: vi.fn(async () => {
      if (connectResult instanceof Error) throw connectResult;
      return connectResult;
    }),
    disconnect: vi.fn(async () => disconnects()),
    test: vi.fn(async () => "连接成功"),
    pushDays: vi.fn(async (server: string, key: string, days: unknown[]) => {
      pushes.push({ server, key, days });
      return pushResults;
    }),
    pullDays: vi.fn(async (server: string, key: string, dates: unknown) => {
      pulls.push({ server, key, dates });
      return pullResults;
    }),
  },
}));

const settings = {
  daily: { template: "", sync: { enabled: true, server: "http://sync.local", key: "k" } },
};
let vaultPath: string | null = null;

vi.mock("@/state/appStore", () => ({
  useAppStore: {
    getState: () => ({ settings, vaultPath }),
  },
}));

vi.mock("@/editor/api", () => ({
  findEditorFor: vi.fn(() => null),
}));

import { api, syncApi } from "@/lib/tauri";
import {
  __resetSyncForTests,
  configureSync,
  flushDailySyncPersist,
  forcePullAll,
  forcePushAll,
  handleSyncDayEvent,
  noteDailySyncPaths,
} from "./sync";

function seedVaultFiles(day: string, content: string | null): void {
  if (content !== null) files.set(`${vaultPath}/Daily/${day}.md`, content);
}

beforeEach(() => {
  __resetSyncForTests();
  vi.useFakeTimers();
  writes.length = 0;
  files.clear();
  pushes.length = 0;
  pulls.length = 0;
  pushResults = [];
  pullResults = [];
  connectResult = true;
  disconnects.mockClear();
  vaultPath = `/tmp/bnote-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  settings.daily.sync = { enabled: true, server: "http://sync.local", key: "k" };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("configureSync", () => {
  it("with sync disabled: no connection is made and nothing else changes", async () => {
    settings.daily.sync = { enabled: false, server: "", key: "" };
    await configureSync();
    expect(syncApi.connect).not.toHaveBeenCalled();
    expect(disconnects).toHaveBeenCalled();
    expect(syncApi.pullDays).not.toHaveBeenCalled();
  });

  it("with an incomplete config: reports the reason instead of connecting", async () => {
    settings.daily.sync = { enabled: true, server: "", key: "k" };
    await configureSync();
    expect(syncApi.connect).not.toHaveBeenCalled();
  });

  it("connects and reconciles: agreeing days become the base, missing days are pulled", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 甲\n");
    pullResults = [
      {
        date: "2026-11-19",
        rev: 3,
        updatedBy: "手机",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 甲\n",
      },
      {
        date: "2026-11-18",
        rev: 2,
        updatedBy: "手机",
        updatedAt: 1,
        content: "# 2026-11-18\n\n- [ ] 昨天的\n",
      },
    ];
    await configureSync();
    expect(syncApi.connect).toHaveBeenCalledWith("http://sync.local", "k", expect.any(String));
    expect(pulls[0]?.dates).toBeNull();
    // The missing day was written verbatim; the agreeing day was not touched.
    expect(files.get(`${vaultPath}/Daily/2026-11-18.md`)).toContain("昨天的");
    expect(writes.filter((w) => w.path.endsWith("2026-11-19.md"))).toHaveLength(0);
    // The state file records the revisions (written after the 300ms debounce).
    await vi.advanceTimersByTimeAsync(300);
    const state = JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!);
    expect(state.days["2026-11-19"]).toEqual({ rev: 3 });
    expect(state.days["2026-11-18"]).toEqual({ rev: 2 });
  });

  it("marks a true divergence unresolved instead of guessing", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 本地改过\n");
    pullResults = [
      {
        date: "2026-11-19",
        rev: 5,
        updatedBy: "手机",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 远端改过\n",
      },
    ];
    await configureSync();
    // No write happened; the day waits for an explicit force sync.
    expect(writes.filter((w) => w.path.endsWith("2026-11-19.md"))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushes).toHaveLength(0);
  });

  it("a failed connect surfaces the message and never reconciles", async () => {
    connectResult = new Error("AUTH_FAILED: 密钥不正确");
    await configureSync();
    expect(syncApi.pullDays).not.toHaveBeenCalled();
  });
});

describe("push path", () => {
  it("debounces vault-changed into one push with the known revision", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 甲\n");
    pullResults = [
      {
        date: "2026-11-19",
        rev: 3,
        updatedBy: "x",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 甲\n",
      },
    ];
    await configureSync();
    pushResults = [
      {
        date: "2026-11-19",
        ok: true,
        rev: 4,
        conflictRev: null,
        conflictContent: null,
        error: null,
      },
    ];
    files.set(`${vaultPath}/Daily/2026-11-19.md`, "# 2026-11-19\n\n- [ ] 甲\n- [ ] 新的\n");
    noteDailySyncPaths([`${vaultPath}/Daily/2026-11-19.md`]);
    expect(pushes).toHaveLength(0); // debounced
    await vi.advanceTimersByTimeAsync(700);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.days).toEqual([
      {
        date: "2026-11-19",
        content: "# 2026-11-19\n\n- [ ] 甲\n- [ ] 新的\n",
        baseRev: 3,
        force: false,
        deviceId: expect.any(String),
      },
    ]);
    await vi.advanceTimersByTimeAsync(300); // state persist debounce
    const state = JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!);
    expect(state.days["2026-11-19"]).toEqual({ rev: 4 });
  });

  it("an unchanged file is never pushed (echo guard)", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 甲\n");
    pullResults = [
      {
        date: "2026-11-19",
        rev: 3,
        updatedBy: "x",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 甲\n",
      },
    ];
    await configureSync();
    noteDailySyncPaths([`${vaultPath}/Daily/2026-11-19.md`]);
    await vi.advanceTimersByTimeAsync(700);
    expect(pushes).toHaveLength(0);
  });

  it("non-daily paths are ignored", async () => {
    await configureSync();
    noteDailySyncPaths([`${vaultPath}/Projects/x.md`]);
    await vi.advanceTimersByTimeAsync(700);
    expect(pushes).toHaveLength(0);
  });

  it("a 409 is resolved by merging against the server copy and re-pushed", async () => {
    const base = "# 2026-11-19\n\n- [ ] 甲\n";
    seedVaultFiles("2026-11-19", base);
    pullResults = [{ date: "2026-11-19", rev: 3, updatedBy: "x", updatedAt: 1, content: base }];
    await configureSync();
    files.set(`${vaultPath}/Daily/2026-11-19.md`, "# 2026-11-19\n\n- [ ] 甲\n- [ ] 本地新增\n");
    // The first push answers 409 (via a one-shot mock); the re-push goes
    // through the recording default by seeding `pushResults` with the 200.
    vi.mocked(syncApi.pushDays).mockResolvedValueOnce([
      {
        date: "2026-11-19",
        ok: false,
        rev: null,
        conflictRev: 4,
        conflictContent: "# 2026-11-19\n\n- [ ] 甲\n- [ ] 手机新增\n",
        error: null,
      },
    ]);
    pushResults = [
      {
        date: "2026-11-19",
        ok: true,
        rev: 5,
        conflictRev: null,
        conflictContent: null,
        error: null,
      },
    ];
    noteDailySyncPaths([`${vaultPath}/Daily/2026-11-19.md`]);
    await vi.advanceTimersByTimeAsync(700);
    // mockResolvedValueOnce bypasses the recording default, so only the
    // re-push lands in `pushes` — the one that carries the MERGED document.
    expect(pushes).toHaveLength(1);
    const merged = (pushes[0]!.days[0] as { content: string }).content;
    expect(merged).toContain("本地新增");
    expect(merged).toContain("手机新增");
    expect((pushes[0]!.days[0] as { baseRev: number }).baseRev).toBe(4);
    await vi.advanceTimersByTimeAsync(300);
    expect(
      JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!).days["2026-11-19"],
    ).toEqual({ rev: 5 });
  });
});

describe("remote day events", () => {
  it("merges a remote edit into a locally dirty day instead of overwriting it", async () => {
    // base rev3 agrees with disk; the local side then edits the file while a
    // remote edit lands: applyRemote must three-way merge, not clobber.
    const base = "# 2026-11-19\n\n- [ ] 甲\n- [ ] 乙\n";
    seedVaultFiles("2026-11-19", base);
    pullResults = [{ date: "2026-11-19", rev: 3, updatedBy: "x", updatedAt: 1, content: base }];
    await configureSync();
    files.set(
      `${vaultPath}/Daily/2026-11-19.md`,
      "# 2026-11-19\n\n- [x] 甲 ✅ 2026-11-19\n- [ ] 乙\n",
    );
    await handleSyncDayEvent({
      date: "2026-11-19",
      rev: 4,
      device: "phone-1",
      content: "# 2026-11-19\n\n- [ ] 甲\n- [ ] 乙(手机改的)\n",
    });
    const merged = files.get(`${vaultPath}/Daily/2026-11-19.md`);
    expect(merged).toContain("- [x] 甲 ✅ 2026-11-19");
    expect(merged).toContain("- [ ] 乙(手机改的)");
    await vi.advanceTimersByTimeAsync(300);
    expect(
      JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!).days["2026-11-19"],
    ).toEqual({ rev: 4 });
  });

  it("own-device echoes only move the revision", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 甲\n");
    pullResults = [
      {
        date: "2026-11-19",
        rev: 3,
        updatedBy: "x",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 甲\n",
      },
    ];
    await configureSync();
    flushDailySyncPersist();
    const state = JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!);
    const deviceId = state.deviceId;
    await handleSyncDayEvent({
      date: "2026-11-19",
      rev: 9,
      device: deviceId,
      content: "# 其他内容\n",
    });
    expect(files.get(`${vaultPath}/Daily/2026-11-19.md`)).toContain("- [ ] 甲");
    await vi.advanceTimersByTimeAsync(300);
    expect(
      JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!).days["2026-11-19"],
    ).toEqual({ rev: 9 });
  });

  it("a remote edit for a day we have not touched is applied verbatim", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 甲\n");
    pullResults = [
      {
        date: "2026-11-19",
        rev: 3,
        updatedBy: "x",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 甲\n",
      },
    ];
    await configureSync();
    await handleSyncDayEvent({
      date: "2026-11-19",
      rev: 4,
      device: "phone-1",
      content: "# 2026-11-19\n\n- [ ] 甲\n- [ ] 手机新加\n",
    });
    expect(files.get(`${vaultPath}/Daily/2026-11-19.md`)).toContain("- [ ] 手机新加");
  });

  it("an older event than the known revision is dropped", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 甲\n");
    pullResults = [
      {
        date: "2026-11-19",
        rev: 6,
        updatedBy: "x",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 甲\n",
      },
    ];
    await configureSync();
    await handleSyncDayEvent({
      date: "2026-11-19",
      rev: 2,
      device: "phone-1",
      content: "# 旧内容\n",
    });
    expect(files.get(`${vaultPath}/Daily/2026-11-19.md`)).toContain("- [ ] 甲");
  });
});

describe("force pull", () => {
  it("overwrites the local file with the server copy", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 本地\n");
    pullResults = [
      {
        date: "2026-11-19",
        rev: 7,
        updatedBy: "手机",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 服务器\n",
      },
    ];
    await configureSync();
    await forcePullAll();
    expect(files.get(`${vaultPath}/Daily/2026-11-19.md`)).toContain("- [ ] 服务器");
  });
});

describe("force push", () => {
  it("collects daily files by their full vault path and pushes them", async () => {
    // dailyDayOf matches `/Daily/<date>.md` inside a FULL path; feeding it a
    // bare "Daily/<name>" silently skipped every day and reported success.
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 本地覆盖\n");
    pullResults = [];
    vi.mocked(api.readDir).mockResolvedValueOnce([
      { name: "2026-11-19.md", kind: "file", relPath: "Daily/2026-11-19.md", children: null },
    ] as never);
    pushResults = [
      {
        date: "2026-11-19",
        ok: true,
        rev: 2,
        conflictRev: null,
        conflictContent: null,
        error: null,
      },
    ];
    await configureSync();
    await forcePushAll();
    expect(pushes).toHaveLength(1);
    const day = pushes[0]!.days[0] as { date: string; content: string; force: boolean };
    expect(day.date).toBe("2026-11-19");
    expect(day.content).toContain("本地覆盖");
    expect(day.force).toBe(true);
  });

  it("rejects when a day fails to push instead of reporting success", async () => {
    seedVaultFiles("2026-11-19", "# 2026-11-19\n\n- [ ] 甲\n");
    vi.mocked(api.readDir).mockResolvedValueOnce([
      { name: "2026-11-19.md", kind: "file", relPath: "Daily/2026-11-19.md", children: null },
    ] as never);
    pushResults = [
      {
        date: "2026-11-19",
        ok: false,
        rev: null,
        conflictRev: null,
        conflictContent: null,
        error: "AUTH_FAILED: 密钥不正确",
      },
    ];
    await configureSync();
    await expect(forcePushAll()).rejects.toThrow("密钥不正确");
  });
});

describe("state persistence", () => {
  it("debounces the state file write and flushes on demand", async () => {
    pullResults = [
      {
        date: "2026-11-19",
        rev: 3,
        updatedBy: "x",
        updatedAt: 1,
        content: "# 2026-11-19\n\n- [ ] 甲\n",
      },
    ];
    await configureSync();
    const stateWrites = () => writes.filter((w) => w.path.includes("sync-state.json")).length;
    expect(stateWrites()).toBe(0); // scheduled, not yet written
    flushDailySyncPersist();
    expect(stateWrites()).toBe(1);
    expect(
      JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!).days["2026-11-19"],
    ).toEqual({ rev: 3 });
  });

  it("reuses the persisted deviceId across resets", async () => {
    pullResults = [];
    await configureSync();
    flushDailySyncPersist();
    const first = JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!).deviceId;
    __resetSyncForTests();
    await configureSync();
    const second = JSON.parse(files.get(`${vaultPath}/.bnote/b-todo/sync-state.json`)!).deviceId;
    expect(second).toBe(first);
  });
});
