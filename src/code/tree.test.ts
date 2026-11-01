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
  it("按路径折出目录层级", () => {
    const roots = buildTree([entry("src/main.rs"), entry("README.md")]);
    expect(roots.map((n) => n.name)).toEqual(["src", "README.md"]);
    const src = roots[0];
    expect(src.isDir).toBe(true);
    expect(src.children.map((n) => n.name)).toEqual(["main.rs"]);
  });

  it("中间目录缺失时按路径补出来", () => {
    // The backend may only give files (empty directories are not in the
    // list): a/b/c.rs still has to land on the tree.
    const roots = buildTree([entry("a/b/c.rs")]);
    const a = roots[0];
    expect(a.name).toBe("a");
    expect(a.children[0].name).toBe("b");
    expect(a.children[0].children[0].path).toBe("a/b/c.rs");
  });

  it("目录条目与按路径补出的中间目录是同一个节点", () => {
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

  it("空目录条目照样出现(不靠文件补出来)", () => {
    const roots = buildTree([entry("empty", true), entry("a.ts")]);
    expect(roots.map((n) => n.name)).toEqual(["empty", "a.ts"]);
    expect(roots[0].children).toEqual([]);
  });

  it("目录排在文件前面,同类按自然序", () => {
    const roots = buildTree([
      entry("file10.txt"),
      entry("file9.txt"),
      entry("zdir", true),
      entry("adir", true),
    ]);
    expect(roots.map((n) => n.name)).toEqual(["adir", "zdir", "file9.txt", "file10.txt"]);
  });

  it("git 状态挂到文件节点上", () => {
    const git = new Map<string, GitFileState>([
      ["a.rs", { path: "a.rs", origPath: null, index: "M", worktree: "M" }],
    ]);
    const roots = buildTree([entry("a.rs")], git);
    expect(roots[0].git?.worktree).toBe("M");
  });

  it("walkFiles 按展示顺序产出文件", () => {
    const roots = buildTree([entry("b/x.ts"), entry("a.ts"), entry("b/y.ts")]);
    expect(walkFiles({ ...roots[0], isDir: true, children: roots[0].children }).map((n) => n.path)).toEqual([
      "b/x.ts",
      "b/y.ts",
    ]);
  });
});

describe("naturalCompare", () => {
  it("数字按数值比", () => {
    expect(naturalCompare("file9", "file10")).toBeLessThan(0);
    expect(naturalCompare("a2", "a10")).toBeLessThan(0);
  });

  it("纯字典序时按字符比", () => {
    expect(naturalCompare("abc", "abd")).toBeLessThan(0);
    expect(naturalCompare("abc", "abc")).toBe(0);
  });
});

describe("visibleRows(虚拟滚动的拍平)", () => {
  const roots = buildTree([
    entry("src/a.ts"),
    entry("src/nested/b.ts"),
    entry("docs/c.md"),
    entry("d.ts"),
  ]);

  it("默认一个目录都没展开:只留顶层(不默认展开所有文件夹)", () => {
    const rows = visibleRows(roots, new Set());
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:docs",
      "0:src",
      "0:d.ts",
    ]);
  });

  it("展开的目录才带出子节点,并记下层级", () => {
    const rows = visibleRows(roots, new Set(["src"]));
    expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      "0:docs",
      "0:src",
      "1:nested",
      "1:a.ts",
      "0:d.ts",
    ]);
  });

  it("全部展开时行数 = 所有节点数", () => {
    const all = new Set(["docs", "src", "src/nested"]);
    expect(visibleRows(roots, all)).toHaveLength(7);
  });

  it("空树给空列表", () => {
    expect(visibleRows([], new Set())).toEqual([]);
  });
});

describe("ancestorDirs(聚焦文件时展开到它)", () => {
  it("逐层给出祖先目录", () => {
    expect(ancestorDirs("src/pkg/mod/a.ts")).toEqual(["src", "src/pkg", "src/pkg/mod"]);
  });

  it("顶层文件没有祖先", () => {
    expect(ancestorDirs("README.md")).toEqual([]);
  });
});

describe("filterTree", () => {
  it("文件按名字过滤,目录只要有命中后代就留下", () => {
    const roots = buildTree([entry("src/app.ts"), entry("src/util.ts"), entry("docs/readme.md")]);
    const filtered = filterTree(roots, "app");
    expect(filtered.map((n) => n.name)).toEqual(["src"]);
    expect(filtered[0].children.map((n) => n.name)).toEqual(["app.ts"]);
  });

  it("空查询返回原树", () => {
    const roots = buildTree([entry("a.ts")]);
    expect(filterTree(roots, "  ")).toBe(roots);
  });
});

describe("searchFilesByName(快速打开)", () => {
  const entries = [
    entry("src/app.ts"),
    entry("src/app-router.ts"),
    entry("src/my-app.tsx"),
    entry("docs/apple.md"),
    entry("src/helper.ts"),
    entry("src", true),
  ];

  it("完全相等排最前,包含其次,子序列最后", () => {
    // In my-app.tsx "app.ts" is a **contiguous** substring (rank 2);
    // app-router.ts is only a subsequence (rank 3).
    const hits = searchFilesByName(entries, "app.ts");
    expect(hits.map((h) => h.path)).toEqual(["src/app.ts", "src/my-app.tsx", "src/app-router.ts"]);
  });

  it("只按文件名匹配,目录不参与", () => {
    // The directory "src" is not a candidate itself; no **file name** contains
    // src.
    expect(searchFilesByName(entries, "src")).toEqual([]);
    expect(searchFilesByName(entries, "helper").map((h) => h.path)).toEqual(["src/helper.ts"]);
  });

  it("子序列也能命中(abc → a_b_c)", () => {
    const hits = searchFilesByName(entries, "aprt");
    expect(hits.map((h) => h.path)).toEqual(["src/app-router.ts"]);
  });

  it("忽略大小写", () => {
    expect(searchFilesByName(entries, "APP").length).toBe(4);
  });

  it("空查询/纯空白不给结果", () => {
    expect(searchFilesByName(entries, "")).toEqual([]);
    expect(searchFilesByName(entries, "   ")).toEqual([]);
  });

  it("有上限", () => {
    const many = Array.from({ length: 80 }, (_, i) => entry(`f${i}.ts`));
    expect(searchFilesByName(many, "f").length).toBe(50);
  });
});
