/**
 * 代码项目文件树的宽度模型。
 *
 * 宽度以像素存进设置(`codeTreeWidth`),编辑器吃剩余宽度;文件树最多占
 * 代码面板的 60%,最少 120px。窗口/中栏变窄时由 CSS 的 clamp 压缩显示,
 * **不回写偏好**——与学习模式三栏、项目视图同一套纪律。
 */

export const TREE_MIN_WIDTH = 120;
export const TREE_DEFAULT_WIDTH = 190;
/** 文件树最多占代码面板的比例(编辑器至少留 40%)。 */
export const TREE_MAX_RATIO = 0.6;

/** 持久化宽度归一:坏数据(非数、负数、NaN)回落默认值;上下界交给拖动与 CSS。 */
export function normalizeTreeWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : TREE_DEFAULT_WIDTH;
}

/** 拖动时把宽度夹进「至少 120px、至多面板的 60%」。 */
export function clampTreeWidth(width: number, paneWidth: number): number {
  const max = Math.max(TREE_MIN_WIDTH, Math.round(Math.max(0, paneWidth) * TREE_MAX_RATIO));
  return Math.round(Math.min(Math.max(TREE_MIN_WIDTH, width), max));
}
