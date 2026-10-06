//! Port of `src/lib/switcher.ts` — quick-switcher result ranking,
//! Obsidian-style.
//!
//! Paths are vault-relative POSIX strings; offsets do not appear here except
//! in `positions` (char indices into the matched text, see
//! [`crate::markdown::fuzzy`]).
//!
//! 1. Notes whose own name matches the query (recency as tiebreak) — a note
//!    named like the query always outranks a folder's contents.
//! 2. Folders whose path matches the query contribute their (recursive)
//!    contents, each folder's files ordered by open recency — typing a folder
//!    name becomes a way to jump into it.
//! 3. Everything else that matches the full path (multi-term "folder name"
//!    queries that no single folder satisfied).
//!
//! Sections are deduplicated top-down and capped at `limit` overall.
//! `exclude_abs` (absolute path) drops one file from the empty-query jump
//! list — the current note: switching to it is meaningless, the list starts
//! at the previously opened file instead.

use super::fuzzy::{fuzzy_match_terms, fuzzy_sort};
use std::cmp::Ordering;

/// Port of `src/lib/path.ts::joinPath` — POSIX join with slash cleanup.
fn join_path(base: &str, rel: &str) -> String {
    if base.is_empty() {
        return rel.to_string();
    }
    format!("{}/{}", base.trim_end_matches('/'), rel.trim_start_matches('/'))
}

/// `/\.(md|markdown|txt)$/i` — note extensions stripped before matching.
fn strip_ext(f: &str) -> &str {
    let lower = f.to_ascii_lowercase();
    for ext in [".md", ".markdown", ".txt"] {
        if lower.ends_with(ext) {
            return &f[..f.len() - ext.len()];
        }
    }
    f
}

/// One switcher row: the vault-relative file path plus match positions
/// (empty outside the basename/full-path sections).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitcherHit {
    pub item: String,
    pub positions: Vec<usize>,
}

