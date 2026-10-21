import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_STEP,
  MAX_PAGE_STEP,
  MIN_PAGE_STEP,
  normalizePageStep,
  snapScrollTopToLine,
  steppedScrollTop,
} from "./reading";

describe("翻页步长设置", () => {
  it("缺失/非法值退回默认 50%", () => {
    expect(normalizePageStep(undefined)).toBe(DEFAULT_PAGE_STEP);
    expect(normalizePageStep(null)).toBe(DEFAULT_PAGE_STEP);
    expect(normalizePageStep(Number.NaN)).toBe(DEFAULT_PAGE_STEP);
    expect(normalizePageStep("0.7")).toBe(DEFAULT_PAGE_STEP);
  });

  it("夹在 10%–100%，按 1% 取整", () => {
    expect(normalizePageStep(0.05)).toBe(MIN_PAGE_STEP);
    expect(normalizePageStep(1.4)).toBe(MAX_PAGE_STEP);
    expect(normalizePageStep(0.333)).toBe(0.33);
  });
});

describe("按步长滚动", () => {
  it("50% 视口：上一屏的下半部分停在屏幕中央", () => {
    // 700px 视口、刚在顶部：下一页后新内容从 350px 开始。
    expect(steppedScrollTop(0, 700, 5000, 1, 0.5)).toBe(350);
    expect(steppedScrollTop(350, 700, 5000, 1, 0.5)).toBe(700);
  });

  it("步长随设置变化", () => {
    expect(steppedScrollTop(0, 700, 5000, 1, 0.3)).toBe(210);
    expect(steppedScrollTop(0, 700, 5000, 1, 1)).toBe(700);
  });

  it("上下端点夹紧，不越过首尾", () => {
    expect(steppedScrollTop(120, 700, 5000, -1, 0.5)).toBe(0);
    expect(steppedScrollTop(4200, 700, 5000, 1, 0.5)).toBe(4300);
    expect(steppedScrollTop(9999, 700, 5000, 1, 0.5)).toBe(4300);
  });

  it("内容不足一屏时停在顶部", () => {
    expect(steppedScrollTop(0, 700, 500, 1, 0.5)).toBe(0);
    expect(steppedScrollTop(0, 0, 0, 1, 0.5)).toBe(0);
  });
});

describe("翻页落点对齐文字行", () => {
  const viewport = 700;
  const content = 5000;
  // 边界在视口 350px 处，容差 2% = 14px。
  const tolerance = viewport * 0.02;

  it("边界落在行间：不动", () => {
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 320, bottom: 340 }], tolerance),
    ).toBe(350);
    expect(snapScrollTopToLine(350, viewport, content, 350, [], tolerance)).toBe(350);
  });

  it("切在行内：把最近的行边对齐到边界", () => {
    // 行 335–357，边界 350：下边更近（7px），滚到 357，整行留在分界线上方。
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 335, bottom: 357 }], tolerance),
    ).toBe(357);
    // 行 345–365，边界 350：上边更近（5px），滚到 345，整行落到分界线下方。
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 345, bottom: 365 }], tolerance),
    ).toBe(345);
  });

  it("需要的位移超过 2% 视口：保持原位", () => {
    // 行高 42px，两边距离 20/22px，都超过 14px。
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 330, bottom: 372 }], tolerance),
    ).toBe(350);
  });

  it("不越过文档首尾：贴边候选不算对齐", () => {
    // 顶部：上边对齐会滚到 -10，只能接受下边对齐。
    expect(
      snapScrollTopToLine(0, viewport, content, 5, [{ top: -5, bottom: 10 }], tolerance),
    ).toBe(5);
    // 底部：下边对齐会超过 max，只能接受上边对齐。
    expect(
      snapScrollTopToLine(4300, viewport, content, 693, [{ top: 688, bottom: 702 }], tolerance),
    ).toBe(4295);
  });

  it("多条行矩形（同一行的文字片段）取最近边", () => {
    const lines = [
      { top: 335, bottom: 357 },
      { top: 336, bottom: 358 },
    ];
    expect(snapScrollTopToLine(350, viewport, content, 350, lines, tolerance)).toBe(357);
  });

  it("落点按整像素取整，且清掉亚像素残余切割", () => {
    // 上边更近：向下取整，行整体落到分界线下方。
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 347.2, bottom: 358.9 }], tolerance),
    ).toBe(347);
    // 下边更近：向上取整，行整体留在分界线上方。
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 340, bottom: 359.2 }], tolerance),
    ).toBe(360);
  });
});
