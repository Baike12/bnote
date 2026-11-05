import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  appendEntrySpec,
  blockEnd,
  blockLines,
  blockRootLine,
  composeDailyScaffold,
  dailyDayOf,
  dailyPathFor,
  findEntryByText,
  isDailyPath,
  linksFilePath,
  parseDailyRegion,
  parseListLine,
  prependEntrySpec,
  previousDailyFile,
  removeEntrySpec,
  replaceEntrySpec,
  resolveRootLine,
  reindentBlock,
  rolloverBlocks,
  textAfterChanges,
  todoText,
} from "./model";

const doc = (text: string) => EditorState.create({ doc: text }).doc;

describe("parseListLine / todoText", () => {
  it("recognizes bullet / ordered / checkbox and keeps the indentation faithful", () => {
    expect(parseListLine("- [ ] 任务")).toEqual({
      indent: "",
      marker: "-",
      gap: " ",
      box: " ",
      text: "任务",
    });
    expect(parseListLine("  * [x] 完成 ✅ 2026-09-23")).toEqual({
      indent: "  ",
      marker: "*",
      gap: " ",
      box: "x",
      text: "完成 ✅ 2026-09-23",
    });
    expect(parseListLine("\t1. [X] 大写")).toEqual({
      indent: "\t",
      marker: "1.",
      gap: " ",
      box: "X",
      text: "大写",
    });
    expect(parseListLine("- 普通列表项")).toEqual({
      indent: "",
      marker: "-",
      gap: " ",
      box: null,
      text: "普通列表项",
    });
    expect(parseListLine("2) 有序圆括号")).toEqual({
      indent: "",
      marker: "2)",
      gap: " ",
      box: null,
      text: "有序圆括号",
    });
    expect(parseListLine("正文行")).toBe(null);
    expect(parseListLine("")).toBe(null);
  });

  it("the identity text strips the ✅ stamp and the whitespace on both ends", () => {
    expect(todoText(parseListLine("- [ ] 任务")!)).toBe("任务");
    expect(todoText(parseListLine("- [x] 任务 ✅ 2026-09-23")!)).toBe("任务");
    expect(todoText(parseListLine("- [ ]  空格包围 ")!)).toBe("空格包围");
  });
});

describe("blockRootLine / blockEnd / blockLines", () => {
  const nested = doc("- [ ] 根\n  - [ ] 子\n    - [ ] 孙\n- [ ] 兄弟\n");
  it("walks the ancestor chain to the shallowest root, a line at the same level is skipped", () => {
    expect(blockRootLine(nested, 1)).toBe(1);
    expect(blockRootLine(nested, 2)).toBe(1);
    expect(blockRootLine(nested, 3)).toBe(1);
    expect(blockRootLine(nested, 4)).toBe(4);
  });

  it("a blank line breaks the chain: the line where the chain breaks is its own root", () => {
    const d = doc("- a\n\n  - b\n");
    expect(blockRootLine(d, 3)).toBe(3);
  });

  it("a plain bullet can also be a block root (the ancestor of a deep todo)", () => {
    const d = doc("- 项目\n  - [ ] 待办\n");
    expect(blockRootLine(d, 2)).toBe(1);
  });

  it("blockEnd swallows all deeper lines, a blank line or the same depth ends it", () => {
    expect(blockEnd(nested, 1)).toBe(3);
    expect(blockEnd(nested, 4)).toBe(4);
    const withBlank = doc("- [ ] 根\n  - [ ] 子\n\n  - [ ] 不算\n");
    expect(blockEnd(withBlank, 1)).toBe(2);
    expect(blockLines(nested, 1)).toEqual(["- [ ] 根", "  - [ ] 子", "    - [ ] 孙"]);
  });
});

describe("reindentBlock", () => {
  it("after the source root indentation is stripped the target root indentation is zeroed, the relative indentation of the child lines is faithful", () => {
    expect(reindentBlock(["  - [ ] 子", "    - [ ] 孙"], 2, "")).toEqual([
      "- [ ] 子",
      "  - [ ] 孙",
    ]);
  });
  it("adding the target indentation: the whole block moves right", () => {
    expect(reindentBlock(["- [ ] 子", "  - [ ] 孙"], 0, "\t")).toEqual([
      "\t- [ ] 子",
      "\t  - [ ] 孙",
    ]);
  });
  it("only whitespace characters are stripped, it never bites into the marker (a tab-indented child line)", () => {
    expect(reindentBlock(["  \t- 混合"], 2, "")).toEqual(["\t- 混合"]);
    expect(reindentBlock(["\t- 混合"], 2, "")).toEqual(["- 混合"]);
  });
});

