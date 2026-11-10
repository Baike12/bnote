import type { Text } from "@codemirror/state";
import { perfEnd, perfFields, perfStart } from "@/perf/trace";

export interface MathRegion {
  from: number;
  to: number;
  display: boolean;
  content: string;
  /** Only the opening marker is present and no closing marker has arrived yet
   *  (a formula being typed). For such a region `to` is the end of the
   *  paragraph rather than after a closing delimiter — with the caret at `to`
   *  the typed character still goes into the math body. */
  unclosed?: true;
}

/**
 * Scans the document for `$$…$$` (block) and `$…$` (inline) math regions.
 * Mirrors Obsidian's heuristics: `\$` is an escape, inline content may not
 * start/end with whitespace or contain a newline, and a closing `$` may not
 * be followed by a digit (so "$5 and $10" stays plain text).
 *
 * The block-level pairing model (from first principles):
 * - A pairing never crosses an "interior blank line" — LaTeX math cannot hold
 *   a blank line. But a typing flow produces **one-sided** blank lines (two
 *   Enters after `$$` and then the formula, or a blank line added before
 *   closing); such blocks must still render. Only when **both** sides are
 *   blank (a body paragraph sandwiched between two stray $$, i.e. the
 *   misaligned product of deleting the wrong $$) is the pairing refused.
 * - **Exception: a blank line inside a properly paired `\begin{…}…\end{…}` is
 *   not a paragraph boundary.** A blank line in a multi-line environment is
 *   typographic whitespace (expanding the `#@` snippet into
 *   `$$\n\begin{align}\n$0\n\end{align}\n$$` and pressing Enter at `$0`
 *   produces exactly that), and the whole block still renders; a blank line
 *   after an *unclosed* `\begin` gets no exemption, otherwise "typed a
 *   \begin, no \end yet, then a blank line" would reopen the hole that
 *   swallows body text.
 * - Pairing advances like a stack: when a pair is refused, neither marker
 *   produces a region (both stay visible and deletable) and the closing
 *   candidate keeps looking further back — after deleting one $$, the intact
 *   formulas below still pair and render as before instead of shifting as a
 *   whole (the "formula monster chasing along").
 * - With an odd number of markers, the final stray $$ is the "still being
 *   typed, not closed" shape and gets a live region capped at the current
 *   paragraph (the first blank line); every other stray stays plain text —
 *   body text inside a misaligned product is never swallowed into any
 *   region, and every $$ stays visible and deletable.
 */
const MATH_SCAN_FIELDS = perfFields("bytes", "lines", "regions");

export function scanMath(doc: Text): MathRegion[] {
  const t = perfStart();
  const out = scanMathUnmeasured(doc);
  perfEnd(t, "math.scan", MATH_SCAN_FIELDS, doc.length, doc.lines, out.length);
  return out;
}

/** The scan itself; the public wrapper owns the perf span so every caller
 *  (decorations, IME, snippets, tests) is measured without touching the
 *  algorithm. */
