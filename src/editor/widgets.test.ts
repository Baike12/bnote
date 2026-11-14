import { describe, expect, it } from "vitest";
import {
  CalloutEdgeWidget,
  CalloutTitleWidget,
  EscapeCharWidget,
  HrWidget,
  ImageWidget,
  ListBulletWidget,
  MathInlinePreviewWidget,
  MathPreviewWidget,
  MathWidget,
  renderMathHtml,
  TaskCheckboxWidget,
} from "./widgets";

/**
 * The math rendering cache and the widget equality contracts.
 *
 * `renderMathHtml` is paid on every decoration rebuild (cursor moves inside a
 * formula), so identical sources must be served from the cache — the second
 * call must return the exact same string instance. The auto-numbering rewrite
 * is the other half: KaTeX ≥ 0.18 tags every row of `align`/`gather`/
 * `equation`/`alignat`, which notes never asked for, so the environment is
 * rewritten to the starred variant before rendering. An explicit `\tag{}` must
 * still render.
 *
 * Widget `eq` decides whether CM6 reuses the existing DOM: a widget that
 * compares equal for different content would leave stale rendering on screen.
 */

const CACHED = renderMathHtml("x^2+y^2", true);

describe("renderMathHtml: display vs inline output", () => {
  it("display math renders the block wrapper, inline math does not", () => {
    expect(renderMathHtml("a=1", true)).toContain("katex-display");
    expect(renderMathHtml("a=1", false)).not.toContain("katex-display");
  });

  it("the same source in both modes produces two distinct entries (mode is part of the key)", () => {
    expect(renderMathHtml("z", true)).not.toBe(renderMathHtml("z", false));
  });
});

describe("renderMathHtml: the result is cached per (mode, source)", () => {
  it("a repeated call returns the identical string (the KaTeX pass is not paid twice)", () => {
    expect(renderMathHtml("x^2+y^2", true)).toBe(CACHED);
  });

  it("different sources do not share a cache entry", () => {
    expect(renderMathHtml("x^2+y^3", true)).not.toBe(CACHED);
  });
});

describe("renderMathHtml: auto-generated row numbers are suppressed", () => {
  it("an align environment is rendered as align* (no katex-tag spans)", () => {
    expect(renderMathHtml("\\begin{align}x&=1\\end{align}", true)).not.toContain("katex-tag");
  });

  it("gather and equation behave the same way", () => {
    expect(renderMathHtml("\\begin{gather}x\\end{gather}", true)).not.toContain("katex-tag");
    expect(renderMathHtml("\\begin{equation}x\\end{equation}", true)).not.toContain("katex-tag");
  });

  it("an environment that is already starred is left untouched", () => {
    expect(renderMathHtml("\\begin{align*}x&=1\\end{align*}", true)).not.toContain("katex-tag");
  });

  it("an explicit \\tag still renders inside a starred environment", () => {
    expect(renderMathHtml("\\begin{align*}x\\tag{7}\\end{align*}", true)).toContain("katex-tag");
  });

  it("only the environment name is rewritten: a brace group mentioning align in a \\text stays text", () => {
    const html = renderMathHtml("\\text{align}", true);
    expect(html).not.toContain("katex-error");
    expect(html).toContain("align");
  });
});

describe("renderMathHtml: malformed source renders an inline error, never throws", () => {
  it("a truncated fraction yields KaTeX's error markup with the error color", () => {
    const html = renderMathHtml("\\frac{1}{", false);
    expect(html.length).toBeGreaterThan(0);
    expect(html.toLowerCase()).toContain("ff6b6b");
  });

  it("an unknown command is rendered as an error instead of throwing", () => {
    expect(() => renderMathHtml("\\nosuchcommand", true)).not.toThrow();
  });
});

describe("MathWidget.eq: every constructor input participates", () => {
  it("equal inputs compare equal; each differing field breaks equality", () => {
    const base = new MathWidget("x", true, 3, 1);
    expect(base.eq(new MathWidget("x", true, 3, 1))).toBe(true);
    expect(base.eq(new MathWidget("y", true, 3, 1))).toBe(false);
    expect(base.eq(new MathWidget("x", false, 3, 1))).toBe(false);
    expect(base.eq(new MathWidget("x", true, 4, 1))).toBe(false);
    expect(base.eq(new MathWidget("x", true, 3, 2))).toBe(false);
  });

  it("an omitted position is distinct from position 0", () => {
    expect(new MathWidget("x", true).eq(new MathWidget("x", true, 0))).toBe(false);
  });
});

