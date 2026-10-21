/**
 * PDF 阅读器的「显示范围」。
 *
 * 框选出来的是一块**归一化**矩形(0..1),不是像素:每页的尺寸不一定相同,
 * 只有比例才能让同一个框原样套到每一页上——翻页时看到的始终是同一段版面。
 */
export interface PdfCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 比这更小的框按误触处理(单击、手抖),不当作裁剪。 */
export const MIN_CROP_SIZE = 0.04;
/** 几乎盖满整页的框等于没裁——存下来只会让每页白掉一圈。 */
const FULL_CROP = 0.995;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 一次框选(起点/终点都在页内,归一化比例)→ 裁剪框。
 * 方向任意(从右下往左上拖也一样);太小的框返回 null。
 */
export function cropFromDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): PdfCrop | null {
  if (![startX, startY, endX, endY].every((v) => Number.isFinite(v))) return null;
  const x0 = clamp01(Math.min(startX, endX));
  const y0 = clamp01(Math.min(startY, endY));
  const w = clamp01(Math.max(startX, endX)) - x0;
  const h = clamp01(Math.max(startY, endY)) - y0;
  if (w < MIN_CROP_SIZE || h < MIN_CROP_SIZE) return null;
  if (w >= FULL_CROP && h >= FULL_CROP) return null;
  return { x: x0, y: y0, w, h };
}

/** 从磁盘/旧版本读回来的值:形状不对、越界、太小都退回「整页」。 */
export function normalizeCrop(raw: unknown): PdfCrop | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, w, h } = raw as Record<string, unknown>;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof w !== "number" || !Number.isFinite(w)) return null;
  if (typeof h !== "number" || !Number.isFinite(h)) return null;
  const left = clamp01(x);
  const top = clamp01(y);
  const width = Math.min(Math.max(0, w), 1 - left);
  const height = Math.min(Math.max(0, h), 1 - top);
  if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) return null;
  if (width >= FULL_CROP && height >= FULL_CROP) return null;
  return { x: left, y: top, w: width, h: height };
}

/** 每份 PDF 各记一个裁剪框;键是 vault 内的绝对路径。 */
const STORAGE_PREFIX = "bnote.pdfCrop:";

export function loadPdfCrop(path: string): PdfCrop | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + path);
    return raw ? normalizeCrop(JSON.parse(raw)) : null;
  } catch {
    // 没有 localStorage(测试/受限环境)或坏数据:退回整页。
    return null;
  }
}

export function savePdfCrop(path: string, crop: PdfCrop | null): void {
  try {
    if (crop) localStorage.setItem(STORAGE_PREFIX + path, JSON.stringify(crop));
    else localStorage.removeItem(STORAGE_PREFIX + path);
  } catch {
    // 存不下只损失下次打开的还原,本次显示不受影响。
  }
}
