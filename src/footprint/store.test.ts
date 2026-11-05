import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { footprintsFilePath, type StoredFootprints, type StoredFootprintsV1 } from "./model";
import { FootprintCore, type FootprintIO } from "./store";

/** In-memory fake IO: files is keyed by absolute path; listFiles returns the vault relative paths like the real backend. */
function fakeIO(files: Map<string, string>): FootprintIO {
  return {
    readFile: async (p) => (files.has(p) ? files.get(p)! : null),
    writeFile: async (p, t) => {
      files.set(p, t);
    },
    listFiles: async () => ({
      files: [...files.keys()].map((p) => p.slice(VAULT.length + 1)),
    }),
  };
}

const VAULT = "/vault";
const NOTE = `${VAULT}/Job/job todo.md`;
const OTHER = `${VAULT}/研究/文献笔记.md`;

function coreOf(files: Map<string, string>, today: string): FootprintCore {
  return new FootprintCore({ io: fakeIO(files), today: () => today }, VAULT);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FootprintCore rotation", () => {
  it("the first init (no metadata): the whole vault is snapshotted into the baseline for that day, the footprint is empty, the day written to disk is the owner day", async () => {
    const files = new Map<string, string>([
      [NOTE, "旧内容 A\n\n旧内容 B"],
      [`${VAULT}/Daily/2026-01-01.md`, "日记不进基线"],
      [`${VAULT}/image.png`, "binary"],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    expect(core.baselineDay).toBe("2026-09-30");
    expect(core.todayEntries()).toEqual([]);

    core.flushPersist();
    const raw = files.get(footprintsFilePath(VAULT))!;
    const stored = JSON.parse(raw) as StoredFootprints;
    expect(stored.version).toBe(2);
    expect(stored.day).toBe("2026-09-30");
    // Only aggregateable files go into the baseline: daily notes and assets are excluded
    expect(Object.keys(stored.baselines)).toEqual([NOTE]);
    expect(stored.baselines[NOTE]).toBe("旧内容 A\n\n旧内容 B");
    // On first use there is no "that day", the archive is empty
    expect(stored.history).toEqual({});
  });

  it("metadata for the day already exists: no rotation, the baseline keeps the stored value (refreshAll builds the index as a fallback)", async () => {
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-30",
      baselines: { [NOTE]: "基线文本" },
    };
    const files = new Map<string, string>([
      [NOTE, "盘上已经改过的内容"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    // The baseline of the day is the stored baseline text, the content on disk diffs into the record of today
    await core.refreshAll(true);
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "盘上已经改过的内容", start: 1, end: 1 }]);
  });

  it("init across a day boundary: yesterday's baseline is void, the whole vault is snapshotted again for that day", async () => {
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-29",
      baselines: { [NOTE]: "昨天的" },
    };
    const files = new Map<string, string>([
      [NOTE, "今天的内容"],
      [OTHER, "别的文件"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    expect(core.baselineDay).toBe("2026-09-30");
    expect(core.todayEntries()).toEqual([]);
    expect(core.footprintsFor(NOTE)).toEqual([]);
  });

  it("v1 metadata (no history archive) loads as usual: the baseline is kept, the history archive is empty", async () => {
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-30",
      baselines: { [NOTE]: "基线文本" },
    };
    const files = new Map<string, string>([
      [NOTE, "基线文本\n\n今天的段"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    await core.refreshAll(true);
    expect(core.todayEntries()).toEqual([
      { path: NOTE, blocks: [{ text: "今天的段", start: 3, end: 3 }] },
    ]);
    expect(core.entriesFor("2026-09-29")).toEqual([]);
  });

  it("corrupted metadata is treated as never rotated (the whole vault rebuilds the baseline)", async () => {
    const files = new Map<string, string>([
      [NOTE, "正文"],
      [footprintsFilePath(VAULT), "{{{not json"],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    expect(core.baselineDay).toBe("2026-09-30");
    expect(core.todayEntries()).toEqual([]);
  });
});

describe("FootprintCore incremental refresh (noteDirty)", () => {
  function seededCore(files: Map<string, string>, today = "2026-09-30") {
    const core = coreOf(files, today);
    return core.init().then(() => core);
  }

  it("a dirty path is debounced for 1s and then diffed into today's blocks", async () => {
    const files = new Map<string, string>([[NOTE, "基线段落"]]);
    const core = await seededCore(files);
    files.set(NOTE, "基线段落\n\n今天写的新段");
    core.noteDirty([NOTE]);
    expect(core.footprintsFor(NOTE)).toEqual([]); // nothing moves during the debounce
    await vi.advanceTimersByTimeAsync(1100);
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "今天写的新段", start: 3, end: 3 }]);
  });

  it("several feeds within the debounce merge into one refresh (only the final state on disk is diffed)", async () => {
    const files = new Map<string, string>([[NOTE, "基线段落"]]);
    const core = await seededCore(files);
    files.set(NOTE, "基线段落\n\n第一段");
    core.noteDirty([NOTE]);
    await vi.advanceTimersByTimeAsync(500);
    files.set(NOTE, "基线段落\n\n第一段\n\n第二段");
    core.noteDirty([NOTE]);
    await vi.advanceTimersByTimeAsync(600);
    expect(core.footprintsFor(NOTE)).toEqual([
      { text: "第一段", start: 3, end: 3 },
      { text: "第二段", start: 5, end: 5 },
    ]);
  });

  it("the Daily directory and the non-note files are filtered out, at zero cost", async () => {
    const files = new Map<string, string>([[NOTE, "基线"]]);
    const core = await seededCore(files);
    core.noteDirty([`${VAULT}/Daily/2026-09-30.md`, `${VAULT}/x.png`, `${VAULT}/Daily/sub/a.md`]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(core.todayEntries()).toEqual([]);
  });

  it("a deleted file (unreadable) is removed from the index", async () => {
    const files = new Map<string, string>([[NOTE, "基线段落"]]);
    const core = await seededCore(files);
    files.set(NOTE, "基线段落\n\n新段");
    core.noteDirty([NOTE]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(core.footprintsFor(NOTE)).toHaveLength(1);
    files.delete(NOTE);
    core.noteDirty([NOTE]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(core.footprintsFor(NOTE)).toEqual([]);
  });

  it("the baseline used by a dirty refresh stays consistent after the rotation (a segment in yesterday's baseline does not count as new)", async () => {
    const files = new Map<string, string>([[NOTE, "基线\n\n昨天写下的段"]]);
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-29",
      baselines: { [NOTE]: "基线\n\n昨天写下的段" },
    };
    files.set(footprintsFilePath(VAULT), JSON.stringify(stored));
    const core = coreOf(files, "2026-09-29");
    await core.init(); // day=09-29, the baseline keeps the stored value
    files.set(NOTE, "基线\n\n昨天写下的段\n\n今天写的段");
    core.noteDirty([NOTE]);
    await vi.advanceTimersByTimeAsync(1100);
    // From the point of view of the 09-29 baseline: the segment written yesterday is in the baseline, it does not count as an addition
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "今天写的段", start: 5, end: 5 }]);
  });

  it("installIndexForTest replaces the index and increments the broadcast revision", async () => {
    const { footprintRevision } = await import("./store");
    const files = new Map<string, string>([[NOTE, "基线"]]);
    const core = await seededCore(files);
    const before = footprintRevision();
    core.installIndexForTest(new Map([[NOTE, [{ text: "注入块", start: 1, end: 1 }]]]));
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "注入块", start: 1, end: 1 }]);
    expect(footprintRevision()).toBeGreaterThan(before);
  });

  it("a core that has not rotated (day is an empty string: the injection / init gap) uses the live index for any date", async () => {
    const { todayStamp } = await import("@/lib/todoStamp");
    const core = coreOf(new Map(), "2026-09-30"); // init is not called, day = ""
    core.installIndexForTest(new Map([[NOTE, [{ text: "注入块", start: 1, end: 1 }]]]));
    expect(core.entriesFor(todayStamp())).toEqual([
      { path: NOTE, blocks: [{ text: "注入块", start: 1, end: 1 }] },
    ]);
  });
});

