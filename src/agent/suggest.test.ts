import { describe, expect, it } from "vitest";

import { applySuggestion, parseSuggestTrigger } from "./suggest";

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
    expect(parseSuggestTrigger(text, text.length)).toEqual({ kind: "file", start: 3, query: "notes/dai" });
  });

  it("a space before the cursor triggers nothing", () => {
    expect(parseSuggestTrigger("hello ", 6)).toBeNull();
    expect(parseSuggestTrigger("", 0)).toBeNull();
  });

  it("a / after a newline still triggers (on the new line)", () => {
    const text = "第一行\n/";
    expect(parseSuggestTrigger(text, text.length)).toEqual({ kind: "skill", start: 4, query: "" });
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
