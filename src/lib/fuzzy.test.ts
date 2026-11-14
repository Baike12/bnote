import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyMatchTerms, fuzzySort } from "./fuzzy";

/**
 * The matcher is shared by the quick switcher and the command palette, and its
 * ordering is a user-visible promise: a name match beats a path match, an
 * earlier match beats a later one, and a query that is not a subsequence must
 * produce nothing at all (never a half match).
 */

describe("fuzzyMatch", () => {
  it("matches a subsequence and reports the character positions", () => {
    expect(fuzzyMatch("bn", "bnote")).toEqual({ score: expect.any(Number), positions: [0, 1] });
    expect(fuzzyMatch("bte", "bnote")?.positions).toEqual([0, 3, 4]);
  });

  it("is case insensitive", () => {
    expect(fuzzyMatch("BN", "bnote")).not.toBeNull();
    expect(fuzzyMatch("bn", "BNOTE")).not.toBeNull();
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("abc", "acb")).toBeNull();
    expect(fuzzyMatch("z", "bnote")).toBeNull();
  });

  it("an empty query matches everything with a neutral score", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("scores a consecutive run above a scattered match of the same length", () => {
    const consecutive = fuzzyMatch("ab", "abcd")?.score ?? 0;
    const scattered = fuzzyMatch("ad", "abcd")?.score ?? 0;
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it("scores a match after a separator above one in the middle of a word", () => {
    const afterSeparator = fuzzyMatch("b", "a/b")?.score ?? 0;
    const midWord = fuzzyMatch("b", "axb")?.score ?? 0;
    expect(afterSeparator).toBeGreaterThan(midWord);
  });

  it("prefers an earlier match and a shorter target on otherwise equal matches", () => {
    expect(fuzzyMatch("x", "xab")?.score ?? 0).toBeGreaterThan(fuzzyMatch("x", "abx")?.score ?? 0);
    expect(fuzzyMatch("a", "ab")?.score ?? 0).toBeGreaterThan(fuzzyMatch("a", "abc")?.score ?? 0);
  });
});

describe("fuzzyMatchTerms", () => {
  it("requires every whitespace-separated term in any order", () => {
    expect(fuzzyMatchTerms("foo bar", "bar/foo")).not.toBeNull();
    expect(fuzzyMatchTerms("foo bar", "foo only")).toBeNull();
  });

  it("a whitespace-only query matches with a neutral score", () => {
    expect(fuzzyMatchTerms("   ", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("sums the per-term scores and merges their positions", () => {
    const both = fuzzyMatchTerms("ab cd", "abcd");
    const one = fuzzyMatch("ab", "abcd");
    expect(both?.score ?? 0).toBeGreaterThan(one?.score ?? 0);
    expect(both?.positions.length).toBe(4);
  });
});

describe("fuzzySort", () => {
  const items = ["docs/bnote.md", "bnote.md", "zebra.md"];

  it("keeps only matching items and orders by score", () => {
    const sorted = fuzzySort(items, (item) => item, "bnote");
    expect(sorted.map((r) => r.item)).toEqual(["bnote.md", "docs/bnote.md"]);
    expect(sorted[0]?.positions.length).toBeGreaterThan(0);
  });

  it("breaks equal scores with the supplied tiebreak", () => {
    const byName = ["a1", "a2"];
    const inOrder = fuzzySort(
      byName,
      (item) => item,
      "a",
      50,
      (a, b) => byName.indexOf(a) - byName.indexOf(b),
    );
    const reversed = fuzzySort(
      byName,
      (item) => item,
      "a",
      50,
      (a, b) => byName.indexOf(b) - byName.indexOf(a),
    );
    expect(inOrder.map((r) => r.item)).toEqual(["a1", "a2"]);
    expect(reversed.map((r) => r.item)).toEqual(["a2", "a1"]);
  });

  it("caps the result at the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => `note-${i}`);
    expect(fuzzySort(many, (item) => item, "note", 3)).toHaveLength(3);
  });
});
