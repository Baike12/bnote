import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { visualLineNumbers, visualRangeSpans, visualSelectionDecos } from "./vim";

/**
 * Visual 模式高亮的几何门禁（vimVisualHighlight 的纯函数体）：
 * - 行集合：vim 引擎的 sel（0 基 line/ch）优先——linewise visual 常保持 CM 选区
 *   为空，引擎没维护 sel 时才退回 CM 选区；行尾起点的选区收缩到上一行。
 * - 精确范围：charwise 用引擎同步进 CM 的选区，blockwise 按列逐行切块。
 * - 绘制所有权：画了选区就必须让 CM 的选区矩形让位（见下方 describe）。
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

/**
 * 精确范围（visualRangeSpans）与绘制所有权（visualSelectionDecos）。
 * 缺陷根因是"同一个状态两个绘制者"：CM 自己的选区矩形是坐标推导的，横向按
 * .cm-line 的 padding 算（本应用留白在 .cm-content 上）、纵向末端向
 * coordsAtPos(to, -2) 取值（紧邻块级 widget 时落进 widget 内部 → 悬在选区下方
 * 的窄长灰带）。装饰层接管后这些几何都由文档坐标给出。这里的门禁锁两件事：
 * 每种 visual 子模式都画得出正确的范围；以及"画了 ⇔ 独占绘制"（CM 矩形让位）。
 */

const spanDoc = EditorState.create({ doc: "第一行\n第二行\n第三行\n第四行\n第五行" }).doc;
const span = (from: number, to: number) => ({ from, to });

describe("visualRangeSpans:charwise 精确范围", () => {
  it("引擎同步到 CM 的选区原样作为绘制范围(含头字符由引擎保证)", () => {
    expect(
      visualRangeSpans(spanDoc, sel({ line: 1, ch: 3 }, { line: 1, ch: 7 }), [span(7, 12)]),
    ).toEqual([span(7, 12)]);
  });

  it("跨行 charwise 一个范围覆盖全文跨度", () => {
    expect(
      visualRangeSpans(spanDoc, sel({ line: 0, ch: 0 }, { line: 2, ch: 2 }), [span(0, 12)]),
    ).toEqual([span(0, 12)]);
  });

  it("刚按 v 还没动的折叠选区不画(返回空)", () => {
    expect(visualRangeSpans(spanDoc, sel({ line: 1, ch: 3 }, { line: 1, ch: 3 }), [])).toEqual([]);
  });

  it("linewise 交给行带,这里返回空(避免同色叠加加深)", () => {
    const linewise = {
      visualMode: true,
      visualLine: true,
      sel: { anchor: { line: 1, ch: 0 }, head: { line: 3, ch: 0 } },
    };
    expect(visualRangeSpans(spanDoc, linewise, [span(4, 16)])).toEqual([]);
  });
});

describe("visualRangeSpans:blockwise 逐行切块", () => {
  const block = (anchor: Pos, head: Pos) => ({
    visualMode: true,
    visualBlock: true,
    sel: { anchor, head },
  });

  it("块形状按列区间逐行切出(不是整行,也不是只有光标那一行)", () => {
    // 五行文档:行 1 = [0,3),行 2 = [4,7)…;列 [1,4) 切出 [1,3) 与 [5,7)
    expect(visualRangeSpans(spanDoc, block({ line: 0, ch: 1 }, { line: 1, ch: 3 }), [])).toEqual([
      span(1, 3),
      span(5, 7),
    ]);
  });

  it("反向块(head 在 anchor 上方)与正向同一集合", () => {
    const forward = visualRangeSpans(spanDoc, block({ line: 0, ch: 1 }, { line: 1, ch: 3 }), []);
    const backward = visualRangeSpans(spanDoc, block({ line: 1, ch: 3 }, { line: 0, ch: 1 }), []);
    expect(backward).toEqual(forward);
  });

  it("列越界的行钳到行尾,整行落在块外的行不产出零宽范围", () => {
    const blockDoc = EditorState.create({ doc: "abcdef\n\nxyz" }).doc;
    // 行 2 只有两列,块的两个边界都在行尾之后 → 该行无范围
    expect(visualRangeSpans(blockDoc, block({ line: 0, ch: 2 }, { line: 2, ch: 9 }), [])).toEqual([
      span(2, 6),
      span(10, 11),
    ]);
  });
});

describe("visualSelectionDecos:绘制所有权", () => {
  const decoClasses = (set: DecorationSet, length: number) => {
    const out: string[] = [];
    set.between(0, length, (from, to, deco) => {
      const cls = (deco as unknown as { spec: { class?: string } }).spec.class ?? "?";
      out.push(`${cls}@${from}..${to}`);
    });
    return out;
  };

  it("charwise:行带(提示色) + 一个精确范围 mark(尺寸 = 行数 + 1)", () => {
    const set = visualSelectionDecos(spanDoc, sel({ line: 1, ch: 3 }, { line: 1, ch: 7 }), [
      span(7, 12),
    ]);
    expect(set.size).toBe(2);
    expect(decoClasses(set, spanDoc.length)).toEqual([
      "cm-vimVisualLineHint@4..4",
      "cm-vimVisualRange@7..12",
    ]);
  });

  it("blockwise:每行一条带(提示色) + 每行一个范围", () => {
    const set = visualSelectionDecos(
      spanDoc,
      {
        visualMode: true,
        visualBlock: true,
        sel: { anchor: { line: 0, ch: 1 }, head: { line: 1, ch: 3 } },
      },
      [],
    );
    expect(set.size).toBe(4);
    expect(decoClasses(set, spanDoc.length)).toEqual([
      "cm-vimVisualLineHint@0..0",
      "cm-vimVisualRange@1..3",
      "cm-vimVisualLineHint@4..4",
      "cm-vimVisualRange@5..7",
    ]);
  });

  it("linewise:只有选区本色的行带(自己就是选区,不需要提示色)", () => {
    const set = visualSelectionDecos(
      spanDoc,
      {
        visualMode: true,
        visualLine: true,
        sel: { anchor: { line: 1, ch: 0 }, head: { line: 3, ch: 0 } },
      },
      [],
    );
    expect(set.size).toBe(3);
    expect(decoClasses(set, spanDoc.length)).toEqual([
      "cm-vimVisualLine@4..4",
      "cm-vimVisualLine@8..8",
      "cm-vimVisualLine@12..12",
    ]);
  });

  it("没有绘制者 ⇔ 空集(折叠选区/非 visual 模式都不得拦住 CM 自己的选区矩形)", () => {
    expect(visualSelectionDecos(spanDoc, null, [span(0, 10)]).size).toBe(0);
    expect(visualSelectionDecos(spanDoc, { visualMode: false }, [span(0, 10)]).size).toBe(0);
    expect(
      visualSelectionDecos(spanDoc, sel({ line: 1, ch: 3 }, { line: 1, ch: 3 }), []).size,
    ).toBe(0);
  });
});
