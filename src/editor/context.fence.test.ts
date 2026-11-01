import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { insideFencedCode, insideFencedCodeByScan } from "./context";

/**
 * The shared "is the caret inside a fenced code block" decision (used by the
 * IME keeping English and by the list-continuation guard):
 *  - tree ready: query the syntax tree, the fence marker lines themselves
 *    count as inside the block;
 *  - tree not ready (file just loaded, background parsing unfinished): fall
 *    back to the line scan, where the fence marker lines do not count.
 *
 * Layering note: in the node environment the syntax tree is parsed
 * synchronously at EditorState.create time (no view, so no background parsing
 * window), which makes insideFencedCode's fallback branch impossible to
 * drive from a unit test — the scan semantics are pinned directly by the pure
 * function insideFencedCodeByScan, and the known difference between the two
 * paths (the fence marker lines) is spelled out in both the comment and the
 * assertions below so that neither side can change alone.
 */

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
}

/** Tree-ready path: force a full parse after creating the state. */
function parsedState(doc: string): EditorState {
  const state = makeState(doc);
  ensureSyntaxTree(state, state.doc.length);
  return state;
}

const atLineEnd = (state: EditorState, lineNo: number) => state.doc.line(lineNo).to;
const atLineMid = (state: EditorState, lineNo: number, col: number) =>
  state.doc.line(lineNo).from + col;

describe("insideFencedCode:树就绪(语法树路径)", () => {
  const state = parsedState(
    ["正文一段", "", "```python", "x = 1", "print(x)", "```", "", "~~~ts", "const a = 1;", "~~~", ""].join("\n"),
  );

  it("围栏内容行在内,正文行不在", () => {
    expect(insideFencedCode(state, atLineMid(state, 1, 1))).toBe(false);
    expect(insideFencedCode(state, atLineEnd(state, 4))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 5))).toBe(true);
    expect(insideFencedCode(state, atLineMid(state, 7, 0))).toBe(false); // the blank line between the two blocks
  });

  it("围栏标记行自身算块内(光标在 ``` 行上敲语言名也是敲代码)", () => {
    expect(insideFencedCode(state, atLineEnd(state, 3))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 6))).toBe(true);
  });

  it("波浪号围栏同样识别;其他语言无关(是块就保持英文)", () => {
    expect(insideFencedCode(state, atLineEnd(state, 9))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 10))).toBe(true);
  });

  it("列表内缩进围栏也算(行首缩进不影响树归属)", () => {
    const indented = parsedState(["- 项目", "", "  ```python", "  x = 1", "  ```"].join("\n"));
    expect(insideFencedCode(indented, atLineEnd(indented, 4))).toBe(true);
    expect(insideFencedCode(indented, atLineEnd(indented, 1))).toBe(false);
  });
});

describe("insideFencedCode:行扫描兜底的纯函数语义", () => {
  // In node the syntax tree is always parsed synchronously, so
  // insideFencedCode's fallback branch can only trigger at runtime; here we
  // pin the pure function the fallback uses directly (same scan model as
  // fenceStateScan).
  const doc = ["```python", "x = 1", "```", "正文", "", "```ts", "const b = 2;"].join("\n");
  const state = makeState(doc);
  const lineLen = (n: number) => state.doc.line(n).to;

  it("内容行在内;开栏行不在(其闭栏行按扫描语义算在内),正文不在", () => {
    expect(insideFencedCodeByScan(state.doc, 1)).toBe(false); // ```python opening line: the fence only opens once that line is processed
    expect(insideFencedCodeByScan(state.doc, 2)).toBe(true);
    expect(insideFencedCodeByScan(state.doc, 3)).toBe(true); // ``` closing line: the lines before it are still open
    expect(insideFencedCodeByScan(state.doc, 4)).toBe(false);
  });

  it("未闭合围栏到文档末尾都在内", () => {
    expect(insideFencedCodeByScan(state.doc, 7)).toBe(true);
  });

  it("与树路径的已知差异只在围栏行自身(树算,扫描不算)", () => {
    expect(insideFencedCode(state, lineLen(1))).toBe(true); // tree: FencedCode includes the marker line
    expect(insideFencedCodeByScan(state.doc, 1)).toBe(false); // scan: does not
  });
});
