/**
 * PDF 阅读器左栏(书签/目录)的宽度。
 *
 * 用像素而不是比例:书签是相对窗口的固定 UI,翻页、换文件都该保持同一个宽度;
 * 比例模型会在窄栏里被压缩。
 */
export const DEFAULT_OUTLINE_WIDTH = 210;
export const MIN_OUTLINE_WIDTH = 140;
export const MAX_OUTLINE_WIDTH = 480;
/** 拖动时至少给 PDF 页面留出的宽度。 */
export const MIN_PAGE_AREA = 260;

/** 右侧批注留白:常用面板宽度下占 30%,夹在 [170, 340];面板太窄就不留。 */
export const MIN_NOTES_RAIL = 170;
export const MAX_NOTES_RAIL = 340;

export function notesRailWidth(panelWidth: number): number {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return 0;
  const available = panelWidth - MIN_PAGE_AREA;
  // 留白至少 150px 才放得下批注卡;再窄就把整块空间还给页面。
  if (available < 150) return 0;
  const preferred = Math.round(panelWidth * 0.3);
  return Math.round(
    Math.min(MAX_NOTES_RAIL, available, Math.max(MIN_NOTES_RAIL, preferred)),
  );
}

/** 夹进 [MIN_OUTLINE_WIDTH, min(MAX_OUTLINE_WIDTH, bodyWidth - MIN_PAGE_AREA)]。 */
export function clampOutlineWidth(width: number, bodyWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_OUTLINE_WIDTH;
  const upper = Math.max(
    MIN_OUTLINE_WIDTH,
    Math.min(MAX_OUTLINE_WIDTH, bodyWidth - MIN_PAGE_AREA),
  );
  return Math.round(Math.min(Math.max(width, MIN_OUTLINE_WIDTH), upper));
}

const STORAGE_KEY = "bnote.pdfOutlineWidth";

export function loadOutlineWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const width = raw === null ? NaN : Number(raw);
    return Number.isFinite(width)
      ? clampOutlineWidth(width, Number.MAX_SAFE_INTEGER)
      : DEFAULT_OUTLINE_WIDTH;
  } catch {
    return DEFAULT_OUTLINE_WIDTH;
  }
}

export function saveOutlineWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // 存不下只损失下次打开的宽度。
  }
}
