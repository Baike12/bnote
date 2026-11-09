/**
 * Study-mode column model.
 *
 * The layout has three columns: left | middle | notes (see StudyLayout). The
 * model speaks **positions**, not panes: the left and middle columns are
 * stored in **pixels** (`studyAgentWidth` / `studyContentWidth`, historical
 * key names for the left and middle column) and the notes column takes the
 * remainder. The panes (assistant, content) are only the occupants of those
 * columns — the focused swap moves them between columns and each one takes the
 * width of the column it lands in. Dragging the window edge leaves the two
 * measured columns alone — the PDF page size and how much fits vertically do
 * not jitter with the window. When the window is too narrow to fit them, CSS
 * clamps them down without writing the preference back.
 *
 * Dragging a divider moves only the **two adjacent columns**: the width
 * transfers between them and the non-adjacent column stays put (dragging
 * left|middle does not move the notes column; dragging middle|notes does not
 * move the left column). Each column has a minimum width of 10% of the layout
 * width; when an adjacent column hits its limit the divider stops there.
 *
 * The old config stored the three widths as `studySplit: [agent, content]`
 * (ratios even earlier); `normalizeContentWidth` converts the old value into
 * a pixel width for the content column at load time, a one-off migration.
 */

/** Minimum width of a column as a ratio of the layout width. */
export const MIN_COLUMN_RATIO = 0.1;
/** Divider width (in layout width), matching .study-resizer in global.css; the
 *  hit area is extended sideways by ::after and takes no layout space. */
export const RESIZER_WIDTH = 1;

export const DEFAULT_CONTENT_WIDTH = 620;
/** Default assistant column width (same as the first value of the old [agent, content] config). */
export const DEFAULT_AGENT_WIDTH = 320;

/** Whitespace above the PDF page (.pdf-pages padding-top). */
export const PAGE_TOP_PAD = 14;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/** Minimum column width in pixels: 10% of the layout width. */
export function minColumnWidth(hostWidth: number): number {
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) return 0;
  return Math.round(hostWidth * MIN_COLUMN_RATIO);
}

/**
 * Normalize the persisted content column width into pixels.
 *
 * - The old ratio form (value in 0..1) is converted by `viewportWidth`;
 * - pixel values are used as-is, only clamped at the floor (the floor = 10%
 *   of the layout width, the same as while dragging; the ceiling is left to
 *   CSS, which compresses the display on a narrow window without changing the
 *   preference);
 * - bad data falls back to the default.
 */
export function normalizeContentWidth(value: unknown, viewportWidth: number): number {
  const floor = minColumnWidth(viewportWidth);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTENT_WIDTH;
  }
  if (value < 1) {
    if (!(Number.isFinite(viewportWidth) && viewportWidth > 0)) {
      return DEFAULT_CONTENT_WIDTH;
    }
    return Math.round(Math.max(floor, value * viewportWidth));
  }
  return Math.round(Math.max(floor, value));
}

/** Normalize the assistant column width: pixels, clamped only at the floor (same floor as above, ceiling left to CSS). */
export function normalizeAgentWidth(value: unknown, viewportWidth: number): number {
  const floor = minColumnWidth(viewportWidth);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_AGENT_WIDTH;
  }
  return Math.round(Math.max(floor, value));
}

/**
 * Old config `studySplit` -> new config `studyContentWidth`.
 *
 * The old array is `[agent, content]` (pixels or ratios) and the content
 * column width is its second element; a single value (already the new
 * config) is normalized as-is. null means there is nothing to migrate.
 */
export function studySplitToContentWidth(split: unknown): number | null {
  if (Array.isArray(split)) {
    return split.length === 2 && typeof split[1] === "number" ? split[1] : null;
  }
  return typeof split === "number" ? split : null;
}

/** The three column widths in pixels. */
export interface ColumnWidths {
  /** Left column. */
  left: number;
  /** Middle column. */
  middle: number;
  /** Right column (notes). */
  right: number;
}

/**
 * Drag the left|middle divider: the width transfers between the two adjacent
 * columns, the notes column stays put.
 *
 * `x` is the divider's right edge relative to the layout's left edge (=
 * the middle column's left edge); `sum` is the current total width of those
 * two columns (left + middle) — it does not change while dragging, so the
 * notes column width does not change either.
 *
 * The pointer position is the column boundary: left width = x - divider
 * width, middle width = sum - left width. The minimum width of an adjacent
 * column is 10% of the layout width; whichever hits its limit first stops the
 * divider.
 */
