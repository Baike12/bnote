import { beforeEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { blockDecorationsField, buildInlineDecorations } from "./livePreview";
import {
  CalloutEdgeWidget,
  CalloutTitleWidget,
  EscapeCharWidget,
  HiddenLineWidget,
  HrWidget,
  ImageWidget,
  MathWidget,
} from "./widgets";
import { useAppStore } from "@/state/appStore";
import { setDocPath, docPathField } from "./docPath";

/**
 * The decoration builders of live preview that have no dedicated test yet:
 * images, wikilinks, links, inline code, escapes, blockquotes and fenced code
 * lines, plus the block field's whole-line replaces (hidden fences, rules,
 * callout caps, display math).
 *
 * Every case is rendered with the caret on a **different line** than the
 * decorated construct: live preview's activity rule renders a construct only
 * while the caret is outside its range, and a caret inside it (or on a
 * single-line document anywhere) keeps the raw source. The rules locked here
 * are the ones with a visible failure mode:
 *
 *  - an image never produces a widget without a candidate URL, and the
 *    candidate list keeps its resolution order (the widget's fallback walk
 *    depends on it);
 *  - a wikilink drops both marker pairs and marks only its target/alias;
 *  - a link marks only the label and the URL;
 *  - a `\*` escape renders as the bare character;
 *  - a fence line is hidden only while the caret is outside the whole block;
 *  - a callout boundary becomes a title/edge widget covering the whole line.
 */

/** A document whose first line is a plain paragraph, so the caret at 0 is
 *  outside every construct built from `body`. */
const HEAD = "head\n";
const base = HEAD.length;

function stateOf(body: string, cursor = 0): EditorState {
  const created = EditorState.create({
    doc: HEAD + body,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] }), docPathField],
  });
  ensureSyntaxTree(created, created.doc.length, 10_000);
  return created.update({ selection: EditorSelection.cursor(cursor) }).state;
}

interface Hit {
  from: number;
  to: number;
  widget?: unknown;
  cls?: string;
}

/** Inline decorations of the body region, with positions relative to the body
 *  start (so the assertions read against `body` alone). */
function inline(body: string): Hit[] {
  const state = stateOf(body);
  const doc = state.doc;
  const set = buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: doc.length }] });
  const out: Hit[] = [];
  set.between(base, doc.length, (f, t, deco) => {
    const spec = deco.spec as { widget?: unknown; class?: string };
    out.push({ from: f - base, to: t - base, widget: spec.widget, cls: spec.class });
  });
  return out;
}

/** Inline decorations of one line of the body with the caret placed on that
 *  line (checks the "source while editing" half of the activity rule). */
function inlineWithCaretOn(body: string, caretInBody: number): Hit[] {
  const state = stateOf(body, base + caretInBody);
  const doc = state.doc;
  const set = buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: doc.length }] });
  const out: Hit[] = [];
  set.between(base, doc.length, (f, t, deco) => {
    const spec = deco.spec as { widget?: unknown; class?: string };
    out.push({ from: f - base, to: t - base, widget: spec.widget, cls: spec.class });
  });
  return out;
}

/** Block-level replaces of the whole document, relative to the body start. */
function block(body: string): Hit[] {
  const created = EditorState.create({
    doc: HEAD + body,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] }), blockDecorationsField],
  });
  ensureSyntaxTree(created, created.doc.length, 10_000);
  // An empty transaction makes the field rebuild against the complete tree
  // (the same step setup.ts performs after a file switch).
  const state = created.update({ selection: EditorSelection.cursor(0) }).state;
  const out: Hit[] = [];
  state.field(blockDecorationsField).decos.between(0, state.doc.length, (f, t, deco) => {
    const spec = deco.spec as { widget?: unknown; block?: boolean };
    if (spec.block) out.push({ from: f - base, to: t - base, widget: spec.widget });
  });
  return out;
}

beforeEach(() => {
  useAppStore.setState({ vaultPath: "/vault", flatAssets: [], currentFile: null });
});

describe("inline decorations: escaping", () => {
  it("a `\\*` escape renders as the bare character while the caret is elsewhere", () => {
    const body = "a \\* b";
    const escape = inline(body).find((h) => h.widget instanceof EscapeCharWidget);
    expect(escape).toBeDefined();
    expect((escape!.widget as EscapeCharWidget).char).toBe("*");
  });

  it("with the caret on the escape's line it stays as source", () => {
    const body = "a \\* b";
    expect(
      inlineWithCaretOn(body, 2).find((h) => h.widget instanceof EscapeCharWidget),
    ).toBeUndefined();
  });
});

