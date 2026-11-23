/**
 * The pure geometry of the Mermaid viewer: the SVG's logical size, and the
 * zoom/pan state. MermaidBlock only wires these to the DOM.
 */

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.25;

export interface DiagramView {
  scale: number;
  /** Translation in CSS pixels, applied before scaling (translate · scale). */
  x: number;
  y: number;
}

export function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/**
 * The viewBox is "minX minY width height". The viewer renders the diagram at
 * 1:1 with these units, so only a positive width/height is usable; anything
 * malformed means "no fixed size, fill the viewport".
 */
export function parseViewBox(svg: string): { width: number; height: number } | null {
  const value = /viewBox="([^"]+)"/.exec(svg)?.[1];
  if (!value) return null;
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const width = parts[2];
  const height = parts[3];
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Zoom by `factor` keeping the stage point under (anchorX, anchorY) fixed.
 * The anchors are offsets from the viewport center, in CSS pixels. The
 * transform is translate(x, y) · scale(s), so a screen offset a maps to the
 * stage coordinate (a - x) / s; solving for the new x with that point pinned
 * gives x' = a - (a - x) · (s' / s).
 */
export function zoomAround(
  view: DiagramView,
  factor: number,
  anchorX: number,
  anchorY: number,
): DiagramView {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchorX - (anchorX - view.x) * ratio,
    y: anchorY - (anchorY - view.y) * ratio,
  };
}

/** Button zoom: the same anchored zoom with the viewport center as the anchor. */
export function zoomBy(view: DiagramView, factor: number): DiagramView {
  return zoomAround(view, factor, 0, 0);
}
