import { eventKeyName, parseBinding } from "@/commands/keys";
import { createVaultJsonStore, vaultDotPath } from "./vaultJson";
import { mergeLineRects } from "./pdfAnnotations";
import { normalizePageStep, snapScrollTopToLine } from "./reading";
import { webAnnotationRuntime } from "./webAnnotationRuntime";

/**
 * Web annotations: highlights (bright yellow) and text annotations (bright
 * blue + an annotation card inside the page).
 *
 * The web page in the content column is a **native sub-webview** (not an
 * iframe, see commands/agent.rs), so the main app cannot reach its DOM. The
 * annotation logic is therefore injected into the page as an init script:
 *
 *  1. The runtime inside the page owns the selection, the anchors, the
 *     highlight layer and the annotation cards (it opens its own shadow root,
 *     so page CSS does not touch it; it works under CSP too, all styling goes
 *     through the CSSOM).
 *  2. When the annotations change it writes `{url, annotations}` into
 *     `document.title` behind the `bnote-anno:` prefix; Rust's title callback
 *     turns that into a Tauri event for the main window, which persists it to
 *     the page's material directory
 *     (`<vault>/.bnote/materials/webpages/<dir>/annotations.json`).
 *     No remote IPC is opened — an arbitrary web page must not get access to
 *     the app's commands.
 *  3. When a page is opened the main window pushes the stored anchors back
 *     into the page (`__bnoteAnno.merge`), and the page relocates them by
 *     "quoted text + surrounding context + offset"; it also keeps a copy in
 *     localStorage so it is available immediately after a page reload.
 *
 * The anchors do not use pixels: ads / lazy loading move the elements, so
 * pixels are guaranteed to fail after a restart. The text fragment (+-40
 * characters of context plus an offset hint) is the stable basis. The reading
 * position is stored as a ratio for the same reason, see `POS_PREFIX`.
 */
export type WebAnnotationKind = "highlight" | "note";

export interface WebAnnotation {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  /** The starting offset in the body text stream at creation time, a disambiguation hint when the anchor is rebuilt. */
  offset: number;
  /** Bright yellow highlight / bright blue text annotation. Old data has no such field and is read as a highlight. */
  kind: WebAnnotationKind;
  /** Text annotation content; empty for highlights. */
  text: string;
  createdAt: number;
}

export interface WebAnnotationFile {
  version: 1;
  /** The original URL is kept in the file so it can be recognized by hand (the file name only has the host + hash). */
  url: string;
  annotations: WebAnnotation[];
}

export const MAX_WEB_QUOTE = 2000;

/**
 * Validate / trim the annotations the page sends. It has to be
 * self-contained (no module constants): it is serialized into the page
 * runtime.
 */
export function normalizeWebAnnotations(value: unknown): WebAnnotation[] {
  if (!Array.isArray(value)) return [];
  const out: WebAnnotation[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 800)) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Partial<WebAnnotation>;
    if (typeof a.id !== "string" || !a.id || seen.has(a.id)) continue;
    if (typeof a.quote !== "string" || !a.quote) continue;
    if (typeof a.offset !== "number" || !Number.isFinite(a.offset) || a.offset < 0) continue;
    seen.add(a.id);
    out.push({
      id: a.id,
      quote: a.quote.slice(0, 2000),
      prefix: typeof a.prefix === "string" ? a.prefix.slice(-40) : "",
      suffix: typeof a.suffix === "string" ? a.suffix.slice(0, 40) : "",
      offset: Math.floor(a.offset),
      kind: a.kind === "note" ? "note" : "highlight",
      text: typeof a.text === "string" ? a.text.slice(0, 2000) : "",
      createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
    });
  }
  return out;
}

/**
 * Find the starting offset of a quote in the rebuilt body text: among the
 * candidates prefer the one whose surrounding context matches, and break a
 * tie by taking the one closest to the original offset. Returns -1 when it is
 * not found (the anchor is kept, it just cannot be drawn in this round).
 */
export function locateQuote(
  text: string,
  quote: string,
  offset: number,
  prefix: string,
  suffix: string,
): number {
  if (!quote) return -1;
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let from = 0;
  for (let found = 0; found < 64; found++) {
    const i = text.indexOf(quote, from);
    if (i < 0) break;
    let score = 0;
    if (prefix && i >= prefix.length && text.slice(i - prefix.length, i) === prefix) {
      score += 2;
    }
    if (suffix && text.slice(i + quote.length, i + quote.length + suffix.length) === suffix) {
      score += 2;
    }
    // The distance only serves as the last tie-breaker, it never outranks the context.
    score -= Math.min(0.9, Math.abs(i - offset) / 100000);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
    from = i + Math.max(1, quote.length);
  }
  return best;
}

/**
 * Text offset -> DOM point. When the offset falls exactly on the boundary
 * between two text runs, the start belongs to the beginning of the later run
 * (offset 0) and the end to the end of the earlier one — the half-open
 * interval `[start, end)`.
 *
 * Both ends must not take the end of the earlier run: a blank line or another
 * block may sit between the two runs (the first character of a line starting
 * a new text node is the common case), and as soon as the Range spans it
 * WebKit counts the whole blank line as selected and returns a full-width
 * rectangle — a yellow bar appears out of nowhere on top of the blank line.
 * Self-contained: it is serialized into the web runtime.
 */
