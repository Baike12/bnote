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
  // 每行起点先算一次:一条编辑一次 slice+reduce 的话,大文件 × 多处编辑
  // 会退成 O(编辑数 × 行数)(重命名一个热门符号能到上千处)。
  const starts = new Array<number>(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = acc;
    acc += lines[i].length + 1;
  }
  const offsetOf = (position: LspPosition): number => {
    // 行号越界(服务器给了文档外的位置)= 文本末尾;列号越界 = 行尾。
    if (position.line >= lines.length) return text.length;
    const index = Math.max(0, position.line);
    return starts[index] + Math.min(Math.max(0, position.character), lines[index].length);
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
