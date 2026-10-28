import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_WIDTH,
  DEFAULT_CONTENT_WIDTH,
  RESIZER_WIDTH,
  basePageWidth,
  contentWidthForRenderedPage,
  dragAgentEdge,
  dragContentEdge,
  minColumnWidth,
  normalizeAgentWidth,
  normalizeContentWidth,
  studySplitToContentWidth,
} from "./layoutModel";

describe("normalizeContentWidth", () => {
  it("旧配置的比例按窗口宽度换算成像素", () => {
    expect(normalizeContentWidth(0.44, 1400)).toBe(616);
  });

  it("像素宽度原样保留,只夹下限(布局宽度的 10%)", () => {
    expect(normalizeContentWidth(900, 1400)).toBe(900);
    expect(normalizeContentWidth(20, 1400)).toBe(minColumnWidth(1400));
  });

  it("坏数据回落默认值", () => {
    expect(normalizeContentWidth(null, 1400)).toBe(DEFAULT_CONTENT_WIDTH);
    expect(normalizeContentWidth(NaN, 1400)).toBe(DEFAULT_CONTENT_WIDTH);
    expect(normalizeContentWidth(0, 1400)).toBe(DEFAULT_CONTENT_WIDTH);
  });
});

describe("studySplitToContentWidth", () => {
  it("旧三栏数组取中栏宽度(第 2 个元素)", () => {
    expect(studySplitToContentWidth([320, 620])).toBe(620);
    expect(studySplitToContentWidth([0.24, 0.44])).toBeCloseTo(0.44, 10);
  });

  it("单值(已是新配置)原样返回", () => {
    expect(studySplitToContentWidth(620)).toBe(620);
  });

  it("没有可迁移的值时返回 null", () => {
    expect(studySplitToContentWidth(undefined)).toBeNull();
    expect(studySplitToContentWidth([320])).toBeNull();
    expect(studySplitToContentWidth([320, "x"] as unknown)).toBeNull();
  });
});

describe("normalizeAgentWidth", () => {
  it("像素原样保留,只夹下限(布局宽度的 10%)", () => {
    expect(normalizeAgentWidth(360, 1400)).toBe(360);
    expect(normalizeAgentWidth(20, 1400)).toBe(minColumnWidth(1400));
  });

  it("坏数据回落默认值", () => {
    expect(normalizeAgentWidth(undefined, 1400)).toBe(DEFAULT_AGENT_WIDTH);
    expect(normalizeAgentWidth(NaN, 1400)).toBe(DEFAULT_AGENT_WIDTH);
    expect(normalizeAgentWidth(0, 1400)).toBe(DEFAULT_AGENT_WIDTH);
  });
});

describe("minColumnWidth", () => {
  it("每栏最小宽度是布局宽度的 10%", () => {
    expect(minColumnWidth(1400)).toBe(140);
    expect(minColumnWidth(900)).toBe(90);
  });

  it("宽度无效时返回 0", () => {
    expect(minColumnWidth(0)).toBe(0);
    expect(minColumnWidth(NaN)).toBe(0);
  });
});

describe("dragAgentEdge(助手|内容:只动相邻两栏)", () => {
  const host = 1400;
  const sum = 320 + 620; // 助手 + 中栏
  const min = minColumnWidth(host);

  it("宽度在助手与中栏之间转移,笔记栏原地不动", () => {
    const widths = dragAgentEdge(RESIZER_WIDTH + 400, host, sum);
    expect(widths.agent).toBe(400);
    expect(widths.content).toBe(sum - 400);
    // 两栏总宽不变 → 笔记栏的宽度不变。
    expect(widths.agent + widths.content).toBe(sum);
    expect(widths.right).toBe(host - RESIZER_WIDTH * 2 - sum);
  });

  it("线往左拖:中栏变宽,助手栏收窄", () => {
    const widths = dragAgentEdge(RESIZER_WIDTH + 200, host, sum);
    expect(widths.agent).toBe(200);
    expect(widths.content).toBe(sum - 200);
    expect(widths.right).toBe(host - RESIZER_WIDTH * 2 - sum);
  });

  it("助手栏到 10% 就顶住", () => {
    const widths = dragAgentEdge(0, host, sum);
    expect(widths.agent).toBe(min);
    expect(widths.content).toBe(sum - min);
  });

  it("中栏到 10% 就顶住", () => {
    const widths = dragAgentEdge(host, host, sum);
    expect(widths.content).toBe(min);
    expect(widths.agent).toBe(sum - min);
  });

  it("两栏都到不了 10%(窗口太窄)时取折中", () => {
    const narrow = 400;
    const widths = dragAgentEdge(0, narrow, 300);
    expect(widths.agent).toBeGreaterThan(0);
    expect(widths.content).toBeGreaterThan(0);
    expect(widths.agent + widths.content).toBe(300);
  });
});

describe("dragContentEdge(内容|笔记:只动相邻两栏)", () => {
  const host = 1400;
  const contentLeft = 320 + RESIZER_WIDTH;
  const min = minColumnWidth(host);

  it("中栏宽度 = 指针位置扣掉分隔条,右栏吃剩余", () => {
    const widths = dragContentEdge(contentLeft + RESIZER_WIDTH + 500, host, contentLeft);
    expect(widths.content).toBe(500);
    expect(widths.right).toBe(host - contentLeft - RESIZER_WIDTH - 500);
  });

  it("笔记栏到 10% 就顶住", () => {
    const widths = dragContentEdge(host, host, contentLeft);
    expect(widths.right).toBe(min);
    expect(widths.content).toBe(host - contentLeft - RESIZER_WIDTH - min);
  });

  it("中栏到 10% 就顶住", () => {
    const widths = dragContentEdge(0, host, contentLeft);
    expect(widths.content).toBe(min);
  });

  it("助手栏不受影响(只看得到中栏与笔记栏)", () => {
    const widths = dragContentEdge(contentLeft + RESIZER_WIDTH + 400, host, contentLeft);
    expect(widths.content + widths.right + contentLeft + RESIZER_WIDTH).toBe(host);
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
