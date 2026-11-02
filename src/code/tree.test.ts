import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  buildTree,
  filterTree,
  naturalCompare,
  searchFilesByName,
  visibleRows,
  walkFiles,
} from "./tree";
import type { CodeEntry, GitFileState } from "./types";

/**
 * The gate of the file tree.
 *
 * The tree is the only implementation of the "flat entries → directory
 * structure" step: the backend only hands over a list, and the folding, the
 * sorting and the filtering happen here. A missing directory node has to be
 * synthesized (otherwise a file has nowhere to go), and the sorting has to
 * put directories first and use the natural order (file10 after file9).
 */

function entry(path: string, isDir = false, size = 0): CodeEntry {
  const slash = path.lastIndexOf("/");
  return {
    path,
    name: slash < 0 ? path : path.slice(slash + 1),
    isDir,
    size,
  };
}

describe("buildTree", () => {
  it("folds the directory hierarchy out of the paths", () => {
    const roots = buildTree([entry("src/main.rs"), entry("README.md")]);
    expect(roots.map((n) => n.name)).toEqual(["src", "README.md"]);
    const src = roots[0];
    expect(src.isDir).toBe(true);
    expect(src.children.map((n) => n.name)).toEqual(["main.rs"]);
  });

  it("missing intermediate directories are synthesized from the path", () => {
    // The backend may only give files (empty directories are not in the
    // list): a/b/c.rs still has to land on the tree.
    const roots = buildTree([entry("a/b/c.rs")]);
    const a = roots[0];
    expect(a.name).toBe("a");
    expect(a.children[0].name).toBe("b");
    expect(a.children[0].children[0].path).toBe("a/b/c.rs");
  });

  it("a directory entry and the intermediate directory synthesized from the path are the same node", () => {
    // The backend gives both directory entries (.github) and the files inside
    // them; the intermediate directories synthesized from the path have to
    // land in the same node, otherwise the same directory appears twice on
    // the tree (once as the empty directory entry, once as the synthesized
    // directory that carries the files).
    const roots = buildTree([
      entry(".github", true),
      entry(".github/ISSUE_TEMPLATE", true),
      entry(".github/ISSUE_TEMPLATE/bug_report.yml"),
      entry(".github/workflows", true),
      entry(".github/workflows/ci.yml"),
    ]);
    expect(roots.map((n) => n.name)).toEqual([".github"]);
    const gh = roots[0];
    expect(gh.children.map((n) => n.name)).toEqual(["ISSUE_TEMPLATE", "workflows"]);
    expect(gh.children[0].children.map((n) => n.name)).toEqual(["bug_report.yml"]);
  });

  it("an empty directory entry still shows up (it is not synthesized from files)", () => {
    const roots = buildTree([entry("empty", true), entry("a.ts")]);
    expect(roots.map((n) => n.name)).toEqual(["empty", "a.ts"]);
    expect(roots[0].children).toEqual([]);
  });

  it("directories come before files, and within one kind the order is natural", () => {
    const roots = buildTree([
      entry("file10.txt"),
      entry("file9.txt"),
      entry("zdir", true),
      entry("adir", true),
    ]);
    expect(roots.map((n) => n.name)).toEqual(["adir", "zdir", "file9.txt", "file10.txt"]);
  });

  it("the git state is attached to the file node", () => {
    const git = new Map<string, GitFileState>([
      ["a.rs", { path: "a.rs", origPath: null, index: "M", worktree: "M" }],
    ]);
    const roots = buildTree([entry("a.rs")], git);
    expect(roots[0].git?.worktree).toBe("M");
  });

  it("walkFiles yields the files in display order", () => {
    const roots = buildTree([entry("b/x.ts"), entry("a.ts"), entry("b/y.ts")]);
    expect(walkFiles({ ...roots[0], isDir: true, children: roots[0].children }).map((n) => n.path)).toEqual([
      "b/x.ts",
      "b/y.ts",
    ]);
  });
});

