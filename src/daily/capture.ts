import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getView } from "@/editor/api";
import { documentPath } from "@/editor/docPath";
import { useAppStore } from "@/state/appStore";
import { dailyScaffoldWithRollover, withFileLock, type DailyIO } from "./engine";
import { dailyPathFor, parseDailyRegion, prependEntrySpec, textAfterChanges } from "./model";
import { runtimeDeps } from "./runtime";

/**
 * Quick todo: type one line and it lands at the front of today's daily note todo
 * region.
 *
 * When the daily note does not exist yet we go through dailyScaffoldWithRollover -
 * the same creation entry point as "open today's daily note" and "send todo" - so
 * the unfinished todos of the previous note roll over. When the daily note is open
 * in the editor we do not write to disk: we patch the in-memory document and let
 * autosave flush it, otherwise the unsaved edits would overwrite what we just
 * wrote.
 */

export interface CaptureTodoDeps {
  vaultRoot: () => string | null;
  today: () => string;
  io: DailyIO;
  view: () => EditorView | null;
  currentFile: () => string | null;
  refresh: () => Promise<void>;
  toast: (msg: string) => void;
  /** Template file used to scaffold a new daily note (vault-relative path); empty = the default `# YYYY-MM-DD` opening. */
  templatePath: () => string | null;
}

/** Input -> the todo line for the daily note: a line that is already a checkbox is taken as is, multiple lines are folded into one. */
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

/** Plain text insertion: returns the new text and the line the todo landed on (1-based). */
export function insertTodoAtFront(base: string, todoLine: string): { text: string; line: number } {
  const doc = EditorState.create({ doc: base }).doc;
  const spec = prependEntrySpec(doc, parseDailyRegion(doc), [todoLine]);
  return { text: textAfterChanges(base, [spec.change]), line: spec.entry.start };
}

/** Returns the path of the daily note that was written; null for empty input or when no vault is open. */
export async function captureTodo(raw: string, deps: CaptureTodoDeps): Promise<string | null> {
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
    const base =
      existing === null
        ? await dailyScaffoldWithRollover(deps.io, vaultRoot, day, deps.templatePath())
        : existing;
    const doc = EditorState.create({ doc: base }).doc;
    const spec = prependEntrySpec(doc, parseDailyRegion(doc), [todo]);
    await deps.io.writeFile(path, textAfterChanges(base, [spec.change]));
    if (created) await deps.refresh();
    deps.toast(created ? "已创建今日日记并加入待办" : "已加入今日日记");
    return path;
  });
}

/** Runtime dependencies of the app: current vault / today / a single editor instance / toast. */
export function captureTodoToToday(raw: string): Promise<string | null> {
  return captureTodo(raw, {
    ...runtimeDeps(),
    view: () => getView(),
    currentFile: () => useAppStore.getState().currentFile,
    refresh: async () => {
      const { refreshTree } = await import("@/app/actions");
      await refreshTree();
    },
  });
}
