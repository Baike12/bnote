import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_WIDTH,
  DEFAULT_CONTENT_WIDTH,
  MIN_AGENT_WIDTH,
  MIN_CONTENT_WIDTH,
  MIN_NOTES_WIDTH,
  RESIZER_WIDTH,
  basePageWidth,
  contentWidthForRenderedPage,
  dragAgentEdge,
  dragContentEdge,
  normalizeSplit,
} from "./layoutModel";

describe("normalizeSplit", () => {
  it("旧配置的比例按窗口宽度换算成像素", () => {
    expect(normalizeSplit([0.24, 0.44], 1400)).toEqual([336, 616]);
  });

  it("像素宽度原样保留,只夹下限", () => {
    expect(normalizeSplit([700, 900], 1400)).toEqual([700, 900]);
    expect(normalizeSplit([10, 20], 1400)).toEqual([MIN_AGENT_WIDTH, MIN_CONTENT_WIDTH]);
  });

  it("坏数据回落默认值", () => {
    expect(normalizeSplit(null, 1400)).toEqual([DEFAULT_AGENT_WIDTH, DEFAULT_CONTENT_WIDTH]);
    expect(normalizeSplit([NaN, 400], 1400)).toEqual([
      DEFAULT_AGENT_WIDTH,
      DEFAULT_CONTENT_WIDTH,
    ]);
    expect(normalizeSplit([0, 0], 1400)).toEqual([DEFAULT_AGENT_WIDTH, DEFAULT_CONTENT_WIDTH]);
  });
});

describe("dragAgentEdge", () => {
  it("拖动只在中|左两栏之间重新分配,两栏之和不变", () => {
    const [agent, content] = dragAgentEdge(500, 300, 700);
    expect(agent).toBe(500);
    expect(agent + content).toBe(1000);
  });

  it("两侧都留出最小宽度", () => {
    expect(dragAgentEdge(10, 300, 700)).toEqual([MIN_AGENT_WIDTH, 1000 - MIN_AGENT_WIDTH]);
    expect(dragAgentEdge(5000, 300, 700)).toEqual([1000 - MIN_CONTENT_WIDTH, MIN_CONTENT_WIDTH]);
  });
});

describe("dragContentEdge", () => {
  it("Agent 展开时,内容栏宽度扣掉左栏和分隔条", () => {
    expect(dragContentEdge(300 + RESIZER_WIDTH + 500, 300, 1400, true)).toBe(500);
  });

  it("Agent 收起时只有一个分隔条", () => {
    expect(dragContentEdge(RESIZER_WIDTH + 500, 0, 1400, false)).toBe(500);
  });

  it("给笔记栏留够最小宽度", () => {
    const host = 1200;
    const agent = 300;
    const content = dragContentEdge(1190, agent, host, true);
    expect(content).toBe(host - agent - RESIZER_WIDTH * 2 - MIN_NOTES_WIDTH);
    expect(host - agent - RESIZER_WIDTH * 2 - content).toBe(MIN_NOTES_WIDTH);
  });
});

describe("basePageWidth", () => {
  it("没有裁剪时就是栏宽", () => {
    expect(basePageWidth(620, 1)).toBe(620);
    expect(basePageWidth(620, 0)).toBe(620);
  });

  it("裁掉一半宽度时,完整页面放大一倍才能让可见部分贴边", () => {
    expect(basePageWidth(620, 0.5)).toBe(1240);
    expect(basePageWidth(620, 0.8)).toBeCloseTo(775, 5);
  });

  it("栏宽无效时返回 0", () => {
    expect(basePageWidth(0, 0.5)).toBe(0);
  });
});

describe("contentWidthForRenderedPage", () => {
  const base = {
    contentWidth: 620,
    pageWidth: 610,
    pageHeight: 610 * Math.SQRT2,
    availableHeight: 630,
    pageRatio: Math.SQRT2,
    cropHeight: 1,
    cropWidth: 1,
    minPageWidth: 220,
    maxPageWidth: 1600,
  };

  it("按真实页面高度差折算宽度,一页刚好完整显示", () => {
    const width = contentWidthForRenderedPage(base) as number;
    const fittedPage = base.pageWidth + (width - base.contentWidth);
    // 宽度取整,高度误差不超过 1px。
    expect(Math.abs(fittedPage * base.pageRatio - base.availableHeight)).toBeLessThanOrEqual(1);
  });

  it("裁掉一半页面时,同样的高度差需要两倍宽度", () => {
    const full = contentWidthForRenderedPage(base) as number;
    const cropped = contentWidthForRenderedPage({ ...base, cropHeight: 0.5 }) as number;
    const fullDelta = full - base.contentWidth;
    const cropDelta = cropped - base.contentWidth;
    expect(Math.abs(cropDelta - fullDelta * 2)).toBeLessThanOrEqual(1);
  });

  it("裁掉左右留白时,中栏只承担可见宽度那一份", () => {
    // 页面按 1/0.8 放大,完整页面宽度变化 1px 只对应中栏 0.8px。
    const pageWidth = base.pageWidth / 0.8;
    const pageHeight = pageWidth * base.pageRatio;
    const target = contentWidthForRenderedPage({
      ...base,
      pageWidth,
      pageHeight,
      cropWidth: 0.8,
    }) as number;
    const fittedPage = pageWidth + (target - base.contentWidth) / 0.8;
    expect(Math.abs(fittedPage * base.pageRatio - base.availableHeight)).toBeLessThanOrEqual(1);
  });

  it("页面宽度卡在上下限时,中栏不再继续变宽", () => {
    const maxed = contentWidthForRenderedPage({
      ...base,
      pageWidth: 1600,
      pageHeight: 100,
      availableHeight: 900,
    }) as number;
    expect(maxed).toBe(base.contentWidth);
    const mined = contentWidthForRenderedPage({
      ...base,
      pageWidth: 220,
      pageHeight: 3000,
      availableHeight: 600,
    }) as number;
    expect(mined).toBe(base.contentWidth);
  });

  it("几何没准备好时返回 null", () => {
    expect(contentWidthForRenderedPage({ ...base, pageHeight: 0 })).toBeNull();
    expect(contentWidthForRenderedPage({ ...base, availableHeight: 0 })).toBeNull();
    expect(contentWidthForRenderedPage({ ...base, pageRatio: 0 })).toBeNull();
  });
});
