import { describe, expect, it } from "vitest";
import { resolveFamily, sessionFamily, sessionRoot, type SessionNode } from "./sessionTree";

function node(id: string, parent: string | null, createdAt: number): SessionNode {
  return { id, parent, basedOn: "", forkAt: parent ? 2 : 0, title: id, createdAt, updatedAt: createdAt };
}

describe("会话家族:根与成员", () => {
  it("从子会话向上找到主会话", () => {
    const nodes = [node("main", null, 1), node("aux", "main", 2)];
    expect(sessionRoot("aux", nodes)).toBe("main");
    expect(resolveFamily("aux", nodes)?.rootId).toBe("main");
  });

  it("锚点本身是主会话时根就是它自己", () => {
    const nodes = [node("main", null, 1), node("aux", "main", 2)];
    expect(sessionRoot("main", nodes)).toBe("main");
  });

  it("链式分叉:孙会话也回到同一个主会话", () => {
    const nodes = [
      node("main", null, 1),
      node("a", "main", 2),
      node("b", "a", 3),
    ];
    expect(sessionRoot("b", nodes)).toBe("main");
    expect(sessionFamily("main", nodes).map((n) => n.id)).toEqual(["main", "a", "b"]);
  });

  it("父记录已删除时就近当根,不抛错", () => {
    const nodes = [node("orphan", "gone", 5)];
    expect(sessionRoot("orphan", nodes)).toBe("orphan");
    expect(sessionFamily("orphan", nodes).map((n) => n.id)).toEqual(["orphan"]);
  });

  it("parent 成环时停住而不是无限递归", () => {
    const nodes = [node("a", "b", 1), node("b", "a", 2)];
    // 环里挑哪条当根无所谓,关键是终止且两条都在家族里。
    const root = sessionRoot("a", nodes);
    expect(["a", "b"]).toContain(root);
    expect(sessionFamily(root, nodes).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("一个父挂多个子:全部还原,按创建时间排序", () => {
    const nodes = [
      node("main", null, 1),
      node("x", "main", 3),
      node("y", "main", 2),
    ];
    expect(sessionFamily("main", nodes).map((n) => n.id)).toEqual(["main", "y", "x"]);
  });

  it("别的家族的会话不混进来", () => {
    const nodes = [
      node("main", null, 1),
      node("aux", "main", 2),
      node("other", null, 3),
      node("other-aux", "other", 4),
    ];
    expect(sessionFamily("main", nodes).map((n) => n.id)).toEqual(["main", "aux"]);
  });

  it("锚点不存在时返回 null(调用方按空处理)", () => {
    expect(resolveFamily("nope", [node("main", null, 1)])).toBeNull();
  });
});
