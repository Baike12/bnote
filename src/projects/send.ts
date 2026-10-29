import { EditorState } from "@codemirror/state";
import { findEditorFor } from "@/editor/api";
import { todayStamp } from "@/editor/ops";
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
import { tauriIO } from "@/daily/runtime";

/**
 * 项目待办 → 今日日记待办区**最前面**。
 *
 * 与 ⌘⇧J(加到末尾、按时间顺序)是两条不同的意图:项目卡片的发送/拖拽是
 * 「今天先干这条」,所以插在最前。落地形状与快速待办相同(prependEntrySpec),
 * 建立的是 copied 映射——两侧从此双向镜像,项目侧据此显示「已发送」。
 *
 * 日记正被某个编辑器打开时就地改内存(交给自动保存),与 captureTodo 同一纪律:
 * 写盘会让编辑器里的旧内容在下一次保存时把那一条覆盖掉。
 */

export type SendTodoResult = "sent" | "already" | "not-todo" | "no-vault" | "no-source";

export interface SendTodoTarget {
  /** 源项目文件绝对路径。 */
  srcPath: string;
  /** 1 基行号。 */
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
}

export async function sendTodoToTodayFront(
  target: SendTodoTarget,
  deps: SendTodoDeps = {
    io: tauriIO,
    vaultRoot: () => useAppStore.getState().vaultPath,
    today: () => todayStamp(),
    toast: (msg) => useAppStore.getState().showToast(msg),
  },
): Promise<SendTodoResult> {
  const vaultRoot = deps.vaultRoot();
  if (!vaultRoot) return "no-vault";
  const store = await ensureLinks(vaultRoot);
  const today = deps.today();
  const dailyPath = dailyPathFor(vaultRoot, today);

  // 源文档:编辑器正装着这份项目文件时用内存(最新的那几笔还没落盘)。
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
        raw = await dailyScaffoldWithRollover(deps.io, vaultRoot, today);
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

  // 当天已映射就只更新锚点行号;否则建一条 copied 映射。按日归属与 ⌘⇧J 一致:
  // 昨天发出去的那条不算今天已同步。
  const own = store
    .forFile(dailyPath)
    .find((l) => l.srcPath === target.srcPath && l.text === text);
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
    // 第一次创建今日日记:侧栏/快速跳转要能看到这份文件。
    void import("@/app/actions").then((m) => m.refreshTree()).catch(() => undefined);
  }
  return inserted ? "sent" : "already";
}

/** 发送并给出用户可见的结果提示(命令与拖拽共用)。 */
export async function sendTodoWithToast(target: SendTodoTarget): Promise<void> {
  const result = await sendTodoToTodayFront(target);
  const toast = useAppStore.getState().showToast;
  if (result === "sent") toast("已发送到今日日记最前");
  else if (result === "already") toast("已在今日日记中,自动保持同步");
  else if (result === "not-todo") toast("光标行不是待办");
  else if (result === "no-vault") toast("没有打开仓库");
  else toast("读不到项目文件");
}
