import { EditorSelection } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getContextAt, mathRegions } from "../context";
import { latexConfig } from "./config";

/**
 * latex-suite's `tabout`: once the snippet and all its tab stops are done,
 * the last layer of Tab is "carry the caret out of the bracket" (the plugin's
 * features/tabout.ts plus the tail of handleKeydown). The semantics follow
 * rule by rule:
 *
 * 1. It only applies inside a formula (inline/block math); in prose Tab is
 *    still an indent;
 * 2. Starting at the caret, it scans forward to the **end of the formula
 *    content** (excluding the closing delimiter) and steps over one character
 *    on hitting any of `}` `)` `]` `>` `|` `$` — with nested brackets one Tab
 *    leaves one level;
 * 3. Only when the scan reaches the end of the content in whitespace (the
 *    caret already sits at the tail of the formula) does it count as "leaving
 *    the whole block": an inline formula lands after the closing `$`; a block
 *    formula lands at the **start of the line after** the bottom `$$` line,
 *    and the trailing whitespace of the line the caret was on is cleaned up;
 *    when the bottom `$$` is already the last line, a newline is inserted
 *    first, otherwise there is no "next line" to land on.
 *
 * Three deliberate differences from the plugin (all locked by the gate):
 * - The cleanup only trimEnds, it does **not** trim the line start: the plugin
 *   uses `line.text.trim()`, which in a list item also eats the indent of the
 *   formula content line, and that indent is part of the markdown structure;
 * - The plugin dispatches the change and then calls setCursor with the **old**
 *   coordinates (the caret drifts by the number of eaten characters); here the
 *   landing point is mapped to the new document by the size of the change;
 * - `codeMath` (a formula inside a ```math fence) does not take part: bnote
 *   has no forceMathLanguages, so fenced formulas do not enter mathRegions.
 */
const TARGET_CHARS = "})]>|$";

/** A multi-character closer: the plugin special-cases only `\rangle` (it does
 *  not end in a single scannable character). */
const RIGHT_ANGLE = "\\rangle";

export interface TaboutPlan {
  /** Where the caret lands after the transaction (new document coordinates). */
  pos: number;
  /** The document changes in the transaction (the cleanup of a block formula). */
  changes: { from: number; to: number; insert: string }[];
}

/** The right end of the formula content (excluding the closing delimiter):
 *  two characters for a block `$$`, one for an inline `$`. */
function contentEnd(region: { display: boolean; to: number }): number {
  return region.display ? region.to - 2 : region.to - 1;
}

/** The left end of the formula content (excluding the opening delimiter). */
function contentStart(region: { display: boolean; from: number }): number {
  return region.display ? region.from + 2 : region.from + 1;
}

/** A pure decision: whether to leave, where to, and what to change; null when
 *  there is nowhere to leave to. */
export function planTabout(state: EditorState, pos: number): TaboutPlan | null {
  const ctx = getContextAt(state, pos);
  if (!ctx.inlineMath && !ctx.blockMath) return null;
  const region = mathRegions(state).find((r) => pos >= r.from && pos <= r.to);
  if (!region) return null;
  const end = contentEnd(region);
  // The caret sits on a delimiter (the one or two `$` at the start or end of
  // the formula): that is not a leave-the-bracket case. The plugin's tree
  // classifies such positions as math-begin/math-end, where `inMath()` is
  // false as well.
  if (pos > end || pos < contentStart(region)) return null;

  // Only the segment from the caret to the end of the content is examined:
  // Tab is a high-frequency key, and one scan must not turn the whole
  // document into a string.
  const seg = state.doc.sliceString(pos, end);
  for (let i = 0; i < seg.length; i++) {
    if (TARGET_CHARS.includes(seg.charAt(i))) return { pos: pos + i + 1, changes: [] };
    if (seg.startsWith(RIGHT_ANGLE, i)) {
      return { pos: pos + i + RIGHT_ANGLE.length, changes: [] };
    }
  }

  // Only whitespace between the caret and the end of the content: leave the
  // whole block.
  if (seg.trim() !== "") return null;
  if (!region.display) return { pos: region.to, changes: [] };

  return blockExit(state, pos, end);
}

/** Leaving a block formula as a whole: lands at the start of the line after
 *  the bottom `$$`, and clears the trailing whitespace of the caret's line. */
function blockExit(state: EditorState, pos: number, end: number): TaboutPlan {
  const doc = state.doc;
  const closing = doc.lineAt(end);
  const changes: TaboutPlan["changes"] = [];
  let target: number;
  if (closing.number === doc.lines) {
    // The bottom $$ is already the last line: insert a newline so that there
    // is a "next line" to land on.
    target = doc.length + 1;
    changes.push({ from: doc.length, to: doc.length, insert: "\n" });
  } else {
    target = doc.line(closing.number + 1).from;
  }

  const line = doc.lineAt(pos);
  const trimmed = line.text.trimEnd();
  if (trimmed !== line.text) {
    // The trailing whitespace is eaten before the landing point, so the
    // landing point shifts left with it (the plugin lands on the old
    // coordinates here and drifts).
    if (line.to <= target) target += trimmed.length - line.text.length;
    changes.push({ from: line.from, to: line.to, insert: trimmed });
  }
  return { pos: target, changes };
}

/** The last layer of Tab: leave the bracket/formula block. */
export function tabout(view: EditorView): boolean {
  if (!latexConfig().tabout) return false;
  const plan = planTabout(view.state, view.state.selection.main.to);
  if (!plan) return false;
  view.dispatch({
    changes: plan.changes,
    selection: EditorSelection.cursor(plan.pos),
    userEvent: "select.tabout",
    scrollIntoView: true,
  });
  return true;
}
