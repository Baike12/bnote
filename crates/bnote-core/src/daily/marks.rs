//! Visual marks on todo lines that a daily link binds. Port of
//! `bnote/src/daily/marks.ts` (the pure predicate part).
//!
//! The semantics split by side, each side telling "the one thing worth
//! knowing right now":
//!
//! - **Source note** (a todo in a project note): mark the lines whose link
//!   points at **today's** daily — the ones ⌘⇧J considers already synced.
//!   Yesterday's sends no longer count, matching the send command's
//!   day-attribution rule; otherwise one line would carry marks for several
//!   days. `auto` links (existence itself aggregates) are not marked on the
//!   source side: under auto-sync every todo has a link and a mark on all of
//!   them stops being information.
//! - **Daily file** (any day): mark the lines whose link points at *this*
//!   daily, and carry the source note's name — the only clue that the entry
//!   was synced in rather than typed.
//!
//! The TS renders these as line decorations plus absolutely-positioned
//! pseudo-elements (never widgets), so list indent and wrap geometry stay
//! pixel-identical; the GPUI engine's line-style channel has the same shape.

use std::ops::Range;

use super::links::{DailyLink, LinkKind};
use super::model::{is_daily_path, parse_list_line, todo_text};

/// One marked line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyMark {
    /// 0-based buffer line.
    pub line: usize,
    /// Tooltip, matching the TS `title` attribute.
    pub title: String,
    /// Daily side: the source note's label, drawn at the line's right edge.
    /// `None` on the source side (the source *is* this note).
    pub source: Option<String>,
}

/// Source-note name (directory and `.md` stripped). Port of
/// `daily/marks.ts::sourceLabel`.
pub fn source_label(src_path: &str) -> &str {
    let after_slash = match src_path.rfind('/') {
        Some(i) => &src_path[i + 1..],
        None => src_path,
    };
    after_slash.strip_suffix(".md").unwrap_or(after_slash)
}

/// The title a source-side mark carries: `recorded` links say it was logged
/// on check-off, every other kind says it was sent.
fn source_title(kind: LinkKind) -> String {
    match kind {
        LinkKind::Recorded => "勾选完成时已记录到今日日记,两侧保持同步".to_string(),
        _ => "已发送到今日日记,两侧保持同步".to_string(),
    }
}

