import { createVaultJsonStore, vaultDotPath } from "./vaultJson";

/**
 * PDF annotations: for now only bright yellow highlights. The data model still
 * keeps `kind: "note"` (text annotation entries in old files are read and
 * written as-is, not cleaned up), but the UI no longer creates them and no
 * longer shows them.
 *
 * Highlight rectangles are stored as "full page ratios" (0..1), so zoom, crop
 * and DPR changes never move an annotation; when the page reflows (the
 * rendered width changed) only the styling has to be recomputed from the
 * current page pixels. The crop window just shifts/clips the same full-page
 * coordinates, so annotations travel with the page.
 *
 * Storage is one-to-one with the material:
 * `<vault>/.bnote/materials/pdfs/<dir>/annotations.json` (the material
 * directory is described in study/materials.ts, the same directory the agent
 * session transcripts use). One file per PDF, and opening a PDF only reads that
 * file, so the read/write volume does not grow with the library just because
 * many PDFs carry annotations.
 */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PdfAnnotationKind = "highlight" | "note";

export interface PdfAnnotation {
  id: string;
  page: number;
  rects: NormRect[];
  /** Bright yellow = highlight, bright blue + text on the right = note. Old data has no such field and is read as a highlight. */
  kind: PdfAnnotationKind;
  /** Text annotation content; empty for highlights. */
  text: string;
  createdAt: number;
}

export interface PdfAnnotationFile {
  version: 1;
  annotations: PdfAnnotation[];
}

export interface BoxLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Read limit for legacy text annotation content (only used when parsing old data; the UI no longer edits it). */
export const MAX_NOTE_TEXT = 5000;

export const EMPTY_PDF_ANNOTATIONS: PdfAnnotation[] = [];

/** Normalize to page ratios; rectangles fully outside the page or degenerate are dropped. */
export function normalizeRects(boxes: Iterable<BoxLike>, page: BoxLike, minSize = 0.5): NormRect[] {
  const width = page.right - page.left;
  const height = page.bottom - page.top;
  if (width <= 0 || height <= 0) return [];
  const out: NormRect[] = [];
  for (const b of boxes) {
    const left = Math.max(b.left, page.left);
    const right = Math.min(b.right, page.right);
    const top = Math.max(b.top, page.top);
    const bottom = Math.min(b.bottom, page.bottom);
    if (right - left < minSize || bottom - top < minSize) continue;
    out.push({
      x: round((left - page.left) / width),
      y: round((top - page.top) / height),
      w: round((right - left) / width),
      h: round((bottom - top) / height),
    });
  }
  return out;
}

/**
 * Merge adjacent rectangles on the same line (only then does a highlight look
 * like a highlighter stroke drawn in one pass).
 *
 * Criterion: vertical overlap beyond half of the shorter rectangle = same
 * line; horizontal gap <= maxGap = same run. In a multi-column layout the gap
 * between the columns is large, so they are not merged.
 */
export function mergeLineRects(rects: NormRect[], maxGap = 0.02): NormRect[] {
  // Self-contained: this function is serialized into the web annotation
  // runtime (toString), so it must not reference other module symbols.
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const out: NormRect[] = [];
  for (const r of rects) {
    if (r.w <= 0 || r.h <= 0) continue;
    let merged = false;
    for (const o of out) {
      const vOverlap = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
      if (vOverlap <= 0.5 * Math.min(o.h, r.h)) continue;
      const gap = Math.max(o.x, r.x) - Math.min(o.x + o.w, r.x + r.w);
      if (gap > maxGap) continue;
      const left = Math.min(o.x, r.x);
      const top = Math.min(o.y, r.y);
      const right = Math.max(o.x + o.w, r.x + r.w);
      const bottom = Math.max(o.y + o.h, r.y + r.h);
      o.x = round6(left);
      o.y = round6(top);
      o.w = round6(right - left);
      o.h = round6(bottom - top);
      merged = true;
      break;
    }
    if (!merged) out.push({ ...r });
  }
  return out;
}

/** The annotation under the click (later ones are on top); a small tolerance means clicking the line edge also hits. */
export function annotationAt(
  annotations: PdfAnnotation[],
  page: number,
  x: number,
  y: number,
  pad = 0.004,
): PdfAnnotation | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.page !== page) continue;
    for (const r of a.rects) {
      if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) {
        return a;
      }
    }
  }
  return null;
}

/**
 * A click that lands on a line of text: take the rectangles of that line (the
 * same horizontal run as the click).
 *
 * `boxes` holds the client rects of every span in the text layer; first find
 * the span under the click, then take the rectangles of the same line that
 * overlap it vertically, merge them into runs and pick the run containing the
 * click's x coordinate — so a single click highlights "this line" instead of
 * every column of the page that happens to be at the same height.
 */
