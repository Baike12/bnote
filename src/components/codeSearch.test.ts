import { describe, expect, it } from "vitest";
import { MAX_MATCHES, findMatches } from "./codeSearch";

/** Both assertions and debugging read the matched text, never hand-written offsets. */
const hits = (text: string, query: string): string[] =>
  findMatches(text, query).map((m) => text.slice(m.from, m.to));

describe("findMatches", () => {
  it("matches literally: regex metacharacters have no effect", () => {
    const text = '["[[0]]", "$0", "($0)$", "a.b", "{0:默认}"]';
    expect(hits(text, "$0")).toEqual(["$0", "$0"]);
    expect(hits(text, "[[0]]")).toEqual(["[[0]]"]);
    expect(hits(text, "a.b")).toEqual(["a.b"]);
    expect(hits(text, "(")).toEqual(["("]);
    expect(hits(text, "{0:")).toEqual(["{0:"]);
  });

  it("case-insensitive with no offset drift", () => {
    const text = "Snippet {snipSnippet} snippet";
    const found = findMatches(text, "snippet");
    expect(found).toHaveLength(3);
    // Matches keep the original casing, and the offsets point into the original text.
    for (const m of found) expect(text.slice(m.from, m.to).toLowerCase()).toBe("snippet");
    // The first and last match positions are exact: the third one is the one at the end.
    expect(found[2]).toEqual({ from: text.length - 7, to: text.length });
  });

  it("matches do not overlap (the scan advances by one query length each time)", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
  });

  it("an empty query matches nothing", () => {
    expect(findMatches("anything", "")).toEqual([]);
  });

  it("the cap is enforced and does not grow with the document", () => {
    const text = "x".repeat(MAX_MATCHES + 50);
    expect(findMatches(text, "x")).toHaveLength(MAX_MATCHES);
  });

  it("Chinese and mixed content are searchable too", () => {
    const text = "// 自动分数\n{ \"//\", ({ }, 自动 }";
    expect(hits(text, "自动")).toEqual(["自动", "自动"]);
    expect(hits(text, "自动分数")).toEqual(["自动分数"]);
  });
});