function scanMathUnmeasured(doc: Text): MathRegion[] {
  const out: MathRegion[] = [];
  const text = doc.toString();
  if (text.length > 2_000_000) return out;

  // --- Block math: stack-pair up unescaped $$ occurrences. ---
  const marks: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text.charCodeAt(i) === 36 /* $ */ && text.charCodeAt(i + 1) === 36) {
      if (i > 0 && text.charCodeAt(i - 1) === 92 /* \ */) continue;
      marks.push(i);
      i++; // consume both dollars
    }
  }

  // Whether the line [start,end) contains only whitespace.
  const lineIsBlank = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      const ch = text.charCodeAt(i);
      if (ch !== 32 /* space */ && ch !== 9 /* tab */) return false;
    }
    return true;
  };

  // `\begin{name}` / `\end{name}`: the environment name does not span lines
  // (a newline after `\begin{` does not open an environment).
  const ENV_TOKEN = /\\(begin|end)\s*\{([^}\n]*)\}/g;

  /** Is there an `\end` for that environment between [from,to)? Without one the environment is not closed. */
  const hasClosingEnd = (from: number, to: number, envName: string): boolean => {
    ENV_TOKEN.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = ENV_TOKEN.exec(text)) !== null && m.index < to) {
      if (m[1] === "end" && m[2] === envName) return true;
    }
    return false;
  };

  /** Reflects the `\begin`/`\end` of the line [from,to) onto the environment stack (only the nearest same-named environment is popped). */
  const scanEnvTokens = (from: number, to: number, stack: string[]): void => {
    if (text.indexOf("\\", from) < 0 || text.indexOf("\\", from) >= to) return;
    ENV_TOKEN.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = ENV_TOKEN.exec(text)) !== null && m.index < to) {
      if (m[1] === "begin") stack.push(m[2]);
      else if (stack[stack.length - 1] === m[2]) stack.pop();
    }
  };

  /** Can the content between the opening and closing markers form a math
   *  block? A single-line pair (`$$x$$`) is valid by nature; for multi-line
   *  pairs the interior lines are counted: after peeling off the leading run
   *  of blank lines (lead) and the trailing run (trail), there must be no
   *  blank line in the middle, and both sides must not be blank at once (that
   *  is a misaligned product with body text sandwiched in);
   *  a blank line inside a properly paired environment does not count as a
   *  blank line (see the file header). */
  const pairValid = (open: number, close: number): boolean => {
    const openNl = text.indexOf("\n", open);
    if (openNl === -1 || openNl + 1 > close) return true; // same-line pair
    let lead = 0;
    let trail = 0;
    let pendingTrail = 0;
    let sawContent = false;
    let interiorBlank = false;
    const envStack: string[] = [];
    let pos = openNl + 1;
    while (pos < close) {
      let nl = text.indexOf("\n", pos);
      if (nl === -1 || nl >= close) nl = close; // the line-start fragment of the closing marker's line
      const blank = lineIsBlank(pos, nl);
      // Is the blank line "whitespace inside an environment": the environment
      // on top of the stack still has its matching \end inside this block.
      const envTop = envStack[envStack.length - 1];
      const envBlank = blank && envTop !== undefined && hasClosingEnd(nl, close, envTop);
      if (blank && !envBlank) {
        if (!sawContent) lead++;
        else pendingTrail++;
      } else {
        if (pendingTrail > 0) interiorBlank = true;
        sawContent = true;
        trail = pendingTrail;
        pendingTrail = 0;
      }
      if (!blank) scanEnvTokens(pos, nl, envStack);
      pos = nl + 1;
    }
    trail += pendingTrail;
    if (lead > 0 && trail > 0) return false;
    return !interiorBlank;
  };

  let open = -1;
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    if (open === -1) {
      open = m;
      continue;
    }
    if (pairValid(open, m)) {
      out.push({ from: open, to: m + 2, display: true, content: text.slice(open + 2, m) });
      open = -1;
    } else {
      // Misaligned pair: neither marker produces a region (both stay visible
      // and deletable) and the current marker becomes the new opening
      // candidate — the intact formulas below therefore still pair as before
      // (the formula monster no longer shifts as a whole).
      open = m;
    }
  }
  // With an odd number of markers the final stray $$ is the "still being
  // typed, not closed" shape and gets a live region (capped at the current
  // paragraph); with an even number of markers a stray remains, which means it
  // is the closing marker squeezed out of a misaligned product and what
  // follows it is unrelated body text — it stays plain text and is never
  // swallowed into any region.
  //
  // A stray $$ **after body text on its line** is not a block opener: the
  // inline-math snippets (ma / ##@) produce exactly `$|$` (two adjacent
  // dollars) in the middle of a line, and treating them as a display block
  // turned the rest of the paragraph into math source (the IME kept English,
  // Tab could not leave). Such a pair belongs to the inline layer below,
  // which recognizes the empty body; a `$$` at the start of a line still
  // opens a block that is being typed (dm / manual).
  if (open !== -1 && marks.length % 2 === 1) {
    const lineStart = text.lastIndexOf("\n", open - 1) + 1;
    if (text.slice(lineStart, open).trim() === "") pushStrayRegion(out, text, open);
  }

  // --- Inline math, per line, outside block regions. ---
  // The closing `$` may be preceded by whitespace: while a formula is being
  // typed (`$s ` + the closing `$`) that trailing space is the normal state,
  // and treating the line as plain text drops the region mid-keystroke — the
  // IME switches back to Chinese (so the next space is eaten by the IME
  // instead of reaching the document) and every inline-math-only snippet stops
  // matching. The opening `$` still may not be followed by whitespace, and a
  // closing `$` still may not be followed by a digit, which is what keeps
  // "$5 and $10" from turning into a formula.
  const inlineRe = /(?<![\\$])\$(?!\s)((?:[^$\n\\]|\\.)*?)\$(?!\d)/g;
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
        // Whitespace-only content (`$ $`) is not a formula: the relaxed
        // trailing-space rule must not turn an empty pair into one.
        if (!inRanges(from, to, out) && m[1].trim().length > 0) {
          out.push({ from, to, display: false, content: m[1] });
        }
      }
      // The empty inline pair `$|$` (ma / ##@ right after expansion): its body
      // is empty, so the regex above does not match it, and the block layer
      // refuses a mid-line stray. It is still a formula the caret can rest
      // inside — the IME keeps English and Tab leaves through the closing
      // delimiter. A pair touching a third `$` ($$$) or preceded by `\` is
      // not classified: those are partial/escaped delimiters, not an empty
      // formula. The rule is deliberately local: a line-start `$$` that the
      // block pairing refused (a misaligned product) is also an empty pair,
      // because locally it is indistinguishable from `$|$`; the cost is only
      // an English-IME window between two visible dollars.
      let pair = lineText.indexOf("$$");
      while (pair !== -1) {
        const from = pos + pair;
        const before = pair > 0 ? lineText.charAt(pair - 1) : "";
        const after = lineText.charAt(pair + 2);
        if (before !== "\\" && before !== "$" && after !== "$" && !inRanges(from, from + 2, out)) {
          out.push({ from, to: from + 2, display: false, content: "" });
        }
        pair = lineText.indexOf("$$", pair + 2);
      }
    }
    pos = lineEnd + 1; // +1 for the newline
    if (pos > doc.length) break;
  }

  out.sort((a, b) => a.from - b.from);
  return out;
}

