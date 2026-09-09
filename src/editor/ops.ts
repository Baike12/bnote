import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { insideFencedCodeByScan } from "./context";
import type { SyntaxNode } from "@lezer/common";
import { renumberHeadings } from "./numbering";
import { useAppStore } from "@/state/appStore";

/** Text-editing operations shared by commands and keybindings. */

const BULLET_ITEM_RE = /^([ \t]*)([-*+])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;
const ORDERED_ITEM_RE = /^([ \t]*)(\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;

/**
 * Enter on a bullet / todo line, bnote-style: continue the item with the
 * EXACT leading whitespace of the current line and repeat the marker, with a
 * fresh unchecked box. lang-markdown's insertNewlineContinueMarkup would
 * expand tab indentation to spaces (countColumn), which livePreview then
 * renders as a much deeper indent than the tab-indented siblings. An empty
 * item exits the list instead of starting a new one (Obsidian behavior).
 * Ordered lists and non-markdown contexts fall
 * through to insertNewlineContinueMarkup. A cursor sitting on the marker
 * (e.g. right after toggling the checkbox) continues the item from its end,
 * and a cursor before the bullet opens a blank line above.
 */
export function enterContinueListItem(view: EditorView): boolean {
  const state = view.state;
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
    const m = BULLET_ITEM_RE.exec(line.text);
    if (!m) return unhandled();
    const [, indent, bullet, gap, box] = m;
    const markerLen = indent.length + bullet.length + gap.length + (box?.length ?? 0);
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
      // On the bullet/gap/box: continue with a fresh item from the line end.
      pos = line.to;
    }

    if (m[5].trim() === "") {
      // Empty item: exit the list — strip marker and anything after it.
      return {
        changes: { from: line.from + indent.length, to: line.to, insert: "" },
        range: EditorSelection.cursor(line.from + indent.length),
      };
    }
    // Continue / split: absorb surrounding whitespace like lang-markdown does.
    let from = pos;
    let to = pos;
    while (from > line.from && /\s/.test(line.text[from - line.from - 1])) from--;
    while (to < line.to && /\s/.test(line.text[to - line.from])) to++;
    const newMarker = box ? `${bullet} [ ] ` : `${bullet} `;
    return {
      changes: { from, to, insert: state.lineBreak + indent + newMarker },
      range: EditorSelection.cursor(from + 1 + indent.length + newMarker.length),
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

/** Inserts a $$ … $$ block on its own lines and places the cursor inside. */
export function insertMathBlock(view: EditorView) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const indent = line.text.match(/^\s*/)?.[0] ?? "";
  const atLineEnd = pos === line.to;
  const insert = (atLineEnd ? "" : "\n") + "$$\n" + indent + "\n" + indent + "$$";
  const from = atLineEnd ? pos : line.to;
  const cursor = from + 3 + indent.length;

  view.dispatch({
    changes: { from, insert },
    selection: { anchor: cursor },
    userEvent: "input.bnote-math-block",
  });
  view.focus();
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

export function insertCodeBlock(view: EditorView) {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const indent = line.text.match(/^\s*/)?.[0] ?? "";
  const atLineEnd = pos === line.to;
  const insert = (atLineEnd ? "" : "\n") + "```ts\n" + indent + "\n" + indent + "```";
  const from = atLineEnd ? pos : line.to;
  const cursor = from + 4;

  view.dispatch({
    changes: { from, insert },
    selection: { anchor: cursor },
    userEvent: "input.bnote-code-block",
  });
  view.focus();
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
