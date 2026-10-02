import { describe, expect, it } from "vitest";
import { dailyScaffold } from "./model";
import { openDailyNote, type OpenDailyDeps } from "./open";
import { LinkStore } from "./links";

/**
 * 「打开今日日记」的契约:
 *  1. 盘上没有这份日记 → 按同步引擎同一份初始内容建出来(dailyScaffold),刷新
 *     文件树,再打开;
 *  2. 盘上已有 → 一个字节都不写(绝不覆盖用户已有的日记);
 *  3. 当前文件就是今日日记 → 消费跳回槽跳回来源;每次非日记内的跳转都覆盖槽。
 */

const DAY = "2026-09-27";
const DAILY = `/v/Daily/${DAY}.md`;

function harness(files: Record<string, string> = {}, over: Partial<OpenDailyDeps> = {}) {
  const disk = new Map(Object.entries(files));
  const written: { path: string; content: string }[] = [];
  const opened: string[] = [];
  let refreshed = 0;
  const toasts: string[] = [];
  let current: string | null = null;
  let dailyBack: string | null = null;
  const deps: OpenDailyDeps = {
    vaultRoot: () => "/v",
    today: () => DAY,
    io: {
      readFile: async (p) => disk.get(p) ?? null,
      writeFile: async (p, c) => {
        disk.set(p, c);
        written.push({ path: p, content: c });
      },
      readDir: async (relPath) => {
        const prefix = `/v/${relPath}/`;
        return [...disk.keys()]
          .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map((k) => k.slice(prefix.length));
      },
      listFiles: async () => [...disk.keys()].map((k) => k.slice("/v/".length)),
    },
    loadLinks: async () => new LinkStore(),
    open: async (p) => {
      opened.push(p);
      current = p;
    },
    refresh: async () => {
      refreshed++;
    },
    toast: (m) => toasts.push(m),
    currentFile: () => current,
    getDailyBack: () => dailyBack,
    setDailyBack: (p) => {
      dailyBack = p;
    },
    ...over,
  };
  return {
    deps,
    disk,
    written,
    opened,
    toasts,
    stats: () => ({ refreshed }),
    setCurrent: (p: string | null) => {
      current = p;
    },
    back: () => dailyBack,
  };
}

describe("打开今日日记", () => {
  it("缺文件时按引擎同款初始内容建出来,刷新文件树后打开", async () => {
    const h = harness();
    expect(await openDailyNote(h.deps)).toBe(DAILY);
    expect(h.written).toEqual([{ path: DAILY, content: dailyScaffold(DAY) }]);
    expect(h.written[0].content).toBe(`# ${DAY}\n`);
    expect(h.stats().refreshed).toBe(1);
    expect(h.opened).toEqual([DAILY]);
  });

  it("已有日记时不写盘、不刷新,只打开", async () => {
    const existing = `# ${DAY}\n- [ ] 已有一条\n`;
    const h = harness({ [DAILY]: existing });
    expect(await openDailyNote(h.deps)).toBe(DAILY);
    expect(h.written).toEqual([]);
    expect(h.stats().refreshed).toBe(0);
    expect(h.disk.get(DAILY)).toBe(existing);
    expect(h.opened).toEqual([DAILY]);
  });

  it("没有打开的仓库:提示且不开文件", async () => {
    const h = harness({}, { vaultRoot: () => null });
    expect(await openDailyNote(h.deps)).toBeNull();
    expect(h.toasts).toEqual(["没有打开仓库"]);
    expect(h.opened).toEqual([]);
  });

  it("日记路径沿用现有命名(Daily/YYYY-MM-DD.md)", async () => {
    const h = harness();
    await openDailyNote(h.deps);
    expect(h.opened[0].endsWith("/Daily/2026-09-27.md")).toBe(true);
  });
});

describe("新建日记的待办跟随", () => {
  const PREV = "/v/Daily/2026-09-26.md";

  it("上一篇的未完成待办(保层级)进新日记,已完成叶子不跟、锚链保留", async () => {
    const h = harness({
      [PREV]: [
        "# 1 2026-09-26",
        "- [x] 已完成的事 ✅ 2026-09-26",
        "- [ ] 还没做完",
        "  - [x] 中间步骤 ✅ 2026-09-26",
        "    - [ ] 剩下的子项",
      ].join("\n"),
    });
    expect(await openDailyNote(h.deps)).toBe(DAILY);
    expect(h.written[0].content).toBe(
      "# 2026-09-27\n\n- [ ] 还没做完\n  - [x] 中间步骤 ✅ 2026-09-26\n    - [ ] 剩下的子项\n",
    );
  });

  it("取最近一篇而不是严格昨天:隔了几天也跟", async () => {
    const h = harness({ "/v/Daily/2026-09-24.md": "# d\n- [ ] 前几天没做完\n" });
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe("# 2026-09-27\n\n- [ ] 前几天没做完\n");
  });

  it("Daily 目录列不到:裸 scaffold,跟随失败不挡创建", async () => {
    const h = harness();
    h.deps.io = { ...h.deps.io, readDir: async () => null };
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe(dailyScaffold(DAY));
  });
});

