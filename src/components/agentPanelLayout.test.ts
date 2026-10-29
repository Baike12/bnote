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
