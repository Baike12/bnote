//! End-to-end rule tests: the ported oracle cases from
//! `livePreview.activity.test.ts`, one focused test per rule, and the
//! invariant sweep over a mixed document.

use std::ops::Range;

use crate::preview::{
    BlockKind, ListGeometry, ListMarkerKind, PanelKind, PreviewPanel, PreviewSnapshot,
    PreviewSpanKind, ScanInput, SpanStyle, Widget,
};

use super::scan;

/// Full-document window (the tests never exercise clipping except where they
/// say so).
const ALL: Range<usize> = 0..usize::MAX;

/// The document slices carrying `style`, in order — the visible outcome of a
/// mark.
fn styled<'a>(snap: &'a PreviewSnapshot, text: &'a str, style: SpanStyle) -> Vec<&'a str> {
    snap.styles
        .iter()
        .filter(|span| span.style == style)
        .map(|span| &text[span.range.clone()])
        .collect()
}

fn snapshot(text: &str, carets: &[usize]) -> PreviewSnapshot {
    snapshot_visible(text, carets, ALL)
}

fn snapshot_visible(text: &str, carets: &[usize], visible: Range<usize>) -> PreviewSnapshot {
    let selections: Vec<Range<usize>> = carets.iter().map(|p| *p..*p).collect();
    scan(ScanInput {
        text,
        selections: &selections,
        visible,
        math_preview: true,
    })
}

fn at(text: &str, needle: &str) -> usize {
    text.find(needle).expect("fixture needle must exist")
}

fn hides(snap: &PreviewSnapshot, from: usize, to: usize) -> bool {
    snap.spans
        .iter()
        .any(|s| s.range.start == from && s.range.end == to && s.kind == PreviewSpanKind::Hidden)
}

fn has_widget(snap: &PreviewSnapshot, pred: impl Fn(&Widget) -> bool) -> bool {
    snap.spans
        .iter()
        .any(|s| matches!(&s.kind, PreviewSpanKind::Widget(w) if pred(w)))
}

/// A widget of `pred`'s kind overlapping `[from, to)` (document-wide checks
/// would also match a sibling line's widget).
fn widget_in(
    snap: &PreviewSnapshot,
    from: usize,
    to: usize,
    pred: impl Fn(&Widget) -> bool,
) -> bool {
    snap.spans.iter().any(|s| {
        s.range.start < to
            && s.range.end > from
            && matches!(&s.kind, PreviewSpanKind::Widget(w) if pred(w))
    })
}

fn bullet(snap: &PreviewSnapshot) -> bool {
    has_widget(snap, |w| *w == Widget::Bullet)
}

fn checkbox(snap: &PreviewSnapshot) -> bool {
    has_widget(snap, |w| matches!(w, Widget::Checkbox { .. }))
}

fn is_checkbox(w: &Widget) -> bool {
    matches!(w, Widget::Checkbox { .. })
}

fn is_bullet(w: &Widget) -> bool {
    *w == Widget::Bullet
}

/// Any span covering the byte position `pos` (the caret's landing spot).
fn covered(snap: &PreviewSnapshot, pos: usize) -> bool {
    snap.spans
        .iter()
        .any(|s| s.range.start <= pos && pos < s.range.end)
}

/// The model invariants: spans sorted and disjoint, every range on a char
/// boundary and inside one line, blocks sorted and disjoint.
fn assert_invariants(text: &str, snap: &PreviewSnapshot) {
    let mut prev_end = 0usize;
    for s in &snap.spans {
        assert!(
            s.range.start >= prev_end,
            "spans overlap or are unsorted: {s:?} after end {prev_end}"
        );
        assert!(s.range.start < s.range.end, "empty span: {s:?}");
        assert!(
            text.is_char_boundary(s.range.start) && text.is_char_boundary(s.range.end),
            "span off a char boundary: {s:?}"
        );
        assert!(
            !text[s.range.clone()].contains('\n'),
            "span crosses a line break: {s:?}"
        );
        prev_end = s.range.end;
    }
    let mut prev_last: Option<usize> = None;
    for b in &snap.blocks {
        match b.last_line {
            Some(last) => {
                assert!(b.first_line <= last, "inverted block: {b:?}");
                if let Some(prev) = prev_last {
                    assert!(
                        b.first_line > prev,
                        "blocks overlap or are unsorted: {b:?} after {prev}"
                    );
                }
                prev_last = Some(last);
            }
            // An insertion sits *between* lines: it may only touch the boundary
            // after the previous replacement.
            None => assert!(
                prev_last.is_none_or(|prev| b.first_line > prev),
                "insertion overlaps the previous block: {b:?}"
            ),
        }
    }
    let mut prev_panel_first: Option<usize> = None;
    for p in &snap.panels {
        assert!(p.first_line <= p.last_line, "inverted panel: {p:?}");
        if let Some(prev) = prev_panel_first {
            assert!(
                p.first_line >= prev,
                "panels unsorted: {p:?} after {prev}"
            );
        }
        prev_panel_first = Some(p.first_line);
    }
}

