import type { Text } from "@codemirror/state";

export interface MathRegion {
  from: number;
  to: number;
  display: boolean;
  content: string;
}

/**
 * Scans the document for `$$…$$` (block) and `$…$` (inline) math regions.
 * Mirrors Obsidian's heuristics: `\$` is an escape, inline content may not
 * start/end with whitespace or contain a newline, and a closing `$` may not
 * be followed by a digit (so "$5 and $10" stays plain text).
 */
export function scanMath(doc: Text): MathRegion[] {
  const out: MathRegion[] = [];
  const text = doc.toString();
  if (text.length > 2_000_000) return out;

  // 空行（只含空白的行）。LaTeX 数学不容许空行——跨空行的 $$ "配对" 只能是
  // 某个 $$ 被删掉/写错后的错位配对。若按公式渲染，删一个 $$ 配对就整体移位、
  // 下一段正文被吞进公式，用户怎么删都"删不掉"。按普通文本渲染，每个 $$
  // 始终可见可删。
  const BLANK_LINE = /\n[ \t]*\n/;

  // --- Block math: pair up unescaped $$ occurrences. ---
  const marks: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text.charCodeAt(i) === 36 /* $ */ && text.charCodeAt(i + 1) === 36) {
      if (i > 0 && text.charCodeAt(i - 1) === 92 /* \ */) continue;
      marks.push(i);
      i++; // consume both dollars
    }
  }
  for (let i = 0; i + 1 < marks.length; i += 2) {
    const from = marks[i];
    const to = marks[i + 1] + 2;
    const content = text.slice(from + 2, to - 2);
    // Ignore blocks that contain another $$ — pairing artifact.
    if (content.includes("$$") || BLANK_LINE.test(content)) continue;
    out.push({ from, to, display: true, content });
  }
  // An unpaired trailing $$ opens a block that renders live while typing,
  // before the closing $$ exists. Capped at the end of the current PARAGRAPH:
  // Obsidian-style live editing happens within one paragraph, and without the
  // cap a stray $$ swallows every paragraph below it into one giant formula.
  if (marks.length % 2 === 1) {
    const from = marks[marks.length - 1];
    if (text.length - from <= 10_000) {
      const rest = text.slice(from + 2);
      const blank = BLANK_LINE.exec(rest);
      // 区域止于段落最后一个字符(不含末尾换行)——区域跨行与否由换行决定,
      // 把换行算进来会让单行区域越过了行尾,行内替换装饰会跨行抛错。
      const paraEnd = blank ? blank.index : rest.length;
      out.push({
        from,
        to: from + 2 + paraEnd,
        display: true,
        content: rest.slice(0, paraEnd),
      });
    }
  }

  // --- Inline math, per line, outside block regions. ---
  const inlineRe = /(?<![\\$])\$(?!\s)((?:[^$\n\\]|\\.)*?)(?<!\s)\$(?!\d)/g;
  const lines = doc.iterLines();
  let pos = 0;
  for (let res = lines.next(); !res.done; res = lines.next()) {
    const lineText = res.value as string;
    const lineEnd = pos + lineText.length;
    if (lineText.includes("$") && !inRanges(pos, lineEnd, out)) {
      inlineRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = inlineRe.exec(lineText))) {
        const from = pos + m.index;
        const to = from + m[0].length;
        if (!inRanges(from, to, out) && m[1].length > 0) {
          out.push({ from, to, display: false, content: m[1] });
        }
      }
    }
    pos = lineEnd + 1; // +1 for the newline
    if (pos > doc.length) break;
  }

  out.sort((a, b) => a.from - b.from);
  return out;
}

function inRanges(from: number, to: number, ranges: MathRegion[]): boolean {
  for (const r of ranges) {
    if (from < r.to && to > r.from) return true;
  }
  return false;
}
