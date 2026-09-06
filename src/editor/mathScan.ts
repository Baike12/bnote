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
    if (content.includes("$$")) continue;
    out.push({ from, to, display: true, content });
  }
  // An unpaired trailing $$ opens a block that runs to the end of the
  // document (Obsidian renders it live while typing, before the closing $$).
  // Capped so a stray $$ can't hand KaTeX the rest of a huge file.
  if (marks.length % 2 === 1) {
    const from = marks[marks.length - 1];
    if (text.length - from <= 10_000) {
      out.push({ from, to: text.length, display: true, content: text.slice(from + 2) });
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
