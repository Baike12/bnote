import type { LspPosition } from "./types";

/**
 * Target selection for "next / previous problem" (F8 / ⇧F8).
 *
 * A pure function: the diagnostics come from the store, the cursor comes from
 * the editor, and this module only decides where to jump. It is pulled out
 * because the old implementation *guessed* "which one are we on": it took the
 * **first** diagnostic of the current file as the cursor, so pressing F8 kept
 * bouncing between two files and the 2nd and 3rd problems of a file were
 * never reached.
 *
 * The rules (same as the mainstream IDEs):
 * - first look for the first diagnostic **after** the caret (direction = 1) /
 *   before it (-1) in the **current file**;
 * - when the current file has none left, cross to the head / tail of the
 *   neighbouring file in the order of the files that have problems;
 * - with a single file, wrap around to itself (a single file must cycle too);
 * - when the current file has no diagnostics at all, start from the head /
 *   tail of the whole list.
 */

export interface ProblemTarget {
  /** Project-relative path. */
  path: string;
  position: LspPosition;
}

export interface ProblemCursor {
  /** The file the caret is in (null = unknown). */
  path: string | null;
  /** The caret position; null when there is no editor (handled as file head / tail). */
  position: LspPosition | null;
}

function comparePosition(a: LspPosition, b: LspPosition): number {
  return a.line - b.line || a.character - b.character;
}

export function nextProblemTarget(
  problems: readonly ProblemTarget[],
  cursor: ProblemCursor,
  direction: 1 | -1,
): ProblemTarget | null {
  if (problems.length === 0) return null;

  // Group by file (file order = order of first appearance of a diagnostic),
  // sorted by position inside a group: the diagnostics pushed by the server
  // are not guaranteed to be ordered.
  const groups = new Map<string, ProblemTarget[]>();
  for (const problem of problems) {
    const list = groups.get(problem.path);
    if (list) list.push(problem);
    else groups.set(problem.path, [problem]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => comparePosition(a.position, b.position));
  }
  const paths = [...groups.keys()];

  /** The head / tail diagnostic of a file. */
  const edgeOf = (path: string): ProblemTarget => {
    const list = groups.get(path)!;
    return direction === 1 ? list[0] : list[list.length - 1];
  };

  if (cursor.path && groups.has(cursor.path)) {
    const list = groups.get(cursor.path)!;
    if (!cursor.position) return edgeOf(cursor.path);
    const position = cursor.position;
    const hit =
      direction === 1
        ? list.find((p) => comparePosition(p.position, position) > 0)
        : [...list].reverse().find((p) => comparePosition(p.position, position) < 0);
    if (hit) return hit;
    // No next one in this file: switch to the head / tail of the neighbouring
    // file (with a single file, wrap around to itself).
    const index = paths.indexOf(cursor.path);
    return edgeOf(paths[(index + direction + paths.length) % paths.length]);
  }

  // The current file has no diagnostics: start from the head / tail of the
  // whole list.
  return edgeOf(paths[direction === 1 ? 0 : paths.length - 1]);
}
