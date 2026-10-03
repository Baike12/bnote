import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  appendEntrySpec,
  blockEnd,
  blockLines,
  blockRootLine,
  composeDailyScaffold,
  dailyPathFor,
  findEntryByText,
  isDailyPath,
  linksFilePath,
  parseDailyRegion,
  parseListLine,
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
  it("识别 bullet / ordered / checkbox 与缩进保真", () => {
    expect(parseListLine("- [ ] 任务")).toEqual({ indent: "", marker: "-", gap: " ", box: " ", text: "任务" });
    expect(parseListLine("  * [x] 完成 ✅ 2026-09-23")).toEqual({
      indent: "  ",
      marker: "*",
      gap: " ",
      box: "x",
      text: "完成 ✅ 2026-09-23",
    });
    expect(parseListLine("\t1. [X] 大写")).toEqual({ indent: "\t", marker: "1.", gap: " ", box: "X", text: "大写" });
    expect(parseListLine("- 普通列表项")).toEqual({ indent: "", marker: "-", gap: " ", box: null, text: "普通列表项" });
    expect(parseListLine("2) 有序圆括号")).toEqual({ indent: "", marker: "2)", gap: " ", box: null, text: "有序圆括号" });
    expect(parseListLine("正文行")).toBe(null);
    expect(parseListLine("")).toBe(null);
  });

  it("身份文本剥掉 ✅ 戳与两端空白", () => {
    expect(todoText(parseListLine("- [ ] 任务")!)).toBe("任务");
    expect(todoText(parseListLine("- [x] 任务 ✅ 2026-09-23")!)).toBe("任务");
    expect(todoText(parseListLine("- [ ]  空格包围 ")!)).toBe("空格包围");
  });
});

describe("blockRootLine / blockEnd / blockLines", () => {
  const nested = doc("- [ ] 根\n  - [ ] 子\n    - [ ] 孙\n- [ ] 兄弟\n");
  it("沿祖先链走到最浅根,同级行跳过", () => {
    expect(blockRootLine(nested, 1)).toBe(1);
    expect(blockRootLine(nested, 2)).toBe(1);
    expect(blockRootLine(nested, 3)).toBe(1);
    expect(blockRootLine(nested, 4)).toBe(4);
  });

  it("空行断链:链断处的行自己是根", () => {
    const d = doc("- a\n\n  - b\n");
    expect(blockRootLine(d, 3)).toBe(3);
  });

  it("普通 bullet 也可以是块根(深层待办的祖先)", () => {
    const d = doc("- 项目\n  - [ ] 待办\n");
    expect(blockRootLine(d, 2)).toBe(1);
  });

  it("blockEnd 吃下所有更深行,空行/同深即止", () => {
    expect(blockEnd(nested, 1)).toBe(3);
    expect(blockEnd(nested, 4)).toBe(4);
    const withBlank = doc("- [ ] 根\n  - [ ] 子\n\n  - [ ] 不算\n");
    expect(blockEnd(withBlank, 1)).toBe(2);
    expect(blockLines(nested, 1)).toEqual(["- [ ] 根", "  - [ ] 子", "    - [ ] 孙"]);
  });
});

describe("reindentBlock", () => {
  it("剥源根缩进后目标根缩进归零,子行相对缩进保真", () => {
    expect(reindentBlock(["  - [ ] 子", "    - [ ] 孙"], 2, "")).toEqual(["- [ ] 子", "  - [ ] 孙"]);
  });
  it("加目标缩进:整块右移", () => {
    expect(reindentBlock(["- [ ] 子", "  - [ ] 孙"], 0, "\t")).toEqual(["\t- [ ] 子", "\t  - [ ] 孙"]);
  });
  it("只剥空白字符,不会啃进 marker(tab 子行)", () => {
    expect(reindentBlock(["  \t- 混合"], 2, "")).toEqual(["\t- 混合"]);
    expect(reindentBlock(["\t- 混合"], 2, "")).toEqual(["- 混合"]);
  });
});

