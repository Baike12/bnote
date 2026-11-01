import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * Gate for the scroll chain of the study assistant.
 *
 * Root cause (2026-10-26): `.agent-panel` is a child of a column flex
 * (`.study-left`), where `min-height: auto` resolves to the content's
 * minimum height. As soon as the conversation got long the panel grew to the
 * content height and overflowed the page, `.agent-scroll`'s clientHeight was
 * permanently equal to its scrollHeight, `overflow-y: auto` had nothing to
 * scroll, and the wheel did nothing while the input box was pushed out of
 * the window.
 *
 * A node test without DOM cannot measure pixels, so both ends of the chain
 * are locked here: the panel must be allowed to shrink (min-height: 0) and
 * the message area must be the only vertical scroll container.
 */
const css = readFileSync("src/styles/global.css", "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const rule = (selector: string): string => {
  // Parse by rule block instead of by a line-anchored regex: the dividers
  // share one style, and with a selector list written as
  // `.study-resizer,\n.projects-resizer {` the line-anchored regex misses it.
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
 * Gate for the study assistant header (session switch and auxiliary session bar).
 *
 * Root cause (2026-10-30): the session switch used a native `<select>`,
 * which in WKWebView is the system grey pill in the system font and not the
 * same language as the middle column's "file name = materials dropdown"; the
 * auxiliary session bar pushed the whole summary of the parent session into
 * the "back" button (flex-shrink: 0), a colored band filled the entire row
 * and the source text was squeezed to a few characters. The new shape is
 * locked here: a custom button plus popover, a narrow bar with the same
 * background as the header, and a fixed-width back button.
 */
describe("学习助手头部:会话切换与辅助会话条", () => {
  const panelSrc = readFileSync("src/components/AgentPanel.tsx", "utf8");
  const headerSrc = readFileSync("src/components/AgentHeader.tsx", "utf8");
  // Only the code is searched: a comment saying "no native <select>" is documentation, not a violation.
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
    // The four header buttons (4 x 26 + 3 x 8 = 128) need that much room:
    // reserve less and in a narrow window it is the icon itself that gets
    // squeezed.
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
    // min-width: 0 is the precondition for ellipsis (a flex item is stretched by its content's minimum width by default).
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
 * Gate for the conversation font size.
 *
 * Root cause (2026-10-30): the panel body was hard-coded to 13.5px, the
 * assistant column is only a few hundred pixels wide and a long answer read
 * blurry, while the middle column could be zoomed and the assistant column
 * could not. The body text is now derived from `--agent-text` (a 15px base
 * times the `--agent-fs` written by the "Aa" button in the header), and all
 * body-level text multiplies it; the header and the auxiliary bar are the
 * outer frame and keep fixed pixels.
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
    // Multi-line selector (the heading group) and the single-line h1
    // override: the rule block parser cannot get the first line of a
    // multi-line selector, so the source is queried directly.
    expect(css).toMatch(/\.agent-md h6 \{\n[^}]*font-size: var\(--agent-text\)/);
    // The top level heading is one step larger than the body, still derived from it
    expect(css).toMatch(/\.agent-md h1 \{ font-size: calc\(var\(--agent-text\) \* 1\.1\); \}/);
  });

  it("缩放值由面板根元素写入(单一写入者),控件在头部", () => {
    expect(panelSrc).toMatch(/--agent-fs/);
    expect(panelSrc).toMatch(/agentFontScale/);
    expect(rule(".agent-font-pop")).toMatch(/position:\s*absolute/);
    expect(rule(".agent-font-value")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
