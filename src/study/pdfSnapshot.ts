/**
 * Snapshot of the reading area: stitch the currently visible PDF pages into
 * one image and hand it straight to the study assistant input box.
 *
 * The pages are drawn by pdf.js into `<canvas>` anyway (one per page in
 * PdfViewer), so this needs neither system screen-recording permission nor
 * html2canvas: create a canvas and move the visible page fragments into it
 * with drawImage. The framing box = "scroll viewport ∩ current content region
 * ∩ page column":
 *   - the current content region is the part below the dimming shade
 *     (.pdf-read-shade): above it is the content just read, and capturing it
 *     would only mislead the model;
 *   - the left outline column (.pdf-outline) lies outside the page column and
 *     is left out for free;
 *   - the page frame shadow is a CSS box-shadow on .pdf-page and does not
 *     exist in canvas pixels at all.
 * The eye-care tint and the highlight annotations are DOM overlays
 * (multiply) and are repainted with the same coordinates and colors.
 *
 * The geometry part (planSnapshot) is a pure function and goes into the node
 * unit tests; the DOM collection and painting live in PdfViewer's registered
 * callback.
 */

export interface SnapshotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SnapshotAnnotation {
  kind: "highlight" | "note";
  /** Full page ratio coordinates (see pdfAnnotations.NormRect). */
  rects: { x: number; y: number; w: number; h: number }[];
}

export interface SnapshotPage {
  /** The display window (.pdf-page): with a "display range" set it is the cropped rectangle. */
  box: SnapshotRect;
  /** The whole page (.pdf-page-full): the reference for canvas and annotation coordinates. */
  full: SnapshotRect;
  /** Canvas physical pixel width; 0 = this page has not been rendered yet. */
  pixels: number;
  annotations: SnapshotAnnotation[];
}

export interface PlannedPage {
  /** Index into SnapshotPage[]. */
  page: number;
  /** Source rectangle (canvas physical pixels). */
  src: SnapshotRect;
  /** Destination rectangle (output canvas pixels). */
  dest: SnapshotRect;
  /** The whole page as a pixel rectangle in the output canvas (annotations are converted by it). */
  sheet: SnapshotRect;
  annotations: SnapshotAnnotation[];
}

export interface SnapshotPlan {
  width: number;
  height: number;
  /** The DPR shared by the visible pages (canvas pixels / CSS pixels). */
  scale: number;
  /** Position of the output's top-left corner in viewport coordinates. */
  origin: { left: number; top: number };
  pages: PlannedPage[];
}

export interface SnapshotOptions {
  /**
   * Top edge of the "current content region" (viewport coordinates). The upper
   * half of the reading area is dimmed old content (the shade mask used for
   * the page-turn split) and is not captured; null = the whole screen is
   * current content.
   */
  currentTop?: number | null;
}

export interface SnapshotColors {
  /** Scroll area background: the gaps between pages and the viewport background outside the pages. */
  background: string;
  /** Paper background; pdf.js paints white itself, this layer only covers the seams left by rounding. */
  paper: string;
  /** Eye-care tint; null = eye-care mode is off. */
  tint: string | null;
  highlight: string;
  note: string;
}

/** Visible fragments narrower or shorter than this are ignored (one or two pixels at the viewport edge are not content). */
export const MIN_VISIBLE_FRAGMENT = 2;

/** The viewport rect of a DOM element -> SnapshotRect. */
export function snapshotRect(el: Element): SnapshotRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function intersectRect(a: SnapshotRect, b: SnapshotRect): SnapshotRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

interface VisiblePage {
  index: number;
  page: SnapshotPage;
  frag: SnapshotRect;
  scale: number;
}

/**
 * Viewport -> the region used for framing: everything above the dimming layer
 * (the old content) is cut away, leaving only the current content region. An
 * empty result returns null (nothing to capture).
 */
export function currentRegion(
  viewport: SnapshotRect,
  currentTop: number | null | undefined,
): SnapshotRect | null {
  if (currentTop == null) return viewport;
  const top = Math.max(viewport.top, currentTop);
  const bottom = viewport.top + viewport.height;
  if (bottom <= top) return null;
  return { left: viewport.left, top, width: viewport.width, height: bottom - top };
}

/**
 * Viewport + per-page geometry -> the framing and the per-page copy plan.
 * There are three cases that return null:
 *   1. no page intersects the viewport (no document open / all outside the
 *      viewport);
 *   2. a page is visible but its canvas is still 0 wide (just jumped to a
 *      page, just zoomed, rendering not finished);
 *   3. the dimming layer covers the whole viewport, so the current content
 *      region is empty.
 * The caller retries on the next frame in those cases.
 */
