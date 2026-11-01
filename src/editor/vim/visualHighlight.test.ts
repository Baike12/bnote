import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import {
  visualLineNumbers,
  visualRangeSpans,
  visualSelection,
  visualSelectionDecos,
} from "./vim";

/**
 * Geometry gate for the visual-mode highlight (the pure functions behind
 * vimVisualHighlight):
 * - Line set: the vim engine's sel (0-based line/ch) wins — linewise visual
 *   often keeps the CM selection empty, so the CM selection is the fallback
 *   only when the engine keeps no sel; a selection ending at a line start
 *   shrinks to the previous line.
 * - Exact range: charwise uses the selection the engine syncs into CM,
 *   blockwise slices the block per line by column.
 * - Painting ownership: once the selection is painted, CM's selection
 *   rectangle must yield (see the describe block below).
 */

// No trailing newline: CM's Text grows an extra phantom empty line for
// "…\n", which is unrelated to the geometry here.
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
    // Selection [0, 7): lines 1 and 2
    expect(visualLineNumbers(doc, { visualMode: true }, range(0, 7))).toEqual([1, 2]);
  });

  it("选区终点恰好落在某行行首:收缩到上一行(不算占据那一行)", () => {
    // [0, 12): 12 is the start of line 4 → only lines 1-3 are highlighted
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
 * The exact range (visualRangeSpans) and painting ownership
 * (visualSelectionDecos).
 * The root cause of the defect is "two painters for one state": CM's own
 * selection rectangle is derived from coordinates — horizontally from the
 * padding of .cm-line (this app puts its padding on .cm-content, so the
 * rectangle is wider than the line box and presses against the quote bar),
 * vertically from coordsAtPos(to, -2) (right next to a block-level widget the
 * coordinate falls inside the widget, growing a narrow tall gray band that
 * hangs below the selection). Once the decoration layer takes over, that
 * geometry comes from document coordinates. This gate locks two things: every
 * visual sub-mode can paint a correct range, and "painted ⇔ exclusively
 * painting" (the CM rectangle yields).
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
    // Five-line document: line 1 = [0,3), line 2 = [4,7)…; columns [1,4) cut
    // out [1,3) and [5,7)
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
    // Line 2 has only two columns and both block boundaries are past the line
    // end → that line has no range
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

describe("visualSelection:⌘⇧B 选中插入的选区(引擎 sel 坐标模型)", () => {
  const vstate = (a: Pos, h: Pos, opts: { line?: boolean; block?: boolean } = {}) => ({
    visualMode: true,
    visualLine: !!opts.line,
    visualBlock: !!opts.block,
    sel: { anchor: a, head: h },
  });

  it("linewise:整行(含行尾换行),范围为整行区间", () => {
    expect(visualSelection(doc, vstate({ line: 1, ch: 0 }, { line: 2, ch: 0 }, { line: true }))).toEqual({
      text: "第二行\n第三行",
      from: 4,
      to: 11,
    });
  });

  it("linewise 折叠(VV 不动):单行整行", () => {
    expect(visualSelection(doc, vstate({ line: 1, ch: 0 }, { line: 1, ch: 0 }, { line: true }))).toEqual({
      text: "第二行",
      from: 4,
      to: 7,
    });
  });

  it("linewise 反向(Jk 向上):与正向同一段文本与范围", () => {
    const forward = visualSelection(doc, vstate({ line: 1, ch: 0 }, { line: 3, ch: 0 }, { line: true }));
    const backward = visualSelection(doc, vstate({ line: 3, ch: 0 }, { line: 1, ch: 0 }, { line: true }));
    expect(backward).toEqual(forward);
    expect(forward).toEqual({ text: "第二行\n第三行\n第四行", from: 4, to: 15 });
  });

  it("blockwise:逐行取列区间(含头字符),范围是整块的行区间", () => {
    expect(
      visualSelection(doc, vstate({ line: 0, ch: 1 }, { line: 2, ch: 2 }, { block: true })),
    ).toEqual({ text: "一行\n二行\n三行", from: 0, to: 11 });
  });

  it("blockwise 列越界:钳到行尾(vim 的块选就是这样)", () => {
    expect(
      visualSelection(doc, vstate({ line: 0, ch: 2 }, { line: 1, ch: 9 }, { block: true })),
    ).toEqual({ text: "行\n行", from: 0, to: 7 });
  });

  it("charwise:锚点到光标的字符区间(含头字符)", () => {
    expect(visualSelection(doc, vstate({ line: 0, ch: 0 }, { line: 1, ch: 1 }))).toEqual({
      text: "第一行\n第二",
      from: 0,
      to: 6,
    });
  });

  it("charwise 反向(v 后向上移动):与正向同一区间", () => {
    const forward = visualSelection(doc, vstate({ line: 0, ch: 1 }, { line: 1, ch: 2 }));
    const backward = visualSelection(doc, vstate({ line: 1, ch: 2 }, { line: 0, ch: 1 }));
    expect(backward).toEqual(forward);
    expect(forward).toEqual({ text: "一行\n第二行", from: 1, to: 7 });
  });

  it("非 visual 模式 / 引擎没维护 sel:返回 null", () => {
    expect(visualSelection(doc, { visualMode: false, sel: { anchor: { line: 0, ch: 0 }, head: { line: 1, ch: 0 } } })).toBeNull();
    expect(visualSelection(doc, { visualMode: true })).toBeNull();
    expect(visualSelection(doc, null)).toBeNull();
  });

  it("行号越界钳制到文档范围(引擎 sel 可能瞬时指向文末之后)", () => {
    expect(visualSelection(doc, vstate({ line: 2, ch: 0 }, { line: 99, ch: 0 }, { line: true }))).toEqual({
      text: "第三行\n第四行",
      from: 8,
      to: 15,
    });
  });
});
