import { useAppStore } from "@/state/appStore";
import type { DailyIO } from "./engine";
import { dailyScaffoldWithRollover, sweepTodosToDaily } from "./engine";
import { dailyPathFor } from "./model";
import { runtimeDeps } from "./runtime";
import { ensureLinks, peekLinks, type LinkStore } from "./links";

/**
 * 「打开今日日记」。日记文件名沿用现有约定(`<vault>/Daily/YYYY-MM-DD.md`),
 * 不存在就建出来——初始内容是裸 scaffold 加上一篇日记的未完成待办(待办
 * 跟随,见 engine.dailyScaffoldWithRollover),⌘⇧O、⌘⇧J、勾选记录三个入口
 * 建出的文件因此逐字节一致。文件就位后再做一次**每日待办聚合**
 * (sweepTodosToDaily,同仓同日只扫一遍):全仓库的未完成待办自动链接进
 * 头部,不需要按快捷键。
 *
 * Toggle 语义:当前文件已是今日日记时,不再打开自己,而是消费跳回槽
 * (`dailyBackFrom`)回到跳进日记之前的那个文件;非日记文件按 ⌘⇧O 则先记录
 * 来源再跳。槽每次跳转都覆盖,所以落点永远是「最近一次 ⌘⇧O 跳转前」的文件。
 *
 * 依赖注入的理由与 engine 相同:磁盘与「打开文件」都是外部世界,测试注入假的
 * 就能断言「建了什么内容、开了哪个路径」。
 */
export interface OpenDailyDeps {
  vaultRoot: () => string | null;
  today: () => string;
  io: DailyIO;
  open: (path: string) => Promise<void>;
  /** 新建日记后刷新文件树,否则侧栏要等下一次 watcher 事件才认这份文件。 */
  refresh: () => Promise<void>;
  toast: (msg: string) => void;
  currentFile: () => string | null;
  getDailyBack: () => string | null;
  setDailyBack: (path: string | null) => void;
  /** 链接库(每日聚合要用);尚未加载/没有仓库时返回 null,聚合跳过。 */
  loadLinks: () => Promise<LinkStore | null>;
}

/** 返回打开的日记路径;没有仓库时返回 null。 */
export async function openDailyNote(deps: OpenDailyDeps): Promise<string | null> {
  const vaultRoot = deps.vaultRoot();
  if (!vaultRoot) {
    deps.toast("没有打开仓库");
    return null;
  }
  const day = deps.today();
  const path = dailyPathFor(vaultRoot, day);
  // 日记内再按 ⌘⇧O = 跳回,不打开自己、也不重记来源。
  if (deps.currentFile() === path) {
    const back = deps.getDailyBack();
    deps.setDailyBack(null);
    if (!back) {
      deps.toast("没有可跳回的文件");
      return path;
    }
    // 来源文件可能已被删/移走:读不到就不跳,toast 说清原因。
    if ((await deps.io.readFile(back)) === null) {
      deps.toast("跳回的文件已不存在");
      return path;
    }
    await deps.open(back);
    return path;
  }
  const current = deps.currentFile();
  if (current) deps.setDailyBack(current);
  // 读失败(不存在)才算缺文件:盘上已有内容一律不动,只打开。
  if ((await deps.io.readFile(path)) === null) {
    await deps.io.writeFile(path, await dailyScaffoldWithRollover(deps.io, vaultRoot, day));
    await deps.refresh();
  }
  // 每日待办聚合:全仓库的未完成待办自动进头部(同仓同日只扫一遍,失败不挡打开)。
  const links = await deps.loadLinks().catch(() => null);
  if (links) {
    try {
      await sweepTodosToDaily(deps.io, vaultRoot, day, links);
    } catch {
      // 聚合是增强:失败就等下一次打开/编辑驱动收敛
    }
  }
  await deps.open(path);
  return path;
}

export async function openTodayDailyNote(): Promise<void> {
  try {
    const { openNote, refreshTree } = await import("@/app/actions");
    await openDailyNote({
      ...runtimeDeps(),
      open: openNote,
      refresh: refreshTree,
      currentFile: () => useAppStore.getState().currentFile,
      getDailyBack: () => useAppStore.getState().dailyBackFrom,
      setDailyBack: (p) => useAppStore.getState().setDailyBackFrom(p),
      loadLinks: async () => {
        const vault = useAppStore.getState().vaultPath;
        if (!vault) return null;
        return peekLinks(vault) ?? (await ensureLinks(vault));
      },
    });
  } catch (e) {
    useAppStore.getState().showToast(`打开日记失败: ${String(e)}`);
  }
}
