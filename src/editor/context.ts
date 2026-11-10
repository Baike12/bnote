import { StateField } from "@codemirror/state";
import type { EditorState, Text, Transaction } from "@codemirror/state";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { scanMath, type MathRegion } from "./mathScan";

/** CommonMark fence marker: at most 3 leading spaces plus at least 3 ` or ~. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Scans the whole document in one pass and returns whether each line is inside
 * a ``` / ~~~ fenced code block (index = line number - 1; a line's own fence
 * marker does not decide whether that line is "inside a fence"). The syntax
 * tree is still empty right after a file loads (background parsing has not
 * finished), and tree queries miss fences and headings entirely — so every
 * logic that must answer deterministically during that window (list
 * continuation on Enter, heading renumbering) falls back to this scan.
 */
export function fenceStateScan(doc: Text): boolean[] {
  const inside = new Array<boolean>(doc.lines);
  let open: string | null = null;
  let openLen = 0;
  for (let n = 1; n <= doc.lines; n++) {
    inside[n - 1] = open !== null;
    const m = FENCE_RE.exec(doc.line(n).text);
    if (!m) continue;
    if (open === null) {
      open = m[1][0];
      openLen = m[1].length;
    } else if (m[1][0] === open && m[1].length >= openLen && m[2].trim() === "") {
      open = null;
    }
  }
  return inside;
}

/** Whether line `lineNo` is inside fenced code (scans the fence state over the lines before it). */
export function insideFencedCodeByScan(doc: Text, lineNo: number): boolean {
  let open: string | null = null;
  let openLen = 0;
  for (let n = 1; n < lineNo; n++) {
    const m = FENCE_RE.exec(doc.line(n).text);
    if (!m) continue;
    if (open === null) {
      open = m[1][0];
      openLen = m[1].length;
    } else if (m[1][0] === open && m[1].length >= openLen && m[2].trim() === "") {
      open = null;
    }
  }
  return open !== null;
}

/**
 * Whether the caret is inside a fenced code block: with the tree available it
 * queries the tree (a FencedCode node, which includes the fence marker lines
 * themselves); before the tree is ready (file just loaded, background parsing
 * unfinished) it falls back to the line scan. Every "is the caret inside a
 * code block" decision goes through here — nobody may roll their own, because
 * the two paths differ on the fence marker lines themselves (the tree counts
 * them, the scan does not), which is only tolerable for low-stakes checks
 * like the IME one.
 */
export function insideFencedCode(state: EditorState, pos: number): boolean {
  if (syntaxTreeAvailable(state, pos + 1)) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    for (; node; node = node.parent) {
      if (node.name === "FencedCode") return true;
    }
    return false;
  }
  return insideFencedCodeByScan(state.doc, state.doc.lineAt(pos).number);
}

export interface EditContext {
  /** Inside $…$ */
  inlineMath: boolean;
  /** Inside $$…$$ */
  blockMath: boolean;
  /** Inside \text{…} within math */
  textEnv: boolean;
  /** Inside inline code (`…`) or a fenced code block */
  code: boolean;
  /** Language of the enclosing fenced code block, if any */
  codeBlock: string | boolean;
  /** None of the above (plain markdown text) */
  isText: boolean;
}

const mathCache = new WeakMap<object, MathRegion[]>();

/** The character at `pos`; the empty string at the document edges. */
function charAt(doc: Text, pos: number): string {
  return pos < 0 || pos >= doc.length ? "" : doc.sliceString(pos, pos + 1);
}

function lineBlank(doc: Text, pos: number): boolean {
  return !/\S/.test(doc.lineAt(pos).text);
}

/** Pairing reads only two things about a neighbour: the character **after** a
 *  `$` (whitespace blocks an opener, a digit blocks a closer) and whether the
 *  character **before** it is `$` or `\` (adjacency/escape). Classifying the
 *  old and new neighbours lets an ordinary letter typed inside a formula map,
 *  while a space/digit typed next to a delimiter rescans. */
