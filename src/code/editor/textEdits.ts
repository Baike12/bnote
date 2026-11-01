import type { LspPosition, LspRange } from "../types";

/**
 * 把一组 LSP TextEdit 应用到一段文本上。
 *
 * LSP 的编辑是**按位置**给的:同一文件里多处修改要**从后往前**应用——
 * 否则前面那处的偏移会因为前面的改动而失效,改出来的内容就错位了。
 *
 * 位置按 UTF-16 码元计(与 LSP、与 CodeMirror 一致),所以列号直接当
 * 字符串下标用。
 */
export function applyTextEdits(text: string, edits: unknown): string {
  if (!Array.isArray(edits)) return text;
  const lines = text.split("\n");
  const offsetOf = (position: LspPosition): number => {
    const line = lines[position.line] ?? "";
    const head = lines
      .slice(0, Math.max(0, position.line))
      .reduce((sum, l) => sum + l.length + 1, 0);
    return head + Math.min(Math.max(0, position.character), line.length);
  };
  const items = edits
    .map((edit) => {
      const e = edit as { range?: LspRange; newText?: string };
      if (!e?.range) return null;
      return {
        from: offsetOf(e.range.start),
        to: offsetOf(e.range.end),
        newText: e.newText ?? "",
      };
    })
    .filter((e): e is { from: number; to: number; newText: string } => e !== null)
    .sort((a, b) => b.from - a.from); // 从后往前
  let out = text;
  for (const edit of items) {
    out = out.slice(0, edit.from) + edit.newText + out.slice(edit.to);
  }
  return out;
}