export function textPointAt<T>(
  entries: Array<{ node: T; start: number; end: number }>,
  offset: number,
  edge: "start" | "end",
): { node: T; offset: number } | null {
  for (const e of entries) {
    if (edge === "start") {
      if (offset >= e.start && offset < e.end) return { node: e.node, offset: offset - e.start };
    } else if (offset > e.start && offset <= e.end) {
      return { node: e.node, offset: offset - e.start };
    }
  }
  // Only out of range at the very end of the text: a start is always < the text length, this is just a fallback.
  const last = entries[entries.length - 1];
  if (last && offset === last.end) return { node: last.node, offset: last.end - last.start };
  return null;
}

// ---------------------------------------------------------------------------
// Persistence (<vault>/.bnote/web-annotations/<host>-<hash>.json, one file per URL)
// ---------------------------------------------------------------------------

export function parseWebAnnotationFile(raw: string | null): WebAnnotationFile {
  const empty: WebAnnotationFile = { version: 1, url: "", annotations: [] };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  if (!record) return empty;
  return {
    version: 1,
    url: typeof record.url === "string" ? record.url : "",
    annotations: normalizeWebAnnotations(record.annotations),
  };
}

export function parseWebAnnotations(raw: string | null): WebAnnotation[] {
  return parseWebAnnotationFile(raw).annotations;
}

/** URL -> annotation file name: a readable host plus a stable hash, so the same URL always lands in the same file. */
export function webAnnotationFileName(url: string): string {
  let host = "page";
  try {
    host = new URL(url).hostname || "page";
  } catch {
    // A non-standard URL (about:blank and the like) still gets a stable name.
  }
  const slug =
    host
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "page";
  return `${slug}-${hash53(url)}.json`;
}

/** The pre-material location of one URL's annotations (`.bnote/web-annotations/<host>-<hash>.json`); only the one-time migration reads it. */
export function legacyWebAnnotationRelPath(url: string): string {
  return `web-annotations/${webAnnotationFileName(url)}`;
}

export function legacyWebAnnotationPath(vaultRoot: string, url: string): string {
  return vaultDotPath(vaultRoot, legacyWebAnnotationRelPath(url));
}

/** Merge two sets of annotations by id (the stored ones + the page ones); the newer one in the page wins. */
export function mergeUrlAnnotations(
  base: WebAnnotation[],
  incoming: WebAnnotation[],
): WebAnnotation[] {
  const byId = new Map<string, WebAnnotation>();
  for (const a of base) byId.set(a.id, a);
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()].slice(0, 800);
}

/** The annotation file of one material: `<vault>/.bnote/materials/webpages/<dir>/annotations.json`. */
export function webAnnotationMaterialPath(vaultRoot: string, materialDir: string): string {
  return vaultDotPath(vaultRoot, `${materialDir}/annotations.json`);
}

const store = createVaultJsonStore<WebAnnotationFile>({
  pathFor: (vaultRoot, materialDir) => webAnnotationMaterialPath(vaultRoot, materialDir),
  empty: () => ({ version: 1, url: "", annotations: [] }),
  parse: parseWebAnnotationFile,
  serialize: (file) => JSON.stringify(file),
});

/** Read the annotations of one material (no material directory = nothing is persisted). */
export async function loadWebAnnotations(
  vaultRoot: string,
  materialDir: string | null,
): Promise<WebAnnotation[]> {
  if (!materialDir) return [];
  return (await store.load(vaultRoot, materialDir)).annotations;
}

export function saveWebAnnotations(
  vaultRoot: string,
  url: string,
  list: WebAnnotation[],
  materialDir: string | null,
): void {
  if (!materialDir) return;
  store.update(vaultRoot, materialDir, (file) => ({
    version: 1,
    url: file.url || url,
    annotations: normalizeWebAnnotations(list),
  }));
}

export function flushWebAnnotations(): void {
  store.flush();
}

function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The complete script injected into the native webview (the runtime + the pure functions it depends on). */
export function buildWebAnnotationScript(): string {
  const helpers = [
    `locateQuote:${locateQuote.toString()}`,
    `textPointAt:${textPointAt.toString()}`,
    `mergeLineRects:${mergeLineRects.toString()}`,
    `normalizeWebAnnotations:${normalizeWebAnnotations.toString()}`,
    `normalizePageStep:${normalizePageStep.toString()}`,
    `snapScrollTopToLine:${snapScrollTopToLine.toString()}`,
    `parseBinding:${parseBinding.toString()}`,
    `eventKeyName:${eventKeyName.toString()}`,
  ].join(",");
  return `(${webAnnotationRuntime.toString()})({${helpers}});`;
}

/** Computed only once: every time the main window opens a web page it hands this to Rust to register as an init script. */
export const WEB_ANNOTATION_SCRIPT = buildWebAnnotationScript();
