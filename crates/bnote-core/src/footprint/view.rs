//! Pure view model for the footprint zone: assemble index entries into
//! "zone → group (source file) → blocks" render data, plus fold-state as
//! pure data operations. Port of `bnote/src/footprint/view.ts` (with
//! `sourceLabel` from `daily/marks.ts`). No DOM — `widget.ts` (the renderer)
//! and the CM extension are not ported: they are CodeMirror-coupled.

use crate::footprint::model::FootprintEntry;

/// Source note name (directory and `.md` stripped), used in daily-side
/// labels and hints. Port of `daily/marks.ts::sourceLabel`.
pub fn source_label(src_path: &str) -> &str {
    let after_slash = match src_path.rfind('/') {
        Some(i) => &src_path[i + 1..],
        None => src_path,
    };
    after_slash.strip_suffix(".md").unwrap_or(after_slash)
}

/// One rendered group (per source file). Port of
/// `footprint/view.ts::FootprintGroupView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FootprintGroupView {
    /// Source file absolute path (for jump-on-click).
    pub path: String,
    /// Source note name (directory and .md stripped), shown in the header.
    pub label: String,
    pub blocks: Vec<crate::footprint::model::FootprintBlock>,
}

/// Port of `footprint/view.ts::FootprintView`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FootprintView {
    pub groups: Vec<FootprintGroupView>,
    pub file_count: usize,
    pub block_count: usize,
}

/// Port of `footprint/view.ts::buildFootprintView`.
pub fn build_footprint_view(entries: &[FootprintEntry]) -> FootprintView {
    let groups: Vec<FootprintGroupView> = entries
        .iter()
        .map(|e| FootprintGroupView {
            path: e.path.clone(),
            label: source_label(&e.path).to_string(),
            blocks: e.blocks.clone(),
        })
        .collect();
    let block_count = groups.iter().map(|g| g.blocks.len()).sum();
    FootprintView { file_count: groups.len(), block_count, groups }
}

// ---------------------------------------------------------------- 折叠状态

/// Fold state is session-local UI state: never persisted — every open of the
/// daily starts fully expanded. Port of `footprint/view.ts::FoldState`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FoldState {
    /// The whole footprint zone collapsed (only the zone header remains).
    pub zone_collapsed: bool,
    /// Collapsed groups (source file absolute paths).
    pub groups: std::collections::BTreeSet<String>,
}

/// Port of `footprint/view.ts::defaultFold`.
pub fn default_fold() -> FoldState {
    FoldState::default()
}

/// Port of `footprint/view.ts::toggleZone`.
pub fn toggle_zone(state: &FoldState) -> FoldState {
    FoldState { zone_collapsed: !state.zone_collapsed, groups: state.groups.clone() }
}

/// Port of `footprint/view.ts::toggleGroup`.
pub fn toggle_group(state: &FoldState, path: &str) -> FoldState {
    let mut groups = state.groups.clone();
    if !groups.remove(path) {
        groups.insert(path.to_string());
    }
    FoldState { zone_collapsed: state.zone_collapsed, groups }
}

/// Signature of the fold state: used by widget eq and zone-rebuild checks.
/// Port of `footprint/view.ts::foldSig` (groups sorted, `;`-joined).
pub fn fold_sig(state: &FoldState) -> String {
    if state.zone_collapsed {
        "z".to_string()
    } else {
        format!("Z{}", state.groups.iter().cloned().collect::<Vec<_>>().join(";"))
    }
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::footprint::model::FootprintBlock;
    use crate::footprint::model::FootprintEntry;

    fn block(text: &str, start: usize) -> FootprintBlock {
        FootprintBlock { text: text.into(), start, end: start }
    }

    fn entries() -> Vec<FootprintEntry> {
        vec![
            FootprintEntry {
                path: "/vault/Job/job todo.md".into(),
                blocks: vec![block("甲", 1), block("乙", 3)],
            },
            FootprintEntry {
                path: "/vault/研究/文献笔记.md".into(),
                blocks: vec![block("丙", 2)],
            },
        ]
    }

    // ---- buildFootprintView (view.test.ts)

    #[test]
    fn groups_by_source_file_with_labels_and_counts() {
        let view = build_footprint_view(&entries());
        assert_eq!(view.file_count, 2);
        assert_eq!(view.block_count, 3);
        assert_eq!(view.groups[0].label, "job todo");
        assert_eq!(view.groups[1].label, "文献笔记");
        assert_eq!(view.groups[0].blocks.len(), 2);
    }

    #[test]
    fn empty_index_is_zero_counts_no_groups() {
        let view = build_footprint_view(&[]);
        assert_eq!(view, FootprintView { groups: Vec::new(), file_count: 0, block_count: 0 });
    }

    #[test]
    fn label_strips_directory_and_extension() {
        let view = build_footprint_view(&[FootprintEntry {
            path: "/vault/readme.md".into(),
            blocks: Vec::new(),
        }]);
        assert_eq!(view.groups[0].label, "readme");
    }

    #[test]
    fn source_label_edges() {
        assert_eq!(source_label("/v/Job/job todo.md"), "job todo");
        assert_eq!(source_label("/v/a/b/c.md"), "c");
    }

    // ---- 折叠状态 (view.test.ts)

    #[test]
    fn default_fully_expanded_signature_distinguishes_zone_collapse() {
        let d = default_fold();
        assert!(!d.zone_collapsed);
        assert!(d.groups.is_empty());
        assert_eq!(fold_sig(&d), "Z");
        assert_eq!(fold_sig(&toggle_zone(&d)), "z");
    }

    #[test]
    fn toggle_zone_flips_zone_only_keeps_groups() {
        let s = toggle_group(&default_fold(), "/vault/a.md");
        let z = toggle_zone(&s);
        assert!(z.zone_collapsed);
        assert!(z.groups.contains("/vault/a.md"));
        assert!(!toggle_zone(&z).zone_collapsed);
    }

    #[test]
    fn toggle_group_flips_single_group_signature_follows() {
        let s = toggle_group(&default_fold(), "/vault/a.md");
        assert!(s.groups.contains("/vault/a.md"));
        assert_eq!(fold_sig(&s), fold_sig(&toggle_group(&default_fold(), "/vault/a.md")));
        let s = toggle_group(&s, "/vault/a.md");
        assert!(s.groups.is_empty());
        assert_eq!(fold_sig(&s), "Z");
    }

    #[test]
    fn signature_is_order_independent_set_semantics() {
        let a = toggle_group(&toggle_group(&default_fold(), "/x.md"), "/y.md");
        let b = toggle_group(&toggle_group(&default_fold(), "/y.md"), "/x.md");
        assert_eq!(fold_sig(&a), fold_sig(&b));
        assert_eq!(fold_sig(&a), "Z/x.md;/y.md");
    }
}
