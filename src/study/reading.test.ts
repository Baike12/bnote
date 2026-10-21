import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_STEP,
  MAX_PAGE_STEP,
  MIN_PAGE_STEP,
  normalizePageStep,
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
