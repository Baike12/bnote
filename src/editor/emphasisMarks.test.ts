import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { buildEmphasisMarks } from "./emphasisMarks";

/**
 * Locks the root rule "a `_` inside a formula does not leak outside":
 *
 * lezer does not know `$$…$$` and takes a subscript `_` inside a formula for an
 * italic marker; once two `_` from two different formulas pair up into one
 * Emphasis node, the whole body text between them (spanning a dozen lines)
 * gets painted. The text styling therefore moved from the HighlightStyle tags
 * into buildEmphasisMarks: if either end of a node falls inside a formula the
 * whole node is dropped, while a genuine emphasis that wraps a formula (both
 * ends in the body) is unaffected.
 */
function stateOf(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
  ensureSyntaxTree(state, state.doc.length);
  return state;
}

function marksOf(doc: string): { from: number; to: number; cls: string }[] {
  const state = stateOf(doc);
  const set = buildEmphasisMarks(state, [{ from: 0, to: state.doc.length }]);
  const out: { from: number; to: number; cls: string }[] = [];
  set.between(0, state.doc.length, (from, to, deco) => {
    const cls = (deco as unknown as { spec: { class: string } }).spec.class;
    out.push({ from, to, cls });
  });
  return out;
}

const texts = (doc: string, marks: { from: number; to: number }[]) =>
  marks.map((m) => doc.slice(m.from, m.to));

describe("emphasisMarks: formula delimiters do not leak out", () => {
  it("a subscript `_` in two formula blocks no longer paints the body text between them italic", () => {
    const doc = [
      "$$",
      "\\nabla _{\\theta}J(\\theta)",
      "$$",
      "期望展开：轨迹上的每一步 的概率 乘 每一步的概率",
      "$$",
      "=\\sum_{\\tau}(\\nabla_{\\theta}P)R",
      "$$",
    ].join("\n");
    expect(marksOf(doc)).toEqual([]);
  });

  it("a pair with one end inside a formula is voided too (this is the shape the user reported)", () => {
    const doc = [
      "$$",
      "\\nabla _{\\theta}J(\\theta)",
      "$$",
      "正文一",
      "$$",
      "=x",
      "$$",
      "正文二",
    ].join("\n");
    expect(marksOf(doc)).toEqual([]);
  });
});

describe("emphasisMarks: valid emphasis is unaffected", () => {
  it("plain italic / bold / strikethrough only mark the content, not the markers", () => {
    const doc = "前 _斜体_ 中 **加粗** 后 ~~删除~~ 尾";
    const marks = marksOf(doc);
    expect(marks.map((m) => m.cls)).toEqual(["md-em", "md-strong", "md-strike"]);
    expect(texts(doc, marks)).toEqual(["斜体", "加粗", "删除"]);
  });

  it("when emphasis wraps an inline formula both ends are in the body, so it is marked as usual", () => {
    const doc = "开始 _文字 $x_y$ 文字_ 结束";
    const marks = marksOf(doc);
    expect(marks).toHaveLength(1);
    expect(texts(doc, marks)).toEqual(["文字 $x_y$ 文字"]);
  });

  it("nested emphasis is marked separately", () => {
    const doc = "***both***";
    const marks = marksOf(doc);
    expect(marks.map((m) => m.cls).sort()).toEqual(["md-em", "md-strong"]);
  });
});
