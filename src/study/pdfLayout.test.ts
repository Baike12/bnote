/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampOutlineWidth,
  DEFAULT_OUTLINE_WIDTH,
  loadOutlineWidth,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  MIN_PAGE_AREA,
  saveOutlineWidth,
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

describe("the persisted outline width", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the width under its own key", () => {
    saveOutlineWidth(260);

    expect(localStorage.getItem("bnote.pdfOutlineWidth")).toBe("260");
    expect(loadOutlineWidth()).toBe(260);
  });

  it("nothing stored means the default width", () => {
    expect(loadOutlineWidth()).toBe(DEFAULT_OUTLINE_WIDTH);
  });

  it("a hand-edited value is clamped on load, so the outline can never eat the page", () => {
    localStorage.setItem("bnote.pdfOutlineWidth", "9999");
    expect(loadOutlineWidth()).toBe(MAX_OUTLINE_WIDTH);

    localStorage.setItem("bnote.pdfOutlineWidth", "1");
    expect(loadOutlineWidth()).toBe(MIN_OUTLINE_WIDTH);
  });

  it("a non-numeric value falls back to the default", () => {
    localStorage.setItem("bnote.pdfOutlineWidth", "wide");
    expect(loadOutlineWidth()).toBe(DEFAULT_OUTLINE_WIDTH);
  });

  it("a storage failure only costs the width on the next open", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(() => saveOutlineWidth(260)).not.toThrow();
    expect(loadOutlineWidth()).toBe(DEFAULT_OUTLINE_WIDTH);

    setItem.mockRestore();
    getItem.mockRestore();
  });
});