export function planSnapshot(
  viewport: SnapshotRect,
  pages: SnapshotPage[],
  options: SnapshotOptions = {},
): SnapshotPlan | null {
  // Framing only looks at the current content region: the shade holds the content just read, capturing it would only mislead the model.
  const capture = currentRegion(viewport, options.currentTop);
  if (!capture) return null;
  const visible: VisiblePage[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.full.width <= 0 || page.full.height <= 0) continue;
    const frag = intersectRect(page.box, capture);
    if (
      !frag ||
      frag.width < MIN_VISIBLE_FRAGMENT ||
      frag.height < MIN_VISIBLE_FRAGMENT
    ) {
      continue;
    }
    if (page.pixels <= 0) return null;
    visible.push({ index: i, page, frag, scale: page.pixels / page.full.width });
  }
  if (visible.length === 0) return null;

  // Horizontally only the page column is taken: the outline column lies outside the page rects.
  const left = Math.max(
    capture.left,
    Math.min(...visible.map((v) => v.page.box.left)),
  );
  const right = Math.min(
    capture.left + capture.width,
    Math.max(...visible.map((v) => v.page.box.left + v.page.box.width)),
  );
  // Vertically both the part outside the viewport and the background outside the pages are cut away (top/bottom padding, the blank space of a short document).
  const top = Math.max(
    capture.top,
    Math.min(...visible.map((v) => v.page.box.top)),
  );
  const bottom = Math.min(
    capture.top + capture.height,
    Math.max(...visible.map((v) => v.page.box.top + v.page.box.height)),
  );
  if (right <= left || bottom <= top) return null;

  const scale = visible[0].scale;
  const width = Math.max(1, Math.round((right - left) * scale));
  const height = Math.max(1, Math.round((bottom - top) * scale));
  if (width <= 0 || height <= 0) return null;

  const frame: SnapshotRect = { left, top, width: right - left, height: bottom - top };
  const planned: PlannedPage[] = [];
  for (const v of visible) {
    const frag = intersectRect(v.frag, frame);
    if (!frag) continue;
    const s = v.scale;
    const cssToOut = (n: number) => n * scale;
    planned.push({
      page: v.index,
      src: {
        left: (frag.left - v.page.full.left) * s,
        top: (frag.top - v.page.full.top) * s,
        width: frag.width * s,
        height: frag.height * s,
      },
      dest: {
        left: cssToOut(frag.left - left),
        top: cssToOut(frag.top - top),
        width: cssToOut(frag.width),
        height: cssToOut(frag.height),
      },
      sheet: {
        left: cssToOut(v.page.full.left - left),
        top: cssToOut(v.page.full.top - top),
        width: cssToOut(v.page.full.width),
        height: cssToOut(v.page.full.height),
      },
      annotations: v.page.annotations,
    });
  }
  if (planned.length === 0) return null;

  return { width, height, scale, origin: { left, top }, pages: planned };
}

/** Move the page canvases into the output canvas following the plan; the order of pages, annotations and eye-care tint matches the DOM. */
export function paintSnapshot(
  plan: SnapshotPlan,
  canvases: HTMLCanvasElement[],
  colors: SnapshotColors,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 不可用");
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, plan.width, plan.height);

  for (const p of plan.pages) {
    const source = canvases[p.page];
    if (!source || source.width === 0) continue;
    ctx.fillStyle = colors.paper;
    ctx.fillRect(p.dest.left, p.dest.top, p.dest.width, p.dest.height);
    ctx.drawImage(
      source,
      p.src.left,
      p.src.top,
      p.src.width,
      p.src.height,
      p.dest.left,
      p.dest.top,
      p.dest.width,
      p.dest.height,
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(p.dest.left, p.dest.top, p.dest.width, p.dest.height);
    ctx.clip();
    ctx.globalCompositeOperation = "multiply";
    for (const a of p.annotations) {
      ctx.fillStyle = a.kind === "note" ? colors.note : colors.highlight;
      for (const r of a.rects) {
        ctx.fillRect(
          p.sheet.left + r.x * p.sheet.width,
          p.sheet.top + r.y * p.sheet.height,
          r.w * p.sheet.width,
          r.h * p.sheet.height,
        );
      }
    }
    if (colors.tint) {
      ctx.fillStyle = colors.tint;
      ctx.fillRect(p.dest.left, p.dest.top, p.dest.width, p.dest.height);
    }
    ctx.restore();
  }

  return canvas;
}

export async function canvasToFile(canvas: HTMLCanvasElement): Promise<File> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) throw new Error("截图编码失败");
  return new File([blob], "reading-snapshot.png", { type: "image/png" });
}

/**
 * The snapshot entry point provided by the currently mounted reader. PdfViewer
 * registers on mount and on annotation / eye-care changes and unregisters on
 * unmount; the command layer only calls capturePdfSnapshot.
 */
export type PdfSnapshotSource = () => Promise<File | null>;

let source: PdfSnapshotSource | null = null;

export function registerPdfSnapshotSource(fn: PdfSnapshotSource): () => void {
  source = fn;
  return () => {
    if (source === fn) source = null;
  };
}

export function hasPdfSnapshotSource(): boolean {
  return source !== null;
}

export async function capturePdfSnapshot(): Promise<File | null> {
  return source ? source() : null;
}
