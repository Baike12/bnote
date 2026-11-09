import type { GitStatus } from "./types";

/**
 * The change list of the code pane's diff view.
 *
 * git reports two independent sides per file (index vs HEAD, worktree vs
 * index); the pane shows one of them at a time, so the filtering rule and the
 * kind mapping live here as pure functions instead of inside the component.
 */

/** Which side of a change the pane shows. */
export type ChangeSource = "worktree" | "staged";

export interface FileChange {
  path: string;
  /** The kind git reports for this side, as a symbol the list can render. */
  kind: "modified" | "added" | "deleted" | "renamed" | "conflicted";
  added: number;
  removed: number;
  /** The original path of a rename (the row shows "a → b"). */
  origPath: string | null;
}

/**
 * One side's status letter of a file, or "" when that side has no change.
 *
 * A file can be changed on both sides (staged and modified again afterwards):
 * each side is listed where it belongs, and a `?` (untracked) only exists on
 * the worktree side.
 */
function sideState(state: GitStatus["files"][number], source: ChangeSource): string {
  return source === "staged" ? state.index : state.worktree;
}

function kindOf(letter: string): FileChange["kind"] | null {
  switch (letter) {
    case "M":
    case "T": // type change (file ↔ symlink) reads as a modification of the path
      return "modified";
    case "A":
    case "?":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "U":
      return "conflicted";
    default:
      return null;
  }
}

/** The changes of one side, in git's order, with that side's line counts. */
export function changesForSource(git: GitStatus | null, source: ChangeSource): FileChange[] {
  if (!git?.isRepo) return [];
  const out: FileChange[] = [];
  for (const file of git.files) {
    const letter = sideState(file, source);
    // An untracked file (`??`) is not in the index, so it belongs to the
    // worktree side only — the staged list must not claim it.
    if (source === "staged" && letter === "?") continue;
    const kind = kindOf(letter);
    if (!kind) continue;
    out.push({
      path: file.path,
      kind,
      added: source === "staged" ? file.stagedAdded : file.added,
      removed: source === "staged" ? file.stagedRemoved : file.removed,
      origPath: kind === "renamed" ? file.origPath : null,
    });
  }
  return out;
}

/** Totals of one side, for the pane header. */
export function changeTotals(changes: FileChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    added += change.added;
    removed += change.removed;
  }
  return { added, removed };
}

/** The last path segment of a change path. */
export function changeName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/** The directory part of a change path ("" for a top-level file). */
export function changeDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/**
 * The identity of one shown patch: a path is a different change on each side,
 * so the side belongs to the key — switching sides must not display the other
 * side's text while the new one loads.
 */
export function patchKey(path: string, staged: boolean): string {
  return `${staged ? "staged" : "worktree"}:${path}`;
}
