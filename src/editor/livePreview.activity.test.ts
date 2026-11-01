import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  buildInlineDecorations,
  blockDecorationsField,
  selectionAffectsDecos,
} from "./livePreview";
import {
  ListBulletWidget,
  MathInlinePreviewWidget,
  MathPreviewWidget,
  MathWidget,
  TaskCheckboxWidget,
} from "./widgets";

const DOC = [
  "- [ ] task item",
  "- [x] done item",
  "- bullet item",
  "  - nested item",
  "1. ordered item",
].join("\n");

function decosAt(state: EditorState, from: number, to: number) {
  const view = { state, visibleRanges: [{ from: 0, to: state.doc.length }] };
  const set = buildInlineDecorations(view);
  const out: { from: number; to: number; deco: unknown }[] = [];
  set.between(from, to, (f, t, deco) => {
    out.push({ from: f, to: t, deco });
  });
  return out;
}

function widgetOf(entry: { deco: unknown }): unknown {
  const spec = (entry.deco as { spec?: { widget?: unknown } }).spec;
  return spec?.widget;
}

function makeState(selectionCol: { line: number; col: number }): EditorState {
  const created = EditorState.create({
    doc: DOC,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
  ensureSyntaxTree(created, created.doc.length);
  const line = created.doc.line(selectionCol.line);
  return created
    .update({ selection: EditorSelection.cursor(line.from + selectionCol.col) })
    .state;
}

/**
 * Locks down live preview's "token range activity rule": a list marker flips
 * back to source only when the caret lands on the marker characters
 * themselves; elsewhere on the line it stays in the rendered state. The
 * pixel-anchored landing point of j/k (verticalMotion) depends on the
 * geometric stability of this rule.
 */
describe("livePreview 列表标记的 token 活动规则", () => {
  const line1 = () => DOC.split("\n")[0];

  it("光标在正文上（标记范围外）：任务行保持渲染态（checkbox + 隐藏 `- `）", () => {
    const state = makeState({ line: 1, col: 6 });
    const entries = decosAt(state, 0, line1().length + 1);
    const widgets = entries.map(widgetOf);
    expect(widgets.some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    // `- ` is hidden by an empty replace (the li-t mark slot folds into the space before the checkbox).
    expect(
      entries.some(
        (e) => e.from === 0 && widgetOf(e) === undefined && e.to === 2,
      ),
    ).toBe(true);
  });

  it("光标在 `[ ]` 内：checkbox 翻回源码，`- ` 仍隐藏", () => {
    const state = makeState({ line: 1, col: 3 });
    const entries = decosAt(state, 0, line1().length + 1);
    expect(entries.map(widgetOf).some((w) => w instanceof TaskCheckboxWidget)).toBe(false);
    expect(entries.some((e) => e.from === 0 && e.to === 2 && widgetOf(e) === undefined)).toBe(
      true,
    );
  });

  it("光标在行首：`-` 翻回源码，checkbox 保持渲染态", () => {
    const state = makeState({ line: 1, col: 0 });
    const entries = decosAt(state, 0, line1().length + 1);
    expect(entries.map(widgetOf).some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    expect(entries.some((e) => e.from === 0 && e.to === 2 && widgetOf(e) === undefined)).toBe(
      false,
    );
  });

  it("无序列表：光标在标记外渲染 bullet，压在 `-` 上翻回源码", () => {
    const line3From = DOC.split("\n").slice(0, 2).join("\n").length + 1;
    const rendered = makeState({ line: 3, col: 5 });
    expect(
      decosAt(rendered, line3From, line3From + 15)
        .map(widgetOf)
        .some((w) => w instanceof ListBulletWidget),
    ).toBe(true);
    const active = makeState({ line: 3, col: 0 });
    expect(
      decosAt(active, line3From, line3From + 15)
        .map(widgetOf)
        .some((w) => w instanceof ListBulletWidget),
    ).toBe(false);
  });

  it("嵌套项：前导缩进空格在活动行也被隐藏（布局不随光标位移的另一半）", () => {
    const state = makeState({ line: 4, col: 6 });
    const nestedFrom = DOC.split("\n").slice(0, 3).join("\n").length + 1;
    const entries = decosAt(state, nestedFrom, nestedFrom + 4);
    // the two leading spaces are hidden by a replace; the li-i2 line decoration handles the indent.
    expect(entries.some((e) => e.from === nestedFrom && e.to === nestedFrom + 2)).toBe(true);
  });

  it("有序列表：数字标记两种状态下都保留原文（无几何翻转）", () => {
    const orderedFrom = DOC.split("\n").slice(0, 4).join("\n").length + 1;
    // Invariant: no state has a replace decoration covering the number
    // marker — the geometry of an ordered line stays stable as the caret
    // enters and leaves (which is also the precondition for a constant .li-o
    // slot width).
    const bareReplaceOverMark = (state: EditorState) =>
      decosAt(state, orderedFrom, orderedFrom + 2).filter(
        (e) =>
          e.from !== e.to &&
          e.from < orderedFrom + 2 &&
          e.to > orderedFrom &&
          !(e.deco as { spec?: { widget?: unknown } }).spec?.widget &&
          !(e.deco as { spec?: { class?: string } }).spec?.class,
      );
    expect(bareReplaceOverMark(makeState({ line: 5, col: 0 }))).toEqual([]);
    expect(bareReplaceOverMark(makeState({ line: 5, col: 4 }))).toEqual([]);
    // In the rendered state the number marker carries the md-listmark coloring.
    const rendered = decosAt(makeState({ line: 5, col: 6 }), orderedFrom, orderedFrom + 2);
    expect(rendered.some((e) => e.from === orderedFrom && e.to === orderedFrom + 2)).toBe(true);
  });
});

/**
 * The "text anchor" rule of an empty list item: if the marker's replace
 * decoration swallows the trailing whitespace, the line has no text node at
 * all, and WebKit cannot compute a rectangle for a caret resting at the start
 * of the item (the drawing degenerates to the edge of the line content, i.e.
 * after continuing a list with Enter the caret flashes to the line start).
 * The trailing space must be kept while the caret rests at the item start.
 */
describe("空列表项的文本锚点（keepMarkerTrailingSpace）", () => {
  const makeDocState = (doc: string, pos: number) => {
    const created = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    return created.update({ selection: EditorSelection.cursor(pos) }).state;
  };
  const covered = (entries: { from: number; to: number }[], pos: number) =>
    entries.some((e) => e.from !== e.to && e.from <= pos && e.to > pos);

  it("空待办项 `- [ ] ` 光标在项首：checkbox 不吞行尾空格", () => {
    const entries = decosAt(makeDocState("- [ ] ", 6), 0, 8);
    // the checkbox is still there ([2,5)), but the trailing space [5,6) stays visible.
    expect(entries.map(widgetOf).some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    expect(covered(entries, 4)).toBe(true);
    expect(covered(entries, 5)).toBe(false);
  });

  it("空待办项光标在行首：checkbox 照常吞空格（行首有 raw `-` 作锚点）", () => {
    const entries = decosAt(makeDocState("- [ ] ", 0), 0, 8);
    expect(covered(entries, 5)).toBe(true);
  });

  it("非空待办项 `- [ ] foo` 光标在项首：空格照常吞掉（正文文本节点即锚点）", () => {
    const entries = decosAt(makeDocState("- [ ] foo", 6), 0, 10);
    expect(entries.map(widgetOf).some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    expect(covered(entries, 5)).toBe(true);
  });

  it("空无序项 `- ` 光标在项首：bullet 不吞行尾空格", () => {
    const entries = decosAt(makeDocState("- ", 2), 0, 3);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(true);
    expect(covered(entries, 1)).toBe(false);
  });
});

/**
 * The setext ambiguity of an empty bullet line: a bare `- ` line after a
 * paragraph is parsed as SetextHeading2 (in CommonMark setext wins when both
 * readings are valid, so there is no ListMark in the tree), and the rendering
 * layer must treat it as an empty list item — otherwise the empty item cut
 * out after a paragraph with Cmd+; never renders, and on the first typed
 * character the parse flips and the whole line reflows, which reads as
 * "the toggle does not work + typing stutters".
 */
describe("段落后空 bullet 行的 setext 歧义（decorateSetextDash）", () => {
  const PARAG = "段落行在此。";
  const doc = `${PARAG}\n- \n`;
  const dashFrom = PARAG.length + 1; // start of the `- ` line

  const makeDocState = (text: string, pos: number) => {
    const created = EditorState.create({
      doc: text,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    return created.update({ selection: EditorSelection.cursor(pos) }).state;
  };
  const covered = (entries: { from: number; to: number }[], pos: number) =>
    entries.some((e) => e.from !== e.to && e.from <= pos && e.to > pos);
  const listLineDeco = (entries: { deco: unknown }[]) =>
    entries.some(
      (e) =>
        (e.deco as { spec?: { class?: string } }).spec?.class?.includes("li-b") === true,
    );

  it("树里是 SetextHeading2 时仍渲染 bullet + li-b 行装饰（立即可见）", () => {
    // the caret is at the line end (where toggleList lands), and the tree is SetextHeading2, not List.
    const state = makeDocState(doc, dashFrom + 2);
    const entries = decosAt(state, dashFrom, dashFrom + 3);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(true);
    expect(listLineDeco(entries)).toBe(true);
  });

  it("光标压在 `-` 上：翻回源码（与 ListMark 同一活动规则），行装饰保持", () => {
    const state = makeDocState(doc, dashFrom);
    const entries = decosAt(state, dashFrom, dashFrom + 3);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(false);
    expect(listLineDeco(entries)).toBe(true);
  });

  it("空项光标在行尾：尾随空格保留作文本锚点（keepTrailingSpace 同规则）", () => {
    const state = makeDocState(doc, dashFrom + 2);
    const entries = decosAt(state, dashFrom, dashFrom + 3);
    expect(covered(entries, dashFrom)).toBe(true); // the `-` is swallowed by the bullet
    expect(covered(entries, dashFrom + 1)).toBe(false); // the space stays visible
  });

  it("真 setext（下划线多于一个 `-`）不受影响", () => {
    const state = makeDocState("标题行\n---\n", 4);
    const entries = decosAt(state, 4, 8);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(false);
  });

  it("键入正文后解析翻转成真 ListMark：bullet 同起点覆盖标记（无缝接管）", () => {
    // The caret is at the line end in both cases (the natural pose of toggle
    // and of typing). Ownership of the trailing space is decided by the shared
    // keepMarkerTrailingSpace anchor rule (kept for an empty item, swallowed
    // when there is body text, a gap of at most 1 space); what is locked here
    // is that in both tree states the bullet takes over from the dash start.
    const rendered = decosAt(makeDocState(doc, dashFrom + 2), dashFrom, dashFrom + 3);
    const typed = decosAt(
      makeDocState(`${PARAG}\n- 字\n`, dashFrom + 3),
      dashFrom,
      dashFrom + 4,
    );
    const bulletFrom = (entries: ReturnType<typeof decosAt>) => {
      const hit = entries.find((e) => widgetOf(e) instanceof ListBulletWidget);
      return hit ? hit.from : null;
    };
    expect(bulletFrom(typed)).toBe(dashFrom);
    expect(bulletFrom(typed)).toBe(bulletFrom(rendered));
  });
});

/**
 * The selection trigger (selectionAffectsDecos): the activity rule of the
 * marker slot (list marker / task brackets) depends on the caret position
 * within the line, so a same-line move across the slot must trigger a
 * rebuild — otherwise vim's 0/A/$ and the caret landing point after Esc
 * leave a bare `-` / bare `[ ]` on screen permanently (or, the other way
 * round, the widget covers the marker being edited). The fast path is
 * unchanged: a pure same-line move outside the slot must still return false.
 */
describe("选区触发器:同行内跨标记槽移动必须重建", () => {
  const DOC2 = [
    "- 随机变量第一行的内容",
    "  - [ ] 嵌套任务行",
    "普通段落文本行,没有标记。",
    "- ",
    "1. 有序项内容",
  ].join("\n");

  const stateAt = (line: number, col: number) => {
    const created = EditorState.create({
      doc: DOC2,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    const l = created.doc.line(line);
    return created.update({ selection: EditorSelection.cursor(l.from + col) }).state;
  };
  const moves = (from: { line: number; col: number }, to: { line: number; col: number }) =>
    selectionAffectsDecos(stateAt(from.line, from.col), stateAt(to.line, to.col));

  it("回归主形态:normal 压在 `-` 上(源码态)→ A 跳行尾,同行必须触发重建", () => {
    // before the fix this returned false: the plugin skipped the rebuild and the bare `-` stayed on screen until a line change or an edit
    expect(moves({ line: 1, col: 0 }, { line: 1, col: 10 })).toBe(true);
  });

  it("反向同样触发:行尾 → 0 回到标记上", () => {
    expect(moves({ line: 1, col: 10 }, { line: 1, col: 0 })).toBe(true);
  });

  it("任务行:光标压 `[ ]` ⇄ 行尾,双向都触发", () => {
    expect(moves({ line: 2, col: 6 }, { line: 2, col: 12 })).toBe(true);
    expect(moves({ line: 2, col: 12 }, { line: 2, col: 6 })).toBe(true);
  });

  it("空列表项 `- `:任何同行移动都触发(尾随空白的保留随光标翻转)", () => {
    expect(moves({ line: 4, col: 0 }, { line: 4, col: 2 })).toBe(true);
    expect(moves({ line: 4, col: 2 }, { line: 4, col: 0 })).toBe(true);
  });

  it("快路径不变:槽外的同行纯移动(普通行/列表行正文内)恒 false", () => {
    expect(moves({ line: 3, col: 2 }, { line: 3, col: 6 })).toBe(false);
    expect(moves({ line: 1, col: 4 }, { line: 1, col: 10 })).toBe(false);
    expect(moves({ line: 5, col: 5 }, { line: 5, col: 8 })).toBe(false);
  });

  it("触发器与真实装饰一致:触发的那对状态,新建装饰确实不同", () => {
    // Locks the class of the bug: trigger true ⟺ the decorations freshly
    // built for the two states differ in the marker area. If someone changes
    // the activity rule so that both states decorate identically, this turns
    // red first and points at the trigger as the thing that may be relaxed.
    const onDash = stateAt(1, 0);
    const atEnd = stateAt(1, 10);
    const bulletOf = (state: EditorState) => {
      const set = buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: state.doc.length }] });
      let has = false;
      set.between(0, 2, (_f, _t, deco) => {
        if ((deco as { spec?: { widget?: unknown } }).spec?.widget instanceof ListBulletWidget) {
          has = true;
        }
      });
      return has;
    };
    expect(bulletOf(onDash)).toBe(false); // on the marker: source state
    expect(bulletOf(atEnd)).toBe(true); // at the line end: rendered state
    expect(selectionAffectsDecos(onDash, atEnd)).toBe(true);
  });
});

/**
 * The block-level decoration rules of the math block's "live preview while
 * editing". The anchor is the **end of the line** of this block's closing
 * line: anchoring at the start of the next line means that, if the next line
 * happens to be another display math block, its whole-block replace starts at
 * the line start, and a block widget inside the replaced range is dropped by
 * CM (the preview vanishes for no reason); a line-start anchor also renders
 * an extra empty cm-line. blockDecorationsField is a pure RangeSet, so the
 * anchor position can be asserted in the node environment.
 */
describe("数学预览的块级锚点（blockDecorationsField）", () => {
  /** "a\n$$\nx = 1\n$$\nb\n": region 2..13 (lines 2-4), end of the region's last line is 13. */
  function blockState(doc: string, pos: number) {
    const created = EditorState.create({ doc, extensions: [blockDecorationsField] });
    return created.update({ selection: EditorSelection.cursor(pos) }).state;
  }

  function blockPoints(state: EditorState) {
    const { decos } = state.field(blockDecorationsField);
    const out: { from: number; to: number; widget: unknown }[] = [];
    decos.between(0, state.doc.length, (from, to, deco) => {
      const w = (deco as { spec?: { widget?: unknown } }).spec?.widget;
      if (w) out.push({ from, to, widget: w });
    });
    return out;
  }

  it("预览 widget 锚在区域末行行尾，不是下一行行首", () => {
    const state = blockState("a\n$$\nx = 1\n$$\nb\n", 6);
    const previews = blockPoints(state).filter((p) => p.widget instanceof MathPreviewWidget);
    expect(previews).toEqual([{ from: 13, to: 13, widget: expect.any(MathPreviewWidget) }]);
    // editing state: the whole block does not collapse into a rendered widget.
    expect(blockPoints(state).some((p) => p.widget instanceof MathWidget)).toBe(false);
  });

  it("紧挨着另一个公式块时预览仍然存在（不落进它的整块替换范围）", () => {
    // "a\n$$\nx = 1\n$$\n$$\ny = 2\n$$\n": the second block 14..25 is replaced wholesale,
    // so a preview anchored at 14 would be dropped by CM — that is exactly the
    // root cause of "the live rendering disappeared".
    const doc = "a\n$$\nx = 1\n$$\n$$\ny = 2\n$$\n";
    const state = blockState(doc, 6);
    const points = blockPoints(state);
    const previews = points.filter((p) => p.widget instanceof MathPreviewWidget);
    expect(previews).toEqual([{ from: 13, to: 13, widget: expect.any(MathPreviewWidget) }]);
    const nextReplace = points.find(
      (p) => p.widget instanceof MathWidget && p.from === 14,
    );
    expect(nextReplace).toBeDefined();
    expect(previews[0].from).toBeLessThan(nextReplace!.from);
  });

  it("空内容不出预览：插入公式块后下方不凭空多出空白", () => {
    const state = blockState("a\n$$\n\n$$\nb\n", 5);
    expect(blockPoints(state).some((p) => p.widget instanceof MathPreviewWidget)).toBe(false);
  });

  it("区域到文档末尾：锚在 doc.length（合法的块级 widget 位置）", () => {
    const state = blockState("a\n$$\nx = 1\n$$", 6);
    const previews = blockPoints(state).filter((p) => p.widget instanceof MathPreviewWidget);
    expect(previews).toEqual([{ from: 13, to: 13, widget: expect.any(MathPreviewWidget) }]);
  });

  it("光标离开区域：整块折叠为 MathWidget，无预览", () => {
    const state = blockState("a\n$$\nx = 1\n$$\nb\n", 0);
    const points = blockPoints(state);
    expect(points.some((p) => p.widget instanceof MathPreviewWidget)).toBe(false);
    expect(points.some((p) => p.widget instanceof MathWidget && p.from === 2 && p.to === 13)).toBe(
      true,
    );
  });

  it("闭合 $$ 同行带正文：块 widget 只盖到定界符，不吞掉后面的正文", () => {
    // "a\n$$\nx = 1\n$$后文\n": region 2..13, the closing line 11..16 — replacing the whole
    // line would make "后文" disappear from the DOM (covered by the widget),
    // so a caret resting there shows no text.
    const state = blockState("a\n$$\nx = 1\n$$后文\n", 0);
    const block = blockPoints(state).find((p) => p.widget instanceof MathWidget);
    expect(block).toEqual({ from: 2, to: 13, widget: expect.any(MathWidget) });
  });
});

/**
 * The rendering rules for inline math (buildInlineDecorations).
 *
 * The activity rule is decided by the **body** (selectionInMathBody in
 * context.ts): `$f(x)$` occupies 3..9, and position 3 (before the opening
 * delimiter) and 9 (after the closing one) are both outside the widget —
 * that is already body text, so the formula renders as usual and the caret
 * lands after the rendered result (the natural spot after tabbing out or
 * after typing the closing `$`). Only the strict interior 4..8 expands the
 * source.
 *
 * While editing, **only the source is shown**: no rendered copy is inserted
 * after the closing delimiter any more (a second rendering of the same
 * formula). When a line holds more than one inline formula, that copy lands
 * right next to the neighbouring formula's rendering (the "overlapping
 * rendering" the user reported), and its width changes on every keystroke,
 * reflowing the whole line.
 *
 * Fixture "前文 $f(x)$ 后文": `$f(x)$` occupies 3..9, the closing delimiter
 * is at 8.
 */
describe("行内公式的渲染规则（buildInlineDecorations）", () => {
  const DOC_MATH = "前文 $f(x)$ 后文";

  function inlinePoints(doc: string, pos: number) {
    const created = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    const state = created.update({ selection: EditorSelection.cursor(pos) }).state;
    const set = buildInlineDecorations({
      state,
      visibleRanges: [{ from: 0, to: state.doc.length }],
    });
    // collect mark decorations (widget undefined) together with replace decorations, so that "only the source is highlighted" can be asserted
    const out: { from: number; to: number; widget: unknown; mark: unknown }[] = [];
    set.between(0, state.doc.length, (from, to, deco) => {
      const spec = (deco as { spec?: { widget?: unknown; class?: unknown } }).spec;
      out.push({ from, to, widget: spec?.widget, mark: spec?.class });
    });
    return out;
  }

  it("光标在公式内：只显示源码，不插渲染副本（无 replace、无第二遍渲染）", () => {
    for (const pos of [4, 6, 8]) {
      const points = inlinePoints(DOC_MATH, pos);
      // the whole region has no replace at all: the source stays verbatim in the document, only the rendered state folds it into a widget
      expect(points.some((p) => p.widget instanceof MathWidget)).toBe(false);
    }
  });

  it("光标在公式内：源码按 token 上色（命令/结构符有 mark）", () => {
    // highlightMathSource only marks $$, \cmd, {}[]^_&~ — a plain $f(x)$ has no token.
    const points = inlinePoints("前文 $\\alpha_{x}$ 后文", 6);
    expect(points.some((p) => p.widget instanceof MathWidget)).toBe(false);
    expect(points.filter((p) => p.mark !== undefined).length).toBeGreaterThan(0);
  });

  it("光标压在边界上（开符之前 3 / 闭合符之后 9）：公式已渲染", () => {
    for (const pos of [3, 9]) {
      const points = inlinePoints(DOC_MATH, pos);
      expect(
        points.some((p) => p.widget instanceof MathWidget && p.from === 3 && p.to === 9),
      ).toBe(true);
    }
  });

  it("光标离开区域：折成渲染 widget", () => {
    const points = inlinePoints(DOC_MATH, 0);
    expect(
      points.some((p) => p.widget instanceof MathWidget && p.from === 3 && p.to === 9),
    ).toBe(true);
  });

  it("一行两个公式、编辑前一个：前一个的渲染副本紧随闭合 $，后一个照常渲染", () => {
    // "甲 $a$ 乙 $b$ 丙": region 2..5 and 8..11.
    const doc = "甲 $a$ 乙 $b$ 丙";
    const points = inlinePoints(doc, 3); // the caret is inside the first formula
    const widgets = points.filter((p) => p.widget instanceof MathWidget);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({ from: 8, to: 11 });
    // The first formula is being edited: its source does not fold, and the
    // rendered copy is inserted after the closing delimiter (=5), pushing
    // "乙" and the next formula back as a whole — it covers nothing and does
    // not overlap side by side.
    const copy = points.filter((p) => p.widget instanceof MathInlinePreviewWidget);
    expect(copy).toHaveLength(1);
    expect(copy[0].from).toBe(5);
    expect(copy[0].from).toBeLessThan(widgets[0].from);
  });
});

/**
 * Callout anchor decorations: body text that is the same run of text as some
 * callout title gets md-callout-anchor (an underline dashed line); the title
 * line, the block content and code regions do not.
 */
describe("livePreview callout 锚点装饰", () => {
  const anchorState = (doc: string, line = 1, col = 0) => {
    const created = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    ensureSyntaxTree(created, created.doc.length);
    const l = created.doc.line(line);
    return created.update({ selection: EditorSelection.cursor(l.from + col) }).state;
  };

  const anchorMarks = (state: EditorState) =>
    decosAt(state, 0, state.doc.length)
      .filter(
        (e) => (e.deco as { spec?: { class?: string } }).spec?.class === "md-callout-anchor",
      )
      .map((e) => ({ from: e.from, to: e.to }));

  it("正文里与标题同一段文字的位置有锚点;标题行与块内文没有", () => {
    const state = anchorState("斜率矩阵是错的\n\n::: 斜率矩阵\n\n:::\n");
    expect(anchorMarks(state)).toEqual([{ from: 0, to: 4 }]);
  });

  it("光标停进锚点内时装饰仍在(不参与标记的活动规则)", () => {
    const state = anchorState("斜率矩阵是错的\n\n::: 斜率矩阵\n\n:::\n", 1, 2);
    expect(anchorMarks(state)).toEqual([{ from: 0, to: 4 }]);
  });

  it("围栏代码里的同一段文字不加锚点", () => {
    const state = anchorState("```\n斜率矩阵\n```\n\n::: 斜率矩阵\n\n:::\n", 4, 0);
    expect(anchorMarks(state)).toEqual([]);
  });

  it("行内代码里的同一段文字不加锚点", () => {
    const state = anchorState("`斜率矩阵`\n\n::: 斜率矩阵\n\n:::\n", 3, 0);
    expect(anchorMarks(state)).toEqual([]);
  });

  it("锚点扫描跟着视口:只看得到视口内的命中", () => {
    const doc = "斜率矩阵\n\n::: 斜率矩阵\n\n:::\n";
    const state = anchorState(doc, 1, 0);
    const marksIn = (from: number, to: number) => {
      const set = buildInlineDecorations({ state, visibleRanges: [{ from, to }] });
      const out: { from: number; to: number }[] = [];
      set.between(0, state.doc.length, (f, t, deco) => {
        if ((deco as { spec?: { class?: string } }).spec?.class === "md-callout-anchor") {
          out.push({ from: f, to: t });
        }
      });
      return out;
    };
    expect(marksIn(0, 5)).toEqual([{ from: 0, to: 4 }]);
    // the viewport holds only the title line (the hit on line 1 is outside): no anchor appears
    expect(marksIn(6, doc.length)).toEqual([]);
  });
});
