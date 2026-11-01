import type { Text } from "@codemirror/state";
import type { LspPosition, LspRange } from "../types";

/**
 * Conversion between CodeMirror positions and LSP positions.
 *
 * Both sides count characters in **UTF-16 code units**: the LSP specification
 * requires it, and a CodeMirror document offset is a JS string index (UTF-16)
 * as well. So the column numbers can be subtracted directly, with no
 * recomputation by code point — counting by code point would misalign on
 * emoji and surrogate pairs.
 *
 * Line numbers: CodeMirror starts at 1, LSP starts at 0.
 */

/** Document offset → LSP position. */
export function cmToLspPosition(doc: Text, offset: number): LspPosition {
  const pos = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
}

/** LSP position → document offset (out-of-range values are clamped into the document). */
export function lspToCmOffset(doc: Text, position: LspPosition): number {
  const lineNumber = position.line + 1;
  if (lineNumber < 1) return 0;
  if (lineNumber > doc.lines) return doc.length;
  const line = doc.line(lineNumber);
  return Math.min(line.from + Math.max(0, position.character), line.to);
}

/** LSP range → the CodeMirror {from, to}. */
export function lspRangeToCm(doc: Text, range: LspRange): { from: number; to: number } {
  const from = lspToCmOffset(doc, range.start);
  const to = lspToCmOffset(doc, range.end);
  return { from: Math.min(from, to), to: Math.max(from, to) };
}
