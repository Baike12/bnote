//! Pure-text model for today's footprints: block splitting, block identity,
//! today's increment diff. Port of `bnote/src/footprint/model.ts`. All
//! functions eat strings only, no IO, no clock.
//!
//! Semantics: a file's footprint for today = blocks present in the current
//! text but not in today's baseline. A block is a run of consecutive lines
//! separated by blank lines; its identity is the block text (trailing
//! whitespace stripped per line, common leading whitespace stripped from the
//! whole block) — trailing-space churn and whole-block re-indenting produce
//! no false "new", changed content is a new block (shown as the new
//! version), deleted blocks are not shown.
//!
//! Todo blocks never enter footprints: todos have their own daily channel
//! (cross-file sync mirrored into the daily header). The same content on two
//! channels would show up twice in the daily, so blocks containing a todo
//! line belong to sync entirely — the `-footprint` filter is applied at the
//! diff exit.

use serde::{Deserialize, Serialize};

use crate::daily::model::{parse_list_line, ListLine};

/// One block: consecutive lines separated by blank lines. `start`/`end` are
/// 1-based line numbers into the containing text. Port of
/// `footprint/model.ts::FootprintBlock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FootprintBlock {
    /// The block's line text (without trailing newline).
    pub text: String,
    pub start: usize,
    pub end: usize,
}

/// View-model entry: a file plus its footprint blocks (what the store hands
/// to the view). Port of `footprint/view.ts::FootprintEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FootprintEntry {
    pub path: String,
    pub blocks: Vec<FootprintBlock>,
}

fn is_blank_line(text: &str) -> bool {
    text.trim().is_empty()
}

/// Whether the block contains a todo line (same judgement as the sync
/// engine: `parseListLine` + `isTodo`). Port of
/// `footprint/model.ts::blockHasTodo`.
pub fn block_has_todo(text: &str) -> bool {
    text.split('\n')
        .any(|l| parse_list_line(l).is_some_and(|p: ListLine<'_>| p.box_.is_some()))
}

/// Split a document into blank-line-separated blocks (1-based line ranges).
/// Leading/trailing blank lines and runs of blank lines never form blocks.
/// Port of `footprint/model.ts::blocksOf`.
pub fn blocks_of(text: &str) -> Vec<FootprintBlock> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    let mut start: Option<usize> = None; // current block start, 0-based
    for i in 0..=lines.len() {
        let blank = i == lines.len() || is_blank_line(lines[i]);
        if !blank && start.is_none() {
            start = Some(i);
        }
        if blank {
            if let Some(s) = start.take() {
                out.push(FootprintBlock {
                    text: lines[s..i].join("\n"),
                    start: s + 1,
                    end: i,
                });
            }
        }
    }
    out
}

/// Block identity text: strip trailing whitespace from every line, drop
/// leading/trailing empty lines, strip the common leading whitespace of all
/// non-empty lines. Re-indenting a whole list one level or removing trailing
/// spaces yields the same key; partial indent changes still count as content
/// changes. Port of `footprint/model.ts::blockKey`.
pub fn block_key(text: &str) -> String {
    let mut lines: Vec<&str> =
        text.split('\n').map(|l| l.trim_end_matches([' ', '\t'])).collect();
    while let Some(first) = lines.first() {
        if first.is_empty() {
            lines.remove(0);
        } else {
            break;
        }
    }
    while let Some(last) = lines.last() {
        if last.is_empty() {
            lines.pop();
        } else {
            break;
        }
    }
    let mut prefix: Option<String> = None;
    for l in &lines {
        if l.is_empty() {
            continue;
        }
        let ind: String = l.chars().take_while(|&c| c == ' ' || c == '\t').collect();
        prefix = Some(match prefix {
            None => ind,
            Some(p) => common_whitespace(&p, &ind),
        });
        if prefix.as_deref() == Some("") {
            break;
        }
    }
    match prefix {
        Some(p) if !p.is_empty() => lines
            .iter()
            .map(|l| if l.is_empty() { l.to_string() } else { l[p.len()..].to_string() })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => lines.join("\n"),
    }
}

/// Common prefix of two leading-whitespace runs (char by char: tabs and
/// spaces each count). Port of `footprint/model.ts::commonWhitespace`.
fn common_whitespace(a: &str, b: &str) -> String {
    let mut n = 0;
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    while n < ab.len() && n < bb.len() && ab[n] == bb[n] {
        n += 1;
    }
    a[..n].to_string()
}

/// Today's increment: blocks of the current text whose identity is not in
/// the baseline (with line numbers into the current text, for jumping).
/// `baseline = None` (missing baseline = file created today) makes every
/// block count as today's. Blocks containing todos are excluded at the exit.
/// Port of `footprint/model.ts::diffBlocks`.
pub fn diff_blocks(baseline: Option<&str>, current: &str) -> Vec<FootprintBlock> {
    let blocks: Vec<FootprintBlock> =
        blocks_of(current).into_iter().filter(|b| !block_has_todo(&b.text)).collect();
    let Some(baseline) = baseline else { return blocks };
    let known: std::collections::HashSet<String> =
        blocks_of(baseline).into_iter().map(|b| block_key(&b.text)).collect();
    if known.is_empty() {
        return blocks;
    }
    blocks.into_iter().filter(|b| !known.contains(&block_key(&b.text))).collect()
}

// ---------------------------------------------------------------- 路径与归属

/// Aggregate-eligible note files: `.md`/`.markdown`/`.txt` (case
/// insensitive), inside the vault, and not under `Daily/` (dailies do not
/// aggregate each other — no self-nesting). Port of
/// `footprint/model.ts::isAggregatePath`.
pub fn is_aggregate_path(path: &str, vault_root: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")) {
        return false;
    }
    let root = vault_root.trim_end_matches('/');
    let Some(rest) = path.strip_prefix(root) else { return false };
    if !rest.starts_with('/') {
        return false;
    }
    !rest.starts_with("/Daily/")
}

