/**
 * Width model of the code project file tree.
 *
 * The width is stored in the settings in pixels (`codeTreeWidth`) and the
 * editor takes the remainder; the file tree takes at most 60% of the code
 * panel and at least 120px. When the window or the middle column narrows,
 * CSS clamps the display without **writing back the preference** — the same
 * discipline as the study mode columns and the project view.
 */

export const TREE_MIN_WIDTH = 120;
export const TREE_DEFAULT_WIDTH = 190;
/** Largest share of the code panel the file tree may take (the editor keeps at least 40%). */
export const TREE_MAX_RATIO = 0.6;

/** Normalize a persisted width: bad data (non-number, negative, NaN) falls back to the default; the bounds are left to dragging and CSS. */
export function normalizeTreeWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : TREE_DEFAULT_WIDTH;
}

/** While dragging, clamp the width into "at least 120px, at most 60% of the panel". */
export function clampTreeWidth(width: number, paneWidth: number): number {
  const max = Math.max(TREE_MIN_WIDTH, Math.round(Math.max(0, paneWidth) * TREE_MAX_RATIO));
  return Math.round(Math.min(Math.max(TREE_MIN_WIDTH, width), max));
}
