import type { EditorState } from "@codemirror/state";
import { getContextAt, mathRegions } from "../context";
import { findMatchingBracket, withinEnv } from "./brackets";
import { parseReplacement, type ParsedReplacement } from "./engine";

/**
 * latex-suite's auto-fraction: typing `/` in math mode expands the expression
 * before the caret into `\frac{numerator}{}`. Ported from the
 * src/features/autofraction.ts bundled with the user's modified Obsidian plugin
 * (latex-suite); each rule maps one-to-one onto the original:
 *
 * - The numerator start is found by scanning backwards and stops at a space,
 *   an opening bracket, a newline, or a breaking character (`+-=` and Tab);
 *   `) ] }` first jump to their matching opener and only then decide to stop,
 *   so the numerator of `\frac{a}{b}/` is the whole `\frac{a}{b}`.
 * - A breaking character truncates the expression: `a+b/c` → `a+\frac{b}{c}`.
 * - A space after a Greek letter command is not a boundary:
 *   `\alpha x/` → `\frac{\alpha x}{}`.
 * - When the numerator is entirely a parenthesis group, the outer pair is
 *   stripped: `(a+b)/` → `\frac{a+b}{}`.
 * - No expansion inside `^{…}` or `\pu{…}` (fractions in an exponent stay
 *   literal).
 * - No expansion inside `\text{…}`, and none when the caret is not in math mode.
 *
 * bnote's timing differs from latex-suite: there the plugin intercepts `/` on
 * keypress and never inserts it, while here the input path has already
 * inserted `/` and left the caret after it — so the scan starts at cursor-2 and
 * the replaced range includes that `/`.
 */

const BREAKING_CHARS = "+-=\t";
const STOP_CHARS = " $([{\n" + BREAKING_CHARS;
const EXCLUDED_ENVS: [string, string][] = [
  ["^{", "}"],
  ["\\pu{", "}"],
];

// The same Greek letter table as latex-suite (rare entries such as Yi/Psi are
// missing there; the original table is authoritative).
const GREEK =
  "alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|omicron|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|Upsilon|varphi|phi|Phi|chi|psi|Psi|omega|Omega";
/** The space after a Greek letter command is temporarily swapped for `#` (a
 * same-length replacement) so the scan does not stop inside the command. */
const GREEK_SPACE = new RegExp(`(${GREEK}) ([^ ])`, "g");

export interface AutoFractionResult {
  /** The replaced range (includes the `/` before the caret). */
  start: number;
  end: number;
  replacement: ParsedReplacement;
}

/** Decides whether `/` should expand into a fraction; null means the rule does
 * not apply and `/` stays literal. */
export function autoFraction(
  state: EditorState,
  cursor: number,
  visualText: string | null,
): AutoFractionResult | null {
  const region = mathRegions(state).find((r) => cursor >= r.from && cursor <= r.to);
  if (!region) return null;
  const ctx = getContextAt(state, cursor);
  if (ctx.textEnv || !(ctx.inlineMath || ctx.blockMath)) return null;

  const contentStart = region.from + (region.display ? 2 : 1);
  const to = cursor;

  // Excluded environments: a `/` inside `^{…}` or `\pu{…}` stays literal
  // (expanding a fraction in an exponent would break the meaning).
  const content = state.sliceDoc(contentStart, region.to);
  const relCursor = to - contentStart;
  for (const [open, close] of EXCLUDED_ENVS) {
    if (withinEnv(content, relCursor, open, close)) return null;
  }

  // The selection is the numerator: the `/` just replaced it, so the text
  // starts at cursor-1.
  if (visualText !== null) {
    return build(to - 1, to, visualText);
  }

  const scanned = state.sliceDoc(contentStart, to - 1).replace(GREEK_SPACE, "$1#$2");
  let start = 0; // relative to contentStart
  for (let i = scanned.length - 1; i >= 0; i--) {
    const ch = scanned[i];
    if (ch === ")" || ch === "]" || ch === "}") {
      const open = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      const j = findMatchingBracket(scanned, i, open, ch, true);
      if (j === -1) return null;
      i = j;
      if (i < 0) break; // The group opens outside the region: the numerator
      // starts at the region head.
    }
    if (STOP_CHARS.includes(ch)) {
      start = i + 1;
      break;
    }
  }
  if (start >= scanned.length) return null; // Empty numerator
  const numeratorStart = contentStart + start;
  const numerator = state.sliceDoc(numeratorStart, to - 1);
  return build(numeratorStart, to, numerator);
}

function build(start: number, end: number, numerator: string) {
  let inner = numerator;
  if (inner[0] === "(" && inner[inner.length - 1] === ")") {
    const closing = findMatchingBracket(inner, 0, "(", ")", false);
    if (closing === inner.length - 1) inner = inner.slice(1, -1);
  }
  return {
    start,
    end,
    replacement: parseReplacement(`\\frac{${inner}}{$0}$1`, [], null),
  };
}