// ---------------------------------------------------------------- 持久化形状

/// v1 (legacy): a single "today baseline" only, invalidated by the day
/// rotation — historical dailies could not be aggregated. Port of
/// `footprint/model.ts::StoredFootprintsV1` (shape used for parsing).
#[derive(Debug, Serialize, Deserialize)]
pub struct StoredFootprintsV1 {
    pub version: u32,
    pub day: String,
    pub baselines: std::collections::BTreeMap<String, String>,
}

/// v2: baselines plus the historical footprint archive.
/// `history[day][path]` = frozen snapshot of that day's new blocks —
/// diffed out of the old baseline at rotation time, read-only afterwards;
/// opening a historical daily aggregates from it. Daily files stay
/// zero-pollution: the mapping lives only in this one metadata file.
/// Port of `footprint/model.ts::StoredFootprints`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StoredFootprints {
    pub version: u32,
    /// Baseline's owning day (YYYY-MM-DD); different from today = rotation due.
    pub day: String,
    /// Today's baseline: absolute path → full text at day-switch time.
    pub baselines: std::collections::BTreeMap<String, String>,
    /// Historical archive: day → path → that day's footprint blocks.
    pub history: std::collections::BTreeMap<String, std::collections::BTreeMap<String, Vec<FootprintBlock>>>,
}

