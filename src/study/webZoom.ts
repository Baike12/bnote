/**
 * Page zoom of the web preview in study mode.
 *
 * The zoom of a native sub-webview is a browser-level zoom (WKWebView.pageZoom
 * / WebView2 SetZoomFactor): the text reflows and the images scale with it,
 * it does not stretch the DOM as a whole. Only the main window holds the zoom
 * value and ContentPane pushes it to Rust — a single writer, the page itself
 * keeps no ratio.
 *
 * The steps match Chrome's: the user moves between 100% / 110% / 125% instead
 * of clicking +-1% dozens of times; the ceiling is 300% and the floor 50%,
 * beyond which the page layout is no longer readable.
 */

/** Zoom steps (ascending). */
const WEB_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export const MIN_WEB_ZOOM = 0.5;
export const MAX_WEB_ZOOM = 3;
export const DEFAULT_WEB_ZOOM = 1;

/** The setting may come from an old config or a hand-edited JSON: clamp into [50%, 300%]. */
export function normalizeWebZoom(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_WEB_ZOOM;
  return Math.min(MAX_WEB_ZOOM, Math.max(MIN_WEB_ZOOM, raw));
}

/** Step one entry in the step table; a value that is not on a step lands on the nearest one (never a fixed-ratio multiply). */
export function stepWebZoom(current: unknown, direction: 1 | -1): number {
  const value = normalizeWebZoom(current);
  if (direction > 0) {
    for (const step of WEB_ZOOM_STEPS) {
      if (step > value + 1e-6) return step;
    }
    return MAX_WEB_ZOOM;
  }
  for (let i = WEB_ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (WEB_ZOOM_STEPS[i] < value - 1e-6) return WEB_ZOOM_STEPS[i];
  }
  return MIN_WEB_ZOOM;
}

/** The toolbar readout, e.g. "110%". */
export function formatWebZoom(value: unknown): string {
  return `${Math.round(normalizeWebZoom(value) * 100)}%`;
}
