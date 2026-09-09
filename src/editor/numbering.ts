import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fenceStateScan } from "./context";

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
 */

const OLD_NUMBER_RE = /^\d+(\.\d+)*[ \t]+/;
const HEADING_RE = /^(#{1,6})([ \t]+.*)?$/;

/** Renumber replacements for `state`, [] when the numbering is already up
 *  to date. Each change rewrites one heading's prefix up to the title text. */
function renumberChanges(state: EditorState): { from: number; to: number; insert: string }[] {
  const doc = state.doc;
  const fences = fenceStateScan(doc);
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
  const changes: { from: number; to: number; insert: string }[] = [];

  for (const head of heads) {
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
