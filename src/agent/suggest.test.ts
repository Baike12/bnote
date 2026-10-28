import { describe, expect, it } from "vitest";

import { applySuggestion, parseSuggestTrigger } from "./suggest";

describe("parseSuggestTrigger", () => {
  it("文本开头的 / 触发 skill", () => {
    expect(parseSuggestTrigger("/", 1)).toEqual({ kind: "skill", start: 0, query: "" });
    expect(parseSuggestTrigger("/html", 5)).toEqual({ kind: "skill", start: 0, query: "html" });
  });

  it("行首的 / 触发 skill,行中间空白后的路径斜杠不触发", () => {
    // 聊天惯例:斜杠命令只在行首;/数据/2026 是绝对路径,不能吃掉。
    const text = "用这个排版 ";
    expect(parseSuggestTrigger(text + "/", text.length + 1)).toBeNull();
    expect(parseSuggestTrigger("read /data/2026", 15)).toBeNull();
    expect(parseSuggestTrigger("https://example.com", 19)).toBeNull();
    expect(parseSuggestTrigger("\n/html", 6)).toEqual({ kind: "skill", start: 1, query: "html" });
  });

  it("@ 任意位置触发 file,查询串到光标为止", () => {
    expect(parseSuggestTrigger("@", 1)).toEqual({ kind: "file", start: 0, query: "" });
    const text = "参考 @notes/dai";
    expect(parseSuggestTrigger(text, text.length)).toEqual({ kind: "file", start: 3, query: "notes/dai" });
  });

  it("光标前的空白处没有触发", () => {
    expect(parseSuggestTrigger("hello ", 6)).toBeNull();
    expect(parseSuggestTrigger("", 0)).toBeNull();
  });

  it("换行后的 / 仍然触发(新的一行)", () => {
    const text = "第一行\n/";
    expect(parseSuggestTrigger(text, text.length)).toEqual({ kind: "skill", start: 4, query: "" });
  });
});

describe("applySuggestion", () => {
  it("把 / 触发词替换为完整技能名并后置光标", () => {
    const result = applySuggestion("/htm", { kind: "skill", start: 0, query: "htm" }, "/html-blog");
    expect(result.text).toBe("/html-blog ");
    expect(result.caret).toBe(11);
  });

  it("把 @ 触发词替换为完整路径,保留上下文", () => {
    const text = "参考 @notes/dai 继续写";
    const result = applySuggestion(
      text,
      { kind: "file", start: 3, query: "notes/dai" },
      "@notes/daily/2026-10-29.md",
    );
    expect(result.text).toBe("参考 @notes/daily/2026-10-29.md  继续写");
    expect(result.caret).toBe(30);
  });

  it("mid 文本替换只动触发词本身", () => {
    const text = "先读 @a.md 再写";
    const result = applySuggestion(text, { kind: "file", start: 3, query: "a.md" }, "@b.md");
    expect(result.text).toBe("先读 @b.md  再写");
  });
});
