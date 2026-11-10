import { Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { mathRegions } from "../context";
import { latexConfig } from "./config";
import { perfEnd, perfFields, perfStart } from "@/perf/trace";

/**
 * All bracket geometry: pairing lookup, colored pairs, caret bracket
 * highlighting. Each rule maps onto obsidian-latex-suite (the function names
 * are the plugin's, to make comparison easy):
 *
 * - Pairing lookup is a **literal count** scan with no escape handling — the
 *   plugin's findMatchingBracket compares slices and counts, so the `{` of
 *   `\{` counts too (hence `\{`/`\}` are colored as well, as in the plugin).
 * - Colored pairs use a fixed 3 colors (the plugin's Ncolors = 3): the color
 *   of a pair is picked by the stack depth **after** the pop, so the outermost
 *   pair is always color 0 and the colors rotate per level. Only that single
 *   character is colored.
 * - Caret bracket highlighting looks only at the caret character and the one
 *   before it; when neither is a bracket and the selection is empty, it steps
 *   back once to find the **innermost enclosing pair**
 *   (getEnclosingBracketsPos).
 */

/** The single-character bracket table (the plugin's getOpenBracket /
 *  getCloseBracket only have these three). */
const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
export function getOpenBracket(close: string): string {
  return OPEN_OF[close];
}

const CLOSE_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
export function getCloseBracket(open: string): string {
  return CLOSE_OF[open];
}

const OPEN_BRACKETS = ["{", "[", "("];
const ALL_BRACKETS = ["{", "[", "(", "}", "]", ")"];

/**
 * Finds the `close` matching `open` starting at `from`. The count is literal
 * (same as the plugin, no escape handling); `stop` bounds the scan to the
 * right and -1 means no match. With `backwards`, the matching *opening*
 * bracket is searched to the left of `from` — only used for single-character
 * brackets (colored pairs, highlighting, enclosing brackets).
 */
export function findMatchingBracket(
  text: string,
  from: number,
  open: string,
  close: string,
  backwards = false,
  stop = text.length,
): number {
  if (backwards) {
    let depth = 0;
    for (let i = from; i >= 0; i--) {
      if (text.startsWith(close, i)) depth++;
      else if (text.startsWith(open, i) && --depth === 0) return i;
    }
    return -1;
  }
  let depth = 0;
  for (let i = from; i < stop; i++) {
    if (text.startsWith(open, i)) depth++;
    else if (text.startsWith(close, i)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The innermost bracket pair enclosing `pos` (relative coordinates); null
 *  when there is none. */
export function enclosingBrackets(
  text: string,
  pos: number,
): { left: number; right: number } | null {
  let i = Math.min(pos - 1, text.length - 1);
  while (i >= 0) {
    const ch = text.charAt(i);
    if (ALL_BRACKETS.includes(ch)) {
      if (OPEN_OF[ch] !== undefined) {
        // A closing bracket: skip its opening bracket along with it (the group
        // ends at i < pos, so it cannot enclose pos).
        const j = findMatchingBracket(text, i, OPEN_OF[ch], ch, true);
        if (j === -1) return null;
        i = j - 1;
        continue;
      }
      const j = findMatchingBracket(text, i, ch, getCloseBracket(ch), false);
      if (j >= pos) return { left: i, right: j };
    }
    i--;
  }
  return null;
}

/**
 * Whether `pos` lies strictly inside the `openSymbol`…`closeSymbol`
 * environment. Two shapes (matching the plugin's isWithinEnvironment):
 * - **Single-bracket environment** (`\pu{`, `^{`): the opener ends in
 *   `{`/`[`/`(` and the closer is that bracket's counterpart, so the pairing
 *   count starts at the left bracket found by `lastIndexOf` itself;
 * - **Multi-character environment** (`\begin{pmatrix}`…`\end{pmatrix}`): both
 *   ends are whole commands, counted as complete strings.
 * Environments of the same name may nest, so the candidates are walked
 * backwards until one really encloses `pos`.
 */
export function withinEnv(
  text: string,
  pos: number,
  openSymbol: string,
  closeSymbol: string,
): boolean {
  const trailing = openSymbol.slice(-1);
  const singleBracket =
    (trailing === "{" || trailing === "[" || trailing === "(") &&
    closeSymbol === getCloseBracket(trailing);
  // The lookup always searches for the **complete opener** (searching for a
  // lone `{` would hit ordinary braces and pull positions outside `\pu{` into
  // the environment); only the pairing scan starts at the opening bracket
  // itself, so the single-bracket shape offsets the start.
  const matchOpen = singleBracket ? trailing : openSymbol;
  const offset = singleBracket ? openSymbol.length - 1 : 0;
  let left = text.lastIndexOf(openSymbol, pos - 1);
  while (left !== -1) {
    const right = findMatchingBracket(text, left + offset, matchOpen, closeSymbol, false);
    if (right === -1) return false;
    if (right >= pos && pos >= left + openSymbol.length) return true;
    if (left <= 0) return false;
    left = text.lastIndexOf(openSymbol, left - 1);
  }
  return false;
}

/** The decoration for a bracket character (covers that one character only, as
 *  the plugin's getHighlightBracketMark does). */
function markAt(pos: number, className: string) {
  return Decoration.mark({ inclusive: true, class: className }).range(pos, pos + 1);
}

/** Colored pairs: 3 colors rotating by nesting depth (the outermost is color 0).
 *  The geometry comes only from the document + viewport range and is
 *  **independent of the selection** — that is why the plugin does not rebuild
 *  on selectionSet (see bracketColorPlugin.update). Exported so the gate can
 *  lock this invariant. */
const BRACKET_COLOR_FIELDS = perfFields("docLines", "marks");
const CURSOR_BRACKET_FIELDS = perfFields("marks");

export function buildBracketColors(view: {
  state: EditorState;
  visibleRanges: readonly { from: number; to: number }[];
}): DecorationSet {
  const t = perfStart();
  const out: ReturnType<typeof markAt>[] = [];
  const doc = view.state.doc;
  for (const range of view.visibleRanges) {
    for (const region of mathRegions(view.state)) {
      if (region.to < range.from || region.from > range.to) continue;
      const text = doc.sliceString(region.from, region.to);
      const stack: string[] = [];
      const posStack: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (OPEN_BRACKETS.includes(ch)) {
          stack.push(ch);
          posStack.push(i);
        } else if (ALL_BRACKETS.includes(ch)) {
          if (getCloseBracket(stack[stack.length - 1]) !== ch) continue; // Type mismatch: ignore
          stack.pop();
          const openPos = posStack.pop()!;
          const depth = stack.length % 3;
          out.push(markAt(openPos + region.from, `cw-bracket-${depth}`));
          out.push(markAt(i + region.from, `cw-bracket-${depth}`));
        }
      }
    }
  }
  const set = Decoration.set(out, true);
  perfEnd(t, "latex.bracketColors", BRACKET_COLOR_FIELDS, view.state.doc.lines, out.length);
  return set;
}

/** Highlights the bracket at the caret and its partner. Exported so the gate can
 *  lock the geometry (a fake view without DOM). */
export function buildCursorBrackets(view: { state: EditorState }): DecorationSet {
  const t = perfStart();
  const selection = view.state.selection;
  const doc = view.state.doc;
  const head = selection.main.to;
  const region = mathRegions(view.state).find((r) => head >= r.from && head <= r.to);
  if (!region) return Decoration.none;
  const eqn = doc.sliceString(region.from, region.to);
  /** Only two characters can be at the caret (range.to and the one before it),
   *  so do not toString() the whole document for that — this function runs on
   *  **every selection change**, and copying the full text is pure waste. */
  const charAt = (pos: number) =>
    pos < 0 || pos >= doc.length ? "" : doc.sliceString(pos, pos + 1);
  const out: ReturnType<typeof markAt>[] = [];
  let done = false;
  for (const range of selection.ranges) {
    // The caret character and the one before it (same as the plugin: i retreats
    // from range.to to range.from - 1).
    for (let i = range.to; i > range.from - 2; i--) {
      const ch = charAt(i);
      if (!ALL_BRACKETS.includes(ch)) continue;
      const isOpen = OPEN_BRACKETS.includes(ch);
      const open = isOpen ? ch : getOpenBracket(ch);
      const close = isOpen ? getCloseBracket(ch) : ch;
      const j = findMatchingBracket(eqn, i - region.from, open, close, !isOpen);
      if (j === -1) continue;
      out.push(markAt(i, "cw-bracket-match"));
      out.push(markAt(j + region.from, "cw-bracket-match"));
      done = true;
      break;
    }
    if (done) break;
    if (!range.empty) continue;
    const enc = enclosingBrackets(eqn, range.from - 1 - region.from);
    if (!enc) continue;
    out.push(markAt(enc.left + region.from, "cw-bracket-match"));
    out.push(markAt(enc.right + region.from, "cw-bracket-match"));
    done = true;
    break;
  }
  const set = Decoration.set(out, true);
  perfEnd(t, "latex.cursorBrackets", CURSOR_BRACKET_FIELDS, out.length);
  return set;
}

/** The colored-pair plugin. Toggling the switch does not necessarily come with
 *  a document/selection change (just a click in the settings panel), so the
 *  previous switch value is remembered and compared too: flipping the switch
 *  repaints immediately. */
const bracketColorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    enabled = latexConfig().bracketColors;

    constructor(view: EditorView) {
      this.decorations = this.enabled ? buildBracketColors(view) : Decoration.none;
    }

    update(u: ViewUpdate) {
      const on = latexConfig().bracketColors;
      // The colored-pair geometry comes only from the document + viewport
      // (buildBracketColors never reads the selection), so a selection change
      // cannot alter a single decoration: selecting or moving the caret must
      // not rebuild the whole bracket coloring.
      if (on === this.enabled && !u.docChanged && !u.viewportChanged) return;
      this.enabled = on;
      this.decorations = on ? buildBracketColors(u.view) : Decoration.none;
    }
  },
  { decorations: (v) => v.decorations },
);

/** The caret bracket highlighting plugin. */
const cursorBracketPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    enabled = latexConfig().highlightCursorBrackets;

    constructor(view: EditorView) {
      this.decorations = this.enabled ? buildCursorBrackets(view) : Decoration.none;
    }

    update(u: ViewUpdate) {
      const on = latexConfig().highlightCursorBrackets;
      if (on === this.enabled && !u.docChanged && !u.viewportChanged && !u.selectionSet) return;
      this.enabled = on;
      this.decorations = on ? buildCursorBrackets(u.view) : Decoration.none;
    }
  },
  { decorations: (v) => v.decorations },
);

export function bracketPlugins() {
  return [bracketColorPlugin, cursorBracketPlugin];
}