describe("naturalCompare", () => {
  it("numbers are compared by value", () => {
    expect(naturalCompare("file9", "file10")).toBeLessThan(0);
    expect(naturalCompare("a2", "a10")).toBeLessThan(0);
  });

  it("purely lexicographic names are compared by character", () => {
    expect(naturalCompare("abc", "abd")).toBeLessThan(0);
    expect(naturalCompare("abc", "abc")).toBe(0);
  });
});

describe("visibleRows (the flattening for virtual scrolling)", () => {
  const roots = buildTree([
    entry("src/a.ts"),
    entry("src/nested/b.ts"),
    entry("docs/c.md"),
    entry("d.ts"),
  ]);

  it("by default no directory is expanded: only the top level stays (folders are not expanded by default)", () => {
    const rows = visibleRows(roots, new Set());
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:docs",
      "0:src",
      "0:d.ts",
    ]);
  });

  it("only expanded directories bring out their children, and the depth is recorded", () => {
    const rows = visibleRows(roots, new Set(["src"]));
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:docs",
      "0:src",
      "1:nested",
      "1:a.ts",
      "0:d.ts",
    ]);
  });

  it("with everything expanded the row count = the node count", () => {
    const all = new Set(["docs", "src", "src/nested"]);
    expect(visibleRows(roots, all)).toHaveLength(7);
  });

  it("an empty tree gives an empty list", () => {
    expect(visibleRows([], new Set())).toEqual([]);
  });
});

describe("ancestorDirs (expanding up to the focused file)", () => {
  it("it lists the ancestor directories level by level", () => {
    expect(ancestorDirs("src/pkg/mod/a.ts")).toEqual(["src", "src/pkg", "src/pkg/mod"]);
  });

  it("a top-level file has no ancestors", () => {
    expect(ancestorDirs("README.md")).toEqual([]);
  });
});

describe("filterTree", () => {
  it("files are filtered by name, and a directory stays as long as it has a matching descendant", () => {
    const roots = buildTree([entry("src/app.ts"), entry("src/util.ts"), entry("docs/readme.md")]);
    const filtered = filterTree(roots, "app");
    expect(filtered.map((n) => n.name)).toEqual(["src"]);
    expect(filtered[0].children.map((n) => n.name)).toEqual(["app.ts"]);
  });

  it("an empty query returns the original tree", () => {
    const roots = buildTree([entry("a.ts")]);
    expect(filterTree(roots, "  ")).toBe(roots);
  });
});

describe("searchFilesByName (quick open)", () => {
  const entries = [
    entry("src/app.ts"),
    entry("src/app-router.ts"),
    entry("src/my-app.tsx"),
    entry("docs/apple.md"),
    entry("src/helper.ts"),
    entry("src", true),
  ];

  it("an exact match comes first, a containment match second, a subsequence last", () => {
    // In my-app.tsx "app.ts" is a **contiguous** substring (rank 2);
    // app-router.ts is only a subsequence (rank 3).
    const hits = searchFilesByName(entries, "app.ts");
    expect(hits.map((h) => h.path)).toEqual(["src/app.ts", "src/my-app.tsx", "src/app-router.ts"]);
  });

  it("only file names are matched, directories do not take part", () => {
    // The directory "src" is not a candidate itself; no **file name** contains
    // src.
    expect(searchFilesByName(entries, "src")).toEqual([]);
    expect(searchFilesByName(entries, "helper").map((h) => h.path)).toEqual(["src/helper.ts"]);
  });

  it("a subsequence matches too (abc → a_b_c)", () => {
    const hits = searchFilesByName(entries, "aprt");
    expect(hits.map((h) => h.path)).toEqual(["src/app-router.ts"]);
  });

  it("the match ignores case", () => {
    expect(searchFilesByName(entries, "APP").length).toBe(4);
  });

  it("an empty query or pure whitespace gives no results", () => {
    expect(searchFilesByName(entries, "")).toEqual([]);
    expect(searchFilesByName(entries, "   ")).toEqual([]);
  });

  it("the result count is capped", () => {
    const many = Array.from({ length: 80 }, (_, i) => entry(`f${i}.ts`));
    expect(searchFilesByName(many, "f").length).toBe(50);
  });
});