/// Baseline metadata file path (inside the vault, travels with the repo).
/// Port of `footprint/model.ts::footprintsFilePath`.
pub fn footprints_file_path(vault_root: &str) -> String {
    format!("{}/.bnote/daily-footprints.json", vault_root.trim_end_matches('/'))
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    // ---- blocksOf (model.test.ts)

    #[test]
    fn blank_line_separated_blocks_with_1based_line_numbers() {
        let text = "第一段\n第二段\n\n- 列表项\n- 另一项\n\n尾段";
        assert_eq!(
            blocks_of(text),
            vec![
                FootprintBlock { text: "第一段\n第二段".into(), start: 1, end: 2 },
                FootprintBlock { text: "- 列表项\n- 另一项".into(), start: 4, end: 5 },
                FootprintBlock { text: "尾段".into(), start: 7, end: 7 },
            ]
        );
    }

    #[test]
    fn leading_trailing_and_repeated_blank_lines_form_no_blocks() {
        let text = "\n\n\n正文\n\n\n\n尾\n\n";
        assert_eq!(
            blocks_of(text),
            vec![
                FootprintBlock { text: "正文".into(), start: 4, end: 4 },
                FootprintBlock { text: "尾".into(), start: 8, end: 8 },
            ]
        );
    }

    #[test]
    fn whitespace_only_lines_count_as_blank() {
        let text = "上 \n\t\n下";
        assert_eq!(
            blocks_of(text),
            vec![
                FootprintBlock { text: "上 ".into(), start: 1, end: 1 },
                FootprintBlock { text: "下".into(), start: 3, end: 3 },
            ]
        );
    }

    #[test]
    fn empty_doc_and_blank_only_doc_return_no_blocks() {
        assert_eq!(blocks_of(""), Vec::<FootprintBlock>::new());
        assert_eq!(blocks_of("\n\n\n"), Vec::<FootprintBlock>::new());
    }

    #[test]
    fn single_block_without_blank_lines() {
        assert_eq!(
            blocks_of("a\nb\nc"),
            vec![FootprintBlock { text: "a\nb\nc".into(), start: 1, end: 3 }]
        );
    }

    // ---- blockKey (model.test.ts)

    #[test]
    fn key_strips_trailing_ws_and_edge_empty_lines_keeps_partial_indent() {
        assert_eq!(block_key("  a  \nb\t\n"), "  a\nb");
        assert_eq!(block_key("a\nb"), block_key("  a\n  b")); // true whole-block indent normalized
    }

    #[test]
    fn partial_indent_change_is_content_change() {
        assert_ne!(block_key("a\n  b"), block_key("a\nb"));
    }

    // ---- diffBlocks (model.test.ts)

    #[test]
    fn diff_returns_blocks_missing_from_baseline_with_current_line_numbers() {
        let baseline = "旧内容\n\n共同段落";
        let current = "旧内容\n\n共同段落\n\n今天新写的\n第二行";
        assert_eq!(
            diff_blocks(Some(baseline), current),
            vec![FootprintBlock { text: "今天新写的\n第二行".into(), start: 5, end: 6 }]
        );
    }

    #[test]
    fn rewritten_paragraph_shows_new_version_whole_block() {
        let baseline = "昨天的版本 A";
        let current = "今天改写的版本 B";
        assert_eq!(
            diff_blocks(Some(baseline), current),
            vec![FootprintBlock { text: "今天改写的版本 B".into(), start: 1, end: 1 }]
        );
    }

    #[test]
    fn deleted_blocks_are_not_shown() {
        let baseline = "留着\n\n被删掉的";
        assert_eq!(diff_blocks(Some(baseline), "留着"), Vec::<FootprintBlock>::new());
    }

    #[test]
    fn moved_block_counts_once_by_identity() {
        let baseline = "甲\n\n乙\n\n丙";
        let current = "丙\n\n甲\n\n乙";
        assert_eq!(diff_blocks(Some(baseline), current), Vec::<FootprintBlock>::new());
    }

    #[test]
    fn missing_baseline_counts_every_block() {
        let current = "新文件第一段\n\n新文件第二段";
        assert_eq!(
            diff_blocks(None, current),
            vec![
                FootprintBlock { text: "新文件第一段".into(), start: 1, end: 1 },
                FootprintBlock { text: "新文件第二段".into(), start: 3, end: 3 },
            ]
        );
    }

    #[test]
    fn empty_baseline_counts_current_as_all_new() {
        assert_eq!(
            diff_blocks(Some(""), "只有一段"),
            vec![FootprintBlock { text: "只有一段".into(), start: 1, end: 1 }]
        );
    }

    #[test]
    fn trailing_space_churn_is_not_a_false_new() {
        assert_eq!(diff_blocks(Some("同一段落"), "同一段落  "), Vec::<FootprintBlock>::new());
    }

    #[test]
    fn whole_block_reindent_is_not_a_false_new() {
        let baseline = "- 项 A\n  - 子项";
        assert_eq!(diff_blocks(Some(baseline), "  - 项 A\n    - 子项"), Vec::<FootprintBlock>::new());
    }

    #[test]
    fn no_change_returns_empty() {
        let text = "甲\n\n乙\n\n丙";
        assert_eq!(diff_blocks(Some(text), text), Vec::<FootprintBlock>::new());
    }

    // ---- isAggregatePath (model.test.ts)

    #[test]
    fn md_markdown_txt_inside_vault_aggregate() {
        let root = "/vault";
        for p in ["/vault/note.md", "/vault/sub/x.MARKDOWN", "/vault/y.txt"] {
            assert!(is_aggregate_path(p, root), "{p}");
        }
    }

    #[test]
    fn daily_dir_outside_vault_and_other_extensions_do_not_aggregate() {
        let root = "/vault";
        assert!(!is_aggregate_path("/vault/Daily/2026-09-30.md", root));
        assert!(!is_aggregate_path("/vault/Daily/sub/a.md", root));
        assert!(!is_aggregate_path("/elsewhere/note.md", root));
        assert!(!is_aggregate_path("/vault/image.png", root));
        assert!(!is_aggregate_path("/vault/.bnote/config.json", root));
    }

    #[test]
    fn trailing_slash_on_root_does_not_change_verdict() {
        assert!(is_aggregate_path("/vault/note.md", "/vault/"));
        assert!(!is_aggregate_path("/vault/Daily/2026-09-30.md", "/vault/"));
    }

    // ---- diffBlocks × 待办排除 (model.test.ts)

    #[test]
    fn todo_blocks_excluded_entirely_any_checkbox_state() {
        let current = "普通段落\n\n- [ ] 待办\n  - 子内容\n\n- [x] 已完成\n\n- 普通列表不是待办";
        assert_eq!(
            diff_blocks(None, current),
            vec![
                FootprintBlock { text: "普通段落".into(), start: 1, end: 1 },
                FootprintBlock { text: "- 普通列表不是待办".into(), start: 8, end: 8 },
            ]
        );
    }

    #[test]
    fn ordered_todo_excluded_too() {
        assert_eq!(diff_blocks(None, "1. [ ] 有序待办"), Vec::<FootprintBlock>::new());
    }

    #[test]
    fn prose_and_todo_in_one_block_whole_block_excluded() {
        assert_eq!(diff_blocks(None, "一些文字\n- [ ] 待办"), Vec::<FootprintBlock>::new());
    }

    #[test]
    fn rewritten_todo_block_in_baseline_still_hidden() {
        let baseline = "- [ ] 旧待办";
        assert_eq!(diff_blocks(Some(baseline), "- [x] 旧待办 ✅ 2026-09-30"), Vec::<FootprintBlock>::new());
    }

    #[test]
    fn todo_line_shapes_same_as_sync_engine() {
        assert_eq!(diff_blocks(None, "* [ ] 星号待办\n+ [X] 加号待办"), Vec::<FootprintBlock>::new());
    }

    // ---- 持久化形状

    #[test]
    fn stored_footprints_v2_round_trip_keeps_camel_shape() {
        let stored = StoredFootprints {
            version: 2,
            day: "2026-09-30".into(),
            baselines: std::collections::BTreeMap::from([("/vault/n.md".into(), "文本".into())]),
            history: std::collections::BTreeMap::from([(
                "2026-09-29".into(),
                std::collections::BTreeMap::from([(
                    "/vault/n.md".into(),
                    vec![FootprintBlock { text: "块".into(), start: 3, end: 3 }],
                )]),
            )]),
        };
        let raw = serde_json::to_string(&stored).unwrap();
        assert!(raw.contains("\"version\":2"));
        assert!(raw.contains("\"day\":\"2026-09-30\""));
        assert!(raw.contains("\"baselines\":{"));
        assert!(raw.contains("\"history\":{"));
        let back: StoredFootprints = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.day, "2026-09-30");
        assert_eq!(back.history["2026-09-29"]["/vault/n.md"][0].text, "块");
    }

    #[test]
    fn v1_payload_parses_as_v1_struct_without_history() {
        let raw = r#"{"version":1,"day":"2026-09-30","baselines":{"/vault/n.md":"基线"}}"#;
        let v1: StoredFootprintsV1 = serde_json::from_str(raw).unwrap();
        assert_eq!(v1.baselines["/vault/n.md"], "基线");
        // The v2 struct accepts it too (history missing → store must default it).
        let loose: Result<StoredFootprints, _> = serde_json::from_str(raw);
        assert!(loose.is_err(), "history is not optional on the v2 struct; the store parses v1 through the guard instead");
    }
}
