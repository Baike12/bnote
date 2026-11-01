import { describe, expect, it } from "vitest";
import {
  clampTreeWidth,
  normalizeTreeWidth,
  TREE_DEFAULT_WIDTH,
  TREE_MIN_WIDTH,
} from "./treeWidth";

/** The file tree width gate: a bad configuration falls back to the default, and dragging never squeezes the editor out. */
describe("normalizeTreeWidth", () => {
  it("缺项/坏值回落默认宽度", () => {
    expect(normalizeTreeWidth(undefined)).toBe(TREE_DEFAULT_WIDTH);
    expect(normalizeTreeWidth(null)).toBe(TREE_DEFAULT_WIDTH);
    expect(normalizeTreeWidth(Number.NaN)).toBe(TREE_DEFAULT_WIDTH);
    expect(normalizeTreeWidth(-20)).toBe(TREE_DEFAULT_WIDTH);
    expect(normalizeTreeWidth("300")).toBe(TREE_DEFAULT_WIDTH);
  });

  it("合法像素值按整数保留", () => {
    expect(normalizeTreeWidth(240)).toBe(240);
    expect(normalizeTreeWidth(239.6)).toBe(240);
  });
});

describe("clampTreeWidth", () => {
  it("不小于最小宽度", () => {
    expect(clampTreeWidth(20, 1000)).toBe(TREE_MIN_WIDTH);
  });

  it("不超过面板宽度的 60%", () => {
    expect(clampTreeWidth(900, 1000)).toBe(600);
    expect(clampTreeWidth(200, 1000)).toBe(200);
  });

  it("面板窄到 60% 低于最小宽度时仍保最小宽度", () => {
    expect(clampTreeWidth(150, 100)).toBe(TREE_MIN_WIDTH);
  });
});
