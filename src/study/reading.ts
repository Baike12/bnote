/**
 * 学习模式翻页的几何模型。
 *
 * PDF 与网页阅读器共用同一个步长：每次 PageUp/PageDown 移动「可见高度 ×
 * 步长」。默认 50% 时，翻页后上一屏的下半部分刚好停在屏幕中央——眼睛留在
 * 中下区域就能接上新内容，不必每次都抬头看屏幕顶部。
 */

export const DEFAULT_PAGE_STEP = 0.5;
export const MIN_PAGE_STEP = 0.1;
export const MAX_PAGE_STEP = 1;

/** 设置值可能是旧配置/手改 JSON：夹进 [10%, 100%]，按 1% 取整。
 *
 *  这个函数会被 `webAnnotations.ts` 序列化进网页运行时，所以函数体不能
 *  引用模块常量（页面里不存在）——范围与默认值写成字面量。 */
export function normalizePageStep(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(1, Math.max(0.1, rounded));
}

/**
 * 从当前位置走一步，端点夹紧（第一屏不越过顶部，最后一屏不越过底部）。
 * `viewport` 是可见高度，`content` 是滚动内容总高度。
 */
export function steppedScrollTop(
  current: number,
  viewport: number,
  content: number,
  delta: 1 | -1,
  step: number,
): number {
  const max = Math.max(0, content - viewport);
  const distance = Math.max(1, Math.round(Math.max(0, viewport) * normalizePageStep(step)));
  return Math.min(max, Math.max(0, current + delta * distance));
}
