import { describe, expect, it } from "vitest";

import {
  applySuggestion,
  buildSkillPrompt,
  expandSkillTemplate,
  parseSuggestTrigger,
} from "./suggest";

describe("parseSuggestTrigger", () => {
  it("a leading / triggers skill", () => {
    expect(parseSuggestTrigger("/", 1)).toEqual({ kind: "skill", start: 0, query: "" });
    expect(parseSuggestTrigger("/html", 5)).toEqual({ kind: "skill", start: 0, query: "html" });
  });

  it("a / at line start triggers skill, a path slash after whitespace mid-line does not", () => {
    // Chat convention: slash commands only live at the start of a line; /data/2026 is an absolute path and must not be swallowed.
    const text = "用这个排版 ";
    expect(parseSuggestTrigger(text + "/", text.length + 1)).toBeNull();
    expect(parseSuggestTrigger("read /data/2026", 15)).toBeNull();
    expect(parseSuggestTrigger("https://example.com", 19)).toBeNull();
    expect(parseSuggestTrigger("\n/html", 6)).toEqual({ kind: "skill", start: 1, query: "html" });
  });

  it("@ triggers file anywhere, the query runs up to the cursor", () => {
    expect(parseSuggestTrigger("@", 1)).toEqual({ kind: "file", start: 0, query: "" });
    const text = "参考 @notes/dai";
    expect(parseSuggestTrigger(text, text.length)).toEqual({
      kind: "file",
      start: 3,
      query: "notes/dai",
    });
  });

  it("a space before the cursor triggers nothing", () => {
    expect(parseSuggestTrigger("hello ", 6)).toBeNull();
    expect(parseSuggestTrigger("", 0)).toBeNull();
  });

  it("a / after a newline still triggers (on the new line)", () => {
    const text = "第一行\n/";
    expect(parseSuggestTrigger(text, text.length)).toEqual({ kind: "skill", start: 4, query: "" });
  });

  it("a caret outside the text triggers nothing", () => {
    // The textarea can hand over a caret that no longer matches the text (a
    // programmatic value write), and slicing past the end would be meaningless.
    expect(parseSuggestTrigger("/html", -1)).toBeNull();
    expect(parseSuggestTrigger("/html", 6)).toBeNull();
  });

  it("a trigger that starts after a space but before the caret is the whole word", () => {
    // The word starts at whitespace, so only the text after it can be a trigger.
    expect(parseSuggestTrigger("看 @a.md", 7)).toEqual({ kind: "file", start: 2, query: "a.md" });
  });
});

describe("applySuggestion", () => {
  it("the / trigger is replaced by the full skill name and the caret moves after it", () => {
    const result = applySuggestion("/htm", { kind: "skill", start: 0, query: "htm" }, "/html-blog");
    expect(result.text).toBe("/html-blog ");
    expect(result.caret).toBe(11);
  });

  it("the @ trigger is replaced by the full path, keeping the surrounding context", () => {
    const text = "参考 @notes/dai 继续写";
    const result = applySuggestion(
      text,
      { kind: "file", start: 3, query: "notes/dai" },
      "@notes/daily/2026-10-29.md",
    );
    expect(result.text).toBe("参考 @notes/daily/2026-10-29.md  继续写");
    expect(result.caret).toBe(30);
  });

  it("a mid-text replacement touches only the trigger itself", () => {
    const text = "先读 @a.md 再写";
    const result = applySuggestion(text, { kind: "file", start: 3, query: "a.md" }, "@b.md");
    expect(result.text).toBe("先读 @b.md  再写");
  });
});

describe("expandSkillTemplate", () => {
  it("$ARGUMENTS takes the whole argument string", () => {
    expect(expandSkillTemplate("翻译 $ARGUMENTS 成英文", "hello world")).toBe(
      "翻译 hello world 成英文",
    );
  });

  it("$1/$2 take the positional parts; a missing position becomes empty", () => {
    expect(expandSkillTemplate("把 $1 移到 $2", "a b")).toBe("把 a 移到 b");
    expect(expandSkillTemplate("只取 $1", "a b")).toBe("只取 a");
    expect(expandSkillTemplate("取 $3", "a b")).toBe("取 ");
  });

  it("a body without placeholders gets ARGUMENTS appended (CC's fallback)", () => {
    expect(expandSkillTemplate("总结这个仓库", "")).toBe("总结这个仓库");
    expect(expandSkillTemplate("总结这个仓库", "--all")).toBe("总结这个仓库\n\nARGUMENTS: --all");
    // Whitespace-only arguments are not arguments.
    expect(expandSkillTemplate("总结这个仓库", "   ")).toBe("总结这个仓库");
  });

  it("a placeholder consumes the arguments even when it expands to empty", () => {
    // The author opted into arguments by writing the placeholder: appending
    // them again would duplicate the text the model reads.
    expect(expandSkillTemplate("取 $1", "")).toBe("取 ");
  });
});

describe("buildSkillPrompt", () => {
  it("carries the command metadata and the expanded body", () => {
    const prompt = buildSkillPrompt("把 $ARGUMENTS 排版成博客", "html-blog", "a.md");
    expect(prompt).toContain("<command-message>html-blog</command-message>");
    expect(prompt).toContain("<command-name>/html-blog</command-name>");
    expect(prompt).toContain("<command-args>a.md</command-args>");
    expect(prompt).toContain("把 a.md 排版成博客");
  });

  it("omits the args tag when no arguments were given", () => {
    const prompt = buildSkillPrompt("总结仓库", "simplify", "");
    expect(prompt).not.toContain("<command-args>");
    expect(prompt).toContain("总结仓库");
  });
});
