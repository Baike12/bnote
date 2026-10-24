import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTENT_WIDTH,
  MIN_CONTENT_WIDTH,
  MIN_RIGHT_WIDTH,
  RESIZER_WIDTH,
  basePageWidth,
  contentWidthForRenderedPage,
  dragContentEdge,
  normalizeContentWidth,
  studySplitToContentWidth,
} from "./layoutModel";

describe("normalizeContentWidth", () => {
  it("旧配置的比例按窗口宽度换算成像素", () => {
    expect(normalizeContentWidth(0.44, 1400)).toBe(616);
  });

  it("像素宽度原样保留,只夹下限", () => {
    expect(normalizeContentWidth(900, 1400)).toBe(900);
    expect(normalizeContentWidth(20, 1400)).toBe(MIN_CONTENT_WIDTH);
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

describe("dragContentEdge", () => {
  it("内容栏宽度 = 指针位置扣掉分隔条,右栏吃剩余", () => {
    expect(dragContentEdge(RESIZER_WIDTH + 500, 1400)).toBe(500);
  });

  it("给右栏留够最小宽度", () => {
    const host = 1200;
    const content = dragContentEdge(host - 1, host);
    expect(content).toBe(host - RESIZER_WIDTH - MIN_RIGHT_WIDTH);
    expect(host - RESIZER_WIDTH - content).toBe(MIN_RIGHT_WIDTH);
  });

  it("内容栏保住最小宽度", () => {
    expect(dragContentEdge(0, 1400)).toBe(MIN_CONTENT_WIDTH);
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
