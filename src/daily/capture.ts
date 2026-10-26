import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getView } from "@/editor/api";
import { documentPath } from "@/editor/docPath";
import { todayStamp } from "@/editor/ops";
import { useAppStore } from "@/state/appStore";
import { dailyScaffoldWithRollover, withFileLock, type DailyIO } from "./engine";
import { dailyPathFor, parseDailyRegion, prependEntrySpec, textAfterChanges } from "./model";
import { tauriIO } from "./runtime";

/**
 * 快速待办:输入一行文字,直接落进今日日记待办区的最前方。
 *
 * 日记不存在时走 dailyScaffoldWithRollover——与「打开今日日记 / 发送待办」
 * 同一个创建入口,上一篇的未完成待办会自动跟随过来。日记正开在编辑器里时
 * 不写盘,而是改内存文档交给自动保存:否则未落盘的编辑会覆盖掉刚写的内容。
 */

export interface CaptureTodoDeps {
  vaultRoot: () => string | null;
  today: () => string;
  io: DailyIO;
  view: () => EditorView | null;
  currentFile: () => string | null;
  refresh: () => Promise<void>;
  toast: (msg: string) => void;
}

/** 输入 → 日记里的待办行:已是 checkbox 行就原样用,多行折成一行。 */
export function formatTodoLine(raw: string): string | null {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
  if (!text) return null;
  return /^[-*+]\s+\[[ xX]\]\s+/.test(text) ? text : `- [ ] ${text}`;
}

/** 纯文本插入:返回新文本与待办所在行号(1 基)。 */
export function insertTodoAtFront(base: string, todoLine: string): { text: string; line: number } {
  const doc = EditorState.create({ doc: base }).doc;
  const spec = prependEntrySpec(doc, parseDailyRegion(doc), [todoLine]);
  return { text: textAfterChanges(base, [spec.change]), line: spec.entry.start };
}

/** 返回写入的日记路径;空输入或没有仓库时返回 null。 */
export async function captureTodo(
  raw: string,
  deps: CaptureTodoDeps,
): Promise<string | null> {
  const todo = formatTodoLine(raw);
  if (!todo) return null;
  const vaultRoot = deps.vaultRoot();
  if (!vaultRoot) {
    deps.toast("没有打开仓库");
    return null;
  }
  const day = deps.today();
  const path = dailyPathFor(vaultRoot, day);
  const view = deps.view();
  if (
    view &&
    view.dom.isConnected &&
    deps.currentFile() === path &&
    documentPath(view.state) === path
  ) {
    const spec = prependEntrySpec(view.state.doc, parseDailyRegion(view.state.doc), [todo]);
    view.dispatch({ changes: spec.change, userEvent: "input.bnote-quick-todo" });
    deps.toast("已加入今日日记");
    return path;
  }
  return withFileLock(path, async () => {
    const existing = await deps.io.readFile(path);
    const created = existing === null;
    const base = existing === null
      ? await dailyScaffoldWithRollover(deps.io, vaultRoot, day)
      : existing;
    const doc = EditorState.create({ doc: base }).doc;
    const spec = prependEntrySpec(doc, parseDailyRegion(doc), [todo]);
    await deps.io.writeFile(path, textAfterChanges(base, [spec.change]));
    if (created) await deps.refresh();
    deps.toast(created ? "已创建今日日记并加入待办" : "已加入今日日记");
    return path;
  });
}

/** 应用运行期的依赖:当前仓库 / 今天 / 单个编辑器实例 / toast。 */
export function captureTodoToToday(raw: string): Promise<string | null> {
  return captureTodo(raw, {
    vaultRoot: () => useAppStore.getState().vaultPath,
    today: () => todayStamp(),
    io: tauriIO,
    view: () => getView(),
    currentFile: () => useAppStore.getState().currentFile,
    refresh: async () => {
      const { refreshTree } = await import("@/app/actions");
      await refreshTree();
    },
    toast: (msg) => useAppStore.getState().showToast(msg),
  });
}
