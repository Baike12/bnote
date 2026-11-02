import { describe, expect, it } from "vitest";
import {
  filterOutline,
  outlinePageFor,
  outlinePages,
  type PdfOutlineNode,
} from "./pdfOutline";

const tree: PdfOutlineNode[] = [
  {
    title: "第 1 章",
    page: 1,
    items: [
      { title: "1.1 背景", page: 2, items: [] },
      { title: "1.2 方法", page: 5, items: [] },
    ],
  },
  {
    title: "第 2 章 实验",
    page: 9,
    items: [{ title: "2.1 对比", page: 10, items: [] }],
  },
];

describe("filterOutline", () => {
  it("an empty query returns the tree as is (the same reference, the tree is not rebuilt)", () => {
    expect(filterOutline(tree, "   ")).toBe(tree);
  });

  it("the matches and their ancestors are kept, unrelated subtrees of the ancestors are not pulled in", () => {
    const out = filterOutline(tree, "对比");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("第 2 章 实验");
    expect(out[0].items.map((n) => n.title)).toEqual(["2.1 对比"]);
  });

  it("when a parent node matches, only the child nodes that match as well are kept", () => {
    const out = filterOutline(tree, "第 1 章");
    expect(out).toHaveLength(1);
    expect(out[0].items).toEqual([]);
  });

  it("case-insensitive", () => {
    const latin: PdfOutlineNode[] = [{ title: "Introduction", page: 1, items: [] }];
    expect(filterOutline(latin, "INTRO")).toHaveLength(1);
  });
});

describe("outlinePages / outlinePageFor", () => {
  it("the page numbers are collected depth first", () => {
    expect(outlinePages(tree)).toEqual([1, 2, 5, 9, 10]);
  });

  it("the current page belongs to the nearest preceding bookmark", () => {
    expect(outlinePageFor(tree, 4)).toBe(2);
    expect(outlinePageFor(tree, 9)).toBe(9);
    expect(outlinePageFor(tree, 1)).toBe(1);
  });

  it("a page before the first bookmark → null", () => {
    expect(outlinePageFor([{ title: "从第 2 页开始", page: 2, items: [] }], 1)).toBe(null);
  });
});
