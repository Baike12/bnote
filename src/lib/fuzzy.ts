/**
 * Lightweight fuzzy matcher used by the quick switcher and command palette.
 * Returns a score (higher is better) or null when the query is not a subsequence.
 */
export interface FuzzyResult {
  score: number;
  /** Indices of matched characters in `text`. */
  positions: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (!query) return { score: 0, positions: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prevMatch = -2;

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    // Skip separators when the query char is a separator too.
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    // Bonus: consecutive match, start of text, or after a separator.
    if (found === prevMatch + 1) score += 5;
    if (found === 0 || "/\\._ -".includes(t[found - 1] ?? "")) score += 8;
    score -= found * 0.05; // prefer earlier matches
    positions.push(found);
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer shorter targets on ties.
  score -= text.length * 0.02;
  return { score, positions };
}

/**
 * Obsidian-style AND match: every whitespace-separated term must fuzzy-match
 * somewhere in `text` (order-free), so "文件夹 文件名" finds a note by its
 * folder and name together. Score is the sum of the per-term scores.
 */
export function fuzzyMatchTerms(query: string, text: string): FuzzyResult | null {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, positions: [] };
  let score = 0;
  const positions: number[] = [];
  for (const term of terms) {
    const res = fuzzyMatch(term, text);
    if (!res) return null;
    score += res.score;
    positions.push(...res.positions);
  }
  return { score, positions };
}

export function fuzzySort<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  limit = 50,
  /** Optional tiebreak for equal fuzzy scores (e.g. recent-open order). */
  tiebreak?: (a: T, b: T) => number,
): { item: T; positions: number[] }[] {
  const out: { item: T; res: FuzzyResult }[] = [];
  for (const item of items) {
    const res = fuzzyMatchTerms(query, getText(item));
    if (res) out.push({ item, res });
  }
  out.sort((a, b) => b.res.score - a.res.score || (tiebreak ? tiebreak(a.item, b.item) : 0));
  return out.slice(0, limit).map(({ item, res }) => ({ item, positions: res.positions }));
}
