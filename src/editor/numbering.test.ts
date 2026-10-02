import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { renumberChanges } from "./numbering";

/** 跑一遍重编号并应用所有替换,返回结果文本。 */
function renumber(text: string): string {
  const state = EditorState.create({ doc: text });
  return state.update({ changes: renumberChanges(state) }).state.doc.toString();
}

describe("标题编号的 callout 作用域", () => {
  it("块内标题从 1 重新数,块外序列像块内不存在一样继续", () => {
    expect(
      renumber("# 一\n:::\n## 定理\n:::\n# 二\n## 节"),
    ).toBe("# 1 一\n:::\n## 1 定理\n:::\n# 2 二\n## 2.1 节");
  });

  it("先后两个块各自从 1", () => {
    expect(renumber(":::\n## 甲\n:::\n:::\n## 乙\n:::")).toBe(
      ":::\n## 1 甲\n:::\n:::\n## 1 乙\n:::",
    );
  });

  it("嵌套块逐层重置,出块逐层恢复外层计数", () => {
    expect(renumber(":::\n## 甲\n::: 内\n## 乙\n:::\n## 丙\n:::\n# 后")).toBe(
      ":::\n## 1 甲\n::: 内\n## 1 乙\n:::\n## 2 丙\n:::\n# 1 后",
    );
  });

  it("块内旧编号也被规范化,二次运行幂等", () => {
    const once = renumber(":::\n## 3.1 旧\n### 2 深\n:::");
    expect(once).toBe(":::\n## 1 旧\n### 1.1 深\n:::");
    expect(renumber(once)).toBe(once);
  });

  it("围栏代码里的 # 行与 callout 标记行都不是标题", () => {
    expect(renumber(":::\n```\n## 不算\n```\n:::\n# 一")).toBe(
      ":::\n```\n## 不算\n```\n:::\n# 1 一",
    );
  });
});
