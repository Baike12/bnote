import { decompressFromBase64 } from "lz-string";

/**
 * Excalidraw 画图文件的格式层(纯函数,不依赖 @excalidraw/excalidraw——
 * 那是大模块,笔记渲染路径只允许碰这一个文件)。
 *
 * 支持两种磁盘格式,与 Obsidian Excalidraw 插件互通:
 * - `<name>.excalidraw` —— 纯 JSON(excalidraw 官方场景文件,bnote 新建用这个);
 * - `<name>.excalidraw.md` —— Obsidian 插件的 markdown 包裹:frontmatter
 *   (`excalidraw-plugin: parsed`)+ ```json / ```compressed-json 代码块。
 *   读写都支持,这样用户已有的 Obsidian 画图库可以直接在 bnote 里编辑。
 */

/** 新建画图落在这个 vault 目录(与用户 Obsidian Excalidraw 插件的配置一致)。 */
export const DRAWING_FOLDER = "Excalidraw";

const DRAWING_RE = /\.excalidraw(\.md)?$/i;
const MD_FORMAT_RE = /\.excalidraw\.md$/i;

export function isDrawingFileName(name: string): boolean {
  return DRAWING_RE.test(name);
}

/** `foo.excalidraw` / `foo.excalidraw.md` → `foo`;其他名字原样返回。 */
export function drawingStem(name: string): string {
  return name.replace(DRAWING_RE, "");
}

/** 画图旁边导出的预览图文件名(与画图同目录同名,只换扩展名)。 */
export function drawingPngName(name: string): string {
  return `${drawingStem(name)}.png`;
}

export interface DrawingScene {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown> | null;
}

/** 官方 serializeAsJSON 的稳定形状;字段顺序与官方一致,方便 diff 工具。 */
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

/** 新建画图的默认文件名,如 `画图 2026-09-20 20.47.06.excalidraw`。 */
export function newDrawingFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    ` ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return `画图 ${stamp}.excalidraw`;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析画图文件文本。`.excalidraw.md` 的包裹头(frontmatter 与说明文字)在
 * 写回时要原样保留,所以一并返回;纯 JSON 格式返回 null。
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

/** Obsidian 插件数据块的围栏标记(压缩/明文两种都认)。 */
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
// 写盘
// ---------------------------------------------------------------------------

/**
 * 序列化为写盘文本。`.excalidraw.md` 用打开时保留的 frontmatter 重建包裹
 * (代码块始终写明文 json —— 插件两种都读,明文让文件可 diff、可手修)。
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