function rightClass(ch: string): number {
  if (ch === "$") return 1;
  if (ch === "\\") return 2;
  if (ch === "") return 3;
  if (/\s/.test(ch)) return 4;
  if (/[0-9]/.test(ch)) return 5;
  return 6;
}

function leftClass(ch: string): number {
  if (ch === "$") return 1;
  if (ch === "\\") return 2;
  return 3;
}

/**
 * Whether a transaction can change **pairing**. The predicate must be a
 * superset of every pairing input; a false negative leaves the field stale
 * (no live preview, wrong IME context), which is worse than a re-scan.
 *
 * Pairing reads: the delimiters themselves, `\n` (line structure), `\`
 * (escapes), the character class immediately after a `$` (whitespace blocks an
 * opener, a digit blocks a closer) and line blankness (the display-block
 * exemption). `\begin`/`\end` tokens only matter inside a display block that
 * already contains a blank line, where any edit may complete the token.
 * Ordinary text — including LaTeX commands — maps the regions.
 */
function mayAffectMath(tr: Transaction, regions: MathRegion[]): boolean {
  const oldDoc = tr.startState.doc;
  const newDoc = tr.state.doc;
  let affected = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (affected) return;
    const removed = oldDoc.sliceString(fromA, toA);
    const inserted = newDoc.sliceString(fromB, toB);
    if (/[$\n\\]/.test(removed) || /[$\n\\]/.test(inserted)) {
      affected = true;
      return;
    }
    // A stray `$$` is a block only while its line prefix is whitespace. An
    // edit earlier on the same line (typing `- ` at column 0, deleting a word
    // before it) flips that classification without touching a delimiter.
    const oldLineText = oldDoc.lineAt(fromA).text;
    const newLineText = newDoc.lineAt(fromB).text;
    const oldMarker = oldLineText.indexOf("$$");
    const newMarker = newLineText.indexOf("$$");
    if (oldMarker !== -1 && newMarker !== -1) {
      const oldAtLineStart = oldLineText.slice(0, oldMarker).trim() === "";
      const newAtLineStart = newLineText.slice(0, newMarker).trim() === "";
      if (oldAtLineStart !== newAtLineStart) {
        affected = true;
        return;
      }
    }
    // A `$` on either edge of the change has one of its pairing neighbours
    // replaced. Compare the classes, not the characters: `$a$` → `$b$` maps.
    // The second `$` of a `$$` is exempt on its right side: block delimiters
    // (and the empty `$|$` pair) do not care about whitespace/digits there, so
    // typing the first body character of a block must not rescan.
    const oldBefore = charAt(oldDoc, fromA - 1);
    const oldAfter = charAt(oldDoc, toA);
    const oldFirst = charAt(oldDoc, fromA);
    const oldLast = charAt(oldDoc, toA - 1);
    const newFirst = charAt(newDoc, fromB);
    const newLast = charAt(newDoc, toB - 1);
    const secondOfBlock = oldBefore === "$" && charAt(oldDoc, fromA - 2) === "$";
    if (!secondOfBlock && oldBefore === "$" && rightClass(oldFirst) !== rightClass(newFirst)) {
      affected = true;
      return;
    }
    if (oldAfter === "$" && leftClass(oldLast) !== leftClass(newLast)) {
      affected = true;
      return;
    }
    // A backslash matters only through the character it escapes: if the edit
    // inserts a character between `\` and `$` (or deletes it), the escape
    // state flips. A `\` followed by anything else (a LaTeX command) does not
    // need a re-scan — typing `\frac` must cost one scan, not two.
    if (oldBefore === "\\" && (oldFirst === "$" || newFirst === "$")) {
      affected = true;
      return;
    }
    if (lineBlank(oldDoc, fromA) !== lineBlank(newDoc, fromB)) {
      affected = true;
      return;
    }
    const enclosing = regions.find((r) => r.display && fromA >= r.from && toA <= r.to);
    if (enclosing && /[ \t]*\n[ \t]*\n/.test(enclosing.content)) affected = true;
  });
  return affected;
}

