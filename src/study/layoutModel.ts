/**
 * Study-mode column model.
 *
 * 布局是两栏:左(内容)+ 右(笔记 / 学习助手二选一,见 StudyLayout 的页签)。
 * 中栏宽度以**像素**保存(`studyContentWidth`),右栏吃剩余宽度。这样拖动
 * 窗口边缘时,中栏宽度不变——PDF 页面尺寸、纵向能看到多少内容都不会跟着
 * 窗口抖。窗口窄到放不下时,由 CSS 的 clamp 压缩中栏,而不回写偏好。
 *
 * 旧配置把三栏宽度存成 `studySplit: [agent, content]`(更早是比例),
 * `normalizeContentWidth` 在加载时把旧值换算成中栏像素宽度,一次性迁移。
 */

export const MIN_CONTENT_WIDTH = 260;
/** 右栏(笔记 / 学习助手)最小宽度。 */
export const MIN_RIGHT_WIDTH = 260;
/** 分栏线宽度(布局宽度),与 global.css 的 .study-resizer 一致;命中区由
 *  ::after 向两侧扩展,不占布局。 */
export const RESIZER_WIDTH = 1;

export const DEFAULT_CONTENT_WIDTH = 620;

/** PDF 页面上方的留白(.pdf-pages padding-top)。 */
export const PAGE_TOP_PAD = 14;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/**
 * 把持久化的中栏宽度归一成像素。
 *
 * - 旧配置的比例形式(值在 0..1)按 `viewportWidth` 换算;
 * - 像素原样使用,只夹下限(上限交给 CSS,窗口变窄时压缩显示而不改偏好);
 * - 坏数据回落默认值。
 */
export function normalizeContentWidth(value: unknown, viewportWidth: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTENT_WIDTH;
  }
  if (value < 1) {
    if (!(Number.isFinite(viewportWidth) && viewportWidth > 0)) {
      return DEFAULT_CONTENT_WIDTH;
    }
    return Math.round(Math.max(MIN_CONTENT_WIDTH, value * viewportWidth));
  }
  return Math.round(Math.max(MIN_CONTENT_WIDTH, value));
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

/**
 * 拖动 内容|右栏 分隔线:内容栏拿到指针位置,右栏吃剩余宽度。
 * `x` 是指针相对布局左缘的坐标;`hostWidth` 是布局宽度。
 */
export function dragContentEdge(x: number, hostWidth: number): number {
  const upper = hostWidth - RESIZER_WIDTH - MIN_RIGHT_WIDTH;
  return Math.round(clamp(x - RESIZER_WIDTH, MIN_CONTENT_WIDTH, Math.max(MIN_CONTENT_WIDTH, upper)));
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
