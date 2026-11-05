import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { renumberChanges } from "./numbering";

/** Runs one renumbering pass, applies all replacements and returns the resulting text. */
function renumber(text: string): string {
  const state = EditorState.create({ doc: text });
  return state.update({ changes: renumberChanges(state) }).state.doc.toString();
}

describe("the callout scope of heading numbering", () => {
  it("headings inside a block are renumbered from 1, the sequence outside continues as if the block did not exist", () => {
    expect(renumber("# 一\n:::\n## 定理\n:::\n# 二\n## 节")).toBe(
      "# 1 一\n:::\n## 1 定理\n:::\n# 2 二\n## 2.1 节",
    );
  });

  it("two consecutive blocks each start from 1", () => {
    expect(renumber(":::\n## 甲\n:::\n:::\n## 乙\n:::")).toBe(
      ":::\n## 1 甲\n:::\n:::\n## 1 乙\n:::",
    );
  });

  it("nested blocks reset level by level, and leaving a block restores the outer count level by level", () => {
    expect(renumber(":::\n## 甲\n::: 内\n## 乙\n:::\n## 丙\n:::\n# 后")).toBe(
      ":::\n## 1 甲\n::: 内\n## 1 乙\n:::\n## 2 丙\n:::\n# 1 后",
    );
  });

  it("old numbers inside a block are normalized too, and a second run is idempotent", () => {
    const once = renumber(":::\n## 3.1 旧\n### 2 深\n:::");
    expect(once).toBe(":::\n## 1 旧\n### 1.1 深\n:::");
    expect(renumber(once)).toBe(once);
  });

  it("a # line inside a fenced code block and a callout marker line are not headings", () => {
    expect(renumber(":::\n```\n## 不算\n```\n:::\n# 一")).toBe(
      ":::\n```\n## 不算\n```\n:::\n# 1 一",
    );
  });
});
