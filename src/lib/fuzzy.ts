/**
 * Lightweight fuzzy matcher used by the quick switcher and command palette.
 * Returns a score (higher is better) or null when the query is not a subsequence.
 */
export interface FuzzyResult {
  score: number;
  /** Indices of matched characters in `text`. */
  positions: number[];
}

/** Characters that start a new word: path separators and the separators note
 *  names use. A match right after one of them reads as "the start of a word". */
const BOUNDARY = "/\\._ -";

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
    if (found === 0 || BOUNDARY.includes(t[found - 1] ?? "")) score += 8;
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
 * somewhere in `text` (order-free), so a query like "folder filename" finds a
 * note by its folder and name together. Score is the sum of the per-term
 * scores.
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

/**
 * Path-aware matching: the query may be split across path components, each
 * part being a contiguous run inside its own component, in order. `abef`
 * matches `abcd/efg.md` — `ab` starts the folder, `ef` starts the name. Plain
 * subsequence matching accepts that query but scores it as two stray
 * characters; the chain bonus makes the split rank as the good match it is.
 *
 * Parts score by where they sit in their component: the component start
 * (folder/name prefix, the common case) beats a word start inside it
 * (`-`, `_`, ` `), which beats a run in the middle — so a folder part does
 * not have to share the file part's prefix to be found.
 *
 * Every chain is also a subsequence, so only items the plain matcher accepts
 * pay for the chain scan.
 */
export function fuzzyMatchPath(query: string, text: string): FuzzyResult | null {
  const base = fuzzyMatchTerms(query, text);
  if (!base) return null;
  return { score: base.score + pathChainScore(query, text), positions: base.positions };
}

/** Whether the query splits into contiguous parts of consecutive path
 *  components, folder part first (0 = no). Used by the quick-open tiers, which
 *  need the yes/no rather than the ranking score. */
export function pathChainScore(query: string, text: string): number {
  let total = 0;
  for (const term of query.split(/\s+/).filter(Boolean)) {
    total += chainScore(term.toLowerCase(), text.toLowerCase());
  }
  return total;
}

/**
 * Best score for consuming `query` as contiguous parts of consecutive path
 * components; 0 when it does not split that way.
 *
 * `dp[i]` is the best score with `query[0..i)` consumed by the components seen
 * so far; components may be skipped, which is what lets a part land on a deep
 * ancestor while the query stays in order.
 */
function chainScore(query: string, text: string): number {
  const n = query.length;
  if (n === 0) return 0;
  let dp: number[] = new Array<number>(n + 1).fill(Number.NEGATIVE_INFINITY);
  dp[0] = 0;
  for (const component of text.split("/")) {
    const next = dp.slice();
    for (let from = 0; from <= n; from++) {
      const before = dp[from] ?? Number.NEGATIVE_INFINITY;
      if (before === Number.NEGATIVE_INFINITY) continue;
      for (let to = from + 1; to <= n; to++) {
        // A longer contiguous part cannot occur when the shorter one does not.
        const hit = componentHit(component, query.slice(from, to));
        if (hit === null) break;
        next[to] = Math.max(next[to] ?? Number.NEGATIVE_INFINITY, before + hit);
      }
    }
    dp = next;
  }
  const best = dp[n] ?? Number.NEGATIVE_INFINITY;
  return best === Number.NEGATIVE_INFINITY ? 0 : best;
}

/** Score for `component` holding the whole `piece` contiguously, or null. */
function componentHit(component: string, piece: string): number | null {
  if (!component.includes(piece)) return null;
  const base = piece.length * 5;
  if (component.startsWith(piece)) return base + 14;
  if (wordStart(component, piece) >= 0) return base + 8;
  return base;
}

/** First occurrence of `piece` inside `component` that starts a word, or -1. */
function wordStart(component: string, piece: string): number {
  let from = 1;
  while (from < component.length) {
    const index = component.indexOf(piece, from);
    if (index < 0) return -1;
    if (BOUNDARY.includes(component[index - 1] ?? "")) return index;
    from = index + 1;
  }
  return -1;
}

function rank<T>(
  items: T[],
  getText: (item: T) => string,
  match: (query: string, text: string) => FuzzyResult | null,
  query: string,
  limit: number,
  tiebreak?: (a: T, b: T) => number,
): { item: T; positions: number[] }[] {
  const out: { item: T; res: FuzzyResult }[] = [];
  for (const item of items) {
    const res = match(query, getText(item));
    if (res) out.push({ item, res });
  }
  out.sort((a, b) => b.res.score - a.res.score || (tiebreak ? tiebreak(a.item, b.item) : 0));
  return out.slice(0, limit).map(({ item, res }) => ({ item, positions: res.positions }));
}

export function fuzzySort<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  limit = 50,
  /** Optional tiebreak for equal fuzzy scores (e.g. recent-open order). */
  tiebreak?: (a: T, b: T) => number,
): { item: T; positions: number[] }[] {
  return rank(items, getText, fuzzyMatchTerms, query, limit, tiebreak);
}

/** `fuzzySort` over full paths with the component-chain bonus (file jumps). */
export function fuzzySortPath<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  limit = 50,
  tiebreak?: (a: T, b: T) => number,
): { item: T; positions: number[] }[] {
  return rank(items, getText, fuzzyMatchPath, query, limit, tiebreak);
}
