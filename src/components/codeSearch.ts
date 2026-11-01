/**
 * Search for the code panes in the settings page: literal, case-insensitive,
 * returning document offsets.
 *
 * Uses the regex `i` flag instead of lowercasing both sides first: some
 * Unicode case folds change the length (`İ` -> `i̇`), so folding before
 * locating would shift every offset.
 */
export interface TextMatch {
  from: number;
  to: number;
}

/** A single-character query can match tens of thousands of places: counting and decorating that far is pointless. */
export const MAX_MATCHES = 2000;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findMatches(text: string, query: string): TextMatch[] {
  if (!query) return [];
  const re = new RegExp(escapeRegExp(query), "gi");
  const out: TextMatch[] = [];
  for (const m of text.matchAll(re)) {
    const from = m.index ?? 0;
    out.push({ from, to: from + m[0].length });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}
