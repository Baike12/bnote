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

/** 一条文字行的客户区上下边（与视口同坐标系）。 */
export interface TextLineBand {
  top: number;
  bottom: number;
}

/**
 * 翻页落点微调：分界线若切在文字行内，把最近的行边对齐到分界线。
 *
 * `boundary` 是分界线在视口坐标系里的 y；`lines` 是**当前落点**下测到的
 * 文字行矩形；`tolerance` 是允许的最大调整距离（约视口高度的 2%）。
 * 只做位移，不改步长模型：调整后滚动距离最多偏离设定值 tolerance。
 * 行高大于 2×tolerance 时两边都可能超出容差，此时保持原位。
 */
export function snapScrollTopToLine(
  current: number,
  viewport: number,
  content: number,
  boundary: number,
  lines: readonly TextLineBand[],
  tolerance: number,
): number {
  if (!(tolerance > 0)) return current;
  const max = Math.max(0, content - viewport);
  let best = current;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestEdge: "top" | "bottom" = "top";
  for (const line of lines) {
    if (!(line.bottom > line.top) || !(line.bottom > boundary && line.top < boundary)) {
      continue;
    }
    const edges: Array<["top" | "bottom", number]> = [
      ["top", line.top],
      ["bottom", line.bottom],
    ];
    for (const [edge, value] of edges) {
      const delta = value - boundary;
      if (!Number.isFinite(delta) || Math.abs(delta) > tolerance) continue;
      const next = current + delta;
      // 顶到首尾就贴边；此时行边并没有真正对齐，不接受这个候选。
      if (next < 0 || next > max) continue;
      const distance = Math.abs(delta);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = next;
        bestEdge = edge;
      }
    }
  }
  if (best === current) return current;
  // 滚动位置按整像素生效：对齐上边时向下取整（行整体落在分界线下方），
  // 对齐下边时向上取整（行整体留在分界线上方），避免 0.5px 的残余切割。
  const rounded = bestEdge === "top" ? Math.floor(best) : Math.ceil(best);
  return Math.min(max, Math.max(0, rounded));
}
