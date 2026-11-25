/**
 * Window model of the drawing canvas: the Excalidraw canvas is a floating,
 * rounded dialog, not a full-screen overlay.
 *
 * The size is a preference in pixels (`drawingWidth` / `drawingHeight`), the
 * same discipline as the split columns: it is what the dialog opens with, and
 * dragging an edge commits back into that same preference. CSS clamps the
 * **display** to the viewport, so opening on a small screen never rewrites the
 * preference; the drag does clamp, because a pointer cannot reach past the
 * screen edge.
 *
 * The position is **not** a preference: every session opens centered.
 */

export interface DrawingSize {
  width: number;
  height: number;
}

export interface DrawingRect extends DrawingSize {
  left: number;
  top: number;
}

/** Which edge (or corner) the pointer grabs. */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const DRAWING_MIN_WIDTH = 480;
export const DRAWING_MIN_HEIGHT = 320;
export const DRAWING_DEFAULT_WIDTH = 1100;
export const DRAWING_DEFAULT_HEIGHT = 700;
/** The gap the window keeps from the viewport edges at its largest (px per side). */
export const DRAWING_VIEWPORT_MARGIN = 16;

/** Normalize a persisted width: bad data (non-number, zero, NaN) falls back to the default, a hand-edited value below the minimum is lifted to it. */
export function normalizeDrawingWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(DRAWING_MIN_WIDTH, Math.round(value))
    : DRAWING_DEFAULT_WIDTH;
}

export function normalizeDrawingHeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(DRAWING_MIN_HEIGHT, Math.round(value))
    : DRAWING_DEFAULT_HEIGHT;
}

/** The size the dialog may actually take: at least the minimum, at most the viewport minus the margin. */
export function clampDrawingSize(
  width: number,
  height: number,
  viewport: DrawingSize,
): DrawingSize {
  return {
    width: clamp(width, DRAWING_MIN_WIDTH, maxSize(viewport.width, DRAWING_MIN_WIDTH)),
    height: clamp(height, DRAWING_MIN_HEIGHT, maxSize(viewport.height, DRAWING_MIN_HEIGHT)),
  };
}

/** The rect a session opens with: the preferred size, centered. */
export function centeredRect(width: number, height: number, viewport: DrawingSize): DrawingRect {
  const size = clampDrawingSize(width, height, viewport);
  return fitRect(
    {
      ...size,
      left: Math.round((viewport.width - size.width) / 2),
      top: Math.round((viewport.height - size.height) / 2),
    },
    viewport,
  );
}

/**
 * Move the rect by a delta counted from the drag's press point (the caller
 * passes the start rect and the accumulated delta, so clamping at an edge
 * does not accumulate error).
 */
export function moveRect(
  rect: DrawingRect,
  dx: number,
  dy: number,
  viewport: DrawingSize,
): DrawingRect {
  return fitRect({ ...rect, left: rect.left + dx, top: rect.top + dy }, viewport);
}

/**
 * Resize by dragging one edge or corner: the **opposite** edge stays put (the
 * standard window behaviour — the press point tracks the pointer), and the
 * dragged edge stops at the minimum size and at the viewport edge.
 */
export function resizeRect(
  rect: DrawingRect,
  dir: ResizeDir,
  dx: number,
  dy: number,
  viewport: DrawingSize,
): DrawingRect {
  let { left, top, width, height } = rect;
  const right = left + width;
  const bottom = top + height;

  if (dir.includes("e")) {
    const limit = Math.min(maxSize(viewport.width, DRAWING_MIN_WIDTH), viewport.width - left);
    width = clamp(width + dx, DRAWING_MIN_WIDTH, limit);
  } else if (dir.includes("w")) {
    const limit = Math.min(maxSize(viewport.width, DRAWING_MIN_WIDTH), right);
    width = clamp(width - dx, DRAWING_MIN_WIDTH, limit);
    left = right - width;
  }
  if (dir.includes("s")) {
    const limit = Math.min(maxSize(viewport.height, DRAWING_MIN_HEIGHT), viewport.height - top);
    height = clamp(height + dy, DRAWING_MIN_HEIGHT, limit);
  } else if (dir.includes("n")) {
    const limit = Math.min(maxSize(viewport.height, DRAWING_MIN_HEIGHT), bottom);
    height = clamp(height - dy, DRAWING_MIN_HEIGHT, limit);
    top = bottom - height;
  }
  return fitRect({ left, top, width, height }, viewport);
}

/** Keep the whole rect inside the viewport: a window never ends up partly off screen. */
export function fitRect(rect: DrawingRect, viewport: DrawingSize): DrawingRect {
  const size = clampDrawingSize(rect.width, rect.height, viewport);
  return {
    ...size,
    left: within(rect.left, viewport.width - size.width),
    top: within(rect.top, viewport.height - size.height),
  };
}

/** Largest size along one axis: the viewport minus the margin, never below the minimum (a tiny window still shows a usable dialog). */
function maxSize(viewport: number, min: number): number {
  const room = Math.round(viewport) - 2 * DRAWING_VIEWPORT_MARGIN;
  return Number.isFinite(room) ? Math.max(min, room) : min;
}

function clamp(value: number, lo: number, hi: number): number {
  const top = Math.max(lo, Math.round(hi));
  return Math.min(Math.max(lo, Math.round(value)), top);
}

/** A coordinate in `[0, max]`, where a viewport smaller than the rect yields 0. */
function within(value: number, max: number): number {
  return Math.round(Math.min(Math.max(0, value), Math.max(0, max)));
}
