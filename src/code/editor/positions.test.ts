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

describe("position conversion", () => {
  it("document offset → LSP position (0-based line)", () => {
    expect(cmToLspPosition(DOC, 0)).toEqual({ line: 0, character: 0 });
    expect(cmToLspPosition(DOC, 12)).toEqual({ line: 1, character: 0 });
  });

  it("LSP position → document offset (1-based line)", () => {
    expect(lspToCmOffset(DOC, { line: 0, character: 0 })).toBe(0);
    expect(lspToCmOffset(DOC, { line: 1, character: 4 })).toBe(16);
  });

  it("converting back and forth is consistent", () => {
    for (const offset of [0, 5, 12, 20, DOC.length]) {
      const lsp = cmToLspPosition(DOC, offset);
      expect(lspToCmOffset(DOC, lsp)).toBe(offset);
    }
  });

  it("an out-of-range position is clamped back into the document", () => {
    expect(lspToCmOffset(DOC, { line: 99, character: 0 })).toBe(DOC.length);
    expect(lspToCmOffset(DOC, { line: -1, character: 0 })).toBe(0);
    expect(cmToLspPosition(DOC, DOC.length + 100).line).toBe(2);
  });

  it("a range converts to from/to", () => {
    const { from, to } = lspRangeToCm(DOC, {
      start: { line: 0, character: 3 },
      end: { line: 0, character: 7 },
    });
    expect(to - from).toBe(4);
  });

  it("non-ASCII text is counted in UTF-16 code units", () => {
    // The two CJK characters are 2 code units.
    const doc = Text.of(["你好"]);
    expect(cmToLspPosition(doc, 2)).toEqual({ line: 0, character: 2 });
    expect(lspToCmOffset(doc, { line: 0, character: 2 })).toBe(2);
  });
});

describe("file:// URI", () => {
  it("path → URI: spaces and CJK are encoded", () => {
    const uri = encodeFileUri("/Users/张三/my code/a.rs");
    expect(uri.startsWith("file:///Users/%E5%BC%A0")).toBe(true);
    expect(uri).toContain("my%20code");
  });

  it("URI → path: the original path comes back unchanged", () => {
    const p = "/Users/张三/my code/a.rs";
    expect(decodeFileUri(encodeFileUri(p))).toBe(p);
  });

  it("a non-file:// URI returns null", () => {
    expect(decodeFileUri("https://example.com/a.rs")).toBeNull();
    expect(decodeFileUri("file://host/a.rs")).toBeNull();
  });

  it("encoding keeps only unreserved characters and slashes", () => {
    expect(encodeUriPath("/a-b_c.d~e/f")).toBe("/a-b_c.d~e/f");
    expect(encodeUriPath("/a b")).toBe("/a%20b");
  });
});
