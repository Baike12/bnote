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
import { DONE_STAMP_RE, todayStamp } from "@/lib/todoStamp";

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
  // No number sequence continuation with multiple cursors: changeByRange
  // composes the changes of all ranges as start-document coordinates, and a
  // continuation change could land inside another cursor's edit range, which
  // garbles the composed result (the primary edit itself stays within its own
  // line, and the ranges do not overlap).
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
    // When the tree is not ready yet (file just loaded) the shared decision
    // falls back to the line scan internally, so the guard always holds.
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
 * The heading level cycle (repeating the same shortcut): body -> H1 -> H2 ->
 * H3 -> H4 -> body. H5/H6 are only reachable through "set to N-level heading",
 * and the next step from them is also "unset". With multiple cursors or a
 * multi-line selection each line advances one step; the leftover automatic
 * numbering is cleaned up by the command layer.
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

      // With the tree covering that line the tree query is used (it
      // recognizes deeply indented fences); the empty tree of a freshly
      // loaded file does not find them. Fence lines do not take part in the
      // list/heading conversion: the tree query handles the tree-ready case
      // and the line scan is the fallback when the tree has not caught up —
      // otherwise converting right after a file switch would also rewrite the
      // markers inside the fence.
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
 * The round trip: body -> the end of the last todo item of the document
 * header -> back to the position before the jump. The header todo block =
 * the run of todo lines (`- [ ]` / `- [x]` / ordered todos, blank lines
 * allowed in between) starting at the "start line"; the first non-empty,
 * non-todo line ends the block.
 *
 * The start line depends on the shape of the file: for a daily note
 * (Daily/YYYY-MM-DD.md) the todo area is after the date heading (from line 2
 * when there is an H1, the same region as parseDailyRegion in daily); for
 * other notes the header todo area is the very top of the file (from line 1)
 * — in a note todos are habitually written on the first line (writing them to
 * the top of the note is the same position for the cross-file sync), and
 * that is true even when the first line is an H1 heading: a new todo is
 * inserted before the title. When the header has no todo block yet, an empty
 * todo is created (after the H1 for a daily note, at the top of the document
 * for a plain note, with the caret after the todo marker so you can type
 * right away); pressing it again returns to the previous position. When the
 * caret is already at the header position but a return memory exists, it
 * jumps back.
 */
const HEADER_TODO_RE = /^(\s*)(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/;
const BLANK_LINE_RE = /^\s*$/;
/** The H1 header test (same shape as HEADER_RE in daily): line 1 is a `# ` heading → the todo area starts at line 2. */
const H1_RE = /^#\s/;
/** The daily note test: a date file name under the Daily directory (same shape as dailyPathFor). */
export const DAILY_FILE_RE = /(^|\/)Daily\/\d{4}-\d{2}-\d{2}\.md$/;

/** The decision of one ⌘T (a pure function, the contract lives in ops.test.ts):
 *  jump = jump to anchor; back = go back to the return memory; stay = silently
 *  do nothing; create = insert `insert` at `at` and put the caret at `cursor`
 *  (after the todo marker). */
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
  // Scan only up to the first non-empty non-todo line: the header block is
  // usually a few lines, so the cost does not depend on the document length.
  for (let n = start; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (HEADER_TODO_RE.test(text)) {
      if (first === null) first = n;
      last = n;
      continue;
    }
    if (BLANK_LINE_RE.test(text)) continue;
    break; // the first non-empty non-todo line ends the header todo block
  }
  if (first !== null && last !== null) {
    if (headLine >= first && headLine <= last) {
      return hasReturn ? { action: "back" } : { action: "stay" };
    }
    return { action: "jump", anchor: doc.line(last).to };
  }
  // The header has no todo block yet. The caret already sits at "where the
  // block will grow" (the start line or the heading before it): with a return
  // memory it jumps back (the round trip comes first), otherwise it creates
  // the block in place; a caret after the start line remembers where it came
  // from and creates the block.
  if (headLine <= start && hasReturn) return { action: "back" };
  if (headerDoc) {
    // Daily note: the empty todo grows after the H1, matching the start of
    // the todo area in parseDailyRegion.
    const at = doc.line(1).to;
    const insert = "\n- [ ] ";
    return { action: "create", at, insert, cursor: at + insert.length };
  }
  // Plain note: the empty todo becomes the first line of the file (an H1
  // heading is pushed to the second line as well — the header todo area of a
  // note is the very top of the file). An empty document gets no trailing
  // newline; a non-empty document has its original first line pushed down.
  // The caret always lands at the end of the `- [ ] ` line (after the todo
  // marker), regardless of whether the inserted string carries a trailing
  // newline.
  const insert = doc.lines === 1 && doc.line(1).text === "" ? "- [ ] " : "- [ ] \n";
  return { action: "create", at: 0, insert, cursor: "- [ ] ".length };
}