export function dragLeftEdge(x: number, hostWidth: number, sum: number): ColumnWidths {
  const min = minColumnWidth(hostWidth);
  // Left column at 10% -> the divider's right edge is leftmost; middle column at 10% -> rightmost.
  const lo = min + RESIZER_WIDTH;
  const hi = sum + RESIZER_WIDTH - min;
  const edge = lo <= hi ? clamp(x, lo, hi) : (lo + hi) / 2;
  const left = edge - RESIZER_WIDTH;
  return {
    left: Math.round(left),
    middle: Math.round(sum - left),
    right: Math.round(hostWidth - RESIZER_WIDTH * 2 - sum),
  };
}

/**
 * Drag the middle|notes divider: the width transfers between the middle and
 * notes columns, the left column stays put.
 *
 * `x` is the divider's right edge relative to the layout's left edge (=
 * the notes column's left edge); `middleLeft` is the middle column's left
 * edge (it does not move while dragging — the divider only moves between the
 * middle and notes columns).
 *
 * The minimum width of an adjacent column is 10% of the layout width;
 * whichever hits its limit first stops the divider.
 */
export function dragMiddleEdge(
  x: number,
  hostWidth: number,
  middleLeft = 0,
): { middle: number; right: number } {
  const min = minColumnWidth(hostWidth);
  const lo = middleLeft + RESIZER_WIDTH + min; // middle column at 10%
  const hi = hostWidth - min; // notes column at 10%
  const edge = lo <= hi ? clamp(x, lo, hi) : (lo + hi) / 2;
  const middle = edge - middleLeft - RESIZER_WIDTH;
  return {
    middle: Math.round(middle),
    right: Math.round(hostWidth - edge),
  };
}

/**
 * The full page width at 100% zoom.
 *
 * After a crop only the selected part is left on screen; 100% should make
 * "the visible part" exactly fill the content column, so the full page is
 * scaled up by the crop width (`fitWidth / cropWidth`). Without a crop it is
 * the column width itself (the page sits flush against the edge).
 */
export function basePageWidth(fitWidth: number, cropWidth: number): number {
  if (!(fitWidth > 0)) return 0;
  const visible = cropWidth > 0 && cropWidth <= 1 ? cropWidth : 1;
  return fitWidth / visible;
}

export interface RenderedPageFitInput {
  /** Current content column width (the displayed value). */
  contentWidth: number;
  /** Full width of the current page (zoomed, uncropped). */
  pageWidth: number;
  /** Height the current page actually occupies (after cropping). */
  pageHeight: number;
  /** Height available for one page in the viewport (scroll area height minus the top padding). */
  availableHeight: number;
  /** Page height / page width (first page). */
  pageRatio: number;
  /** Share of the full page height the display range covers; 1 = whole page. */
  cropHeight: number;
  /** Share of the full page width the display range covers; 1 = no width crop. */
  cropWidth: number;
  minPageWidth: number;
  maxPageWidth: number;
}

/**
 * The content column width at which one page exactly fits the viewport.
 *
 * Derived from the already-rendered page size: the page height varies
 * linearly with the width, so a height deficit converts directly into a
 * width surplus. This avoids assumptions like "how many pixels the scrollbar
 * takes" — what is measured is the real layout.
 *
 * After a crop the full page is scaled up by `1 / cropWidth` (see
 * basePageWidth), so a 1px change of the content column width changes the
 * full page width by `1 / cropWidth` px: multiply `cropWidth` back in when
 * converting to the column. A `null` return means the geometry is not ready
 * yet (page/viewport size is 0), in which case the layout must not change.
 */
export function contentWidthForRenderedPage(input: RenderedPageFitInput): number | null {
  const {
    contentWidth,
    pageWidth,
    pageHeight,
    availableHeight,
    pageRatio,
    cropHeight,
    cropWidth,
    minPageWidth,
    maxPageWidth,
  } = input;
  if (
    !(contentWidth > 0) ||
    !(pageWidth > 0) ||
    !(pageHeight > 0) ||
    !(availableHeight > 0) ||
    !(pageRatio > 0)
  ) {
    return null;
  }
  const heightRatio = pageRatio * (cropHeight > 0 ? cropHeight : 1);
  const visibleWidth = cropWidth > 0 && cropWidth <= 1 ? cropWidth : 1;
  const delta = (availableHeight - pageHeight) / heightRatio;
  const fittedPageWidth = clamp(pageWidth + delta, minPageWidth, maxPageWidth);
  return Math.round(contentWidth + (fittedPageWidth - pageWidth) * visibleWidth);
}
