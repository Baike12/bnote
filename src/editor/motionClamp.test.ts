import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { blockDecorationsField } from "./livePreview";
import { visibleVerticalTarget } from "./motionClamp";

/**
 * 行号（1 起）：
 *  1 above
 *  2 $$
 *  3 x = 1
 *  4 y = 2
 *  5 $$
 *  6 mid
 *  7 （空行）
 *  8 ---
 *  9 （空行）
 * 10 after hr
 * 11 （空行）
 * 12 ```js
 * 13 code
 * 14 ```
 * 15 after fence
 */
const DOC = [
  "above",
  "$$",
  "x = 1",
  "y = 2",
  "$$",
  "mid",
  "",
  "---",
  "",
  "after hr",
  "",
  "```js",
  "code",
  "```",
  "after fence",
].join("\n");

/** 建一个带完整语法树 + 块装饰 field 的 state（与真实编辑器同一套装饰来源）。 */
function makeState(doc: string): EditorState {
  const created = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] }), blockDecorationsField],
  });
  ensureSyntaxTree(created, created.doc.length);
  // 空事务触发 field 按完整语法树重建（与 setup.ts 的 primeSyntaxTree 同理）。
  return created.update({}).state;
}

describe("visibleVerticalTarget（可见行步进——j/k 的垂直维度模型）", () => {
  const state = makeState(DOC);
  // 围栏的可见性由 field 按选区重建决定：把选区放进代码块内部模拟"块活动"。
  const stateInsideFence = state
    .update({ selection: { anchor: state.doc.line(13).from } })
    .state;

  it("普通行按文档行计数", () => {
    expect(visibleVerticalTarget(state, 1, true, 1)).toBe(2);
    expect(visibleVerticalTarget(state, 1, true, 2)).toBe(3);
    expect(visibleVerticalTarget(state, 6, false, 2)).toBe(4);
  });

  it("跨折叠公式块：近端边缘是落点，块内源码在展开后是普通步", () => {
    // 光标在 1（块外）：第一步落在 $$ 开行（边缘，停上去即展开）。
    expect(visibleVerticalTarget(state, 1, true, 1)).toBe(2);
    // 第二步在源码内：活动区域不是隐藏步。
    expect(visibleVerticalTarget(state, 1, true, 2)).toBe(3);
    // 走完整个块需要 5 步：开行、源1、源2、闭行、下一行。
    expect(visibleVerticalTarget(state, 1, true, 5)).toBe(6);
    // 自下而上：闭行是近端边缘。
    expect(visibleVerticalTarget(state, 6, false, 1)).toBe(5);
  });

  it("hr 渲染态是隐藏步，被跳过", () => {
    // 光标在 7（空行）：8 的 `---` 是 hr（前有空行，不是 setext 下划线）。
    expect(visibleVerticalTarget(state, 7, true, 1)).toBe(9);
  });

  it("折叠围栏行是隐藏步，代码内容行是普通步", () => {
    // 光标在 11（块外）：12 的 ``` 隐藏，落到内容行 13。
    expect(visibleVerticalTarget(state, 11, true, 1)).toBe(13);
    // 选区在块内：围栏行保持源码可见，14 是普通步。
    expect(visibleVerticalTarget(stateInsideFence, 13, true, 1)).toBe(14);
    // 自下而上：14 隐藏被跳过，落 13。
    expect(visibleVerticalTarget(state, 15, false, 1)).toBe(13);
  });

  it("步数超出文档端时停在边界", () => {
    expect(visibleVerticalTarget(state, 14, true, 10)).toBe(15);
    expect(visibleVerticalTarget(state, 2, false, 10)).toBe(1);
  });
});
