import { EditorState, type Text } from "@codemirror/state";
import { fenceStateScan } from "@/editor/context";
import { DONE_STAMP_RE } from "@/editor/ops";

/**
 * Pure text model for cross-file todo sync: list line parsing, todo block
 * extraction, and parsing plus editing of the todo region at the head of a daily
 * note. Every function takes only line text or CM Text and does no IO - engine.ts
 * drives the orchestration, this module owns the single source of truth for what
 * the document looks like and where a change lands. All rules are locked down in
 * model.test.ts.
 */

// ---------------------------------------------------------------- line model

const LIST_LINE_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;
const BOX_RE = /^\[([ xX])\][ \t]?/;

export interface ListLine {
  /** Leading whitespace verbatim (tabs/spaces preserved, same convention as enterContinueListItem) */
  indent: string;
  /** "-" / "*" / "+" / "1." / "2)" */
  marker: string;
  /** Whitespace between the marker and the content */
  gap: string;
  /** Checkbox state; null = plain list item (no checkbox) */
  box: " " | "x" | "X" | null;
  /** Line content after the checkbox (after the marker when there is no checkbox) */
  text: string;
}

export function parseListLine(text: string): ListLine | null {
  const m = LIST_LINE_RE.exec(text);
  if (!m) return null;
  let box: ListLine["box"] = null;
  let content = m[4];
  const b = BOX_RE.exec(content);
  if (b) {
    box = b[1] as ListLine["box"];
    content = content.slice(b[0].length);
  }
  return { indent: m[1], marker: m[2], gap: m[3], box, text: content };
}

/** Whether the line is a todo line (a list item carrying a checkbox). */
export function isTodo(l: ListLine | null): l is ListLine & { box: " " | "x" | "X" } {
  return l !== null && l.box !== null;
}

/** Identity text of a todo: the done stamp stripped and both ends trimmed. Link anchors and entry matching both use it. */
export function todoText(l: ListLine): string {
  return l.text.replace(DONE_STAMP_RE, "").trim();
}

/** Identity text of the todo on document line n (1-based); null when that line is not a todo. */
export function todoTextAt(doc: Text, lineNo: number): string | null {
  const p = parseListLine(doc.line(lineNo).text);
  return isTodo(p) ? todoText(p) : null;
}

// ---------------------------------------------------------------- block extraction

/**
 * Root of the todo block holding `lineNo`: walk up the chain of ancestors whose
 * indent is strictly shallower. A blank or non-list line breaks the chain; a line
 * at the same or deeper indent is a sibling or a child, so it is skipped. Indent 0
 * is the root itself. The 500 step cap is insurance against malformed documents
 * (endless same-level chains); real blocks are far smaller.
 */
export function blockRootLine(doc: Text, lineNo: number): number {
  const cur = parseListLine(doc.line(lineNo).text);
  if (!cur) return lineNo;
  let depth = cur.indent.length;
  if (depth === 0) return lineNo;
  let root = lineNo;
  for (let n = lineNo - 1; n >= 1 && lineNo - n <= 500; n--) {
    const p = parseListLine(doc.line(n).text);
    if (!p) break;
    if (p.indent.length < depth) {
      root = n;
      depth = p.indent.length;
      if (depth === 0) break;
    }
  }
  return root;
}

/** Last line of a todo block: the run of deeper list lines after the root, ending at a blank line, a non-list line, or a line at the same depth. */
export function blockEnd(doc: Text, rootNo: number): number {
  const root = parseListLine(doc.line(rootNo).text);
  if (!root) return rootNo;
  let end = rootNo;
  for (let n = rootNo + 1; n <= doc.lines; n++) {
    const p = parseListLine(doc.line(n).text);
    if (!p || p.indent.length <= root.indent.length) break;
    end = n;
  }
  return end;
}

/** Line texts of the block (the root plus its deeper list lines). */
export function blockLines(doc: Text, rootNo: number): string[] {
  const out: string[] = [];
  for (let n = rootNo; n <= blockEnd(doc, rootNo); n++) out.push(doc.line(n).text);
  return out;
}

