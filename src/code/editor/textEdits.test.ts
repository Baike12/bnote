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
  it("a single replacement", () => {
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

  it("multiple replacements are applied back to front, so the earlier offsets stay valid", () => {
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

  it("insertion (empty range)", () => {
    const text = "ab\n";
    const out = applyTextEdits(text, [
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
        newText: "X",
      },
    ]);
    expect(out).toBe("aXb\n");
  });

  it("deletion (empty new text)", () => {
    const text = "abc\n";
    const out = applyTextEdits(text, [
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
        newText: "",
      },
    ]);
    expect(out).toBe("ac\n");
  });

  it("an invalid edit array is returned unchanged", () => {
    expect(applyTextEdits("abc", null)).toBe("abc");
    expect(applyTextEdits("abc", "nope")).toBe("abc");
  });

  it("an out-of-range position is clamped into the text instead of throwing", () => {
    const out = applyTextEdits("ab", [
      {
        range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } },
        newText: "X",
      },
    ]);
    expect(out).toBe("abX");
  });
});
