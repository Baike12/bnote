/**
 * Study-mode column model.
 *
 * 布局是三栏:助手 | 内容 | 笔记(见 StudyLayout)。助手栏与中栏的宽度都以
 * **像素**保存(`studyAgentWidth` / `studyContentWidth`),笔记栏吃剩余宽度。
 * 这样拖动窗口边缘时,助手栏与中栏都不变——PDF 页面尺寸、纵向能看到多少
 * 内容都不会跟着窗口抖。窗口窄到放不下时,由 CSS 的 clamp 压缩,而不回写
 * 偏好。
 *
 * 拖分栏线只动**相邻的两栏**:宽度在相邻两栏之间转移,不相邻的那栏原地不动
 * (拖 助手|内容 不牵动笔记栏;拖 内容|笔记 不牵动助手栏)。每栏最小宽度是
 * 布局宽度的 10%,相邻栏到界时把分隔线顶住。
 *
 * 旧配置把三栏宽度存成 `studySplit: [agent, content]`(更早是比例),
 * `normalizeContentWidth` 在加载时把旧值换算成中栏像素宽度,一次性迁移。
 */

/** 每栏最小宽度占布局宽度的比例。 */
export const MIN_COLUMN_RATIO = 0.1;
/** 分栏线宽度(布局宽度),与 global.css 的 .study-resizer 一致;命中区由
 *  ::after 向两侧扩展,不占布局。 */
export const RESIZER_WIDTH = 1;

export const DEFAULT_CONTENT_WIDTH = 620;
/** 助手栏默认宽度(与旧三栏配置的 [agent, content] 首值一致)。 */
export const DEFAULT_AGENT_WIDTH = 320;

/** PDF 页面上方的留白(.pdf-pages padding-top)。 */
export const PAGE_TOP_PAD = 14;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/** 每栏最小宽度(像素):布局宽度的 10%。 */
export function minColumnWidth(hostWidth: number): number {
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) return 0;
  return Math.round(hostWidth * MIN_COLUMN_RATIO);
}

/**
 * 把持久化的中栏宽度归一成像素。
 *
 * - 旧配置的比例形式(值在 0..1)按 `viewportWidth` 换算;
 * - 像素原样使用,只夹下限(下限 = 布局宽度的 10%,与拖动时一致;上限交给
 *   CSS,窗口变窄时压缩显示而不改偏好);
 * - 坏数据回落默认值。
 */
export function normalizeContentWidth(value: unknown, viewportWidth: number): number {
  const floor = minColumnWidth(viewportWidth);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTENT_WIDTH;
  }
  if (value < 1) {
    if (!(Number.isFinite(viewportWidth) && viewportWidth > 0)) {
      return DEFAULT_CONTENT_WIDTH;
    }
    return Math.round(Math.max(floor, value * viewportWidth));
  }
  return Math.round(Math.max(floor, value));
}

/** 助手栏宽度归一:像素,只夹下限(下限同上,上限交给 CSS)。 */
export function normalizeAgentWidth(value: unknown, viewportWidth: number): number {
  const floor = minColumnWidth(viewportWidth);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_AGENT_WIDTH;
  }
  return Math.round(Math.max(floor, value));
}

/**
 * 旧配置 `studySplit` → 新配置 `studyContentWidth`。
 *
 * 旧数组是 `[agent, content]`(像素或比例),中栏宽度取第 2 个元素;
 * 单值(已是新配置)原样归一。返回 null 表示没有可迁移的值。
 */
export function studySplitToContentWidth(split: unknown): number | null {
  if (Array.isArray(split)) {
    return split.length === 2 && typeof split[1] === "number" ? split[1] : null;
  }
  return typeof split === "number" ? split : null;
}

/** 三栏宽度(像素)。 */
export interface ColumnWidths {
  /** 助手栏。 */
  agent: number;
  /** 中栏(内容)。 */
  content: number;
  /** 右栏(笔记)。 */
  right: number;
}

/**
 * 拖动 助手|内容 分隔线:宽度在相邻的助手栏与中栏之间转移,笔记栏原地不动。
 *
 * `x` 是分隔线右缘相对布局左缘的坐标(= 中栏左缘);`sum` 是这两栏当前的
 * 总宽度(助手 + 中栏)——拖动时它不变,所以笔记栏的宽度也就不变。
 *
 * 指针的位置就是列的边界:助手栏宽 = x − 线宽,中栏宽 = sum − 助手栏宽。
 * 相邻栏的最小宽度是布局宽度的 10%,先到界的那个把线顶住。
 */
export function dragAgentEdge(
  x: number,
  hostWidth: number,
  sum: number,
): ColumnWidths {
  const min = minColumnWidth(hostWidth);
  // 助手栏到 10% → 线右缘最靠左;中栏到 10% → 线右缘最靠右。
  const lo = min + RESIZER_WIDTH;
  const hi = sum + RESIZER_WIDTH - min;
  const edge = lo <= hi ? clamp(x, lo, hi) : (lo + hi) / 2;
  const agent = edge - RESIZER_WIDTH;
  return {
    agent: Math.round(agent),
    content: Math.round(sum - agent),
    right: Math.round(hostWidth - RESIZER_WIDTH * 2 - sum),
  };
}

/**
 * 拖动 内容|笔记 分隔线:宽度在相邻的中栏与笔记栏之间转移,助手栏原地不动。
 *
 * `x` 是分隔线右缘相对布局左缘的坐标(= 笔记栏左缘);`contentLeft` 是中栏
 * 左缘(拖动时不动——线只在中栏与笔记栏之间移动)。
 *
 * 相邻栏的最小宽度是布局宽度的 10%,先到界的那个把线顶住。
 */
export function dragContentEdge(
  x: number,
  hostWidth: number,
  contentLeft = 0,
): { content: number; right: number } {
  const min = minColumnWidth(hostWidth);
  const lo = contentLeft + RESIZER_WIDTH + min; // 中栏到 10%
  const hi = hostWidth - min; // 笔记栏到 10%
  const edge = lo <= hi ? clamp(x, lo, hi) : (lo + hi) / 2;
  const content = edge - contentLeft - RESIZER_WIDTH;
  return {
    content: Math.round(content),
    right: Math.round(hostWidth - edge),
  };
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