/**
 * The live region of a stray $$: from the `$$` to the end of the current
 * paragraph (the first blank line) — a formula being typed keeps rendering
 * live and yet never swallows the following paragraph. The region ends at the
 * last character of the paragraph (without the trailing newline), otherwise a
 * single-line region would pass the line end and the inline replace
 * decoration would throw across lines:
 * "Decorations that replace line breaks may not be specified via plugins".
 */
function pushStrayRegion(out: MathRegion[], text: string, from: number): void {
  if (text.length - from > 10_000) return;
  const rest = text.slice(from + 2, Math.min(text.length, from + 2 + 10_000));
  const blank = /\n[ \t]*\n/.exec(rest);
  // The region ends at the last character of the paragraph (without the
  // trailing newline) — whether the region spans lines is decided by the
  // newline, and counting it in would push a single-line region past the line
  // end, making the inline replace decoration throw across lines.
  const paraEnd = blank ? blank.index : rest.length;
  out.push({
    from,
    to: from + 2 + paraEnd,
    display: true,
    content: rest.slice(0, paraEnd),
    unclosed: true,
  });
}

function inRanges(from: number, to: number, ranges: MathRegion[]): boolean {
  for (const r of ranges) {
    if (from < r.to && to > r.from) return true;
  }
  return false;
}
