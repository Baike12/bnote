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
    // 700px viewport, just at the top: after the next page the new content starts at 350px.
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
  // The boundary is at 350px of the viewport, the tolerance 2% = 14px.
  const tolerance = viewport * 0.02;

  it("边界落在行间：不动", () => {
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 320, bottom: 340 }], tolerance),
    ).toBe(350);
    expect(snapScrollTopToLine(350, viewport, content, 350, [], tolerance)).toBe(350);
  });

  it("切在行内：把最近的行边对齐到边界", () => {
    // Line 335-357, boundary 350: the bottom edge is closer (7px), scroll to 357, the whole line stays above the split line.
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 335, bottom: 357 }], tolerance),
    ).toBe(357);
    // Line 345-365, boundary 350: the top edge is closer (5px), scroll to 345, the whole line ends up below the split line.
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 345, bottom: 365 }], tolerance),
    ).toBe(345);
  });

  it("需要的位移超过 2% 视口：保持原位", () => {
    // Line height 42px, distances 20/22px on both sides, both over 14px.
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 330, bottom: 372 }], tolerance),
    ).toBe(350);
  });

  it("不越过文档首尾：贴边候选不算对齐", () => {
    // Top: aligning the top edge would scroll to -10, so only the bottom edge alignment is accepted.
    expect(
      snapScrollTopToLine(0, viewport, content, 5, [{ top: -5, bottom: 10 }], tolerance),
    ).toBe(5);
    // Bottom: aligning the bottom edge would exceed max, so only the top edge alignment is accepted.
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
    // The top edge is closer: round down, the whole line ends up below the split line.
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 347.2, bottom: 358.9 }], tolerance),
    ).toBe(347);
    // The bottom edge is closer: round up, the whole line stays above the split line.
    expect(
      snapScrollTopToLine(350, viewport, content, 350, [{ top: 340, bottom: 359.2 }], tolerance),
    ).toBe(360);
  });
});
