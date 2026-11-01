import { describe, expect, it } from "vitest";
import { applyTextEdits } from "./textEdits";

/**
 * Gate for renames written back to disk.
 *
 * LSP TextEdits are given by position: several edits in the same file must be
 * applied **from back to front**, otherwise an earlier edit shifts the offsets
 * of the later ones and the written content ends up misaligned. The case that
 * breaks most easily is "two places change at once", so the gate has to cover
 * it.
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
