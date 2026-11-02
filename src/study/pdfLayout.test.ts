import { describe, expect, it } from "vitest";
import {
  clampOutlineWidth,
  DEFAULT_OUTLINE_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  MIN_PAGE_AREA,
} from "./pdfLayout";

describe("the outline column width", () => {
  it("kept as is inside [140, 480] and rounded", () => {
    expect(clampOutlineWidth(210, 1200)).toBe(210);
    expect(clampOutlineWidth(210.4, 1200)).toBe(210);
    expect(clampOutlineWidth(600, 1200)).toBe(MAX_OUTLINE_WIDTH);
    expect(clampOutlineWidth(10, 1200)).toBe(MIN_OUTLINE_WIDTH);
  });

  it("when the column is very narrow it leaves the PDF page its minimum width instead of dropping below MIN", () => {
    const body = 700;
    expect(clampOutlineWidth(600, body)).toBe(body - MIN_PAGE_AREA);
    // When even MIN_PAGE_AREA cannot be given, the outline column keeps its own lower bound.
    expect(clampOutlineWidth(600, 300)).toBe(MIN_OUTLINE_WIDTH);
  });

  it("a bad value falls back to the default width", () => {
    expect(clampOutlineWidth(NaN, 1200)).toBe(DEFAULT_OUTLINE_WIDTH);
    expect(clampOutlineWidth(Infinity, 1200)).toBe(DEFAULT_OUTLINE_WIDTH);
  });
});
