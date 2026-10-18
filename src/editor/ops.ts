import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { EditorState, Text } from "@codemirror/state";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { indentUnit, syntaxTreeAvailable } from "@codemirror/language";
import { fenceStateScan, getContextAt, insideFencedCode, insideFencedCodeByScan, mathRegions } from "./context";
import { calloutRegions, type CalloutRegion } from "./callout";
import { anchorRegionAt } from "./calloutAnchor";
import { takeVimVisual } from "./vim/vim";
import { readClipboardText, writeClipboardText } from "@/lib/clipboard";
import { useAppStore } from "@/state/appStore";

/** Text-editing operations shared by commands and keybindings. */

const BULLET_ITEM_RE = /^([ \t]*)([-*+])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;
const ORDERED_ITEM_RE = /^([ \t]*)(\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;

const LEADING_WS_RE = /^[ \t]*/;

type Edit = { from: number; to: number; insert: string };

/** One indent level, written the way the line already is: a single tab for
 *  tab-indented lines, otherwise one indent unit (the same step Shift-Tab
 *  removes). */
function dedentOneLevel(indent: string, unit: string): string {
  if (indent.startsWith("\t")) return indent.slice(1);
  return indent.slice(Math.min(unit.length, indent.length));
}

/** Number for an ordered item that just moved up to `indent`: one past the
 *  nearest preceding sibling at that level, or 1 when there is none. A blank
 *  line, a shallower line or a non-list line ends the walk — the list is over. */
function orderedNumberAtLevel(doc: Text, lineNo: number, indent: string): number {
  for (let n = lineNo - 1; n >= 1; n--) {
    const text = doc.line(n).text;
    if (text.trim() === "") break;
    const lead = LEADING_WS_RE.exec(text)![0];
    if (lead.length < indent.length) break;
    if (lead.length > indent.length) continue; // deeper: a child of the previous item
    if (lead !== indent) break;
    const m = ORDERED_ITEM_RE.exec(text);
    if (!m) break;
    return parseInt(m[2], 10) + 1;
  }
  return 1;
}

/** Renumbers the ordered siblings after `lineNo` so the list stays sequential
 *  once a new item took number `number`. Only items already sitting in exactly
 *  that slot are rewritten — hand-written `1. 1. 1.` or deliberately
 *  out-of-order lists are left alone, the same rule lang-markdown's
 *  renumberList uses. */
function bumpFollowingOrdered(
  doc: Text,
  lineNo: number,
  indent: string,
  number: number,
  delim: string,
  out: Edit[],
): void {
  let want = number;
  for (let n = lineNo + 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (text.trim() === "") break;
    const lead = LEADING_WS_RE.exec(text)![0];
    if (lead.length < indent.length) break;
    if (lead.length > indent.length) continue;
    if (lead !== indent) break;
    const m = ORDERED_ITEM_RE.exec(text);
    if (!m || m[2].slice(-1) !== delim) break;
    if (parseInt(m[2], 10) !== want) break;
    const at = doc.line(n).from + lead.length;
    out.push({ from: at, to: at + m[2].length, insert: String(want + 1) + delim });
    want++;
  }
}

/**
 * Enter on a list line, bnote-style: keep the item's EXACT leading whitespace
 * and repeat the marker (fresh unchecked box for todos, next number for ordered
 * lists) so nested items stay aligned. lang-markdown's
 * insertNewlineContinueMarkup would expand tab indentation to spaces
 * (countColumn), which livePreview then renders as a much deeper indent than
 * the tab-indented siblings — and its empty-item handling leaves stray blank
 * lines behind. Everything is handled here instead, identically for bullets,
 * todos and ordered lists:
 *
 *   Enter on a non-empty item        → new sibling at the same level
 *   Enter on an empty nested item    → drop one level (marker kept)
 *   Enter on an empty top-level item → leave the list (marker stripped)
 *
 * A cursor sitting on the marker (e.g. right after toggling the checkbox)
 * continues the item from its end, and a cursor before the marker opens a blank
 * line above. Non-list lines, blockquotes and non-markdown contexts fall
 * through to insertNewlineContinueMarkup.
 */
export function enterContinueListItem(view: EditorView): boolean {
  const state = view.state;
  const indentUnitText = state.facet(indentUnit);
  // 多光标时不做序号顺延：changeByRange 把各 range 的改动都当起始文档坐标合成，
  // 顺延改动可能落进另一个光标的编辑范围，合成结果会错乱（主编辑本身仍在各自
  // 行内，互不重叠）。
  const renumber = state.selection.ranges.length === 1;
  let handledAll = true;
  const changes = state.changeByRange((range) => {
    const unhandled = () => {
      handledAll = false;
      return { range };
    };
    if (!range.empty) return unhandled();
    let pos = range.from;
    // Inside a fenced code block the markup is literal text — never continue.
    // 树还没就绪（文件刚载入）时由共享判定内部退回行扫描，守卫始终成立。
    if (insideFencedCode(state, pos)) return unhandled();
    // markdown-only editor: this gate only matters against nested-language
    // regions, and only the parsed tree knows about them. With an empty tree
    // isActiveAt is false for EVERY position (Tree.empty's top node carries no
    // language data) — bnote and lang-markdown would both bail and Enter would
    // fall through to a plain newline: no `- [ ] ` continuation, cursor at the
    // line start. Exactly the "occasional after file switch" bug.
    if (
      syntaxTreeAvailable(state, state.doc.length) &&
      !markdownLanguage.isActiveAt(state, pos, -1) &&
      !markdownLanguage.isActiveAt(state, pos, 1)
    ) {
      return unhandled();
    }
    const line = state.doc.lineAt(pos);
    const bulletMatch = BULLET_ITEM_RE.exec(line.text);
    const orderedMatch = bulletMatch ? null : ORDERED_ITEM_RE.exec(line.text);
    const m = bulletMatch ?? orderedMatch;
    if (!m) return unhandled();
    const [, indent, marker, gap, box, content] = m;
    const markerLen = indent.length + marker.length + gap.length + (box?.length ?? 0);
    if (pos < line.from + markerLen) {
      // Cursor on the leading whitespace or the marker itself (e.g. right
      // where toggling the checkbox drops it). Falling through to
      // lang-markdown here expands tab indent to spaces — the deep-indent
      // bug — so handle these positions directly.
      if (pos <= line.from + indent.length) {
        // Before the bullet: plain blank line above (no indent copy — the
        // item line already carries its own).
        return {
          changes: { from: line.from, insert: state.lineBreak },
          range: EditorSelection.cursor(line.from + state.lineBreak.length),
        };
      }
      // On the marker/gap/box: continue with a fresh item from the line end.
      pos = line.to;
    }

    if (content.trim() === "") {
      // Empty item. Nested: lose one level of indent but keep the item, so
      // repeated Enter walks back out one level at a time. Top level: leave the
      // list — strip the marker and anything after it.
      if (indent.length === 0) {
        return {
          changes: { from: line.from, to: line.to, insert: "" },
          range: EditorSelection.cursor(line.from),
        };
      }
      const edits: Edit[] = [];
      const newIndent = dedentOneLevel(indent, indentUnitText);
      const delim = orderedMatch ? marker.slice(-1) : "";
      let head = marker;
      if (orderedMatch) {
        const number = orderedNumberAtLevel(state.doc, line.number, newIndent);
        head = `${number}${delim}`;
        if (renumber) bumpFollowingOrdered(state.doc, line.number, newIndent, number, delim, edits);
      }
      const text = newIndent + head + gap + (box ?? "");
      edits.push({ from: line.from, to: line.to, insert: text });
      return {
        changes: edits,
        range: EditorSelection.cursor(line.from + text.length),
      };
    }

    // Continue / split: absorb surrounding whitespace like lang-markdown does.
    let from = pos;
    let to = pos;
    while (from > line.from && /\s/.test(line.text[from - line.from - 1])) from--;
    while (to < line.to && /\s/.test(line.text[to - line.from])) to++;
    const edits: Edit[] = [];
    const delim = orderedMatch ? marker.slice(-1) : "";
    const head = orderedMatch ? `${parseInt(marker, 10) + 1}${delim}` : marker;
    if (orderedMatch && renumber) {
      // The new item owns the number after this one; the items below it shift.
      bumpFollowingOrdered(state.doc, line.number, indent, parseInt(marker, 10) + 1, delim, edits);
    }
    const insert = `${head}${gap}${box ? "[ ] " : ""}`;
    edits.push({ from, to, insert: state.lineBreak + indent + insert });
    return {
      changes: edits,
      range: EditorSelection.cursor(from + state.lineBreak.length + indent.length + insert.length),
    };
  });
  if (!handledAll) return false;
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
}

export function toggleHeading(view: EditorView, level: number) {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const seenLines = new Set<number>();

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (seenLines.has(line.number)) continue;
    seenLines.add(line.number);

    const existing = line.text.match(/^(#{1,6})(\s+|$)/);
    const prefix = "#".repeat(level) + " ";
    if (existing) {
      const insert = existing[1].length === level ? "" : prefix;
      changes.push({ from: line.from, to: line.from + existing[0].length, insert });
    } else {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  if (changes.length === 0) return;

  view.dispatch({
    changes,
    userEvent: "input.bnote-heading",
  });
}

/**
 * 标题层级循环（同一快捷键重复按）：正文 → H1 → H2 → H3 → H4 → 正文。
 * H5/H6 只能经「设为 N 级标题」到达，从它们出发的下一档也是取消。
 * 多光标/多行选区里每行各前进一步；残留的自动编号由命令层收尾。
 */
export function cycleHeading(view: EditorView) {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const seenLines = new Set<number>();

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (seenLines.has(line.number)) continue;
    seenLines.add(line.number);

    const existing = line.text.match(/^(#{1,6})(\s+|$)/);
    if (!existing) {
      changes.push({ from: line.from, insert: "# " });
    } else if (existing[1].length < 4) {
      const level = existing[1].length;
      changes.push({ from: line.from, to: line.from + level, insert: "#".repeat(level + 1) });
    } else {
      changes.push({ from: line.from, to: line.from + existing[0].length, insert: "" });
    }
  }
  if (changes.length === 0) return;

  view.dispatch({
    changes,
    userEvent: "input.bnote-heading",
  });
}

/** Today as YYYY-MM-DD, the ✅ stamp appended when a todo is completed. */
export function todayStamp(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Trailing " ✅ YYYY-MM-DD" completion stamp, with surrounding whitespace. */
export const DONE_STAMP_RE = /(\s*✅\s*\d{4}-\d{2}-\d{2})\s*$/;

/** The todo prefix toggleTodo inserts; cursors in the prefix zone land behind it. */
const TODO_PREFIX = "- [ ] ";

/**
 * Cycles each cursor line: plain → `- [ ]` → `- [x] ✅ date` → plain.
 * Completing stamps today's date; the last step strips marker and stamp so
 * the line returns to exactly its pre-todo text.
 *
 * Cursor model (same as toggleList): a collapsed cursor inside the line's
 * prefix zone — line start through the end of the (old or new) marker — lands
 * right behind the new `- [ ] ` so typing continues at the item text (an empty
 * line toggled to a todo puts the caret after the checkbox, not before the
 * hidden marker). Cursors deeper in the text keep their anchored text via
 * change mapping. `delta` carries earlier lines' net length change so later
 * selections land correctly in multi-cursor dispatches.
 */
export function toggleTodo(view: EditorView) {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const sels: { anchor: number; head: number }[] = [];
  const seenLines = new Set<number>();
  let delta = 0;

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (seenLines.has(line.number)) continue;
    seenLines.add(line.number);

    const task = /^(\s*)((?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](.*)$/.exec(line.text);
    if (task) {
      const markFrom = line.from + task[1].length + task[2].length;
      const tail = task[4];
      const stamp = DONE_STAMP_RE.exec(tail);
      const textEnd = markFrom + 3 + (stamp ? stamp.index : tail.length);
      if (task[3] === " ") {
        // Todo → done: flip the box, (re)stamp today's date at line end.
        changes.push({ from: markFrom + 1, to: markFrom + 2, insert: "x" });
        changes.push({ from: textEnd, to: line.to, insert: ` ✅ ${todayStamp()}` });
        delta += ` ✅ ${todayStamp()}`.length - (line.to - textEnd);
      } else {
        // Done → plain: strip marker + checkbox and the stamp entirely.
        const lead = tail.startsWith(" ") || tail.startsWith("\t") ? 1 : 0;
        const textStart = Math.min(markFrom + 3 + lead, textEnd);
        changes.push({ from: line.from + task[1].length, to: textStart, insert: "" });
        if (stamp) changes.push({ from: textEnd, to: line.to, insert: "" });
        delta -= textStart - (line.from + task[1].length) + (line.to - textEnd);
      }
      continue;
    }

    // Bullet / ordered item without a checkbox: swap the marker for the task.
    const list = /^(\s*)(?:[-*+]|\d+[.)])(\s+)/.exec(line.text);
    if (list) {
      const markerLen = list[0].length - list[1].length;
      const indentLen = list[1].length;
      changes.push({
        from: line.from + indentLen,
        to: line.from + list[0].length,
        insert: "- [ ] ",
      });
      if (range.empty && range.head - line.from <= indentLen + markerLen) {
        const target = line.from + delta + indentLen + TODO_PREFIX.length;
        sels.push({ anchor: target, head: target });
      }
      delta += TODO_PREFIX.length - markerLen;
      continue;
    }

    const indent = line.text.match(/^\s*/)?.[0] ?? "";
    changes.push({ from: line.from + indent.length, insert: "- [ ] " });
    if (range.empty && range.head - line.from <= indent.length) {
      const target = line.from + delta + indent.length + TODO_PREFIX.length;
      sels.push({ anchor: target, head: target });
    }
    delta += TODO_PREFIX.length;
  }
  if (changes.length === 0) return;

  view.dispatch({
    changes,
    selection: sels.length
      ? EditorSelection.create(sels.map((s) => EditorSelection.range(s.anchor, s.head)))
      : undefined,
    userEvent: "input.bnote-todo",
  });
}

export type ListKind = "bullet" | "numbered";

/**
 * Per-line list toggle behind the Cmd+; (bullet) / Cmd+Shift+; (numbered)
 * commands. Converting a line to the target kind replaces a foreign marker
 * (an ordered item keeps its checkbox when demoted to a bullet and vice
 * versa); a line that already is the target kind drops back to plain text,
 * stripping marker and checkbox together. Lines inside fenced code are left
 * alone — their markup is literal text. The selection spans every covered
 * line; a cursor sitting on the affected prefix moves behind the new marker
 * so typing continues at the line content.
 */
export function toggleList(view: EditorView, kind: ListKind) {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const sels: { anchor: number; head: number }[] = [];
  const seenLines = new Set<number>();
  const doc = state.doc;
  let delta = 0;
  // Marker head (bullet/ordered sign + gap) and optional task checkbox.
  const headLen = (m: RegExpExecArray) => m[2].length + m[3].length;
  const boxLen = (m: RegExpExecArray) => m[4]?.length ?? 0;

  for (const range of state.selection.ranges) {
    // range.to may sit on the first column of an untouched line.
    const firstLine = doc.lineAt(range.from).number;
    const lastLine = doc.lineAt(Math.max(range.from, range.to - 1)).number;
    for (let n = firstLine; n <= lastLine; n++) {
      if (seenLines.has(n)) continue;
      seenLines.add(n);
      const line = doc.line(n);

      // 树已覆盖该行时走树查询（能识别深层缩进的围栏）；刚载入的空树查不到
      // 围栏行不参与列表/标题转换:树就绪走树查询,树没跟上行扫描兜底,
      // 否则切换文件后立刻转换会把围栏内标记也换掉。
      const probePos = Math.min(line.from + 1, doc.length);
      if (insideFencedCode(state, probePos)) continue;

      const bullet = BULLET_ITEM_RE.exec(line.text);
      const ordered = ORDERED_ITEM_RE.exec(line.text);
      const indent = (
        bullet ? bullet[1] : ordered ? ordered[1] : /^\s*/.exec(line.text)?.[0]
      )?.length ?? 0;
      const indentEnd = line.from + indent;
      let remLen = 0;
      let insLen = 0;

      if (kind === "bullet") {
        if (bullet) {
          // Already a bullet: cancel the list, checkbox included.
          remLen = headLen(bullet) + boxLen(bullet);
          changes.push({ from: indentEnd, to: indentEnd + remLen, insert: "" });
        } else if (ordered) {
          remLen = headLen(ordered);
          insLen = "- ".length;
          changes.push({ from: indentEnd, to: indentEnd + remLen, insert: "- " });
        } else {
          insLen = "- ".length;
          changes.push({ from: indentEnd, insert: "- " });
        }
      } else if (ordered) {
        // Already numbered: cancel the list, checkbox included.
        remLen = headLen(ordered) + boxLen(ordered);
        changes.push({ from: indentEnd, to: indentEnd + remLen, insert: "" });
      } else if (bullet) {
        remLen = headLen(bullet);
        insLen = "1. ".length;
        changes.push({ from: indentEnd, to: indentEnd + remLen, insert: "1. " });
      } else {
        insLen = "1. ".length;
        changes.push({ from: indentEnd, insert: "1. " });
      }

      if (range.empty && range.head >= line.from && range.head - line.from <= indent + remLen) {
        const target = line.from + delta + indent + insLen;
        sels.push({ anchor: target, head: target });
      }
      delta += insLen - remLen;
    }
  }
  if (changes.length === 0) return;

  view.dispatch({
    changes,
    selection: sels.length
      ? EditorSelection.create(sels.map((s) => EditorSelection.range(s.anchor, s.head)))
      : undefined,
    userEvent: "input.bnote-list",
  });
}

/**
 * 往返跳转：正文 → 文档头部最后一个待办项的行尾 → 回到跳转前的位置。
 * 头部待办块 = 从「起点行」开始(允许空行)连续的待办行(`- [ ]` / `- [x]` /
 * 有序待办,中间可夹空行),首个非空且非待办的行结束块。
 *
 * 起点行按文件形态分两套:日记(Daily/YYYY-MM-DD.md)的待办区在日期标题
 * 之后(H1 时行 2 起,与 daily 的 parseDailyRegion 同一片区域);其他笔记的
 * 头部待办区就是文件最顶(行 1 起)——笔记里待办习惯写在第一行(跨文件同步
 * 写笔记顶部也是这个位置),第一行是 H1 标题也一样,新待办插到标题之前。
 * 头部还没有待办块时创建一个空待办(日记插在 H1 后、普通笔记插文档顶,
 * 光标落待办符号后,直接输入);再按一次回到原位。已在头部位置但有来处
 * 记忆时回跳。
 */
const HEADER_TODO_RE = /^(\s*)(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/;
const BLANK_LINE_RE = /^\s*$/;
/** H1 头判定(与 daily 的 HEADER_RE 同形状):行 1 是 `# ` 标题 → 待办区从行 2 起。 */
const H1_RE = /^#\s/;
/** 日记文件判定:Daily 目录下的日期文件名(与 dailyPathFor 同一形状)。 */
export const DAILY_FILE_RE = /(^|\/)Daily\/\d{4}-\d{2}-\d{2}\.md$/;

/** 一次 ⌘T 的决策(纯函数,契约在 ops.test.ts):
 *  jump = 跳到 anchor;back = 回到来处记忆;stay = 无声无效;
 *  create = 在 at 插入 insert,光标落 cursor(待办符号后)。 */
export type HeaderTodoPlan =
  | { action: "jump"; anchor: number }
  | { action: "back" }
  | { action: "stay" }
  | { action: "create"; at: number; insert: string; cursor: number };

export function planHeaderTodoJump(
  doc: { lines: number; line(n: number): { text: string; from: number; to: number } },
  headLine: number,
  hasReturn: boolean,
  isDaily: boolean,
): HeaderTodoPlan {
  const headerDoc = isDaily && doc.lines >= 1 && H1_RE.test(doc.line(1).text);
  const start = headerDoc ? 2 : 1;
  let first: number | null = null;
  let last: number | null = null;
  // 只扫到首个非空非待办行为止:头部块通常几行,成本与文档总长无关。
  for (let n = start; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (HEADER_TODO_RE.test(text)) {
      if (first === null) first = n;
      last = n;
      continue;
    }
    if (BLANK_LINE_RE.test(text)) continue;
    break; // 首个非空非待办行:头部待办块结束
  }
  if (first !== null && last !== null) {
    if (headLine >= first && headLine <= last) {
      return hasReturn ? { action: "back" } : { action: "stay" };
    }
    return { action: "jump", anchor: doc.line(last).to };
  }
  // 头部还没有待办块。光标已在「块将长出的位置」(起点行或其前的标题行):
  // 有来处记忆则回跳(往返优先),否则就地创建;光标在起点行之后则记住来处并创建。
  if (headLine <= start && hasReturn) return { action: "back" };
  if (headerDoc) {
    // 日记:空待办长在 H1 之后,与 parseDailyRegion 的待办区起点一致。
    const at = doc.line(1).to;
    const insert = "\n- [ ] ";
    return { action: "create", at, insert, cursor: at + insert.length };
  }
  // 普通笔记:空待办成为文件第一行(H1 标题也被顶到第二行——笔记的头部
  // 待办区就是文件最顶)。空文档不加尾换行;非空文档把原第一行顶下去。
  // 光标一律落在 `- [ ] ` 行尾(待办符号后),与插入串是否带尾换行无关。
  const insert = doc.lines === 1 && doc.line(1).text === "" ? "- [ ] " : "- [ ] \n";
  return { action: "create", at: 0, insert, cursor: "- [ ] ".length };
}

/**
 * 往返跳转的「来处」记忆：文件路径 → 跳转前的光标(行号+列)与滚动位置。
 * 按访问顺序淘汰、上限 64 条（覆盖任何真实的多文件往返工作流），内存占用
 * 有界。仅在按下快捷键时读写，不挂任何编辑周期。存行列而非绝对 pos：跳转后
 * 用户在目标处打字，来处的行内容不受影响，回跳精确。⌘T（头部待办）与 ⌘⇧B
 * （callout 锚点）各持一份，两个功能的往返记忆互不覆盖。
 */
interface ReturnSpot {
  line: number;
  col: number;
  scroll: number;
}

const RETURN_MAX = 64;

function makeReturnMemory() {
  const map = new Map<string, ReturnSpot>();
  return {
    has: (path: string) => map.has(path),
    get: (path: string) => map.get(path),
    /** 写入并刷新淘汰顺序。 */
    set(path: string, spot: ReturnSpot) {
      map.delete(path);
      map.set(path, spot);
      if (map.size > RETURN_MAX) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    /** 只刷新淘汰顺序（回跳后保留记忆，往返可以反复走）。 */
    touch(path: string) {
      const spot = map.get(path);
      if (spot === undefined) return;
      map.delete(path);
      map.set(path, spot);
    },
    clear: () => map.clear(),
  };
}

const headerTodoReturn = makeReturnMemory();
const calloutReturn = makeReturnMemory();

/** 测试钩子:清空往返记忆(模块级 Map 会跨用例泄漏)。 */
export function resetHeaderTodoReturnForTest(): void {
  headerTodoReturn.clear();
}

/** 测试钩子:清空 ⌘⇧B 的往返回跳记忆。 */
export function resetCalloutReturnForTest(): void {
  calloutReturn.clear();
}

export function jumpHeaderTodos(view: EditorView): void {
  const state = view.state;
  const doc = state.doc;
  const path = useAppStore.getState().currentFile ?? "";
  const head = state.selection.main.head;
  const headLine = doc.lineAt(head).number;
  const headCol = head - doc.lineAt(head).from;
  const plan = planHeaderTodoJump(
    state.doc,
    headLine,
    headerTodoReturn.has(path),
    DAILY_FILE_RE.test(path),
  );
  if (plan.action === "stay") return;
  if (plan.action === "back") {
    // 已在目标处：回到之前记笔记的位置(行列锚,行被改短则钳到行尾)。
    const saved = headerTodoReturn.get(path)!;
    headerTodoReturn.touch(path); // 刷新淘汰顺序,往返可反复走
    const line = doc.line(Math.min(saved.line, doc.lines));
    view.dispatch({
      selection: { anchor: Math.min(line.from + saved.col, line.to) },
      scrollIntoView: true,
    });
    view.scrollDOM.scrollTop = Math.max(0, Math.min(saved.scroll, view.scrollDOM.scrollHeight));
    return;
  }
  // 在正文:记下当前位置,跳到目标或创建空待办。创建的整行插入在来处之前时,
  // 来处行号随插入平移(行内列不变)。
  let line = headLine;
  if (plan.action === "create" && plan.at <= doc.line(headLine).from) {
    line = headLine + (plan.insert.split("\n").length - 1);
  }
  headerTodoReturn.set(path, {
    line,
    col: headCol,
    scroll: Math.round(view.scrollDOM.scrollTop),
  });
  if (plan.action === "create") {
    // 空待办长在头部起点,光标落在 `- [ ] ` 行尾,直接输入。
    view.dispatch({
      changes: [{ from: plan.at, insert: plan.insert }],
      selection: { anchor: plan.cursor },
      scrollIntoView: true,
      userEvent: "input.bnote-header-todo",
    });
    return;
  }
  view.dispatch({
    selection: { anchor: plan.anchor },
    scrollIntoView: true,
  });
}

export function toggleWrap(view: EditorView, marker: string) {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const sels: { anchor: number; head: number }[] = [];
  let delta = 0;

  for (const range of state.selection.ranges) {
    const { from, to } = range;
    const text = state.sliceDoc(from, to);

    // Unwrap when the markers sit right outside the selection.
    const before = state.sliceDoc(Math.max(0, from - marker.length), from);
    const after = state.sliceDoc(to, Math.min(state.doc.length, to + marker.length));
    if (before === marker && after === marker) {
      changes.push({ from: from - marker.length, to: from, insert: "" });
      changes.push({ from: to, to: to + marker.length, insert: "" });
      sels.push({ anchor: from - marker.length + delta, head: to - marker.length + delta });
      delta -= marker.length * 2;
      continue;
    }

    // Unwrap when the selection itself is wrapped.
    if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
      const inner = text.slice(marker.length, text.length - marker.length);
      changes.push({ from, to, insert: inner });
      sels.push({ anchor: from + delta, head: from + inner.length + delta });
      delta += inner.length - text.length;
      continue;
    }

    // Wrap (or place empty markers with the cursor inside).
    changes.push({ from, to, insert: marker + text + marker });
    sels.push({
      anchor: from + delta + marker.length,
      head: to + delta + marker.length,
    });
    delta += marker.length * 2;
  }

  view.dispatch({
    changes,
    selection: EditorSelection.create(sels.map((s) => EditorSelection.range(s.anchor, s.head))),
    userEvent: "input.bnote-wrap",
  });
}

/**
 * 独占整行的块（```…``` / $$…$$ 与 LaTeX 环境行）插入。open/close 按行给，
 * 逐行拼接（公式块是 `$$` + `\begin{align}` 两行，中间空行留给光标）。
 * 定界符必须自己占一行——粘在正文后面既不是合法围栏也不是块公式：当前行为
 * 空行时原位替换（顺带清掉纯空白），否则插到本行行尾之后。首行（开栏）不缩进，
 * 其余行（环境行、内部空行、闭栏）继承本行缩进（块留在列表项内）。光标位置
 * 从构造出的插入串推导——恒落在内部空行的缩进之后（块内首个内容位，直接开写）。
 */
function insertOwnLineBlock(
  view: EditorView,
  open: string[],
  close: string[],
  userEvent: string,
) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const blank = line.text.trim() === "";
  const indent = blank ? "" : (line.text.match(/^\s*/)?.[0] ?? "");
  const openText = open.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
  const closeText = close.map((l) => indent + l).join("\n");
  const insert = (blank ? "" : "\n") + openText + "\n" + indent + "\n" + closeText;
  const from = blank ? line.from : line.to;
  const cursor = from + (blank ? 0 : 1) + openText.length + 1 + indent.length;

  view.dispatch({
    changes: blank ? { from: line.from, to: line.to, insert } : { from, insert },
    selection: { anchor: cursor },
    userEvent,
  });
  view.focus();
}

/**
 * 插入 Callout 块(`:::` 容器,⌘⇧B)。四种落法:
 *
 *  - 有选区:「选中插入」——在选区所在行之后(围栏代码块/display 公式块内
 *    的选区延伸到该块之后,不把块切开)建一个以选中文字为标题的 callout
 *    (与前文空一行),光标落块内空行直接开写解释;选中的原文留在原处,
 *    渲染成下划虚线锚点(calloutAnchor.ts 按「标题 = 正文文本」推导),
 *    光标停在锚点里再按 ⌘⇧B 即跳到这个块。
 *  - 无选区、光标在 callout 内:往返(有来处记忆回跳;否则就地开新块)。
 *  - 无选区、光标在锚点上:跳到关联的 callout。
 *  - 其余:就地开一个空块——空行原位替换/否则插到本行尾之后。插入形状是
 *    相邻的开栏/闭栏两行,开栏带一个尾随空格作标题槽,光标落在槽之后——
 *    紧接着写标题(`::: 标题`),写完回车就是块内正文行(两栏之间不预置
 *    空行,回车不必先删一行);不写标题直接回车则是无标题裸块。两栏一律
 *    栏 0:callout.ts 只认栏 0 的标记,缩进的闭栏永远关不上块。
 */
export function insertCallout(view: EditorView) {
  // vim visual 的选区要先从引擎取(linewise/blockwise 的 CM 选区不完整)——
  // 顺便退出 visual,命令消费掉这次选择。
  const visual = takeVimVisual(view);
  const state = view.state;
  const range = state.selection.main;
  const sel =
    visual ??
    (range.empty
      ? null
      : { text: state.sliceDoc(range.from, range.to), from: range.from, to: range.to });
  const title = sel ? normalizeCalloutTitle(sel.text) : "";
  if (sel && title !== "") {
    insertTitledCallout(view, title, calloutInsertAnchor(state, sel.from, sel.to));
    return;
  }
  jumpOrInsertCallout(view);
}

/**
 * 选中内容作为标题的单行形态:换行(跨行选区)压成空格、连续空白压成一个。
 * callout 标题是单行语法(开栏行剩余部分);压过之后锚点匹配端对空白弹性
 * (见 calloutAnchor.findTitleMatches),原文处仍能命中。
 */
function normalizeCalloutTitle(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * 选中插入的落点:选区所在「块」的最后一行行尾。普通文本就是选区末行;
 * 选区落在围栏代码块或 display 公式块里时延伸到该块末行——插在块的中间会
 * 把块切开(围栏/$$ 被拆散),整块之后再长 callout 才不破坏它。
 */
export function calloutInsertAnchor(state: EditorState, from: number, to: number): number {
  const doc = state.doc;
  const end = Math.max(from, to - 1);
  let anchorLine = doc.lineAt(end).number;
  // 围栏代码块:行扫描与 callout 扫描同源(树未就绪也准确)。选区末行在围栏
  // 内时往下找第一个出围栏的行,它的前一行即块的闭合行(未闭合到文末则是末行)。
  const inside = fenceStateScan(doc);
  if (inside[anchorLine - 1]) {
    let n = anchorLine;
    while (n <= doc.lines && inside[n - 1]) n++;
    anchorLine = Math.min(n - 1, doc.lines);
  }
  // display 公式块:选区与区域相交时延伸到区域末行(取最靠后那个)。
  for (const r of mathRegions(state)) {
    if (!r.display) continue;
    if (end >= r.from && from <= r.to) {
      const regionEnd = doc.lineAt(Math.max(r.from, r.to - 1)).number;
      if (regionEnd > anchorLine) anchorLine = regionEnd;
    }
  }
  return doc.line(anchorLine).to;
}

/**
 * 在 `at`(某行行尾)之后插入带标题的 callout。与前文恰好隔开一个空行:
 * 落点行非空补两个换行(原文与开栏之间空一行),落点行本身是空行(未闭合
 * 围栏延伸到文末的空尾行)只补一个。光标落块内空行(开栏行之后),直接输入
 * 就是块内容;`at` 之后原有的内容被推到块后面。
 */
function insertTitledCallout(view: EditorView, title: string, at: number) {
  const doc = view.state.doc;
  const atLine = doc.lineAt(at);
  const prefix = atLine.text.trim() === "" ? "\n" : "\n\n";
  const head = `::: ${title}\n`;
  view.dispatch({
    changes: { from: at, insert: `${prefix}${head}\n:::` },
    selection: { anchor: at + prefix.length + head.length },
    scrollIntoView: true,
    userEvent: "input.bnote-callout",
  });
  view.focus();
}

/** 一次无选区 ⌘⇧B 的决策(纯函数,契约在 ops.test.ts):
 *  anchor-jump = 光标在锚点上,跳到关联 callout;back = 已在 callout 内且有
 *  来处记忆,回跳;insert = 就地开一个空块。 */
export type CalloutPlan =
  | { action: "anchor-jump"; region: CalloutRegion }
  | { action: "back" }
  | { action: "insert" };

export function planCalloutShortcut(
  doc: Text,
  callouts: CalloutRegion[],
  head: number,
  hasReturn: boolean,
): CalloutPlan {
  // 光标在某个 callout 内(含边界行,与边界行的活动规则同一范围):往返优先——
  // 刚跳到块里,再按一次就是回去;没有来处的块内编辑照旧就地开新块。
  if (callouts.some((c) => head >= c.from && head <= c.to)) {
    return hasReturn ? { action: "back" } : { action: "insert" };
  }
  const region = anchorRegionAt(doc, callouts, head);
  if (region) return { action: "anchor-jump", region };
  return { action: "insert" };
}

/** 无选区时的 ⌘⇧B:锚点跳转 / 往返回跳 / 就地插入空块。 */
function jumpOrInsertCallout(view: EditorView) {
  const state = view.state;
  const doc = state.doc;
  const path = useAppStore.getState().currentFile ?? "";
  const head = state.selection.main.head;
  const plan = planCalloutShortcut(doc, calloutRegions(state), head, calloutReturn.has(path));
  if (plan.action === "back") {
    // 已在 callout 内:回到跳转前的正文位置(行列锚,行被改短则钳到行尾)。
    const saved = calloutReturn.get(path)!;
    calloutReturn.touch(path); // 刷新淘汰顺序,往返可反复走
    const line = doc.line(Math.min(saved.line, doc.lines));
    view.dispatch({
      selection: { anchor: Math.min(line.from + saved.col, line.to) },
      scrollIntoView: true,
    });
    view.scrollDOM.scrollTop = Math.max(0, Math.min(saved.scroll, view.scrollDOM.scrollHeight));
    return;
  }
  if (plan.action === "anchor-jump") {
    const headLine = doc.lineAt(head).number;
    calloutReturn.set(path, {
      line: headLine,
      col: head - doc.lineAt(head).from,
      scroll: Math.round(view.scrollDOM.scrollTop),
    });
    // 落点 = 开栏行行尾(标题槽后):与「创建选中块时光标落标题槽」同一位置,
    // 光标已在块内,再按一次 ⌘⇧B 即往回跳。
    view.dispatch({
      selection: { anchor: doc.line(plan.region.openLine).to },
      scrollIntoView: true,
    });
    return;
  }
  insertEmptyCallout(view);
}

/** 就地插入空 callout 块(空行原位替换/否则插到本行尾之后)。 */
function insertEmptyCallout(view: EditorView) {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  const blank = line.text.trim() === "";
  const open = "::: ";
  const from = blank ? line.from : line.to;
  view.dispatch({
    changes: blank
      ? { from: line.from, to: line.to, insert: `${open}\n:::` }
      : { from: line.to, insert: `\n${open}\n:::` },
    selection: { anchor: from + (blank ? 0 : 1) + open.length },
    userEvent: "input.bnote-callout",
  });
  view.focus();
}

/**
 * 插入公式块（⌘M）：原生给出对齐环境骨架——`$$` 定界行之间嵌
 * `\begin{align}…\end{align}`，光标落环境内的空行。
 *
 * 与片段 `dm`/`#@` 同形，区别是热键直达、不必先打触发词再转换。等号对齐与
 * 换行不在插入时预置：在 align 环境里回车由 matrix.ts 的 alignEnter 接管
 * （第一个裸关系符前补对齐点 `&`、行尾补 ` \\`），插入只给环境与落点。
 */
export function insertMathBlock(view: EditorView) {
  insertOwnLineBlock(
    view,
    ["$$", "\\begin{align}"],
    ["\\end{align}", "$$"],
    "input.bnote-math-block",
  );
}

export function insertInlineMath(view: EditorView) {
  wrapOrPlace(view, "$");
}

export function insertInlineCode(view: EditorView) {
  wrapOrPlace(view, "`");
}

export function insertWikilink(view: EditorView) {
  wrapOrPlace(view, "[[", "]]");
}

/** `[[目标]]` / `[[目标|别名]]` 的形状，与 livePreview 的渲染正则同源。 */
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

/**
 * 光标所在行上的第一个链接目标（`[[目标|别名]]` / `[[目标#标题]]` 都取目标），
 * 行内代码与围栏代码里的 `[[…]]` 不算——那是示例文本，不是链接。
 * 一行只允许一个链接，所以取第一个就是那一行的链接。
 */
export function wikilinkTargetOnLine(view: EditorView): string | null {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  if (!line.text.includes("[[")) return null;
  // 语法树解析到这一行时，getContextAt 就能判出围栏/行内代码；整行扫描只是刚载入、
  // 树还没跟上时的兜底（与回车续行同一套约定）。无条件扫会变成 O(光标之前的行数)——
  // 一万行文档里光标贴着底部时约 4.5ms，每按一次都要付。
  if (!syntaxTreeAvailable(state, line.to) && insideFencedCodeByScan(state.doc, line.number)) {
    return null;
  }
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(line.text))) {
    if (getContextAt(state, line.from + m.index + 2).code) continue;
    const raw = m[1];
    const pipe = raw.indexOf("|");
    const target = (pipe === -1 ? raw : raw.slice(0, pipe)).split("#")[0].trim();
    if (target) return target;
  }
  return null;
}

/**
 * 写一条链接进文档：有选区时选区文字当别名（`[[目标|别名]]` 顶掉选区），否则插在
 * 光标处、光标落在链接之后。别名里的链接语法字符会截断链接，一律换成空格。
 */
export function insertWikilinkText(view: EditorView, target: string) {
  const state = view.state;
  const range = state.selection.main;
  const alias = range.empty
    ? ""
    : state
        .sliceDoc(range.from, range.to)
        .replace(/[\[\]|\r\n]/g, " ")
        .trim();
  const insert = alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
    userEvent: "input.bnote-link",
  });
  view.focus();
}

/**
 * 围栏信息串：剥掉反引号/换行（会提前终止围栏）并裁空白；空 = 裸 ```。
 */
function fenceInfoString(langOverride?: string): string {
  const raw = langOverride ?? useAppStore.getState().settings.codeBlockLang;
  return raw.replace(/[`\r\n]/g, "").trim();
}

/**
 * 插入代码块：无选区时在光标处开一个带设置语言的开栏，光标落在内部空行；
 * 有选区时把覆盖的行包进围栏（围栏独占整行，行中选区扩展到整行），选区
 * 两端平移进块内。
 */
export function insertCodeBlock(view: EditorView, langOverride?: string) {
  const state = view.state;
  const range = state.selection.main;
  const open = "```" + fenceInfoString(langOverride);
  if (!range.empty) {
    const firstLine = state.doc.lineAt(range.from);
    // range.to may sit on the first column of an untouched line.
    const lastLine = state.doc.lineAt(Math.max(range.from, range.to - 1));
    const covered = state.sliceDoc(firstLine.from, lastLine.to);
    const openLen = open.length + 1;
    const mapPos = (p: number) => {
      if (p <= firstLine.from) return p;
      if (p <= lastLine.to) return firstLine.from + openLen + (p - firstLine.from);
      return firstLine.from + openLen + covered.length + 4 + (p - lastLine.to - 1);
    };
    view.dispatch({
      changes: { from: firstLine.from, to: lastLine.to, insert: `${open}\n${covered}\n\`\`\`` },
      selection: { anchor: mapPos(range.anchor), head: mapPos(range.head) },
      userEvent: "input.bnote-code-block",
    });
    view.focus();
    return;
  }
  insertOwnLineBlock(view, [open], ["```"], "input.bnote-code-block");
}

export function insertHorizontalRule(view: EditorView) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const prefix = line.text.trim() === "" ? "" : "\n\n";
  view.dispatch({
    changes: { from: line.to, insert: prefix + "---\n" },
    selection: { anchor: line.to + prefix.length + 4 },
    userEvent: "input.bnote-insert",
  });
  view.focus();
}

/** 全部非空选区文本（按文档位置排序，多光标以换行相连）。 */
function selectedText(state: EditorState): string {
  const ranges = [...state.selection.ranges].sort((a, b) => a.from - b.from);
  return ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join(state.lineBreak);
}

/**
 * ⌘C：把选中内容写入系统剪贴板。wry 的 WKWebView 把 ⌘ 和弦当普通 keydown
 * 送进页面、AppKit 菜单角色收不到，复制粘贴只能在这里显式实现；无选区时
 * 放行（拦下来也无事可做）。
 */
export function copySelection(view: EditorView): boolean {
  const text = selectedText(view.state);
  if (!text) return false;
  void writeClipboardText(text);
  return true;
}

/** ⌘X：写入剪贴板并删除选中内容。 */
export function cutSelection(view: EditorView): boolean {
  const text = selectedText(view.state);
  if (!text) return false;
  void writeClipboardText(text);
  view.dispatch({
    changes: view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to })),
    userEvent: "delete.cut",
  });
  return true;
}