/**
 * Re-indent a block: strip up to `stripLen` leading whitespace from every line
 * (whitespace only, so a marker is never eaten) and prefix the target root indent
 * - the relative indent of the children survives. The source root indent is
 * `stripLen`, the target root indent is `toIndent`.
 */
export function reindentBlock(lines: string[], stripLen: number, toIndent: string): string[] {
  if (stripLen <= 0 && toIndent === "") return lines;
  const strip = new RegExp(`^[ \\t]{0,${stripLen}}`);
  return lines.map((l) => toIndent + l.replace(strip, ""));
}

// ---------------------------------------------------------------- daily note todo region

const BLANK_RE = /^\s*$/;
const HEADER_RE = /^#\s/;

/** One top-level entry of the todo region at the head of a daily note (1-based line range). */
export interface DailyEntry {
  start: number;
  end: number;
}

export interface DailyRegion {
  /** Header H1 line number (1-based); 0 when there is no header. */
  headerEnd: number;
  /** Top-level entries, in document order. */
  entries: DailyEntry[];
  /** Last list line inside the region; equals headerEnd when there are no entries. */
  lastListLine: number;
}

/**
 * Structure of a daily note: an optional `# title` line, then (skipping blank
 * lines) the todo region - a run of list lines where a top-level entry starts at
 * a list line with indent 0 and deeper lines belong to the current entry. A
 * single blank line between entries is a separator (the region only continues when
 * a list line follows it). The first non-blank non-list line ends the region;
 * everything after it is the user's prose.
 */
export function parseDailyRegion(doc: Text): DailyRegion {
  const headerEnd = doc.lines >= 1 && HEADER_RE.test(doc.line(1).text) ? 1 : 0;
  let i = headerEnd + 1;
  while (i <= doc.lines && BLANK_RE.test(doc.line(i).text)) i++;
  const entries: DailyEntry[] = [];
  let cur: DailyEntry | null = null;
  let lastListLine = headerEnd;
  for (; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (BLANK_RE.test(text)) {
      if (i + 1 <= doc.lines && parseListLine(doc.line(i + 1).text)) continue;
      break;
    }
    const p = parseListLine(text);
    if (!p) break;
    if (p.indent.length === 0) {
      cur = { start: i, end: i };
      entries.push(cur);
    } else if (cur) {
      cur.end = i;
    } else {
      break; // a deeper line before any top-level entry: not part of the todo region
    }
    lastListLine = i;
  }
  return { headerEnd, entries, lastListLine };
}

