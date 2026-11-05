import type { Text } from "@codemirror/state";
import type { CalloutRegion } from "./callout";

/**
 * Callout anchors: text spans in the body that are "the same run of text" as
 * some callout title.
 *
 * Selecting a passage and pressing ⌘⇧B creates a callout titled with it at the
 * end of the document (the selected original stays in place); that passage then
 * becomes an "entry with an explanation": it renders as an underline dashed
 * line, and putting the caret inside it and pressing ⌘⇧B jumps to the linked
 * callout. The link relies on no extra marker in the document — the title is
 * the identity, and whenever an answer is needed it is computed from "title
 * text equals body text": reopening the file or editing the title by hand
 * keeps working, and not a single byte of the body changes for this feature.
 *
 * Matching is whitespace-flexible: whitespace in the title (the newlines or
 * extra whitespace of the original selection, squeezed into single spaces when
 * the block was created) matches any whitespace run in the body (newlines
 * included), so a multi-line selection still hits; non-whitespace characters
 * must be equal character by character. No word-boundary rule: the passage the
 * user selected must hit, and that is the minimum requirement of this match —
 * a boundary rule would instead break the common shape of "selected word +
 * following Chinese text".
 */

export interface Interval {
  from: number;
  to: number;
}

/** One hit: the matched range plus the callout region it points at. */
export interface AnchorHit extends Interval {
  region: CalloutRegion;
}

const isWsCode = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;

/** Every range in doc[from, to) matching the trimmed title, in order of appearance. */
export function findTitleMatches(doc: Text, from: number, to: number, title: string): Interval[] {
  const out: Interval[] = [];
  if (to <= from || title === "") return out;
  const parts = title.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return out;
  // Slice the whole window text once; the indexOf loop no longer re-slices per
  // hit (the window is viewport-sized, so copying is cheap).
  const text = doc.sliceString(from, to);
  const first = parts[0];
  let search = 0;
  for (;;) {
    const hit = text.indexOf(first, search);
    if (hit < 0) break;
    let p = hit + first.length;
    let ok = true;
    for (let i = 1; i < parts.length; i++) {
      const ws = p;
      while (p < text.length && isWsCode(text.charCodeAt(p))) p++;
      // Segments must be separated by whitespace (a space in the title stands
      // for a newline / whitespace run in the original), and the next segment
      // must follow it immediately — any extra non-whitespace character in the
      // body means it is different text.
      if (p === ws || !text.startsWith(parts[i], p)) {
        ok = false;
        break;
      }
      p += parts[i].length;
    }
    if (ok) out.push({ from: from + hit, to: from + p });
    search = hit + 1;
  }
  return out;
}

/** Which anchor the position `pos` falls into; null when it is in no anchor. */
export function anchorRegionAt(
  doc: Text,
  callouts: CalloutRegion[],
  pos: number,
): CalloutRegion | null {
  const lineEnd = doc.lineAt(pos).to;
  for (const c of callouts) {
    if (c.title === "") continue;
    // The match may start a few characters before the caret and may also run
    // past it: derive a conservative two-sided window from the title length
    // (whitespace in the title can double in the original, so use 4x margin).
    const window = c.title.length * 4 + 64;
    const from = Math.max(0, pos - window);
    const to = Math.min(doc.length, Math.max(lineEnd, pos + window));
    for (const m of findTitleMatches(doc, from, to, c.title)) {
      if (pos >= m.from && pos < m.to) return c;
    }
  }
  return null;
}

/**
 * Every anchor in the document range [from, to) (the viewport). The callout
 * regions themselves are excluded (title line and block content — repeated
 * text inside a block is not an entry), as are the caller-provided exclusion
 * ranges (fenced code / inline code: the text there is an example or a
 * literal). When several callouts with the same title match the same range,
 * only one is kept.
 */
export function collectAnchors(
  doc: Text,
  callouts: CalloutRegion[],
  from: number,
  to: number,
  exclude: readonly Interval[],
): AnchorHit[] {
  const titled = callouts.filter((c) => c.title !== "");
  if (titled.length === 0 || to <= from) return [];
  const out: AnchorHit[] = [];
  const seen = new Set<string>();
  const clashes = (m: Interval) =>
    callouts.some((r) => m.from < r.to && m.to > r.from) ||
    exclude.some((r) => m.from < r.to && m.to > r.from);
  for (const c of titled) {
    for (const m of findTitleMatches(doc, from, to, c.title)) {
      const key = `${m.from}:${m.to}`;
      if (seen.has(key) || clashes(m)) continue;
      seen.add(key);
      out.push({ from: m.from, to: m.to, region: c });
    }
  }
  return out;
}
