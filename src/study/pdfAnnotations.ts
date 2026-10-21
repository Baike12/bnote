import { createVaultJsonStore } from "./vaultJson";

/**
 * PDF 批注:亮黄色行高亮。
 *
 * 高亮矩形以「整页比例」(0..1) 存盘——缩放、裁剪、DPR 变化都不影响批注
 * 位置;页面重排(渲染宽度变了)时只需按当前页面像素重算样式。裁剪窗口
 * 只是把同一份整页坐标平移/裁掉,批注跟着页面走。
 */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfAnnotation {
  id: string;
  page: number;
  rects: NormRect[];
  createdAt: number;
}

export interface PdfAnnotationFile {
  version: 1;
  /** key = vault 相对路径(`pdfs/x.pdf`),仓库移动不失效。 */
  docs: Record<string, PdfAnnotation[]>;
}

export interface BoxLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

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

function round(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

export function newPdfAnnotationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `pdf-${c.randomUUID()}`;
  return `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function parsePdfAnnotationFile(raw: string | null): PdfAnnotationFile {
  const empty: PdfAnnotationFile = { version: 1, docs: {} };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const docs = (parsed as { docs?: unknown }).docs;
  if (!docs || typeof docs !== "object") return empty;
  const out: Record<string, PdfAnnotation[]> = {};
  for (const [key, value] of Object.entries(docs as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const list = value.filter(isPdfAnnotation);
    if (list.length > 0) out[key] = list;
  }
  return { version: 1, docs: out };
}

function isPdfAnnotation(value: unknown): value is PdfAnnotation {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<PdfAnnotation>;
  return (
    typeof a.id === "string" &&
    typeof a.page === "number" &&
    Array.isArray(a.rects) &&
    a.rects.every(
      (r) =>
        r &&
        typeof r.x === "number" &&
        typeof r.y === "number" &&
        typeof r.w === "number" &&
        typeof r.h === "number",
    )
  );
}

export function withDocAnnotations(
  file: PdfAnnotationFile,
  key: string,
  list: PdfAnnotation[],
): PdfAnnotationFile {
  const docs = { ...file.docs };
  if (list.length > 0) docs[key] = list;
  else delete docs[key];
  return { version: 1, docs };
}

const store = createVaultJsonStore<PdfAnnotationFile>({
  fileName: "pdf-annotations.json",
  empty: () => ({ version: 1, docs: {} }),
  parse: parsePdfAnnotationFile,
  serialize: (file) => JSON.stringify(file),
});

export async function loadPdfAnnotations(
  vaultRoot: string,
  key: string,
): Promise<PdfAnnotation[]> {
  const file = await store.load(vaultRoot);
  return file.docs[key] ?? [];
}

export function savePdfAnnotations(
  vaultRoot: string,
  key: string,
  list: PdfAnnotation[],
): void {
  store.update(vaultRoot, (file) => withDocAnnotations(file, key, list));
}

export function flushPdfAnnotations(): void {
  store.flush();
}
