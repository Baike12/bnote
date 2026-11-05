import { describe, expect, it } from "vitest";
import { renderBlockHtml } from "./render";

/**
 * Structural contract for the footprint block rendering: reusing the editor's
 * class names (md-heading, md-list-line, the li-i family) and the same formula
 * scanner is what makes "what you see in the daily note matches the source".
 * This gate locks the mapping between class names and content — the rendering
 * output is an innerHTML string, so asserting the key fragments is enough.
 */

describe("footprint block rendering: block level structure", () => {
  it("heading: the raw # does not appear, the text goes into md-heading md-h{n}", () => {
    const html = renderBlockHtml("# 为什么需要多头\n");
    expect(html).toContain('<span class="md-heading md-h1">为什么需要多头</span>');
    expect(html).not.toContain("#");
  });

  it("unordered list: the li-i0 li-b geometry classes + the md-bullet dot, nesting goes up a level per column width", () => {
    const html = renderBlockHtml("- 项目一\n  - 嵌套项\n");
    expect(html).toContain('<div class="footprint-line md-list-line li-i0 li-b">');
    expect(html).toContain('<div class="footprint-line md-list-line li-i2 li-b">');
    expect(html.match(/md-bullet/g)!.length).toBe(2);
    expect(html).toContain("项目一");
    expect(html).toContain("嵌套项");
    expect(html).not.toContain("- 项目");
  });

  it("ordered list: li-o + the original marker kept in a faded color", () => {
    const html = renderBlockHtml("1. 第一\n");
    expect(html).toContain("md-list-line li-i0 li-o");
    expect(html).toContain('<span class="md-listmark">1.</span>');
    expect(html).toContain("第一");
  });

  it("task item fallback (the diff layer already excludes them, this only makes sure it does not crash): the checkbox is shown statically", () => {
    expect(renderBlockHtml("- [ ] 待办\n")).toContain('<span class="md-task"></span>');
    expect(renderBlockHtml("- [x] 完成\n")).toContain('<span class="md-task checked"></span>');
  });

  it("quote line: the md-quote line class, the > sign does not appear", () => {
    const html = renderBlockHtml("> 引用一句\n");
    expect(html).toContain("md-quote");
    expect(html).toContain("引用一句");
    expect(html).not.toContain("&gt;");
  });

  it("code fence: the fence lines disappear, the content lines keep md-code-line verbatim", () => {
    const html = renderBlockHtml("```js\nlet a = 1\n```\n");
    expect(html).toContain('class="footprint-line md-code-line"');
    expect(html).toContain("let a = 1");
    expect(html).not.toContain("```");
  });

  it("thematic break: rendered as an hr", () => {
    expect(renderBlockHtml("---\n")).toContain('<div class="fp-hr"><hr></div>');
  });

  it("blank line: rendered as a small gap div", () => {
    expect(renderBlockHtml("甲\n\n乙\n")).toContain('<div class="footprint-gap"></div>');
  });

  it("all whitespace text: an empty string", () => {
    expect(renderBlockHtml("\n\n")).toBe("");
  });
});

describe("footprint block rendering: inline structure", () => {
  it("bold / italic / strikethrough / inline code: the same classes as the editor, the mark characters do not appear", () => {
    const html = renderBlockHtml("**粗** *斜* ~~删~~ `码`\n");
    expect(html).toContain('<strong class="md-strong">粗</strong>');
    expect(html).toContain('<em class="md-em">斜</em>');
    expect(html).toContain('<del class="md-strike">删</del>');
    expect(html).toContain('<code class="md-inline-code">码</code>');
    expect(html).not.toContain("**");
    expect(html).not.toContain("~~");
  });

  it("link: the label in md-link + the URL faded, the parentheses do not appear", () => {
    const html = renderBlockHtml("[标签](http://a.b)\n");
    expect(html).toContain('<span class="md-link">标签</span>');
    expect(html).toContain('<span class="md-url">http://a.b</span>');
    expect(html).not.toContain("(");
  });

  it("wikilink: the alias is shown (without an alias the target), the double brackets do not appear", () => {
    expect(renderBlockHtml("[[页|别名]]\n")).toContain('<span class="md-wikilink">别名</span>');
    expect(renderBlockHtml("[[目标页]]\n")).toContain('<span class="md-wikilink">目标页</span>');
  });

  it("inline formula: $…$ goes through cw-math-inline (KaTeX), the delimiters do not appear", () => {
    const html = renderBlockHtml("质能方程 $E=mc^2$ 成立\n");
    expect(html).toContain("cw-math-inline");
    expect(html).toContain("katex");
    expect(html).not.toContain("$E");
    expect(html).toContain("成立");
  });

  it("「$5 和 $10」 is not a formula: plain text (the same scanning rule as the editor)", () => {
    const html = renderBlockHtml("价格 $5 和 $10 的差\n");
    expect(html).not.toContain("cw-math");
    expect(html).toContain("$5 和 $10");
  });

  it("block formula: a multi-line $$ region is rendered as a whole centered formula block, the fences do not appear", () => {
    const html = renderBlockHtml("$$\n\\frac{a}{b}\n$$\n");
    expect(html).toContain("cw-math-block");
    expect(html).toContain("frac");
    expect(html).not.toContain("$$");
  });
});

describe("footprint block rendering: list geometry same as the editor", () => {
  it("the list depth is computed from the marker column width (the same formula as livePreview: floor(cols/2)*2)", () => {
    const html = renderBlockHtml("- a\n    - 深一层\n");
    expect(html).toContain("li-i4");
  });

  it("indentation fidelity: the geometry class needed for the wrapped line alignment is on every line", () => {
    const html = renderBlockHtml("- 第一行很长\n  折行续在内容起点\n");
    expect(html.match(/md-list-line/g)!.length).toBe(2);
  });
});

describe("footprint block rendering: safety and robustness (the renderer eats any user text)", () => {
  it("escaping gate: the HTML tags in the source text must be escaped, they must not enter the output", () => {
    const html = renderBlockHtml("<img src=x onerror=alert(1)> <script>alert(2)</script>\n");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script");
  });

  it("escaping gate: the HTML inside a heading and inside emphasis is escaped as well", () => {
    const html = renderBlockHtml("# 标题 <b>加粗</b>\n\n正文 **粗<i>x</i>体**\n");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
  });

  it("unclosed syntax does not throw: bold / inline code / math / fence / wikilink", () => {
    const cases = [
      "**未闭合粗体",
      "`未闭合行内码",
      "$$ 未闭合块公式",
      "$ 未闭合行内公式",
      "``` 未闭合围栏\n代码行",
      "[[未闭合wikilink",
      "[未闭合链接](http://a",
      "- [ 未闭合任务",
    ];
    for (const c of cases) expect(() => renderBlockHtml(c)).not.toThrow();
  });

  it("degenerate input does not throw: a very long line / deep nesting / lone marker characters", () => {
    expect(() => renderBlockHtml("超".repeat(20_000))).not.toThrow();
    expect(() => renderBlockHtml("- ".repeat(200) + "深\n")).not.toThrow();
    expect(() => renderBlockHtml("$\n\n$$\n\n[\n\n]\n")).not.toThrow();
  });
});
