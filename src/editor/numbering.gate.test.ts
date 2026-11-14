import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { numberingMayChange, renumberChanges } from "./numbering";

/**
 * `numberingMayChange` is the per-keystroke gate in front of the heading
 * renumber scan. It must be a **superset** of every change that can alter a
 * number: a false negative leaves a stale number on screen until the next
 * structural edit. Concretely only `#`, `:`, a newline, or an edit inside the
 * first few columns of a line (which can expose or hide a column-0 heading)
 * can matter; typing ordinary title/body text cannot.
 */
function transaction(doc: string, from: number, to: number, insert: string): Transaction {
  const state = EditorState.create({ doc });
  return state.update({ changes: { from, to, insert } });
}

const changed = (doc: string, from: number, to: number, insert: string): boolean =>
  numberingMayChange([transaction(doc, from, to, insert)]);

describe("numberingMayChange: characters that really build or break a heading", () => {
  it("typing `#` at a line start asks for a renumber", () => {
    expect(changed("abc", 0, 0, "#")).toBe(true);
  });

  it("typing `#` in the middle of the text asks for a renumber (cheap superset)", () => {
    expect(changed("abcdef", 3, 3, "#")).toBe(true);
  });

  it("a newline asks for a renumber (the line structure changes)", () => {
    expect(changed("abc", 3, 3, "\n")).toBe(true);
  });

  it("a colon asks for a renumber (it can open or close a callout scope)", () => {
    expect(changed("abc", 0, 0, ":")).toBe(true);
  });

  it("deleting a `#` asks for a renumber (the removed text matters, not the inserted one)", () => {
    expect(changed("# abc", 0, 1, "")).toBe(true);
  });
});

describe("numberingMayChange: edits touching the heading prefix columns", () => {
  it("an insertion in the first columns of a line asks for a renumber (the heading may appear or vanish)", () => {
    expect(changed("abc", 2, 2, "x")).toBe(true);
  });

  it("a deletion in the first columns asks too", () => {
    expect(changed("abcdef", 1, 3, "")).toBe(true);
  });

  it("an edit deep inside a line asks too, because the removed range can start early", () => {
    // The startState column is what counts: from=3 is still within the first
    // four characters of the line.
    expect(changed("abcdef", 3, 4, "z")).toBe(true);
  });
});

describe("numberingMayChange: edits that cannot alter numbering", () => {
  it("typing ordinary text far from the line start does not ask for a renumber", () => {
    expect(changed("a very long body line", 12, 12, "x")).toBe(false);
  });

  it("a change far inside a long document does not ask", () => {
    const doc = "a very long first line\nand a second line here";
    expect(changed(doc, 20, 20, "zz")).toBe(false);
  });

  it("a selection-only transaction does not ask", () => {
    const state = EditorState.create({ doc: "# title" });
    const tr = state.update({ selection: { anchor: 2 } });
    expect(numberingMayChange([tr])).toBe(false);
  });

  it("an empty transaction list does not ask", () => {
    expect(numberingMayChange([])).toBe(false);
  });

  it("one qualifying transaction among several is enough", () => {
    const state = EditorState.create({ doc: "aaaaaaaaaaaaaaaaaaaa\n# heading" });
    const plain = state.update({ changes: { from: 18, insert: "x" } });
    const heading = plain.state.update({ changes: { from: 18, insert: "#" } });
    expect(numberingMayChange([plain, heading])).toBe(true);
  });

  it("several non-qualifying transactions together still do not ask", () => {
    const state = EditorState.create({ doc: "a long body line, words" });
    const one = state.update({ changes: { from: 12, insert: "x" } });
    const two = one.state.update({ changes: { from: 20, insert: "y" } });
    expect(numberingMayChange([one, two])).toBe(false);
  });
});

describe("renumberChanges: the numbering model behind the gate", () => {
  const renumber = (text: string) => {
    const state = EditorState.create({ doc: text });
    return state.update({ changes: renumberChanges(state) }).state.doc.toString();
  };

  it("a document whose numbering is already correct produces no changes", () => {
    const state = EditorState.create({ doc: "# 1 一\n## 1.1 节" });
    expect(renumberChanges(state)).toEqual([]);
  });

  it("`##` as the first heading numbers as 1, not 0.1 (the leading zero part is dropped)", () => {
    expect(renumber("## 甲")).toBe("## 1 甲");
  });

  it("a heading with no title keeps a number without a trailing space", () => {
    expect(renumber("# ")).toBe("# 1");
  });

  it("a heading inside a tilde fence is not numbered", () => {
    expect(renumber("~~~\n# 注释\n~~~\n# 正文")).toBe("~~~\n# 注释\n~~~\n# 1 正文");
  });

  it("a heading indented under a list item is not numbered (only column-0 headings count)", () => {
    expect(renumber("  # 非标题")).toBe("  # 非标题");
  });

  it("H7+ is not a heading", () => {
    expect(renumber("####### 七")).toBe("####### 七");
  });

  it("levels deeper than the previous heading reset when a shallower one appears", () => {
    expect(renumber("# 一\n### 深\n## 二\n### 深二")).toBe(
      "# 1 一\n### 1.0.1 深\n## 1.1 二\n### 1.1.1 深二",
    );
  });
});