describe("MathPreviewWidget / MathInlinePreviewWidget equality", () => {
  it("the block preview compares source, display and depth", () => {
    expect(new MathPreviewWidget("x", true, 0).eq(new MathPreviewWidget("x", true, 0))).toBe(true);
    expect(new MathPreviewWidget("x", true, 0).eq(new MathPreviewWidget("x", true, 1))).toBe(false);
    expect(new MathPreviewWidget("x", true, 0).eq(new MathPreviewWidget("y", true, 0))).toBe(false);
  });

  it("the inline preview compares the source only", () => {
    expect(new MathInlinePreviewWidget("x").eq(new MathInlinePreviewWidget("x"))).toBe(true);
    expect(new MathInlinePreviewWidget("x").eq(new MathInlinePreviewWidget("y"))).toBe(false);
  });
});

describe("callout widgets carry their click-to-source position", () => {
  it("the title widget distinguishes title, position and depth", () => {
    const base = new CalloutTitleWidget("定理", 10, 0);
    expect(base.eq(new CalloutTitleWidget("定理", 10, 0))).toBe(true);
    expect(base.eq(new CalloutTitleWidget("引理", 10, 0))).toBe(false);
    expect(base.eq(new CalloutTitleWidget("定理", 11, 0))).toBe(false);
    expect(base.eq(new CalloutTitleWidget("定理", 10, 1))).toBe(false);
  });

  it("the edge widget distinguishes the cap side, position and depth", () => {
    const open = new CalloutEdgeWidget(true, 4, 0);
    expect(open.eq(new CalloutEdgeWidget(true, 4, 0))).toBe(true);
    expect(open.eq(new CalloutEdgeWidget(false, 4, 0))).toBe(false);
    expect(open.eq(new CalloutEdgeWidget(true, 5, 0))).toBe(false);
    expect(open.eq(new CalloutEdgeWidget(true, 4, 2))).toBe(false);
  });
});

describe("the small marker widgets", () => {
  it("a hidden line and a bullet never differ (no DOM content to refresh)", () => {
    expect(new ListBulletWidget().eq()).toBe(true);
    expect(new HrWidget(1).eq(new HrWidget(2))).toBe(false);
    expect(new HrWidget(1).eq(new HrWidget(1))).toBe(true);
  });

  it("the hr widget is depth-insensitive by default (both are -1, outside a callout)", () => {
    expect(new HrWidget().eq(new HrWidget(-1))).toBe(true);
  });

  it("the task checkbox compares its checked state", () => {
    expect(new TaskCheckboxWidget(true).eq(new TaskCheckboxWidget(true))).toBe(true);
    expect(new TaskCheckboxWidget(true).eq(new TaskCheckboxWidget(false))).toBe(false);
  });

  it("the escape widget compares the rendered character", () => {
    expect(new EscapeCharWidget("*").eq(new EscapeCharWidget("*"))).toBe(true);
    expect(new EscapeCharWidget("*").eq(new EscapeCharWidget("_"))).toBe(false);
  });
});

describe("ImageWidget.eq: the candidate list decides a reload", () => {
  it("identical lists with the same alt/hint/drawing compare equal", () => {
    const a = new ImageWidget(["a.png", "b.png"], "alt", "a.png");
    expect(a.eq(new ImageWidget(["a.png", "b.png"], "alt", "a.png"))).toBe(true);
  });

  it("a different list length or order breaks equality (the widget must re-try the new order)", () => {
    const a = new ImageWidget(["a.png", "b.png"], "alt", "a.png");
    expect(a.eq(new ImageWidget(["a.png"], "alt", "a.png"))).toBe(false);
    expect(a.eq(new ImageWidget(["b.png", "a.png"], "alt", "a.png"))).toBe(false);
  });

  it("alt, hint and the drawing path all participate", () => {
    const a = new ImageWidget(["a.png"], "alt", "a.png");
    expect(a.eq(new ImageWidget(["a.png"], "other", "a.png"))).toBe(false);
    expect(a.eq(new ImageWidget(["a.png"], "alt", "b.png"))).toBe(false);
    expect(a.eq(new ImageWidget(["a.png"], "alt", "a.png", "/v/a.excalidraw"))).toBe(false);
  });
});
