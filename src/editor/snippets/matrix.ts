import { EditorSelection } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getContextAt, mathRegions } from "../context";
import { withinEnv } from "./brackets";
import { latexConfig } from "./config";

/**
 * latex-suite's matrixShortcuts: inside a matrix environment **Shift+Tab**
 * completes ` & ` (aligning the next column) and Enter completes a ` \\` line
 * break (Shift+Enter only moves the caret to the end of the next line and
 * leaves the document alone). The semantics follow the plugin's
 * runmatrixshortcuts:
 *
 * - They only apply in **block math** (inline math never triggers);
 * - The environment is detected by pairing `\begin{name}` with its end; the
 *   names come from the settings (by default pmatrix/cases/align/
 *   bmatrix/Bmatrix/vmatrix/Vmatrix/array/matrix);
 * - The plugin has no separate handling for `&`/`\\`/Backspace, and neither
 *   "auto-clean an empty matrix" nor "re-align the columns" exist (confirmed
 *   by grepping it), so neither is done here.
 *
 * **Hanging the separator on Shift+Tab** was the plugin author's change (the
 * handleKeydown comment there reads "Shift+Tab inserts &, plain Tab is left to
 * tabout"): plain Tab is left to tabout, so `&` can only be triggered by
 * Shift+Tab. This division of labour is copied verbatim — otherwise Tab inside
 * a matrix never reaches the "leave the bracket" layer, and with nested
 * brackets Tab would only ever insert ` & ` into the formula.
 */

/** The matrix row separator: space + LaTeX's `\\` + newline. The iden snippet
 *  and this place share the same constant — one wrong level of escaping and
 *  the matrix renders wrong. */
export const MATRIX_ROW_BREAK = String.raw` \\` + "\n";

/** The matrix environment name at the caret; null when the caret is not in a
 *  matrix environment (or not in block math). */
export function matrixEnvAt(state: EditorState, pos: number): string | null {
  const ctx = getContextAt(state, pos);
  if (!ctx.blockMath) return null;
  const region = mathRegions(state).find((r) => pos >= r.from && pos <= r.to);
  if (!region) return null;
  const content = state.doc.sliceString(region.from, region.to);
  const rel = pos - region.from;
  for (const env of latexConfig().matrixEnvs) {
    if (withinEnv(content, rel, `\\begin{${env}}`, `\\end{${env}}`)) return env;
  }
  return null;
}

/** The matrix column separator: inserts ` & ` (replacing the selection).
 *  Returns false when not in a matrix environment, handing the key back. */
export function matrixSeparator(view: EditorView): boolean {
  if (!latexConfig().matrixShortcuts) return false;
  const range = view.state.selection.main;
  if (!matrixEnvAt(view.state, range.from)) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: " & " },
    userEvent: "input.matrix-tab",
    scrollIntoView: true,
  });
  return true;
}

/** Enter: inserts a ` \\` line break; Shift+Enter moves to the end of the next
 *  line (and does nothing on the last line of an empty document). */
export function matrixEnter(view: EditorView, shift = false): boolean {
  if (!latexConfig().matrixShortcuts) return false;
  const range = view.state.selection.main;
  const env = matrixEnvAt(view.state, range.from);
  if (!env) return false;
  if (shift) {
    const line = view.state.doc.lineAt(range.to);
    if (line.number >= view.state.doc.lines) return false;
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.line(line.number + 1).to),
      userEvent: "select.matrix-next-row",
      scrollIntoView: true,
    });
    return true;
  }
  // align is an alignment environment, not a data table: inserting the matrix
  // row separator ` \\` there would leave the equals signs permanently
  // misaligned (the alignment point `&` has to be added by hand). Enter in an
  // align environment goes to alignEnter — it only takes over the lines it
  // "can take over" (non-empty, not begin/end, no ` \\` at the end yet); every
  // other line falls back to the default line break.
  if (env === "align") return alignEnter(view);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: MATRIX_ROW_BREAK },
    userEvent: "input.matrix-row",
    scrollIntoView: true,
  });
  return true;
}

/**
 * The pure decision for continuing an align line (exported for the gate): the
 * line text before the caret → the replacement text for that half (with ` \\`
 * and a newline at the end), null = do not take over (the caret is at the line
 * start, the line is a `\begin`/`\end` line, or the half already ends with
 * `\\` — in those cases Enter is just a normal line break and appending ` \\`
 * would only dirty the rendering).
 *
 * When it takes over there are two completions, matching the shape of an
 * align the user writes by hand (`a &= b \\`):
 * - The half has no `&`: insert `&` before the first bare relation operator
 *   (`=` / `<=` / `>=`) as the alignment point; when there already is an `&`,
 *   respect the alignment point the user chose and insert nothing.
 * - Append ` \\` (the LaTeX row separator) at the end of the half.
 *
 * The caret is the break point (the same semantics as a normal line break):
 * [line start, caret] is replaced and the text after the caret naturally
 * becomes the new line — `\end{align}` can never be swallowed into the
 * completed line.
 */
export function alignEnterPlan(headText: string): string | null {
  if (headText.trim() === "") return null;
  if (/^\s*\\(begin|end)\{/.test(headText)) return null;
  if (/\\{2}\s*$/.test(headText)) return null;
  let out = headText;
  if (!out.includes("&")) {
    const m = /(^|[^\\])([<>]?=)/.exec(out);
    if (m) {
      const at = m.index + m[1].length;
      out = `${out.slice(0, at)}&${out.slice(at)}`;
    }
  }
  // The row separator has the same source as the matrix one
  // (MATRIX_ROW_BREAK = ` \\` + newline); the escaping is written once only.
  return `${out}${MATRIX_ROW_BREAK}`;
}

/** Enter inside an align environment (empty selection): completes the half
 *  line before the caret, breaks the line, and leaves the caret at the start
 *  of the new line. Only called by matrixEnter once it has decided the
 *  environment is align. */
function alignEnter(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const line = view.state.doc.lineAt(range.head);
  const headText = line.text.slice(0, range.head - line.from);
  const plan = alignEnterPlan(headText);
  if (plan === null) return false;
  view.dispatch({
    changes: { from: line.from, to: range.head, insert: plan },
    selection: EditorSelection.cursor(line.from + plan.length),
    userEvent: "input.align-row",
    scrollIntoView: true,
  });
  return true;
}
