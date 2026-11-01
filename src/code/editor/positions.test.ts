import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { cmToLspPosition, lspRangeToCm, lspToCmOffset } from "./positions";
import { decodeFileUri, encodeFileUri, encodeUriPath } from "./uri";

/**
 * The gate of the position and URI conversion.
 *
 * Both sides count characters in UTF-16 code units (the LSP specification
 * says so, and a CodeMirror offset is a JS string index as well). So the
 * column numbers can be subtracted directly — counting by code point would
 * misalign on emoji and surrogate pairs.
 */

const DOC = Text.of(["fn main() {", "    println!(\"你好\");", "}"]);

describe("位置换算", () => {
  it("文档偏移 → LSP 位置(行 0-based)", () => {
    expect(cmToLspPosition(DOC, 0)).toEqual({ line: 0, character: 0 });
    expect(cmToLspPosition(DOC, 12)).toEqual({ line: 1, character: 0 });
  });

  it("LSP 位置 → 文档偏移(行 1-based)", () => {
    expect(lspToCmOffset(DOC, { line: 0, character: 0 })).toBe(0);
    expect(lspToCmOffset(DOC, { line: 1, character: 4 })).toBe(16);
  });

  it("来回换算自洽", () => {
    for (const offset of [0, 5, 12, 20, DOC.length]) {
      const lsp = cmToLspPosition(DOC, offset);
      expect(lspToCmOffset(DOC, lsp)).toBe(offset);
    }
  });

  it("越界夹回文档内", () => {
    expect(lspToCmOffset(DOC, { line: 99, character: 0 })).toBe(DOC.length);
    expect(lspToCmOffset(DOC, { line: -1, character: 0 })).toBe(0);
    expect(cmToLspPosition(DOC, DOC.length + 100).line).toBe(2);
  });

  it("区间换算出 from/to", () => {
    const { from, to } = lspRangeToCm(DOC, {
      start: { line: 0, character: 3 },
      end: { line: 0, character: 7 },
    });
    expect(to - from).toBe(4);
  });

  it("非 ASCII 按 UTF-16 码元计数", () => {
    // The two CJK characters are 2 code units.
    const doc = Text.of(["你好"]);
    expect(cmToLspPosition(doc, 2)).toEqual({ line: 0, character: 2 });
    expect(lspToCmOffset(doc, { line: 0, character: 2 })).toBe(2);
  });
});

describe("file:// URI", () => {
  it("路径 → URI:空格与中文被编码", () => {
    const uri = encodeFileUri("/Users/张三/my code/a.rs");
    expect(uri.startsWith("file:///Users/%E5%BC%A0")).toBe(true);
    expect(uri).toContain("my%20code");
  });

  it("URI → 路径:能原样回来", () => {
    const p = "/Users/张三/my code/a.rs";
    expect(decodeFileUri(encodeFileUri(p))).toBe(p);
  });

  it("非 file:// 的 URI 返回 null", () => {
    expect(decodeFileUri("https://example.com/a.rs")).toBeNull();
    expect(decodeFileUri("file://host/a.rs")).toBeNull();
  });

  it("编码只保留 unreserved 与斜杠", () => {
    expect(encodeUriPath("/a-b_c.d~e/f")).toBe("/a-b_c.d~e/f");
    expect(encodeUriPath("/a b")).toBe("/a%20b");
  });
});
