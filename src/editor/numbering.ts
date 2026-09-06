import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

/**
 * Hierarchical heading numbering: every ATX heading outside code gets a
 * `1.1.2`-style number based on document order (`##` after the first `#`
 * becomes `1.1`, the next `#` resets `##` to `2.1`, …). Existing number
 * prefixes are replaced, so toggling headings keeps the whole document
 * consistent. Runs as one transaction; the cursor maps through it.
 */

const OLD_NUMBER_RE = /^\d+(\.\d+)*[ \t]+/;

export function renumberHeadings(view: EditorView) {
  const state = view.state;

  const heads: { from: number; to: number; level: number }[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      // Headings inside fenced/indented code or math are not headings.
      if (ref.name === "FencedCode" || ref.name === "IndentedCode") return false;
      const m = /^ATXHeading([1-6])$/.exec(ref.name);
      if (m) {
        const node = ref.node;
        // Only number headings that own their whole line (not list-embedded).
        if (state.doc.lineAt(node.from).from === node.from) {
          heads.push({ from: node.from, to: node.to, level: Number(m[1]) });
        }
      }
      return undefined;
    },
  });
  if (heads.length === 0) return;

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

    const line = state.doc.lineAt(head.from);
    const m = /^(#{1,6})[ \t]*(.*)$/.exec(line.text);
    if (!m) continue;
    const title = m[2].replace(OLD_NUMBER_RE, "");
    const insert = title ? `${m[1]} ${number} ${title}` : `${m[1]} ${number}`;
    if (insert !== line.text) {
      changes.push({ from: line.from, to: line.to, insert });
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.bnote-renumber" });
  }
}
