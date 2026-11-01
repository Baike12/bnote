import { describe, expect, it } from "vitest";
import { buildTree, filterTree, naturalCompare, walkFiles } from "./tree";
import type { CodeEntry, GitFileState } from "./types";

/**
 * 文件树的门禁。
 *
 * 树是「拍平条目 → 目录结构」这一步的唯一实现:后端只给列表,折叠、排序、
 * 过滤都在这里。目录节点缺失时要能补出来(否则文件无处安放),排序要目录
 * 在前且按自然序(文件10 排在文件9 后面)。
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
    // 后端可能只给文件(空目录不进列表):a/b/c.rs 要能落到树上。
    const roots = buildTree([entry("a/b/c.rs")]);
    const a = roots[0];
    expect(a.name).toBe("a");
    expect(a.children[0].name).toBe("b");
    expect(a.children[0].children[0].path).toBe("a/b/c.rs");
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
