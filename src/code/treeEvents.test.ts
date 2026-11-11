import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseTreeDelta } from "./events";

/**
 * The project watcher pushes what changed on disk (a file the agent wrote, a
 * shell command, a branch switch). The delta is applied to the entry list the
 * tree folds, so a malformed element must not get past the IPC edge: `buildTree`
 * keys every directory on `path` and renders `name`/`size` per row.
 */
describe("a tree delta is narrowed at the IPC edge", () => {
  it("keeps well-formed entries and drops the rest", () => {
    const delta = parseTreeDelta({
      root: "/repo",
      added: [
        { path: "src/a.ts", name: "a.ts", isDir: false, size: 12 },
        { path: "docs", name: "docs", isDir: true, size: 0 },
        { path: "bad/path", name: "bad/path", isDir: "yes", size: 1 },
        { name: "no-path.ts", isDir: false, size: 1 },
        null,
        "nope",
      ],
      removed: ["old.ts", 7, null],
      reset: false,
    });
    expect(delta?.added).toEqual([
      { path: "src/a.ts", name: "a.ts", isDir: false, size: 12 },
      { path: "docs", name: "docs", isDir: true, size: 0 },
    ]);
    expect(delta?.removed).toEqual(["old.ts"]);
  });

  it("an empty delta is still a delta (a modified file only moves git)", () => {
    expect(parseTreeDelta({ root: "/repo", added: [], removed: [], reset: false })).toEqual({
      added: [],
      removed: [],
    });
  });

  it("a non-object payload is dropped", () => {
    expect(parseTreeDelta(null)).toBeNull();
    expect(parseTreeDelta("x")).toBeNull();
    expect(parseTreeDelta(42)).toBeNull();
  });

  it("the handler ignores the events of a project that is no longer open", () => {
    // The watcher is replaced when another project opens, but a queued event
    // can still arrive: the same guard the LSP events use.
    const src = readFileSync("src/code/events.ts", "utf8");
    const start = src.indexOf('add("code-tree-changed"');
    const handler = src.slice(start, src.indexOf("await add(", start + 1));
    expect(handler).toMatch(/!fromThisProject\(data\.root\)/);
  });
});
