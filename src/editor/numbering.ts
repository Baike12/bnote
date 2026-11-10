import { EditorState } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fenceStateScan } from "./context";
import { calloutRegions } from "./callout";
import { perfEnd, perfFields, perfStart } from "@/perf/trace";

/**
 * Hierarchical heading numbering: every ATX heading outside code gets a
 * `1.1.2`-style number based on document order (`##` after the first `#`
 * becomes `1.1`, the next `#` resets `##` to `2.1`, …). Existing number
 * prefixes are replaced, so toggling headings keeps the whole document
 * consistent. Replacement only touches the `## old-number` prefix, so the
 * cursor inside the title text maps through unchanged.
 *
 * Heading collection is a plain line scan, not a syntax-tree walk: right
 * after a file switch the tree is still unparsed and a tree query silently
 * misses headings (partial numbering that then sticks). A scan is complete
 * and deterministic at any time; fenced code is excluded by tracking ```
 * / ~~~ toggles (fences indented deeper than 3 spaces — inside nested list
 * items — are only recognized by the tree, which is fine since the scan is
 * only ever a fallback-grade approximation of the same rule).
 *
 * Callout blocks (`:::` containers) are independent numbering scopes: on
 * **entering** a region the outer counters are pushed and zeroed, on leaving
 * they are restored as they were — headings inside the block count from 1
 * again while the outer sequence continues as if the block did not exist.
 * Sibling blocks (two callouts at the same level, one after the other) share
 * no counter and each starts at 1; nested blocks push layer by layer and the
 * inner one counts from the start again. The scopes are aligned by the
 * "region identity path" (the chain of regions from outer to inner), not by
 * the depth number — two sibling blocks of the same depth are different
 * scopes too.
 */

const OLD_NUMBER_RE = /^\d+(\.\d+)*[ \t]+/;

/**
 * Whether a document change can alter **numbering**. A heading is created or
 * destroyed only by `#`, a line break, or a shift of the leading whitespace
 * (column 0 matters); a callout scope only by `:`. Typing ordinary text in a
 * title or body cannot change a number, so the per-keystroke renumber scan is
 * skipped — it used to walk every line on every typed character.
 */
export function numberingMayChange(transactions: readonly Transaction[]): boolean {
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    let affected = false;
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      if (affected) return;
      const removed = tr.startState.doc.sliceString(fromA, toA);
      const inserted = tr.state.doc.sliceString(fromB, toB);
      if (/[#:\n]/.test(removed) || /[#:\n]/.test(inserted)) {
        affected = true;
        return;
      }
      // A change in the first characters of a line can expose/hide a heading
      // (the scan only recognizes column-0 headings).
      if (
        fromA - tr.startState.doc.lineAt(fromA).from <= 3 ||
        fromB - tr.state.doc.lineAt(fromB).from <= 3
      ) {
        affected = true;
      }
    });
    if (affected) return true;
  }
  return false;
}
const HEADING_RE = /^(#{1,6})([ \t]+.*)?$/;

/** Renumber replacements for `state`, [] when the numbering is already up
 *  to date. Each change rewrites one heading's prefix up to the title text.
 *  Exported so unit tests can lock the scope semantics (a pure function, no
 *  view dependency). */
const NUMBERING_SCAN_FIELDS = perfFields("lines", "changes");

export function renumberChanges(
  state: EditorState,
): { from: number; to: number; insert: string }[] {
  const t = perfStart();
  const changes = renumberChangesUnmeasured(state);
  perfEnd(t, "numbering.scan", NUMBERING_SCAN_FIELDS, state.doc.lines, changes.length);
  return changes;
}

function renumberChangesUnmeasured(
  state: EditorState,
): { from: number; to: number; insert: string }[] {
  const doc = state.doc;
  const fences = fenceStateScan(doc);
  const regions = calloutRegions(state);
  // The smallest enclosing parent region of each region (the regions are
  // sorted by `from` and properly nested; the first one found from right to
  // left that contains the region is its innermost parent).
  const parent = new Array<number>(regions.length).fill(-1);
  for (let i = 0; i < regions.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      if (
        regions[j].openLine <= regions[i].openLine &&
        regions[i].closeLine <= regions[j].closeLine
      ) {
        parent[i] = j;
        break;
      }
    }
  }
  /** The scope path of the heading: the chain of region indices from outer to inner. */
  const pathOf = (lineNo: number): number[] => {
    let idx = -1;
    for (let i = regions.length - 1; i >= 0; i--) {
      if (regions[i].openLine <= lineNo && lineNo <= regions[i].closeLine) {
        idx = i;
        break;
      }
    }
    const path: number[] = [];
    for (let r = idx; r !== -1; r = parent[r]) path.unshift(r);
    return path;
  };

  const heads: { lineNo: number; level: number }[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    if (fences[n - 1]) continue;
    // Only headings that own their whole line from column 0 (not
    // list-embedded, matching the previous tree-based rule).
    const m = HEADING_RE.exec(doc.line(n).text);
    if (m) heads.push({ lineNo: n, level: m[1].length });
  }
  if (heads.length === 0) return [];

  const counters = [0, 0, 0, 0, 0, 0, 0];
  const saved: number[][] = [];
  let prevPath: number[] = [];
  let curDepth = 0;
  const changes: { from: number; to: number; insert: string }[] = [];

  for (const head of heads) {
    // Entering and leaving a callout scope: take the common prefix of this
    // heading's scope path and the previous one, restore the counters of the
    // popped layers and zero the newly entered ones. The depth may jump by
    // several levels at once (the first heading inside a nested block), so
    // the loop fills the gap.
    const path = pathOf(head.lineNo);
    let common = 0;
    while (common < path.length && common < prevPath.length && path[common] === prevPath[common]) {
      common++;
    }
    while (curDepth > common) {
      const outer = saved.pop();
      if (outer) counters.splice(0, outer.length, ...outer);
      curDepth--;
    }
    while (curDepth < path.length) {
      saved.push(counters.slice());
      counters.fill(0);
      curDepth++;
    }
    prevPath = path;
    counters[head.level]++;
    for (let l = head.level + 1; l <= 6; l++) counters[l] = 0;
    // Strict level counters, then drop missing-parent (leading zero) parts so
    // a document starting at `##` numbers it "1" rather than "0.1".
    const parts = counters.slice(1, head.level + 1);
    while (parts.length > 1 && parts[0] === 0) parts.shift();
    const number = parts.join(".");

    const line = doc.line(head.lineNo);
    const hash = "#".repeat(head.level);
    const rest = line.text.slice(head.level).replace(/^[ \t]+/, "");
    const title = rest.replace(OLD_NUMBER_RE, "");
    const titleStart = line.to - title.length;
    const want = title ? `${hash} ${number} ` : `${hash} ${number}`;
    const have = line.text.slice(0, line.text.length - title.length);
    if (have !== want) {
      changes.push({ from: line.from, to: titleStart, insert: want });
    }
  }
  return changes;
}

/** Runs one renumbering pass over the current document (no-op when current
 *  numbers are already correct). The cursor maps through prefix-only edits. */
export function renumberHeadings(view: EditorView) {
  const changes = renumberChanges(view.state);
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.bnote-renumber" });
  }
}
