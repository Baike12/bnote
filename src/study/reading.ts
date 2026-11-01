/**
 * Geometry model for turning pages in study mode.
 *
 * The PDF and web readers share one step size: every PageUp/PageDown moves
 * "visible height x step". At the default 50% the lower half of the previous
 * screen ends up in the middle of the screen after a page turn — the eyes stay
 * in the lower-middle area and pick up the new content there, without looking
 * up to the top of the screen every time.
 */

export const DEFAULT_PAGE_STEP = 0.5;
export const MIN_PAGE_STEP = 0.1;
export const MAX_PAGE_STEP = 1;

/** The setting may come from an old config or a hand-edited JSON: clamp into [10%, 100%], rounded to 1%.
 *
 *  This function is serialized into the web runtime by `webAnnotations.ts`,
 *  so its body must not reference module constants (they do not exist in the
 *  page) — the range and the default are written as literals. */
export function normalizePageStep(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(1, Math.max(0.1, rounded));
}

/**
 * Take one step from the current position, with the endpoints clamped (the
 * first screen never goes above the top, the last screen never past the
 * bottom). `viewport` is the visible height, `content` the total height of
 * the scrolled content.
 */
export function steppedScrollTop(
  current: number,
  viewport: number,
  content: number,
  delta: 1 | -1,
  step: number,
): number {
  const max = Math.max(0, content - viewport);
  const distance = Math.max(1, Math.round(Math.max(0, viewport) * normalizePageStep(step)));
  return Math.min(max, Math.max(0, current + delta * distance));
}

/** The top and bottom edge of one line of text in client coordinates (the same coordinate system as the viewport). */
export interface TextLineBand {
  top: number;
  bottom: number;
}

/**
 * Fine-tune the page-turn landing point: if the split line cuts through a
 * line of text, align the nearest line edge with the split line.
 *
 * `boundary` is the y of the split line in viewport coordinates; `lines` are
 * the text line rects measured **at the current landing point**; `tolerance`
 * is the maximum adjustment distance allowed (about 2% of the viewport
 * height). It only shifts the position and does not change the step model:
 * after the adjustment the scroll distance deviates from the configured value
 * by at most the tolerance. When the line height exceeds 2x the tolerance
 * both edges may fall outside it, and the position stays as it is.
 */
export function snapScrollTopToLine(
  current: number,
  viewport: number,
  content: number,
  boundary: number,
  lines: readonly TextLineBand[],
  tolerance: number,
): number {
  if (!(tolerance > 0)) return current;
  const max = Math.max(0, content - viewport);
  let best = current;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestEdge: "top" | "bottom" = "top";
  for (const line of lines) {
    if (!(line.bottom > line.top) || !(line.bottom > boundary && line.top < boundary)) {
      continue;
    }
    const edges: Array<["top" | "bottom", number]> = [
      ["top", line.top],
      ["bottom", line.bottom],
    ];
    for (const [edge, value] of edges) {
      const delta = value - boundary;
      if (!Number.isFinite(delta) || Math.abs(delta) > tolerance) continue;
      const next = current + delta;
      // Hitting the top/bottom end means the position is flush against it; the line edge is not really aligned then, so this candidate is rejected.
      if (next < 0 || next > max) continue;
      const distance = Math.abs(delta);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = next;
        bestEdge = edge;
      }
    }
  }
  if (best === current) return current;
  // The scroll position takes effect in whole pixels: when aligning the top
  // edge round down (the line ends up entirely below the split line), when
  // aligning the bottom edge round up (the line stays entirely above it), so
  // no 0.5px sliver of a line is left cut.
  const rounded = bestEdge === "top" ? Math.floor(best) : Math.ceil(best);
  return Math.min(max, Math.max(0, rounded));
}