describe("inline decorations: links", () => {
  it("only the label and the URL are marked, not the brackets or the parentheses", () => {
    const body = "see [label](https://x.y) end";
    const hits = inline(body);
    const label = hits.find((h) => h.cls === "md-link");
    const url = hits.find((h) => h.cls === "md-url");
    expect(label && body.slice(label.from, label.to)).toBe("label");
    expect(url && body.slice(url.from, url.to)).toBe("https://x.y");
  });

  it("with the caret inside the link it stays as source", () => {
    const body = "see [label](https://x.y) end";
    const hits = inlineWithCaretOn(body, body.indexOf("label") + 1);
    expect(hits.some((h) => h.cls === "md-link" || h.cls === "md-url")).toBe(false);
  });

  it("a bare autolink URL is marked as a link", () => {
    const body = "go to https://example.com now";
    const url = inline(body).find((h) => h.cls === "md-link");
    expect(url && body.slice(url.from, url.to)).toBe("https://example.com");
  });
});

describe("inline decorations: inline code", () => {
  it("the backticks are hidden and the content carries the code mark", () => {
    const body = "a `sample` b";
    const hits = inline(body);
    const code = hits.find((h) => h.cls === "md-inline-code");
    expect(code && body.slice(code.from, code.to)).toBe("sample");
    const open = body.indexOf("`");
    const close = body.lastIndexOf("`");
    expect(hits.filter((h) => h.from === open && h.to === open + 1)).toHaveLength(1);
    expect(hits.filter((h) => h.from === close && h.to === close + 1)).toHaveLength(1);
  });

  it("with the caret inside the code span it stays as source", () => {
    const body = "a `sample` b";
    expect(inlineWithCaretOn(body, 4).some((h) => h.cls === "md-inline-code")).toBe(false);
  });
});

describe("inline decorations: blockquotes", () => {
  it("a rendered quote line gets the quote line class", () => {
    const body = "> quoted\n\nbody";
    expect(inline(body).some((h) => h.cls === "md-quote" && h.from === 0)).toBe(true);
  });

  it("the active quote line keeps its source and gets no quote class", () => {
    const body = "> quoted\n\nbody";
    expect(inlineWithCaretOn(body, 2).some((h) => h.cls === "md-quote")).toBe(false);
  });
});

describe("inline decorations: fenced code lines", () => {
  const body = "```js\nconst a = 1;\n```\n\nafter";

  it("content lines of a rendered fence get the code line class", () => {
    const hits = inline(body);
    expect(hits.some((h) => h.cls === "md-code-line" && h.from === body.indexOf("const"))).toBe(
      true,
    );
  });

  it("with the caret inside the block the content lines lose the rendered class", () => {
    expect(
      inlineWithCaretOn(body, body.indexOf("const")).some((h) => h.cls === "md-code-line"),
    ).toBe(false);
  });
});

describe("inline decorations: images", () => {
  const imageOf = (body: string, cursor?: number): ImageWidget | undefined => {
    const hits = cursor === undefined ? inline(body) : inlineWithCaretOn(body, cursor);
    return hits.find((h) => h.widget instanceof ImageWidget)?.widget as ImageWidget | undefined;
  };

  it("a relative image resolves against the note directory first, then the vault root", () => {
    const state = stateOf("![alt](assets/p1.svg)").update({
      effects: setDocPath.of("/vault/notes/a.md"),
    }).state;
    const doc = state.doc;
    let widget: ImageWidget | undefined;
    const set = buildInlineDecorations({ state, visibleRanges: [{ from: 0, to: doc.length }] });
    set.between(base, doc.length, (_f, _t, deco) => {
      if (deco.spec.widget instanceof ImageWidget) widget = deco.spec.widget;
    });
    // No asset protocol outside Tauri, so candidates stay plain paths.
    expect(widget!.srcs).toEqual(["/vault/notes/assets/p1.svg", "/vault/assets/p1.svg"]);
    expect(widget!.alt).toBe("alt");
    expect(widget!.hint).toBe("assets/p1.svg");
  });

  it("an absolute reference is tried as a path and as a vault-root path", () => {
    expect(imageOf("![a](/images/x.png)")!.srcs).toEqual(["/images/x.png", "/vault/images/x.png"]);
  });

  it("an http reference is used verbatim (no local resolution)", () => {
    expect(imageOf("![a](https://example.com/x.png)")!.srcs).toEqual(["https://example.com/x.png"]);
  });

  it("a bare file name also searches the whole vault, shortest path first", () => {
    useAppStore.setState({
      vaultPath: "/vault",
      flatAssets: ["deep/nested/pic.png", "pic.png", "other/pic.png"],
      currentFile: null,
    });
    expect(imageOf("![a](pic.png)")!.srcs).toEqual(["/vault/pic.png"]);
  });

  it("a reference with a path component is not shadowed by a same-named vault file", () => {
    useAppStore.setState({ vaultPath: "/vault", flatAssets: ["pic.png"], currentFile: null });
    // Without a document path the vault-root form is the only candidate; the
    // same-named `pic.png` at the root must not replace it.
    expect(imageOf("![a](assets/pic.png)")!.srcs).toEqual(["/vault/assets/pic.png"]);
  });

  it("a percent-encoded reference is decoded before resolving", () => {
    expect(imageOf("![a](my%20pic.png)")!.srcs).toEqual(["/vault/my pic.png"]);
  });

  it("with the caret on the image line the source stays", () => {
    expect(imageOf("![alt](assets/p1.svg)", 2)).toBeUndefined();
  });

  it("a picture reference with no possible candidate produces no widget (the source stays visible)", () => {
    useAppStore.setState({ vaultPath: null, flatAssets: [], currentFile: null });
    expect(imageOf("![a](relative.png)")).toBeUndefined();
  });

  it("the widget keeps the raw reference as its hint and the alt text verbatim", () => {
    const widget = imageOf('![读取失败时显示](x.png "title")')!;
    expect(widget.alt).toBe("读取失败时显示");
    // The optional title is stripped from the URL but kept in the hint.
    expect(widget.hint).toBe("x.png");
  });
});

