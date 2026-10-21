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
  it("空查询原样返回（同一引用，不重建树）", () => {
    expect(filterOutline(tree, "   ")).toBe(tree);
  });

  it("保留命中项及其祖先，不把祖先的无关子树带出来", () => {
    const out = filterOutline(tree, "对比");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("第 2 章 实验");
    expect(out[0].items.map((n) => n.title)).toEqual(["2.1 对比"]);
  });

  it("命中父节点时只保留同样命中的子节点", () => {
    const out = filterOutline(tree, "第 1 章");
    expect(out).toHaveLength(1);
    expect(out[0].items).toEqual([]);
  });

  it("大小写不敏感", () => {
    const latin: PdfOutlineNode[] = [{ title: "Introduction", page: 1, items: [] }];
    expect(filterOutline(latin, "INTRO")).toHaveLength(1);
  });
});

describe("outlinePages / outlinePageFor", () => {
  it("按深度优先收集页码", () => {
    expect(outlinePages(tree)).toEqual([1, 2, 5, 9, 10]);
  });

  it("当前页归属最近的前一个书签", () => {
    expect(outlinePageFor(tree, 4)).toBe(2);
    expect(outlinePageFor(tree, 9)).toBe(9);
    expect(outlinePageFor(tree, 1)).toBe(1);
  });

  it("页在第一个书签之前 → null", () => {
    expect(outlinePageFor([{ title: "从第 2 页开始", page: 2, items: [] }], 1)).toBe(null);
  });
});
