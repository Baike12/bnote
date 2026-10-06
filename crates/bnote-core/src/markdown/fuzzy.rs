//! Port of `src/lib/fuzzy.ts` — lightweight fuzzy matcher used by the quick
//! switcher and command palette.
//!
//! Positions are **char indices** into the lowercased text (the TS module
//! indexes UTF-16 units of the lowercased string; notes are effectively ASCII
//! here and the host only uses positions for highlight rendering). Scores are
//! `f64`, matching the TS arithmetic exactly.

/// One match result: score and the indices of matched characters in `text`.
/// Mirrors the TS `FuzzyResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct FuzzyResult {
    pub score: f64,
    pub positions: Vec<usize>,
}

/// Port of `src/lib/fuzzy.ts::fuzzyMatch`. Returns a score (higher is better)
/// or `None` when the query is not a subsequence.
pub fn fuzzy_match(query: &str, text: &str) -> Option<FuzzyResult> {
    if query.is_empty() {
        return Some(FuzzyResult { score: 0.0, positions: Vec::new() });
    }

    let q: Vec<char> = query.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let text_len = text.chars().count();
    let mut positions: Vec<usize> = Vec::new();
    let mut score = 0.0f64;
    let mut ti = 0usize;
    let mut prev_match: isize = -2;

    for &ch in &q {
        let mut found: Option<usize> = None;
        // Skip separators when the query char is a separator too.
        while ti < t.len() {
            if t[ti] == ch {
                found = Some(ti);
                break;
            }
            ti += 1;
        }
        let found = found?;
        // Bonus: consecutive match, start of text, or after a separator.
        if found as isize == prev_match + 1 {
            score += 5.0;
        }
        if found == 0 || matches!(t[found - 1], '/' | '\\' | '.' | '_' | ' ' | '-') {
            score += 8.0;
        }
        score -= found as f64 * 0.05; // prefer earlier matches
        positions.push(found);
        prev_match = found as isize;
        ti = found + 1;
    }
    // Prefer shorter targets on ties.
    score -= text_len as f64 * 0.02;
    Some(FuzzyResult { score, positions })
}

/// Port of `src/lib/fuzzy.ts::fuzzyMatchTerms`.
///
/// Obsidian-style AND match: every whitespace-separated term must fuzzy-match
/// somewhere in `text` (order-free), so "文件夹 文件名" finds a note by its
/// folder and name together. Score is the sum of the per-term scores.
pub fn fuzzy_match_terms(query: &str, text: &str) -> Option<FuzzyResult> {
    let terms: Vec<&str> = query.split_whitespace().collect();
    if terms.is_empty() {
        return Some(FuzzyResult { score: 0.0, positions: Vec::new() });
    }
    let mut score = 0.0;
    let mut positions: Vec<usize> = Vec::new();
    for term in terms {
        let res = fuzzy_match(term, text)?;
        score += res.score;
        positions.extend(res.positions);
    }
    Some(FuzzyResult { score, positions })
}

/// One ranked hit: the item's index into the input slice plus match positions.
pub struct FuzzyHit {
    pub index: usize,
    pub positions: Vec<usize>,
}

/// Port of `src/lib/fuzzy.ts::fuzzySort` — filters `items` by
/// [`fuzzy_match_terms`] on `get_text(item)`, sorts by score desc with an
/// optional tiebreak (e.g. recent-open order) and caps at `limit`.
pub fn fuzzy_sort<T>(
    items: &[T],
    get_text: impl Fn(&T) -> String,
    query: &str,
    limit: usize,
    tiebreak: Option<&dyn Fn(&T, &T) -> std::cmp::Ordering>,
) -> Vec<FuzzyHit> {
    let mut out: Vec<(usize, FuzzyResult)> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if let Some(res) = fuzzy_match_terms(query, &get_text(item)) {
            out.push((i, res));
        }
    }
    out.sort_by(|a, b| {
        b.1.score
            .partial_cmp(&a.1.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| match tiebreak {
                Some(f) => f(&items[a.0], &items[b.0]),
                None => std::cmp::Ordering::Equal,
            })
    });
    out.into_iter()
        .take(limit)
        .map(|(index, res)| FuzzyHit { index, positions: res.positions })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_matches_everything_with_zero_score() {
        let r = fuzzy_match("", "anything").unwrap();
        assert_eq!(r.score, 0.0);
        assert!(r.positions.is_empty());
    }

    #[test]
    fn non_subsequence_returns_none() {
        assert!(fuzzy_match("zz", "hello").is_none());
        assert!(fuzzy_match_terms("a z", "hello").is_none());
    }

    #[test]
    fn case_insensitive_with_positions_and_consecutive_bonus() {
        // fuzzy_match("AB", "xabc"): matches at 1,2 → +5 consecutive,
        // -0.05*1 -0.05*2 earlier, -0.02*4 shorter-target.
        let r = fuzzy_match("AB", "xabc").unwrap();
        assert_eq!(r.positions, vec![1, 2]);
        assert!((r.score - (5.0 - 0.05 - 0.1 - 0.08)).abs() < 1e-9);
    }

    #[test]
    fn boundary_bonus_after_separator() {
        // "a/b-f": first 'f' at 4, right after '-' → +8, -0.2 earlier, -0.1.
        let r = fuzzy_match("f", "a/b-f").unwrap();
        assert_eq!(r.positions, vec![4]);
        assert!((r.score - (8.0 - 0.2 - 0.1)).abs() < 1e-9);
    }

    #[test]
    fn and_match_requires_every_term() {
        let r = fuzzy_match_terms("fold name", "fold/some name.md").unwrap();
        assert!(r.score > 0.0);
        assert_eq!(r.positions.len(), 8);
        assert!(fuzzy_match_terms("fold zzz", "fold/some name.md").is_none());
    }

    #[test]
    fn fuzzy_sort_orders_by_score_then_limit() {
        let items = vec!["abc", "abcd", "zabcz"];
        let hits = fuzzy_sort(&items, |s| s.to_string(), "ab", 10, None);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].index, 0); // shorter target wins the tie
        assert_eq!(hits[2].index, 2);

        let capped = fuzzy_sort(&items, |s| s.to_string(), "ab", 2, None);
        assert_eq!(capped.len(), 2);
    }

    #[test]
    fn fuzzy_sort_tiebreak_prefers_earlier_recency_rank() {
        // Identical scores ("x/abc" vs "y/abc" both match "ab" at 2,3) so the
        // tiebreak alone decides.
        let items = vec!["x/abc", "y/abc"];
        // Recency order: item 1 before item 0.
        let rank: Vec<usize> = vec![1, 0];
        let hits = fuzzy_sort(
            &items,
            |s| s.to_string(),
            "ab",
            10,
            Some(&|a, b| {
                let ra = items.iter().position(|i| std::ptr::eq(*i, *a)).unwrap();
                let rb = items.iter().position(|i| std::ptr::eq(*i, *b)).unwrap();
                rank[ra].cmp(&rank[rb])
            }),
        );
        assert_eq!(hits[0].index, 1);
        assert_eq!(hits[1].index, 0);
    }
}
