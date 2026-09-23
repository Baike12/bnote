import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { visualLineNumbers } from "./vim";

/**
 * Visual 模式行高亮的几何门禁（vimVisualHighlight 的纯函数体）：
 * vim 引擎的 sel（0 基 line/ch）优先——linewise visual 常保持 CM 选区为空，
 * 引擎没维护 sel 时才退回 CM 选区；行尾起点的选区收缩到上一行。
 */

// 不带尾随换行:CM 的 Text 对 "…\n" 会多出一个幻影空行,与这里的几何无关。
const doc = EditorState.create({ doc: "第一行\n第二行\n第三行\n第四行" }).doc;

interface Pos {
  line: number;
  ch: number;
}
const sel = (anchor: Pos, head: Pos, visualLine = false) => ({
  visualMode: true,
  visualLine,
  sel: { anchor, head },
});
const range = (from: number, to: number) => [{ from, to, empty: from === to }];

describe("visualLineNumbers:引擎 sel 路径", () => {
  it("linewise 正向 Vj:anchor/head 行区间全亮(即使 CM 选区为空)", () => {
    const lines = visualLineNumbers(doc, sel({ line: 1, ch: 0 }, { line: 3, ch: 0 }), [
      { from: 0, to: 0, empty: true },
    ]);
    expect(lines).toEqual([2, 3, 4]);
  });

  it("charwise 反向选择与正向同一集合", () => {
    const forward = visualLineNumbers(doc, sel({ line: 2, ch: 1 }, { line: 3, ch: 2 }), []);
    const backward = visualLineNumbers(doc, sel({ line: 3, ch: 2 }, { line: 2, ch: 1 }), []);
    expect(forward).toEqual([3, 4]);
    expect(backward).toEqual(forward);
  });

  it("charwise 折叠选区(vv 后光标没动):无高亮行", () => {
    expect(visualLineNumbers(doc, sel({ line: 1, ch: 0 }, { line: 1, ch: 0 }), [])).toEqual([]);
  });

  it("visualLine(VV)折叠选区也是整行", () => {
    expect(visualLineNumbers(doc, sel({ line: 1, ch: 0 }, { line: 1, ch: 0 }, true), [])).toEqual([
      2,
    ]);
  });

  it("行号越界钳制到文档范围(引擎 sel 可能瞬时指向文档末行之后)", () => {
    const lines = visualLineNumbers(doc, sel({ line: 2, ch: 0 }, { line: 99, ch: 0 }), []);
    expect(lines).toEqual([3, 4]);
  });
});

describe("visualLineNumbers:CM 选区回退路径(引擎没维护 sel)", () => {
  it("非空 CM 选区覆盖的行全亮", () => {
    // 选区 [0, 7):行 1 与行 2
    expect(visualLineNumbers(doc, { visualMode: true }, range(0, 7))).toEqual([1, 2]);
  });

  it("选区终点恰好落在某行行首:收缩到上一行(不算占据那一行)", () => {
    // [0, 12):12 是第 4 行行首 → 只亮行 1-3
    expect(visualLineNumbers(doc, { visualMode: true }, range(0, 12))).toEqual([1, 2, 3]);
  });

  it("空 CM 选区不产生高亮", () => {
    expect(visualLineNumbers(doc, { visualMode: true }, range(4, 4))).toEqual([]);
  });
});

describe("visualLineNumbers:非 visual 模式", () => {
  it("visualMode 关闭时恒为空(normal/insert 模式翻转回高亮消失)", () => {
    expect(visualLineNumbers(doc, null, range(0, 15))).toEqual([]);
    expect(visualLineNumbers(doc, { visualMode: false }, range(0, 15))).toEqual([]);
  });
});
