import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { blockDecorationsField } from "./livePreview";
import { visibleVerticalTarget } from "./motionClamp";

/**
 * Line numbers (starting at 1):
 *  1 above
 *  2 $$
 *  3 x = 1
 *  4 y = 2
 *  5 $$
 *  6 mid
 *  7 (blank line)
 *  8 ---
 *  9 (blank line)
 * 10 after hr
 * 11 (blank line)
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

/** Builds a state with a complete syntax tree and the block decoration field (the same source of decorations as the real editor). */
function makeState(doc: string): EditorState {
  const created = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] }), blockDecorationsField],
  });
  ensureSyntaxTree(created, created.doc.length);
  // An empty transaction makes the field rebuild from the complete syntax tree (same as primeSyntaxTree in setup.ts).
  return created.update({}).state;
}

describe("visibleVerticalTarget（可见行步进——j/k 的垂直维度模型）", () => {
  const state = makeState(DOC);
  // The visibility of the fences is decided by the field rebuilding from the selection: putting the selection inside the code block simulates an "active block".
  const stateInsideFence = state
    .update({ selection: { anchor: state.doc.line(13).from } })
    .state;

  it("普通行按文档行计数", () => {
    expect(visibleVerticalTarget(state, 1, true, 1)).toBe(2);
    expect(visibleVerticalTarget(state, 1, true, 2)).toBe(3);
    expect(visibleVerticalTarget(state, 6, false, 2)).toBe(4);
  });

  it("跨折叠公式块：近端边缘是落点，块内源码在展开后是普通步", () => {
    // the caret is at 1 (outside the block): the first step lands on the $$ opening line (the edge, stopping there expands it).
    expect(visibleVerticalTarget(state, 1, true, 1)).toBe(2);
    // the second step is inside the source: the active region is not a hidden step.
    expect(visibleVerticalTarget(state, 1, true, 2)).toBe(3);
    // walking the whole block takes 5 steps: opening line, source 1, source 2, closing line, next line.
    expect(visibleVerticalTarget(state, 1, true, 5)).toBe(6);
    // bottom-up: the closing line is the near edge.
    expect(visibleVerticalTarget(state, 6, false, 1)).toBe(5);
  });

  it("hr 渲染态是隐藏步，被跳过", () => {
    // the caret is at 7 (blank line): the `---` on 8 is an hr (there is a blank line before it, so it is not a setext underline).
    expect(visibleVerticalTarget(state, 7, true, 1)).toBe(9);
  });

  it("折叠围栏行是隐藏步，代码内容行是普通步", () => {
    // the caret is at 11 (outside the block): the ``` on 12 is hidden, so it lands on the content line 13.
    expect(visibleVerticalTarget(state, 11, true, 1)).toBe(13);
    // the selection is inside the block: the fence lines stay visible as source, and 14 is a normal step.
    expect(visibleVerticalTarget(stateInsideFence, 13, true, 1)).toBe(14);
    // bottom-up: 14 is hidden and skipped, so it lands on 13.
    expect(visibleVerticalTarget(state, 15, false, 1)).toBe(13);
  });

  it("步数超出文档端时停在边界", () => {
    expect(visibleVerticalTarget(state, 14, true, 10)).toBe(15);
    expect(visibleVerticalTarget(state, 2, false, 10)).toBe(1);
  });
});