/**
 * The "where I came from" memory of the round trip: file path -> the caret
 * (line number + column) and scroll position before the jump. Evicted in
 * access order with a cap of 64 entries (enough for any realistic multi-file
 * round-trip workflow), so the memory usage stays bounded. It is read and
 * written only when the shortcut is pressed, never hooked into any editing
 * cycle. It stores line and column rather than an absolute pos: after the
 * jump the user types at the target and the content of the origin line is
 * unaffected, so the return is exact. ⌘T (the header todo) and ⌘⇧B (the
 * callout anchor) each keep their own copy, and the two round-trip memories
 * never overwrite each other.
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
    /** Writes the spot and refreshes the eviction order. */
    set(path: string, spot: ReturnSpot) {
      map.delete(path);
      map.set(path, spot);
      if (map.size > RETURN_MAX) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    /** Only refreshes the eviction order (the memory survives the jump back, so the round trip can be taken repeatedly). */
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

/** Test hook: clears the round-trip memory (the module-level Map would leak across test cases). */
export function resetHeaderTodoReturnForTest(): void {
  headerTodoReturn.clear();
}

/** Test hook: clears the ⌘⇧B round-trip memory. */
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
    // Already at the target: go back to where the note was written (a
    // line/column anchor, clamped to the line end when the line got shorter).
    const saved = headerTodoReturn.get(path)!;
    headerTodoReturn.touch(path); // refresh the eviction order, the round trip can be taken repeatedly
    const line = doc.line(Math.min(saved.line, doc.lines));
    view.dispatch({
      selection: { anchor: Math.min(line.from + saved.col, line.to) },
      scrollIntoView: true,
    });
    view.scrollDOM.scrollTop = Math.max(0, Math.min(saved.scroll, view.scrollDOM.scrollHeight));
    return;
  }
  // In the body: remember the current position, then jump to the target or
  // create an empty todo. When the created whole line is inserted before the
  // origin, the origin's line number shifts with the insertion (the column
  // within the line stays the same).
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
    // The empty todo grows at the start of the header and the caret lands at
    // the end of the `- [ ] ` line, ready to type.
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
 * Inserts a block that occupies whole lines (```…``` / $$…$$ and the LaTeX
 * environment lines). open/close are given per line and concatenated line by
 * line (a math block is the two lines `$$` + `\begin{align}`, with the blank
 * line in between left for the caret). The delimiters must own a line each —
 * glued to the body they are neither a legal fence nor a block formula: the
 * current behavior replaces a blank line in place (clearing the pure
 * whitespace along the way), otherwise it inserts after the end of the
 * current line. The first line (the opening) is not indented, the remaining
 * lines (the environment line, the inner blank line, the closing) inherit
 * the indent of the current line (so the block stays inside the list item).
 * The caret position is derived from the constructed insert string — it
 * always lands after the indent of the inner blank line (the first content
 * position inside the block, ready to type).
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
 * Inserts a Callout block (`:::` container, ⌘⇧B). Four landing cases:
 *
 *  - With a selection: "insert with selection" — a callout titled with the
 *    selected text is created after the line of the selection (a selection
 *    inside a fenced code block / display math block extends past that block,
 *    so the block is not cut in half), separated from the preceding text by
 *    one blank line, and the caret lands on the blank line inside the block
 *    so the explanation can be typed right away; the selected original stays
 *    in place and renders as an underlined dashed anchor (calloutAnchor.ts
 *    derives it from "title = body text"), and pressing ⌘⇧B again with the
 *    caret inside that anchor jumps to this block.
 *  - Without a selection, caret inside a callout: the round trip (jump back
 *    with a return memory; otherwise open a new block in place).
 *  - Without a selection, caret on an anchor: jump to the linked callout.
 *  - Otherwise: open an empty block in place — a blank line is replaced in
 *    place, otherwise it is inserted after the end of the current line. The
 *    inserted shape is two adjacent lines, the opening and the closing; the
 *    opening carries a trailing space as the title slot and the caret lands
 *    right after that slot — so a title can be typed immediately
 *    (`::: title`), and pressing Enter then yields the body line of the block
 *    (no blank line is pre-inserted between the two lines, so Enter does not
 *    have to delete a line first); pressing Enter without a title gives a
 *    titleless bare block. Both lines are always at column 0: callout.ts
 *    only recognizes column-0 markers, so an indented closing line could
 *    never close the block.
 */
