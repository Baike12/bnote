import type { Text } from "@codemirror/state";
import type { LspPosition, LspRange } from "../types";

/**
 * CodeMirror 位置 ↔ LSP 位置的换算。
 *
 * 两边都用 **UTF-16 码元** 计数字符:LSP 规范要求如此,CodeMirror 的文档
 * 偏移也是 JS 字符串下标(UTF-16)。所以列号直接相减就是对的,不需要
 * 按码点重算——按码点算反而会在 emoji 与代理对上错位。
 *
 * 行号:CodeMirror 从 1 开始,LSP 从 0 开始。
 */

/** 文档偏移 → LSP 位置。 */
export function cmToLspPosition(doc: Text, offset: number): LspPosition {
  const pos = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
}

/** LSP 位置 → 文档偏移(越界夹到文档内)。 */
export function lspToCmOffset(doc: Text, position: LspPosition): number {
  const lineNumber = position.line + 1;
  if (lineNumber < 1) return 0;
  if (lineNumber > doc.lines) return doc.length;
  const line = doc.line(lineNumber);
  return Math.min(line.from + Math.max(0, position.character), line.to);
}

/** LSP 区间 → CodeMirror 的 {from, to}。 */
export function lspRangeToCm(doc: Text, range: LspRange): { from: number; to: number } {
  const from = lspToCmOffset(doc, range.start);
  const to = lspToCmOffset(doc, range.end);
  return { from: Math.min(from, to), to: Math.max(from, to) };
}
