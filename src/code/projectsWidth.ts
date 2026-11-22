/**
 * Width model of code mode's leading column: the project-and-session sidebar.
 *
 * It is a fixed pixel column like the others (`codeProjectsWidth`), and its
 * divider sits between it and the agent column. Dragging it must not squeeze
 * the three columns to its right into nothing, so the model clamps the column
 * to leave every right-hand column at its minimum (the same 10% floor the
 * other layouts use, plus the one-resizer widths between them).
 */
import { minColumnWidth, RESIZER_WIDTH } from "@/study/layoutModel";

/** Hard floor: below this a project name and a session title do not fit. */
export const PROJECTS_MIN_WIDTH = 180;
/** Default width of the column. */
export const DEFAULT_PROJECTS_WIDTH = 240;
/** Dividers in the layout while this column is open (projects|agent|content|notes). */
export const CODE_RESIZER_COUNT = 3;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/**
 * The **seam** between CodeLayout and this model (docs/TESTING.md, "the seam
 * rule"): measurements are taken once at pointerdown, `dx` is the pointer
 * offset, and `reservedWidth` is the total width of the columns to the right
 * (agent + content, which the drag never touches).
 */
export function projectsDividerWidth(
  m: { projectsWidth: number; hostWidth: number; reservedWidth: number },
  dx: number,
): number {
  if (!(m.hostWidth > 0)) return Math.round(m.projectsWidth);
  const rightFloor = minColumnWidth(m.hostWidth);
  const lo = PROJECTS_MIN_WIDTH;
  const hi = m.hostWidth - m.reservedWidth - CODE_RESIZER_COUNT * RESIZER_WIDTH - rightFloor;
  return Math.round(clamp(m.projectsWidth + dx, lo, hi));
}
