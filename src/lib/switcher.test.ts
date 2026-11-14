import { describe, expect, it } from "vitest";
import { buildSwitcherResults } from "./switcher";

/**
 * Quick-switcher ranking is the "jump to a note" contract. Three properties
 * matter to the user and are not visible from the data alone:
 *
 *   - a note whose own name matches outranks the contents of a matching folder;
 *   - a typed folder name turns into "the files of that folder, by recency";
 *   - the empty query is the recency jump list, with the open note removed.
 *
 * Every case runs the real ranking function over a flat index, no UI.
 */

const VAULT = "/v";

const FILES = [
  "bnote/bnote-notes.md",
  "bnote/ideas.md",
  "projects/kanban.md",
  "projects/reading/books.md",
  "inbox.md",
  "archive/old.md",
];

const RECENT = ["/v/inbox.md", "/v/projects/kanban.md"];

const items = (query: string, extra: { excludeAbs?: string | null; limit?: number } = {}) =>
  buildSwitcherResults(
    FILES,
    RECENT,
    VAULT,
    query,
    extra.excludeAbs ?? null,
    extra.limit ?? 50,
  ).map((r) => r.item);

describe("empty query: the recency jump list", () => {
  it("orders the recently opened files first and the never opened ones after them", () => {
    expect(items("")).toEqual([
      "inbox.md",
      "projects/kanban.md",
      "bnote/bnote-notes.md",
      "bnote/ideas.md",
      "projects/reading/books.md",
      "archive/old.md",
    ]);
  });

  it("drops the note that is already open so the list starts at the previous one", () => {
    expect(items("", { excludeAbs: "/v/inbox.md" })[0]).toBe("projects/kanban.md");
    expect(items("", { excludeAbs: "/v/inbox.md" })).not.toContain("inbox.md");
  });

  it("without a vault path there is nothing absolute to exclude, so the list stays complete", () => {
    const all = buildSwitcherResults(FILES, [], null, "", "/v/inbox.md").map((r) => r.item);
    expect(all).toContain("inbox.md");
    // With no recency the input order is preserved.
    expect(all).toEqual(FILES);
  });
});

describe("name matches", () => {
  it("a note named like the query outranks a folder whose contents match too", () => {
    const result = items("bnote");
    expect(result[0]).toBe("bnote/bnote-notes.md");
  });

  it("carries the matched positions for highlighting", () => {
    const [first] = buildSwitcherResults(FILES, RECENT, VAULT, "kanban");
    expect(first?.item).toBe("projects/kanban.md");
    expect(first?.positions.length).toBeGreaterThan(0);
  });
});

describe("folder matches", () => {
  it("typing a folder name contributes its files ordered by open recency", () => {
    const result = items("projects");
    expect(result).toContain("projects/kanban.md");
    expect(result).toContain("projects/reading/books.md");
    // The opened file of that folder comes before the never-opened one.
    expect(result.indexOf("projects/kanban.md")).toBeLessThan(
      result.indexOf("projects/reading/books.md"),
    );
  });

  it("an ancestor folder absorbs its descendants: files are listed once", () => {
    const result = items("projects");
    expect(result.filter((item) => item === "projects/reading/books.md")).toHaveLength(1);
  });
});

describe("full-path matches and the cap", () => {
  it("a multi-term query no single folder satisfies still matches through the whole path", () => {
    expect(items("reading books")).toContain("projects/reading/books.md");
  });

  it("deduplicates across the three sections and caps the total", () => {
    const full = items("o");
    expect(new Set(full).size).toBe(full.length);
    expect(items("o", { limit: 2 })).toHaveLength(2);
  });

  it("a query that matches nothing returns an empty list", () => {
    expect(items("qqqq")).toEqual([]);
  });
});
