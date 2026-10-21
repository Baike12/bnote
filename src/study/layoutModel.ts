/**
 * Study-mode column model.
 *
 * 左(Agent)、中(内容)两栏的宽度以**像素**保存,右(笔记)吃剩余宽度。
 * 这样拖动窗口边缘时,中栏宽度不变——PDF 页面尺寸、纵向能看到多少内容都
 * 不会跟着窗口抖。窗口窄到放不下时,由 CSS 的 clamp 依次压缩中栏、左栏,
 * 而不回写偏好。
 *
 * 旧配置存的是占可用宽度的比例(两个数都 < 1),`normalizeSplit` 在加载时
 * 用当时的窗口宽度换算成像素,一次性迁移。
 */

export const MIN_AGENT_WIDTH = 220;
export const MIN_CONTENT_WIDTH = 260;
export const MIN_NOTES_WIDTH = 220;
/** 分隔条命中区宽度,与 global.css 的 .study-resizer 一致。 */
export const RESIZER_WIDTH = 8;

export const DEFAULT_AGENT_WIDTH = 320;
export const DEFAULT_CONTENT_WIDTH = 620;

/** PDF 页面上方的留白(.pdf-pages padding-top)。 */
export const PAGE_TOP_PAD = 14;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 把持久化的 `studySplit` 归一成像素宽度 `[agent, content]`。
 *
 * - 旧配置的比例形式(两个数都在 0..1)按 `viewportWidth` 换算;
 * - 像素形式原样使用;
 * - 坏数据回落默认值。
 */
export function normalizeSplit(split: unknown, viewportWidth: number): [number, number] {
  if (!Array.isArray(split) || split.length !== 2) {
    return [DEFAULT_AGENT_WIDTH, DEFAULT_CONTENT_WIDTH];
  }
  const rawAgent = finitePositive(split[0]);
  const rawContent = finitePositive(split[1]);
  if (rawAgent === null || rawContent === null) {
    return [DEFAULT_AGENT_WIDTH, DEFAULT_CONTENT_WIDTH];
  }
  const legacy = rawAgent < 1 && rawContent < 1;
  if (legacy) {
    if (!(Number.isFinite(viewportWidth) && viewportWidth > 0)) {
      return [DEFAULT_AGENT_WIDTH, DEFAULT_CONTENT_WIDTH];
    }
    return [
      Math.round(Math.max(MIN_AGENT_WIDTH, rawAgent * viewportWidth)),
      Math.round(Math.max(MIN_CONTENT_WIDTH, rawContent * viewportWidth)),
    ];
  }
  return [
    Math.round(Math.max(MIN_AGENT_WIDTH, rawAgent)),
    Math.round(Math.max(MIN_CONTENT_WIDTH, rawContent)),
  ];
}

/**
 * 拖动 Agent|内容 分隔线:两栏之和保持不变,笔记栏不受影响。
 * `x` 是指针相对布局左缘的坐标。
 */
export function dragAgentEdge(
  x: number,
  agentWidth: number,
  contentWidth: number,
): [number, number] {
  const pair = agentWidth + contentWidth;
  const agent = Math.round(clamp(x, MIN_AGENT_WIDTH, pair - MIN_CONTENT_WIDTH));
  return [agent, Math.round(pair - agent)];
}

/**
 * 拖动 内容|笔记 分隔线:内容栏拿到指针位置,笔记栏吃剩余宽度。
 * `x` 是指针相对布局左缘的坐标;`hostWidth` 是布局宽度。
 */
export function dragContentEdge(
  x: number,
  agentWidth: number,
  hostWidth: number,
  agentOpen: boolean,
): number {
  const offset = agentOpen ? agentWidth + RESIZER_WIDTH : RESIZER_WIDTH;
  const upper = hostWidth - offset - RESIZER_WIDTH - MIN_NOTES_WIDTH;
  return Math.round(clamp(x - offset, MIN_CONTENT_WIDTH, upper));
}

/**
 * 100% 缩放下页面的完整宽度。
 *
 * 框选后屏幕上只剩裁出来的那一块;100% 应当让「看得见的这块」正好贴住中栏
 * 边框,所以完整页面要按裁剪宽度等比放大(`fitWidth / cropWidth`)。没有裁剪
 * 时就是栏宽本身(页面贴边)。
 */
export function basePageWidth(fitWidth: number, cropWidth: number): number {
  if (!(fitWidth > 0)) return 0;
  const visible = cropWidth > 0 && cropWidth <= 1 ? cropWidth : 1;
  return fitWidth / visible;
}

export interface RenderedPageFitInput {
  /** 当前中栏宽度(实际显示值)。 */
  contentWidth: number;
  /** 当前页面的完整宽度(缩放后,未裁剪)。 */
  pageWidth: number;
  /** 当前页面实际占的高度(裁剪后)。 */
  pageHeight: number;
  /** 视口里留给一页的高度(滚动区高度减去顶部留白)。 */
  availableHeight: number;
  /** 页高 / 页宽(第一页)。 */
  pageRatio: number;
  /** 显示范围占整页高度的比例;1 = 整页。 */
  cropHeight: number;
  /** 显示范围占整页宽度的比例;1 = 不裁宽度。 */
  cropWidth: number;
  minPageWidth: number;
  maxPageWidth: number;
}

/**
 * 让一页刚好完整落在视口里的中栏宽度。
 *
 * 用已经渲染出来的页面尺寸反推:页面高度随宽度线性变化,差多少高度就折算成
 * 多少宽度。这样不依赖"滚动条占几像素"这类假设——量到的就是真实布局。
 *
 * 框选后完整页面按 `1 / cropWidth` 放大(见 basePageWidth),所以中栏宽度变化
 * 1px,页面完整宽度变化 `1 / cropWidth` px:折算回中栏时要乘回 `cropWidth`。
 * 返回 `null` 表示几何还没准备好(页面/视口尺寸为 0),此时不该改布局。
 */
export function contentWidthForRenderedPage(input: RenderedPageFitInput): number | null {
  const {
    contentWidth,
    pageWidth,
    pageHeight,
    availableHeight,
    pageRatio,
    cropHeight,
    cropWidth,
    minPageWidth,
    maxPageWidth,
  } = input;
  if (
    !(contentWidth > 0) ||
    !(pageWidth > 0) ||
    !(pageHeight > 0) ||
    !(availableHeight > 0) ||
    !(pageRatio > 0)
  ) {
    return null;
  }
  const heightRatio = pageRatio * (cropHeight > 0 ? cropHeight : 1);
  const visibleWidth = cropWidth > 0 && cropWidth <= 1 ? cropWidth : 1;
  const delta = (availableHeight - pageHeight) / heightRatio;
  const fittedPageWidth = clamp(pageWidth + delta, minPageWidth, maxPageWidth);
  return Math.round(contentWidth + (fittedPageWidth - pageWidth) * visibleWidth);
}
