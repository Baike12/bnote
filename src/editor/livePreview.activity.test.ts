import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { buildInlineDecorations } from "./livePreview";
import { ListBulletWidget, TaskCheckboxWidget } from "./widgets";

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
