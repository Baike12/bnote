import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { footprintsFilePath, type StoredFootprints } from "./model";
import { FootprintCore, type FootprintIO } from "./store";

/** 内存假 IO:files 以绝对路径为键;listFiles 与真后端一样返回 vault 相对路径。 */
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

describe("FootprintCore 轮转", () => {
  it("首次 init(无元数据):当天即全库快照进基线,足迹为空,写盘归属日", async () => {
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
    expect(stored.version).toBe(1);
    expect(stored.day).toBe("2026-09-30");
    // 只有可聚合文件进基线:日记与资产被排除
    expect(Object.keys(stored.baselines)).toEqual([NOTE]);
    expect(stored.baselines[NOTE]).toBe("旧内容 A\n\n旧内容 B");
  });

  it("已有当天元数据:不轮转,基线沿用存储值(refreshAll 兜底建索引)", async () => {
    const stored: StoredFootprints = { version: 1, day: "2026-09-30", baselines: { [NOTE]: "基线文本" } };
    const files = new Map<string, string>([
      [NOTE, "盘上已经改过的内容"],
      [footprintsFilePath(VAULT), JSON.stringify(stored)],
    ]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    // 当天基线是「基线文本」,盘上内容 diff 出今天的记录
    await core.refreshAll(true);
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "盘上已经改过的内容", start: 1, end: 1 }]);
  });

  it("跨天 init:昨天基线作废,当天全库快照重轮转", async () => {
    const stored: StoredFootprints = { version: 1, day: "2026-09-29", baselines: { [NOTE]: "昨天的" } };
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

  it("损坏的元数据按从未轮转处理(全库重建基线)", async () => {
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

describe("FootprintCore 增量刷新(noteDirty)", () => {
  function seededCore(files: Map<string, string>, today = "2026-09-30") {
    const core = coreOf(files, today);
    return core.init().then(() => core);
  }

  it("脏路径防抖 1s 后 diff 出今日块", async () => {
    const files = new Map<string, string>([[NOTE, "基线段落"]]);
    const core = await seededCore(files);
    files.set(NOTE, "基线段落\n\n今天写的新段");
    core.noteDirty([NOTE]);
    expect(core.footprintsFor(NOTE)).toEqual([]); // 防抖期内不动
    await vi.advanceTimersByTimeAsync(1100);
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "今天写的新段", start: 3, end: 3 }]);
  });

  it("防抖期内多次喂入合并成一次刷新(只 diff 最终盘面)", async () => {
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

  it("Daily 目录与非笔记文件被过滤,零开销", async () => {
    const files = new Map<string, string>([[NOTE, "基线"]]);
    const core = await seededCore(files);
    core.noteDirty([`${VAULT}/Daily/2026-09-30.md`, `${VAULT}/x.png`, `${VAULT}/Daily/sub/a.md`]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(core.todayEntries()).toEqual([]);
  });

  it("文件被删除(读不到)时从索引移除", async () => {
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

  it("脏刷新用的基线在轮转后保持一致(昨日基线里的段不算新增)", async () => {
    const files = new Map<string, string>([[NOTE, "基线\n\n昨天写下的段"]]);
    const stored: StoredFootprints = {
      version: 1,
      day: "2026-09-29",
      baselines: { [NOTE]: "基线\n\n昨天写下的段" },
    };
    files.set(footprintsFilePath(VAULT), JSON.stringify(stored));
    const core = coreOf(files, "2026-09-29");
    await core.init(); // day=09-29,基线沿用存储值
    files.set(NOTE, "基线\n\n昨天写下的段\n\n今天写的段");
    core.noteDirty([NOTE]);
    await vi.advanceTimersByTimeAsync(1100);
    // 09-29 的基线视角:「昨天写下的段」在基线里,不算新增
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "今天写的段", start: 5, end: 5 }]);
  });

  it("installIndexForTest 替换索引并递增广播版本号", async () => {
    const { footprintRevision } = await import("./store");
    const files = new Map<string, string>([[NOTE, "基线"]]);
    const core = await seededCore(files);
    const before = footprintRevision();
    core.installIndexForTest(new Map([[NOTE, [{ text: "注入块", start: 1, end: 1 }]]]));
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "注入块", start: 1, end: 1 }]);
    expect(footprintRevision()).toBeGreaterThan(before);
  });
});

describe("FootprintCore 全量兜底(refreshAll)", () => {
  it("重建全部文件的索引,覆盖应用未运行期间的改动", async () => {
    const files = new Map<string, string>([[NOTE, "基线段落"]]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    // 应用没开着时的改动:盘面直接变,没有 watcher 事件
    files.set(NOTE, "基线段落\n\n离线写的新段");
    files.set(OTHER, "另一篇今天改的");
    await core.refreshAll();
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "离线写的新段", start: 3, end: 3 }]);
    expect(core.footprintsFor(OTHER)).toEqual([{ text: "另一篇今天改的", start: 1, end: 1 }]);
  });

  it("节流:5s 内重复调用不重扫(无变化也不广播)", async () => {
    const files = new Map<string, string>([[NOTE, "基线段落"]]);
    const core = coreOf(files, "2026-09-30");
    await core.init();
    await core.refreshAll();
    files.set(NOTE, "基线段落\n\n新段");
    await core.refreshAll(); // 被节流吞掉
    expect(core.footprintsFor(NOTE)).toEqual([]);
    await vi.advanceTimersByTimeAsync(5001);
    await core.refreshAll();
    expect(core.footprintsFor(NOTE)).toEqual([{ text: "新段", start: 3, end: 3 }]);
  });
});
