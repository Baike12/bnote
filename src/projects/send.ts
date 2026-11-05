import { EditorState } from "@codemirror/state";
import { findEditorFor } from "@/editor/api";
import { useAppStore } from "@/state/appStore";
import {
  blockLines,
  dailyPathFor,
  findEntryByText,
  isTodo,
  parseDailyRegion,
  parseListLine,
  prependEntrySpec,
  reindentBlock,
  textAfterChanges,
  todoText,
} from "@/daily/model";
import {
  dailyScaffoldWithRollover,
  SYNC_USER_EVENT,
  withFileLock,
  type DailyIO,
} from "@/daily/engine";
import { ensureLinks, scheduleLinksPersist } from "@/daily/links";
import { runtimeDeps } from "@/daily/runtime";

/**
 * Project todo -> the **front** of the todo region of today's daily note.
 *
 * This is a different intent from ⌘⇧J (which appends at the end, in chronological
 * order): sending or dragging from a project card means "do this one first
 * today", so the entry goes to the front. The shape on disk is the same as for the
 * quick capture (prependEntrySpec) and a `copied` link is created - from then on
 * the two sides mirror each other, and the project side shows "sent" because of it.
 *
 * When the daily note is open in an editor the in-memory document is patched (and
 * autosave writes it), the same discipline as in captureTodo: writing to disk
 * would let the stale content of the editor overwrite that entry on the next save.
 */

export type SendTodoResult = "sent" | "already" | "not-todo" | "no-vault" | "no-source";

export interface SendTodoTarget {
  /** Absolute path of the source project file. */
  srcPath: string;
  /** 1-based line number. */
  line: number;
}

function newLinkId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface SendTodoDeps {
  io: DailyIO;
  vaultRoot: () => string | null;
  today: () => string;
  toast: (msg: string) => void;
  /** Template file used to scaffold a new daily note (vault-relative path); empty = the default `# YYYY-MM-DD` opening. */
  templatePath: () => string | null;
}

export async function sendTodoToTodayFront(
  target: SendTodoTarget,
  deps: SendTodoDeps = runtimeDeps(),
): Promise<SendTodoResult> {
  const vaultRoot = deps.vaultRoot();
  if (!vaultRoot) return "no-vault";
  const store = await ensureLinks(vaultRoot);
  const today = deps.today();
  const dailyPath = dailyPathFor(vaultRoot, today);

  // Source document: when an editor holds this project file the in-memory document
  // is used (the latest edits are not on disk yet).
  const srcView = findEditorFor(target.srcPath);
  const srcText = srcView ? srcView.state.doc.toString() : await deps.io.readFile(target.srcPath);
  if (srcText === null) return "no-source";

  const sdoc = EditorState.create({ doc: srcText }).doc;
  const lineNo = Math.min(Math.max(1, target.line), sdoc.lines);
  const parsed = parseListLine(sdoc.line(lineNo).text);
  if (!isTodo(parsed) || todoText(parsed) === "") return "not-todo";
  const text = todoText(parsed);
  const block = reindentBlock(blockLines(sdoc, lineNo), parsed.indent.length, "");

  let dailyLine = 1;
  let inserted = false;
  let createdDaily = false;

  const dailyView = findEditorFor(dailyPath);
  if (dailyView) {
    const doc = dailyView.state.doc;
    const region = parseDailyRegion(doc);
    const existing = findEntryByText(doc, region, text, 0);
    if (existing) {
      dailyLine = existing.start;
    } else {
      const spec = prependEntrySpec(doc, region, block);
      dailyView.dispatch({ changes: spec.change, userEvent: SYNC_USER_EVENT });
      dailyLine = spec.entry.start;
      inserted = true;
    }
  } else {
    await withFileLock(dailyPath, async () => {
      let raw = await deps.io.readFile(dailyPath);
      if (raw === null) {
        raw = await dailyScaffoldWithRollover(deps.io, vaultRoot, today, deps.templatePath());
        createdDaily = true;
      }
      const doc = EditorState.create({ doc: raw }).doc;
      const region = parseDailyRegion(doc);
      const existing = findEntryByText(doc, region, text, 0);
      if (existing) {
        dailyLine = existing.start;
        return;
      }
      const spec = prependEntrySpec(doc, region, block);
      await deps.io.writeFile(dailyPath, textAfterChanges(raw, [spec.change]));
      dailyLine = spec.entry.start;
      inserted = true;
    });
  }

  // When it is already mapped for today only the anchor line numbers are updated,
  // otherwise a `copied` link is created. The per-day ownership is the same as for
  // ⌘⇧J: the entry sent yesterday does not count as synced today.
  const own = store.forFile(dailyPath).find((l) => l.srcPath === target.srcPath && l.text === text);
  if (own) {
    store.update(own.id, { dailyLine, srcLine: lineNo, day: today });
  } else {
    store.upsert({
      id: newLinkId(),
      kind: "copied",
      day: today,
      srcPath: target.srcPath,
      dailyPath,
      text,
      srcLine: lineNo,
      dailyLine,
    });
  }
  scheduleLinksPersist();

  if (createdDaily) {
    // The first creation of today's daily note: the sidebar and the quick jump
    // have to see this file.
    void import("@/app/actions").then((m) => m.refreshTree()).catch(() => undefined);
  }
  return inserted ? "sent" : "already";
}

/** Send and give a user visible result hint (shared by the command and the drag). */
export async function sendTodoWithToast(target: SendTodoTarget): Promise<void> {
  const result = await sendTodoToTodayFront(target);
  const toast = useAppStore.getState().showToast;
  if (result === "sent") toast("已发送到今日日记最前");
  else if (result === "already") toast("已在今日日记中,自动保持同步");
  else if (result === "not-todo") toast("光标行不是待办");
  else if (result === "no-vault") toast("没有打开仓库");
  else toast("读不到项目文件");
}
