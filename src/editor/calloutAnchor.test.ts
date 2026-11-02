import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { calloutRegions } from "./callout";
import { anchorRegionAt, collectAnchors, findTitleMatches } from "./calloutAnchor";

const docOf = (text: string) => EditorState.create({ doc: text }).doc;

/** Turns match results into text slices that can be asserted on directly (including multi-line ranges). */
const slices = (doc: ReturnType<typeof docOf>, title: string, from = 0) =>
  findTitleMatches(doc, from, doc.length, title).map((m) => doc.sliceString(m.from, m.to));

describe("findTitleMatches: whitespace-flexible matching of a title against body text", () => {
  it("single-line exact match: every occurrence of the same text is hit", () => {
    const doc = docOf("斜率矩阵是错的\n斜率矩阵也有用");
    expect(findTitleMatches(doc, 0, doc.length, "斜率矩阵")).toEqual([
      { from: 0, to: 4 },
      { from: 8, to: 12 },
    ]);
  });

  it("a space in the title matches a newline in the body: a multi-line selection still hits", () => {
    const doc = docOf("前\n甲\n乙\n后");
    // a multi-line selection is squeezed into the title "甲 乙" when the block is created
    expect(slices(doc, "甲 乙")).toEqual(["甲\n乙"]);
  });

  it("a space in the title matches several blanks and indentation in the body: a run of blanks counts as one", () => {
    const doc = docOf("甲   \n  乙");
    expect(slices(doc, "甲 乙")).toEqual(["甲   \n  乙"]);
  });

  it("non-blank characters must be equal character by character: a missing, extra or different character misses", () => {
    const doc = docOf("斜率矩阵\n斜率的矩阵\n斜率阵");
    expect(slices(doc, "斜率矩阵")).toEqual(["斜率矩阵"]);
  });

  it("there must be real whitespace between the segments: segments squeezed together do not hit", () => {
    const doc = docOf("甲乙\n甲 乙");
    expect(slices(doc, "甲 乙")).toEqual(["甲 乙"]);
  });

  it("an empty title and an empty window both return nothing", () => {
    const doc = docOf("甲");
    expect(findTitleMatches(doc, 0, doc.length, "")).toEqual([]);
    expect(findTitleMatches(doc, 1, 1, "甲")).toEqual([]);
  });

  it("the window covers only [from, to): occurrences outside the window do not count", () => {
    const doc = docOf("甲\n甲");
    expect(findTitleMatches(doc, 2, doc.length, "甲")).toEqual([{ from: 2, to: 3 }]);
  });
});

describe("anchorRegionAt: caret position → the associated callout", () => {
  const DOC = "开头\n斜率矩阵\n结尾\n\n::: 斜率矩阵\n\n:::\n";

  it("position inside the anchor range: returns the associated region", () => {
    const state = EditorState.create({ doc: DOC });
    const regions = calloutRegions(state);
    expect(anchorRegionAt(state.doc, regions, 3)?.title).toBe("斜率矩阵");
    expect(anchorRegionAt(state.doc, regions, 6)?.title).toBe("斜率矩阵");
  });

  it("the range is right-open: a position past the end is not an anchor", () => {
    const state = EditorState.create({ doc: DOC });
    expect(anchorRegionAt(state.doc, calloutRegions(state), 7)).toBeNull();
  });

  it("multi-line anchor: a caret on the later part of the anchor (on another line than the start) counts", () => {
    const state = EditorState.create({ doc: "甲\n乙\n\n::: 甲 乙\n\n:::\n" });
    const regions = calloutRegions(state);
    // anchor range [0, 3) ("甲\n乙"), caret on "乙"
    expect(anchorRegionAt(state.doc, regions, 2)?.title).toBe("甲 乙");
  });

  it("a block without a title produces no anchor", () => {
    const state = EditorState.create({ doc: "内容\n\n:::\n内容\n:::\n" });
    expect(anchorRegionAt(state.doc, calloutRegions(state), 1)).toBeNull();
  });
});

describe("collectAnchors: viewport anchor collection (render layer)", () => {
  it("body hits are collected, duplicated text inside the block (title line / content line) is excluded", () => {
    const doc = docOf("斜率矩阵\n\n::: 斜率矩阵\n斜率矩阵的解释\n:::\n");
    const state = EditorState.create({ doc });
    const hits = collectAnchors(doc, calloutRegions(state), 0, doc.length, []);
    expect(hits).toHaveLength(1);
    expect(doc.sliceString(hits[0].from, hits[0].to)).toBe("斜率矩阵");
    expect(hits[0].from).toBe(0);
    expect(hits[0].region.title).toBe("斜率矩阵");
  });

  it("hits inside excluded ranges (code / inline code) are skipped", () => {
    const doc = docOf("斜率矩阵\n\n```\n斜率矩阵\n```\n\n::: 斜率矩阵\n\n:::\n");
    const state = EditorState.create({ doc });
    const hits = collectAnchors(doc, calloutRegions(state), 0, doc.length, [
      { from: doc.line(3).from, to: doc.line(5).to }, // the whole fenced code block
    ]);
    // only the hit on body line 1 survives: hits inside the code block are skipped by exclude, and hits on the title line / inside the block are skipped by the callout region
    expect(hits.map((h) => h.from)).toEqual([0]);
  });

  it("several callouts with the same title: only one is kept for the same range", () => {
    const doc = docOf("斜率矩阵\n\n::: 斜率矩阵\n\n:::\n\n::: 斜率矩阵\n\n:::\n");
    const state = EditorState.create({ doc });
    const hits = collectAnchors(doc, calloutRegions(state), 0, doc.length, []);
    expect(hits).toHaveLength(1);
    expect(hits[0].from).toBe(0);
  });
});
