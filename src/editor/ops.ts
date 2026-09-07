import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { renumberHeadings } from "./numbering";
import { useAppStore } from "@/state/appStore";

/** Text-editing operations shared by commands and keybindings. */

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
