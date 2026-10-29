/**
 * 项目视图三栏宽度模型。
 *
 * 三栏 = 项目导航 | 项目看板 | 日记。左栏与日记栏的宽度按**像素**存进
 * settings(`projectsSideWidth` / `projectsDailyWidth`),看板吃剩余宽度:
 * 拖窗口边缘只改看板,导航与日记不变——日记的换行宽度、看板里能放下几列
 * 都不会跟着窗口抖。窗口窄到放不下时由 CSS 的 clamp 压缩显示,不回写偏好。
 *
 * 拖分栏线只动**相邻的两栏**:宽度在相邻两栏之间转移,不相邻的那栏原地不动
 * (拖 导航|看板 不牵动日记;拖 看板|日记 不牵动导航)。每栏最小宽度是布局
 * 宽度的 10%;看板另有像素下限——低于它连一行待办都排不下。
 */

/** 项目导航默认宽度。 */
export const DEFAULT_SIDE_WIDTH = 232;
/** 日记栏默认宽度。 */
export const DEFAULT_DAILY_WIDTH = 420;
/** 每栏最小宽度占布局宽度的比例(与学习模式三栏一致)。 */
export const MIN_COLUMN_RATIO = 0.1;
/** 看板(中栏)最小像素宽度:低于它一列待办都排不下。 */
export const MIN_CENTER_WIDTH = 300;
/** 分栏线宽度(布局宽度),与 global.css 的 .projects-resizer 一致。 */
export const RESIZER_WIDTH = 1;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/** 每栏最小宽度(像素):布局宽度的 10%。 */
export function minColumnWidth(hostWidth: number): number {
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) return 0;
  return Math.round(hostWidth * MIN_COLUMN_RATIO);
}

/**
 * 拖动 导航|看板 分隔线:改导航宽度,日记不动。
 *
 * `edgeX` 是分隔线右缘相对布局左缘的坐标(= 看板左缘 = 导航栏右缘 + 线宽);
 * 左栏到 10% 时线最靠左,看板到 `MIN_CENTER_WIDTH` 时线最靠右。
 */
export function dragSideEdge(edgeX: number, hostWidth: number, dailyWidth: number): number {
  const min = minColumnWidth(hostWidth);
  const lo = min + RESIZER_WIDTH;
  const hi = hostWidth - dailyWidth - RESIZER_WIDTH - MIN_CENTER_WIDTH;
  const x = clamp(edgeX, lo, hi);
  return Math.round(x - RESIZER_WIDTH);
}

/**
 * 拖动 看板|日记 分隔线:改日记宽度,导航不动。
 *
 * `edgeX` 是分隔线右缘相对布局左缘的坐标(= 日记栏左缘);日记栏到 10% 时线
 * 最靠右,看板到 `MIN_CENTER_WIDTH` 时线最靠左。
 */
export function dragDailyEdge(edgeX: number, hostWidth: number, sideWidth: number): number {
  const min = minColumnWidth(hostWidth);
  const lo = sideWidth + RESIZER_WIDTH * 2 + MIN_CENTER_WIDTH;
  const hi = hostWidth - min;
  return Math.round(hostWidth - clamp(edgeX, lo, hi));
}

/**
 * 持久化宽度归一:坏数据(非数、负数、NaN)回落默认值。
 *
 * 上下界交给拖动时的 `dragSideEdge` / `dragDailyEdge` 与 CSS 的 clamp——
 * 加载时量不到布局宽度,在这里猜一个只会把用户的偏好改坏。
 */
export function normalizeSideWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_SIDE_WIDTH;
}

export function normalizeDailyWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_DAILY_WIDTH;
}
