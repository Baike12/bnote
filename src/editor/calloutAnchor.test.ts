import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { calloutRegions } from "./callout";
import { anchorRegionAt, collectAnchors, findTitleMatches } from "./calloutAnchor";

const docOf = (text: string) => EditorState.create({ doc: text }).doc;

/** Turns match results into text slices that can be asserted on directly (including multi-line ranges). */
const slices = (doc: ReturnType<typeof docOf>, title: string, from = 0) =>
  findTitleMatches(doc, from, doc.length, title).map((m) => doc.sliceString(m.from, m.to));

describe("findTitleMatches:标题与正文文本的空白弹性匹配", () => {
  it("单行精确匹配:同一段文字的所有出现都命中", () => {
    const doc = docOf("斜率矩阵是错的\n斜率矩阵也有用");
    expect(findTitleMatches(doc, 0, doc.length, "斜率矩阵")).toEqual([
      { from: 0, to: 4 },
      { from: 8, to: 12 },
    ]);
  });

  it("标题里的空格匹配正文里的换行:跨行选中的原文仍能命中", () => {
    const doc = docOf("前\n甲\n乙\n后");
    // a multi-line selection is squeezed into the title "甲 乙" when the block is created
    expect(slices(doc, "甲 乙")).toEqual(["甲\n乙"]);
  });

  it("标题里的空格匹配正文里的多个空白与缩进:一串空白算一处", () => {
    const doc = docOf("甲   \n  乙");
    expect(slices(doc, "甲 乙")).toEqual(["甲   \n  乙"]);
  });

  it("非空白字符必须逐字符相等:缺字、多字、不同字都不命中", () => {
    const doc = docOf("斜率矩阵\n斜率的矩阵\n斜率阵");
    expect(slices(doc, "斜率矩阵")).toEqual(["斜率矩阵"]);
  });

  it("段与段之间必须真有空白:挤在一起的段不算命中", () => {
    const doc = docOf("甲乙\n甲 乙");
    expect(slices(doc, "甲 乙")).toEqual(["甲 乙"]);
  });

  it("空标题与空窗口返回空", () => {
    const doc = docOf("甲");
    expect(findTitleMatches(doc, 0, doc.length, "")).toEqual([]);
    expect(findTitleMatches(doc, 1, 1, "甲")).toEqual([]);
  });

  it("窗口只覆盖 [from, to):窗口外的出现不算", () => {
    const doc = docOf("甲\n甲");
    expect(findTitleMatches(doc, 2, doc.length, "甲")).toEqual([{ from: 2, to: 3 }]);
  });
});

describe("anchorRegionAt:光标位置 → 关联 callout", () => {
  const DOC = "开头\n斜率矩阵\n结尾\n\n::: 斜率矩阵\n\n:::\n";

  it("位置在锚点区间内:返回关联区域", () => {
    const state = EditorState.create({ doc: DOC });
    const regions = calloutRegions(state);
    expect(anchorRegionAt(state.doc, regions, 3)?.title).toBe("斜率矩阵");
    expect(anchorRegionAt(state.doc, regions, 6)?.title).toBe("斜率矩阵");
  });

  it("区间右开:末尾之后的位置不算锚点", () => {
    const state = EditorState.create({ doc: DOC });
    expect(anchorRegionAt(state.doc, calloutRegions(state), 7)).toBeNull();
  });

  it("跨行锚点:光标在锚点后段(与起点不同行)也算", () => {
    const state = EditorState.create({ doc: "甲\n乙\n\n::: 甲 乙\n\n:::\n" });
    const regions = calloutRegions(state);
    // anchor range [0, 3) ("甲\n乙"), caret on "乙"
    expect(anchorRegionAt(state.doc, regions, 2)?.title).toBe("甲 乙");
  });

  it("无标题块:不产生锚点", () => {
    const state = EditorState.create({ doc: "内容\n\n:::\n内容\n:::\n" });
    expect(anchorRegionAt(state.doc, calloutRegions(state), 1)).toBeNull();
  });
});

describe("collectAnchors:视口锚点收集（渲染层）", () => {
  it("正文命中被收集,块内的重复文本(标题行/内容行)被排除", () => {
    const doc = docOf("斜率矩阵\n\n::: 斜率矩阵\n斜率矩阵的解释\n:::\n");
    const state = EditorState.create({ doc });
    const hits = collectAnchors(doc, calloutRegions(state), 0, doc.length, []);
    expect(hits).toHaveLength(1);
    expect(doc.sliceString(hits[0].from, hits[0].to)).toBe("斜率矩阵");
    expect(hits[0].from).toBe(0);
    expect(hits[0].region.title).toBe("斜率矩阵");
  });

  it("排除区(代码/行内代码)里的命中被跳过", () => {
    const doc = docOf("斜率矩阵\n\n```\n斜率矩阵\n```\n\n::: 斜率矩阵\n\n:::\n");
    const state = EditorState.create({ doc });
    const hits = collectAnchors(doc, calloutRegions(state), 0, doc.length, [
      { from: doc.line(3).from, to: doc.line(5).to }, // the whole fenced code block
    ]);
    // only the hit on body line 1 survives: hits inside the code block are skipped by exclude, and hits on the title line / inside the block are skipped by the callout region
    expect(hits.map((h) => h.from)).toEqual([0]);
  });

  it("多个同标题 callout:同一区间只留一处", () => {
    const doc = docOf("斜率矩阵\n\n::: 斜率矩阵\n\n:::\n\n::: 斜率矩阵\n\n:::\n");
    const state = EditorState.create({ doc });
    const hits = collectAnchors(doc, calloutRegions(state), 0, doc.length, []);
    expect(hits).toHaveLength(1);
    expect(hits[0].from).toBe(0);
  });
});