/** Find the entry in the region whose identity text is `normalized`; with several matches take the one closest to `nearLine`. */
export function findEntryByText(
  doc: Text,
  region: DailyRegion,
  normalized: string,
  nearLine: number,
): DailyEntry | null {
  let best: DailyEntry | null = null;
  let bestDist = Infinity;
  for (const e of region.entries) {
    const p = parseListLine(doc.line(e.start).text);
    if (!isTodo(p) || todoText(p) !== normalized) continue;
    const d = Math.abs(e.start - nearLine);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

// ---------------------------------------------------------------- change specs

export interface DocChange {
  from: number;
  to?: number;
  insert?: string;
}

/**
 * Append one top-level entry (chronological order: right after the last entry;
 * after the header when the region is empty; at the top of the file when there is
 * no header and the document is not empty). The returned line range is where the
 * new entry lands in the new document.
 */
export function appendEntrySpec(
  doc: Text,
  region: DailyRegion,
  block: string[],
): { change: DocChange; entry: DailyEntry } {
  const text = block.join("\n");
  let at: number;
  let start: number;
  if (region.entries.length > 0) {
    at = doc.line(region.lastListLine).to;
    start = region.lastListLine + 1;
  } else if (region.headerEnd >= 1) {
    at = doc.line(region.headerEnd).to;
    start = region.headerEnd + 2; // header plus one blank line
  } else if (doc.length === 0) {
    at = 0;
    start = 1;
  } else {
    at = 0;
    start = 1;
  }
  const lines = text === "" ? 0 : text.split("\n").length;
  const insert =
    region.entries.length > 0 ? "\n" + text : region.headerEnd >= 1 ? "\n\n" + text : doc.length === 0 ? text : text + "\n\n";
  return { change: { from: at, insert }, entry: { start, end: start + Math.max(0, lines - 1) } };
}

/**
 * Insert one top-level entry at the front of the todo region (quick capture).
 * With an empty region this matches appendEntrySpec (after the header, or at the
 * top of the file when there is no header), so the written shape stays identical
 * to what the engine produces.
 */
export function prependEntrySpec(
  doc: Text,
  region: DailyRegion,
  block: string[],
): { change: DocChange; entry: DailyEntry } {
  if (region.entries.length === 0) return appendEntrySpec(doc, region, block);
  const text = block.join("\n");
  const at = doc.line(region.entries[0].start).from;
  const lines = text === "" ? 0 : text.split("\n").length;
  return {
    change: { from: at, insert: text + "\n" },
    entry: { start: region.entries[0].start, end: region.entries[0].start + Math.max(0, lines - 1) },
  };
}

/** Replace an entry wholesale with a new block. */
export function replaceEntrySpec(doc: Text, entry: DailyEntry, block: string[]): DocChange {
  return { from: doc.line(entry.start).from, to: doc.line(entry.end).to, insert: block.join("\n") };
}

/** Delete an entry (whole-line semantics, the trailing newline goes with it);
 * the single blank line right after it is removed as well, so repeated add and
 * remove cycles do not pile up blank lines. When the deletion reaches the end of
 * the file (the region is now empty) the separating blank line after the header is
 * removed too, so no empty tail is left behind. */
export function removeEntrySpec(doc: Text, entry: DailyEntry): DocChange {
  const afterEnd = entry.end + 1;
  let from = doc.line(entry.start).from;
  let to: number;
  if (afterEnd <= doc.lines && BLANK_RE.test(doc.line(afterEnd).text)) {
    to = afterEnd + 1 <= doc.lines ? doc.line(afterEnd + 1).from : doc.length;
  } else {
    to = afterEnd <= doc.lines ? doc.line(afterEnd).from : doc.length;
  }
  if (to >= doc.length && entry.start > 1 && BLANK_RE.test(doc.line(entry.start - 1).text)) {
    from = doc.line(entry.start - 1).from;
  }
  return { from, to };
}

/** Apply change specs to document text (pure string arithmetic, used for files that are not open in an editor). */
export function textAfterChanges(docText: string, specs: DocChange[]): string {
  const state = EditorStateOf(docText);
  return state.update({ changes: specs }).state.doc.toString();
}

// ---------------------------------------------------------------- paths and lookup

const DAILY_FILE_RE = /\/Daily\/(\d{4}-\d{2}-\d{2})\.md$/;

/** Whether the path is a daily note file (`<vault>/Daily/YYYY-MM-DD.md`, any day). */
export function isDailyPath(path: string): boolean {
  return dailyDayOf(path) !== null;
}

/** The date (YYYY-MM-DD) encoded in a daily note path; null for any other path. */
export function dailyDayOf(path: string): string | null {
  return DAILY_FILE_RE.exec(path)?.[1] ?? null;
}

/** Absolute path of the daily note for a given day. */
export function dailyPathFor(vaultRoot: string, day: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/Daily/${day}.md`;
}

/** Initial content of a newly created daily note. The send/record path and
 *  "open today's daily note" share the same shape (H1 plus the todo region after
 *  it), so files created through either entry point are byte-identical. */
export function dailyScaffold(day: string): string {
  return `# ${day}\n`;
}

/** Path of the link metadata file (inside the vault, travels with the repo). */
export function linksFilePath(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/.bnote/daily-links.json`;
}

/**
 * Find the todo block root line in the document whose identity text is one of
 * `texts`: try the hint line first, then look in the hint +/- 30 line window by
 * distance, then the whole document (a low-frequency path after debouncing, so
 * the full scan is acceptable). Returns null when nothing matches.
 */
export function resolveRootLine(doc: Text, texts: string[], hint: number | null): number | null {
  const want = new Set(texts);
  const matchAt = (n: number) => {
    const t = todoTextAt(doc, n);
    return t !== null && want.has(t);
  };
  if (hint !== null && hint >= 1 && hint <= doc.lines && matchAt(hint)) return hint;
  if (hint !== null) {
    const from = Math.max(1, hint - 30);
    const to = Math.min(doc.lines, hint + 30);
    for (let n = from; n <= to; n++) if (matchAt(n)) return n;
  }
  for (let n = 1; n <= doc.lines; n++) if (matchAt(n)) return n;
  return null;
}

function EditorStateOf(docText: string): EditorState {
  return EditorState.create({ doc: docText });
}

// ---------------------------------------------------------------- todo rollover

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** Lines kept from a block: the unfinished lines plus the ancestor chain of every unfinished descendant; null when nothing is unfinished. */
function carriedLines(doc: Text, rootNo: number, endNo: number): string[] | null {
  const indent: number[] = [];
  const kept: boolean[] = [];
  for (let n = rootNo; n <= endNo; n++) {
    const p = parseListLine(doc.line(n).text);
    if (!p) break; // blockEnd guarantees every line up to endNo is a list line
    indent.push(p.indent.length);
    kept.push(p.box === " ");
  }
  // Add anchors bottom-up: when the window of deeper consecutive lines holds a
  // kept descendant, this line has to stay too, otherwise the hierarchy breaks.
  // The window closes at the first line with indent <= this line's, so it never
  // reaches into a sibling subtree.
  for (let i = kept.length - 2; i >= 0; i--) {
    if (kept[i]) continue;
    for (let j = i + 1; j < kept.length && indent[j] > indent[i]; j++) {
      if (kept[j]) {
        kept[i] = true;
        break;
      }
    }
  }
  if (!kept.some(Boolean)) return null;
  const lines: string[] = [];
  for (let i = 0; i < kept.length; i++) if (kept[i]) lines.push(doc.line(rootNo + i).text);
  return lines;
}

/** Top-level list blocks (lines inside fenced code do not count): root line
 *  number and block end line. The root is a list line with indent 0 (todo or plain
 *  bullet - filtering is left to the caller, which knows the semantics). */
function topBlocks(doc: Text, fenced: boolean[]): { rootNo: number; endNo: number }[] {
  const out: { rootNo: number; endNo: number }[] = [];
  let n = 1;
  while (n <= doc.lines) {
    if (fenced[n - 1]) {
      n++;
      continue;
    }
    const p = parseListLine(doc.line(n).text);
    if (!p || p.indent.length > 0) {
      n++;
      continue;
    }
    const end = blockEnd(doc, n);
    out.push({ rootNo: n, endNo: end });
    n = end + 1;
  }
  return out;
}

/**
 * Block extraction for todo rollover: every block in the daily note that contains
 * an unfinished item (including blocks rooted at a plain bullet and todos with
 * empty text - handwritten shapes in the daily note get no special casing). The
 * rollover rule lives in carriedLines.
 */
export function rolloverBlocks(prevText: string): string[][] {
  const doc = EditorState.create({ doc: prevText }).doc;
  const fenced = fenceStateScan(doc);
  const out: string[][] = [];
  for (const b of topBlocks(doc, fenced)) {
    const carried = carriedLines(doc, b.rootNo, b.endNo);
    if (carried) out.push(carried);
  }
  return out;
}

/** The most recent daily note date earlier than `today` among the file names in
 *  Daily/; null when there is none. After a few days without writing we roll over
 *  from the most recent note, not strictly from "yesterday". */
export function previousDailyFile(names: string[], today: string): string | null {
  let best: string | null = null;
  for (const name of names) {
    const m = DATE_FILE_RE.exec(name);
    if (!m || m[1] >= today) continue;
    if (best === null || m[1] > best) best = m[1];
  }
  return best;
}

/** Initial content of a new daily note: the body start (the bare scaffold by
 *  default, the template body when a template is configured) plus one
 *  appendEntrySpec per block, producing the same shape the engine writes to disk
 *  (entries follow the header, adjacent entries are separated by a single
 *  newline, and the file ends with one newline). */
export function composeDailyScaffold(
  day: string,
  blocks: string[][],
  base: string = dailyScaffold(day),
): string {
  let text = base;
  for (const block of blocks) {
    const doc = EditorState.create({ doc: text }).doc;
    const { change } = appendEntrySpec(doc, parseDailyRegion(doc), block);
    text = textAfterChanges(text, [change]);
  }
  return text;
}