describe("parseDailyRegion", () => {
  it("header H1 + entries + blank line separator + the body ends the region", () => {
    const d = doc("# 2026-09-23\n\n- [ ] 甲\n  - [ ] 甲1\n\n- [ ] 乙\n\n今天写了日记。\n");
    const r = parseDailyRegion(d);
    expect(r.headerEnd).toBe(1);
    expect(r.entries).toEqual([
      { start: 3, end: 4 },
      { start: 6, end: 6 },
    ]);
    expect(r.lastListLine).toBe(6);
  });

  it("no header / empty document / pure body", () => {
    expect(parseDailyRegion(doc("- [ ] 甲\n- [ ] 乙\n")).headerEnd).toBe(0);
    expect(parseDailyRegion(doc("")).entries).toEqual([]);
    const prose = doc("今天的事\n- 不是待办区开头\n");
    expect(parseDailyRegion(prose).entries).toEqual([]);
  });

  it("deep lines before the first top-level entry do not count as the todo region", () => {
    const d = doc("  - 深层开头\n- [ ] 甲\n");
    expect(parseDailyRegion(d).entries).toEqual([]);
  });
});

describe("appendEntrySpec / replaceEntrySpec / removeEntrySpec", () => {
  it("empty region + header: inserted after one blank line following the header", () => {
    const d = doc("# 2026-09-23\n");
    const r = parseDailyRegion(d);
    const { change, entry } = appendEntrySpec(d, r, ["- [ ] 甲"]);
    expect(textAfterChanges("# 2026-09-23\n", [change])).toBe("# 2026-09-23\n\n- [ ] 甲\n");
    expect(entry).toEqual({ start: 3, end: 3 });
  });

  it("existing entries: inserted right after the last entry (chronological order)", () => {
    const text = "# d\n\n- [ ] 甲\n- [ ] 乙\n";
    const d = doc(text);
    const { change } = appendEntrySpec(d, parseDailyRegion(d), ["- [ ] 丙"]);
    expect(textAfterChanges(text, [change])).toBe("# d\n\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n");
  });

  it("an empty document without a header / a body document without a header", () => {
    const empty = doc("");
    const r0 = parseDailyRegion(empty);
    expect(textAfterChanges("", [appendEntrySpec(empty, r0, ["- [ ] 甲"]).change])).toBe(
      "- [ ] 甲",
    );
    const prose = doc("旧内容\n");
    expect(
      textAfterChanges("旧内容\n", [
        appendEntrySpec(prose, parseDailyRegion(prose), ["- [ ] 甲"]).change,
      ]),
    ).toBe("- [ ] 甲\n\n旧内容\n");
  });

  it("replaceEntrySpec replaces the whole segment; removeEntrySpec swallows the blank line between entries", () => {
    const text = "# d\n\n- [ ] 甲\n  - [ ] 甲1\n\n- [ ] 乙\n\n正文\n";
    const d = doc(text);
    const region = parseDailyRegion(d);
    expect(
      textAfterChanges(text, [
        replaceEntrySpec(d, region.entries[0], ["- [ ] 甲改", "  - [ ] 新子项"]),
      ]),
    ).toBe("# d\n\n- [ ] 甲改\n  - [ ] 新子项\n\n- [ ] 乙\n\n正文\n");
    expect(textAfterChanges(text, [removeEntrySpec(d, region.entries[0])])).toBe(
      "# d\n\n- [ ] 乙\n\n正文\n",
    );
  });

  it("deleting the entry at the end of the region keeps the blank line before the body", () => {
    const text = "# d\n\n- [ ] 甲\n\n正文\n";
    const d = doc(text);
    expect(textAfterChanges(text, [removeEntrySpec(d, parseDailyRegion(d).entries[0])])).toBe(
      "# d\n\n正文\n",
    );
  });
});