describe("parseDailyRegion", () => {
  it("头部 H1 + 条目 + 空行分隔 + 正文截止", () => {
    const d = doc("# 2026-09-23\n\n- [ ] 甲\n  - [ ] 甲1\n\n- [ ] 乙\n\n今天写了日记。\n");
    const r = parseDailyRegion(d);
    expect(r.headerEnd).toBe(1);
    expect(r.entries).toEqual([
      { start: 3, end: 4 },
      { start: 6, end: 6 },
    ]);
    expect(r.lastListLine).toBe(6);
  });

  it("无头部/空文档/纯正文", () => {
    expect(parseDailyRegion(doc("- [ ] 甲\n- [ ] 乙\n")).headerEnd).toBe(0);
    expect(parseDailyRegion(doc("")).entries).toEqual([]);
    const prose = doc("今天的事\n- 不是待办区开头\n");
    expect(parseDailyRegion(prose).entries).toEqual([]);
  });

  it("顶层条目之前的深层行不算待办区", () => {
    const d = doc("  - 深层开头\n- [ ] 甲\n");
    expect(parseDailyRegion(d).entries).toEqual([]);
  });
});

describe("appendEntrySpec / replaceEntrySpec / removeEntrySpec", () => {
  it("空区域 + 头部:头后空一行插入", () => {
    const d = doc("# 2026-09-23\n");
    const r = parseDailyRegion(d);
    const { change, entry } = appendEntrySpec(d, r, ["- [ ] 甲"]);
    expect(textAfterChanges("# 2026-09-23\n", [change])).toBe("# 2026-09-23\n\n- [ ] 甲\n");
    expect(entry).toEqual({ start: 3, end: 3 });
  });

  it("已有条目:紧接最后一个条目(时间顺序)", () => {
    const text = "# d\n\n- [ ] 甲\n- [ ] 乙\n";
    const d = doc(text);
    const { change } = appendEntrySpec(d, parseDailyRegion(d), ["- [ ] 丙"]);
    expect(textAfterChanges(text, [change])).toBe("# d\n\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n");
  });

  it("无头部空文档 / 无头部的正文文档", () => {
    const empty = doc("");
    const r0 = parseDailyRegion(empty);
    expect(textAfterChanges("", [appendEntrySpec(empty, r0, ["- [ ] 甲"]).change])).toBe("- [ ] 甲");
    const prose = doc("旧内容\n");
    expect(textAfterChanges("旧内容\n", [appendEntrySpec(prose, parseDailyRegion(prose), ["- [ ] 甲"]).change])).toBe(
      "- [ ] 甲\n\n旧内容\n",
    );
  });

  it("replaceEntrySpec 整段替换;removeEntrySpec 吃掉条目间分隔空行", () => {
    const text = "# d\n\n- [ ] 甲\n  - [ ] 甲1\n\n- [ ] 乙\n\n正文\n";
    const d = doc(text);
    const region = parseDailyRegion(d);
    expect(
      textAfterChanges(text, [replaceEntrySpec(d, region.entries[0], ["- [ ] 甲改", "  - [ ] 新子项"])]),
    ).toBe("# d\n\n- [ ] 甲改\n  - [ ] 新子项\n\n- [ ] 乙\n\n正文\n");
    expect(textAfterChanges(text, [removeEntrySpec(d, region.entries[0])])).toBe(
      "# d\n\n- [ ] 乙\n\n正文\n",
    );
  });

  it("区域尾条目删除时保留正文前的空行", () => {
    const text = "# d\n\n- [ ] 甲\n\n正文\n";
    const d = doc(text);
    expect(textAfterChanges(text, [removeEntrySpec(d, parseDailyRegion(d).entries[0])])).toBe(
      "# d\n\n正文\n",
    );
  });
});

