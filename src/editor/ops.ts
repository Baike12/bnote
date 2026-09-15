import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { indentUnit, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { getContextAt, insideFencedCodeByScan } from "./context";
import type { SyntaxNode } from "@lezer/common";
import { renumberHeadings } from "./numbering";
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
    // The tree is still empty right after a file switch (background parse
    // hasn't landed), where resolveInner finds no FencedCode — fall back to a
    // line scan so the guard stays correct in that window.
    if (syntaxTreeAvailable(state, pos + 1)) {
      let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
      for (; node; node = node.parent) {
        if (node.name === "FencedCode") return unhandled();
      }
    } else if (insideFencedCodeByScan(state.doc, state.doc.lineAt(pos).number)) {
      return unhandled();
    }
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
 * Unified heading toggle: plain line → level-1 heading, heading line → plain.
 * Returns true when at least one cursor line had its heading removed (so the
 * caller can drop a leftover auto number before renumbering).
 */
export function toggleHeadingAny(view: EditorView): boolean {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const seenLines = new Set<number>();
  let toggledOff = false;

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (seenLines.has(line.number)) continue;
    seenLines.add(line.number);

    const existing = line.text.match(/^(#{1,6})(\s+|$)/);
    if (existing) {
      toggledOff = true;
      changes.push({ from: line.from, to: line.from + existing[0].length, insert: "" });
    } else {
      changes.push({ from: line.from, insert: "# " });
    }
  }
  if (changes.length === 0) return false;

  view.dispatch({
    changes,
    userEvent: "input.bnote-heading",
  });
  return toggledOff;
}

/**
 * Tab / Shift-Tab on heading lines: level up (max 5) / down (min 1). The
 * unified heading command starts at level 1, so level 6 stays reachable only
 * through the 设为 N 级标题 commands. Returns false when any cursor sits on a
 * non-heading line, leaving Tab to its default behavior (indent); renumbers
 * when auto heading numbering is on.
 */
export function adjustHeadingLevel(view: EditorView, delta: 1 | -1): boolean {
  const state = view.state;
  const changes: { from: number; to: number; insert: string }[] = [];
  const seenLines = new Set<number>();

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (seenLines.has(line.number)) continue;
    seenLines.add(line.number);

    const existing = line.text.match(/^(#{1,6})(\s+|$)/);
    if (!existing) return false;
    const level = existing[1].length;
    const target = Math.min(5, Math.max(1, level + delta));
    if (target !== level) {
      changes.push({ from: line.from, to: line.from + level, insert: "#".repeat(target) });
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.bnote-heading-tab" });
    if (useAppStore.getState().settings.autoNumberHeadings) renumberHeadings(view);
  }
  return true;
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

/**
 * Cycles each cursor line: plain → `- [ ]` → `- [x] ✅ date` → plain.
 * Completing stamps today's date; the last step strips marker and stamp so
 * the line returns to exactly its pre-todo text.
 */
export function toggleTodo(view: EditorView) {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const seenLines = new Set<number>();

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
      } else {
        // Done → plain: strip marker + checkbox and the stamp entirely.
        const lead = tail.startsWith(" ") || tail.startsWith("\t") ? 1 : 0;
        const textStart = Math.min(markFrom + 3 + lead, textEnd);
        changes.push({ from: line.from + task[1].length, to: textStart, insert: "" });
        if (stamp) changes.push({ from: textEnd, to: line.to, insert: "" });
      }
      continue;
    }

    // Bullet / ordered item without a checkbox: swap the marker for the task.
    const list = /^(\s*)(?:[-*+]|\d+[.)])(\s+)/.exec(line.text);
    if (list) {
      changes.push({
        from: line.from + list[1].length,
        to: line.from + list[0].length,
        insert: "- [ ] ",
      });
      continue;
    }

    const indent = line.text.match(/^\s*/)?.[0] ?? "";
    changes.push({ from: line.from + indent.length, insert: "- [ ] " });
  }
  if (changes.length === 0) return;

  view.dispatch({
    changes,
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
      // FencedCode，行扫描兜底，否则切换文件后立刻转换会把围栏内标记也换掉。
      const probePos = Math.min(line.from + 1, doc.length);
      let inFence = false;
      if (syntaxTreeAvailable(state, probePos + 1)) {
        let node: SyntaxNode | null = syntaxTree(state).resolveInner(probePos, -1);
        for (; node; node = node.parent) {
          if (node.name === "FencedCode") {
            inFence = true;
            break;
          }
        }
      } else {
        inFence = insideFencedCodeByScan(doc, n);
      }
      if (inFence) continue;

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
 * 头部待办块 = 文档开头（允许空行）连续的待办行（`- [ ]` / `- [x]` /
 * 有序待办，中间可夹空行），首个非空且非待办的行结束块。头部没有待办时
 * 静默无效；在块内但找不到来处（没有跳转过）同样静默。
 */
const HEADER_TODO_RE = /^(\s*)(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/;
const BLANK_LINE_RE = /^\s*$/;
/**
 * 往返跳转的"来处"记忆：文件路径 → 跳转前的光标与滚动位置。这是本功能唯一
 * 的常驻状态；按访问顺序淘汰、上限 64 条（覆盖任何真实的多文件往返工作流），
 * 内存占用有界。仅在按下快捷键时读写，不挂任何编辑周期。
 */
const headerTodoReturn = new Map<string, { pos: number; scroll: number }>();
const HEADER_TODO_RETURN_MAX = 64;

export function jumpHeaderTodos(view: EditorView): void {
  const state = view.state;
  const doc = state.doc;
  let first: number | null = null;
  let last: number | null = null;
  // 只扫到首个非空非待办行为止：头部块通常几行，成本与文档总长无关。
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (HEADER_TODO_RE.test(text)) {
      if (first === null) first = n;
      last = n;
      continue;
    }
    if (BLANK_LINE_RE.test(text)) continue;
    break; // 首个非空非待办行：头部待办块结束
  }
  if (first === null || last === null) return;

  const path = useAppStore.getState().currentFile ?? "";
  const head = state.selection.main.head;
  const headLine = doc.lineAt(head).number;
  if (headLine >= first && headLine <= last) {
    // 已在头部待办块里：回到之前记笔记的位置。
    const saved = headerTodoReturn.get(path);
    if (!saved) return;
    headerTodoReturn.delete(path);
    headerTodoReturn.set(path, saved); // 重新插入，刷新淘汰顺序
    view.dispatch({
      selection: { anchor: Math.min(saved.pos, doc.length) },
      scrollIntoView: true,
    });
    view.scrollDOM.scrollTop = Math.max(0, Math.min(saved.scroll, view.scrollDOM.scrollHeight));
    return;
  }
  // 在正文：记下当前位置，跳到头部最后一个待办项的行尾。
  headerTodoReturn.set(path, { pos: head, scroll: Math.round(view.scrollDOM.scrollTop) });
  if (headerTodoReturn.size > HEADER_TODO_RETURN_MAX) {
    const oldest = headerTodoReturn.keys().next().value;
    if (oldest !== undefined) headerTodoReturn.delete(oldest);
  }
  view.dispatch({
    selection: { anchor: doc.line(last).to },
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
 * 独占整行的开/闭定界块（```…``` / $$…$$）插入。定界符必须自己占一行——
 * 粘在正文后面既不是合法围栏也不是块公式：当前行为空行时原位替换（顺带清掉
 * 纯空白），否则插到本行行尾之后。内部空行与闭栏继承本行缩进（块留在列表
 * 项内）。光标位置从构造出的插入串推导，落在内部空行行首——开栏内容
 * （语言等）变化时无需再调偏移量。
 */
function insertOwnLineBlock(view: EditorView, open: string, close: string, userEvent: string) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const blank = line.text.trim() === "";
  const indent = blank ? "" : (line.text.match(/^\s*/)?.[0] ?? "");
  const insert = (blank ? "" : "\n") + open + "\n" + indent + "\n" + indent + close;
  const from = blank ? line.from : line.to;
  const cursor = from + (blank ? 0 : 1) + open.length + 1 + indent.length;

  view.dispatch({
    changes: blank ? { from: line.from, to: line.to, insert } : { from, insert },
    selection: { anchor: cursor },
    userEvent,
  });
  view.focus();
}

/** Inserts a $$ … $$ block on its own lines and places the cursor inside. */
export function insertMathBlock(view: EditorView) {
  insertOwnLineBlock(view, "$$", "$$", "input.bnote-math-block");
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
function fenceInfoString(): string {
  return useAppStore.getState().settings.codeBlockLang.replace(/[`\r\n]/g, "").trim();
}

/**
 * 插入代码块：无选区时在光标处开一个带设置语言的开栏，光标落在内部空行；
 * 有选区时把覆盖的行包进围栏（围栏独占整行，行中选区扩展到整行），选区
 * 两端平移进块内。
 */
export function insertCodeBlock(view: EditorView) {
  const state = view.state;
  const range = state.selection.main;
  const open = "```" + fenceInfoString();
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
  insertOwnLineBlock(view, open, "```", "input.bnote-code-block");
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
