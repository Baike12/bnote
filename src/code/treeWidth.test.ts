import { describe, expect, it } from "vitest";
import {
  clampTreeWidth,
  normalizeTreeWidth,
  TREE_DEFAULT_WIDTH,
  TREE_MIN_WIDTH,
} from "./treeWidth";

/** The file tree width gate: a bad configuration falls back to the default, and dragging never squeezes the editor out. */
describe("normalizeTreeWidth", () => {
  it("a missing or bad value falls back to the default width", () => {
    expect(normalizeTreeWidth(undefined)).toBe(TREE_DEFAULT_WIDTH);
    expect(normalizeTreeWidth(null)).toBe(TREE_DEFAULT_WIDTH);
    expect(normalizeTreeWidth(Number.NaN)).toBe(TREE_DEFAULT_WIDTH);
    expect(normalizeTreeWidth(-20)).toBe(TREE_DEFAULT_WIDTH);
    expect(normalizeTreeWidth("300")).toBe(TREE_DEFAULT_WIDTH);
  });

  it("a valid pixel value is kept as an integer", () => {
    expect(normalizeTreeWidth(240)).toBe(240);
    expect(normalizeTreeWidth(239.6)).toBe(240);
  });
});

describe("clampTreeWidth", () => {
  it("never smaller than the minimum width", () => {
    expect(clampTreeWidth(20, 1000)).toBe(TREE_MIN_WIDTH);
  });

  it("never more than 60% of the panel width", () => {
    expect(clampTreeWidth(900, 1000)).toBe(600);
    expect(clampTreeWidth(200, 1000)).toBe(200);
  });

  it("when the panel is so narrow that 60% falls below the minimum width, the minimum width is still kept", () => {
    expect(clampTreeWidth(150, 100)).toBe(TREE_MIN_WIDTH);
  });
});
