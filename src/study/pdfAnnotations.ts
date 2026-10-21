import { createVaultJsonStore, vaultDotPath } from "./vaultJson";

/**
 * PDF 批注:亮黄色高亮 + 亮蓝色文字批注。
 *
 * 高亮矩形以「整页比例」(0..1) 存盘——缩放、裁剪、DPR 变化都不影响批注
 * 位置;页面重排(渲染宽度变了)时只需按当前页面像素重算样式。裁剪窗口
 * 只是把同一份整页坐标平移/裁掉,批注跟着页面走。
 *
 * 存盘按 PDF 一一对应:`<vault>/.bnote/pdf-annotations/<PDF 相对路径>.json`。
 * 一份 PDF 一个文件,打开哪份只读哪份,不会因为批注了很多 PDF 而让读写量
 * 随库增长。
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
  /** 亮黄 = highlight,亮蓝 + 右侧文字 = note。旧数据没有这个字段,按高亮读。 */
  kind: PdfAnnotationKind;
  /** 文字批注内容;高亮批注为空。 */
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

/** 文字批注内容上限;超长内容在输入框里滚动,不拖垮渲染。 */
export const MAX_NOTE_TEXT = 5000;

export const EMPTY_PDF_ANNOTATIONS: PdfAnnotation[] = [];

/** 归一化到页面比例;完全在页外/退化的矩形丢掉。 */
export function normalizeRects(
  boxes: Iterable<BoxLike>,
  page: BoxLike,
  minSize = 0.5,
): NormRect[] {
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
 * 同一行的相邻矩形合成一条(高亮才像一笔画过去的荧光笔)。
 *
 * 判据:垂直重叠超过较矮矩形的一半 = 同一行;水平间距 ≤ maxGap = 同一段。
 * 多栏排版的两栏之间间距大,不会被并成一条。
 */
export function mergeLineRects(rects: NormRect[], maxGap = 0.02): NormRect[] {
  // 自包含:这个函数会被序列化进网页批注运行时(toString),不能引用模块
  // 里的其它符号。
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const out: NormRect[] = [];
  for (const r of rects) {
    if (r.w <= 0 || r.h <= 0) continue;
    let merged = false;
    for (const o of out) {
      const vOverlap =
        Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
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

/** 点中的批注(后加的在上层);带一点容差,点在行边也算命中。 */
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
      if (
        x >= r.x - pad &&
        x <= r.x + r.w + pad &&
        y >= r.y - pad &&
        y <= r.y + r.h + pad
      ) {
        return a;
      }
    }
  }
  return null;
}

/**
 * 单击落在一行文字上:取那一行(与点击处同一水平段)的矩形。
 *
 * `boxes` 是文本层所有 span 的客户区矩形;先找点击处的 span,取与它垂直
 * 重叠的同一行矩形,合并成段后取包含点击横坐标的那一段——这样单击高亮的
 * 是「这一行」,而不是整页同高度的多栏内容。
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
  // 点在行间空隙时,取垂直距离最近的那个文字矩形。
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

/**
 * 批注文字框连线的起点:选区右侧、纵向底边(多行选区取整体包围盒)。
 * 从底边引出,线走在行间/文字下方,不会横穿同一行后面的正文。
 */
export function rectsAnchor(rects: NormRect[]): { x: number; y: number } | null {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    if (!(r.w > 0) || !(r.h > 0)) continue;
    left = Math.min(left, r.x);
    right = Math.max(right, r.x + r.w);
    top = Math.min(top, r.y);
    bottom = Math.max(bottom, r.y + r.h);
  }
  if (left === Number.POSITIVE_INFINITY) return null;
  return { x: right, y: bottom };
}

export function isNoteAnnotation(a: PdfAnnotation): boolean {
  return a.kind === "note";
}

/**
 * 右侧留白的阅读顺序:页 → 行(上→下) → 行内(左→右)。同一行选了两次,
 * 先出现的批注卡在上,后出现的往下排。
 *
 * 同一行的 span 常有几像素的高差(上标、不同字号),所以纵向差在
 * NOTE_LINE_TOLERANCE 内视为同一行,先比 x 再比 y——否则一行内的先后会被
 * 亚像素差打乱,违背「从左到右」。
 */
export const NOTE_LINE_TOLERANCE = 0.008;

export function sortNotes(list: PdfAnnotation[]): PdfAnnotation[] {
  return [...list].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const pa = rectsAnchor(a.rects);
    const pb = rectsAnchor(b.rects);
    const ay = pa?.y ?? Number.POSITIVE_INFINITY;
    const by = pb?.y ?? Number.POSITIVE_INFINITY;
    if (Math.abs(ay - by) > NOTE_LINE_TOLERANCE) return ay - by;
    const ax = pa?.x ?? Number.POSITIVE_INFINITY;
    const bx = pb?.x ?? Number.POSITIVE_INFINITY;
    if (Math.abs(ax - bx) > 1e-6) return ax - bx;
    return a.createdAt - b.createdAt;
  });
}

/**
 * 批注卡的纵向排布:每张卡对齐自己的锚点,和前一张重叠时整体往下推。
 * 输入必须已按阅读顺序排好(见 sortNotes),返回的 top 与输入一一对应。
 */
export function stackNoteTops(
  desiredTops: number[],
  boxHeight: number,
  gap: number,
): number[] {
  const out: number[] = [];
  let prevBottom = Number.NEGATIVE_INFINITY;
  for (const desired of desiredTops) {
    const top = Math.max(desired, prevBottom + gap);
    out.push(top);
    prevBottom = top + boxHeight;
  }
  return out;
}

export function newPdfAnnotationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `pdf-${c.randomUUID()}`;
  return `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Persistence: one file per PDF
// ---------------------------------------------------------------------------

/** 一份 PDF 对应的批注文件(相对 `.bnote/`)。目录结构镜像仓库,便于人工查找。 */
export function pdfAnnotationRelPath(docKey: string): string {
  const parts = docKey
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/\\/g, "_").replace(/\0/g, ""));
  if (parts.length === 0) parts.push("document.pdf");
  const last = parts[parts.length - 1];
  const name = `${last}.json`;
  // APFS 文件名上限 255 字节;超长时用路径哈希兜底,仍保持一份 PDF 一个文件。
  parts[parts.length - 1] =
    name.length <= 200 ? name : `${last.slice(0, 120)}-${fnv1a(docKey)}.json`;
  return `pdf-annotations/${parts.join("/")}`;
}

export function pdfAnnotationPath(vaultRoot: string, docKey: string): string {
  return vaultDotPath(vaultRoot, pdfAnnotationRelPath(docKey));
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

const store = createVaultJsonStore<PdfAnnotation[]>({
  pathFor: (vaultRoot, docKey) => pdfAnnotationPath(vaultRoot, docKey),
  empty: () => [],
  parse: parsePdfAnnotations,
  serialize: (list) => JSON.stringify({ version: 1, annotations: list } satisfies PdfAnnotationFile),
});

export async function loadPdfAnnotations(
  vaultRoot: string,
  docKey: string,
): Promise<PdfAnnotation[]> {
  return store.load(vaultRoot, docKey);
}

export function savePdfAnnotations(
  vaultRoot: string,
  docKey: string,
  list: PdfAnnotation[],
): void {
  store.update(vaultRoot, docKey, () => list);
}

export function flushPdfAnnotations(): void {
  store.flush();
}
