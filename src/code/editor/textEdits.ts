import type { LspPosition, LspRange } from "../types";

/**
 * Apply a set of LSP TextEdits to a piece of text.
 *
 * LSP edits are given **by position**: several changes in the same file have
 * to be applied **from the back to the front** — otherwise the offsets of the
 * earlier ones go stale after the preceding change and the result is
 * misaligned.
 *
 * Positions are counted in UTF-16 code units (same as LSP and CodeMirror), so
 * the column number can be used as a string index directly.
 */
export function applyTextEdits(text: string, edits: unknown): string {
  if (!Array.isArray(edits)) return text;
  const lines = text.split("\n");
  // Compute the line starts once: one slice+reduce per edit would degrade to
  // O(edits × lines) on a large file with many edits (renaming a popular
  // symbol can reach a thousand occurrences).
  const starts = new Array<number>(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = acc;
    acc += lines[i].length + 1;
  }
  const offsetOf = (position: LspPosition): number => {
    // A line number outside the document (the server gave a position beyond
    // the document) = end of the text; a column number out of range = end of
    // the line.
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
    .sort((a, b) => b.from - a.from); // from the back to the front
  let out = text;
  for (const edit of items) {
    out = out.slice(0, edit.from) + edit.newText + out.slice(edit.to);
  }
  return out;
}
