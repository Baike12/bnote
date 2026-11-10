import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { scanMath } from "./mathScan";

function regions(doc: string) {
  return scanMath(EditorState.create({ doc }).doc);
}

const display = (doc: string) => regions(doc).filter((r) => r.display);

/** Whether the body snippet is swallowed into any math region (the core assertion against "body text is swallowed"). */
const insideAny = (doc: string, needle: string) => {
  const at = doc.indexOf(needle);
  return regions(doc).some((r) => at >= r.from && at + needle.length <= r.to);
};

describe("scanMath block formula pairing", () => {
  it("a normal block formula is still recognized", () => {
    const rs = display("$$\nx=1\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 9, display: true, content: "\nx=1\n" }]);
  });

  it("separately paired formulas in a multi-paragraph document do not interfere", () => {
    const rs = display("$$\na\n$$\n\n文字\n\n$$\nb\n$$\n\n结尾");
    expect(rs.map((r) => r.content)).toEqual(["\na\n", "\nb\n"]);
  });

  it("a block with a leading blank line still renders (typing flow: two enters after $$ before writing the formula)", () => {
    const rs = display("$$\n\nE=mc^2\n$$\n\n正文");
    expect(rs).toEqual([{ from: 0, to: 13, display: true, content: "\n\nE=mc^2\n" }]);
  });

  it("a block with a blank line appended after the body is still a formula: $$\\nx=1\\n\\n$$", () => {
    const rs = display("$$\nx=1\n\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 10, display: true, content: "\nx=1\n\n" }]);
  });

  it("an empty block $$\\n\\n$$ is still a formula (IME following and empty-block rendering depend on it)", () => {
    const rs = display("$$\n\n$$\n后面");
    expect(rs).toEqual([{ from: 0, to: 6, display: true, content: "\n\n" }]);
  });

  it("blank lines on both sides = a misaligned product with the body sandwiched: the pairing is refused and the body is not swallowed (the whole thing stays plain text)", () => {
    const doc = "$$\na\n\nb\n$$\n后面";
    expect(display(doc)).toHaveLength(0);
    expect(insideAny(doc, "a")).toBe(false);
    expect(insideAny(doc, "b")).toBe(false);
  });

  it("after deleting one $$: the misaligned product does not render and the intact formula below still pairs and renders as a whole (the formula monster no longer shifts)", () => {
    // the user scenario: one of four $$ is deleted, the stack pairing refuses m1-m2, and m2-m3 (an intact formula) still pairs as usual
    const doc = "因为\n1\n$$\n\n后面段落A\n\n$$\n.x\n$$\n\n结尾";
    const rs = display(doc);
    expect(rs.map((r) => r.content)).toEqual(["\n.x\n"]);
    expect(insideAny(doc, "后面段落A")).toBe(false);
    expect(insideAny(doc, "结尾")).toBe(false);
  });

  it("typing above an existing formula: the intact formula below is unaffected and the upper one pairs as usual once it is closed", () => {
    const doc = "$$\nE\n\n正文\n\n$$\nF\n$$";
    const rs = display(doc);
    expect(rs.map((r) => r.content)).toEqual(["\nF\n"]);
    expect(insideAny(doc, "正文")).toBe(false);
    // after adding the closing $$ above, the formula being typed also pairs and renders as a whole
    expect(display("$$\nE\n$$\n\n正文\n\n$$\nF\n$$").map((r) => r.content)).toEqual([
      "\nE\n",
      "\nF\n",
    ]);
  });

  it("an unpaired $$ only renders up to the end of the paragraph and does not swallow the following paragraph", () => {
    const doc = "$$\nx=1\n\n后面文字";
    const rs = display(doc);
    expect(rs).toEqual([{ from: 0, to: 6, display: true, content: "\nx=1", unclosed: true }]);
    expect(doc.indexOf("后面文字")).toBeGreaterThan(rs[0].to - 1);
  });

  it("an unpaired $$ followed by a blank line: the region contains only $$ itself and does not cross the line end (inline replacement decorations must not span lines)", () => {
    const rs = display("a\n\n$$\n\n结尾");
    expect(rs).toEqual([{ from: 3, to: 5, display: true, content: "", unclosed: true }]);
    expect(insideAny("a\n\n$$\n\n结尾", "结尾")).toBe(false);
  });

  it("an unpaired $$ with no blank line after it: it extends to the end of the document (the formula being typed keeps rendering live)", () => {
    const rs = display("前文\n\n$$\nx=1");
    expect(rs).toEqual([{ from: 4, to: 10, display: true, content: "\nx=1", unclosed: true }]);
  });
});

describe("scanMath blank lines inside multi-line environments", () => {
  it("\\begin{align} inside blank lines still render (user report: $$\n\\begin{align}\n…\n\n\\end{align}\n$$ turned the whole block into plain text)", () => {
    const doc = "$$\n\\begin{align}\nE[q_{i}^{2}]=Var(q_{i})\n\n\\end{align}\n$$";
    const rs = display(doc);
    expect(rs).toHaveLength(1);
    expect(rs[0].content).toBe("\n\\begin{align}\nE[q_{i}^{2}]=Var(q_{i})\n\n\\end{align}\n");
  });

  it("blank lines on both sides inside the environment (after the opening / before the closing) are allowed as well", () => {
    expect(display("$$\n\\begin{align}\n\nx\n\\end{align}\n$$")).toHaveLength(1);
    expect(display("$$\n\\begin{align}\nx\n\\end{align}\n\n$$")).toHaveLength(1);
  });

  it("blank lines inside nested environments are allowed as well", () => {
    const doc = "$$\n\\begin{align}\n\\begin{cases}\n1\n\n2\n\\end{cases}\n\\end{align}\n$$";
    expect(display(doc)).toHaveLength(1);
  });

  it("a blank line after the environment is closed but before the closing $$ is still a paragraph boundary (no misaligned pairing that swallows the body)", () => {
    const doc = "$$\n\\begin{align}\nx\n\\end{align}\n\n后面段落A\n\n$$";
    expect(display(doc)).toHaveLength(0);
    expect(insideAny(doc, "后面段落A")).toBe(false);
  });

  it("a \\begin without a matching \\end followed by a blank line: no exemption is granted and the body is still not swallowed (the property of 1914fc8 does not regress)", () => {
    const doc = "$$\n\\begin{align}\nx\n\n后面段落A\n$$";
    expect(insideAny(doc, "后面段落A")).toBe(false);
  });
});

describe("scanMath existing behavior does not regress", () => {
  it("an escaped \\$\\$ is not a delimiter", () => {
    expect(regions("\\$\\$ 不是公式")).toHaveLength(0);
  });

  it("inline formulas still work as usual", () => {
    const rs = regions("因为 $x_1$ 文字");
    expect(rs).toEqual([{ from: 3, to: 8, display: false, content: "x_1" }]);
  });

  it("inline formulas are not lost because of the block-level guard", () => {
    // after the misaligned pair is refused, the text of that line goes back to being a plain line and inline math is still recognized
    const doc = "值 $a$ 与 $b$\n\n$$\n\n后面";
    const rs = regions(doc);
    expect(rs.some((r) => r.content === "a" && !r.display)).toBe(true);
    expect(rs.some((r) => r.content === "b" && !r.display)).toBe(true);
  });

  it("a trailing space before the closing $ keeps the inline region (typing `$s ` mid-formula)", () => {
    // `$s $` is the state after typing "s" and one space inside a new inline
    // formula. It must stay a region: the IME picks the source by
    // caretInMathBody (a lost region switches back to Chinese and eats the
    // next space), and inline-math-only snippets match by it too.
    expect(regions("$s $")).toEqual([{ from: 0, to: 4, display: false, content: "s " }]);
    expect(regions("前文 $s $ 后文").map((r) => r.content)).toEqual(["s "]);
  });

  it("the trailing-space relaxation does not turn prices into formulas", () => {
    expect(regions("$5 and $10")).toHaveLength(0);
    expect(regions("cost $100 to $200")).toHaveLength(0);
  });

  it("a leading space after the opening $ is still not a formula, and neither is an empty pair", () => {
    expect(regions("$ s$")).toHaveLength(0);
    expect(regions("$ $")).toHaveLength(0);
  });

  it("the ma shape `$|$` after text is an empty inline formula, not a block opener", () => {
    // ma / ##@ expand to two adjacent dollars with the caret between them. A
    // display classification made the rest of the paragraph math source and
    // left Tab with nowhere to go (the regression this test locks).
    expect(regions("前文 $$")).toEqual([{ from: 3, to: 5, display: false, content: "" }]);
    expect(regions("a $$ b")).toEqual([{ from: 2, to: 4, display: false, content: "" }]);
  });

  it("the empty pair never overlaps a real inline formula ($x$$ is $x$ plus a stray $)", () => {
    expect(regions("前文 $x$$")).toEqual([{ from: 3, to: 6, display: false, content: "x" }]);
  });

  it("a lone $$ at the start of a line still opens the block being typed", () => {
    expect(regions("$$\n\n正文")).toEqual([
      { from: 0, to: 2, display: true, content: "", unclosed: true },
    ]);
  });
});
