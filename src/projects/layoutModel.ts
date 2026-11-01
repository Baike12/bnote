/**
 * Width model of the three columns of the project view.
 *
 * The three columns are project navigation | project kanban | daily note. The
 * widths of the left column and the daily note column are stored in **pixels** in
 * the settings (`projectsSideWidth` / `projectsDailyWidth`), the kanban takes the
 * remaining width: dragging the window edge only changes the kanban, navigation
 * and the daily note stay put - the wrapping width of the daily note and the
 * number of columns that fit into the kanban do not jitter with the window. When
 * the window gets too narrow the CSS clamp shrinks the display and the preference
 * is not written back.
 *
 * Dragging a divider only moves the **two adjacent columns**: the width is
 * transferred between them, the column that is not adjacent stays where it is
 * (dragging navigation|kanban does not move the daily note, dragging
 * kanban|daily note does not move navigation). The minimum width of every column
 * is 10% of the layout width; the kanban has an additional pixel lower bound -
 * below it not even a single line of todos fits.
 */

/** Default width of the project navigation. */
export const DEFAULT_SIDE_WIDTH = 232;
/** Default width of the daily note column. */
export const DEFAULT_DAILY_WIDTH = 420;
/** Ratio of the layout width that a column must keep at least (same as the three columns of study mode). */
export const MIN_COLUMN_RATIO = 0.1;
/** Minimum pixel width of the kanban (the middle column): below it a single column of todos does not fit. */
export const MIN_CENTER_WIDTH = 300;
/** Width of the divider (in layout width), matching .projects-resizer in global.css. */
export const RESIZER_WIDTH = 1;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/** Minimum width of a column (pixels): 10% of the layout width. */
export function minColumnWidth(hostWidth: number): number {
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) return 0;
  return Math.round(hostWidth * MIN_COLUMN_RATIO);
}

/**
 * Dragging the navigation|kanban divider: it changes the width of the navigation,
 * the daily note stays put.
 *
 * `edgeX` is the coordinate of the right edge of the divider relative to the left
 * edge of the layout (= the left edge of the kanban = the right edge of the
 * navigation plus the width of the line); when the left column is at 10% the line
 * is leftmost, when the kanban is at `MIN_CENTER_WIDTH` the line is rightmost.
 */
export function dragSideEdge(edgeX: number, hostWidth: number, dailyWidth: number): number {
  const min = minColumnWidth(hostWidth);
  const lo = min + RESIZER_WIDTH;
  const hi = hostWidth - dailyWidth - RESIZER_WIDTH - MIN_CENTER_WIDTH;
  const x = clamp(edgeX, lo, hi);
  return Math.round(x - RESIZER_WIDTH);
}

/**
 * Dragging the kanban|daily note divider: it changes the width of the daily note,
 * the navigation stays put.
 *
 * `edgeX` is the coordinate of the right edge of the divider relative to the left
 * edge of the layout (= the left edge of the daily note column); when the daily
 * note column is at 10% the line is rightmost, when the kanban is at
 * `MIN_CENTER_WIDTH` the line is leftmost.
 */
export function dragDailyEdge(edgeX: number, hostWidth: number, sideWidth: number): number {
  const min = minColumnWidth(hostWidth);
  const lo = sideWidth + RESIZER_WIDTH * 2 + MIN_CENTER_WIDTH;
  const hi = hostWidth - min;
  return Math.round(hostWidth - clamp(edgeX, lo, hi));
}

/**
 * Normalizing a persisted width: bad data (not a number, negative, NaN) falls back
 * to the default.
 *
 * The bounds are left to `dragSideEdge` / `dragDailyEdge` at drag time and to the
 * CSS clamp - the layout width cannot be measured while loading, guessing one here
 * would only corrupt the preference of the user.
 */
export function normalizeSideWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_SIDE_WIDTH;
}

export function normalizeDailyWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_DAILY_WIDTH;
}
