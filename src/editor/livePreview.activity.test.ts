import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { buildInlineDecorations, blockDecorationsField } from "./livePreview";
import { ListBulletWidget, MathWidget, MathPreviewWidget, TaskCheckboxWidget } from "./widgets";

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
 * 锁住 live preview 的「token 范围活动规则」：列表标记只在光标落进标记
 * 字符本身时才翻回源码，光标在行上其他位置时保持渲染态。j/k 的像素锚定
 * 落点（verticalMotion）依赖这条规则的几何稳定性。
 */
describe("livePreview 列表标记的 token 活动规则", () => {
  const line1 = () => DOC.split("\n")[0];

  it("光标在正文上（标记范围外）：任务行保持渲染态（checkbox + 隐藏 `- `）", () => {
    const state = makeState({ line: 1, col: 6 });
    const entries = decosAt(state, 0, line1().length + 1);
    const widgets = entries.map(widgetOf);
    expect(widgets.some((w) => w instanceof TaskCheckboxWidget)).toBe(true);
    // `- ` 被空替换隐藏（li-t 的 mark 槽收进 checkbox 前的空间）。
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
    // 行首两个空格被 replace 隐藏，li-i2 行装饰负责缩进。
    expect(entries.some((e) => e.from === nestedFrom && e.to === nestedFrom + 2)).toBe(true);
  });

  it("有序列表：数字标记两种状态下都保留原文（无几何翻转）", () => {
    const orderedFrom = DOC.split("\n").slice(0, 4).join("\n").length + 1;
    // 不变量：任何状态下都没有 replace 装饰盖住数字标记——有序行的几何
    // 在光标进出时稳定（这也是 .li-o 槽宽恒定的前提）。
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
    // 渲染态下数字标记带 md-listmark 着色。
    const rendered = decosAt(makeState({ line: 5, col: 6 }), orderedFrom, orderedFrom + 2);
    expect(rendered.some((e) => e.from === orderedFrom && e.to === orderedFrom + 2)).toBe(true);
  });
});

/**
 * 空列表项的「文本锚点」规则：marker 的替换装饰若吞掉行尾空白，整行就没有
 * 任何文本节点，WebKit 给落在项首的光标算不出矩形（绘制退化到行内容边缘，
 * 即 Enter 续行后光标闪到行首）。光标停在项首时必须保留行尾空格。
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
    // checkbox 仍在（[2,5)），但行尾空格 [5,6) 保持可见。
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
 * 空 bullet 行的 setext 歧义：段落后的裸 `- ` 行被解析器归为 SetextHeading2
 * （CommonMark 里两种读法都成立时 setext 赢，树里没有 ListMark），渲染层必须
 * 按空列表项处理——否则 Cmd+; 在段落后切出的空项永远不渲染，输入第一个字符
 * 时解析翻转、整行重排，读作“切换不生效 + 输入卡顿”。
 */
describe("段落后空 bullet 行的 setext 歧义（decorateSetextDash）", () => {
  const PARAG = "段落行在此。";
  const doc = `${PARAG}\n- \n`;
  const dashFrom = PARAG.length + 1; // `- ` 行起点

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
    // 光标在行尾（toggleList 落点），树是 SetextHeading2 而不是 List。
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
    expect(covered(entries, dashFrom)).toBe(true); // `-` 被 bullet 吞掉
    expect(covered(entries, dashFrom + 1)).toBe(false); // 空格保留可见
  });

  it("真 setext（下划线多于一个 `-`）不受影响", () => {
    const state = makeDocState("标题行\n---\n", 4);
    const entries = decosAt(state, 4, 8);
    expect(entries.map(widgetOf).some((w) => w instanceof ListBulletWidget)).toBe(false);
  });

  it("键入正文后解析翻转成真 ListMark：bullet 同起点覆盖标记（无缝接管）", () => {
    // 光标都在行尾（toggle 与打字的自然姿态）。行尾空格的归属由共享的
    // keepMarkerTrailingSpace 锚点规则决定（空项保留、有正文吞掉，≤1 空格
    // 宽的既定缝隙），这里锁的是两种树态下 bullet 都从 dash 起点接管。
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
 * 公式块「编辑态实时预览」的块级装饰规则。块级 widget 的规范锚点是行首：
 * 锚在行尾（换行符之前）CM6 会把该行劈成两行，DOM 里多出一个不属于任何
 * 文档行的幽灵空行（预览与下文之间的大间隙）。blockDecorationsField 是
 * 纯 RangeSet，node 环境即可断言锚点位置。
 */
describe("数学预览的块级锚点（blockDecorationsField）", () => {
  /** "a\n$$\nx = 1\n$$\nb\n":region 2..13(行 2-4),下一行行首 14。 */
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

  it("预览 widget 锚在下一行行首，不是区域末行行尾", () => {
    const state = blockState("a\n$$\nx = 1\n$$\nb\n", 6);
    const previews = blockPoints(state).filter((p) => p.widget instanceof MathPreviewWidget);
    expect(previews).toEqual([{ from: 14, to: 14, widget: expect.any(MathPreviewWidget) }]);
    // 编辑态：整块不折叠成渲染 widget。
    expect(blockPoints(state).some((p) => p.widget instanceof MathWidget)).toBe(false);
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
});
