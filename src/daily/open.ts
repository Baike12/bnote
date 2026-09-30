import { useAppStore } from "@/state/appStore";
import type { DailyIO } from "./engine";
import { dailyPathFor, dailyScaffold } from "./model";
import { runtimeDeps } from "./runtime";

/**
 * 「打开今日日记」。日记文件名沿用现有约定(`<vault>/Daily/YYYY-MM-DD.md`),
 * 不存在就按同步引擎的初始内容(`# YYYY-MM-DD`)建出来——⌘⇧O 与 ⌘⇧J 于是
 * 落到同一个文件、同一份形状上,谁先按都不会建出不一样的东西。
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
    await deps.io.writeFile(path, dailyScaffold(day));
    await deps.refresh();
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
    });
  } catch (e) {
    useAppStore.getState().showToast(`打开日记失败: ${String(e)}`);
  }
}