export function insertCallout(view: EditorView) {
  // The selection of a vim visual mode must be taken from the engine first
  // (the CM selection of linewise/blockwise is incomplete) — that also exits
  // visual mode, so the command consumes this selection.
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
 * The single-line form of the selected content used as the title: newlines
 * (a multi-line selection) are squeezed into spaces and runs of whitespace
 * into a single space. A callout title is single-line syntax (the rest of
 * the opening line); after squeezing, the anchor matching end stays
 * whitespace-flexible (see calloutAnchor.findTitleMatches), so the original
 * text still matches at its place.
 */
function normalizeCalloutTitle(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * The landing point of "insert with selection": the end of the last line of
 * the "block" the selection is in. For plain text that is the last line of
 * the selection; a selection inside a fenced code block or a display math
 * block extends to the last line of that block — inserting in the middle of
 * the block would cut it in half (the fence / $$ would be torn apart), only
 * growing the callout after the whole block keeps it intact.
 */
export function calloutInsertAnchor(state: EditorState, from: number, to: number): number {
  const doc = state.doc;
  const end = Math.max(from, to - 1);
  let anchorLine = doc.lineAt(end).number;
  // Fenced code block: the line scan shares its source with the callout scan
  // (accurate even when the tree is not ready). When the last line of the
  // selection is inside a fence, look further down for the first line that
  // leaves the fence; the line before it is the closing line of the block
  // (for an unclosed fence reaching the end of the document, the last line).
  const inside = fenceStateScan(doc);
  if (inside[anchorLine - 1]) {
    let n = anchorLine;
    while (n <= doc.lines && inside[n - 1]) n++;
    anchorLine = Math.min(n - 1, doc.lines);
  }
  // Display math block: when the selection intersects the region, extend to
  // the last line of the region (the latest of those regions).
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
 * Inserts a titled callout after `at` (the end of some line). Exactly one
 * blank line separates it from the preceding text: a non-empty landing line
 * gets two newlines (one blank line between the original text and the
 * opening), a landing line that is itself blank (the empty tail line of an
 * unclosed fence reaching the end of the document) gets only one. The caret
 * lands on the blank line inside the block (after the opening line), so
 * typing right away produces the block content; the content that followed
 * `at` is pushed behind the block.
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

/** The decision of one ⌘⇧B without a selection (a pure function, the
 *  contract lives in ops.test.ts):
 *  anchor-jump = the caret is on an anchor, jump to the linked callout;
 *  back = already inside a callout with a return memory, jump back;
 *  insert = open an empty block in place. */
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
  // The caret is inside some callout (boundary lines included, the same range
  // as the activity rule of the boundary lines): the round trip comes first —
  // having just jumped into the block, pressing again goes back; editing
  // inside a block with no return memory still opens a new block in place.
  if (callouts.some((c) => head >= c.from && head <= c.to)) {
    return hasReturn ? { action: "back" } : { action: "insert" };
  }
  const region = anchorRegionAt(doc, callouts, head);
  if (region) return { action: "anchor-jump", region };
  return { action: "insert" };
}

/** ⌘⇧B without a selection: anchor jump / round-trip jump back / insert an empty block in place. */
function jumpOrInsertCallout(view: EditorView) {
  const state = view.state;
  const doc = state.doc;
  const path = useAppStore.getState().currentFile ?? "";
  const head = state.selection.main.head;
  const plan = planCalloutShortcut(doc, calloutRegions(state), head, calloutReturn.has(path));
  if (plan.action === "back") {
    // Already inside a callout: go back to the body position from before the
    // jump (a line/column anchor, clamped to the line end when the line got
    // shorter).
    const saved = calloutReturn.get(path)!;
    calloutReturn.touch(path); // refresh the eviction order, the round trip can be taken repeatedly
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
    // The landing point = the end of the opening line (after the title
    // slot): the same position as "when creating a block from a selection
    // the caret lands in the title slot"; with the caret already inside the
    // block, pressing ⌘⇧B again jumps back.
    view.dispatch({
      selection: { anchor: doc.line(plan.region.openLine).to },
      scrollIntoView: true,
    });
    return;
  }
  insertEmptyCallout(view);
}

/** Inserts an empty callout block in place (a blank line is replaced in place, otherwise it is inserted after the end of the current line). */
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
 * Inserts a math block (⌘M): it natively provides the skeleton of an aligned
 * environment — `\begin{align}…\end{align}` nested between the `$$`
 * delimiter lines, with the caret on the blank line inside the environment.
 *
 * Same shape as the `dm` / `#@` snippets, except that the shortcut reaches
 * it directly without typing a trigger word first. The alignment of the
 * equals signs and the line breaks are not pre-inserted: pressing Enter
 * inside an align environment is handled by alignEnter in matrix.ts (it adds
 * the alignment point `&` before the first bare relation operator and a ` \\`
 * at the line end), so the insertion only provides the environment and the
 * landing point.
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

/** The shape of `[[target]]` / `[[target|alias]]`, the same source as the rendering regex in livePreview. */
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

/**
 * The first link target on the caret's line (`[[target|alias]]` and
 * `[[target#heading]]` both yield the target); a `[[…]]` inside inline code
 * or fenced code does not count — that is sample text, not a link. Only one
 * link is allowed per line, so the first one is that line's link.
 */
export function wikilinkTargetOnLine(view: EditorView): string | null {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  if (!line.text.includes("[[")) return null;
  // Once the syntax tree has parsed that line, getContextAt can tell fenced
  // code / inline code apart; the whole-line scan is only the fallback right
  // after a load, when the tree has not caught up yet (the same convention as
  // the list continuation on Enter). Scanning unconditionally would cost
  // O(lines before the caret) — about 4.5ms in a 10k-line document with the
  // caret at the bottom, paid on every press.
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
 * Writes a link into the document: with a selection the selected text becomes
 * the alias (`[[target|alias]]` replaces the selection), otherwise it is
 * inserted at the caret and the caret lands after the link. Link syntax
 * characters inside the alias would truncate the link, so they are all
 * replaced with spaces.
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
 * The fence info string: strips backticks and newlines (they would end the
 * fence early) and trims whitespace; empty = a bare ```.
 */
function fenceInfoString(langOverride?: string): string {
  const raw = langOverride ?? useAppStore.getState().settings.codeBlockLang;
  return raw.replace(/[`\r\n]/g, "").trim();
}

