import { describe, expect, it } from "vitest";
import { renderBlockHtml } from "./render";

/**
 * 足迹块渲染的结构契约:复用编辑器的类名(md-heading、md-list-line、li-i 系列)
 * 和同一个公式扫描器,才能做到「日记里看到的和原文一样」。这里锁类名与
 * 内容的对应关系——渲染产物是 innerHTML 字符串,断言关键片段即可。
 */

describe("足迹块渲染:块级结构", () => {
  it("标题:raw # 不出现,正文进 md-heading md-h{n}", () => {
    const html = renderBlockHtml("# 为什么需要多头\n");
    expect(html).toContain('<span class="md-heading md-h1">为什么需要多头</span>');
    expect(html).not.toContain("#");
  });

  it("无序列表:li-i0 li-b 几何类 + md-bullet 圆点,嵌套按列宽升层", () => {
    const html = renderBlockHtml("- 项目一\n  - 嵌套项\n");
    expect(html).toContain('<div class="footprint-line md-list-line li-i0 li-b">');
    expect(html).toContain('<div class="footprint-line md-list-line li-i2 li-b">');
    expect(html.match(/md-bullet/g)!.length).toBe(2);
    expect(html).toContain("项目一");
    expect(html).toContain("嵌套项");
    expect(html).not.toContain("- 项目");
  });

  it("有序列表:li-o + 原始标记淡色保留", () => {
    const html = renderBlockHtml("1. 第一\n");
    expect(html).toContain("md-list-line li-i0 li-o");
    expect(html).toContain('<span class="md-listmark">1.</span>');
    expect(html).toContain("第一");
  });

  it("任务项兜底(diff 层已排除,这里只保证不炸):checkbox 静态展示", () => {
    expect(renderBlockHtml("- [ ] 待办\n")).toContain('<span class="md-task"></span>');
    expect(renderBlockHtml("- [x] 完成\n")).toContain('<span class="md-task checked"></span>');
  });

  it("引用行:md-quote 行类,> 符号不出现", () => {
    const html = renderBlockHtml("> 引用一句\n");
    expect(html).toContain("md-quote");
    expect(html).toContain("引用一句");
    expect(html).not.toContain("&gt;");
  });

  it("代码围栏:围栏行消失,内容行 md-code-line 原样保真", () => {
    const html = renderBlockHtml("```js\nlet a = 1\n```\n");
    expect(html).toContain('class="footprint-line md-code-line"');
    expect(html).toContain("let a = 1");
    expect(html).not.toContain("```");
  });

  it("分隔线:渲染成 hr", () => {
    expect(renderBlockHtml("---\n")).toContain('<div class="fp-hr"><hr></div>');
  });

  it("空行:渲染成小间隔 div", () => {
    expect(renderBlockHtml("甲\n\n乙\n")).toContain('<div class="footprint-gap"></div>');
  });

  it("全空白文本:空串", () => {
    expect(renderBlockHtml("\n\n")).toBe("");
  });
});

describe("足迹块渲染:行内结构", () => {
  it("粗体/斜体/删除线/行内码:编辑器同款类,mark 字符不出现", () => {
    const html = renderBlockHtml("**粗** *斜* ~~删~~ `码`\n");
    expect(html).toContain('<strong class="md-strong">粗</strong>');
    expect(html).toContain('<em class="md-em">斜</em>');
    expect(html).toContain('<del class="md-strike">删</del>');
    expect(html).toContain('<code class="md-inline-code">码</code>');
    expect(html).not.toContain("**");
    expect(html).not.toContain("~~");
  });

  it("链接:标签 md-link + URL 淡色,括号不出现", () => {
    const html = renderBlockHtml("[标签](http://a.b)\n");
    expect(html).toContain('<span class="md-link">标签</span>');
    expect(html).toContain('<span class="md-url">http://a.b</span>');
    expect(html).not.toContain("(");
  });

  it("wikilink:显示别名(无别名显示目标),双括号不出现", () => {
    expect(renderBlockHtml("[[页|别名]]\n")).toContain('<span class="md-wikilink">别名</span>');
    expect(renderBlockHtml("[[目标页]]\n")).toContain('<span class="md-wikilink">目标页</span>');
  });

  it("行内公式:$…$ 走 cw-math-inline(KaTeX),界定符不出现", () => {
    const html = renderBlockHtml("质能方程 $E=mc^2$ 成立\n");
    expect(html).toContain("cw-math-inline");
    expect(html).toContain("katex");
    expect(html).not.toContain("$E");
    expect(html).toContain("成立");
  });

  it("「$5 和 $10」不是公式:原样文本(与编辑器同一条扫描规则)", () => {
    const html = renderBlockHtml("价格 $5 和 $10 的差\n");
    expect(html).not.toContain("cw-math");
    expect(html).toContain("$5 和 $10");
  });

  it("块级公式:多行 $$ 区域整体渲染为居中公式块,围栏不出现", () => {
    const html = renderBlockHtml("$$\n\\frac{a}{b}\n$$\n");
    expect(html).toContain("cw-math-block");
    expect(html).toContain("frac");
    expect(html).not.toContain("$$");
  });
});

describe("足迹块渲染:列表几何与编辑器同款", () => {
  it("列表深度按标记列宽算(livePreview 同一公式:floor(列/2)*2)", () => {
    const html = renderBlockHtml("- a\n    - 深一层\n");
    expect(html).toContain("li-i4");
  });

  it("缩进保真:折行对齐所需的几何类挂在每一行", () => {
    const html = renderBlockHtml("- 第一行很长\n  折行续在内容起点\n");
    expect(html.match(/md-list-line/g)!.length).toBe(2);
  });
});

describe("足迹块渲染:安全与健壮性(渲染器吃任意用户文本)", () => {
  it("转义门禁:源文本里的 HTML 标签必须被转义,不得进入产物", () => {
    const html = renderBlockHtml('<img src=x onerror=alert(1)> <script>alert(2)</script>\n');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script");
  });

  it("转义门禁:标题与强调内部的 HTML 同样转义", () => {
    const html = renderBlockHtml("# 标题 <b>加粗</b>\n\n正文 **粗<i>x</i>体**\n");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
  });

  it("未闭合的语法不抛异常:粗体/行内码/数学/围栏/wikilink", () => {
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

  it("退化输入不抛异常:超长行/深层嵌套/孤立标记字符", () => {
    expect(() => renderBlockHtml("超".repeat(20_000))).not.toThrow();
    expect(() => renderBlockHtml("- ".repeat(200) + "深\n")).not.toThrow();
    expect(() => renderBlockHtml("$\n\n$$\n\n[\n\n]\n")).not.toThrow();
  });
});