/** Maps regions through a transaction that cannot change pairing; content is
 *  re-sliced only for regions the change really intersects.
 *
 *  An unclosed region's `to` **is** the end of its body (the paragraph end;
 *  see pushStrayRegion), not an exclusive boundary like a closing delimiter.
 *  It therefore maps with assoc +1 and accepts an insertion exactly at `to`:
 *  typing there is still typing into the formula, and with the closed rule the
 *  region would keep `content:""` and never render. */
function mapMathRegions(regions: MathRegion[], tr: Transaction): MathRegion[] {
  const changes: { from: number; to: number }[] = [];
  tr.changes.iterChangedRanges((fromA, toA) => changes.push({ from: fromA, to: toA }));
  const doc = tr.state.doc;
  // Keep the array identity when nothing moved: consumers derive from it (the
  // callout field compares identity/line spans), and an edit after every
  // formula must not look like a math change.
  let out: MathRegion[] | null = null;
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const from = tr.changes.mapPos(region.from, 1);
    const unclosed = region.unclosed === true;
    const to = tr.changes.mapPos(region.to, unclosed ? 1 : -1);
    let intersects = false;
    for (const c of changes) {
      if (c.from < region.to || (unclosed && c.from === region.to)) {
        if (c.to > region.from) {
          intersects = true;
          break;
        }
      }
    }
    let next = region;
    if (intersects) {
      const start = region.display ? from + 2 : from + 1;
      const end = unclosed ? to : to - (region.display ? 2 : 1);
      next = {
        ...region,
        from,
        to,
        content: doc.sliceString(Math.max(start, from), Math.max(start, end)),
      };
    } else if (from !== region.from || to !== region.to) {
      next = { ...region, from, to };
    }
    if (next === region && out === null) continue;
    if (out === null) out = regions.slice(0, i);
    out.push(next);
  }
  return out ?? regions;
}

/**
 * Math regions as a state field: the single source for every per-keystroke
 * consumer (decorations, IME, snippets, Tab). Without it each caller scanned
 * the whole document whenever a Text generation changed — i.e. on **every
 * keystroke**. The field maps the previous regions through ordinary edits and
 * only re-scans when pairing can actually change (see mayAffectMath).
 */
export const mathRegionsField = StateField.define<MathRegion[]>({
  create: (state) => scanMath(state.doc),
  update(value, tr) {
    if (!tr.docChanged) return value;
    return mayAffectMath(tr, value) ? scanMath(tr.state.doc) : mapMathRegions(value, tr);
  },
});

/** Math regions of the document. States that carry the field (all editor
 *  instances) are O(changes); bare states in tests fall back to the per-Text
 *  memo so the public API stays usable without the editor setup. */
export function mathRegions(state: EditorState): MathRegion[] {
  const field = state.field(mathRegionsField, false);
  return field ?? mathRegionsForDoc(state.doc);
}

/** Doc-keyed variant: modules that hold no EditorState (the callout scan) share
 *  the same memo as the decoration path, so a full-document math scan is paid
 *  once per document generation. */
export function mathRegionsForDoc(doc: Text): MathRegion[] {
  let regions = mathCache.get(doc);
  if (!regions) {
    regions = scanMath(doc);
    mathCache.set(doc, regions);
  }
  return regions;
}

/**
 * Whether the caret rests on the math **body** — that is, "will the next typed
 * character go into the math source".
 *
 * Position semantics (in CM6 a position sits between characters): `from` is
 * before the opening delimiter and `to` after the closing one, so both lie on
 * the **body side** — typing there lands outside the formula. Hence a closed
 * region only accepts its strict interior; an unclosed region (unclosed: only
 * one `$$`, still being typed) has no closing delimiter, so `to` is the end of
 * the body and typing there still writes into the formula.
 *
 * This is the single source of truth for "typing intent": the IME picks the
 * English/Chinese source by it (math is ASCII), and inline math source
 * expansion follows it too (caret on a boundary = the formula is rendered and
 * the caret is outside the widget, so expanding the source again would trap
 * the caret between source and preview). The **block-level** math activation
 * rule is a different matter: a full-line block widget covers the line the
 * boundary position sits on, and when collapsed it draws the caret outside
 * its own line — see active() in livePreview.
 */
