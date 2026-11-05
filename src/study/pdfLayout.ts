/**
 * Width of the PDF reader's left column (bookmarks / outline).
 *
 * Pixels rather than a ratio: the outline is fixed UI relative to the window
 * and should keep the same width across page turns and file switches; a ratio
 * model gets squeezed in a narrow column.
 */
export const DEFAULT_OUTLINE_WIDTH = 210;
export const MIN_OUTLINE_WIDTH = 140;
export const MAX_OUTLINE_WIDTH = 480;
/** Width always left for the PDF page while dragging. */
export const MIN_PAGE_AREA = 260;

/** Clamp into [MIN_OUTLINE_WIDTH, min(MAX_OUTLINE_WIDTH, bodyWidth - MIN_PAGE_AREA)]. */
export function clampOutlineWidth(width: number, bodyWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_OUTLINE_WIDTH;
  const upper = Math.max(MIN_OUTLINE_WIDTH, Math.min(MAX_OUTLINE_WIDTH, bodyWidth - MIN_PAGE_AREA));
  return Math.round(Math.min(Math.max(width, MIN_OUTLINE_WIDTH), upper));
}

const STORAGE_KEY = "bnote.pdfOutlineWidth";

export function loadOutlineWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const width = raw === null ? NaN : Number(raw);
    return Number.isFinite(width)
      ? clampOutlineWidth(width, Number.MAX_SAFE_INTEGER)
      : DEFAULT_OUTLINE_WIDTH;
  } catch {
    return DEFAULT_OUTLINE_WIDTH;
  }
}

export function saveOutlineWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Failing to store only costs the width on the next open.
  }
}
