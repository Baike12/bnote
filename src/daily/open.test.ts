import { describe, expect, it } from "vitest";
import { dailyScaffold } from "./model";
import { openDailyNote, type OpenDailyDeps } from "./open";

/**
 * The contract of "open today's daily note":
 *  1. The daily note is not on disk -> create it with the same initial content as
 *     the sync engine (dailyScaffold), refresh the file tree, then open it;
 *  2. It is already on disk -> not a single byte is written (a daily note the user
 *     already has is never overwritten);
 *  3. The current file already is today's daily note -> consume the jump-back
 *     slot and jump to the source; every jump from outside a daily note
 *     overwrites the slot.
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
    },
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
    templatePath: () => null,
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

describe("新建日记的模板", () => {
  const TPL = "/v/Templates/日记.md";

  it("模板内容开篇,{{date}}/{{title}} 换成当天日期", async () => {
    const h = harness(
      { [TPL]: "# {{date}}\n\n## 计划\n- 早会\n" },
      { templatePath: () => "Templates/日记.md" },
    );
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe("# 2026-09-27\n\n## 计划\n- 早会\n");
  });

  it("模板与待办跟随叠加:待办区仍紧跟在首个 H1 之后", async () => {
    const h = harness(
      {
        "/v/Daily/2026-09-26.md": "# 前一天\n- [ ] 还没做完\n",
        [TPL]: "# {{title}}\n\n## 计划\n",
      },
      { templatePath: () => "Templates/日记.md" },
    );
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe(
      "# 2026-09-27\n\n- [ ] 还没做完\n\n## 计划\n",
    );
  });

  it("模板文件读不到:回落到默认 `# 日期`,不挡创建", async () => {
    const h = harness({}, { templatePath: () => "Templates/已删除.md" });
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe(dailyScaffold(DAY));
  });

  it("模板没有 H1:待办按引擎既有规则顶到文件最前", async () => {
    const h = harness(
      {
        "/v/Daily/2026-09-26.md": "# 前一天\n- [ ] 还没做完\n",
        [TPL]: "## 计划\n",
      },
      { templatePath: () => "Templates/日记.md" },
    );
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe("- [ ] 还没做完\n\n## 计划\n");
  });

  it("模板路径越出仓库(`..`):按未设置处理", async () => {
    const h = harness(
      { "/v/../secret.md": "# 不该读\n" },
      { templatePath: () => "../secret.md" },
    );
    await openDailyNote(h.deps);
    expect(h.written[0].content).toBe(dailyScaffold(DAY));
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

    await openDailyNote(h.deps); // already in the daily note: toggle
    expect(h.opened).toEqual([DAILY, note]);
    expect(h.back()).toBeNull(); // consuming clears the slot
    // Jumping back goes through open: of all the writes to disk only the first
    // jump, the one that creates the daily note, writes; the toggle itself puts
    // no byte on disk.
    expect(h.written).toEqual([{ path: DAILY, content: dailyScaffold(DAY) }]);
    expect(h.disk.get(note)).toBe("草稿\n");
  });

  it("toggle 来回反复:每次跳进都重记来源,toggle 语义可循环", async () => {
    const note = "/v/a.md";
    const h = harness({ [note]: "x\n", [DAILY]: "# d\n" });
    h.setCurrent(note);
    await openDailyNote(h.deps);
    await openDailyNote(h.deps); // back to the note
    await openDailyNote(h.deps); // into the daily note again
    await openDailyNote(h.deps); // back to the note again
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
