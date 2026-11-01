import { sourceLabel } from "@/daily/marks";
import type { FootprintBlock } from "./model";

/**
 * Pure view model of today's footprint zone: it assembles the index entries into
 * the rendering data of "zone -> group (source file) -> block" and adds the pure
 * data operations of the fold state. No DOM; view.test.ts locks down the group
 * order, the counts and the fold toggles; widget.ts only draws this immutable
 * data.
 */

export interface FootprintEntry {
  path: string;
  blocks: FootprintBlock[];
}

export interface FootprintGroupView {
  /** Absolute path of the source file (used when jumping on a click). */
  path: string;
  /** Name of the source note (directory and .md stripped), shown in the group header. */
  label: string;
  blocks: FootprintBlock[];
}

export interface FootprintView {
  groups: FootprintGroupView[];
  fileCount: number;
  blockCount: number;
}

export function buildFootprintView(entries: FootprintEntry[]): FootprintView {
  const groups: FootprintGroupView[] = entries.map((e) => ({
    path: e.path,
    label: sourceLabel(e.path),
    blocks: e.blocks,
  }));
  return {
    groups,
    fileCount: groups.length,
    blockCount: groups.reduce((n, g) => n + g.blocks.length, 0),
  };
}

// ---------------------------------------------------------------- fold state

/** Folding is UI state of the session: it is not persisted - every daily note opens fully expanded. */
export interface FoldState {
  /** The whole footprint zone is collapsed (only the zone header is left). */
  zoneCollapsed: boolean;
  /** The collapsed groups (absolute path of the source file). */
  groups: ReadonlySet<string>;
}

export function defaultFold(): FoldState {
  return { zoneCollapsed: false, groups: new Set() };
}

export function toggleZone(state: FoldState): FoldState {
  return { ...state, zoneCollapsed: !state.zoneCollapsed };
}

export function toggleGroup(state: FoldState, path: string): FoldState {
  const groups = new Set(state.groups);
  if (groups.has(path)) groups.delete(path);
  else groups.add(path);
  return { ...state, groups };
}

/** Signature of the fold state: the widget equality check and the zone rebuild use it to compare. */
export function foldSig(state: FoldState): string {
  return state.zoneCollapsed
    ? "z"
    : `Z${[...state.groups].sort().join(";")}`;
}