describe("FootprintCore full fallback (refreshAll)", () => {
  it("rebuilds the index of all the files, covering the changes made while the app was not running", async () => {
    const files = new Map<string, string>([[NOTE, "基线段落"]]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    // A change made while the app was not running: the state on disk changed
    // directly, there is no watcher event
    files.set(NOTE, "基线段落\n\n离线写的新段");
    files.set(OTHER, "另一篇今天改的");
    await core.refreshAll();
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "离线写的新段", start: 3, end: 3 }]);
    expect(core.footprintsFor(OTHER)).toEqual([{ text: "另一篇今天改的", start: 1, end: 1 }]);
  });

  it("throttle: a repeated call within 5s does not rescan (no broadcast even without changes)", async () => {
    const files = new Map<string, string>([[NOTE, "基线段落"]]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    await core.refreshAll();
    files.set(NOTE, "基线段落\n\n新段");
    await core.refreshAll(); // swallowed by the throttle
    expect(core.footprintsFor(NOTE)).toEqual([]);
    await vi.advanceTimersByTimeAsync(5001);
    await core.refreshAll();
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "新段", start: 3, end: 3 }]);
  });
});

describe("FootprintCore × todo exclusion: end to end (user visible behavior)", () => {
  it("a pure todo file produces no footprint after the refresh; a mixed file keeps only the non-todo blocks", async () => {
    const stored: StoredFootprintsV1 = { version: 1, day: "2026-09-30", baselines: {} };
    const files = new Map<string, string>([
      [NOTE, "- [ ] 纯待办甲\n- [x] 纯待办乙\n\n普通段落\n\n- 普通列表项"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    await core.refreshAll(true);
    expect(core.todayEntries()).toEqual([
      {
        path: NOTE,
        blocks: [
          { text: "普通段落", start: 4, end: 4 },
          { text: "- 普通列表项", start: 6, end: 6 },
        ],
      },
    ]);
  });
});

describe("FootprintCore history archive: frozen by the cross-day rotation, the historical daily notes aggregated by day", () => {
  it("the cross-day rotation freezes the added blocks of the old baseline day into an archive; today is still an empty live index", async () => {
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-29",
      baselines: { [NOTE]: "基线段落" },
    };
    const files = new Map<string, string>([
      [NOTE, "基线段落\n\n09-29 写的段"],
      [OTHER, "09-29 也写了"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    // The footprint of 09-29 is frozen; the current day (09-30) starts from zero.
    // The entries are sorted with localeCompare, so the order depends on the locale
    // of the host (in zh-CN the Chinese characters come before the Latin ones), the
    // assertion only locks the content and normalizes both sides by code point
    // order before comparing.
    const sorted = <T extends { path: string }>(es: T[]): T[] =>
      [...es].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    expect(sorted(core.entriesFor("2026-09-29"))).toEqual(
      sorted([
        { path: NOTE, blocks: [{ text: "09-29 写的段", start: 3, end: 3 }] },
        { path: OTHER, blocks: [{ text: "09-29 也写了", start: 1, end: 1 }] },
      ]),
    );
    expect(core.entriesFor("2026-09-30")).toEqual([]);
    core.flushPersist();
    const persisted = JSON.parse(files.get(footprintsFilePath(VAULT))!) as StoredFootprints;
    expect(persisted.version).toBe(2);
    expect(persisted.history["2026-09-29"][NOTE]).toEqual([
      { text: "09-29 写的段", start: 3, end: 3 },
    ]);
  });

  it("the archive is a frozen snapshot: the disk keeps changing after the rotation, the old day entries do not change, today goes live", async () => {
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-29",
      baselines: { [NOTE]: "基线段落" },
    };
    const files = new Map<string, string>([
      [NOTE, "基线段落\n\n09-29 写的段"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    files.set(NOTE, "基线段落\n\n09-29 写的段\n\n09-30 写的段");
    core.noteDirty([NOTE]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(core.entriesFor("2026-09-29")).toEqual([
      { path: NOTE, blocks: [{ text: "09-29 写的段", start: 3, end: 3 }] },
    ]);
    expect(core.entriesFor("2026-09-30")).toEqual([
      { path: NOTE, blocks: [{ text: "09-30 写的段", start: 5, end: 5 }] },
    ]);
  });

  it("the todo exclusion applies to the archive as well; with no additions that day the archive is empty", async () => {
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-29",
      baselines: { [NOTE]: "基线" },
    };
    const files = new Map<string, string>([
      [NOTE, "基线\n\n- [ ] 纯待办不进档案"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    expect(core.entriesFor("2026-09-29")).toEqual([]);
    core.flushPersist();
    const persisted = JSON.parse(files.get(footprintsFilePath(VAULT))!) as StoredFootprints;
    expect(persisted.history["2026-09-29"]).toEqual({});
  });

  it("the app was not opened for days: the last active day gets the whole accumulation, the days in between have no archive", async () => {
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-27",
      baselines: { [NOTE]: "基线" },
    };
    const files = new Map<string, string>([
      [NOTE, "基线\n\n几天间写的段"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    expect(core.entriesFor("2026-09-27")).toEqual([
      { path: NOTE, blocks: [{ text: "几天间写的段", start: 3, end: 3 }] },
    ]);
    expect(core.entriesFor("2026-09-28")).toEqual([]);
    expect(core.entriesFor("2026-09-29")).toEqual([]);
  });

  it("ensureDay is idempotent: repeated calls within the same day do not rotate again and do not rewrite the archive", async () => {
    const stored: StoredFootprintsV1 = {
      version: 1,
      day: "2026-09-29",
      baselines: { [NOTE]: "基线" },
    };
    const files = new Map<string, string>([
      [NOTE, "基线\n\n昨天的段"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    const first = core.entriesFor("2026-09-29");
    await core.ensureDay();
    await core.ensureDay();
    expect(core.entriesFor("2026-09-29")).toEqual(first);
    expect(core.baselineDay).toBe("2026-09-30");
  });
});
