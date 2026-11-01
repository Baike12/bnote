import { decompressFromBase64 } from "lz-string";

/**
 * Format layer for Excalidraw drawing files (pure functions, no dependency on
 * @excalidraw/excalidraw — that is a large module and the note rendering path
 * is only allowed to touch this one file).
 *
 * Two on-disk formats are supported, interoperable with the Obsidian Excalidraw
 * plugin:
 * - `<name>.excalidraw` — plain JSON (the official Excalidraw scene file; this
 *   is what bnote creates);
 * - `<name>.excalidraw.md` — the Obsidian plugin's markdown wrapper: frontmatter
 *   (`excalidraw-plugin: parsed`) plus a ```json / ```compressed-json code block.
 *   Both are read and written, so a user's existing Obsidian drawing library
 *   can be edited directly in bnote.
 */

/** New drawings land in this vault folder (matching the user's Obsidian Excalidraw plugin config). */
export const DRAWING_FOLDER = "Excalidraw";

const DRAWING_RE = /\.excalidraw(\.md)?$/i;
const MD_FORMAT_RE = /\.excalidraw\.md$/i;

export function isDrawingFileName(name: string): boolean {
  return DRAWING_RE.test(name);
}

/** `foo.excalidraw` / `foo.excalidraw.md` → `foo`; any other name is returned unchanged. */
export function drawingStem(name: string): string {
  return name.replace(DRAWING_RE, "");
}

/** File name of the preview PNG exported next to a drawing (same stem, same folder). */
export function drawingPngName(name: string): string {
  return `${drawingStem(name)}.png`;
}

export interface DrawingScene {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown> | null;
}

/** The stable shape of the official serializeAsJSON; field order matches upstream so diff tools stay useful. */
export function serializeSceneJson(scene: DrawingScene): string {
  const appState: Record<string, unknown> = {};
  const bg = scene.appState.viewBackgroundColor;
  if (typeof bg === "string") appState.viewBackgroundColor = bg;
  if ("gridSize" in scene.appState) appState.gridSize = scene.appState.gridSize;
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "bnote",
    elements: scene.elements,
    appState,
    files: scene.files ?? {},
  });
}

export function emptySceneJson(): string {
  return serializeSceneJson({ elements: [], appState: {}, files: null });
}

/** Default file name for a new drawing: a fixed CJK prefix plus a YYYY-MM-DD
 *  HH.MM.SS stamp, e.g. `2026-09-20 20.47.06.excalidraw`. */
export function newDrawingFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    ` ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return `画图 ${stamp}.excalidraw`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse drawing file text. The wrapper head of an `.excalidraw.md` file
 * (frontmatter and prose) must be preserved verbatim on write-back, so it is
 * returned alongside the scene; plain JSON files return null.
 */
export function parseDrawingFile(
  text: string,
  fileName: string,
): { scene: DrawingScene; mdWrapper: string | null } {
  if (!MD_FORMAT_RE.test(fileName)) {
    return { scene: parseSceneJson(text), mdWrapper: null };
  }
  const wrapper = extractMdWrapper(text);
  if (!wrapper) {
    throw new Error(`${fileName}: 不是有效的 Excalidraw markdown 文件`);
  }
  const { json, frontmatter } = wrapper;
  return { scene: parseSceneJson(json), mdWrapper: frontmatter };
}

function parseSceneJson(text: string): DrawingScene {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`场景数据不是合法 JSON: ${String(e)}`);
  }
  const obj = data as Record<string, unknown>;
  if (!obj || obj.type !== "excalidraw" || !Array.isArray(obj.elements)) {
    throw new Error("场景数据缺少 excalidraw 元素");
  }
  return {
    elements: obj.elements,
    appState:
      obj.appState && typeof obj.appState === "object"
        ? (obj.appState as Record<string, unknown>)
        : {},
    files:
      obj.files && typeof obj.files === "object"
        ? (obj.files as Record<string, unknown>)
        : null,
  };
}

/** Fence markers of the Obsidian plugin's data block (both compressed and plain). */
const FENCE_RE = /```(compressed-json|json)[ \t]*\r?\n([\s\S]*?)\r?\n?```/;

function extractMdWrapper(
  text: string,
): { json: string; frontmatter: string } | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm || !/^excalidraw-plugin:/m.test(fm[1])) return null;
  const m = FENCE_RE.exec(text);
  if (!m) return null;
  let json = m[2];
  if (m[1] === "compressed-json") {
    json = decompressFromBase64(json);
    if (!json) return null;
  }
  return { json, frontmatter: fm[0] };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Serialize to the text written to disk. `.excalidraw.md` rebuilds its wrapper
 * from the frontmatter kept at open time (the code block is always written as
 * plain json — the plugin reads both, and plain text keeps the file diffable
 * and hand-editable).
 */
export function serializeDrawingFile(
  scene: DrawingScene,
  fileName: string,
  mdWrapper: string | null,
): string {
  const json = serializeSceneJson(scene);
  if (!MD_FORMAT_RE.test(fileName)) {
    if (!fileName.toLowerCase().endsWith(".excalidraw")) {
      throw new Error(`不是画图文件: ${fileName}`);
    }
    return json;
  }
  const frontmatter = mdWrapper ?? defaultFrontmatter();
  return `${frontmatter}\n\n# Excalidraw Data\n\n## Drawing\n\`\`\`json\n${json}\n\`\`\`\n%%\n`;
}

function defaultFrontmatter(): string {
  return "---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---";
}
