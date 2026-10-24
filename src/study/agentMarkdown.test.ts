import { describe, expect, it } from "vitest";
import { renderAgentMarkdown, renderInline } from "./agentMarkdown";

describe("renderInline", () => {
  it("HTML 一律转义,规则之外没有放行通道", () => {
    expect(renderInline("<script>alert(1)</script>")).not.toContain("<script");
    expect(renderInline('<img src=x onerror="a">')).not.toContain("<img");
  });

  it("行内代码原样保留,不参与其他规则", () => {
    expect(renderInline("写 `**a**` 看字面量")).toContain("<code>**a**</code>");
  });

  it("粗体、斜体、删除线、链接", () => {
    expect(renderInline("**重点**")).toContain("<strong>重点</strong>");
    expect(renderInline("a *斜* b")).toContain("<em>斜</em>");
    expect(renderInline("~~删~~")).toContain("<del>删</del>");
    expect(renderInline("[文档](https://x.y)")).toContain(
      '<a href="https://x.y" target="_blank" rel="noopener">文档</a>',
    );
  });

  it("行内数学走 katex,\\(…\\) 定界符同样支持", () => {
    // katex 输出的稳定特征:分数 → .mfrac,上标 → .msupsub
    expect(renderInline("$\\frac{a}{b}$")).toContain("mfrac");
    expect(renderInline("\\(x^2\\)")).toContain("msupsub");
  });

  it("数学里的 < 在 katex 内还原并转义输出(不破坏 HTML 结构)", () => {
    const html = renderInline("$a<b$");
    expect(html).toContain("katex");
    expect(html).toContain("&lt;"); // katex 处理过原始的 <
  });

  it("成对的 $ 才是公式,孤立美元符留作字面量", () => {
    expect(renderInline("价格 $5 和 $6")).not.toContain("katex");
    expect(renderInline("价格 $5 和 $6")).toContain("$5 和 $6");
  });
});

describe("renderAgentMarkdown", () => {
  it("标题层级", () => {
    expect(renderAgentMarkdown("## 小节")).toContain("<h2>小节</h2>");
    expect(renderAgentMarkdown("### 深")).toContain("<h3>深</h3>");
  });

  it("段落内单个换行渲染为 <br>(聊天里的换行是有意的)", () => {
    expect(renderAgentMarkdown("第一行\n第二行")).toBe("<p>第一行<br>第二行</p>");
  });

  it("无序与有序列表,两级嵌套", () => {
    const ul = renderAgentMarkdown("- a\n- b\n  - b1\n- c");
    expect(ul).toContain("<ul>");
    expect(ul).toContain("<li>a</li>");
    expect(ul).toContain("<li>b<ul><li>b1</li></ul></li>");
    const ol = renderAgentMarkdown("1. 先\n2. 后");
    expect(ol).toContain("<ol>");
    expect(ol).toContain("<li>后</li>");
  });

  it("列表项支持行内规则", () => {
    expect(renderAgentMarkdown("- **重点**项")).toContain("<li><strong>重点</strong>项</li>");
  });

  it("围栏代码块整体转义,带语言类名", () => {
    const html = renderAgentMarkdown('```ts\nconst a = "<b>";\n```');
    expect(html).toContain('<pre class="agent-code language-ts"><code>');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("未闭合的围栏代码块到文末为止", () => {
    const html = renderAgentMarkdown("```\nabc");
    expect(html).toContain("abc");
  });

  it("块级数学 $$…$$ 与 \\[…\\],可跨行", () => {
    const block = renderAgentMarkdown("$$\n\\int_0^1 x\\,dx\n$$");
    expect(block).toContain("katex-display");
    expect(block).toContain("∫");
    expect(block).not.toContain("<p>");
    const bracket = renderAgentMarkdown("\\[\nE = mc^2\n\\]");
    expect(bracket).toContain("katex-display");
    expect(bracket).toContain("msupsub");
  });

  it("引用块递归渲染内部 markdown", () => {
    const html = renderAgentMarkdown("> 引用 **重点**");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<strong>重点</strong>");
  });

  it("分隔线", () => {
    expect(renderAgentMarkdown("---")).toContain("<hr>");
  });

  it("表格:表头 + 行,单元格走行内规则", () => {
    const html = renderAgentMarkdown(
      "| 概念 | 区别 |\n| --- | --- |\n| **A** | 快 |\n| B | 慢 |",
    );
    expect(html).toContain("<table><thead>");
    expect(html).toContain("<th>概念</th>");
    expect(html).toContain("<td><strong>A</strong></td>");
    expect(html).toContain("<td>慢</td>");
  });

  it("混合文档按块依序输出", () => {
    const html = renderAgentMarkdown("## 结论\n\n先说答案:是的。\n\n- 要点一\n- 要点二");
    expect(html.indexOf("<h2>")).toBe(0);
    expect(html).toContain("<p>先说答案:是的。</p>");
    expect(html).toContain("<ul>");
  });
});
