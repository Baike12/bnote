import { describe, expect, it } from "vitest";
import { renderAgentMarkdown, renderInline, splitAgentMarkdown } from "./agentMarkdown";

describe("renderInline", () => {
  it("HTML is always escaped, with no pass-through outside the rules", () => {
    expect(renderInline("<script>alert(1)</script>")).not.toContain("<script");
    expect(renderInline('<img src=x onerror="a">')).not.toContain("<img");
  });

  it("inline code is kept verbatim and does not take part in the other rules", () => {
    expect(renderInline("写 `**a**` 看字面量")).toContain("<code>**a**</code>");
  });

  it("bold, italic, strikethrough and links", () => {
    expect(renderInline("**重点**")).toContain("<strong>重点</strong>");
    expect(renderInline("a *斜* b")).toContain("<em>斜</em>");
    expect(renderInline("~~删~~")).toContain("<del>删</del>");
    expect(renderInline("[文档](https://x.y)")).toContain(
      '<a href="https://x.y" target="_blank" rel="noopener">文档</a>',
    );
  });

  it("inline math goes through katex, and the \\(…\\) delimiters are supported too", () => {
    // Stable features of the katex output: a fraction -> .mfrac, a superscript -> .msupsub
    expect(renderInline("$\\frac{a}{b}$")).toContain("mfrac");
    expect(renderInline("\\(x^2\\)")).toContain("msupsub");
  });

  it("a < inside math is restored within katex and emitted escaped (without breaking the HTML structure)", () => {
    const html = renderInline("$a<b$");
    expect(html).toContain("katex");
    expect(html).toContain("&lt;"); // katex has processed the original <
  });

  it("only a paired $ is a formula, a lone dollar sign stays literal", () => {
    expect(renderInline("价格 $5 和 $6")).not.toContain("katex");
    expect(renderInline("价格 $5 和 $6")).toContain("$5 和 $6");
  });
});

