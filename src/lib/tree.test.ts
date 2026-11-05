import { describe, expect, it } from "vitest";
import type { FileNode } from "@/lib/tauri";
import { chainLoadPlan, findNode, flattenVisible } from "./tree";

const file = (relPath: string): FileNode => ({
  name: relPath.slice(relPath.lastIndexOf("/") + 1),
  relPath,
  kind: "file",
  children: null,
});
/** Directory: children === null means "not read yet", an array (possibly empty) means read. */
const dir = (relPath: string, children: FileNode[] | null = []): FileNode => ({
  name: relPath.slice(relPath.lastIndexOf("/") + 1),
  relPath,
  kind: "dir",
  children,
});

describe("flattenVisible / findNode", () => {
  const tree = [dir("a", [file("a/1.md"), dir("a/b", [file("a/b/2.md")])]), file("z.md")];

  it("only expanded directories are flattened into rows, in depth-first order", () => {
    expect(flattenVisible(tree, new Set()).map((n) => n.relPath)).toEqual(["a", "z.md"]);
    expect(flattenVisible(tree, new Set(["a"])).map((n) => n.relPath)).toEqual([
      "a",
      "a/1.md",
      "a/b",
      "z.md",
    ]);
    expect(flattenVisible(tree, new Set(["a", "a/b"])).map((n) => n.relPath)).toEqual([
      "a",
      "a/1.md",
      "a/b",
      "a/b/2.md",
      "z.md",
    ]);
  });

  it("an unread directory (children === null) is not flattened and findNode cannot reach through it", () => {
    const unread = [dir("a", null)];
    expect(flattenVisible(unread, new Set(["a"])).map((n) => n.relPath)).toEqual(["a"]);
    expect(findNode(unread, "a")).toMatchObject({ children: null });
    expect(findNode(unread, "a/b")).toBe(null);
  });

  it("findNode hits deep nodes recursively and returns null when nothing is found", () => {
    expect(findNode(tree, "a/b/2.md")?.kind).toBe("file");
    expect(findNode(tree, "a/b/3.md")).toBe(null);
  });
});

describe("chainLoadPlan: the construction plan for a reveal request", () => {
  it("a root-level file has no ancestors: nothing to load and nothing pending", () => {
    expect(chainLoadPlan([file("z.md")], "z.md")).toEqual({ load: [], pending: false });
  });

  it("all ancestor directories exist and are read: the chain is complete (the row is not in the tree → the entry can be judged missing)", () => {
    const tree = [dir("a", [dir("a/b", [])])];
    expect(chainLoadPlan(tree, "a/b/2.md")).toEqual({ load: [], pending: false });
  });

  it("in the tree but the children are not read: the caller must read it; the deeper level cannot be found yet and counts as pending too", () => {
    // pending means "this level is not in the tree yet, so its absence cannot
    // be concluded right now". While the parent is unread the child is
    // necessarily not found — but that child is exactly what this call is
    // supposed to read, so the answer is to keep waiting, not to give up.
    expect(chainLoadPlan([dir("a", null)], "a/b/2.md")).toEqual({ load: ["a"], pending: true });
  });

  it("the tree is not ready yet (first frame/just switched vault): the ancestor is not in the tree → pending, no 'entry does not exist' conclusion allowed", () => {
    expect(chainLoadPlan([], "a/b/2.md")).toEqual({ load: [], pending: true });
    // The parent is read but the middle level is not in the tree yet: keep
    // waiting, the file is not gone
    const tree = [dir("a", [file("a/1.md")])];
    expect(chainLoadPlan(tree, "a/b/2.md")).toEqual({ load: [], pending: true });
  });

  it("the order of the extra levels is driven by the tree: before the parent is read the child is neither findable nor readable", () => {
    const before = [dir("a", null)];
    expect(chainLoadPlan(before, "a/b/2.md").load).toEqual(["a"]);
    const after = [dir("a", [dir("a/b", null)])];
    expect(chainLoadPlan(after, "a/b/2.md")).toEqual({ load: ["a/b"], pending: false });
  });
});
