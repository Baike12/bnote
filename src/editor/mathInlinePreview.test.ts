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

describe("the rendered copy while editing an inline formula", () => {
  it("caret inside the body of a: the source stays + a rendered copy of a is inserted after the closing $", () => {
    const entries = entriesOf(makeState(firstOpen + 3));
    const preview = entries.filter((e) => e.widget instanceof MathInlinePreviewWidget);
    expect(preview).toHaveLength(1);
    // anchored after the closing delimiter (= after the source), not at the region start
    expect(preview[0].from).toBe(firstClose);
    expect((preview[0].widget as MathInlinePreviewWidget).src).toBe("a+b");
  });

  it("b on the same line still gets a widget in rendered form, the copy is ordered before b (pushing b back instead of covering it)", () => {
    const entries = entriesOf(makeState(firstOpen + 3));
    const previews = entries.filter((e) => e.widget instanceof MathInlinePreviewWidget);
    const rendered = entries.filter(
      (e) => e.widget instanceof MathWidget && !(e.widget as MathWidget).display,
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0].from).toBe(secondOpen);
    expect(previews[0].from).toBeLessThan(rendered[0].from);
  });

  it("when editing b: the copy follows b, a returns to rendered form, and only one copy remains", () => {
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

  it("caret inside no formula: no copy, both formulas are rendered", () => {
    const entries = entriesOf(makeState(0));
    expect(entries.filter((e) => e.widget instanceof MathInlinePreviewWidget)).toHaveLength(0);
    const rendered = entries.filter(
      (e) => e.widget instanceof MathWidget && !(e.widget as MathWidget).display,
    );
    expect(rendered.map((e) => e.from)).toEqual([firstOpen, secondOpen]);
  });

  it("a boundary position (after the closing $) counts as the body side: the copy disappears, the formula renders", () => {
    const entries = entriesOf(makeState(firstClose));
    expect(entries.filter((e) => e.widget instanceof MathInlinePreviewWidget)).toHaveLength(0);
    const rendered = entries.filter((e) => e.widget instanceof MathWidget);
    expect(rendered.map((e) => e.from)).toContain(firstOpen);
  });
});
