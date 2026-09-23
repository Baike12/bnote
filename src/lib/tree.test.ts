import { describe, expect, it } from "vitest";
import type { FileNode } from "@/lib/tauri";
import { chainLoadPlan, findNode, flattenVisible } from "./tree";

const file = (relPath: string): FileNode => ({
  name: relPath.slice(relPath.lastIndexOf("/") + 1),
  relPath,
  kind: "file",
  children: null,
});
/** 目录：children === null 表示「还没读」，数组（可为空）表示已读。 */
const dir = (relPath: string, children: FileNode[] | null = []): FileNode => ({
  name: relPath.slice(relPath.lastIndexOf("/") + 1),
  relPath,
  kind: "dir",
  children,
});

describe("flattenVisible / findNode", () => {
  const tree = [
    dir("a", [file("a/1.md"), dir("a/b", [file("a/b/2.md")])]),
    file("z.md"),
  ];

  it("只有展开的目录才展开成行，顺序按深度优先", () => {
    expect(flattenVisible(tree, new Set()).map((n) => n.relPath)).toEqual(["a", "z.md"]);
    expect(flattenVisible(tree, new Set(["a"])).map((n) => n.relPath)).toEqual(["a", "a/1.md", "a/b", "z.md"]);
    expect(flattenVisible(tree, new Set(["a", "a/b"])).map((n) => n.relPath)).toEqual([
      "a",
      "a/1.md",
      "a/b",
      "a/b/2.md",
      "z.md",
    ]);
  });

  it("未读目录（children === null）不展开，findNode 也穿不过去", () => {
    const unread = [dir("a", null)];
    expect(flattenVisible(unread, new Set(["a"])).map((n) => n.relPath)).toEqual(["a"]);
    expect(findNode(unread, "a")).toMatchObject({ children: null });
    expect(findNode(unread, "a/b")).toBe(null);
  });

  it("findNode 递归命中深层节点，找不到返回 null", () => {
    expect(findNode(tree, "a/b/2.md")?.kind).toBe("file");
    expect(findNode(tree, "a/b/3.md")).toBe(null);
  });
});

describe("chainLoadPlan：露出请求的施工计划", () => {
  it("根级文件没有祖先：无需加载、也无从 pending", () => {
    expect(chainLoadPlan([file("z.md")], "z.md")).toEqual({ load: [], pending: false });
  });

  it("祖先目录都在且已读：链齐了（该行还不在树里 → 可以判定条目不存在）", () => {
    const tree = [dir("a", [dir("a/b", [])])];
    expect(chainLoadPlan(tree, "a/b/2.md")).toEqual({ load: [], pending: false });
  });

  it("已进树但子节点没读：交给调用方去读；更深的层此刻还找不到，一并算 pending", () => {
    // pending 的含义是「这一层还没进树，所以现在不能判定它不存在」；父层没读时
    // 子层必然找不到，可它正是这次要读出来的东西 —— 结论是继续等，不是放弃。
    expect(chainLoadPlan([dir("a", null)], "a/b/2.md")).toEqual({ load: ["a"], pending: true });
  });

  it("树还没就绪（首帧/刚换库）：祖先不在树里 → pending，不许下「条目不存在」的结论", () => {
    expect(chainLoadPlan([], "a/b/2.md")).toEqual({ load: [], pending: true });
    // 父层读完了，中间层还没进树：继续等，不是「文件没了」
    const tree = [dir("a", [file("a/1.md")])];
    expect(chainLoadPlan(tree, "a/b/2.md")).toEqual({ load: [], pending: true });
  });

  it("补层的次序由树驱动：父层读完前，子层既找不到也不该被读", () => {
    const before = [dir("a", null)];
    expect(chainLoadPlan(before, "a/b/2.md").load).toEqual(["a"]);
    const after = [dir("a", [dir("a/b", null)])];
    expect(chainLoadPlan(after, "a/b/2.md")).toEqual({ load: ["a/b"], pending: false });
  });
});
