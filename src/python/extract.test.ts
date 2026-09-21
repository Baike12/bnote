import { EditorState, type Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  extractPython,
  hasPythonFenceHint,
  lspPointToOffset,
  mapLspDiagnostics,
  type RawLspDiagnostic,
} from "./extract";

function docOf(text: string): Text {
  return EditorState.create({ doc: text }).doc;
}

describe("hasPythonFenceHint", () => {
  it("快速判负:没有围栏标记的文档不进解析", () => {
    expect(hasPythonFenceHint("# 标题\n\n正文,没有代码块\n")).toBe(false);
    expect(hasPythonFenceHint("```python\nx = 1\n```")).toBe(true);
    expect(hasPythonFenceHint("~~~python\nx = 1\n~~~")).toBe(true);
  });
});

describe("extractPython 基础提取", () => {
  it("提取单个 python 围栏,虚拟文件行对齐(非代码行置空)", () => {
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

  it("多块按序进入同一虚拟文件,ts 块被排除", () => {
    const doc = "```python\na = 1\n```\n中间文字\n```ts\nconst b = 2\n```\n```python\nc = a + 1\nprint(c)\n```";
    const eff = extractPython(doc);
    expect(eff.blocks.map((b) => b.text)).toEqual(["a = 1", "c = a + 1\nprint(c)"]);
    const vLines = eff.virtualText.split("\n");
    expect(vLines[1]).toBe("a = 1");
    expect(vLines[3]).toBe(""); // 中间文字
    expect(vLines[5]).toBe(""); // ts 内容
    expect(vLines[8]).toBe("c = a + 1");
  });

  it("py / python3 信息串也识别;其他语言不算", () => {
    expect(extractPython("```py\nx = 1\n```").blocks).toHaveLength(1);
    expect(extractPython("```python3\nx = 1\n```").blocks).toHaveLength(1);
    expect(extractPython("```ruby\nx = 1\n```").blocks).toHaveLength(0);
    expect(extractPython("```\nx = 1\n```").blocks).toHaveLength(0);
    expect(extractPython("```Python\nx = 1\n```").blocks).toHaveLength(1);
  });

  it("带参数的 info string 取首词(如 ```python title=demo)", () => {
    expect(extractPython("```python title=demo\nx = 1\n```").blocks).toHaveLength(1);
  });
});

describe("extractPython 围栏边界", () => {
  it("波浪号围栏", () => {
    const eff = extractPython("~~~python\nx = 1\n~~~\n");
    expect(eff.blocks[0].text).toBe("x = 1");
  });

  it("开栏缩进 ≤3 空格时内容剥掉等量缩进(列表里的围栏)", () => {
    const doc = "- 项\n\n  ```python\n  for i in range(2):\n      print(i)\n  ```\n";
    const eff = extractPython(doc);
    expect(eff.blocks[0].text).toBe("for i in range(2):\n    print(i)");
    expect(eff.virtualText.split("\n")[3]).toBe("for i in range(2):");
  });

  it("内容行缩进少于围栏缩进:剥到 0 为止,不产生负缩进", () => {
    const doc = "  ```python\n  a = 1\nb = 2\n  ```\n";
    const eff = extractPython(doc);
    expect(eff.blocks[0].text).toBe("a = 1\nb = 2");
  });

  it("围栏内出现更短的 ``` 是内容,不截断;更长围栏需要更长闭栏", () => {
    const doc = "````python\nx = \"```\nl = ```python```\n````\n";
    const eff = extractPython(doc);
    expect(eff.blocks[0].text).toBe('x = "```\nl = ```python```');
  });

  it("反引号围栏的 info string 带反引号时不是围栏", () => {
    expect(extractPython("```py`thon\nx = 1\n```").blocks).toHaveLength(0);
  });

  it("未闭合围栏到文档末尾(含末尾空行,行对齐优先)", () => {
    const doc = "# 标题\n```python\nx = 1\ny = 2\n";
    const eff = extractPython(doc);
    expect(eff.blocks[0].startLine).toBe(2);
    expect(eff.blocks[0].text).toBe("x = 1\ny = 2\n");
  });

  it("4 空格缩进的围栏不是顶层围栏(段落内缩进代码),不提取", () => {
    expect(extractPython("    ```python\n    x = 1\n    ```").blocks).toHaveLength(0);
  });
});

describe("main 守卫", () => {
  it("有模块级 def main 且无守卫:追加标准 __main__ 调用", () => {
    const eff = extractPython("```python\ndef main():\n    print('hi')\n```");
    expect(eff.hasMain).toBe(true);
    expect(eff.hasMainGuard).toBe(false);
    expect(eff.appendedLines).toBe(3);
    expect(eff.effectiveText.endsWith('if __name__ == "__main__":\n    main()')).toBe(true);
    // 追加不改变已有行的行号映射。
    expect(eff.effectiveText.split("\n")[1]).toBe("def main():");
  });

  it("已有 __name__ 守卫:尊重原文,不再追加", () => {
    const doc = '```python\ndef main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n```';
    const eff = extractPython(doc);
    expect(eff.hasMainGuard).toBe(true);
    expect(eff.appendedLines).toBe(0);
    expect(eff.effectiveText).toBe(eff.virtualText);
  });

  it("没有 main:原样运行(从头到尾)", () => {
    const eff = extractPython("```python\nprint('top')\n```");
    expect(eff.hasMain).toBe(false);
    expect(eff.appendedLines).toBe(0);
  });

  it("缩进的 def main(嵌套在类里)不触发追加", () => {
    const eff = extractPython("```python\nclass A:\n    def main(self):\n        pass\n```");
    expect(eff.hasMain).toBe(false);
    expect(eff.appendedLines).toBe(0);
  });
});

describe("LSP 行列映射(UTF-16 code unit 与 CM 偏移同单位)", () => {
  it("行号 0 基、列钳制到行内;行越界返回 -1", () => {
    const doc = docOf("ab\n中文cd\nx\n");
    expect(lspPointToOffset(doc, 0, 1)).toBe(1);
    expect(lspPointToOffset(doc, 1, 0)).toBe(3);
    // 超出行长钳到行尾(「中文cd」是 4 个 BMP 字符 = 4 个 UTF-16 单元)。
    expect(lspPointToOffset(doc, 1, 100)).toBe(3 + 4);
    expect(lspPointToOffset(doc, 99, 0)).toBe(-1);
  });

  it("代理对(emoji)按 UTF-16 计数,与 LSP 一致", () => {
    const doc = docOf("a🎉b\n");
    // 🎉 是 1 个码点 = 2 个 UTF-16 单元;a(1)+🎉(2)=3。
    expect(lspPointToOffset(doc, 0, 3)).toBe(3);
    expect(doc.sliceString(3, 4)).toBe("b");
  });

  it("mapLspDiagnostics 映射 range/severity/message,越界条目丢弃", () => {
    const doc = docOf("# 标题\n```python\nx: int = \"hello\"\n```\n");
    const raw: RawLspDiagnostic[] = [
      {
        range: { start: { line: 2, character: 9 }, end: { line: 2, character: 16 } },
        severity: 2,
        message: "Type \"str\" is not assignable to \"int\"",
        code: "invalid-assignment",
        source: "ty",
      },
      // 追加守卫区 / 越界行 → 丢
      { range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } }, message: "ghost" },
      // 缺 range → 丢
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

  it("code 为 LSP 3.17 对象形式({value})时也能取到", () => {
    const doc = docOf("x = 1\n");
    const mapped = mapLspDiagnostics(doc, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, code: { value: "E1" }, message: "m" },
    ]);
    expect(mapped[0].code).toBe("E1");
  });

  it("end 在 start 之前时交换,保证 from ≤ to", () => {
    const doc = docOf("abcdef\n");
    const mapped = mapLspDiagnostics(doc, [
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 1 } }, message: "m" },
    ]);
    expect(mapped[0].from).toBe(1);
    expect(mapped[0].to).toBe(4);
  });
});

describe("性能护栏", () => {
  it("大文档提取是线性开销(10k 行 < 50ms,防意外 O(n²))", () => {
    const chunk = "文字段落,some prose。\n```python\nx1 = 1\n```\n```ts\nconst a = 1\n```\n";
    const doc = chunk.repeat(1250); // ~10k 行
    const t0 = performance.now();
    const eff = extractPython(doc);
    const ms = performance.now() - t0;
    expect(eff.blocks.length).toBe(1250);
    expect(ms).toBeLessThan(50);
  });
});
