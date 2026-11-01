/**
 * The PDF reader's "display range".
 *
 * A drag selects a **normalized** rectangle (0..1), not pixels: pages are not
 * all the same size, and only a ratio lets the same box fit every page as-is
 * — turning a page always shows the same stretch of layout.
 */
export interface PdfCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box smaller than this is treated as a misclick (a click, a shaky hand), not a crop. */
export const MIN_CROP_SIZE = 0.04;
/** A box that covers nearly the whole page is no crop at all — storing it would only leave a white margin on every page. */
const FULL_CROP = 0.995;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * One drag (both endpoints inside the page, normalized ratios) -> crop box.
 * Any direction (dragging from bottom-right to top-left works the same); a
 * too-small box returns null.
 */
export function cropFromDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): PdfCrop | null {
  if (![startX, startY, endX, endY].every((v) => Number.isFinite(v))) return null;
  const x0 = clamp01(Math.min(startX, endX));
  const y0 = clamp01(Math.min(startY, endY));
  const w = clamp01(Math.max(startX, endX)) - x0;
  const h = clamp01(Math.max(startY, endY)) - y0;
  if (w < MIN_CROP_SIZE || h < MIN_CROP_SIZE) return null;
  if (w >= FULL_CROP && h >= FULL_CROP) return null;
  return { x: x0, y: y0, w, h };
}

/** A value read back from disk / an older version: wrong shape, out of bounds or too small all fall back to "whole page". */
export function normalizeCrop(raw: unknown): PdfCrop | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, w, h } = raw as Record<string, unknown>;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof w !== "number" || !Number.isFinite(w)) return null;
  if (typeof h !== "number" || !Number.isFinite(h)) return null;
  const left = clamp01(x);
  const top = clamp01(y);
  const width = Math.min(Math.max(0, w), 1 - left);
  const height = Math.min(Math.max(0, h), 1 - top);
  if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) return null;
  if (width >= FULL_CROP && height >= FULL_CROP) return null;
  return { x: left, y: top, w: width, h: height };
}

/** One crop box per PDF; the key is the absolute path inside the vault. */
const STORAGE_PREFIX = "bnote.pdfCrop:";

export function loadPdfCrop(path: string): PdfCrop | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + path);
    return raw ? normalizeCrop(JSON.parse(raw)) : null;
  } catch {
    // No localStorage (tests / restricted environment) or bad data: fall back to the whole page.
    return null;
  }
}

export function savePdfCrop(path: string, crop: PdfCrop | null): void {
  try {
    if (crop) localStorage.setItem(STORAGE_PREFIX + path, JSON.stringify(crop));
    else localStorage.removeItem(STORAGE_PREFIX + path);
  } catch {
    // Failing to store only costs the restore on the next open; the current display is unaffected.
  }
}
