import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * 学习助手的滚动链条门禁。
 *
 * 根因(2026-10-26):`.agent-panel` 是 column flex 的子项(`.study-left`),
 * `min-height: auto` 解析成内容最小高度——对话一长,面板长到内容高度、
 * 溢出页面,`.agent-scroll` 的 clientHeight 恒等于 scrollHeight,`overflow-y:
 * auto` 无可滚动余量,于是滚轮不动、输入框被顶出窗口。
 *
 * 没有 DOM 的 node 测试量不到像素,这里锁链条的两端:面板必须允许收缩
 * (min-height: 0),消息区必须是唯一的纵向滚动容器。
 */
const css = readFileSync("src/styles/global.css", "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const rule = (selector: string): string => {
  // 按规则块解析而不是按行首正则:分栏线是共用样式,选择器列表写成
  // `.study-resizer,\n.projects-resizer {` 时行首正则取不到。
  for (const block of css.split("}")) {
    const at = block.lastIndexOf("{");
    if (at < 0) continue;
    const selectors = block
      .slice(0, at)
      .split(",")
      .map((s: string) => s.trim());
    if (selectors.includes(selector)) return block.slice(at + 1);
  }
  expect(null, `${selector} 规则消失`).not.toBeNull();
  return "";
};

describe("agent 面板滚动布局", () => {
  it("面板在 column flex 里可收缩(min-height: 0)", () => {
    expect(rule(".agent-panel")).toMatch(/min-height:\s*0/);
  });

  it("消息区是纵向滚动容器", () => {
    const scroll = rule(".agent-scroll");
    expect(scroll).toMatch(/overflow-y:\s*auto/);
    expect(scroll).toMatch(/flex:\s*1/);
  });

  it("两栏之间没有可见空隙:分栏线只占 1px,命中区靠伪元素外扩", () => {
    expect(rule(".study-resizer")).toMatch(/flex:\s*0 0 1px/);
    expect(rule(".study-resizer::after")).toMatch(/left:\s*-4px/);
    expect(rule(".study-resizer::after")).toMatch(/right:\s*-4px/);
  });

  it("项目视图的两根分栏线与学习模式共用同一套几何(只占 1px,不外扩布局)", () => {
    expect(rule(".projects-resizer")).toMatch(/flex:\s*0 0 1px/);
    expect(rule(".projects-resizer::after")).toMatch(/left:\s*-4px/);
    expect(rule(".projects-resizer::after")).toMatch(/right:\s*-4px/);
  });

  it("agent 顶部与 PDF 顶栏同色(bg0),不是面板灰", () => {
    expect(rule(".agent-panel")).toMatch(/background:\s*var\(--bg0\)/);
    expect(rule(".agent-header")).toMatch(/background:\s*var\(--bg0\)/);
  });
});

/**
 * 学习助手头部(会话切换 + 辅助会话条)的门禁。
 *
 * 根因(2026-10-30):会话切换用的是原生 `<select>`,在 WKWebView 里是系统
 * 灰胶囊 + 系统字体,和中栏「文件名 = 材料下拉」不是一套语言;辅助会话条把
 * 父会话的整段摘要塞进「返回」按钮(flex-shrink: 0),一条彩色带占满整行,
 * 来源文字被挤到只剩几字。这里锁住新形状:自定义按钮 + popover、与头部同
 * 底色的窄条、定宽的返回按钮。
 */