export function lineRectsAtPoint(
  boxes: BoxLike[],
  page: BoxLike,
  x: number,
  y: number,
  maxGap = 0.02,
): NormRect[] {
  const width = page.right - page.left;
  const height = page.bottom - page.top;
  if (width <= 0 || height <= 0) return [];
  const hit = boxes.filter(
    (b) => x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2,
  );
  if (hit.length === 0) return [];
  // When the click lands in the gap between lines, take the text rectangle with the smallest vertical distance.
  const line = hit.reduce((a, b) => (lineDistance(b, y) < lineDistance(a, y) ? b : a));
  const band = boxes.filter(
    (b) =>
      Math.min(b.bottom, line.bottom) - Math.max(b.top, line.top) > 1 &&
      b.right > page.left &&
      b.left < page.right,
  );
  const merged = mergeLineRects(
    band.map((b) => {
      const left = Math.max(b.left, page.left);
      const right = Math.min(b.right, page.right);
      const top = Math.max(b.top, page.top);
      const bottom = Math.min(b.bottom, page.bottom);
      return {
        x: (left - page.left) / width,
        y: (top - page.top) / height,
        w: (right - left) / width,
        h: (bottom - top) / height,
      };
    }),
    maxGap,
  );
  const xNorm = (x - page.left) / width;
  return merged
    .filter((r) => xNorm >= r.x - 0.01 && xNorm <= r.x + r.w + 0.01)
    .map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));
}

function lineDistance(b: BoxLike, y: number): number {
  if (y < b.top) return b.top - y;
  if (y > b.bottom) return y - b.bottom;
  return 0;
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

export function newPdfAnnotationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `pdf-${c.randomUUID()}`;
  return `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Persistence: one file per material
// ---------------------------------------------------------------------------

/** The annotation file of one material (relative to `.bnote/`). It sits next to the PDF's sessions, inside the material directory. */
export function pdfAnnotationRelPath(materialDir: string): string {
  return `${materialDir}/annotations.json`;
}

export function pdfAnnotationPath(vaultRoot: string, materialDir: string): string {
  return vaultDotPath(vaultRoot, pdfAnnotationRelPath(materialDir));
}

/** The pre-material location of one PDF's annotations (`.bnote/pdf-annotations/<vault relative pdf path>.json`); only the one-time migration reads it. */
export function legacyPdfAnnotationRelPath(docKey: string): string {
  const parts = docKey
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/\\/g, "_").replace(/\0/g, ""));
  if (parts.length === 0) parts.push("document.pdf");
  const last = parts[parts.length - 1];
  const name = `${last}.json`;
  // APFS file names are limited to 255 bytes; when too long, fall back to a path hash, still keeping one file per PDF.
  parts[parts.length - 1] =
    name.length <= 200 ? name : `${last.slice(0, 120)}-${fnv1a(docKey)}.json`;
  return `pdf-annotations/${parts.join("/")}`;
}

export function legacyPdfAnnotationPath(vaultRoot: string, docKey: string): string {
  return vaultDotPath(vaultRoot, legacyPdfAnnotationRelPath(docKey));
}

export function parsePdfAnnotationFile(raw: string | null): PdfAnnotationFile {
  const empty: PdfAnnotationFile = { version: 1, annotations: [] };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as { annotations?: unknown }).annotations
      : null;
  if (!Array.isArray(list)) return empty;
  return { version: 1, annotations: list.filter(isPdfAnnotation).map(normalizeAnnotation) };
}

export function parsePdfAnnotations(raw: string | null): PdfAnnotation[] {
  return parsePdfAnnotationFile(raw).annotations;
}

function isPdfAnnotation(value: unknown): value is PdfAnnotation {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<PdfAnnotation>;
  return (
    typeof a.id === "string" &&
    a.id.length > 0 &&
    typeof a.page === "number" &&
    Number.isFinite(a.page) &&
    a.page >= 1 &&
    Array.isArray(a.rects) &&
    a.rects.length > 0 &&
    a.rects.every(
      (r) =>
        r &&
        typeof r.x === "number" &&
        typeof r.y === "number" &&
        typeof r.w === "number" &&
        typeof r.h === "number" &&
        r.w > 0 &&
        r.h > 0,
    )
  );
}

function normalizeAnnotation(a: PdfAnnotation): PdfAnnotation {
  return {
    id: a.id,
    page: Math.floor(a.page),
    rects: a.rects,
    kind: a.kind === "note" ? "note" : "highlight",
    text: typeof a.text === "string" ? a.text.slice(0, MAX_NOTE_TEXT) : "",
    createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
  };
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Annotations live in the material directory, next to the PDF's sessions:
 * `<vault>/.bnote/materials/pdfs/<dir>/annotations.json`. Without a material
 * directory (no vault, the backend could not create it) nothing is persisted;
 * there is no second location.
 */
const store = createVaultJsonStore<PdfAnnotation[]>({
  pathFor: (vaultRoot, materialDir) => pdfAnnotationPath(vaultRoot, materialDir),
  empty: () => [],
  parse: parsePdfAnnotations,
  serialize: (list) =>
    JSON.stringify({ version: 1, annotations: list } satisfies PdfAnnotationFile),
});

/** Read the annotations of one material. */
export async function loadPdfAnnotations(
  vaultRoot: string,
  materialDir: string | null,
): Promise<PdfAnnotation[]> {
  if (!materialDir) return EMPTY_PDF_ANNOTATIONS;
  return store.load(vaultRoot, materialDir);
}

export function savePdfAnnotations(
  vaultRoot: string,
  list: PdfAnnotation[],
  materialDir: string | null,
): void {
  if (!materialDir) return;
  store.update(vaultRoot, materialDir, () => list);
}

export function flushPdfAnnotations(): void {
  store.flush();
}

/** Merge by id; the incoming entries win. Used when migrating the pre-material annotation files. */
export function mergePdfAnnotations(
  base: PdfAnnotation[],
  incoming: PdfAnnotation[],
): PdfAnnotation[] {
  const byId = new Map<string, PdfAnnotation>();
  for (const a of base) byId.set(a.id, a);
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()];
}
