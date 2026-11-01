/**
 * 打字机模式的光标纵向位置模型。
 *
 * `position` 是光标行中心落在视口高度的比例：0.5 = 垂直居中，小于 0.5 靠上
 * （下方留出更多还没读的内容），大于 0.5 靠下。滚动容器的上下留白由同一个
 * 比例推出来（上 p、下 1-p），首行与末行才都能停在这个高度——只留上边距的话，
 * 末行永远停在底部，「靠上」就只在文档中段可见。
 */

export const DEFAULT_TYPEWRITER_POSITION = 0.5;
export const MIN_TYPEWRITER_POSITION = 0.2;
export const MAX_TYPEWRITER_POSITION = 0.8;

/** 设置值可能是旧配置 / 手改 JSON：夹进 [20%, 80%]，按 1% 取整。 */
export function normalizeTypewriterPosition(value: unknown): number {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_TYPEWRITER_POSITION;
  return Math.min(
    MAX_TYPEWRITER_POSITION,
    Math.max(MIN_TYPEWRITER_POSITION, Math.round(raw * 100) / 100),
  );
}

/**
 * 滚动容器的上下留白（px）。光标行中心要落在 `position` 高度上，留白就要
 * 扣掉半行行高：首行中心 = 上留白 + 半行；末行中心 = 视口高 - 下留白 - 半行，
 * 两处都恰好等于 `position × 视口高`。
 *
 * `reserveTop = false` 时上留白为 0：**第一行始终钉在顶部**，光标行在上面
 * 几屏时不再为了居中把首行拉下来，而是让光标自己在屏幕上往上走（代码区用；
 * 笔记正文仍留上白，首行也能停在设定高度）。下留白照旧，末行仍能停到目标高度。
 */
export function typewriterReserve(
  clientHeight: number,
  lineHeight: number,
  position: number,
  reserveTop = true,
): { top: number; bottom: number } {
  const ratio = normalizeTypewriterPosition(position);
  const height = Math.max(0, clientHeight);
  const line = Math.max(0, lineHeight);
  return {
    top: reserveTop ? Math.max(0, Math.round(ratio * height - line / 2)) : 0,
    bottom: Math.max(0, Math.round((1 - ratio) * height - line / 2)),
  };
}

/** 把光标行中心推到目标高度所需的 scrollTop 增量（正值向下滚）。 */
export function typewriterScrollDelta(
  caretCenter: number,
  clientHeight: number,
  position: number,
): number {
  return caretCenter - Math.max(0, clientHeight) * normalizeTypewriterPosition(position);
}
