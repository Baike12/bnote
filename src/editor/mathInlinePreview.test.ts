import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { buildInlineDecorations } from "./livePreview";
import { MathInlinePreviewWidget, MathWidget } from "./widgets";

/** Two inline formulas on one line: `a xxxx b`. While editing a the rendered
 *  copy must come **after a**, pushing the rendering of xxxx and b back as a
 *  whole — it must not simply not render to avoid "looking overlapped" (that
 *  was what 57a9d40 did, and the user explicitly rejected it). */
const DOC = "前缀 $a+b$ 中间 $c-d$ 结尾";

function makeState(col: number): EditorState {
  const created = EditorState.create({
    doc: DOC,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
  ensureSyntaxTree(created, created.doc.length);
  return created.update({ selection: EditorSelection.cursor(col) }).state;
}

interface Entry {
  from: number;
  to: number;
  widget: unknown;
}

function entriesOf(state: EditorState): Entry[] {
  const view = { state, visibleRanges: [{ from: 0, to: state.doc.length }] };
  const set = buildInlineDecorations(view);
  const out: Entry[] = [];
  set.between(0, state.doc.length, (from, to, deco) => {
    const spec = (deco as { spec?: { widget?: unknown } }).spec;
    out.push({ from, to, widget: spec?.widget });
  });
  return out;
}

const firstOpen = DOC.indexOf("$");
const firstClose = DOC.indexOf("$", firstOpen + 1) + 1; // after the closing $
const secondOpen = DOC.indexOf("$", firstClose);

describe("编辑行内公式时的渲染副本", () => {
  it("光标在 a 的正文里:源码保留 + a 的渲染副本插在闭合 $ 之后", () => {
    const entries = entriesOf(makeState(firstOpen + 3));
    const preview = entries.filter((e) => e.widget instanceof MathInlinePreviewWidget);
    expect(preview).toHaveLength(1);
    // anchored after the closing delimiter (= after the source), not at the region start
    expect(preview[0].from).toBe(firstClose);
    expect((preview[0].widget as MathInlinePreviewWidget).src).toBe("a+b");
  });

  it("同行的 b 仍按渲染态出 widget,副本排在 b 前面(把 b 往后挤,不覆盖)", () => {
    const entries = entriesOf(makeState(firstOpen + 3));
    const previews = entries.filter((e) => e.widget instanceof MathInlinePreviewWidget);
    const rendered = entries.filter(
      (e) => e.widget instanceof MathWidget && !(e.widget as MathWidget).display,
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0].from).toBe(secondOpen);
    expect(previews[0].from).toBeLessThan(rendered[0].from);
  });

  it("编辑 b 时:副本跟着 b,a 恢复渲染态、只剩一个副本", () => {
    const entries = entriesOf(makeState(secondOpen + 2));
    const previews = entries.filter((e) => e.widget instanceof MathInlinePreviewWidget);
    expect(previews).toHaveLength(1);
    expect((previews[0].widget as MathInlinePreviewWidget).src).toBe("c-d");
    expect(previews[0].from).toBe(secondOpen + "$c-d$".length); // after b's closing $
    const rendered = entries.filter(
      (e) => e.widget instanceof MathWidget && !(e.widget as MathWidget).display,
    );
    expect(rendered.map((e) => e.from)).toEqual([firstOpen]);
  });

  it("光标不在任何公式里:没有副本,两个公式都渲染", () => {
    const entries = entriesOf(makeState(0));
    expect(entries.filter((e) => e.widget instanceof MathInlinePreviewWidget)).toHaveLength(0);
    const rendered = entries.filter(
      (e) => e.widget instanceof MathWidget && !(e.widget as MathWidget).display,
    );
    expect(rendered.map((e) => e.from)).toEqual([firstOpen, secondOpen]);
  });

  it("边界位置(闭合 $ 之后)算正文侧:副本消失、公式渲染", () => {
    const entries = entriesOf(makeState(firstClose));
    expect(entries.filter((e) => e.widget instanceof MathInlinePreviewWidget)).toHaveLength(0);
    const rendered = entries.filter((e) => e.widget instanceof MathWidget);
    expect(rendered.map((e) => e.from)).toContain(firstOpen);
  });
});