describe("学习助手头部:会话切换与辅助会话条", () => {
  const panelSrc = readFileSync("src/components/AgentPanel.tsx", "utf8");
  const headerSrc = readFileSync("src/components/AgentHeader.tsx", "utf8");
  // 只查代码:注释里写着「不用原生 <select>」是说明,不是违规。
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("会话切换不用原生 <select>(系统控件与项目 UI 不统一)", () => {
    expect(code(panelSrc)).not.toMatch(/<select/);
    expect(code(headerSrc)).not.toMatch(/<select/);
    expect(panelSrc).toMatch(/<AgentHeader/);
    expect(headerSrc).toMatch(/agent-conv-pop/);
  });

  it("标题按钮与中栏材料下拉同一套几何:26px 高、透明底、hover 才出底色", () => {
    const button = rule(".agent-conv-btn");
    expect(button).toMatch(/height:\s*26px/);
    expect(button).toMatch(/background:\s*transparent/);
    expect(rule(".agent-conv-btn.open")).toMatch(/background:\s*var\(--bg3\)/);
    expect(rule(".content-title-btn.open")).toMatch(/background:\s*var\(--bg3\)/);
  });

  it("会话标题过长时省略,不挤掉右侧按钮", () => {
    const title = rule(".agent-conv-title");
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(title).toMatch(/white-space:\s*nowrap/);
    // 头部四个按钮(4 × 26 + 3 × 8 = 128)必须留够:少留一点,窄窗口下被
    // 压扁的就是图标本身。
    expect(rule(".agent-conv")).toMatch(/max-width:\s*calc\(100% - 144px\)/);
    expect(rule(".agent-header .icon-btn")).toMatch(/flex:\s*0 0 auto/);
  });

  it("辅助会话条与头部同底色,两块只画一条下边框", () => {
    expect(rule(".agent-aux-bar")).toMatch(/background:\s*var\(--bg0\)/);
    expect(rule(".agent-aux-bar")).not.toMatch(/color-mix/);
    expect(rule(".agent-header:has(+ .agent-aux-bar)")).toMatch(/border-bottom:\s*none/);
  });

  it("返回按钮定宽,来源摘要是唯一可省略的那一段", () => {
    expect(rule(".agent-aux-back")).toMatch(/flex:\s*0 0 auto/);
    const based = rule(".agent-aux-based");
    // min-width: 0 是 ellipsis 生效的前提(flex 子项默认按内容最小宽度撑开)。
    expect(based).toMatch(/min-width:\s*0/);
    expect(based).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("历史抽屉让开辅助条,不盖住来源与返回", () => {
    expect(rule(".agent-panel:has(.agent-aux-bar) .agent-history")).toMatch(
      /top:\s*calc\(var\(--study-head-h\) \+ 30px\)/,
    );
  });
});

/**
 * 对话字号门禁。
 *
 * 根因(2026-10-30):面板正文写死 13.5px,助手栏只有几百像素宽,长答案
 * 读起来发虚,而中栏能缩放、助手栏不能。现在正文由 `--agent-text`
 * (基准 15px × 头部「Aa」写入的 `--agent-fs`)派生,所有正文级文字都乘它;
 * 头部/辅助条是外框,保持固定像素。
 */
describe("学习助手:对话字号可调", () => {
  const panelSrc = readFileSync("src/components/AgentPanel.tsx", "utf8");

  it("正文基准不低于 14px(13.5px 就是这次要修的「太小」)", () => {
    const panel = rule(".agent-panel");
    expect(panel).toMatch(/--agent-body:\s*15px/);
    expect(panel).toMatch(/--agent-fs:\s*1/);
    expect(panel).toMatch(/--agent-text:\s*calc\(var\(--agent-body\) \* var\(--agent-fs\)\)/);
  });

  it("正文级文字都乘 --agent-text(改一处不会漏掉消息或输入框)", () => {
    for (const selector of [
      ".agent-msg",
      ".agent-md",
      ".agent-thinking-body",
      ".agent-tool",
      ".agent-input",
    ]) {
      expect(rule(selector)).toMatch(
        /font-size:\s*(var\(--agent-text\)|calc\(var\(--agent-text\) \* [\d.]+\))/,
      );
    }
    // 多行选择器(标题组)与单行 h1 覆盖:规则块解析拿不到多行首行,直接查源码。
    expect(css).toMatch(/\.agent-md h6 \{\n[^}]*font-size: var\(--agent-text\)/);
    // 一级标题比正文大一档,仍由正文派生
    expect(css).toMatch(/\.agent-md h1 \{ font-size: calc\(var\(--agent-text\) \* 1\.1\); \}/);
  });

  it("缩放值由面板根元素写入(单一写入者),控件在头部", () => {
    expect(panelSrc).toMatch(/--agent-fs/);
    expect(panelSrc).toMatch(/agentFontScale/);
    expect(rule(".agent-font-pop")).toMatch(/position:\s*absolute/);
    expect(rule(".agent-font-value")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