export function caretInMathBody(region: MathRegion, pos: number): boolean {
  return pos > region.from && (pos < region.to || region.unclosed === true);
}

/**
 * Whether the selection rests on the math body: an empty selection follows the
 * caret, a non-empty one counts as long as it intersects the body (the user is
 * selecting math text and must be able to see what they selected).
 */
export function selectionInMathBody(region: MathRegion, from: number, to: number): boolean {
  if (from === to) return caretInMathBody(region, from);
  const bodyEnd = region.unclosed === true ? region.to : region.to - 1;
  return from <= bodyEnd && to >= region.from + 1;
}

/** The position range of the math body, clamped inside the delimiters (used to
 *  land a click on a rendered formula inside its body). A closed region drops
 *  both delimiters; an unclosed region's `to` already is the end of the body. */
export function mathBodySpan(region: MathRegion): { from: number; to: number } {
  const open = region.display ? region.from + 2 : region.from + 1;
  const close = region.unclosed === true ? region.to : region.to - (region.display ? 2 : 1);
  return { from: open, to: Math.max(open, close) };
}

/**
 * Whether an inline node's delimiters fall inside math — math content is not
 * markdown.
 *
 * lezer does not know `$$…$$` / `$…$`, so a `_` (subscript) inside math is
 * taken for an italic marker; once two `_` from different formulas pair up
 * into an Emphasis node, the whole span of body text between them (even
 * across a dozen lines) gets italicized. If the node's **first or last
 * character** lies inside a math region, then at least one end of that
 * delimiter pair is LaTeX text and the node must be discarded wholesale.
 * Checking only the ends is deliberate: when emphasis legitimately wraps an
 * inline formula (`_text $x$ text_`) both ends are body text and the node
 * must be kept.
 */
export function mathOwnsEndpoints(
  regions: readonly MathRegion[],
  from: number,
  to: number,
): boolean {
  if (to <= from) return false;
  const last = to - 1;
  return regions.some((r) => (from >= r.from && from < r.to) || (last >= r.from && last < r.to));
}

/** Classifies the cursor position for snippet-mode matching, in the spirit of
 *  latex-suite's Context (math / code / \text{} environments). */
export function getContextAt(state: EditorState, pos: number): EditContext {
  let codeBlock: string | boolean = false;
  let inlineCode = false;

  let cur: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (cur) {
    const name = cur.name;
    if (name === "FencedCode" || name === "CodeBlock" || name === "IndentedCode") {
      let lang: string | false = false;
      for (let child = cur.firstChild; child; child = child.nextSibling) {
        if (child.name === "CodeInfo") {
          lang = state.sliceDoc(child.from, child.to);
          break;
        }
      }
      codeBlock = lang || true;
      break;
    }
    if (name === "InlineCode") {
      inlineCode = true;
      break;
    }
    cur = cur.parent;
  }

  let inlineMath = false;
  let blockMath = false;
  let textEnv = false;
  if (!codeBlock && !inlineCode) {
    for (const region of mathRegions(state)) {
      if (pos >= region.from && pos <= region.to) {
        if (region.display) blockMath = true;
        else inlineMath = true;
        textEnv = insideTextEnv(region, pos);
        break;
      }
    }
  }

  const code = inlineCode || codeBlock !== false;
  return {
    inlineMath,
    blockMath,
    textEnv,
    code,
    codeBlock,
    isText: !code && !inlineMath && !blockMath,
  };
}

/** Checks whether `pos` falls inside a \text{…} group of a math region. */
function insideTextEnv(region: MathRegion, pos: number): boolean {
  if (!region.content.includes("\\text")) return false;
  const base = region.from + 2; // content offset within region
  const content = region.content;
  const idx = pos - base;
  if (idx < 0 || idx > content.length) return false;

  const openRe = /\\text\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(content))) {
    const openBrace = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = openBrace; i < content.length; i++) {
      const ch = content[i];
      if (ch === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          if (idx > openBrace && idx <= i) return true;
          break;
        }
      }
    }
  }
  return false;
}