/**
 * Inserts a code block: without a selection it opens a fence with the
 * configured language at the caret and the caret lands on the inner blank
 * line; with a selection it wraps the covered lines in a fence (the fence
 * owns whole lines, so a selection inside a line extends to whole lines) and
 * both ends of the selection shift into the block.
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

/** The text of all non-empty selections (sorted by document position, multiple cursors joined by a newline). */
function selectedText(state: EditorState): string {
  const ranges = [...state.selection.ranges].sort((a, b) => a.from - b.from);
  return ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join(state.lineBreak);
}

/**
 * ⌘C: writes the selected content to the system clipboard. wry's WKWebView
 * sends ⌘ chords into the page as ordinary keydowns and the AppKit menu roles
 * never see them, so copy and paste must be implemented explicitly here;
 * without a selection it lets the event through (there is nothing to do
 * anyway).
 */
export function copySelection(view: EditorView): boolean {
  const text = selectedText(view.state);
  if (!text) return false;
  void writeClipboardText(text);
  return true;
}

/** ⌘X: writes to the clipboard and deletes the selected content. */
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
 * ⌘V: reads the system clipboard and replaces every selection (multiple
 * cursors paste the same text), with the caret landing after the inserted
 * text. The IPC is asynchronous: when it completes the action runs against
 * the then-current selections (changeByRange reads the resolved state), not
 * against the caret of the keystroke moment, so no stale write happens.
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
