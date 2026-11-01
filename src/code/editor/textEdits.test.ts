import { describe, expect, it } from "vitest";
import { applyTextEdits } from "./textEdits";

/**
 * 重命名落盘的门禁。
 *
 * LSP 的 TextEdit 是按位置给的:同一文件里多处修改必须**从后往前**应用,
 * 否则前面那处的偏移会被前面的改动顶掉,改出来的内容错位。这条最容易
 * 出的是「两处都在改」的情况,所以门禁里必须有它。
 */
describe("applyTextEdits", () => {
  it("单处替换", () => {
    const text = "fn main() {\n    old();\n}\n";
    const out = applyTextEdits(text, [
      {
        range: {
          start: { line: 1, character: 4 },
          end: { line: 1, character: 7 },
        },
        newText: "new",
      },
    ]);
    expect(out).toBe("fn main() {\n    new();\n}\n");
  });

  it("多处替换从后往前应用,前面的偏移不受影响", () => {
    const text = "aaa\nbbb\nccc\n";
    const out = applyTextEdits(text, [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: "AAA",
      },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
        newText: "CCC",
      },
    ]);
    expect(out).toBe("AAA\nbbb\nCCC\n");
  });

  it("插入(空区间)", () => {
    const text = "ab\n";
    const out = applyTextEdits(text, [
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
        newText: "X",
      },
    ]);
    expect(out).toBe("aXb\n");
  });

  it("删除(新区间为空)", () => {
    const text = "abc\n";
    const out = applyTextEdits(text, [
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
        newText: "",
      },
    ]);
    expect(out).toBe("ac\n");
  });

  it("非法的编辑数组原样返回", () => {
    expect(applyTextEdits("abc", null)).toBe("abc");
    expect(applyTextEdits("abc", "nope")).toBe("abc");
  });

  it("越界位置夹回文本内,不抛", () => {
    const out = applyTextEdits("ab", [
      {
        range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } },
        newText: "X",
      },
    ]);
    expect(out).toBe("abX");
  });
});