describe("renderAgentMarkdown", () => {
  it("heading levels", () => {
    expect(renderAgentMarkdown("## 小节")).toContain("<h2>小节</h2>");
    expect(renderAgentMarkdown("### 深")).toContain("<h3>深</h3>");
  });

  it("a single newline inside a paragraph renders as <br> (line breaks in chat are intentional)", () => {
    expect(renderAgentMarkdown("第一行\n第二行")).toBe("<p>第一行<br>第二行</p>");
  });

  it("unordered and ordered lists with two levels of nesting", () => {
    const ul = renderAgentMarkdown("- a\n- b\n  - b1\n- c");
    expect(ul).toContain("<ul>");
    expect(ul).toContain("<li>a</li>");
    expect(ul).toContain("<li>b<ul><li>b1</li></ul></li>");
    const ol = renderAgentMarkdown("1. 先\n2. 后");
    expect(ol).toContain("<ol>");
    expect(ol).toContain("<li>后</li>");
  });

  it("list items support the inline rules", () => {
    expect(renderAgentMarkdown("- **重点**项")).toContain("<li><strong>重点</strong>项</li>");
  });

  it("an ordered list separated by blank lines is one list with continuous numbering (regression: it used to split into separate <ol> blocks each starting at 1, showing 1. 1. 1. 1. on screen)", () => {
    // The typical output of a model: every item is written as "1.", with a blank line between the items.
    const html = renderAgentMarkdown("1. 甲\n\n1. 乙\n\n1. 丙\n\n1. 丁");
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toBe('<ol class="is-loose"><li>甲</li><li>乙</li><li>丙</li><li>丁</li></ol>');
    // The same holds for explicit numbering: the consecutive numbers are incremented by the browser, the 2./3. in the source do not open another list
    expect(renderAgentMarkdown("1. 甲\n\n2. 乙\n\n3. 丙").match(/<ol/g)).toHaveLength(1);
  });

  it("an unordered list separated by blank lines belongs to one <ul>", () => {
    expect(renderAgentMarkdown("- 甲\n\n- 乙")).toBe('<ul class="is-loose"><li>甲</li><li>乙</li></ul>');
  });

  it("a tight list carries no is-loose (no blank lines between the items means no extra spacing)", () => {
    expect(renderAgentMarkdown("- 甲\n- 乙")).toBe("<ul><li>甲</li><li>乙</li></ul>");
  });

  it("the start number comes from the first item (a list really starting at 3. also starts at 3 on screen)", () => {
    expect(renderAgentMarkdown("3. 丙\n4. 丁")).toBe('<ol start="3"><li>丙</li><li>丁</li></ol>');
    // A list starting at 1. carries no start (it would repeat the browser's default numbering)
    expect(renderAgentMarkdown("1. 甲")).toBe("<ol><li>甲</li></ol>");
  });

  it("a different marker type after a blank line starts another list", () => {
    expect(renderAgentMarkdown("1. 有序\n\n- 无序")).toBe(
      "<ol><li>有序</li></ol><ul><li>无序</li></ul>",
    );
  });

  it("the continuation paragraph of a loose list item (indented) still belongs to that item", () => {
    expect(renderAgentMarkdown("1. 第一段\n\n   第二段")).toBe(
      '<ol class="is-loose"><li>第一段<br>第二段</li></ol>',
    );
  });

  it("a plain paragraph after a list is not swallowed into the last item", () => {
    expect(renderAgentMarkdown("- 甲\n\n这是一段正文。")).toBe(
      "<ul><li>甲</li></ul><p>这是一段正文。</p>",
    );
  });

  it("a fenced code block is escaped as a whole and carries the language class name", () => {
    const html = renderAgentMarkdown('```ts\nconst a = "<b>";\n```');
    expect(html).toContain('<pre class="agent-code language-ts"><code>');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("an unclosed fenced code block runs to the end of the document", () => {
    const html = renderAgentMarkdown("```\nabc");
    expect(html).toContain("abc");
  });

  it("block math with $$…$$ and \\[…\\], which may span lines", () => {
    const block = renderAgentMarkdown("$$\n\\int_0^1 x\\,dx\n$$");
    expect(block).toContain("katex-display");
    expect(block).toContain("∫");
    expect(block).not.toContain("<p>");
    const bracket = renderAgentMarkdown("\\[\nE = mc^2\n\\]");
    expect(bracket).toContain("katex-display");
    expect(bracket).toContain("msupsub");
  });

  it("block math inside a list item goes through KaTeX (regression: the model indents the $$ block under a list item, and it used to leak out verbatim)", () => {
    // The shape reported by the user: a multi-line $$…$$ block in the continuation line of an ordered list item
    const html = renderAgentMarkdown(
      "1. 全局 Softmax 分母\n   $$\n   s_p=\\sum_{j\\in C_p}e^{x_j-x_{\\max}}\n   $$\n   再 all-reduce。",
    );
    expect(html).toContain("<ol>");
    expect(html).toContain("katex-display");
    expect(html).toContain("∑");
    expect(html).not.toContain("$$");
    // The \[…\] block is supported the same way
    const bracket = renderAgentMarkdown("- 要点\n  \\[\n  E = mc^2\n  \\]");
    expect(bracket).toContain("katex-display");
    // The text lines around the math block are still rendered inline and separated by <br>
    const mixed = renderAgentMarkdown("- 文本行\n  $$\n  x^2\n  $$\n  **尾行**");
    expect(mixed).toContain("<strong>尾行</strong>");
    expect(mixed.indexOf("katex-display")).toBeGreaterThan(-1);
  });

  it("a blockquote recursively renders the markdown inside it", () => {
    const html = renderAgentMarkdown("> 引用 **重点**");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<strong>重点</strong>");
  });

  it("a horizontal rule", () => {
    expect(renderAgentMarkdown("---")).toContain("<hr>");
  });

  it("tables: header + rows, with cells using the inline rules", () => {
    const html = renderAgentMarkdown(
      "| 概念 | 区别 |\n| --- | --- |\n| **A** | 快 |\n| B | 慢 |",
    );
    expect(html).toContain("<table><thead>");
    expect(html).toContain("<th>概念</th>");
    expect(html).toContain("<td><strong>A</strong></td>");
    expect(html).toContain("<td>慢</td>");
  });

  it("a mixed document is emitted block by block in order", () => {
    const html = renderAgentMarkdown("## 结论\n\n先说答案:是的。\n\n- 要点一\n- 要点二");
    expect(html.indexOf("<h2>")).toBe(0);
    expect(html).toContain("<p>先说答案:是的。</p>");
    expect(html).toContain("<ul>");
  });
});

describe("splitAgentMarkdown", () => {
  it("a closed top-level html fence becomes a verbatim preview block", () => {
    const code = "<p>hi</p><script>1+1</script>";
    const blocks = splitAgentMarkdown(`前文\n\n\`\`\`html\n${code}\n\`\`\`\n\n后文`);
    expect(blocks).toEqual([
      { kind: "markdown", html: expect.stringContaining("前文") },
      { kind: "html", code },
      { kind: "markdown", html: expect.stringContaining("后文") },
    ]);
  });

  it("renderAgentMarkdown keeps emitting html fences as code blocks", () => {
    const html = renderAgentMarkdown("```html\n<p>hi</p>\n```");
    expect(html).toContain("agent-code");
    expect(html).toContain("&lt;p&gt;");
    expect(html).not.toContain("<p>hi</p>");
  });

  it("htm is the same language; case does not matter", () => {
    for (const lang of ["HTML", "htm", "Html"]) {
      const blocks = splitAgentMarkdown("```" + lang + "\n<p>x</p>\n```");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({ kind: "html", code: "<p>x</p>" });
    }
  });

  it("an unclosed html fence (streaming tail) stays a code block", () => {
    const blocks = splitAgentMarkdown("```html\n<p>x</p>");
    expect(blocks).toEqual([
      { kind: "markdown", html: expect.stringContaining("agent-code") },
    ]);
  });

  it("an html fence nested in a list stays a plain code block", () => {
    const src = "- 要点\n  ```html\n  <p>x</p>\n  ```";
    const blocks = splitAgentMarkdown(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("markdown");
    expect(blocks[0].kind === "markdown" && blocks[0].html).toContain("<li>");
  });

  it("empty input yields no blocks", () => {
    expect(splitAgentMarkdown("")).toEqual([]);
  });
});
