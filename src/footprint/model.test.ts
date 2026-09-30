import { describe, expect, it } from "vitest";
import { blockKey, blocksOf, diffBlocks, isAggregatePath } from "./model";

describe("blocksOf", () => {
  it("空行分隔的连续行成块,行号 1-based 指向原文", () => {
    const text = "第一段\n第二段\n\n- 列表项\n- 另一项\n\n尾段";
    expect(blocksOf(text)).toEqual([
      { text: "第一段\n第二段", start: 1, end: 2 },
      { text: "- 列表项\n- 另一项", start: 4, end: 5 },
      { text: "尾段", start: 7, end: 7 },
    ]);
  });

  it("首尾空行、连续空行都不成块", () => {
    const text = "\n\n\n正文\n\n\n\n尾\n\n";
    expect(blocksOf(text)).toEqual([
      { text: "正文", start: 4, end: 4 },
      { text: "尾", start: 8, end: 8 },
    ]);
  });

  it("空白行(空格/tab)也按空行断块", () => {
    const text = "上 \n\t\n下";
    expect(blocksOf(text)).toEqual([
      { text: "上 ", start: 1, end: 1 },
      { text: "下", start: 3, end: 3 },
    ]);
  });

  it("空文档与纯空行文档返回空", () => {
    expect(blocksOf("")).toEqual([]);
    expect(blocksOf("\n\n\n")).toEqual([]);
  });

  it("单个无空行文档是一整块", () => {
    expect(blocksOf("a\nb\nc")).toEqual([{ text: "a\nb\nc", start: 1, end: 3 }]);
  });
});

describe("blockKey", () => {
  it("剥掉每行尾随空白、首尾空行;非整体的行首缩进保留", () => {
    expect(blockKey("  a  \nb\t\n")).toBe("  a\nb");
    expect(blockKey("a\nb")).toBe(blockKey("  a\n  b")); // 真整体缩进归一
  });

  it("行中与行首缩进保留——部分缩进变化算内容变化", () => {
    expect(blockKey("a\n  b")).not.toBe(blockKey("a\nb"));
  });
});

describe("diffBlocks", () => {
  it("当前有而基线无的块返回,行号指向当前文本", () => {
    const baseline = "旧内容\n\n共同段落";
    const current = "旧内容\n\n共同段落\n\n今天新写的\n第二行";
    expect(diffBlocks(baseline, current)).toEqual([
      { text: "今天新写的\n第二行", start: 5, end: 6 },
    ]);
  });

  it("改写的段落:旧版消失、新版整块显示(不显示 diff 片段)", () => {
    const baseline = "昨天的版本 A";
    const current = "今天改写的版本 B";
    expect(diffBlocks(baseline, current)).toEqual([{ text: "今天改写的版本 B", start: 1, end: 1 }]);
  });

  it("删除的块不显示(引用式聚合只显示现存内容)", () => {
    const baseline = "留着\n\n被删掉的";
    expect(diffBlocks(baseline, "留着")).toEqual([]);
  });

  it("移动的块按身份只算一次(旧位置消失、新位置出现,key 相同)", () => {
    const baseline = "甲\n\n乙\n\n丙";
    const current = "丙\n\n甲\n\n乙";
    expect(diffBlocks(baseline, current)).toEqual([]);
  });

  it("基线缺失(今日新建文件)全部块算今日记录", () => {
    const current = "新文件第一段\n\n新文件第二段";
    expect(diffBlocks(null, current)).toEqual([
      { text: "新文件第一段", start: 1, end: 1 },
      { text: "新文件第二段", start: 3, end: 3 },
    ]);
  });

  it("基线为空文档时当前全部算新增(空集语义与缺失一致)", () => {
    expect(diffBlocks("", "只有一段")).toEqual([{ text: "只有一段", start: 1, end: 1 }]);
  });

  it("行尾空格抖动不产生假新增", () => {
    const baseline = "同一段落";
    expect(diffBlocks(baseline, "同一段落  ")).toEqual([]);
  });

  it("整体缩进调整不产生假新增", () => {
    const baseline = "- 项 A\n  - 子项";
    expect(diffBlocks(baseline, "  - 项 A\n    - 子项")).toEqual([]);
  });

  it("无变化返回空", () => {
    const text = "甲\n\n乙\n\n丙";
    expect(diffBlocks(text, text)).toEqual([]);
  });
});

describe("isAggregatePath", () => {
  const root = "/vault";

  it("仓库内的 md/markdown/txt 可聚合", () => {
    for (const p of ["/vault/note.md", "/vault/sub/x.MARKDOWN", "/vault/y.txt"]) {
      expect(isAggregatePath(p, root)).toBe(true);
    }
  });

  it("Daily/ 目录与日记互不聚合,非仓库文件不聚合,其他扩展名不聚合", () => {
    expect(isAggregatePath("/vault/Daily/2026-09-30.md", root)).toBe(false);
    expect(isAggregatePath("/vault/Daily/sub/a.md", root)).toBe(false);
    expect(isAggregatePath("/elsewhere/note.md", root)).toBe(false);
    expect(isAggregatePath("/vault/image.png", root)).toBe(false);
    expect(isAggregatePath("/vault/.bnote/config.json", root)).toBe(false);
  });

  it("根路径尾斜杠不影响判定", () => {
    expect(isAggregatePath("/vault/note.md", "/vault/")).toBe(true);
    expect(isAggregatePath("/vault/Daily/2026-09-30.md", "/vault/")).toBe(false);
  });
});
