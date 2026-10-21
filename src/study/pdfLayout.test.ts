import { describe, expect, it } from "vitest";
import {
  clampOutlineWidth,
  DEFAULT_OUTLINE_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  MIN_PAGE_AREA,
} from "./pdfLayout";

describe("书签栏宽度", () => {
  it("在 [140, 480] 内原样保留,并取整", () => {
    expect(clampOutlineWidth(210, 1200)).toBe(210);
    expect(clampOutlineWidth(210.4, 1200)).toBe(210);
    expect(clampOutlineWidth(600, 1200)).toBe(MAX_OUTLINE_WIDTH);
    expect(clampOutlineWidth(10, 1200)).toBe(MIN_OUTLINE_WIDTH);
  });

  it("栏很窄时给 PDF 页面留出最小宽度,而不是压到 MIN 以下", () => {
    const body = 700;
    expect(clampOutlineWidth(600, body)).toBe(body - MIN_PAGE_AREA);
    // 连 MIN_PAGE_AREA 都给不出时,保住书签栏自己的下限。
    expect(clampOutlineWidth(600, 300)).toBe(MIN_OUTLINE_WIDTH);
  });

  it("坏值退回默认宽度", () => {
    expect(clampOutlineWidth(NaN, 1200)).toBe(DEFAULT_OUTLINE_WIDTH);
    expect(clampOutlineWidth(Infinity, 1200)).toBe(DEFAULT_OUTLINE_WIDTH);
  });
});
