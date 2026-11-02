import { EditorState, type Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  extractPython,
  hasPythonFenceHint,
  lspHoverText,
  lspPointToOffset,
  mapLspCompletions,
  mapLspDiagnostics,
  mdPosToLspPosition,
  type RawLspDiagnostic,
} from "./extract";

function docOf(text: string): Text {
  return EditorState.create({ doc: text }).doc;
}

describe("hasPythonFenceHint", () => {
  it("fast negative: a document without a fence marker is not parsed", () => {
    expect(hasPythonFenceHint("# 标题\n\n正文,没有代码块\n")).toBe(false);
    expect(hasPythonFenceHint("```python\nx = 1\n```")).toBe(true);
    expect(hasPythonFenceHint("~~~python\nx = 1\n~~~")).toBe(true);
  });
});

describe("extractPython basic extraction", () => {
  it("extracts a single python fence with the virtual file lines aligned (non-code lines are blank)", () => {
    const doc = "# 标题\n\n```python\nx = 1\nprint(x)\n```\n\n正文\n";
    const eff = extractPython(doc);
    expect(eff.blocks).toHaveLength(1);
    expect(eff.blocks[0].startLine).toBe(3);
    expect(eff.blocks[0].endLine).toBe(4);
    expect(eff.blocks[0].text).toBe("x = 1\nprint(x)");
    const vLines = eff.virtualText.split("\n");
    expect(vLines).toHaveLength(doc.split("\n").length);
    expect(vLines[3]).toBe("x = 1");
    expect(vLines[4]).toBe("print(x)");
    expect(vLines[0]).toBe("");
    expect(vLines[6]).toBe("");
    expect(eff.appendedLines).toBe(0);
  });

  it("multiple blocks enter the same virtual file in order, ts blocks are excluded", () => {
    const doc = "```python\na = 1\n```\n中间文字\n```ts\nconst b = 2\n```\n```python\nc = a + 1\nprint(c)\n```";
    const eff = extractPython(doc);
    expect(eff.blocks.map((b) => b.text)).toEqual(["a = 1", "c = a + 1\nprint(c)"]);
    const vLines = eff.virtualText.split("\n");
    expect(vLines[1]).toBe("a = 1");
    expect(vLines[3]).toBe(""); // the prose in between
    expect(vLines[5]).toBe(""); // the ts block
    expect(vLines[8]).toBe("c = a + 1");
  });

  it("py and python3 info strings are recognized too; other languages do not count", () => {
    expect(extractPython("```py\nx = 1\n```").blocks).toHaveLength(1);
    expect(extractPython("```python3\nx = 1\n```").blocks).toHaveLength(1);
    expect(extractPython("```ruby\nx = 1\n```").blocks).toHaveLength(0);
    expect(extractPython("```\nx = 1\n```").blocks).toHaveLength(0);
    expect(extractPython("```Python\nx = 1\n```").blocks).toHaveLength(1);
  });

  it("an info string with parameters takes the first word (like ```python title=demo)", () => {
    expect(extractPython("```python title=demo\nx = 1\n```").blocks).toHaveLength(1);
  });
});

describe("extractPython fence boundaries", () => {
  it("tilde fences", () => {
    const eff = extractPython("~~~python\nx = 1\n~~~\n");
    expect(eff.blocks[0].text).toBe("x = 1");
  });

  it("with an opening fence indented by ≤3 spaces the content loses the same indentation (a fence inside a list)", () => {
    const doc = "- 项\n\n  ```python\n  for i in range(2):\n      print(i)\n  ```\n";
    const eff = extractPython(doc);
    expect(eff.blocks[0].text).toBe("for i in range(2):\n    print(i)");
    expect(eff.virtualText.split("\n")[3]).toBe("for i in range(2):");
  });

  it("content lines indented less than the fence: stripped down to 0, never a negative indentation", () => {
    const doc = "  ```python\n  a = 1\nb = 2\n  ```\n";
    const eff = extractPython(doc);
    expect(eff.blocks[0].text).toBe("a = 1\nb = 2");
  });

  it("a shorter ``` inside the fence is content and does not truncate; a longer fence needs a longer closing fence", () => {
    const doc = "````python\nx = \"```\nl = ```python```\n````\n";
    const eff = extractPython(doc);
    expect(eff.blocks[0].text).toBe('x = "```\nl = ```python```');
  });

  it("a backtick fence whose info string contains a backtick is not a fence", () => {
    expect(extractPython("```py`thon\nx = 1\n```").blocks).toHaveLength(0);
  });

  it("an unclosed fence runs to the end of the document (including the trailing blank line, line alignment wins)", () => {
    const doc = "# 标题\n```python\nx = 1\ny = 2\n";
    const eff = extractPython(doc);
    expect(eff.blocks[0].startLine).toBe(2);
    expect(eff.blocks[0].text).toBe("x = 1\ny = 2\n");
  });

  it("a fence indented by 4 spaces is not a top-level fence (indented code inside a paragraph) and is not extracted", () => {
    expect(extractPython("    ```python\n    x = 1\n    ```").blocks).toHaveLength(0);
  });
});

