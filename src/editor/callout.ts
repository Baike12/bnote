import { EditorState, StateField, type Text, type Transaction } from "@codemirror/state";
import { fenceStateScan, mathRegions, mathRegionsField, mathRegionsForDoc } from "./context";
import type { MathRegion } from "./mathScan";
import { perfEnd, perfFields, perfStart } from "@/perf/trace";

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
const CALLOUT_SCAN_FIELDS = perfFields("bytes", "lines", "regions");

export function computeCalloutRegions(
  doc: Text,
  fences: boolean[],
  maths: MathRegion[],
): CalloutRegion[] {
  const t = perfStart();
  const out = computeCalloutRegionsUnmeasured(doc, fences, maths);
  perfEnd(t, "callout.scan", CALLOUT_SCAN_FIELDS, doc.length, doc.lines, out.length);
  return out;
}

function computeCalloutRegionsUnmeasured(
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

/** A CommonMark fence line (the scan in context.ts uses the same shape). */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Whether a transaction can change the callout geometry: a marker character,
 * a line break (line numbers), a fence or a math delimiter (both hide marker
 * lines), or any edit on a line whose text is a `:::` marker — a marker's role
 * is decided by its **whole text**, so typing an ordinary character on an
 * opening line (the title) or on a closing line adds/removes a marker without
 * typing a colon. Fence lines need the same treatment: a letter appended to a
 * closing fence turns it into text and unhides the `:::` lines it swallowed.
 * An ordinary body edit maps the regions.
 */
function mayAffectCallouts(tr: Transaction): boolean {
  let affected = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (affected) return;
    const removed = tr.startState.doc.sliceString(fromA, toA);
    const inserted = tr.state.doc.sliceString(fromB, toB);
    if (/[:\n`~$]/.test(removed) || /[:\n`~$]/.test(inserted)) {
      affected = true;
      return;
    }
    const oldLine = tr.startState.doc.lineAt(fromA).text;
    const newLine = tr.state.doc.lineAt(fromB).text;
    if (oldLine.startsWith(":::") || newLine.startsWith(":::")) {
      affected = true;
      return;
    }
    if (FENCE_LINE.test(oldLine) || FENCE_LINE.test(newLine)) affected = true;
  });
  return affected;
}

/** Line numbers and titles are unchanged here (a newline or a marker-line
 *  edit triggers a re-scan), so only the absolute ranges move. An unclosed
 *  callout's `to` is the document end by definition, so it must follow the
 *  document rather than map like a closing marker. */
function mapCalloutRegions(regions: CalloutRegion[], tr: Transaction): CalloutRegion[] {
  const docLength = tr.state.doc.length;
  return regions.map((region) => {
    const from = tr.changes.mapPos(region.from, 1);
    const to = region.closed ? tr.changes.mapPos(region.to, -1) : docLength;
    return from === region.from && to === region.to ? region : { ...region, from, to };
  });
}

/** The line spans of the display-math regions. The callout scan reads math
 *  only to skip `:::` lines inside display math, so a content edit (same line
 *  spans) or a position shift with the same lines cannot change the result. */
function displayLines(doc: Text, regions: readonly MathRegion[]): number[] {
  const out: number[] = [];
  for (const r of regions) {
    if (!r.display) continue;
    out.push(doc.lineAt(r.from).number, doc.lineAt(r.to).number);
  }
  return out;
}

function displayLinesChanged(
  oldDoc: Text,
  oldRegions: readonly MathRegion[],
  newDoc: Text,
  newRegions: readonly MathRegion[],
): boolean {
  const before = displayLines(oldDoc, oldRegions);
  const after = displayLines(newDoc, newRegions);
  return before.length !== after.length || before.some((n, i) => n !== after[i]);
}

/** Callout regions as a state field (see mathRegionsField for the same
 *  single-writer/mapped-cache rule). Declared after mathRegionsField so this
 *  update reads the math regions of the same transaction. */
export const calloutRegionsField = StateField.define<CalloutRegion[]>({
  create: (state) =>
    computeCalloutRegions(state.doc, fenceStateScan(state.doc), mathRegions(state)),
  update(value, tr) {
    if (!tr.docChanged) return value;
    // The scan reads the math regions (display math hides `:::` lines). When
    // the display-math line spans changed — even through an edit that typed no
    // delimiter, such as a blank-line repair — the geometries cannot be
    // mapped. A plain shift of the same formulas does not qualify: their line
    // spans move with the text, and the regions map.
    const oldMath = tr.startState.field(mathRegionsField, false);
    const newMath = tr.state.field(mathRegionsField, false);
    const mathChanged =
      oldMath !== newMath &&
      (!oldMath ||
        !newMath ||
        displayLinesChanged(tr.startState.doc, oldMath, tr.state.doc, newMath));
    if (mathChanged || mayAffectCallouts(tr)) {
      return computeCalloutRegions(
        tr.state.doc,
        fenceStateScan(tr.state.doc),
        mathRegions(tr.state),
      );
    }
    return mapCalloutRegions(value, tr);
  },
});

/** Callout regions of the document. Bare states in tests fall back to the
 *  per-Text memo (the same API without the editor setup). */
export function calloutRegions(state: EditorState): CalloutRegion[] {
  const field = state.field(calloutRegionsField, false);
  if (field) return field;
  let regions = cache.get(state.doc);
  if (!regions) {
    const doc = state.doc;
    regions = computeCalloutRegions(doc, fenceStateScan(doc), mathRegionsForDoc(doc));
    cache.set(doc, regions);
  }
  return regions;
}
