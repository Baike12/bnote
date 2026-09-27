import { describe, expect, it } from "vitest";
import { dailyScaffold } from "./model";
import { openDailyNote, type OpenDailyDeps } from "./open";

/**
 * 「打开今日日记」的两条契约:
 *  1. 盘上没有这份日记 → 按同步引擎同一份初始内容建出来(dailyScaffold),刷新
 *     文件树,再打开;
 *  2. 盘上已有 → 一个字节都不写(绝不覆盖用户已有的日记)。
 */

const DAY = "2026-09-27";
const DAILY = `/v/Daily/${DAY}.md`;

function harness(files: Record<string, string> = {}, over: Partial<OpenDailyDeps> = {}) {
  const disk = new Map(Object.entries(files));
  const written: { path: string; content: string }[] = [];
  const opened: string[] = [];
  let refreshed = 0;
  const toasts: string[] = [];
  const deps: OpenDailyDeps = {
    vaultRoot: () => "/v",
    today: () => DAY,
    io: {
      readFile: async (p) => disk.get(p) ?? null,
      writeFile: async (p, c) => {
        disk.set(p, c);
        written.push({ path: p, content: c });
      },
    },
    open: async (p) => {
      opened.push(p);
    },
    refresh: async () => {
      refreshed++;
    },
    toast: (m) => toasts.push(m),
    ...over,
  };
  return { deps, disk, written, opened, toasts, stats: () => ({ refreshed }) };
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