describe("main guard", () => {
  it("a module-level def main without a guard: the standard __main__ call is appended", () => {
    const eff = extractPython("```python\ndef main():\n    print('hi')\n```");
    expect(eff.hasMain).toBe(true);
    expect(eff.hasMainGuard).toBe(false);
    expect(eff.appendedLines).toBe(3);
    expect(eff.effectiveText.endsWith('if __name__ == "__main__":\n    main()')).toBe(true);
    // Appending does not change the line mapping of the existing lines.
    expect(eff.effectiveText.split("\n")[1]).toBe("def main():");
  });

  it("an existing __name__ guard: the original text is respected and nothing is appended", () => {
    const doc = '```python\ndef main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n```';
    const eff = extractPython(doc);
    expect(eff.hasMainGuard).toBe(true);
    expect(eff.appendedLines).toBe(0);
    expect(eff.effectiveText).toBe(eff.virtualText);
  });

  it("no main: it runs as is (from start to end)", () => {
    const eff = extractPython("```python\nprint('top')\n```");
    expect(eff.hasMain).toBe(false);
    expect(eff.appendedLines).toBe(0);
  });

  it("an indented def main (nested in a class) does not trigger the append", () => {
    const eff = extractPython("```python\nclass A:\n    def main(self):\n        pass\n```");
    expect(eff.hasMain).toBe(false);
    expect(eff.appendedLines).toBe(0);
  });
});

describe("LSP line/column mapping (UTF-16 code units are the same unit as CM offsets)", () => {
  it("line numbers are 0-based, columns are clamped to the line; an out-of-range line returns -1", () => {
    const doc = docOf("ab\n中文cd\nx\n");
    expect(lspPointToOffset(doc, 0, 1)).toBe(1);
    expect(lspPointToOffset(doc, 1, 0)).toBe(3);
    // A column past the end of the line is clamped to the line end (the CJK line is 4 BMP characters = 4 UTF-16 units).
    expect(lspPointToOffset(doc, 1, 100)).toBe(3 + 4);
    expect(lspPointToOffset(doc, 99, 0)).toBe(-1);
  });

  it("surrogate pairs (emoji) count as UTF-16, consistent with LSP", () => {
    const doc = docOf("a🎉b\n");
    // The emoji is 1 code point = 2 UTF-16 units; a(1)+emoji(2)=3.
    expect(lspPointToOffset(doc, 0, 3)).toBe(3);
    expect(doc.sliceString(3, 4)).toBe("b");
  });

  it("mapLspDiagnostics maps range/severity/message and drops out-of-range entries", () => {
    const doc = docOf("# 标题\n```python\nx: int = \"hello\"\n```\n");
    const raw: RawLspDiagnostic[] = [
      {
        range: { start: { line: 2, character: 9 }, end: { line: 2, character: 16 } },
        severity: 2,
        message: "Type \"str\" is not assignable to \"int\"",
        code: "invalid-assignment",
        source: "ty",
      },
      // The appended guard region / an out-of-range line -> dropped
      { range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } }, message: "ghost" },
      // Missing range -> dropped
      { range: undefined as never, message: "broken" },
    ];
    const mapped = mapLspDiagnostics(doc, raw);
    expect(mapped).toHaveLength(1);
    const line = doc.line(3);
    expect(mapped[0].from).toBe(line.from + 9);
    expect(mapped[0].to).toBe(line.from + 16);
    expect(mapped[0].severity).toBe("warning");
    expect(mapped[0].source).toBe("ty");
    expect(mapped[0].code).toBe("invalid-assignment");
  });

  it("a code in the LSP 3.17 object form ({value}) is also read", () => {
    const doc = docOf("x = 1\n");
    const mapped = mapLspDiagnostics(doc, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, code: { value: "E1" }, message: "m" },
    ]);
    expect(mapped[0].code).toBe("E1");
  });

  it("end before start is swapped so that from ≤ to holds", () => {
    const doc = docOf("abcdef\n");
    const mapped = mapLspDiagnostics(doc, [
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 1 } }, message: "m" },
    ]);
    expect(mapped[0].from).toBe(1);
    expect(mapped[0].to).toBe(4);
  });
});

describe("performance guard", () => {
  it("extraction of a large document is linear (10k lines < 50ms, guards against accidental O(n²))", () => {
    const chunk = "文字段落,some prose。\n```python\nx1 = 1\n```\n```ts\nconst a = 1\n```\n";
    const doc = chunk.repeat(1250); // ~10k lines
    const t0 = performance.now();
    const eff = extractPython(doc);
    const ms = performance.now() - t0;
    expect(eff.blocks.length).toBe(1250);
    expect(ms).toBeLessThan(50);
  });
});

