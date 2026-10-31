import { describe, expect, it } from "vitest";
import { MAX_MATCHES, findMatches } from "./codeSearch";

/** 断言/调试都看命中文本,不手写偏移。 */
const hits = (text: string, query: string): string[] =>
  findMatches(text, query).map((m) => text.slice(m.from, m.to));

describe("findMatches", () => {
  it("按字面量匹配:正则元字符不生效", () => {
    const text = '["[[0]]", "$0", "($0)$", "a.b", "{0:默认}"]';
    expect(hits(text, "$0")).toEqual(["$0", "$0"]);
    expect(hits(text, "[[0]]")).toEqual(["[[0]]"]);
    expect(hits(text, "a.b")).toEqual(["a.b"]);
    expect(hits(text, "(")).toEqual(["("]);
    expect(hits(text, "{0:")).toEqual(["{0:"]);
  });

  it("忽略大小写且偏移不错位", () => {
    const text = "Snippet {snipSnippet} snippet";
    const found = findMatches(text, "snippet");
    expect(found).toHaveLength(3);
    // 命中保留原文大小写,偏移指向原文。
    for (const m of found) expect(text.slice(m.from, m.to).toLowerCase()).toBe("snippet");
    // 首尾命中位置精确:第 3 处是末尾那个。
    expect(found[2]).toEqual({ from: text.length - 7, to: text.length });
  });

  it("命中不重叠(逐处前进一个查询长度)", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
  });

  it("空查询无命中", () => {
    expect(findMatches("anything", "")).toEqual([]);
  });

  it("上限封顶,不随文档无限增长", () => {
    const text = "x".repeat(MAX_MATCHES + 50);
    expect(findMatches(text, "x")).toHaveLength(MAX_MATCHES);
  });

  it("中文与混合内容同样可查", () => {
    const text = "// 自动分数\n{ \"//\", ({ }, 自动 }";
    expect(hits(text, "自动")).toEqual(["自动", "自动"]);
    expect(hits(text, "自动分数")).toEqual(["自动分数"]);
  });
});
