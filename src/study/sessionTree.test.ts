import { describe, expect, it } from "vitest";
import { resolveFamily, sessionFamily, sessionRoot, type SessionNode } from "./sessionTree";

function node(id: string, parent: string | null, createdAt: number): SessionNode {
  return {
    id,
    parent,
    basedOn: "",
    forkAt: parent ? 2 : 0,
    title: id,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("the session family: root and members", () => {
  it("the main session is found by walking up from a child session", () => {
    const nodes = [node("main", null, 1), node("aux", "main", 2)];
    expect(sessionRoot("aux", nodes)).toBe("main");
    expect(resolveFamily("aux", nodes)?.rootId).toBe("main");
  });

  it("when the anchor is the main session it is its own root", () => {
    const nodes = [node("main", null, 1), node("aux", "main", 2)];
    expect(sessionRoot("main", nodes)).toBe("main");
  });

  it("chained forks: a grandchild session also comes back to the same main session", () => {
    const nodes = [node("main", null, 1), node("a", "main", 2), node("b", "a", 3)];
    expect(sessionRoot("b", nodes)).toBe("main");
    expect(sessionFamily("main", nodes).map((n) => n.id)).toEqual(["main", "a", "b"]);
  });

  it("when the parent record is gone the nearest node becomes the root, without throwing", () => {
    const nodes = [node("orphan", "gone", 5)];
    expect(sessionRoot("orphan", nodes)).toBe("orphan");
    expect(sessionFamily("orphan", nodes).map((n) => n.id)).toEqual(["orphan"]);
  });

  it("a cycle in parent stops instead of recursing forever", () => {
    const nodes = [node("a", "b", 1), node("b", "a", 2)];
    // Which node of the cycle becomes the root does not matter; what matters is that it terminates and that both nodes are in the family.
    const root = sessionRoot("a", nodes);
    expect(["a", "b"]).toContain(root);
    expect(sessionFamily(root, nodes).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("one parent with several children: all of them are restored, sorted by creation time", () => {
    const nodes = [node("main", null, 1), node("x", "main", 3), node("y", "main", 2)];
    expect(sessionFamily("main", nodes).map((n) => n.id)).toEqual(["main", "y", "x"]);
  });

  it("sessions of another family do not get mixed in", () => {
    const nodes = [
      node("main", null, 1),
      node("aux", "main", 2),
      node("other", null, 3),
      node("other-aux", "other", 4),
    ];
    expect(sessionFamily("main", nodes).map((n) => n.id)).toEqual(["main", "aux"]);
  });

  it("null when the anchor does not exist (the caller treats it as empty)", () => {
    expect(resolveFamily("nope", [node("main", null, 1)])).toBeNull();
  });

  it("a parent chain that points at an id outside the list stops at the last real node", () => {
    // The main session was deleted but its children remain: each child is its own root,
    // and none of them drags in the others.
    const nodes = [node("a", "gone", 1), node("b", "gone", 2)];

    expect(resolveFamily("a", nodes)?.rootId).toBe("a");
    expect(sessionFamily("a", nodes).map((n) => n.id)).toEqual(["a"]);
  });

  it("a family whose root is missing from the list is not returned (sessionFamily needs a real root)", () => {
    expect(sessionFamily("absent", [node("child", "absent", 1)])).toEqual([]);
    expect(resolveFamily("child", [node("child", "absent", 1)])?.members).toHaveLength(1);
  });

  it("members with the same creation time are ordered by id, so the list is stable", () => {
    const nodes = [node("root", null, 1), node("b", "root", 5), node("a", "root", 5)];

    expect(sessionFamily("root", nodes).map((n) => n.id)).toEqual(["root", "a", "b"]);
  });

  it("the root itself is the only member of a family with no forks", () => {
    expect(sessionFamily("solo", [node("solo", null, 1)]).map((n) => n.id)).toEqual(["solo"]);
  });

  it("an empty list has no family and no root", () => {
    expect(resolveFamily("x", [])).toBeNull();
    expect(sessionFamily("x", [])).toEqual([]);
    expect(sessionRoot("x", [])).toBe("x");
  });
});
