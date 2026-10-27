/**
 * 阅读区截图:把当前可见的 PDF 页面拼成一张图,直接送进学习助手输入框。
 *
 * 页面本来就是 pdf.js 画进 `<canvas>` 的(PdfViewer 每页一个),所以这里
 * 不需要系统截图权限,也不需要 html2canvas:新建一块画布,把可见的页面片段
 * 用 drawImage 搬过去。取景框 = 「滚动视口 ∩ 页面列」:
 *   - 左侧目录栏(.pdf-outline)与批注留白(.pdf-notes)在页面列之外,自然
 *     不进图;
 *   - 页框阴影是 .pdf-page 的 CSS box-shadow,canvas 像素里根本不存在。
 * 护眼染色与高亮批注是 DOM 覆盖层(multiply),按同一坐标与颜色补画。
 *
 * 几何部分(planSnapshot)是纯函数,进 node 单测;DOM 采集与绘制在
 * PdfViewer 的注册回调里。
 */

export interface SnapshotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SnapshotAnnotation {
  kind: "highlight" | "note";
  /** 整页比例坐标(见 pdfAnnotations.NormRect)。 */
  rects: { x: number; y: number; w: number; h: number }[];
}

export interface SnapshotPage {
  /** 显示窗口(.pdf-page):设了「显示范围」时就是裁剪后的矩形。 */
  box: SnapshotRect;
  /** 整页(.pdf-page-full):canvas 与批注坐标的基准。 */
  full: SnapshotRect;
  /** canvas 物理像素宽度;0 = 这一页还没渲染。 */
  pixels: number;
  annotations: SnapshotAnnotation[];
}

export interface PlannedPage {
  /** SnapshotPage[] 的下标。 */
  page: number;
  /** 源矩形(canvas 物理像素)。 */
  src: SnapshotRect;
  /** 目标矩形(输出画布像素)。 */
  dest: SnapshotRect;
  /** 整页在输出画布里的像素矩形(批注按它换算)。 */
  sheet: SnapshotRect;
  annotations: SnapshotAnnotation[];
}

export interface SnapshotPlan {
  width: number;
  height: number;
  /** 可见页共用的 DPR(canvas 像素 / CSS 像素)。 */
  scale: number;
  /** 输出左上角在视口坐标系里的位置。 */
  origin: { left: number; top: number };
  pages: PlannedPage[];
}

export interface SnapshotColors {
  /** 滚动区底色:页间空隙与页面外的视口底色。 */
  background: string;
  /** 纸面底色;pdf.js 自己铺白,这层只盖住取整留下的缝。 */
  paper: string;
  /** 护眼染色;null = 没开护眼。 */
  tint: string | null;
  highlight: string;
  note: string;
}

/** 比这更窄/更矮的可见碎片忽略(视口边缘的一两个像素不算内容)。 */
export const MIN_VISIBLE_FRAGMENT = 2;

/** DOM 元素的视口矩形 → SnapshotRect。 */
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
 * 视口 + 每页几何 → 取景与逐页搬运计划。返回 null 的两种情况:
 *   1. 没有任何页面与视口相交(没打开文档 / 全在视口外);
 *   2. 有页面可见但它的 canvas 还是 0 宽(刚跳页、刚缩放,渲染没完成)。
 * 调用方据此重试下一帧。
 */
export function planSnapshot(
  viewport: SnapshotRect,
  pages: SnapshotPage[],
): SnapshotPlan | null {
  const visible: VisiblePage[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.full.width <= 0 || page.full.height <= 0) continue;
    const frag = intersectRect(page.box, viewport);
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

  // 横向只取页面列:目录栏与批注留白都在页面矩形之外。
  const left = Math.max(
    viewport.left,
    Math.min(...visible.map((v) => v.page.box.left)),
  );
  const right = Math.min(
    viewport.left + viewport.width,
    Math.max(...visible.map((v) => v.page.box.left + v.page.box.width)),
  );
  // 纵向同时裁掉视口外的部分与页面外的底色(顶部/底部留白、短文档的空白)。
  const top = Math.max(
    viewport.top,
    Math.min(...visible.map((v) => v.page.box.top)),
  );
  const bottom = Math.min(
    viewport.top + viewport.height,
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

/** 按计划把页面画布搬进输出画布;页面、批注、护眼染色的顺序与 DOM 一致。 */
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
 * 当前挂载的阅读器提供的截图入口。PdfViewer 在挂载/批注/护眼变化时注册,
 * 卸载时注销;命令层只调 capturePdfSnapshot。
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
