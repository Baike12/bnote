/**
 * Pure text model of today's footprint: block splitting, block identity and the
 * diff of today's additions. Every function takes only strings and does no IO -
 * store owns reading the disk and the rotation orchestration, this module owns the
 * single source of truth for "what was written today". All rules are locked down
 * in model.test.ts.
 *
 * Semantics: the footprint of a file today = the blocks that are in the current
 * text but not in today's baseline. A block is a run of consecutive lines
 * separated by blank lines; its identity is the block text (trailing whitespace
 * stripped per line, the whole block trimmed) - trailing space jitter and a
 * wholesale re-indent do not create a false new block, changed content is a new
 * block (the new version is shown), and a deleted block is not shown (a
 * quote-style aggregation only shows content that still exists).
 *
 * Todo blocks never enter the footprint: todos already have their own channel
 * into the daily note (the cross-file sync mirrors them into the head of the
 * note). The same content on two channels would show up twice in the daily note
 * (one from the sync, one from the footprint), so a block that contains a todo
 * line belongs entirely to the sync, and the footprint check filters those blocks
 * at the exit of the diff.
 */

import { isTodo, parseListLine } from "@/daily/model";

/** A block: a run of consecutive lines separated by blank lines. start/end are 1-based line numbers into the text it belongs to. */
export interface FootprintBlock {
  /** Line texts of the block (without the trailing newline). */
  text: string;
  start: number;
  end: number;
}

const BLANK_RE = /^\s*$/;

/** Whether the block contains a todo line (the check comes from the same source as the todo sync engine: parseListLine + isTodo). */
export function blockHasTodo(text: string): boolean {
  return text.split("\n").some((l) => isTodo(parseListLine(l)));
}

/** Split the document into blank-line separated blocks (1-based line ranges). Leading and trailing blank lines as well as runs of blank lines never form a block. */
export function blocksOf(text: string): FootprintBlock[] {
  const lines = text.split("\n");
  const out: FootprintBlock[] = [];
  let start = -1; // 0-based start of the current block; -1 = not inside a block
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || BLANK_RE.test(lines[i]);
    if (!blank && start < 0) start = i;
    if (blank && start >= 0) {
      out.push({ text: lines.slice(start, i).join("\n"), start: start + 1, end: i });
      start = -1;
    }
  }
  return out;
}

/**
 * Identity text of a block: trailing whitespace stripped per line, leading and
 * trailing blank lines removed, and the common leading whitespace of all non-blank
 * lines removed. "Indent the whole list by one more step" and "delete the trailing
 * spaces" do not create a false new block; a partial indent change (beyond the
 * common prefix) still counts as a content change.
 */
export function blockKey(text: string): string {
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let prefix: string | null = null;
  for (const l of lines) {
    if (l === "") continue;
    const ind = /^[ \t]*/.exec(l)![0];
    prefix = prefix === null ? ind : commonWhitespace(prefix, ind);
    if (prefix === "") break;
  }
  if (prefix) {
    return lines.map((l) => (l === "" ? l : l.slice(prefix!.length))).join("\n");
  }
  return lines.join("\n");
}

/** Common prefix of two leading whitespace strings (character by character: a tab and a space count separately). */
function commonWhitespace(a: string, b: string): string {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}

/**
 * Today's additions: the blocks of the current text whose identity is not in the
 * baseline (with the line numbers of the current text, for jumping). When
 * `baseline` is null (a missing baseline means the file was created today) every
 * block counts as written today. Blocks with todos are excluded at the exit (see
 * the module comment).
 */
export function diffBlocks(baseline: string | null, current: string): FootprintBlock[] {
  const blocks = blocksOf(current).filter((b) => !blockHasTodo(b.text));
  if (baseline === null) return blocks;
  const known = new Set<string>();
  for (const b of blocksOf(baseline)) known.add(blockKey(b.text));
  if (known.size === 0) return blocks;
  return blocks.filter((b) => !known.has(blockKey(b.text)));
}

// ---------------------------------------------------------------- paths and ownership

const NOTE_FILE_RE = /\.(md|markdown|txt)$/i;

/** Aggregateable note files: `.md` / `.markdown` / `.txt` that are not inside the
 *  Daily/ directory of the vault (daily notes never aggregate each other, that
 *  would nest them into themselves). */
export function isAggregatePath(path: string, vaultRoot: string): boolean {
  if (!NOTE_FILE_RE.test(path)) return false;
  const root = vaultRoot.replace(/\/+$/, "");
  if (!path.startsWith(root + "/")) return false;
  return !path.startsWith(`${root}/Daily/`);
}

// ---------------------------------------------------------------- persisted shape

/** v1 (old): only one "today's baseline", it is void after the day rotates - a historical daily note cannot aggregate anything. */
export interface StoredFootprintsV1 {
  version: 1;
  day: string;
  baselines: Record<string, string>;
}

/**
 * v2: besides the baseline a historical footprint archive is kept.
 * `history[day][path]` = a frozen snapshot of the blocks added on that day - it
 * is diffed out of the old baseline during the rotation and then only read, never
 * recomputed, so opening a historical daily note aggregates the footprint of
 * that day from it. The semantics of zero pollution of the daily note files stay
 * the same: the mapping only exists in this one metadata file and is never
 * written into a daily note.
 */
export interface StoredFootprints {
  version: 2;
  /** Day the baseline belongs to (YYYY-MM-DD); different from today = a rotation is due. */
  day: string;
  /** Today's baseline: absolute path -> the full text at the moment the day switched. */
  baselines: Record<string, string>;
  /** Historical footprint archive: day -> absolute path -> the footprint blocks of that day (with the line numbers of the time, for jumping). */
  history: Record<string, Record<string, FootprintBlock[]>>;
}

/** Path of the baseline metadata file (inside the vault, travels with the repo). */
export function footprintsFilePath(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/.bnote/daily-footprints.json`;
}