describe("findEntryByText", () => {
  it("同文条目按 nearLine 就近取", () => {
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
  it("hint 命中 / 窗口命中 / 全文命中 / 找不到", () => {
    expect(resolveRootLine(d, ["乙"], 3)).toBe(3);
    expect(resolveRootLine(d, ["乙"], 8)).toBe(3); // 窗口 ±30
    expect(resolveRootLine(d, ["丙"], 2)).toBe(4); // hint 行不是它,就近找
    expect(resolveRootLine(d, ["丁"], 2)).toBe(null);
  });
  it("非待办行永远不匹配", () => {
    expect(resolveRootLine(doc("甲\n- [ ] 乙\n"), ["甲"], 1)).toBe(null);
  });
});

describe("路径约定", () => {
  it("日记文件与链接文件路径", () => {
    expect(dailyPathFor("/vault", "2026-09-23")).toBe("/vault/Daily/2026-09-23.md");
    expect(dailyPathFor("/vault/", "2026-09-23")).toBe("/vault/Daily/2026-09-23.md");
    expect(isDailyPath("/vault/Daily/2026-09-23.md")).toBe(true);
    expect(isDailyPath("/vault/Daily/2026-9-3.md")).toBe(false);
    expect(isDailyPath("/vault/notes/Daily/2026-09-23.md")).toBe(true);
    expect(isDailyPath("/vault/notes/todo.md")).toBe(false);
    expect(linksFilePath("/vault")).toBe("/vault/.bnote/daily-links.json");
  });
});

describe("待办跟随:rolloverBlocks", () => {
  it("格言行/正文不截断:整篇扫描一级列表块,已完成叶子被过滤(用户真实日记形状)", () => {
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

  it("已完成中间节点是未完成后代的锚:保留,层级不断链", () => {
    const prev = ["- [ ] 父", "  - [x] 中间 ✅ 2026-09-22", "    - [ ] 剩下的"].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- [ ] 父", "  - [x] 中间 ✅ 2026-09-22", "    - [ ] 剩下的"]]);
  });

  it("已完成兄弟子树整块跳过,不越过缩进窗口误抓", () => {
    const prev = [
      "- [ ] 父",
      "  - [x] 完成的中间 ✅ 2026-09-22",
      "  - [ ] 活着的子项",
      "  - [x] 另一个完成 ✅ 2026-09-22",
    ].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- [ ] 父", "  - [ ] 活着的子项"]]);
  });

  it("顶层已完成块:有未完成后代则整链跟随,没有则整块跳过", () => {
    const prev = [
      "- [x] 收尾完成 ✅ 2026-09-22",
      "- [x] 大盘还未完",
      "  - [ ] 还没做的子项",
      "- [x] 纯完成 ✅ 2026-09-22",
      "  - [x] 完成的子项 ✅ 2026-09-22",
    ].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- [x] 大盘还未完", "  - [ ] 还没做的子项"]]);
  });

  it("纯 bullet 块:不含未完成跳过;含则作锚保留,其下普通叶子同样被过滤", () => {
    const prev = [
      "- 普通分组",
      "  - 普通子项",
      "- 有活的分组",
      "  - 普通备注",
      "  - [ ] 真正的待办",
    ].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- 有活的分组", "  - [ ] 真正的待办"]]);
  });

  it("围栏代码块里的 `- [ ]` 是代码,不跟随", () => {
    const prev = ["```", "- [ ] 代码里的假待办", "```", "", "- [ ] 真待办"].join("\n");
    expect(rolloverBlocks(prev)).toEqual([["- [ ] 真待办"]]);
  });

  it("全已完成 / 空文档:没有可跟随的", () => {
    expect(rolloverBlocks("# d\n\n- [x] 甲 ✅ 2026-09-22\n")).toEqual([]);
    expect(rolloverBlocks("")).toEqual([]);
  });

  it("空文本未完成待办也跟随(统一规则,不特判)", () => {
    expect(rolloverBlocks("- [ ] ")).toEqual([["- [ ] "]]);
  });
});

describe("待办跟随:previousDailyFile", () => {
  it("取早于今天的最近一篇,忽略非日期文件与今天及未来的文件", () => {
    const names = ["2026-09-30.md", "notes.md", "2026-10-02.md", "2026-10-03.md", "2026-10-01.md"];
    expect(previousDailyFile(names, "2026-10-02")).toBe("2026-10-01");
    expect(previousDailyFile(["2026-10-02.md"], "2026-10-02")).toBe(null);
    expect(previousDailyFile([], "2026-10-02")).toBe(null);
  });
});

describe("待办跟随:composeDailyScaffold", () => {
  it("无块 = 裸 scaffold(逐字节一致)", () => {
    expect(composeDailyScaffold("2026-10-03", [])).toBe("# 2026-10-03\n");
  });

  it("有块 = 与引擎 appendEntrySpec 同形:条目单换行相邻,文件尾单换行", () => {
    expect(composeDailyScaffold("2026-10-03", [["- [ ] 甲", "  - [ ] 乙"], ["- [ ] 丙"]])).toBe(
      "# 2026-10-03\n\n- [ ] 甲\n  - [ ] 乙\n- [ ] 丙\n",
    );
  });
});
