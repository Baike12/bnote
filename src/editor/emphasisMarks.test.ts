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

describe("emphasisMarks:公式分隔符不外溢", () => {
  it("两个公式块里的下标 `_` 不再把中间正文染成斜体", () => {
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

  it("单侧落在公式里的配对同样作废(下面是用户报告的形状)", () => {
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

describe("emphasisMarks:合法强调不受影响", () => {
  it("普通斜体/加粗/删除线只标内容,不含标记", () => {
    const doc = "前 _斜体_ 中 **加粗** 后 ~~删除~~ 尾";
    const marks = marksOf(doc);
    expect(marks.map((m) => m.cls)).toEqual(["md-em", "md-strong", "md-strike"]);
    expect(texts(doc, marks)).toEqual(["斜体", "加粗", "删除"]);
  });

  it("强调包住一个行内公式时两端都在正文,照常标记", () => {
    const doc = "开始 _文字 $x_y$ 文字_ 结束";
    const marks = marksOf(doc);
    expect(marks).toHaveLength(1);
    expect(texts(doc, marks)).toEqual(["文字 $x_y$ 文字"]);
  });

  it("嵌套强调各自标记", () => {
    const doc = "***both***";
    const marks = marksOf(doc);
    expect(marks.map((m) => m.cls).sort()).toEqual(["md-em", "md-strong"]);
  });
});