describe("prependEntrySpec", () => {
  it("with existing todos: inserted before the first one, the original entries move down unchanged", () => {
    const d = doc("# 2026-10-26\n\n- [ ] 甲\n- [ ] 乙\n");
    const { change, entry } = prependEntrySpec(d, parseDailyRegion(d), ["- [ ] 新"]);
    expect(textAfterChanges(d.toString(), [change])).toBe(
      "# 2026-10-26\n\n- [ ] 新\n- [ ] 甲\n- [ ] 乙\n",
    );
    expect(entry).toEqual({ start: 3, end: 3 });
  });

  it("a block with children is prepended as a whole, the line range of the entry covers the whole block", () => {
    const d = doc("# d\n\n- [ ] 甲\n  - [ ] 子\n");
    const { change, entry } = prependEntrySpec(d, parseDailyRegion(d), [
      "- [ ] 新",
      "  - [ ] 子新",
    ]);
    expect(textAfterChanges(d.toString(), [change])).toBe(
      "# d\n\n- [ ] 新\n  - [ ] 子新\n- [ ] 甲\n  - [ ] 子\n",
    );
    expect(entry).toEqual({ start: 3, end: 4 });
  });

  it("empty region: the same shape as appendEntrySpec (one blank line after the header)", () => {
    const d = doc("# 2026-10-26\n");
    const { change } = prependEntrySpec(d, parseDailyRegion(d), ["- [ ] 新"]);
    expect(textAfterChanges(d.toString(), [change])).toBe("# 2026-10-26\n\n- [ ] 新\n");
  });

  it("a plain list without a header: pushed to the very front, before the first entry", () => {
    const d = doc("- [ ] 甲\n- [ ] 乙\n");
    const { change } = prependEntrySpec(d, parseDailyRegion(d), ["- [ ] 新"]);
    expect(textAfterChanges(d.toString(), [change])).toBe("- [ ] 新\n- [ ] 甲\n- [ ] 乙\n");
  });
});

describe("findEntryByText", () => {
  it("an entry with the same text is picked by nearLine, the closest one wins", () => {
    const text = "# d\n\n- [ ] 同名\n- [ ] 其他\n- [ ] 同名\n";
    const d = doc(text);
    const region = parseDailyRegion(d);
    expect(findEntryByText(d, region, "同名", 1)?.start).toBe(3);
    expect(findEntryByText(d, region, "同名", 100)?.start).toBe(5);
    expect(findEntryByText(d, region, "不存在", 1)).toBe(null);
  });
});

describe("resolveRootLine", () => {
  const d = doc("前言\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n");
  it("the hint hits / the window hits / the full text hits / not found", () => {
    expect(resolveRootLine(d, ["乙"], 3)).toBe(3);
    expect(resolveRootLine(d, ["乙"], 8)).toBe(3); // the +/-30 window
    expect(resolveRootLine(d, ["丙"], 2)).toBe(4); // the hint line is not it, the nearest one wins
    expect(resolveRootLine(d, ["丁"], 2)).toBe(null);
  });
  it("a non-todo line never matches", () => {
    expect(resolveRootLine(doc("甲\n- [ ] 乙\n"), ["甲"], 1)).toBe(null);
  });
});

describe("path conventions", () => {
  it("the daily note file path and the links file path", () => {
    expect(dailyPathFor("/vault", "2026-09-23")).toBe("/vault/Daily/2026-09-23.md");
    expect(dailyPathFor("/vault/", "2026-09-23")).toBe("/vault/Daily/2026-09-23.md");
    expect(isDailyPath("/vault/Daily/2026-09-23.md")).toBe(true);
    expect(isDailyPath("/vault/Daily/2026-9-3.md")).toBe(false);
    expect(isDailyPath("/vault/notes/Daily/2026-09-23.md")).toBe(true);
    expect(isDailyPath("/vault/notes/todo.md")).toBe(false);
    expect(linksFilePath("/vault")).toBe("/vault/.bnote/daily-links.json");
  });

  it("dailyDayOf extracts the date from a daily note path (the same regex as isDailyPath)", () => {
    expect(dailyDayOf("/vault/Daily/2026-09-23.md")).toBe("2026-09-23");
    expect(dailyDayOf("/vault/notes/Daily/2026-09-23.md")).toBe("2026-09-23");
    expect(dailyDayOf("/vault/Daily/2026-9-3.md")).toBe(null);
    expect(dailyDayOf("/vault/notes/todo.md")).toBe(null);
  });
});