/**
 * ⌘V：读系统剪贴板，替换每个选区（多光标同文粘贴），光标落在插入文本后。
 * IPC 是异步的：完成时按"当时"的最新选区执行（changeByRange 读的是解析后
 * 的 state），不绑定按键瞬间的旧光标，避免过期写入。
 */
export function pasteClipboard(view: EditorView): boolean {
  void readClipboardText().then((text) => {
    if (text === null) return;
    view.dispatch(
      view.state.changeByRange((range) => ({
        changes: { from: range.from, to: range.to, insert: text },
        range: EditorSelection.cursor(range.from + text.length),
      })),
      { userEvent: "input.paste", scrollIntoView: true },
    );
  });
  return true;
}

function wrapOrPlace(view: EditorView, open: string, close: string = open) {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const sels: { anchor: number; head: number }[] = [];
  let delta = 0;

  for (const range of state.selection.ranges) {
    const { from, to } = range;
    const text = state.sliceDoc(from, to);
    changes.push({ from, to, insert: open + text + close });
    const innerStart = from + delta + open.length;
    sels.push({ anchor: innerStart, head: innerStart + text.length });
    delta += open.length + close.length;
  }

  view.dispatch({
    changes,
    selection: EditorSelection.create(sels.map((s) => EditorSelection.range(s.anchor, s.head))),
    userEvent: "input.bnote-insert",
  });
  view.focus();
}
