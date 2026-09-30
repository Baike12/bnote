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
  it("按源文件分组,带笔记名与计数", () => {
    const view = buildFootprintView(entries);
    expect(view.fileCount).toBe(2);
    expect(view.blockCount).toBe(3);
    expect(view.groups.map((g) => g.label)).toEqual(["job todo", "文献笔记"]);
    expect(view.groups[0].blocks).toHaveLength(2);
  });

  it("空索引是零计数、无组", () => {
    expect(buildFootprintView([])).toEqual({ groups: [], fileCount: 0, blockCount: 0 });
  });

  it("文件名剥目录与 .md;无目录路径照常", () => {
    const view = buildFootprintView([{ path: "/vault/readme.md", blocks: [] }]);
    expect(view.groups[0].label).toBe("readme");
  });
});

describe("折叠状态", () => {
  it("默认全部展开,签名区分收起态", () => {
    const d = defaultFold();
    expect(d.zoneCollapsed).toBe(false);
    expect(d.groups.size).toBe(0);
    expect(foldSig(d)).toBe("Z");
    expect(foldSig(toggleZone(d))).toBe("z");
  });

  it("toggleZone 在区级翻转,组状态不动", () => {
    let s = defaultFold();
    s = toggleGroup(s, "/vault/a.md");
    const z = toggleZone(s);
    expect(z.zoneCollapsed).toBe(true);
    expect(z.groups.has("/vault/a.md")).toBe(true);
    expect(toggleZone(z).zoneCollapsed).toBe(false);
  });

  it("toggleGroup 翻转单个组,签名随收起集变化", () => {
    let s = defaultFold();
    s = toggleGroup(s, "/vault/a.md");
    expect(s.groups.has("/vault/a.md")).toBe(true);
    expect(foldSig(s)).toBe(foldSig(toggleGroup(defaultFold(), "/vault/a.md")));
    s = toggleGroup(s, "/vault/a.md");
    expect(s.groups.size).toBe(0);
    expect(foldSig(s)).toBe("Z");
  });

  it("签名与组序无关(集合语义)", () => {
    const a = toggleGroup(toggleGroup(defaultFold(), "/x.md"), "/y.md");
    const b = toggleGroup(toggleGroup(defaultFold(), "/y.md"), "/x.md");
    expect(foldSig(a)).toBe(foldSig(b));
  });
});