describe("todo rollover: rolloverBlocks", () => {
  it("quote lines / body text do not truncate: the whole file is scanned for top-level list blocks, completed leaves are filtered out (the shape of a real daily note)", () => {
    const prev = [
      "# 1 2026-10-02",
      "**没有规划的不做，专注**",
      "- [ ] cs336第一次作业",
      "  - [ ] 注意力机制",
      "    - [x] rope ✅ 2026-10-02",
      "    - [ ] 带rope的多头注意力",
      "  - [ ] transformer",
      "- [ ] 了解一下aihot",
    ].join("\n");
    expect(rolloverBlocks(prev)).toEqual([
      [
        "- [ ] cs336第一次作业",
        "  - [ ] 注意力机制",
        "    - [ ] 带rope的多头注意力",
        "  - [ ] transformer",
      ],
      ["- [ ] 了解一下aihot"],
    ]);
  });

  it("a completed middle node is the anchor of an unfinished descendant: it is kept, the hierarchy is not broken", () => {
    const prev = ["- [ ] 父", "  - [x] 中间 ✅ 2026-09-22", "    - [ ] 剩下的"].join("\n");
    expect(rolloverBlocks(prev)).toEqual([
      ["- [ ] 父", "  - [x] 中间 ✅ 2026-09-22", "    - [ ] 剩下的"],
    ]);
  });

  it("a completed sibling subtree is skipped as a whole, it does not reach beyond the indentation window and grab the wrong block", () => {
    const prev = [
      "- [ ] 父",
      "  - [x] 完成的中间 ✅ 2026-09-22",
      "  - [ ] 活着的子项",
      "  - [x] 另一个完成 ✅ 2026-09-22",
    ].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- [ ] 父", "  - [ ] 活着的子项"]]);
  });

  it("a completed top-level block: with an unfinished descendant the whole chain follows, without one the block is skipped", () => {
    const prev = [
      "- [x] 收尾完成 ✅ 2026-09-22",
      "- [x] 大盘还未完",
      "  - [ ] 还没做的子项",
      "- [x] 纯完成 ✅ 2026-09-22",
      "  - [x] 完成的子项 ✅ 2026-09-22",
    ].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- [x] 大盘还未完", "  - [ ] 还没做的子项"]]);
  });

  it("a plain bullet block: without an unfinished todo it is skipped; with one it is kept as the anchor, its plain leaves are filtered out too", () => {
    const prev = [
      "- 普通分组",
      "  - 普通子项",
      "- 有活的分组",
      "  - 普通备注",
      "  - [ ] 真正的待办",
    ].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- 有活的分组", "  - [ ] 真正的待办"]]);
  });

  it("a `- [ ]` inside a fenced code block is code, it does not follow", () => {
    const prev = ["```", "- [ ] 代码里的假待办", "```", "", "- [ ] 真待办"].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- [ ] 真待办"]]);
  });

  it("all completed / empty document: there is nothing to follow", () => {
    expect(rolloverBlocks("# d\n\n- [x] 甲 ✅ 2026-09-22\n")).toEqual([]);
    expect(rolloverBlocks("")).toEqual([]);
  });

  it("an unfinished todo with empty text follows too (one uniform rule, no special case)", () => {
    expect(rolloverBlocks("- [ ] ")).toEqual([["- [ ] "]]);
  });
});

describe("todo rollover: previousDailyFile", () => {
  it("picks the latest note before today, ignoring files that are not dated and today's or future files", () => {
    const names = ["2026-09-30.md", "notes.md", "2026-10-02.md", "2026-10-03.md", "2026-10-01.md"];
    expect(previousDailyFile(names, "2026-10-02")).toBe("2026-10-01");
    expect(previousDailyFile(["2026-10-02.md"], "2026-10-02")).toBe(null);
    expect(previousDailyFile([], "2026-10-02")).toBe(null);
  });
});

describe("todo rollover: composeDailyScaffold", () => {
  it("no blocks = the bare scaffold (byte for byte identical)", () => {
    expect(composeDailyScaffold("2026-10-03", [])).toBe("# 2026-10-03\n");
  });

  it("with blocks = the same shape as the engine's appendEntrySpec: the entries are adjacent with a single newline, the file ends with a single newline", () => {
    expect(composeDailyScaffold("2026-10-03", [["- [ ] 甲", "  - [ ] 乙"], ["- [ ] 丙"]])).toBe(
      "# 2026-10-03\n\n- [ ] 甲\n  - [ ] 乙\n- [ ] 丙\n",
    );
  });
});