describe("mapLspCompletions", () => {
  it("both a CompletionList (items wrapped in one layer) and a bare array are readable", () => {
    const list = { isIncomplete: false, items: [{ label: "print" }] };
    expect(mapLspCompletions(list).map((c) => c.label)).toEqual(["print"]);
    expect(mapLspCompletions([{ label: "input" }]).map((c) => c.label)).toEqual(["input"]);
  });

  it("the numeric kind maps to a CM type; insertText wins over label", () => {
    const items = [
      { label: "hello", kind: 3, insertText: "hello($1)", detail: "def hello()" },
      { label: "HttpError", kind: 7 },
      { label: "PI", kind: 21 },
      { label: "unknown kind", kind: 99 },
    ];
    const out = mapLspCompletions(items);
    expect(out[0].type).toBe("function");
    expect(out[0].apply).toBe("hello($1)");
    expect(out[0].detail).toBe("def hello()");
    expect(out[1].type).toBe("class");
    expect(out[2].type).toBe("constant");
    expect(out[3].type).toBeUndefined();
  });

  it("the snippet format does not parse placeholders and falls back to label", () => {
    const out = mapLspCompletions([{ label: "with_open", insertText: "with open($1) as $2:", insertTextFormat: 2 }]);
    expect(out[0].apply).toBeUndefined();
  });

  it("documentation supports MarkupContent and strips the markdown fence lines", () => {
    const out = mapLspCompletions([
      {
        label: "print",
        documentation: { kind: "markdown", value: "```python\nprint(*values)\n```\n输出到 stdout。" },
      },
    ]);
    expect(out[0].info).toBe("print(*values)\n输出到 stdout。");
  });

  it("malformed entries are dropped and a non-list input returns empty", () => {
    expect(mapLspCompletions([{ label: "" }, null, { noLabel: true }, { label: "ok" }]).map((c) => c.label)).toEqual(["ok"]);
    expect(mapLspCompletions(null)).toEqual([]);
    expect(mapLspCompletions("nope")).toEqual([]);
    expect(mapLspCompletions({ items: "not-array" })).toEqual([]);
  });
});

describe("lspHoverText", () => {
  it("MarkupContent loses its fence; a plain string stays as is; an array is joined in order", () => {
    expect(
      lspHoverText({ contents: { kind: "markdown", value: "```python\ndef f(x: int)\n```" } }),
    ).toBe("def f(x: int)");
    expect(lspHoverText({ contents: "int" })).toBe("int");
    expect(lspHoverText({ contents: ["def f(x: int)", "说明文字"] })).toBe("def f(x: int)\n\n说明文字");
  });

  it("no content or malformed input returns null", () => {
    expect(lspHoverText(null)).toBeNull();
    expect(lspHoverText({ contents: null })).toBeNull();
    expect(lspHoverText({ contents: { kind: "markdown", value: "```python\n```" } })).toBeNull();
    expect(lspHoverText("string")).toBeNull();
  });
});

describe("mdPosToLspPosition (cursor → virtual file position)", () => {
  it("a flush-left fence: the line and column are read directly", () => {
    const doc = docOf("```python\nx = 1\nprint(x)\n```");
    const eff = extractPython(doc.toString());
    // The caret is at the end of "x = 1" (offset 10 + 5 = column 5 in the line).
    expect(mdPosToLspPosition(doc, 10 + 5, eff)).toEqual({ line: 1, character: 5 });
    expect(mdPosToLspPosition(doc, 10 + 2, eff)).toEqual({ line: 1, character: 2 });
  });

  it("an indented fence inside a list: the common indentation is stripped and the caret inside the stripped prefix sticks to column 0", () => {
    const doc = docOf("- item\n\n  ```python\n  for i in r\n  ```\n");
    const eff = extractPython(doc.toString());
    // The opening fence is indented by 2, so the content line "  for i in r" becomes the virtual line "for i in r".
    const line = doc.line(4); // "  for i in r"
    expect(line.text).toBe("  for i in r");
    const cursorAfterIn = line.from + 9; // after "for i in", the virtual column = 9 - 2
    expect(mdPosToLspPosition(doc, cursorAfterIn, eff)).toEqual({ line: 3, character: 7 });
    // The caret sits inside the 2 stripped indent columns -> it sticks to column 0.
    expect(mdPosToLspPosition(doc, line.from + 1, eff)).toEqual({ line: 3, character: 0 });
  });

  it("a fence marker line or a prose line returns null (the gate for completion and hover)", () => {
    const doc = docOf("# 标题\n\n```python\nx = 1\n```\n\n正文\n");
    const eff = extractPython(doc.toString());
    expect(mdPosToLspPosition(doc, 0, eff)).toBeNull(); // the heading line
    expect(mdPosToLspPosition(doc, doc.line(3).to, eff)).toBeNull(); // the ``` opening fence line
    expect(mdPosToLspPosition(doc, doc.line(5).to, eff)).toBeNull(); // the ``` closing fence line
    expect(mdPosToLspPosition(doc, doc.line(6).to, eff)).toBeNull(); // the blank line after the closing fence
  });

  it("an out-of-range offset is clamped to the document length (with an unclosed fence every line up to the end is a code line)", () => {
    const doc = docOf("```python\nx = 1");
    const eff = extractPython(doc.toString());
    expect(mdPosToLspPosition(doc, doc.length + 999, eff)).toEqual({ line: 1, character: 5 });
  });
});
