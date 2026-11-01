/**
 * Parsing of a unified diff and the side-by-side alignment.
 *
 * The backend only hands over the raw unified diff text (`git diff
 * --no-color`); the parsing happens on the frontend because rendering needs
 * line numbers, colors and a side-by-side alignment, and the backend would
 * otherwise have to implement a second diff model.
 */

/** One diff line. */
export interface DiffLine {
  type: "context" | "add" | "remove" | "meta";
  text: string;
  /** Line number in the old file (1-based); absent for added lines. */
  oldLine: number | null;
  /** Line number in the new file (1-based); absent for removed lines. */
  newLine: number | null;
}

/** One hunk (`@@ -a,b +c,d @@`). */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The context heading after `@@` (optional). */
  section: string;
  lines: DiffLine[];
}

/** The diff of one file. */
export interface DiffFileDiff {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
}

/** The whole parsed diff. */
export interface ParsedDiff {
  files: DiffFileDiff[];
}

/** `@@ -1,4 +1,5 @@ foo` → hunk header. */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse unified diff text.
 *
 * Supports multiple files (segmented by `diff --git`), added files (old path
 * `/dev/null`) and deleted files (new path `/dev/null`). Unrecognized lines
 * are treated as context — showing one line too much is better than losing
 * context.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFileDiff[] = [];
  const raw = text.split("\n");
  // The trailing newline splits off an empty segment: it is not "an empty
  // context line", it is an artifact of the split.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const lines = raw;
  let file: DiffFileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const ensureFile = (): DiffFileDiff => {
    if (!file) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
    }
    return file;
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      ensureFile().oldPath = p === "/dev/null" ? null : stripPrefix(p);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      ensureFile().newPath = p === "/dev/null" ? null : stripPrefix(p);
      continue;
    }
    const m = HUNK_RE.exec(raw);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: newLine,
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5].trim(),
        lines: [],
      };
      ensureFile().hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" — attached to the previous line, it does
      // not change any line number.
      hunk.lines.push({ type: "meta", text: raw.slice(2), oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith("+")) {
      hunk.lines.push({ type: "add", text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      hunk.lines.push({ type: "remove", text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ type: "context", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // Everything else (meta lines other than `diff --git`) is not displayed.
  }

  return { files };
}

/** Strip the `a/` / `b/` prefix of a diff path. */
function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** One row of the side-by-side view: one cell per side, a missing one is null. */
export interface DiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Arrange the lines of a hunk into the rows of the side-by-side view.
 *
 * The pairing has two layers:
 * 1. **Lines with unchanged content** (the common subsequence found by the
 *    LCS) are aligned left to right — they are the lines that "moved" and
 *    must not drift elsewhere;
 * 2. the remaining unpaired removals/additions are **paired by position** —
 *    that is the "same line, modified": the old one on the left, the new one
 *    on the right.
 *
 * Pairing by content alone is not enough: the line where a single word
 * changed has different text before and after, so the LCS cannot pair it and
 * it would become two rows ("removed" on the left, "added" on the right),
 * which reads as if a line was deleted and another one added.
 */
export function alignHunk(hunk: DiffHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "context" || line.type === "meta") {
      rows.push({ left: line, right: line.type === "context" ? line : null });
      i += 1;
      continue;
    }
    // A run of consecutive removals/additions (no context line in between).
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && (lines[i].type === "remove" || lines[i].type === "add")) {
      if (lines[i].type === "remove") removed.push(lines[i]);
      else added.push(lines[i]);
      i += 1;
    }
    rows.push(...alignSegment(removed, added));
  }
  return rows;
}

/** Alignment of a run of consecutive removals/additions: pair the unchanged lines by LCS first, the rest by position. */
function alignSegment(removed: DiffLine[], added: DiffLine[]): DiffRow[] {
  const pairs = lcsPairs(
    removed.map((l) => l.text),
    added.map((l) => l.text),
  );
  const rows: DiffRow[] = [];
  let ri = 0;
  let ai = 0;
  for (const pair of pairs) {
    rows.push(...pairPositional(removed.slice(ri, pair.left), added.slice(ai, pair.right)));
    rows.push({ left: removed[pair.left], right: added[pair.right] });
    ri = pair.left + 1;
    ai = pair.right + 1;
  }
  rows.push(...pairPositional(removed.slice(ri), added.slice(ai)));
  return rows;
}

/** Pair by position: the longer side leaves blanks. */
function pairPositional(removed: DiffLine[], added: DiffLine[]): DiffRow[] {
  const n = Math.max(removed.length, added.length);
  const rows: DiffRow[] = [];
  for (let k = 0; k < n; k++) {
    rows.push({ left: removed[k] ?? null, right: added[k] ?? null });
  }
  return rows;
}

/** The pairing result: left index → right index. */
interface LcsPair {
  left: number;
  right: number;
}

/**
 * The pairing of the longest common subsequence (indices only, not the
 * subsequence itself).
 *
 * Uses the standard dynamic-programming LCS length table and then backtracks
 * the pairs out of it. O(n*m) — a hunk is usually a few dozen lines, which is
 * enough; to guard against a huge hunk the caller can truncate by line count
 * first.
 */
export function lcsPairs(a: string[], b: string[]): LcsPair[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: LcsPair[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ left: i, right: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Diff statistics: how many lines were added / removed. */
export function diffStats(diff: ParsedDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add") added += 1;
        else if (line.type === "remove") removed += 1;
      }
    }
  }
  return { added, removed };
}