describe("inline decorations: wikilinks", () => {
  it("a plain wikilink hides both marker pairs and marks the target", () => {
    const body = "see [[笔记]] end";
    const hits = inline(body);
    const mark = hits.find((h) => h.cls === "md-wikilink");
    expect(mark && body.slice(mark.from, mark.to)).toBe("笔记");
    const open = body.indexOf("[[");
    const close = body.indexOf("]]");
    expect(hits.some((h) => h.from === open && h.to === open + 2)).toBe(true);
    expect(hits.some((h) => h.from === close && h.to === close + 2)).toBe(true);
  });

  it("with an alias only the alias is marked and the `|` is hidden", () => {
    const body = "[[目标|显示文字]]";
    const mark = inline(body).find((h) => h.cls === "md-wikilink");
    expect(mark && body.slice(mark.from, mark.to)).toBe("显示文字");
  });

  it("with the caret on the line the link stays as source", () => {
    const body = "see [[笔记]] end";
    expect(inlineWithCaretOn(body, 6).some((h) => h.cls === "md-wikilink")).toBe(false);
  });

  it("a wikilink inside inline code is not decorated", () => {
    expect(inline("`[[笔记]]`").some((h) => h.cls === "md-wikilink")).toBe(false);
  });

  it("`![[x.png]]` is an image embed, not a link", () => {
    const hits = inline("![[assets/pic.png]]");
    expect(hits.some((h) => h.widget instanceof ImageWidget)).toBe(true);
    expect(hits.some((h) => h.cls === "md-wikilink")).toBe(false);
  });

  it("an empty target is not a link", () => {
    expect(inline("[[|alias]]").some((h) => h.cls === "md-wikilink")).toBe(false);
  });

  it("a line with no `[[` is skipped entirely", () => {
    expect(inline("plain text").some((h) => h.cls === "md-wikilink")).toBe(false);
  });
});

describe("block decorations: fenced code, rules, callout caps and display math", () => {
  it("a fence's two marker lines are hidden while the caret is outside the block", () => {
    const body = "```js\nconst a = 1;\n```\n\nafter";
    const fences = block(body).filter((h) => h.widget instanceof HiddenLineWidget);
    expect(fences).toHaveLength(2);
    expect(fences[0]).toMatchObject({ from: 0, to: 5 });
  });

  it("a horizontal rule is replaced by the rule widget in its rendered state", () => {
    const body = "a\n\n---\n\nb";
    const hr = block(body).find((h) => h.widget instanceof HrWidget);
    expect(hr).toBeDefined();
    expect(body.slice(hr!.from, hr!.to)).toBe("---");
  });

  it("a title-only callout renders a title widget covering the marker line", () => {
    const body = "::: 定理\ntext\n:::\n";
    const title = block(body).find((h) => h.widget instanceof CalloutTitleWidget);
    expect(title).toBeDefined();
    expect(body.slice(title!.from, title!.to)).toBe("::: 定理");
    expect((title!.widget as CalloutTitleWidget).title).toBe("定理");
  });

  it("a titleless callout renders an opening and a closing edge widget", () => {
    const body = ":::\ntext\n:::\n";
    const edges = block(body).filter((h) => h.widget instanceof CalloutEdgeWidget);
    expect(edges).toHaveLength(2);
    expect((edges[0].widget as CalloutEdgeWidget).open).toBe(true);
    expect((edges[1].widget as CalloutEdgeWidget).open).toBe(false);
  });

  it("an unclosed callout renders only its opening cap", () => {
    const body = "::: 标题\ntext";
    const hits = block(body);
    expect(hits.filter((h) => h.widget instanceof CalloutEdgeWidget)).toHaveLength(0);
    expect(hits.filter((h) => h.widget instanceof CalloutTitleWidget)).toHaveLength(1);
  });

  it("a display formula block collapses into one math widget when the caret is outside", () => {
    const body = "$$\nx = 1\n$$\n";
    const math = block(body).find((h) => h.widget instanceof MathWidget);
    expect(math).toBeDefined();
    expect((math!.widget as MathWidget).display).toBe(true);
  });

  it("a single-line display formula is left to the inline path (no block widget)", () => {
    expect(block("$$x=1$$\n").some((h) => h.widget instanceof MathWidget && h.from === 0)).toBe(
      false,
    );
  });
});
