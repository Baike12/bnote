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
  // The default budget is 100ms; on a loaded machine the parse still misses it
  // and `ensureSyntaxTree` returns null, so the test quietly exercised the scan
  // fallback instead of the tree path it is named for. This budget is larger
  // than any real parse of the documents used here.
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state;
}

const atLineEnd = (state: EditorState, lineNo: number) => state.doc.line(lineNo).to;
const atLineMid = (state: EditorState, lineNo: number, col: number) =>
  state.doc.line(lineNo).from + col;

describe("insideFencedCode: tree ready (syntax tree path)", () => {
  const state = parsedState(
    [
      "正文一段",
      "",
      "```python",
      "x = 1",
      "print(x)",
      "```",
      "",
      "~~~ts",
      "const a = 1;",
      "~~~",
      "",
    ].join("\n"),
  );

  it("fence content lines are inside, body lines are not", () => {
    expect(insideFencedCode(state, atLineMid(state, 1, 1))).toBe(false);
    expect(insideFencedCode(state, atLineEnd(state, 4))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 5))).toBe(true);
    expect(insideFencedCode(state, atLineMid(state, 7, 0))).toBe(false); // the blank line between the two blocks
  });

  it("the fence marker lines themselves count as inside the block (typing a language name on the ``` line is typing code)", () => {
    expect(insideFencedCode(state, atLineEnd(state, 3))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 6))).toBe(true);
  });

  it("tilde fences are recognized too; the language does not matter (it is a block, so it stays English)", () => {
    expect(insideFencedCode(state, atLineEnd(state, 9))).toBe(true);
    expect(insideFencedCode(state, atLineEnd(state, 10))).toBe(true);
  });

  it("an indented fence inside a list counts too (leading indentation does not change the tree membership)", () => {
    const indented = parsedState(["- 项目", "", "  ```python", "  x = 1", "  ```"].join("\n"));
    expect(insideFencedCode(indented, atLineEnd(indented, 4))).toBe(true);
    expect(insideFencedCode(indented, atLineEnd(indented, 1))).toBe(false);
  });
});

describe("insideFencedCode: the pure-function semantics of the line-scan fallback", () => {
  // In node the syntax tree is always parsed synchronously, so
  // insideFencedCode's fallback branch can only trigger at runtime; here we
  // pin the pure function the fallback uses directly (same scan model as
  // fenceStateScan).
  const doc = ["```python", "x = 1", "```", "正文", "", "```ts", "const b = 2;"].join("\n");
  const state = makeState(doc);
  const lineLen = (n: number) => state.doc.line(n).to;

  it("content lines are inside; the opening fence line is not (its closing line counts as inside by scan semantics), body lines are not", () => {
    expect(insideFencedCodeByScan(state.doc, 1)).toBe(false); // ```python opening line: the fence only opens once that line is processed
    expect(insideFencedCodeByScan(state.doc, 2)).toBe(true);
    expect(insideFencedCodeByScan(state.doc, 3)).toBe(true); // ``` closing line: the lines before it are still open
    expect(insideFencedCodeByScan(state.doc, 4)).toBe(false);
  });

  it("an unclosed fence stays inside up to the end of the document", () => {
    expect(insideFencedCodeByScan(state.doc, 7)).toBe(true);
  });

  it("the known difference from the tree path is only on the fence marker lines themselves (the tree counts them, the scan does not)", () => {
    expect(insideFencedCode(state, lineLen(1))).toBe(true); // tree: FencedCode includes the marker line
    expect(insideFencedCodeByScan(state.doc, 1)).toBe(false); // scan: does not
  });
});
