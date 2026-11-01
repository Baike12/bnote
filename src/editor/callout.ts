import { EditorState, type Text } from "@codemirror/state";
import { fenceStateScan, mathRegionsForDoc } from "./context";
import type { MathRegion } from "./mathScan";

/**
 * Callout blocks (`:::` containers): they carry content that is "less one with
 * the body" — their own background + left rule, while the content still renders
 * as plain markdown (headings/math/code blocks all go through the existing
 * decoration paths); heading numbering inside a block is independent of the
 * outside (numbering.ts resets its counters per the regions produced here).
 *
 * Syntax (column 0 only, three or more colons):
 *   ::: optional title → opens. Non-empty text = title, rendered as a small
 *                       label on top of the block; no text = a bare block with
 *                       no title (no Obsidian-style [!note] type name needed).
 *   :::              → stack semantics: outside a block = open a titleless
 *                       block, inside a block = close the innermost one. Same
 *                       "one marker toggles" feel as code fences; a marker with
 *                       text always opens, so nested levels open with
 *                       `::: title`.
 * `:::` containers instead of Obsidian's `> [!note]`: every line of a blockquote
 * carries a `>` prefix — bnote does not hide the `>` marker (the clean block
 * surface from the screenshots is unattainable that way), and mathScan pairs
 * `$$` on plain text without knowing about a `>` prefix, so math inside the
 * block would break. `:::` content lines are clean markdown, so lezer/mathScan
 * and the existing decorations work unchanged at zero integration cost.
 *
 * Scanning follows the same model as fenceStateScan: a pure line scan (no
 * syntax tree needed, so the answer is already complete right after a file
 * loads and the tree has not parsed yet), pairing as the scan advances line by
 * line; `:::` inside fenced code lines and inside math blocks is ignored
 * (in a code fence it is a literal, in a `$$` block it belongs to the math
 * source); an unclosed block extends to the end of the document, just like an
 * unclosed fence.
 */

export interface CalloutRegion {
  /** Start of the opening marker line. The whole-block range [from, to] includes both boundary marker lines. */
  from: number;
  /** End of the closing marker line; for an unclosed block, the end of the last line. */
  to: number;
  /** Line number of the opening marker (1-based). */
  openLine: number;
  /** Line number of the closing marker (1-based); unclosed = last line. */
  closeLine: number;
  /** The text after the opening `:::` (trimmed; empty string = no title). */
  title: string;
  /** Nesting depth, 0 = outermost. */
  depth: number;
  /** false = unclosed (extends to the end of the document). */
  closed: boolean;
}

const MARKER_RE = /^(:{3,})(.*)$/;

/**
 * Pure-function scan: callers that already hold the fence state / math regions
 * pass them in (numbering already scans the fences once for renumbering, so
 * there is no reason to pay twice). The result is sorted by `from` — an outer
 * region always precedes its nested ones, so order-dependent consumers (per-line
 * depth annotation) can safely overwrite.
 */
export function computeCalloutRegions(
  doc: Text,
  fences: boolean[],
  maths: MathRegion[],
): CalloutRegion[] {
  const out: CalloutRegion[] = [];
  const stack: { openLine: number; from: number; title: string; depth: number }[] = [];
  // Only a display math region, which may span lines, can hold a column-0
  // `:::` (an inline region starts with `$`, and a `$` at column 0 can never
  // start a `:::` line); the regions are ordered by `from`, so one pass over
  // the lines covers them.
  const display = maths.filter((r) => r.display);
  let mi = 0;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    while (mi < display.length && display[mi].to < line.from) mi++;
    const inMath =
      mi < display.length && display[mi].from <= line.from && line.from <= display[mi].to;
    if (fences[n - 1] || inMath) continue;
    const m = MARKER_RE.exec(line.text);
    if (!m) continue;
    const rest = m[2].trim();
    if (stack.length > 0 && rest === "") {
      const open = stack.pop()!;
      out.push({
        from: open.from,
        to: line.to,
        openLine: open.openLine,
        closeLine: n,
        title: open.title,
        depth: open.depth,
        closed: true,
      });
    } else {
      stack.push({ openLine: n, from: line.from, title: rest, depth: stack.length });
    }
  }
  const lastLine = doc.line(doc.lines);
  while (stack.length > 0) {
    const open = stack.pop()!;
    out.push({
      from: open.from,
      to: lastLine.to,
      openLine: open.openLine,
      closeLine: doc.lines,
      title: open.title,
      depth: open.depth,
      closed: false,
    });
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}

const cache = new WeakMap<Text, CalloutRegion[]>();

/** Callout regions of the document, memoized per Text generation (decoration hot path). */
export function calloutRegions(state: EditorState): CalloutRegion[] {
  let regions = cache.get(state.doc);
  if (!regions) {
    const doc = state.doc;
    regions = computeCalloutRegions(doc, fenceStateScan(doc), mathRegionsForDoc(doc));
    cache.set(doc, regions);
  }
  return regions;
}