/// No block may cover the line holding `pos` (the caret line stays editable).
fn assert_no_block_on_line(text: &str, snap: &PreviewSnapshot, pos: usize) {
    let lines = crate::markdown::line_ranges(text);
    let n = lines
        .iter()
        .position(|(from, to)| pos >= *from && pos <= *to)
        .unwrap_or(0);
    for b in &snap.blocks {
        match b.last_line {
            Some(last) => assert!(
                n < b.first_line || n > last,
                "block {b:?} covers caret line {n}"
            ),
            // An insertion does not cover a line: it only adds height.
            None => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Ported from livePreview.activity.test.ts
// ---------------------------------------------------------------------------

const DOC: &str =
    "- [ ] task item\n- [x] done item\n- bullet item\n  - nested item\n1. ordered item";

/// "光标在正文上（标记范围外）：任务行保持渲染态（checkbox + 隐藏 `- `）"
#[test]
fn task_line_renders_while_caret_is_in_the_text() {
    let caret = at(DOC, "task item") + 3;
    let snap = snapshot(DOC, &[caret]);
    assert!(checkbox(&snap));
    assert!(hides(&snap, 0, 2), "`- ` hidden: {:?}", snap.spans);
}

/// "光标在 `[ ]` 内：checkbox 翻回源码，`- ` 仍隐藏"
#[test]
fn task_checkbox_returns_to_source_under_the_caret() {
    let task = at(DOC, "[ ]");
    let snap = snapshot(DOC, &[task + 1]);
    assert!(!widget_in(&snap, task, task + 3, is_checkbox));
    assert!(hides(&snap, 0, 2));
}

/// "光标在行首：`-` 翻回源码，checkbox 保持渲染态"
#[test]
fn dash_returns_to_source_at_line_start_checkbox_stays() {
    let snap = snapshot(DOC, &[0]);
    assert!(checkbox(&snap));
    assert!(!snap
        .spans
        .iter()
        .any(|s| s.range.start < 2 && s.range.end > 0));
}

/// "无序列表：光标在标记外渲染 bullet，压在 `-` 上翻回源码"
#[test]
fn bullet_renders_off_marker_and_returns_to_source_on_it() {
    let line_from = at(DOC, "- bullet item");
    let line_to = line_from + "- bullet item".len();
    let rendered = snapshot(DOC, &[line_from + 5]);
    assert!(widget_in(&rendered, line_from, line_to, is_bullet));
    let active = snapshot(DOC, &[line_from]);
    assert!(!widget_in(&active, line_from, line_to, is_bullet));
}

/// "嵌套项：前导缩进空格在活动行也被隐藏（布局不随光标位移的另一半）"
#[test]
fn nested_indent_is_hidden_even_on_the_active_line() {
    let line_from = at(DOC, "  - nested item");
    let snap = snapshot(DOC, &[line_from + 6]);
    assert!(hides(&snap, line_from, line_from + 2), "{:?}", snap.spans);
}

/// "有序列表：数字标记两种状态下都保留原文（无几何翻转）"
#[test]
fn ordered_markers_never_get_a_span() {
    let ordered = at(DOC, "1. ordered item");
    for caret in [ordered, ordered + 4, ordered + 6] {
        let snap = snapshot(DOC, &[caret]);
        assert!(
            !snap
                .spans
                .iter()
                .any(|s| s.range.start < ordered + 2 && s.range.end > ordered),
            "ordered marker geometry must be stable: {:?}",
            snap.spans
        );
    }
}

// ---------------------------------------------------------------------------
// Ported from "空列表项的文本锚点（keepMarkerTrailingSpace）"
// ---------------------------------------------------------------------------

#[test]
fn empty_task_keeps_the_trailing_space_under_a_caret_at_the_item_start() {
    let snap = snapshot("- [ ] ", &[6]);
    assert!(checkbox(&snap));
    assert!(covered(&snap, 4));
    assert!(
        !covered(&snap, 5),
        "trailing space stays visible: {:?}",
        snap.spans
    );
}

#[test]
fn empty_task_at_line_start_swallows_the_space() {
    let snap = snapshot("- [ ] ", &[0]);
    assert!(covered(&snap, 5));
}

#[test]
fn non_empty_task_swallows_the_space_even_at_the_item_start() {
    let snap = snapshot("- [ ] foo", &[6]);
    assert!(checkbox(&snap));
    assert!(covered(&snap, 5));
}

/// Every list line reports its hanging-indent geometry: the source
/// indentation in two-space levels (capped at 16) and the marker kind that
/// picks the slot width.
#[test]
fn list_lines_report_their_hanging_geometry() {
    let doc = "- bullet\n  - nested\n1. ordered\n- [ ] task\n        - deep\n\nplain";
    let snap = snapshot(doc, &[]);

    let geometry: Vec<(usize, u8, ListMarkerKind)> = snap
        .lists
        .iter()
        .map(|g| (g.line, g.level, g.marker))
        .collect();
    assert_eq!(
        geometry,
        vec![
            (0, 0, ListMarkerKind::Bullet),
            (1, 1, ListMarkerKind::Bullet),
            (2, 0, ListMarkerKind::Ordered),
            (3, 0, ListMarkerKind::Task),
            (4, 4, ListMarkerKind::Bullet),
        ],
        "top level 0, each two spaces one level"
    );

    // The geometry is caret-independent (the TS line class is too): an
    // active line keeps its entry.
    let active = snapshot(doc, &[at(doc, "- bullet")]);
    assert_eq!(
        active.lists.iter().map(|g| g.line).collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4]
    );

    // The window clips it like every per-line emission.
    let first_line_only = snapshot_visible(doc, &[], 0..1);
    assert_eq!(
        first_line_only
            .lists
            .iter()
            .map(|g| g.line)
            .collect::<Vec<_>>(),
        vec![0]
    );
}

/// The em constants match `global.css` (the geometry is a CSS fact, not a
/// choice) and the helpers compose them the way the classes do.
#[test]
fn list_geometry_constants_match_the_style_sheet() {
    use crate::preview::{LI_BASE_EM, LI_GAP_EM, LI_STEP_EM, li_hang_em, li_px_em};
    assert_eq!(LI_BASE_EM, 0.8125);
    assert_eq!(LI_STEP_EM, 1.75);
    assert_eq!(LI_GAP_EM, 0.5);
    assert_eq!(li_px_em(0), 0.8125);
    assert_eq!(li_px_em(3), 0.8125 + 3.0 * 1.75);
    assert_eq!(li_hang_em(ListMarkerKind::Bullet), Some(0.95));
    assert_eq!(li_hang_em(ListMarkerKind::Task), Some(1.4));
    assert_eq!(li_hang_em(ListMarkerKind::Ordered), None);
}

#[test]
fn empty_bullet_keeps_the_trailing_space_under_a_caret_at_the_item_start() {
    let snap = snapshot("- ", &[2]);
    assert!(bullet(&snap));
    assert!(!covered(&snap, 1), "{:?}", snap.spans);
}

// ---------------------------------------------------------------------------
// Ported from "段落后空 bullet 行的 setext 歧义（decorateSetextDash）"
// ---------------------------------------------------------------------------

const SETEXT_DOC: &str = "段落行在此。\n- \n";

fn setext_dash_from() -> usize {
    SETEXT_DOC.find("\n- ").expect("fixture") + 1
}

/// "树里是 SetextHeading2 时仍渲染 bullet（立即可见）" + "空项光标在行尾：
/// 尾随空格保留作文本锚点"
#[test]
fn setext_ambiguous_dash_renders_as_empty_bullet_with_trailing_space_kept() {
    let dash = setext_dash_from();
    let snap = snapshot(SETEXT_DOC, &[dash + 2]);
    assert!(bullet(&snap));
    assert!(covered(&snap, dash), "{:?}", snap.spans);
    assert!(!covered(&snap, dash + 1));
}

/// "光标压在 `-` 上：翻回源码（与 ListMark 同一活动规则）"
#[test]
fn setext_ambiguous_dash_returns_to_source_under_the_caret() {
    let dash = setext_dash_from();
    let snap = snapshot(SETEXT_DOC, &[dash]);
    assert!(!bullet(&snap));
}

/// "真 setext（下划线多于一个 `-`）不受影响"
#[test]
fn real_setext_underline_emits_nothing() {
    let doc = "标题行\n---\n";
    let snap = snapshot(doc, &[4]);
    assert!(!bullet(&snap));
    assert!(snap.blocks.is_empty(), "a real setext underline is no rule");
    // Typing text flips the parse to a real ListMark: the bullet takes over
    // from the same offset (seamless handover); an empty item keeps the
    // trailing space visible.
    let typed = "段落行在此。\n- 字\n";
    let dash = typed.find("\n- ").expect("fixture") + 1;
    let snap = snapshot(typed, &[dash + 3]);
    assert!(bullet(&snap));
    assert!(covered(&snap, dash));
}

// ---------------------------------------------------------------------------
// Ported from "选区触发器" (the model-level analogue: the two states differ)
// ---------------------------------------------------------------------------

const DOC2: &str =
    "- 随机变量第一行的内容\n  - [ ] 嵌套任务行\n普通段落文本行,没有标记。\n- \n1. 有序项内容";

#[test]
fn same_line_move_across_the_marker_slot_changes_the_snapshot() {
    let list = at(DOC2, "随机变量");
    assert_ne!(
        snapshot(DOC2, &[list - 2]),
        snapshot(DOC2, &[list + 8]),
        "pressing on `-` must flip the bullet"
    );
    let task = at(DOC2, "[ ]") + 1;
    let task_end = at(DOC2, "嵌套任务行") + 3;
    assert_ne!(snapshot(DOC2, &[task]), snapshot(DOC2, &[task_end]));
}

#[test]
fn empty_item_move_changes_the_trailing_space_rule() {
    let empty = at(DOC2, "- \n");
    assert_ne!(snapshot(DOC2, &[empty]), snapshot(DOC2, &[empty + 2]));
}

#[test]
fn plain_line_moves_leave_the_snapshot_identical() {
    let plain = at(DOC2, "普通段落文本行");
    assert_eq!(snapshot(DOC2, &[plain + 4]), snapshot(DOC2, &[plain + 16]));
    let ordered = at(DOC2, "有序项内容");
    assert_eq!(
        snapshot(DOC2, &[ordered + 2]),
        snapshot(DOC2, &[ordered + 6])
    );
    let text = at(DOC2, "随机变量") + 4;
    assert_eq!(snapshot(DOC2, &[text]), snapshot(DOC2, &[text + 6]));
}

// ---------------------------------------------------------------------------
// Ported from "数学预览的块级锚点（blockDecorationsField）"
// ---------------------------------------------------------------------------

#[test]
fn display_math_block_covers_its_lines_and_anchor_is_the_region() {
    let doc = "a\n$$\nx = 1\n$$\nb\n";
    // Caret outside the region (line 0): the whole region is one block.
    let snap = snapshot(doc, &[0]);
    assert_eq!(
        snap.blocks,
        vec![crate::preview::PreviewBlock {
            first_line: 1,
            last_line: Some(3),
            kind: BlockKind::Math {
                tex: "\nx = 1\n".into(),
                depth: None,
            },
        }]
    );
    assert!(!has_widget(&snap, |w| matches!(w, Widget::Math { .. })));
    assert_no_block_on_line(doc, &snap, 0);
    // Caret inside: the region collapses to editable source and the live
    // preview is inserted below it (one insertion, no replacement).
    let snap = snapshot(doc, &[6]);
    assert_eq!(
        snap.blocks,
        vec![crate::preview::PreviewBlock {
            first_line: 4,
            last_line: None,
            kind: BlockKind::MathPreview {
                tex: "\nx = 1\n".into(),
                depth: None,
            },
        }],
        "{:?}",
        snap.blocks
    );
}

#[test]
fn display_math_block_at_document_end_has_no_trailing_line() {
    let doc = "a\n$$\nx = 1\n$$";
    let snap = snapshot(doc, &[0]);
    assert_eq!(
        (snap.blocks[0].first_line, snap.blocks[0].last_line),
        (1, Some(3))
    );
}

#[test]
fn display_math_block_collapses_while_editing_and_inserts_the_live_preview() {
    // Caret on the block's opening line: the source stays editable (no
    // replacement) and the live preview is inserted right below the region —
    // the TS `MathPreviewWidget`, anchored at the next line's start.
    let doc = "a\n$$\nx = 1\n$$\nb\n";
    let snap = snapshot(doc, &[3]);
    assert_eq!(
        snap.blocks,
        vec![crate::preview::PreviewBlock {
            first_line: 4,
            last_line: None,
            kind: BlockKind::MathPreview {
                tex: "\nx = 1\n".into(),
                depth: None,
            },
        }],
        "{:?}",
        snap.blocks
    );
    assert!(!has_widget(&snap, |w| matches!(w, Widget::Math { .. })));
    // Caret outside (line 0): the replacement block renders and there is no
    // insertion.
    let snap = snapshot(doc, &[0]);
    assert_eq!(snap.blocks.len(), 1);
    assert!(snap.blocks[0].last_line.is_some(), "{:?}", snap.blocks);
}

// ---------------------------------------------------------------------------
// One focused test per rule
// ---------------------------------------------------------------------------

/// `decorateHeading` (livePreview.ts:807-838) hides only the opening marker
/// run (`mark.from..contentFrom`); a trailing closing `#` run stays visible
/// (it is covered by the `md-heading` mark, not by a replace).
#[test]
fn rule_2_atx_heading_hides_only_the_opening_prefix() {
    let doc = "## Title ##\n";
    let snap = snapshot(doc, &[12]);
    assert!(hides(&snap, 0, 3), "{:?}", snap.spans); // `## `
    assert_eq!(snap.spans.len(), 1, "closing hashes stay: {:?}", snap.spans);
    // Caret on the line: raw source.
    assert!(snapshot(doc, &[0]).spans.is_empty());
    // Spaced heading: the prefix swallows the spaces after the hashes.
    let doc = "###  H3 ###   ";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(hides(&snap, 0, 5), "{:?}", snap.spans);
    assert_eq!(snap.spans.len(), 1, "{:?}", snap.spans);
    // Not a heading: `#hashtag`, 7 hashes, `#\tH`.
    for doc in ["#hashtag\n", "####### x\n", "#\tH\n"] {
        assert!(snapshot(doc, &[99]).spans.is_empty(), "{doc:?}");
    }
    // Bare `#` is an empty heading: the hash hides, no panic.
    assert!(hides(&snapshot("#\n", &[]), 0, 1));
}

#[test]
fn rule_3_setext_equals_underline_is_left_alone() {
    let doc = "Title\n=====\n";
    let snap = snapshot(doc, &[0]);
    assert!(snap.spans.is_empty(), "{:?}", snap.spans);
}

#[test]
fn rule_4_list_marks_and_indent() {
    for doc in ["- item", "* item", "+ item"] {
        let snap = snapshot(doc, &[6]);
        assert_eq!(
            snap.spans
                .iter()
                .map(|s| (s.range.clone(), s.kind.clone()))
                .collect::<Vec<_>>(),
            vec![(0..2, PreviewSpanKind::Widget(Widget::Bullet))],
            "{doc:?}"
        );
    }
    // Indentation hides on every line, active or not.
    let doc = "  - item";
    let snap = snapshot(doc, &[6]);
    assert!(hides(&snap, 0, 2), "{:?}", snap.spans);
    let active = snapshot(doc, &[5]);
    assert!(hides(&active, 0, 2), "active line keeps the indent hide");
    // Four columns of indentation are an indented code block, not a list.
    let snap = snapshot("    - item", &[10]);
    assert!(snap.spans.is_empty(), "{:?}", snap.spans);
    // Ordered markers stay untouched.
    assert!(snapshot("1. item", &[7]).spans.is_empty());
}

#[test]
fn rule_5_task_markers() {
    let snap = snapshot("- [x] done", &[9]);
    assert!(has_widget(&snap, |w| *w == Widget::Checkbox { checked: true }));
    let snap = snapshot("- [ ] open", &[9]);
    assert!(has_widget(&snap, |w| *w == Widget::Checkbox { checked: false }));
    assert!(hides(&snap, 0, 2));
    // No whitespace after `]`: not a task (lezer GFM).
    let snap = snapshot("- [ ]", &[4]);
    assert!(!checkbox(&snap) && bullet(&snap));
}

#[test]
fn rule_6_emphasis_strong_strikethrough() {
    let doc = "*em* _under_ **strong** ~~strike~~";
    let (em, under, strong, strike) = (
        at(doc, "*em*"),
        at(doc, "_under_"),
        at(doc, "**strong**"),
        at(doc, "~~strike~~"),
    );
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(hides(&snap, em, em + 1) && hides(&snap, em + 3, em + 4));
    assert!(hides(&snap, under, under + 1) && hides(&snap, under + 6, under + 7));
    assert!(hides(&snap, strong, strong + 2) && hides(&snap, strong + 8, strong + 10));
    assert!(hides(&snap, strike, strike + 2) && hides(&snap, strike + 8, strike + 10));
    // Caret inside the emphasis node: its marks stay, the untouched nodes on
    // the same line still render (the activity rule is per construct).
    let snap = snapshot(doc, &[em + 1]);
    assert!(!hides(&snap, em, em + 1) && !hides(&snap, em + 3, em + 4));
    assert!(hides(&snap, under, under + 1), "{:?}", snap.spans);
    // Intraword `_` does not emphasize; `~` needs two tildes.
    assert!(snapshot("a_b_c and ~x~", &[]).spans.is_empty());
}

fn dot(doc: &str) -> usize {
    doc.len() + 1 // position past the end of the line: nothing is active
}

#[test]
fn rule_6b_nested_emphasis_hides_every_level() {
    let doc = "*a **b** c*";
    let snap = snapshot(doc, &[dot(doc)]);
    for range in [0..1, 3..5, 6..8, 10..11] {
        assert!(
            snap.spans
                .iter()
                .any(|s| s.range == range && s.kind == PreviewSpanKind::Hidden),
            "missing {range:?} in {:?}",
            snap.spans
        );
    }
    // A caret inside the outer node but outside the inner one keeps the outer
    // marks and hides the inner ones.
    let snap = snapshot(doc, &[2]);
    assert!(!hides(&snap, 0, 1));
    assert!(hides(&snap, 3, 5) && hides(&snap, 6, 8));
    assert!(!hides(&snap, 10, 11));
}

#[test]
fn rule_7_inline_code_and_no_spans_inside_code() {
    let doc = "`code *x*` plain";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(hides(&snap, 0, 1) && hides(&snap, 9, 10));
    assert!(!snapshot(doc, &[dot(doc)])
        .spans
        .iter()
        .any(|s| s.range.start == 5 || s.range.start == 7));
    // Caret inside the code span: backticks stay.
    let snap = snapshot(doc, &[3]);
    assert!(snap.spans.is_empty(), "{:?}", snap.spans);
    // `$` inside code is not math.
    let doc = "`$x$`";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(!has_widget(&snap, |w| matches!(w, Widget::Math { .. })));
    // A lone backtick is not a code span.
    assert!(snapshot("a ` b", &[]).spans.is_empty());
}

/// Deviation from the TS, deliberate: `buildInlineDecorations` stops at the
/// first heading node, so `# *em*` keeps its emphasis marks visible; this port
/// treats the heading text as ordinary inline content.
#[test]
fn heading_text_is_scanned_for_inline_constructs() {
    let doc = "# *em* title";
    let snap = snapshot(doc, &[dot(doc)]);
    let em = at(doc, "*em*");
    assert!(hides(&snap, 0, 2), "prefix");
    assert!(hides(&snap, em, em + 1) && hides(&snap, em + 3, em + 4));
}

#[test]
fn rule_8_fenced_code_lines() {
    let doc = "```rust\nlet a = 1;\n```\n";
    let snap = snapshot(doc, &[dot(doc)]);
    // Both fence lines are whole-line removals (zero height, TS
    // `HiddenLineWidget`), not inline hides and not a language chip.
    assert_eq!(
        snap.blocks
            .iter()
            .map(|b| (b.first_line, b.last_line, b.kind.clone()))
            .collect::<Vec<_>>(),
        vec![
            (0, Some(0), BlockKind::HiddenLine),
            (2, Some(2), BlockKind::HiddenLine)
        ]
    );
    // Nothing is expected of the fence lines' bytes: the line is gone.
    assert!(snap.spans.is_empty(), "{:?}", snap.spans);
    // Caret inside the block: the fences stay source (still no spans drawn for
    // them, which is the `Skip::FenceLine` rule).
    let snap = snapshot(doc, &[at(doc, "let a")]);
    assert!(snap.spans.is_empty(), "{:?}", snap.spans);
    assert!(snap.blocks.is_empty(), "{:?}", snap.blocks);
    // Bare and tilde fences.
    let doc = "~~~\n*x* inside\n~~~\n";
    let snap = snapshot(doc, &[dot(doc)]);
    assert_eq!(snap.blocks.len(), 2, "{:?}", snap.blocks);
    assert!(!bullet(&snap));
    // Unclosed fence: only the opening line is collapsed.
    let doc = "```\nbody";
    let snap = snapshot(doc, &[dot(doc)]);
    assert_eq!(
        snap.blocks
            .iter()
            .map(|b| (b.first_line, b.kind.clone()))
            .collect::<Vec<_>>(),
        vec![(0, BlockKind::HiddenLine)]
    );
}

/// `decorateBlockquote` (livePreview.ts:913-928) only pushes a `md-quote`
/// line decoration on inactive lines — bnote keeps the `>` visible (see the
/// design note in `callout.ts`: "bnote 不隐藏 `>` 标记"), so no span is
/// emitted for a quote prefix, caret anywhere.
#[test]
fn rule_9_blockquote_prefixes_stay_visible() {
    let doc = "> one\n> two\n";
    for caret in [0, 1, at(doc, "two"), dot(doc)] {
        assert!(
            snapshot(doc, &[caret]).spans.is_empty(),
            "caret {caret}: {:?}",
            snapshot(doc, &[caret]).spans
        );
    }
    // Nested quotes are context only as well (`> > deep` emits nothing).
    let doc = "> > deep\n";
    assert!(snapshot(doc, &[dot(doc)]).spans.is_empty());
    // Quote-indented content still decorates normally on inactive lines: the
    // `- ` marker inside sits behind the prefix, which is not claimed.
    let doc = "> - item\n";
    let snap = snapshot(doc, &[dot(doc)]);
    assert_eq!(
        snap.spans
            .iter()
            .map(|s| (s.range.clone(), s.kind.clone()))
            .collect::<Vec<_>>(),
        vec![(2..4, PreviewSpanKind::Widget(Widget::Bullet))],
        "{:?}",
        snap.spans
    );
}

/// `decorateLink` (livePreview.ts:1075-1091) emits only marks — `md-link` on
/// the label and `md-url` on the URL — and no replace; the URL/Autolink
/// branch (524-529) is mark-only too. Neither contributes a span, so the
/// source stays visible; the ranges only shield their content from other
/// rules (the TS `return false` at those nodes).
#[test]
fn rule_10_links_and_autolinks_emit_no_spans() {
    let doc = "[text](https://x) tail";
    assert!(snapshot(doc, &[dot(doc)]).spans.is_empty());
    assert!(snapshot(doc, &[2]).spans.is_empty());
    // The label is shielded: emphasis inside it is not decorated.
    let doc = "[*em* `code`](u) tail";
    assert!(snapshot(doc, &[dot(doc)]).spans.is_empty());
    // Autolinks keep the URL visible.
    let doc = "see <https://x> now";
    assert!(snapshot(doc, &[dot(doc)]).spans.is_empty());
    // A link-shaped range is still not a link: `[a]` alone marks nothing.
    assert!(snapshot("[a] tail", &[dot("[a] tail")]).spans.is_empty());
}

#[test]
fn rule_11_wikilinks() {
    let doc = "[[target]] tail";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(
        hides(&snap, 0, 2) && hides(&snap, 8, 10),
        "{:?}",
        snap.spans
    );
    let doc = "[[target|alias]] tail";
    let alias = at(doc, "alias");
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(hides(&snap, 0, 2), "{:?}", snap.spans);
    assert!(hides(&snap, 2, alias), "{:?}", snap.spans); // `target|`
    assert!(hides(&snap, alias + 5, alias + 7), "{:?}", snap.spans); // `]]`
                                                                     // Line-level activity: a caret anywhere on the line keeps the source.
    assert!(snapshot(doc, &[0]).spans.is_empty());
    // Empty target renders nothing.
    assert!(snapshot("[[|x]]", &[]).spans.is_empty());
}

#[test]
fn rule_12_images() {
    let doc = "![alt](assets/a.png) tail";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(has_widget(&snap, |w| {
        *w == Widget::Image {
            src: "assets/a.png".into(),
            alt: "alt".into(),
        }
    }));
    // Title is stripped from the src.
    let doc = "![a](x.png \"t\") tail";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(has_widget(&snap, |w| {
        matches!(w, Widget::Image { src, .. } if src == "x.png")
    }));
    // Embed wikilink: whole range becomes an image.
    let doc = "![[pic.png]] tail";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(has_widget(&snap, |w| {
        matches!(w, Widget::Image { src, .. } if src == "pic.png")
    }));
    // A drawing embed is an image too; a non-image target falls back to the
    // plain wikilink path (source keeps the `!`).
    let doc = "![[draw.excalidraw]] tail";
    assert!(has_widget(&snapshot(doc, &[dot(doc)]), |w| {
        matches!(w, Widget::Image { .. })
    }));
    let doc = "![[notes]] tail";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(!has_widget(&snap, |w| matches!(w, Widget::Image { .. })));
    assert!(hides(&snap, 1, 3) && hides(&snap, 8, 10));
}

#[test]
fn rule_13_math_widgets() {
    let doc = "before $x_1$ after";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(has_widget(&snap, |w| {
        *w == Widget::Math {
            tex: "x_1".into(),
            display: false,
        }
    }));
    // Caret inside the region: no widget (source shown).
    assert!(!has_widget(&snapshot(doc, &[8]), |w| matches!(
        w,
        Widget::Math { .. }
    )));
    // Single-line display math is an inline widget; multi-line is a block.
    let doc = "a $$x$$ b";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(has_widget(&snap, |w| matches!(
        w,
        Widget::Math { display: true, .. }
    )));
    let doc = "a\n$$\nx\n$$\nb";
    let snap = snapshot(doc, &[0]);
    assert_eq!(snap.blocks.len(), 1);
    assert!(snap.spans.is_empty(), "{:?}", snap.spans);
}

#[test]
fn rule_14_horizontal_rule() {
    // The whole line is replaced by a rule block (`HrWidget`, `block: true`).
    for doc in ["---\n", "***\n", "___\n", "- - -\n"] {
        let snap = snapshot(doc, &[dot(doc)]);
        assert_eq!(
            snap.blocks,
            vec![crate::preview::PreviewBlock {
                first_line: 0,
                last_line: Some(0),
                kind: BlockKind::Rule { depth: None },
            }],
            "{doc:?}"
        );
        assert!(snap.spans.is_empty(), "{doc:?} → {:?}", snap.spans);
    }
    // A dash run under a paragraph is a setext underline, not a rule.
    assert!(snapshot("text\n---\n", &[0]).blocks.is_empty());
    // Caret on the rule line: source stays.
    assert!(snapshot("---\n", &[1]).spans.is_empty());
    assert!(snapshot("---\n", &[1]).blocks.is_empty());
}

#[test]
fn rule_15_callouts() {
    let doc = "::: 提示\nthe body\n:::\n";
    let snap = snapshot(doc, &[dot(doc)]);
    let open = snap
        .blocks
        .iter()
        .find(|b| b.first_line == 0)
        .expect("opening block");
    assert_eq!(open.last_line, Some(0));
    assert_eq!(
        open.kind,
        BlockKind::Callout {
            title: "提示".into(),
            depth: 0,
            open: true,
        }
    );
    let close = snap
        .blocks
        .iter()
        .find(|b| b.first_line == 2)
        .expect("closing block");
    assert_eq!(
        close.kind,
        BlockKind::Callout {
            title: String::new(),
            depth: 0,
            open: false,
        }
    );
    // Body lines carry no spans at all.
    assert!(snap.spans.is_empty(), "{:?}", snap.spans);
    // Caret inside the block: no blocks, raw source everywhere.
    let snap = snapshot(doc, &[at(doc, "the body")]);
    assert!(snap.blocks.is_empty());
    // Unclosed callout: only the opening edge is a block.
    let doc = "::: 甲\nbody without close\n";
    let snap = snapshot(doc, &[dot(doc)]);
    assert_eq!(snap.blocks.len(), 1);
    assert_eq!(snap.blocks[0].first_line, 0);
}

/// While the caret is inside a display math block the source stays, and (with
/// the `mathPreview` setting on) a live-rendered copy is **inserted** below
/// the block — never replacing anything (TS `MathPreviewWidget`, 302-326).
#[test]
fn rule_14b_math_preview_insertion() {
    let doc = "before\n$$\nx = 1\n$$\nafter\n";
    let caret = at(doc, "x = 1");
    let snap = snapshot(doc, &[caret]);
    // The source lines are untouched: no spans, and no replacement blocks
    // (the only block is the insertion).
    assert!(snap.spans.is_empty(), "{:?}", snap.spans);
    assert!(snap.blocks.iter().all(|b| b.last_line.is_none()), "{:?}", snap.blocks);
    // ...and the preview is inserted at the start of the line after the block.
    let previews: Vec<_> = snap
        .blocks
        .iter()
        .filter(|b| matches!(b.kind, BlockKind::MathPreview { .. }))
        .collect();
    assert_eq!(previews.len(), 1, "{:?}", snap.blocks);
    let preview = previews[0];
    assert_eq!(preview.first_line, 4);
    assert_eq!(preview.last_line, None);
    assert_eq!(
        preview.kind,
        BlockKind::MathPreview {
            tex: "\nx = 1\n".into(),
            depth: None,
        }
    );

    // The setting off: no insertion at all.
    let selections = vec![caret..caret];
    let snap = scan(ScanInput {
        text: doc,
        selections: &selections,
        visible: ALL,
        math_preview: false,
    });
    assert!(snap.blocks.is_empty(), "{:?}", snap.blocks);

    // Empty block: nothing to preview, and no placeholder space either.
    let doc = "$$\n\n$$\n";
    let snap = snapshot(doc, &[at(doc, "$$") + 1]);
    assert!(snap.blocks.is_empty(), "{:?}", snap.blocks);

    // A block at the very end of the document anchors after the last line —
    // the insertion's `at_line == line count` boundary.
    let doc = "a\n$$\nx = 1\n$$";
    let snap = snapshot(doc, &[at(doc, "x = 1")]);
    let lines = crate::markdown::line_ranges(doc);
    assert_eq!(snap.blocks.len(), 1, "{:?}", snap.blocks);
    assert_eq!(snap.blocks[0].first_line, lines.len());
    assert_eq!(snap.blocks[0].last_line, None);

    // Caret outside: a replacement block, no insertion.
    let doc = "before\n$$\nx = 1\n$$\nafter\n";
    let snap = snapshot(doc, &[dot(doc)]);
    assert_eq!(
        snap.blocks
            .iter()
            .map(|b| (b.first_line, b.last_line))
            .collect::<Vec<_>>(),
        vec![(1, Some(3))]
    );
}

/// Markdown escapes: `\X` renders as `X` alone (TS `Escape` node →
/// `EscapeCharWidget`); it is not a markdown escape inside code, a link or a
/// formula, and the caret's presence on the pair keeps the source.
#[test]
fn rule_17_markdown_escapes() {
    let doc = "a \\* b and \\\\ and \\x\n";
    let snap = snapshot(doc, &[dot(doc)]);
    let escapes: Vec<_> = snap
        .spans
        .iter()
        .filter_map(|s| match &s.kind {
            PreviewSpanKind::Widget(Widget::Escape { char }) => Some((s.range.clone(), char.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        escapes,
        vec![
            (at(doc, "\\*")..at(doc, "\\*") + 2, "*".to_string()),
            // `\\` is an escaped backslash: one backslash remains.
            (at(doc, "\\\\")..at(doc, "\\\\") + 2, "\\".to_string()),
        ],
        "only escapable pairs: {:?}",
        snap.spans
    );
    // `\x` is not an escape: the backslash stays.
    assert!(
        !snap.spans.iter().any(|s| s.range.start == at(doc, "\\x")),
        "{:?}",
        snap.spans
    );

    // Caret on the pair: source stays.
    let pair = at(doc, "\\*");
    for caret in [pair, pair + 1, pair + 2] {
        let snap = snapshot(doc, &[caret]);
        assert!(
            !snap.spans.iter().any(|s| s.range.start < pair + 2 && s.range.end > pair),
            "caret {caret} must keep the escaped pair as source: {:?}",
            snap.spans
        );
    }

    // Not markdown escapes: inside inline code, inside a link, inside a formula.
    for doc in ["`\\*`", "[label \\* x](url)", "$\\,$"] {
        let snap = snapshot(doc, &[dot(doc)]);
        assert!(
            !snap
                .spans
                .iter()
                .any(|s| matches!(s.kind, PreviewSpanKind::Widget(Widget::Escape { .. }))),
            "{doc}: {:?}",
            snap.spans
        );
    }
    // A lone backslash at the end of the line is not an escape either.
    let snap = snapshot("tail \\\n", &[dot("tail \\\n")]);
    assert!(!snap.spans.iter().any(|s| matches!(s.kind, PreviewSpanKind::Widget(Widget::Escape { .. }))));
}

/// Code bodies and quotes get their container look from panels too (TS
/// `md-code-line` / `md-quote`), each under its own activity rule.
#[test]
fn rule_15c_code_and_quote_panels() {
    // Code body: styled only while the caret is outside the whole block.
    let doc = "```rust\nlet a = 1;\nlet b = 2;\n```\n";
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(
        snap.panels.iter().any(|p| p.kind == PanelKind::CodeBlock
            && (p.first_line, p.last_line) == (1, 2)),
        "{:?}",
        snap.panels
    );
    let snap = snapshot(doc, &[at(doc, "let b")]);
    assert!(
        !snap.panels.iter().any(|p| p.kind == PanelKind::CodeBlock),
        "caret inside the block: {:?}",
        snap.panels
    );

    // Quotes: one panel per run of inactive quoted lines.
    let doc = "> one\n> two\nplain\n> three\n";
    let snap = snapshot(doc, &[dot(doc)]);
    let quotes: Vec<(usize, usize)> = snap
        .panels
        .iter()
        .filter(|p| p.kind == PanelKind::Blockquote)
        .map(|p| (p.first_line, p.last_line))
        .collect();
    assert_eq!(quotes, vec![(0, 1), (3, 3)], "{:?}", snap.panels);
    // Caret on a quoted line: that line drops out of the run.
    let snap = snapshot(doc, &[at(doc, "> two") + 2]);
    let quotes: Vec<(usize, usize)> = snap
        .panels
        .iter()
        .filter(|p| p.kind == PanelKind::Blockquote)
        .map(|p| (p.first_line, p.last_line))
        .collect();
    assert_eq!(quotes, vec![(0, 0), (3, 3)], "{:?}", snap.panels);

    // A plain document has no panels at all.
    let snap = snapshot("plain\n", &[dot("plain\n")]);
    assert!(snap.panels.is_empty(), "{:?}", snap.panels);
}

/// Callout panels: the container look is a panel, not a block — it covers
/// every line of the region, is emitted whether or not the caret is inside,
/// and nests (TS `md-callout-line d{depth}`, livePreview.ts 577-604).
#[test]
fn rule_15b_callout_panels() {
    let doc = "::: 提示\nthe body\n:::\n";
    // Caret outside the region: panel + the two edge blocks.
    let snap = snapshot(doc, &[dot(doc)]);
    assert_eq!(snap.panels.len(), 1);
    assert_eq!(
        snap.panels[0],
        PreviewPanel {
            first_line: 0,
            last_line: 2,
            kind: PanelKind::Callout {
                depth: 0,
                open_line: 0,
                close_line: Some(2),
            },
        }
    );

    // Caret inside: the blocks are gone (source is editable) but the panel
    // stays — it is not caret-gated in the TS either.
    let inside = snapshot(doc, &[at(doc, "the body")]);
    assert!(inside.blocks.is_empty());
    assert_eq!(inside.panels, snap.panels);

    // Unclosed region: the panel runs to the document's last line (including
    // the empty one a trailing newline produces), `close_line` is None.
    let doc = "::: 甲\nbody without close\n";
    let snap = snapshot(doc, &[dot(doc)]);
    assert_eq!(snap.panels.len(), 1);
    assert_eq!(snap.panels[0].last_line, 2);
    assert!(matches!(
        snap.panels[0].kind,
        PanelKind::Callout {
            close_line: None,
            ..
        }
    ));

    // Nested regions: one panel each, depths 0/1, ranges overlapping by
    // design (the renderer paints them in order).
    let doc = "::: outer\na\n::: inner\nb\n:::\n:::\n";
    let snap = snapshot(doc, &[dot(doc)]);
    let panels: Vec<(usize, usize, u8)> = snap
        .panels
        .iter()
        .map(|p| match &p.kind {
            PanelKind::Callout { depth, .. } => (p.first_line, p.last_line, *depth),
            other => panic!("expected a callout panel, got {other:?}"),
        })
        .collect();
    assert_eq!(panels, vec![(0, 5, 0), (2, 4, 1)]);
    for (panel, close) in snap.panels.iter().zip([5usize, 4]) {
        assert!(matches!(
            panel.kind,
            PanelKind::Callout {
                close_line: Some(c),
                ..
            } if c == close
        ));
    }

    // The window clips the panel's lines (the TS clamps its per-line classes
    // the same way) while the edges keep the region's own line numbers.
    let doc = "::: 提示\nline a\nline b\n:::\n";
    let start = doc.find("line a").unwrap();
    let snap = snapshot_visible(doc, &[dot(doc)], start..start + 3);
    assert_eq!(snap.panels.len(), 1);
    assert_eq!((snap.panels[0].first_line, snap.panels[0].last_line), (1, 1));
    assert!(matches!(
        snap.panels[0].kind,
        PanelKind::Callout {
            open_line: 0,
            close_line: Some(3),
            ..
        }
    ));

    // A document without callouts has no panels at all.
    let snap = snapshot("plain text\n", &[dot("plain text\n")]);
    assert!(snap.panels.is_empty());
}

#[test]
fn rule_16_visible_window_limits_emission_but_not_classification() {
    let doc = "# Title\n\nbody text\n\n- item\n";
    let body = at(doc, "body text");
    let visible = body..body + 4;
    let snap = snapshot_visible(doc, &[dot(doc)], visible);
    assert!(
        snap.spans.is_empty(),
        "heading is outside the window: {:?}",
        snap.spans
    );
    let item = at(doc, "- item");
    let snap = snapshot_visible(doc, &[dot(doc)], item..item + 3);
    assert!(bullet(&snap));
    // A multi-line math block intersecting the window is reported whole.
    let doc = "a\n$$\nx = 1\n$$\nb\n";
    let lines = crate::markdown::line_ranges(doc);
    let snap = snapshot_visible(doc, &[0], lines[2].0..lines[2].1);
    assert_eq!(
        (snap.blocks[0].first_line, snap.blocks[0].last_line),
        (1, Some(3))
    );
    // A window that misses it entirely reports nothing.
    let snap = snapshot_visible(doc, &[0], 0..1);
    assert!(snap.blocks.is_empty(), "{:?}", snap.blocks);
}

#[test]
fn inline_code_wins_over_link_and_emphasis() {
    let doc = "`[a](b) *x*` then *y*";
    let code_close = at(doc, "` then");
    let y = at(doc, "*y*");
    let snap = snapshot(doc, &[dot(doc)]);
    assert!(hides(&snap, 0, 1) && hides(&snap, code_close, code_close + 1));
    assert!(!snap
        .spans
        .iter()
        .any(|s| s.range.start > 0 && s.range.end <= code_close));
    assert!(
        hides(&snap, y, y + 1) && hides(&snap, y + 2, y + 3),
        "{:?}",
        snap.spans
    );
}

// ---------------------------------------------------------------------------
// Mixed document: structural invariants + the caret line stays editable
// ---------------------------------------------------------------------------

const MIXED: &str = "\
# Title

Intro with *em*, **strong**, `code`, $x+1$ and a [link](https://example.com).

- [ ] todo item
- bullet item
  - nested item
1. ordered item

> quoted line
> > deeper

```rust
let a = 1;
```

$$
E = mc^2
$$

---

::: 提示
callout body
:::

Setext title
===

![[image.png]] and [[wiki target|alias]]
";

#[test]
fn mixed_document_is_sorted_disjoint_and_visible() {
    let snap = snapshot(MIXED, &[0]);
    assert_invariants(MIXED, &snap);
    assert!(!snap.spans.is_empty());
    assert!(!snap.blocks.is_empty());
}

#[test]
fn mixed_document_never_hides_the_caret() {
    // Every byte of every construct gets a turn as the caret. The two
    // leading spaces of the nested item are excluded: hiding indentation on
    // the active line is deliberate (`rule_4_list_marks_and_indent`), so a
    // caret inside an indentation run is the one position that may sit inside
    // a hidden span.
    let nested_indent = at(MIXED, "  - nested item");
    let mut carets: Vec<usize> = Vec::new();
    for needle in [
        "# Title",
        "Intro",
        "*em*",
        "**strong**",
        "`code`",
        "$x+1$",
        "[link]",
        "- [ ]",
        "- bullet",
        "  - nested",
        "1. ordered",
        "> quoted",
        "> > deeper",
        "```rust",
        "let a = 1;",
        "$$",
        "E = mc^2",
        "---",
        "::: 提示",
        "callout body",
        "===",
        "![[image.png]]",
        "[[wiki target|alias]]",
    ] {
        let start = at(MIXED, needle);
        for offset in 0..needle.len() {
            let pos = start + offset;
            if (nested_indent..nested_indent + 2).contains(&pos) {
                continue;
            }
            carets.push(pos);
        }
    }
    for &caret in &carets {
        let snap = snapshot(MIXED, &[caret]);
        assert_invariants(MIXED, &snap);
        assert!(
            !covered(&snap, caret),
            "caret {caret} lands inside a hidden span: {:?}",
            snap.spans
        );
        assert_no_block_on_line(MIXED, &snap, caret);
    }
}

#[test]
fn mixed_document_renders_every_construct_when_the_caret_is_away() {
    let snap = snapshot(MIXED, &[MIXED.len()]);
    assert_invariants(MIXED, &snap);
    // One representative span per rule family.
    assert!(hides(&snap, 0, 2), "heading prefix");
    assert!(bullet(&snap), "bullet");
    assert!(checkbox(&snap), "checkbox");
    assert!(
        has_widget(&snap, |w| matches!(w, Widget::Math { .. })),
        "math widget"
    );
    assert!(
        has_widget(&snap, |w| matches!(w, Widget::Image { .. })),
        "image"
    );
    // Blocks: the two fence lines (zero-height removals), the display maths,
    // the rule, and one line per callout edge.
    assert_eq!(snap.blocks.len(), 6, "{:?}", snap.blocks);
    assert_eq!(
        snap.blocks
            .iter()
            .filter(|b| b.kind == BlockKind::HiddenLine)
            .count(),
        2,
        "both fence lines collapse: {:?}",
        snap.blocks
    );
    assert_eq!(
        snap.blocks
            .iter()
            .filter(|b| matches!(b.kind, BlockKind::Rule { .. }))
            .count(),
        1,
        "the rule is a block replace: {:?}",
        snap.blocks
    );
    // Style spans ride along the same document: the emphasis, the inline
    // code, the ordered marker, and the heading's content all carry marks.
    assert_eq!(styled(&snap, MIXED, SpanStyle::Strong), vec!["strong"]);
    assert_eq!(styled(&snap, MIXED, SpanStyle::Emphasis), vec!["em"]);
    assert_eq!(
        styled(&snap, MIXED, SpanStyle::InlineCode),
        vec!["code"]
    );
    assert_eq!(styled(&snap, MIXED, SpanStyle::ListMark), vec!["1."]);
    assert_eq!(
        styled(&snap, MIXED, SpanStyle::Heading { level: 1 }),
        vec!["Title"]
    );
    assert_eq!(styled(&snap, MIXED, SpanStyle::Link), vec!["link"]);
    assert_eq!(
        styled(&snap, MIXED, SpanStyle::WikiLink),
        vec!["alias"]
    );
}

// ---------------------------------------------------------------------------
// Style spans (the TS mark classes, `Decoration.mark`)
// ---------------------------------------------------------------------------

#[test]
fn style_spans_mark_emphasis_code_links_and_wikilinks() {
    let doc = "a **bold** *em* ~~gone~~ `code` [label](https://x.dev) [[wiki|alias]] b\n";
    let snap = snapshot(doc, &[doc.len()]);
    assert_eq!(styled(&snap, doc, SpanStyle::Strong), vec!["bold"]);
    assert_eq!(styled(&snap, doc, SpanStyle::Emphasis), vec!["em"]);
    assert_eq!(styled(&snap, doc, SpanStyle::Strikethrough), vec!["gone"]);
    assert_eq!(styled(&snap, doc, SpanStyle::InlineCode), vec!["code"]);
    assert_eq!(styled(&snap, doc, SpanStyle::Link), vec!["label"]);
    assert_eq!(styled(&snap, doc, SpanStyle::LinkUrl), vec!["https://x.dev"]);
    assert_eq!(styled(&snap, doc, SpanStyle::WikiLink), vec!["alias"]);
    // A wikilink without an alias marks its whole content.
    let doc = "[[plain]]\n";
    let snap = snapshot(doc, &[doc.len()]);
    assert_eq!(styled(&snap, doc, SpanStyle::WikiLink), vec!["plain"]);
}

/// The activity gates differ per construct — the TS marks the inline-code
/// content unconditionally (`decorateInlineCode`) but runs the whole emphasis
/// helper only off the caret (`!active(node)`), so the two behave differently
/// while the caret edits them. Each construct is gated on its own range.
#[test]
fn inline_code_keeps_its_mark_while_emphasis_loses_it() {
    let doc = "a `code` b **bold** c\n";
    // Caret inside the code span: the code mark is unconditional and the
    // sibling emphasis (a different construct) is unaffected.
    let caret = at(doc, "code") + 1;
    let snap = snapshot(doc, &[caret]);
    // The caret's code span keeps its backticks; the emphasis on the same
    // line is inactive and hides its `**` runs.
    assert_eq!(snap.spans.len(), 2, "{:?}", snap.spans);
    assert!(hides(&snap, 11, 13) && hides(&snap, 17, 19), "{:?}", snap.spans);
    assert_eq!(styled(&snap, doc, SpanStyle::InlineCode), vec!["code"]);
    assert_eq!(styled(&snap, doc, SpanStyle::Strong), vec!["bold"]);
    // Caret inside the emphasis: its mark is gone (the whole helper is gated
    // on `!active(node)`), while the code span keeps its mark.
    let caret = at(doc, "bold") + 1;
    let snap = snapshot(doc, &[caret]);
    assert!(
        styled(&snap, doc, SpanStyle::Strong).is_empty(),
        "the emphasis under the caret loses its mark"
    );
    assert_eq!(
        styled(&snap, doc, SpanStyle::InlineCode),
        vec!["code"],
        "the code mark is unconditional"
    );
}

#[test]
fn style_spans_mark_headings_and_raw_math_source() {
    let doc = "# Title ##\ntext\n$x^2 + \\frac{1}{2}$\n";
    // Caret on the second line: the heading is inactive but its content keeps
    // the `md-heading md-h1` mark (only the hash hiding is lifted on the
    // caret's line), and the raw `#` run carries no mark.
    let snap = snapshot(doc, &[at(doc, "text")]);
    assert_eq!(
        styled(&snap, doc, SpanStyle::Heading { level: 1 }),
        vec!["Title ##"]
    );
    assert!(styled(&snap, doc, SpanStyle::HeadingMark).is_empty());
    // Caret on the heading line: the hashes stay and get the dim mark.
    let snap = snapshot(doc, &[at(doc, "Title") + 2]);
    assert_eq!(styled(&snap, doc, SpanStyle::HeadingMark), vec!["# "]);
    assert_eq!(
        styled(&snap, doc, SpanStyle::Heading { level: 1 }),
        vec!["Title ##"]
    );

    // Maths source colouring only while the caret edits the region; a lone
    // `$` is not a highlighted delimiter (the TS regex matches `$$` only).
    let caret = at(doc, "^2");
    let snap = snapshot(doc, &[caret]);
    assert_eq!(
        styled(&snap, doc, SpanStyle::MathBrace),
        vec!["^", "{", "}", "{", "}"]
    );
    assert_eq!(styled(&snap, doc, SpanStyle::MathCmd), vec!["\\frac"]);
    assert!(styled(&snap, doc, SpanStyle::MathDelim).is_empty());
    // Away from the region: the inline formula is a widget, no source marks.
    let snap = snapshot(doc, &[at(doc, "text")]);
    assert!(styled(&snap, doc, SpanStyle::MathBrace).is_empty());
    assert!(styled(&snap, doc, SpanStyle::MathCmd).is_empty());
    assert!(styled(&snap, doc, SpanStyle::MathDelim).is_empty());
}

#[test]
fn style_spans_mark_ordered_list_markers_only() {
    let doc = "1. one\n- two\n";
    let snap = snapshot(doc, &[doc.len()]);
    // The ordered marker is dimmed in place; the bullet is a widget instead,
    // so it carries no mark (TS `decorateListMark`).
    assert_eq!(styled(&snap, doc, SpanStyle::ListMark), vec!["1."]);
}

/// Styles are not claims: a mark may cover bytes another rule hides, and the
/// window clip is the only gate.
#[test]
fn style_spans_are_not_claims_and_follow_the_window() {
    let doc = "a **bold** b\n";
    let snap = snapshot(doc, &[doc.len()]);
    // The `**` pairs are hidden; the content mark sits between them.
    assert!(hides(&snap, 2, 4));
    assert_eq!(styled(&snap, doc, SpanStyle::Strong), vec!["bold"]);
    // A window that clips the line reports no styles for it.
    let snap = snapshot_visible(doc, &[doc.len()], doc.len()..doc.len() + 1);
    assert!(snap.styles.is_empty(), "{:?}", snap.styles);
}
