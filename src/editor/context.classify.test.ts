import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { getContextAt, mathOwnsEndpoints, mathRegions } from "./context";

/**
 * `getContextAt` is the single classifier for "where is the caret" that the
 * snippet engine (word-boundary matching), the IME and the list continuation
 * all consult. Its precedence is the contract:
 *
 * 1. code (fenced / indented / inline) wins over math — a `$` inside a fence
 *    is literal text and must never be taken for a formula;
 * 2. inside math, a `\text{…}` group is reported separately, because the
 *    snippet engine must treat its content as prose, not as formula source;
 * 3. everything else is plain text.
 */
function parsedState(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state;
}

const at = (doc: string, marker: string, offset = 0) => {
  const pos = doc.indexOf(marker);
  return getContextAt(parsedState(doc), pos + offset);
};

describe("getContextAt: plain text", () => {
  it("ordinary prose is text and nothing else", () => {
    expect(at("hello world", "world")).toEqual({
      inlineMath: false,
      blockMath: false,
      textEnv: false,
      code: false,
      codeBlock: false,
      isText: true,
    });
  });

  it("an empty document at position 0 is text", () => {
    expect(getContextAt(EditorState.create({ doc: "" }), 0).isText).toBe(true);
  });
});

describe("getContextAt: code", () => {
  it("a fenced code block reports its language string", () => {
    const doc = "```python\nx = 1\n```";
    const ctx = at(doc, "x = 1");
    expect(ctx.code).toBe(true);
    expect(ctx.codeBlock).toBe("python");
    expect(ctx.isText).toBe(false);
  });

  it("a fence without an info string reports `true` (a block, language unknown)", () => {
    const doc = "```\nx = 1\n```";
    expect(at(doc, "x = 1").codeBlock).toBe(true);
  });

  it("an indented code block counts as code", () => {
    const doc = "text\n\n    indented code";
    // Position 0 of a code line is still the document node; one character in
    // the tree reports CodeBlock.
    expect(getContextAt(parsedState(doc), doc.indexOf("ndented")).code).toBe(true);
  });

  it("inline code counts as code but carries no block language", () => {
    const doc = "a `sample` b";
    const ctx = at(doc, "sample");
    expect(ctx.code).toBe(true);
    expect(ctx.codeBlock).toBe(false);
  });

  it("a `$` inside a fence is not math (code wins over math)", () => {
    const doc = "```\n$a$ and $$b$$\n```";
    const ctx = at(doc, "$a$");
    expect(ctx.code).toBe(true);
    expect(ctx.inlineMath).toBe(false);
    expect(ctx.blockMath).toBe(false);
  });

  it("a `$` inside inline code is not math either", () => {
    const doc = "text `$a$` tail";
    const ctx = at(doc, "$a$", 1);
    expect(ctx.code).toBe(true);
    expect(ctx.inlineMath).toBe(false);
  });
});

describe("getContextAt: math", () => {
  it("an inline formula reports inlineMath and not blockMath", () => {
    const doc = "前 $x$ 后";
    const ctx = at(doc, "x");
    expect(ctx.inlineMath).toBe(true);
    expect(ctx.blockMath).toBe(false);
    expect(ctx.isText).toBe(false);
  });

  it("a display block reports blockMath", () => {
    const doc = "$$\nx = 1\n$$";
    expect(at(doc, "x = 1").blockMath).toBe(true);
  });

  it("the delimiters themselves are inside the region (the context covers the whole range)", () => {
    const doc = "前 $x$ 后";
    expect(getContextAt(parsedState(doc), doc.indexOf("$")).inlineMath).toBe(true);
  });

  it("text between two formulas is plain text again", () => {
    expect(at("$a$ between $b$", "between").isText).toBe(true);
  });
});

describe("getContextAt: \\text{…} inside math", () => {
  it("the body of a text group reports textEnv", () => {
    const doc = "$$\\text{中文} + x$$";
    const ctx = at(doc, "中文");
    expect(ctx.textEnv).toBe(true);
    expect(ctx.blockMath).toBe(true);
  });

  it("a position outside the text group is math but not textEnv", () => {
    const doc = "$$\\text{中文} + x$$";
    expect(getContextAt(parsedState(doc), doc.indexOf("x")).textEnv).toBe(false);
  });

  it("a position before the text group is not textEnv", () => {
    const doc = "$$a+\\text{中文}$$";
    expect(getContextAt(parsedState(doc), doc.indexOf("a")).textEnv).toBe(false);
  });

  it("nested braces inside the text group still count as its body", () => {
    const doc = "$$\\text{a{b}c}$$";
    expect(getContextAt(parsedState(doc), doc.indexOf("c")).textEnv).toBe(true);
  });

  it("content without a \\text command never reports textEnv", () => {
    const doc = "$$x+y$$";
    expect(getContextAt(parsedState(doc), doc.indexOf("y")).textEnv).toBe(false);
  });

  it("an escaped brace inside the group does not close it early", () => {
    const doc = "$$\\text{a\\}b}$$";
    expect(getContextAt(parsedState(doc), doc.indexOf("b")).textEnv).toBe(true);
  });

  it("the second text group of the same formula is recognized too", () => {
    const doc = "$$\\text{a}+\\text{b}$$";
    const second = doc.lastIndexOf("\\text{") + "\\text{".length;
    expect(getContextAt(parsedState(doc), second).textEnv).toBe(true);
  });
});

describe("mathOwnsEndpoints: an endpoint inside math voids the node", () => {
  // One inline and one display region, on separate lines so the inline scan is
  // not suppressed by the display region sharing its line.
  const regions = mathRegions(parsedState("a $x_y$ b\n$$\nz_w\n$$\nc"));
  const inline = regions.find((r) => !r.display);
  const display = regions.find((r) => r.display);

  it("the fixture really holds one region of each kind", () => {
    expect(inline).toBeDefined();
    expect(display).toBeDefined();
  });

  it("a degenerate range owns nothing", () => {
    expect(mathOwnsEndpoints(regions, 5, 5)).toBe(false);
  });

  it("a node whose first character is inside a formula is owned by math", () => {
    expect(mathOwnsEndpoints(regions, inline!.from + 1, inline!.to + 20)).toBe(true);
  });

  it("a node whose last character is inside a formula is owned by math", () => {
    expect(mathOwnsEndpoints(regions, 0, inline!.to)).toBe(true);
  });

  it("a node entirely outside every formula is not owned", () => {
    expect(mathOwnsEndpoints(regions, 0, 1)).toBe(false);
  });

  it("the display region participates the same way", () => {
    expect(mathOwnsEndpoints(regions, display!.from, display!.to + 10)).toBe(true);
  });

  it("an empty region list owns nothing", () => {
    expect(mathOwnsEndpoints([], 0, 100)).toBe(false);
  });
});
