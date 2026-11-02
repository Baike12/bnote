import { describe, expect, it } from "vitest";
import {
  buildFootprintView,
  defaultFold,
  foldSig,
  toggleGroup,
  toggleZone,
} from "./view";

const entries = [
  { path: "/vault/Job/job todo.md", blocks: [{ text: "甲", start: 1, end: 1 }, { text: "乙", start: 3, end: 3 }] },
  { path: "/vault/研究/文献笔记.md", blocks: [{ text: "丙", start: 2, end: 2 }] },
];

describe("buildFootprintView", () => {
  it("grouped by source file, with the note name and the counts", () => {
    const view = buildFootprintView(entries);
    expect(view.fileCount).toBe(2);
    expect(view.blockCount).toBe(3);
    expect(view.groups.map((g) => g.label)).toEqual(["job todo", "文献笔记"]);
    expect(view.groups[0].blocks).toHaveLength(2);
  });

  it("an empty index gives zero counts and no groups", () => {
    expect(buildFootprintView([])).toEqual({ groups: [], fileCount: 0, blockCount: 0 });
  });

  it("the file name drops the directory and the .md; a path without a directory works as well", () => {
    const view = buildFootprintView([{ path: "/vault/readme.md", blocks: [] }]);
    expect(view.groups[0].label).toBe("readme");
  });
});

describe("fold state", () => {
  it("everything is expanded by default, the signature distinguishes the collapsed state", () => {
    const d = defaultFold();
    expect(d.zoneCollapsed).toBe(false);
    expect(d.groups.size).toBe(0);
    expect(foldSig(d)).toBe("Z");
    expect(foldSig(toggleZone(d))).toBe("z");
  });

  it("toggleZone flips at the zone level, the group state is untouched", () => {
    let s = defaultFold();
    s = toggleGroup(s, "/vault/a.md");
    const z = toggleZone(s);
    expect(z.zoneCollapsed).toBe(true);
    expect(z.groups.has("/vault/a.md")).toBe(true);
    expect(toggleZone(z).zoneCollapsed).toBe(false);
  });

  it("toggleGroup flips a single group, the signature changes with the collapsed set", () => {
    let s = defaultFold();
    s = toggleGroup(s, "/vault/a.md");
    expect(s.groups.has("/vault/a.md")).toBe(true);
    expect(foldSig(s)).toBe(foldSig(toggleGroup(defaultFold(), "/vault/a.md")));
    s = toggleGroup(s, "/vault/a.md");
    expect(s.groups.size).toBe(0);
    expect(foldSig(s)).toBe("Z");
  });

  it("the signature does not depend on the group order (set semantics)", () => {
    const a = toggleGroup(toggleGroup(defaultFold(), "/x.md"), "/y.md");
    const b = toggleGroup(toggleGroup(defaultFold(), "/y.md"), "/x.md");
    expect(foldSig(a)).toBe(foldSig(b));
  });
});
