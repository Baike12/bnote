import { describe, expect, it } from "vitest";
import { mergeDocs } from "./merge";

/** The canonical day document shape the engine writes: header, entries, prose. */
function doc(entries: string[], below = "下午写点别的。"): string {
  return `# 2026-11-19\n\n${entries.join("\n")}\n\n${below}\n`;
}

describe("mergeDocs — content edits", () => {
  it("keeps both sides when different entries change on each", () => {
    const base = doc(["- [ ] 甲", "- [ ] 乙"]);
    const local = doc(["- [x] 甲 ✅ 2026-11-19", "- [ ] 乙"]);
    const remote = doc(["- [ ] 甲", "- [ ] 乙(改)"]);
    expect(mergeDocs(base, local, remote)).toBe(doc(["- [x] 甲 ✅ 2026-11-19", "- [ ] 乙(改)"]));
  });

  it("renaming the same entry on both sides keeps both texts (text is identity)", () => {
    // Editing an entry's text deletes one identity and adds another, so two
    // divergent renames of one line keep both versions — nothing is lost.
    const base = doc(["- [ ] 甲"]);
    expect(mergeDocs(base, doc(["- [ ] 甲本地"]), doc(["- [ ] 甲远端"]))).toBe(
      doc(["- [ ] 甲本地", "- [ ] 甲远端"]),
    );
  });

  it("local wins when both sides changed the same entry without renaming", () => {
    const base = doc(["- [ ] 甲"]);
    expect(mergeDocs(base, doc(["- [x] 甲 ✅ 2026-11-19"]), doc(["- [X] 甲"]))).toBe(
      doc(["- [x] 甲 ✅ 2026-11-19"]),
    );
  });

  it("a remote edit survives a local deletion (modify beats delete)", () => {
    const base = doc(["- [ ] 甲", "- [ ] 乙"]);
    const local = doc(["- [ ] 乙"]); // 甲 deleted locally
    const remote = doc(["- [ ] 甲(手机上改了)", "- [ ] 乙"]);
    expect(mergeDocs(base, local, remote)).toBe(doc(["- [ ] 乙", "- [ ] 甲(手机上改了)"]));
  });

  it("a local deletion stands when remote did not touch the entry", () => {
    const base = doc(["- [ ] 甲", "- [ ] 乙"]);
    const local = doc(["- [ ] 乙"]);
    expect(mergeDocs(base, local, base)).toBe(doc(["- [ ] 乙"]));
  });

  it("identical text added on both sides collapses into one entry", () => {
    const base = doc(["- [ ] 甲"]);
    const added = doc(["- [ ] 甲", "- [ ] 新项"]);
    expect(mergeDocs(base, added, added)).toBe(added);
  });

  it("a rename and a remote completion of the same entry keep both", () => {
    // 文本即身份：本地改标题算"删旧加新"，远端勾选算"旧条目被修改"——
    // 修改战胜删除，两条都留下，谁也不丢。
    const base = doc(["- [ ] 写周报"]);
    const local = doc(["- [ ] 写季度周报"]);
    const remote = doc(["- [x] 写周报 ✅ 2026-11-19"]);
    // The restored entry keeps its base position; the rename lands after it
    // as an addition.
    expect(mergeDocs(base, local, remote)).toBe(
      doc(["- [x] 写周报 ✅ 2026-11-19", "- [ ] 写季度周报"]),
    );
  });
});

describe("mergeDocs — additions and order", () => {
  it("appends entries added on either side", () => {
    const base = doc(["- [ ] 甲"]);
    const local = doc(["- [ ] 甲", "- [ ] 本地新增"]);
    const remote = doc(["- [ ] 甲", "- [ ] 远端新增"]);
    expect(mergeDocs(base, local, remote)).toBe(
      doc(["- [ ] 甲", "- [ ] 本地新增", "- [ ] 远端新增"]),
    );
  });

  it("creates a whole document from two empty sides", () => {
    const remote = "- [ ] 从网页加的\n";
    expect(mergeDocs("", "", remote)).toBe(remote);
  });

  it("follows the remote order when local did not reorder", () => {
    const base = doc(["- [ ] 甲", "- [ ] 乙", "- [ ] 丙"]);
    const local = base; // untouched
    const remote = doc(["- [ ] 丙", "- [ ] 甲", "- [ ] 乙"]);
    expect(mergeDocs(base, local, remote)).toBe(remote);
  });

  it("follows the local order when local reordered", () => {
    const base = doc(["- [ ] 甲", "- [ ] 乙", "- [ ] 丙"]);
    const local = doc(["- [ ] 丙", "- [ ] 甲", "- [ ] 乙"]);
    const remote = doc(["- [ ] 甲", "- [ ] 丙", "- [ ] 乙"]); // also reordered, differently
    expect(mergeDocs(base, local, remote)).toBe(doc(["- [ ] 丙", "- [ ] 甲", "- [ ] 乙"]));
  });

  it("keeps subtrees attached when the parent moves", () => {
    const base = doc(["- [ ] 甲", "  - 甲的子项", "- [ ] 乙"]);
    const local = doc(["- [ ] 乙", "- [ ] 甲", "  - 甲的子项"]);
    expect(mergeDocs(base, local, base)).toBe(doc(["- [ ] 乙", "- [ ] 甲", "  - 甲的子项"]));
  });
});

describe("mergeDocs — header and prose", () => {
  it("the prose side that changed keeps its version", () => {
    const base = doc(["- [ ] 甲"], "原始正文");
    const local = doc(["- [ ] 甲"], "本地改的正文");
    const remote = doc(["- [ ] 甲"], "原始正文");
    expect(mergeDocs(base, local, remote)).toBe(doc(["- [ ] 甲"], "本地改的正文"));
  });

  it("remote prose wins when the local side did not touch it", () => {
    const base = doc(["- [ ] 甲"], "原始正文");
    const remote = doc(["- [ ] 甲"], "手机上补的一段");
    expect(mergeDocs(base, base, remote)).toBe(doc(["- [ ] 甲"], "手机上补的一段"));
  });

  it("keeps prose edits and remote todo edits in one document", () => {
    const base = doc(["- [ ] 甲"], "原始正文");
    const local = doc(["- [x] 甲 ✅ 2026-11-19"], "原始正文");
    const remote = doc(["- [ ] 甲"], "手机上补的一段");
    expect(mergeDocs(base, local, remote)).toBe(doc(["- [x] 甲 ✅ 2026-11-19"], "手机上补的一段"));
  });

  it("is a no-op when all three sides agree", () => {
    const doc1 = doc(["- [ ] 甲", "- [x] 乙 ✅ 2026-11-18"]);
    expect(mergeDocs(doc1, doc1, doc1)).toBe(doc1);
  });
});
