import type { EditorView } from "@codemirror/view";
import { mathRegions } from "../context";
import { findMatchingBracket } from "./brackets";
import { latexConfig } from "./config";

/**
 * latex-suite's autoEnlargeBrackets: when a "big operator" such as `\sum` or
 * `\frac` appears inside brackets, `( … )` is upgraded to `\left( … \right)`
 * so the user does not have to type it. Each rule maps onto the plugin:
 *
 * - The trigger is not "typing a bracket" but **a snippet expansion or an
 *   auto-fraction**: if the inserted text contains a trigger word (substring
 *   match on `\` + word), the whole equation is scanned. An auto-fraction
 *   always contains `\frac`, so it always triggers.
 * - What is written into the equation is `\left(` + space and space +
 *   `\right)`, one space on each side.
 * - A pair whose content holds no trigger word is skipped as a whole (the
 *   scan does not descend into it); **with a trigger word it advances only one
 *   level**, so nested inner brackets are enlarged on their own.
 * - A pair that is already `\left…\right` is skipped, never doubled.
 */

const LEFT = "\\left";
const RIGHT = "\\right";

/** The plugin's eight opening brackets (the key order is copied verbatim:
 *  the first match wins). */
const BRACKET_PAIRS: [string, string][] = [
  ["(", ")"],
  ["[", "]"],
  ["\\{", "\\}"],
  ["\\langle", "\\rangle"],
  ["\\lvert", "\\rvert"],
  ["\\lVert", "\\rVert"],
  ["\\lceil", "\\rceil"],
  ["\\lfloor", "\\rfloor"],
];

export interface BracketEdit {
  from: number;
  to: number;
  insert: string;
}

/** A pure function: finds the bracket pairs to enlarge in the equation text
 *  `[start, end)` and returns the insertion edits (absolute coordinates,
 *  sorted). An empty array means nothing matched. */
export function enlargeBracketEdits(
  text: string,
  start: number,
  end: number,
  triggers: string[],
): BracketEdit[] {
  const out: BracketEdit[] = [];
  for (let i = start; i < end; i++) {
    const pair = BRACKET_PAIRS.find(([open]) => text.startsWith(open, i));
    if (!pair) continue;
    const [open, close] = pair;
    const j = findMatchingBracket(text, i, open, close, false, end);
    if (j === -1) continue;
    const alreadyEnlarged =
      text.slice(i - LEFT.length, i) === LEFT && text.slice(j - RIGHT.length, j) === RIGHT;
    if (alreadyEnlarged) continue;
    const contents = text.slice(i + 1, j);
    if (!triggers.some((word) => contents.includes("\\" + word))) {
      i = j; // No big operator inside this pair: skip the pair, do not look
      // inside it
      continue;
    }
    out.push({ from: i, to: i + open.length, insert: LEFT + open + " " });
    out.push({ from: j, to: j + open.length, insert: " " + RIGHT + close });
  }
  return out;
}

/** Enlarges brackets after a snippet expansion when needed; returns whether the
 *  document was really changed. */
export function autoEnlargeBrackets(view: EditorView, inserted: string): boolean {
  const cfg = latexConfig();
  if (!cfg.autoEnlargeBrackets) return false;
  if (!cfg.autoEnlargeTriggers.some((word) => inserted.includes("\\" + word))) return false;
  const head = view.state.selection.main.head;
  const region = mathRegions(view.state).find((r) => head >= r.from && head <= r.to);
  if (!region) return false;
  const edits = enlargeBracketEdits(
    view.state.doc.toString(),
    region.from,
    region.to,
    cfg.autoEnlargeTriggers,
  );
  if (edits.length === 0) return false;
  view.dispatch({ changes: edits, userEvent: "input.snippet-enlarge" });
  return true;
}
