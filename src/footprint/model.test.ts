import { describe, expect, it } from "vitest";
import { blockKey, blocksOf, diffBlocks, isAggregatePath } from "./model";

describe("blocksOf", () => {
  it("consecutive lines separated by blank lines form a block, the line numbers are 1-based and point into the source", () => {
    const text = "第一段\n第二段\n\n- 列表项\n- 另一项\n\n尾段";
    expect(blocksOf(text)).toEqual([
      { text: "第一段\n第二段", start: 1, end: 2 },
      { text: "- 列表项\n- 另一项", start: 4, end: 5 },
      { text: "尾段", start: 7, end: 7 },
    ]);
  });

  it("leading, trailing and consecutive blank lines form no block", () => {
    const text = "\n\n\n正文\n\n\n\n尾\n\n";
    expect(blocksOf(text)).toEqual([
      { text: "正文", start: 4, end: 4 },
      { text: "尾", start: 8, end: 8 },
    ]);
  });

  it("whitespace-only lines (space/tab) also break the block", () => {
    const text = "上 \n\t\n下";
    expect(blocksOf(text)).toEqual([
      { text: "上 ", start: 1, end: 1 },
      { text: "下", start: 3, end: 3 },
    ]);
  });

  it("an empty document and a document of only blank lines return nothing", () => {
    expect(blocksOf("")).toEqual([]);
    expect(blocksOf("\n\n\n")).toEqual([]);
  });

  it("a document without blank lines is a single block", () => {
    expect(blocksOf("a\nb\nc")).toEqual([{ text: "a\nb\nc", start: 1, end: 3 }]);
  });
});

describe("blockKey", () => {
  it("strips the trailing whitespace of every line and the leading/trailing blank lines; the indentation of a line that is not part of a whole block is kept", () => {
    expect(blockKey("  a  \nb\t\n")).toBe("  a\nb");
    expect(blockKey("a\nb")).toBe(blockKey("  a\n  b")); // a genuine whole block indent is normalized
  });

  it("the indentation inside the line and at the line start is kept — a partial indentation change counts as a content change", () => {
    expect(blockKey("a\n  b")).not.toBe(blockKey("a\nb"));
  });
});

describe("diffBlocks", () => {
  it("the blocks that are in the current text but not in the baseline are returned, the line numbers point into the current text", () => {
    const baseline = "旧内容\n\n共同段落";
    const current = "旧内容\n\n共同段落\n\n今天新写的\n第二行";
    expect(diffBlocks(baseline, current)).toEqual([
      { text: "今天新写的\n第二行", start: 5, end: 6 },
    ]);
  });

  it("a rewritten paragraph: the old version disappears, the new version is shown as a whole block (no diff fragments)", () => {
    const baseline = "昨天的版本 A";
    const current = "今天改写的版本 B";
    expect(diffBlocks(baseline, current)).toEqual([{ text: "今天改写的版本 B", start: 1, end: 1 }]);
  });

  it("a deleted block is not shown (the quote-style aggregation only shows existing content)", () => {
    const baseline = "留着\n\n被删掉的";
    expect(diffBlocks(baseline, "留着")).toEqual([]);
  });

  it("a moved block counts once by identity (the old position disappears, the new position appears, the key is the same)", () => {
    const baseline = "甲\n\n乙\n\n丙";
    const current = "丙\n\n甲\n\n乙";
    expect(diffBlocks(baseline, current)).toEqual([]);
  });

  it("a missing baseline (a file created today): all the blocks count as today's record", () => {
    const current = "新文件第一段\n\n新文件第二段";
    expect(diffBlocks(null, current)).toEqual([
      { text: "新文件第一段", start: 1, end: 1 },
      { text: "新文件第二段", start: 3, end: 3 },
    ]);
  });

  it("when the baseline is an empty document everything in the current text counts as new (the empty-set semantics match the missing case)", () => {
    expect(diffBlocks("", "只有一段")).toEqual([{ text: "只有一段", start: 1, end: 1 }]);
  });

  it("trailing space jitter produces no fake addition", () => {
    const baseline = "同一段落";
    expect(diffBlocks(baseline, "同一段落  ")).toEqual([]);
  });

  it("a whole-block indentation adjustment produces no fake addition", () => {
    const baseline = "- 项 A\n  - 子项";
    expect(diffBlocks(baseline, "  - 项 A\n    - 子项")).toEqual([]);
  });

  it("no change returns nothing", () => {
    const text = "甲\n\n乙\n\n丙";
    expect(diffBlocks(text, text)).toEqual([]);
  });
});

describe("isAggregatePath", () => {
  const root = "/vault";

  it("md/markdown/txt inside the vault can be aggregated", () => {
    for (const p of ["/vault/note.md", "/vault/sub/x.MARKDOWN", "/vault/y.txt"]) {
      expect(isAggregatePath(p, root)).toBe(true);
    }
  });

  it("the Daily/ directory and the daily notes do not aggregate each other, files outside the vault are not aggregated, other extensions are not aggregated", () => {
    expect(isAggregatePath("/vault/Daily/2026-09-30.md", root)).toBe(false);
    expect(isAggregatePath("/vault/Daily/sub/a.md", root)).toBe(false);
    expect(isAggregatePath("/elsewhere/note.md", root)).toBe(false);
    expect(isAggregatePath("/vault/image.png", root)).toBe(false);
    expect(isAggregatePath("/vault/.bnote/config.json", root)).toBe(false);
  });

  it("a trailing slash on the root path does not change the decision", () => {
    expect(isAggregatePath("/vault/note.md", "/vault/")).toBe(true);
    expect(isAggregatePath("/vault/Daily/2026-09-30.md", "/vault/")).toBe(false);
  });
});

describe("diffBlocks: todo blocks belong to the sync engine, they do not enter the footprint", () => {
  it("a block that contains a todo line is excluded as a whole (any checkbox state)", () => {
    const current = "普通段落\n\n- [ ] 待办\n  - 子内容\n\n- [x] 已完成\n\n- 普通列表不是待办";
    expect(diffBlocks(null, current)).toEqual([
      { text: "普通段落", start: 1, end: 1 },
      { text: "- 普通列表不是待办", start: 8, end: 8 },
    ]);
  });

  it("ordered todos are excluded too (the 1. [ ] form)", () => {
    expect(diffBlocks(null, "1. [ ] 有序待办")).toEqual([]);
  });

  it("a paragraph and a todo squeezed into one block: the whole block belongs to the sync engine", () => {
    expect(diffBlocks(null, "一些文字\n- [ ] 待办")).toEqual([]);
  });

  it("a todo block of the baseline rewritten today: it still does not appear", () => {
    const baseline = "- [ ] 旧待办";
    expect(diffBlocks(baseline, "- [x] 旧待办 ✅ 2026-09-30")).toEqual([]);
  });

  it("the todo line detection inside a block has the same source as the sync engine: everything parseListLine recognizes counts", () => {
    expect(diffBlocks(null, "* [ ] 星号待办\n+ [X] 加号待办")).toEqual([]);
  });
});