/// Build the marks for the visible lines of the open file.
///
/// `path` is the open file's **absolute** path (links store absolute paths),
/// `today_daily_path` the absolute path of today's daily. `lines` is the
/// visible line window (0-based, inclusive; `None` = no viewport yet, which
/// marks nothing — the TS empty-`visibleRanges` rule). Port of
/// `daily/marks.ts::buildDailyMarks`.
pub fn build_daily_marks(
    text: &str,
    lines: Option<Range<usize>>,
    path: &str,
    links: &[&DailyLink],
    today_daily_path: &str,
) -> Vec<DailyMark> {
    let Some(window) = lines else { return Vec::new() };
    let daily_side = is_daily_path(path);
    // Identity text → link, first link wins (the TS `byText` map).
    let mut by_text: Vec<(&str, &DailyLink)> = Vec::new();
    for l in links {
        let relevant = if daily_side {
            l.daily_path == path
        } else {
            l.kind != LinkKind::Auto && l.src_path == path && l.daily_path == today_daily_path
        };
        if relevant && !by_text.iter().any(|(t, _)| *t == l.text) {
            by_text.push((&l.text, l));
        }
    }
    if by_text.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    for (n, line) in text.split('\n').enumerate() {
        if n > window.end {
            break;
        }
        if n < window.start {
            continue;
        }
        let Some(parsed) = parse_list_line(line) else { continue };
        if parsed.box_.is_none() {
            continue;
        }
        let wanted = todo_text(&parsed);
        let Some((_, link)) = by_text.iter().find(|(t, _)| *t == wanted) else {
            continue;
        };
        out.push(if daily_side {
            let label = source_label(&link.src_path);
            DailyMark {
                line: n,
                title: format!("与《{label}》的待办同步中"),
                source: Some(label.to_string()),
            }
        } else {
            DailyMark { line: n, title: source_title(link.kind), source: None }
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: &str = "/v/Daily/2026-09-27.md";
    const SRC: &str = "/v/Job/job todo.md";

    fn link(id: &str, kind: LinkKind, src: &str, daily: &str, text: &str) -> DailyLink {
        DailyLink {
            id: id.into(),
            kind,
            day: "2026-09-27".into(),
            src_path: src.into(),
            daily_path: daily.into(),
            text: text.into(),
            src_line: 1,
            daily_line: 2,
        }
    }

    /// The whole document as the visible window.
    fn all_lines(text: &str) -> Option<Range<usize>> {
        let last = text.split('\n').count().saturating_sub(1);
        Some(0..last)
    }

    fn marks_of(text: &str, path: &str, links: &[DailyLink]) -> Vec<DailyMark> {
        let refs: Vec<&DailyLink> = links.iter().collect();
        build_daily_marks(text, all_lines(text), path, &refs, TODAY)
    }

    fn mark_lines(text: &str, path: &str, links: &[DailyLink]) -> Vec<usize> {
        marks_of(text, path, links).into_iter().map(|m| m.line).collect()
    }

    // ---- 待办链接的可视标识 (daily/marks.test.ts)

    #[test]
    fn source_side_marks_only_the_root_todo_line() {
        let text = "- [ ] cs336\n  - [ ] 第一个作业\n- [ ] bm25\n正文一行\n";
        let links = vec![link("l1", LinkKind::Copied, SRC, TODAY, "cs336")];
        let marks = marks_of(text, SRC, &links);
        assert_eq!(marks.iter().map(|m| m.line).collect::<Vec<_>>(), vec![0]);
        assert!(marks[0].source.is_none(), "the source side shows no label");
        assert!(marks[0].title.contains("今日日记"));
    }

    #[test]
    fn source_side_yesterdays_send_no_longer_marks() {
        let text = "- [ ] cs336\n";
        let links = vec![link("l1", LinkKind::Copied, SRC, "/v/Daily/2026-09-26.md", "cs336")];
        assert_eq!(mark_lines(text, SRC, &links), Vec::<usize>::new());
    }

    #[test]
    fn source_side_auto_links_do_not_mark() {
        let text = "- [ ] cs336\n";
        let links = vec![link("l1", LinkKind::Auto, SRC, TODAY, "cs336")];
        assert_eq!(mark_lines(text, SRC, &links), Vec::<usize>::new());
    }

    #[test]
    fn source_side_links_of_other_files_do_not_mark() {
        let text = "- [ ] cs336\n";
        let links = vec![link("l1", LinkKind::Copied, "/v/Anc/anc todo.md", TODAY, "cs336")];
        assert_eq!(mark_lines(text, SRC, &links), Vec::<usize>::new());
    }

    #[test]
    fn daily_side_marks_synced_entries_with_the_source_label() {
        let text = "# 2026-09-27\n- [ ] bm25\n- [ ] 自己记的一件事\n";
        let links = vec![link("l1", LinkKind::Copied, SRC, TODAY, "bm25")];
        let marks = marks_of(text, TODAY, &links);
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].line, 1, "handwritten entries stay unmarked");
        assert_eq!(marks[0].source.as_deref(), Some("job todo"));
        assert!(marks[0].title.contains("job todo"));
    }

    #[test]
    fn daily_side_a_past_daily_marks_links_pointing_at_it() {
        let past = "/v/Daily/2026-09-23.md";
        let text = "# 2026-09-23\n- [ ] anc-ke\n";
        let links = vec![link("l1", LinkKind::Copied, "/v/Anc/anc todo.md", past, "anc-ke")];
        assert_eq!(mark_lines(text, past, &links), vec![1]);
    }

    #[test]
    fn recorded_links_say_logged_on_check_off() {
        let text = "- [x] cs336 ✅ 2026-09-27\n";
        let links = vec![link("l1", LinkKind::Recorded, SRC, TODAY, "cs336")];
        assert!(marks_of(text, SRC, &links)[0].title.contains("勾选完成"));
    }

    #[test]
    fn only_the_visible_lines_and_an_empty_window_yields_nothing() {
        let text = &(0..40).map(|i| format!("- [ ] t{i}\n")).collect::<String>();
        let links = vec![
            link("l1", LinkKind::Copied, SRC, TODAY, "t0"),
            link("l2", LinkKind::Copied, SRC, TODAY, "t30"),
        ];
        assert_eq!(mark_lines(text, SRC, &links), vec![0, 30]);
        // A window covering only line 31 (1-based) sees only t30.
        let refs: Vec<&DailyLink> = links.iter().collect();
        let windowed = build_daily_marks(text, Some(30..30), SRC, &refs, TODAY);
        assert_eq!(windowed.iter().map(|m| m.line).collect::<Vec<_>>(), vec![30]);
        // No viewport at all (the TS empty `visibleRanges`): nothing marks.
        assert!(build_daily_marks(text, None, SRC, &refs, TODAY).is_empty());
    }

    #[test]
    fn identity_text_strips_the_checkbox_and_the_done_stamp() {
        let text = "- [x] 接入4a登录 ✅ 2026-09-23\n";
        let links = vec![link("l1", LinkKind::Copied, SRC, TODAY, "接入4a登录")];
        assert_eq!(mark_lines(text, SRC, &links), vec![0]);
    }

    #[test]
    fn source_label_strips_directory_and_extension() {
        assert_eq!(source_label("/v/Job/job todo.md"), "job todo");
        assert_eq!(source_label("/v/a/b/c.md"), "c");
    }
}