describe("打开日记触发每日待办聚合", () => {
  /** sweptKey 以 vault::day 占位,这里用与默认夹具不同的日期避开污染。 */
  it("其他文件的未完成待办自动进头部(已完成叶子过滤),链接 kind=auto", async () => {
    const day = "2026-09-25";
    const daily = `/v/Daily/${day}.md`;
    const h = harness(
      {
        "/v/Notes/proj.md": "# proj\n\n- [x] 完成的 ✅ 2026-09-26\n- [ ] 项目待办\n  - [ ] 子项\n",
        "/v/Notes/other.md": "- [ ] 另一个文件\n",
      },
      { today: () => day },
    );
    const store = new LinkStore();
    h.deps.loadLinks = async () => store;
    expect(await openDailyNote(h.deps)).toBe(daily);
    expect(h.disk.get(daily)).toBe(`# ${day}\n\n- [ ] 项目待办\n  - [ ] 子项\n- [ ] 另一个文件\n`);
    expect(h.written.map((w) => w.path)).toEqual([daily, daily]); // 建档一次 + 聚合一次
    expect(store.all()).toHaveLength(2);
    expect(store.all()[0]).toMatchObject({ kind: "auto", text: "项目待办", srcPath: "/v/Notes/proj.md" });
  });

  it("聚合失败不挡打开", async () => {
    const day = "2026-09-26";
    const daily = `/v/Daily/${day}.md`;
    const h = harness({ "/v/p.md": "- [ ] 甲\n" }, { today: () => day });
    h.deps.loadLinks = async () => {
      throw new Error("库坏了");
    };
    expect(await openDailyNote(h.deps)).toBe(daily);
    expect(h.written[0].content).toBe(dailyScaffold(day));
  });
});

describe("日记内再按 ⌘⇧O:跳回跳转前的文件", () => {
  it("从笔记跳进日记会记录来源;日记内再按跳回来源,来源文件原样不动", async () => {
    const note = "/v/Job/ideas.md";
    const h = harness({ [note]: "草稿\n" });
    h.setCurrent(note);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([DAILY]);
    expect(h.back()).toBe(note);

    await openDailyNote(h.deps); // 已在日记:toggle
    expect(h.opened).toEqual([DAILY, note]);
    expect(h.back()).toBeNull(); // 消费即清空
    // 跳回走的是 open:全部写盘只有第一跳建日记那一次,toggle 自己不落任何字节。
    expect(h.written).toEqual([{ path: DAILY, content: dailyScaffold(DAY) }]);
    expect(h.disk.get(note)).toBe("草稿\n");
  });

  it("toggle 来回反复:每次跳进都重记来源,toggle 语义可循环", async () => {
    const note = "/v/a.md";
    const h = harness({ [note]: "x\n", [DAILY]: "# d\n" });
    h.setCurrent(note);
    await openDailyNote(h.deps);
    await openDailyNote(h.deps); // 回 note
    await openDailyNote(h.deps); // 再进日记
    await openDailyNote(h.deps); // 再回 note
    expect(h.opened).toEqual([DAILY, note, DAILY, note]);
  });

  it("无来源时在日记内再按:提示且不跳", async () => {
    const h = harness({ [DAILY]: "# d\n" });
    h.setCurrent(DAILY);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([]);
    expect(h.toasts).toEqual(["没有可跳回的文件"]);
  });

  it("来源文件已被删除:提示且不跳,槽照常清空", async () => {
    const h = harness({ [DAILY]: "# d\n" });
    h.setCurrent("/v/gone.md");
    await openDailyNote(h.deps);
    h.setCurrent(DAILY);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([DAILY]);
    expect(h.toasts).toEqual(["跳回的文件已不存在"]);
    expect(h.back()).toBeNull();
  });

  it("来源换成另一篇日记(昨天)也照记:跳回落点是它", async () => {
    const yesterday = "/v/Daily/2026-09-26.md";
    const h = harness({ [DAILY]: "# d\n", [yesterday]: "# 前一天\n" });
    h.setCurrent(yesterday);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([DAILY]);
    await openDailyNote(h.deps);
    expect(h.opened).toEqual([DAILY, yesterday]);
  });

  it("在日记内但来源槽为空时,不会把日记自己记成来源", async () => {
    const h = harness({ [DAILY]: "# d\n" });
    h.setCurrent(DAILY);
    await openDailyNote(h.deps);
    expect(h.back()).toBeNull();
  });
});