/// Port of `src/lib/switcher.ts::buildSwitcherResults`.
pub fn build_switcher_results(
    flat_files: &[String],
    recent_files: &[String],
    vault_path: Option<&str>,
    query: &str,
    exclude_abs: Option<&str>,
    limit: usize,
) -> Vec<SwitcherHit> {
    // Recency rank: absolute stored paths → per-vault relative rank. Files
    // never opened rank after everything that was.
    let rank: std::collections::HashMap<&str, usize> = recent_files
        .iter()
        .enumerate()
        .map(|(i, p)| (p.as_str(), i))
        .collect();
    let rank_of = |rel: &str| -> usize {
        vault_path
            .and_then(|vp| rank.get(join_path(vp, rel).as_str()))
            .copied()
            .unwrap_or(usize::MAX)
    };
    let q = query.trim();

    if q.is_empty() {
        // Empty query = jump list: most recently opened first (Obsidian-style),
        // minus the note that is already open.
        let mut files: Vec<&String> = flat_files
            .iter()
            .filter(|f| {
                exclude_abs.is_none()
                    || vault_path.is_none()
                    || &join_path(vault_path.unwrap(), f) != exclude_abs.unwrap()
            })
            .collect();
        files.sort_by_key(|f| rank_of(f));
        return files
            .into_iter()
            .map(|item| SwitcherHit { item: item.clone(), positions: Vec::new() })
            .collect();
    }

    let mut out: Vec<SwitcherHit> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let recency = |a: &String, b: &String| rank_of(a).cmp(&rank_of(b));

    // 1) Basename matches.
    let name_hits = fuzzy_sort(
        flat_files,
        |f| {
            strip_ext(f)
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string()
        },
        q,
        limit,
        Some(&recency),
    );
    for hit in name_hits {
        seen.insert(flat_files[hit.index].clone());
        out.push(SwitcherHit { item: flat_files[hit.index].clone(), positions: hit.positions });
    }

    // 2) Folder matches → contents by open recency. Ancestor folders absorb
    //    their descendants, so a matched "a" skips the also-matched "a/b".
    let mut folders: Vec<String> = Vec::new();
    for f in flat_files {
        let segs: Vec<&str> = f.split('/').collect();
        for i in 1..segs.len() {
            let folder = segs[..i].join("/");
            if !folders.contains(&folder) {
                folders.push(folder);
            }
        }
    }
    let mut folder_hits: Vec<(String, f64)> = folders
        .into_iter()
        .filter_map(|folder| {
            fuzzy_match_terms(q, &folder).map(|res| (folder, res.score))
        })
        .collect();
    // score desc, then folder name asc (localeCompare ≈ byte order for paths).
    folder_hits.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut covered_folders: Vec<String> = Vec::new();
    for (folder, _) in &folder_hits {
        if covered_folders.iter().any(|c| folder.starts_with(&format!("{c}/"))) {
            continue;
        }
        covered_folders.push(folder.clone());
        let mut kids: Vec<&String> = flat_files
            .iter()
            .filter(|f| f.starts_with(&format!("{folder}/")) && !seen.contains(*f))
            .collect();
        kids.sort_by(|a, b| recency(a, b));
        for kid in kids {
            seen.insert(kid.clone());
            out.push(SwitcherHit { item: kid.clone(), positions: Vec::new() });
        }
    }

    // 3) Full-path matches not covered above.
    for hit in fuzzy_sort(flat_files, |f| strip_ext(f).to_string(), q, limit, Some(&recency)) {
        if out.len() >= limit {
            break;
        }
        let item = &flat_files[hit.index];
        if seen.contains(item) {
            continue;
        }
        seen.insert(item.clone());
        out.push(SwitcherHit { item: item.clone(), positions: hit.positions });
    }

    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_query_is_mru_jump_list_without_the_open_note() {
        let flat = files(&["a.md", "b.md", "c.md"]);
        let recent = files(&["/v/c.md", "/v/a.md"]);
        let hits = build_switcher_results(&flat, &recent, Some("/v"), "", Some("/v/c.md"), 50);
        // c.md excluded (open), a.md before b.md (opened once vs never).
        let items: Vec<&str> = hits.iter().map(|h| h.item.as_str()).collect();
        assert_eq!(items, ["a.md", "b.md"]);
    }

    #[test]
    fn basename_matches_come_first_with_positions() {
        // Equal basename scores keep input order (stable sort, like the TS).
        let flat = files(&["alpha.md", "proj/alpha.md"]);
        let hits = build_switcher_results(&flat, &[], None, "alpha", None, 50);
        assert_eq!(hits[0].item, "alpha.md");
        assert_eq!(hits[0].positions, vec![0, 1, 2, 3, 4]);
        assert_eq!(hits[1].item, "proj/alpha.md");
        assert_eq!(hits[1].positions, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn basename_tiebreak_prefers_recency() {
        let flat = files(&["alpha.md", "proj/alpha.md"]);
        let recent = files(&["/v/proj/alpha.md"]);
        let hits = build_switcher_results(&flat, &recent, Some("/v"), "alpha", None, 50);
        assert_eq!(hits[0].item, "proj/alpha.md"); // opened once → first
        assert_eq!(hits[1].item, "alpha.md");
    }

    #[test]
    fn folder_query_pulls_in_contents_by_recency() {
        let flat = files(&["proj/b.md", "other/x.md", "proj/a.md", "proj.md"]);
        let recent = files(&["/v/proj/a.md", "/v/proj/b.md"]);
        let hits = build_switcher_results(&flat, &recent, Some("/v"), "proj", None, 50);
        let items: Vec<&str> = hits.iter().map(|h| h.item.as_str()).collect();
        // 1) basename hit "proj.md"; 2) folder "proj" → a.md, b.md by recency.
        // "other/x.md" matches no section of the query and is absent.
        assert_eq!(items, ["proj.md", "proj/a.md", "proj/b.md"]);
        // Folder-derived rows carry no positions.
        assert!(hits[1].positions.is_empty());
    }

    #[test]
    fn ancestor_folder_absorbs_descendant_folder_hits() {
        let flat = files(&["a/b/c.md"]);
        let hits = build_switcher_results(&flat, &[], None, "a", None, 50);
        // Folders "a" and "a/b" both match; only "a" contributes (absorbed).
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item, "a/b/c.md");
    }

    #[test]
    fn multi_term_query_falls_through_to_full_path() {
        let flat = files(&["docs/notes/todo.md"]);
        let hits = build_switcher_results(&flat, &[], None, "docs todo", None, 50);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item, "docs/notes/todo.md");
        assert!(!hits[0].positions.is_empty());
    }

    #[test]
    fn non_matching_files_are_dropped() {
        let flat = files(&["a.md", "zzz.md"]);
        let hits = build_switcher_results(&flat, &[], None, "a", None, 50);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item, "a.md");
    }

    #[test]
    fn limit_caps_the_result_list() {
        let flat = files(&["a1.md", "a2.md", "a3.md", "a4.md"]);
        let hits = build_switcher_results(&flat, &[], None, "a", None, 2);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn strip_ext_handles_case_insensitive_note_extensions() {
        assert_eq!(strip_ext("A.MD"), "A");
        assert_eq!(strip_ext("n.Markdown"), "n");
        assert_eq!(strip_ext("n.txt"), "n");
        assert_eq!(strip_ext("n.txt.bak"), "n.txt.bak");
    }
}
