import { createVaultJsonStore, vaultDotPath, type JsonIO } from "./vaultJson";

/**
 * Reading positions in study mode: PDFs record "which page + the offset
 * within it", web pages record "the scroll ratio".
 *
 * A PDF's page number / in-page ratio holds under zoom, column width changes
 * and cropping: after a reflow the same page still continues from the same
 * spot. A web page cannot reach its own scroll container (its DOM lives
 * outside the main window), and ads / lazy loading invalidate pixel
 * positions, so it uses "the ratio of the scrollable height" instead.
 *
 * Everything lands in a single `<vault>/.bnote/read-positions.json`: this
 * data is volatile reading traces, not user content, and does not need one
 * file per PDF / URL; the writes are still serialized by
 * `createVaultJsonStore`, so there is only one writer at a time.
 */
export interface PdfReadPosition {
  /** 1-based page number. */
  page: number;
  /** Offset within the page (0..1, a ratio of the page height). */
  offset: number;
  /** Unix ms, only used to prune old entries. */
  at: number;
}

export interface WebReadPosition {
  /** 0..1:scrollTop / (scrollHeight - clientHeight)。 */
  ratio: number;
  at: number;
}

export interface ReadPositions {
  version: 1;
  pdfs: Record<string, PdfReadPosition>;
  urls: Record<string, WebReadPosition>;
}

/** Positions keep being added while reading; only the most recent batch is kept so the file does not grow without bound. */
export const MAX_TRACKED_POSITIONS = 500;

export function emptyReadPositions(): ReadPositions {
  return { version: 1, pdfs: {}, urls: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function prune<T extends { at: number }>(record: Record<string, T>): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= MAX_TRACKED_POSITIONS) return record;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_POSITIONS));
}

/** Bad fields from a hand edit or an older version are dropped; the config must never take the reader down at startup. */
export function normalizeReadPositions(raw: unknown): ReadPositions {
  const out = emptyReadPositions();
  if (!isRecord(raw)) return out;
  if (isRecord(raw.pdfs)) {
    for (const [key, value] of Object.entries(raw.pdfs)) {
      if (!key || !isRecord(value)) continue;
      const page = Math.floor(num(value.page));
      if (page < 1) continue;
      out.pdfs[key] = {
        page,
        offset: clamp01(num(value.offset)),
        at: num(value.at),
      };
    }
  }
  if (isRecord(raw.urls)) {
    for (const [key, value] of Object.entries(raw.urls)) {
      if (!key || !isRecord(value)) continue;
      out.urls[key] = { ratio: clamp01(num(value.ratio)), at: num(value.at) };
    }
  }
  out.pdfs = prune(out.pdfs);
  out.urls = prune(out.urls);
  return out;
}

export function parseReadPositions(raw: string | null): ReadPositions {
  if (!raw) return emptyReadPositions();
  try {
    return normalizeReadPositions(JSON.parse(raw));
  } catch {
    return emptyReadPositions();
  }
}

/** The position of a page in the scrolled content (pixels). */
export interface PageMetric {
  page: number;
  top: number;
  height: number;
}

/**
 * Scroll position -> page number + in-page offset. Takes "the last page whose
 * top edge has passed the viewport top": when there are gaps between pages, a
 * viewport top landing in a gap still counts as the previous page (an offset
 * > 1 is clamped to 1).
 */
export function pdfPositionAt(pages: PageMetric[], scrollTop: number): PdfReadPosition | null {
  if (pages.length === 0) return null;
  const sorted = [...pages].sort((a, b) => a.top - b.top);
  let chosen = sorted[0];
  for (const p of sorted) {
    if (p.top <= scrollTop + 2) chosen = p;
    else break;
  }
  const offset = chosen.height > 0 ? (scrollTop - chosen.top) / chosen.height : 0;
  return { page: chosen.page, offset: clamp01(offset), at: 0 };
}

/** Page number + in-page offset -> absolute scrollTop; null when the page no longer exists (the file was swapped). */
export function scrollTopForPdfPosition(
  pages: PageMetric[],
  position: Pick<PdfReadPosition, "page" | "offset">,
): number | null {
  const target = pages.find((p) => p.page === position.page);
  if (!target) return null;
  return Math.max(0, target.top + clamp01(position.offset) * target.height);
}

function createReadPositionStore(io?: JsonIO) {
  return createVaultJsonStore<ReadPositions>({
    pathFor: (vaultRoot) => vaultDotPath(vaultRoot, "read-positions.json"),
    empty: emptyReadPositions,
    parse: parseReadPositions,
    serialize: (data) => JSON.stringify(data),
    io,
  });
}

/** Singleton: one cache and one writer for this file. */
export const readPositionStore = createReadPositionStore();

/** For tests: a standalone store with an injected fake IO. */
export { createReadPositionStore };

const KEY = "positions";

export async function loadReadPositions(vaultRoot: string): Promise<ReadPositions> {
  return readPositionStore.load(vaultRoot, KEY);
}

export function savePdfReadPosition(
  vaultRoot: string,
  docKey: string,
  position: Pick<PdfReadPosition, "page" | "offset">,
): void {
  readPositionStore.update(vaultRoot, KEY, (data) => ({
    ...data,
    pdfs: prune({
      ...data.pdfs,
      [docKey]: { ...position, at: Date.now() },
    }),
  }));
}

export function saveWebReadPosition(
  vaultRoot: string,
  url: string,
  ratio: number,
): void {
  readPositionStore.update(vaultRoot, KEY, (data) => ({
    ...data,
    urls: prune({
      ...data.urls,
      [url]: { ratio: clamp01(ratio), at: Date.now() },
    }),
  }));
}

export function flushReadPositions(): void {
  readPositionStore.flush();
}
