import { useAppStore } from "@/state/appStore";
import type { DailyIO } from "./engine";
import { dailyScaffoldWithRollover } from "./engine";
import { dailyPathFor } from "./model";
import { runtimeDeps } from "./runtime";

/**
 * "Open today's daily note". The file name follows the existing convention
 * (`<vault>/Daily/YYYY-MM-DD.md`) and the file is created when it does not exist -
 * the initial content is the bare scaffold plus the unfinished todos of the previous
 * note (todo rollover, see engine.dailyScaffoldWithRollover), so the files created
 * by the three entry points ⌘⇧O, ⌘⇧J and check-and-record are byte-identical.
 *
 * Toggle semantics: when the current file already is today's daily note, it does
 * not open itself but consumes the jump-back slot (`dailyBackFrom`) to return to
 * the file it came from; pressing ⌘⇧O in a non-daily file records the source
 * first and then jumps. The slot is overwritten on every jump, so the landing
 * point is always the file that was open before the most recent ⌘⇧O jump.
 *
 * The reason for dependency injection is the same as in the engine: the disk and
 * "open a file" are the outside world, and injecting fakes in tests lets them
 * assert what content was created and which path was opened.
 */
export interface OpenDailyDeps {
  vaultRoot: () => string | null;
  today: () => string;
  io: DailyIO;
  open: (path: string) => Promise<void>;
  /** Refresh the file tree after creating a daily note, otherwise the sidebar only picks the file up on the next watcher event. */
  refresh: () => Promise<void>;
  toast: (msg: string) => void;
  currentFile: () => string | null;
  getDailyBack: () => string | null;
  setDailyBack: (path: string | null) => void;
  /** Template file used to scaffold a new daily note (vault-relative path); empty = the default `# YYYY-MM-DD` opening. */
  templatePath: () => string | null;
}

/** Returns the path of the daily note that was opened; null when no vault is open. */
export async function openDailyNote(deps: OpenDailyDeps): Promise<string | null> {
  const vaultRoot = deps.vaultRoot();
  if (!vaultRoot) {
    deps.toast("没有打开仓库");
    return null;
  }
  const day = deps.today();
  const path = dailyPathFor(vaultRoot, day);
  // Pressing ⌘⇧O inside a daily note means jump back: do not open itself and do
  // not record the source again.
  if (deps.currentFile() === path) {
    const back = deps.getDailyBack();
    deps.setDailyBack(null);
    if (!back) {
      deps.toast("没有可跳回的文件");
      return path;
    }
    // The source file may have been deleted or moved away: when it cannot be read
    // do not jump, and let the toast say why.
    if ((await deps.io.readFile(back)) === null) {
      deps.toast("跳回的文件已不存在");
      return path;
    }
    await deps.open(back);
    return path;
  }
  const current = deps.currentFile();
  if (current) deps.setDailyBack(current);
  // Only a failed read (file missing) means the file is absent: content already on
  // disk is never touched, we just open it.
  if ((await deps.io.readFile(path)) === null) {
    await deps.io.writeFile(
      path,
      await dailyScaffoldWithRollover(deps.io, vaultRoot, day, deps.templatePath()),
    );
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
