import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { activeLineDecos } from "./vim";

/**
 * 门禁：当前行底 shade 的可见性判据必须与引擎块光标（cm-vimMode 类）逐字一致
 * ——`!insertMode || overwrite`。回归的样子有两条：insert 态又发出 shade（说明
 * 判据写回成了 highlightActiveLine 的无条件绘制），或以 scroller 的
 * `.cm-vimMode` 祖先类做条件（宽域样式失效回来，Esc/i 每次罩住整个视口子树）。
 */

const state = (cursors: number[]) =>
  EditorState.create({
    doc: "第一行\n第二行\n第三行\n",
    // 多段选区必须开着这个 facet 才会在 EditorState.create 里活下来——与
    // setup.ts 的真实装配一致(vim blockwise 依赖同一条)。
    extensions: [EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create(cursors.map((h) => EditorSelection.cursor(h))),
  });

describe("activeLine 装饰", () => {
  it("insert 态（不画块光标）不发装饰", () => {
    expect(activeLineDecos(state([4]), false).size).toBe(0);
  });

  it("块光标态给 head 行挂 cm-activeLine（行首点装饰）", () => {
    const decos = activeLineDecos(state([4]), true);
    expect(decos.size).toBe(1);
    const cursor = decos.iter();
    expect(cursor.from).toBe(4); // "第二行" 行首
    expect(cursor.to).toBe(4);
    const spec = cursor.value?.spec as { class: string } | undefined;
    expect(spec?.class).toContain("cm-activeLine");
  });

  it("多 range 同行去重、异行各一行", () => {
    expect(activeLineDecos(state([1, 2]), true).size).toBe(1); // 同在第一行
    expect(activeLineDecos(state([1, 5]), true).size).toBe(2); // 第一/二行
  });
});
