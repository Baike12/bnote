//! Block-level statics: fences, code ranges, maths, callouts, headings,
//! setext underlines, list items, quote prefixes and horizontal rules —
//! everything the per-line pass needs before it looks at inline content.
//!
//! The TS source of truth walks a lezer syntax tree
//! (`collectBlockStatics` in `livePreview.ts`); this port has no tree, so the
//! same classification is derived by scanning lines. The scanning models are
//! reused from [`crate::markdown`] (`math_scan`, `callout`,
//! `context::fence_state_scan` and its `parse_fence`); only the per-line
//! *shape* the decorations need is computed here.
//!
//! Two approximations are deliberate and documented in the port report:
//! indented code blocks (`IndentedCode`/`CodeBlock` in the TS) are not
//! modelled — their lines are treated as ordinary text — and a block start
//! indented deeper than 3 columns is only recognized inside a list-item
//! paragraph (`indent >= ` that item's content indent), mirroring how a
//! list continuation keeps its container.

use crate::markdown::callout::{compute_callout_regions, CalloutRegion};
use crate::markdown::context::{fence_state_scan, parse_fence};
use crate::markdown::line_ranges;
use crate::markdown::math_scan::{scan_math, MathRegion};

use super::geom::{line_of, LineTable};

/// One fenced-code block (TS `FencedCode`). `from`/`to` are the node-style
/// byte range the activity rule uses (`nodeRef.from .. nodeRef.to`: the first
/// fence char to the end of the closing fence line), not the whole lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FenceBlock {
    pub(super) open_line: usize,
    pub(super) close_line: Option<usize>,
    pub(super) from: usize,
    pub(super) to: usize,
    /// First word of the opening fence's info string (`None` when bare).
    pub(super) lang: Option<String>,
}

/// The list marker of a line (TS `ListMark` + the `Task` child).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ListKind {
    /// `- ` / `* ` / `+ ` → `Widget::Bullet`.
    Bullet,
    /// `1. ` — stays visible (TS adds only a class).
    Ordered,
    /// `- [ ]` / `- [x]` → `Widget::Checkbox`, `- ` hidden.
    Task {
        checked: bool,
        /// The `[ ]` byte range (TS `TaskMarker`).
        task: (usize, usize),
        /// End of the whitespace run after the marker (`whitespaceEnd`).
        trailing: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ListInfo {
    /// TS `ListMark` range (marker only, no trailing whitespace).
    pub(super) mark: (usize, usize),
    pub(super) kind: ListKind,
    /// Start of the item's inline content (after marker + task + whitespace).
    pub(super) content_from: usize,
    /// Item content indent relative to its container's content start.
    pub(super) content_indent: usize,
}

/// ATX heading pieces (TS `decorateHeading`, livePreview.ts:807-838).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HeadingInfo {
    /// `#`s plus the spaces after them — the hidden prefix on inactive lines
    /// (`mark.from..contentFrom`). A trailing closing `#` run is *not* part of
    /// it: `decorateHeading` hides only the first `HeaderMark` and the spaces
    /// after it.
    pub(super) prefix: (usize, usize),
    /// Start of the heading text (inline content).
    pub(super) content_from: usize,
    /// Number of `#`s, 1..=6 (the `md-h{level}` in TS `decorateHeading`).
    pub(super) level: u8,
}

/// A `-`-only setext underline: the empty-bullet ambiguity
/// (TS `decorateSetextDash`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SetextDash {
    pub(super) mark: (usize, usize),
    /// End of the whitespace run after the dash (capped at the line end).
    pub(super) ws_to: usize,
}

/// Why a line carries no inline decorations at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Skip {
    /// The line is a fence line of a fenced-code block.
    FenceLine,
    /// The line is code text inside a fenced-code block.
    CodeBody,
    /// The line belongs to a multi-line display-math block.
    MathBody,
    /// The line is a callout edge (`:::`); rendered as a block or as source.
    CalloutEdge,
}

/// Per-line shape consumed by the decoration pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LineInfo {
    pub(super) skip: Option<Skip>,
    /// Quote marker chunks (`>` plus one following space/tab) by nesting level.
    pub(super) quotes: Vec<(usize, usize)>,
    /// Container content start: the byte after the quote prefixes.
    pub(super) base: usize,
    /// Inline content start (after quote prefixes and any list marker).
    pub(super) content_from: usize,
    pub(super) list: Option<ListInfo>,
    pub(super) heading: Option<HeadingInfo>,
    pub(super) setext_dash: Option<SetextDash>,
    /// Horizontal-rule text range (TS `HorizontalRule` node).
    pub(super) hr: Option<(usize, usize)>,
    /// `(callout region index, is the opening line)`.
    pub(super) callout: Option<(usize, bool)>,
}

impl Default for LineInfo {
    fn default() -> Self {
        LineInfo {
            skip: None,
            quotes: Vec::new(),
            base: 0,
            content_from: 0,
            list: None,
            heading: None,
            setext_dash: None,
            hr: None,
            callout: None,
        }
    }
}

/// Document-wide block statics, computed once per scan.
#[derive(Debug, Clone)]
pub(super) struct Statics {
    pub(super) lines: LineTable,
    pub(super) math: Vec<MathRegion>,
    pub(super) callouts: Vec<CalloutRegion>,
    pub(super) fences: Vec<FenceBlock>,
    /// Fenced-code byte ranges (bodies included) for the "never inside code"
    /// exclusions.
    pub(super) code_ranges: Vec<(usize, usize)>,
    pub(super) info: Vec<LineInfo>,
    /// Which regions are rendered as an inline `Widget::Math` (single-line,
    /// outside fenced code), indexed like `math`.
    pub(super) math_inline: Vec<bool>,
    /// Indices into `math` rendered as `PreviewBlock`s (multi-line display,
    /// outside fenced code).
    pub(super) math_blocks: Vec<usize>,
}

impl Statics {
    pub(super) fn collect(text: &str) -> Statics {
        let lines = line_ranges(text);
        let math = scan_math(text);
        let fence_state = fence_state_scan(text);
        let callouts = compute_callout_regions(text, &fence_state, &math);
        let fences = fence_blocks(text, &lines);
        let last = lines.len().saturating_sub(1);

        let mut code_ranges = Vec::with_capacity(fences.len());
        let mut info = vec![LineInfo::default(); lines.len()];

        for f in &fences {
            code_ranges.push((f.from, f.to));
            let end = f.close_line.unwrap_or(last);
            for n in f.open_line..=end.min(last) {
                info[n].skip = Some(if n == f.open_line || f.close_line == Some(n) {
                    Skip::FenceLine
                } else {
                    Skip::CodeBody
                });
            }
        }

        let in_code =
            |from: usize, to: usize| code_ranges.iter().any(|(a, b)| from < *b && to > *a);
        let mut math_inline = vec![false; math.len()];
        let mut math_blocks = Vec::new();
        for (i, region) in math.iter().enumerate() {
            if in_code(region.from, region.to) {
                continue;
            }
            let first = line_of(&lines, region.from);
            let last_line = line_of(&lines, region.to.saturating_sub(1));
            if first == last_line {
                math_inline[i] = true;
                continue;
            }
            math_blocks.push(i);
            for n in first..=last_line.min(last) {
                if info[n].skip.is_none() {
                    info[n].skip = Some(Skip::MathBody);
                }
            }
        }

        for (ci, c) in callouts.iter().enumerate() {
            for (line_no, is_open) in [(c.open_line, true), (c.close_line, false)] {
                if !is_open && !c.closed {
                    continue;
                }
                let n = line_no.saturating_sub(1);
                if n <= last && info[n].skip.is_none() {
                    info[n].callout = Some((ci, is_open));
                    info[n].skip = Some(Skip::CalloutEdge);
                }
            }
        }

        classify_lines(text, &lines, &mut info);
        Statics {
            lines,
            math,
            callouts,
            fences,
            code_ranges,
            info,
            math_inline,
            math_blocks,
        }
    }
}

/// Fenced-code blocks: pairing mirrors [`fence_state_scan`] (same char, close
/// run at least as long, nothing after it) but keeps the block structure the
/// decorations need — the bool view of this scan is exactly that function.
fn fence_blocks(text: &str, lines: &[(usize, usize)]) -> Vec<FenceBlock> {
    let mut out = Vec::new();
    // (line, fence char offset, char, run length, info-string first word)
    let mut open: Option<(usize, usize, u8, usize, Option<String>)> = None;
    for (n, (from, to)) in lines.iter().enumerate() {
        let Some((ch, len, rest)) = parse_fence(&text[*from..*to]) else {
            continue;
        };
        match &open {
            None => {
                let lang = rest.trim().split_whitespace().next().map(|w| w.to_string());
                // TS `FencedCode.from` starts at the fence char, not the line.
                let indent = text[*from..*to]
                    .bytes()
                    .take_while(|b| *b == b' ')
                    .count()
                    .min(3);
                open = Some((n, *from + indent, ch, len, lang));
            }
            Some((open_line, open_from, open_ch, open_len, lang)) => {
                if ch == *open_ch && len >= *open_len && rest.trim().is_empty() {
                    out.push(FenceBlock {
                        open_line: *open_line,
                        close_line: Some(n),
                        from: *open_from,
                        to: *to,
                        lang: lang.clone(),
                    });
                    open = None;
                }
            }
        }
    }
    if let Some((open_line, open_from, _, _, lang)) = open {
        out.push(FenceBlock {
            open_line,
            close_line: None,
            from: open_from,
            to: text.len(),
            lang,
        });
    }
    out
}

/// Per-line shape pass. The paragraph state `(quote depth, container indent)`
/// implements the setext-underline eligibility and the "a list item can only
/// interrupt a paragraph when it has content / starts at 1" rule (CommonMark,
/// which the lezer tree this ports follows).
fn classify_lines(text: &str, lines: &[(usize, usize)], info: &mut [LineInfo]) {
    let bytes = text.as_bytes();
    let mut para: Option<(usize, usize)> = None;
    for (n, (from, to)) in lines.iter().enumerate() {
        let (from, to) = (*from, *to);
        if info[n].skip.is_some() {
            para = None;
            continue;
        }
        let (quotes, base) = quote_prefix(text, from, to);
        let depth = quotes.len();
        info[n].quotes = quotes;
        info[n].base = base;
        let mut cfrom = base;
        while cfrom < to && (bytes[cfrom] == b' ' || bytes[cfrom] == b'\t') {
            cfrom += 1;
        }
        let indent = cfrom - base;
        if cfrom >= to {
            para = None; // blank line (quote prefix only)
            continue;
        }
        // Block starts need either a shallow indent or a list-item paragraph
        // context at least as indented as this line.
        let deep_ok =
            indent <= 3 || para.is_some_and(|(q, pind)| q == depth && pind > 0 && indent >= pind);

        if deep_ok {
            if let Some(heading) = atx_heading(text, cfrom, to) {
                info[n].content_from = heading.content_from;
                info[n].heading = Some(heading);
                para = None;
                continue;
            }
            if let Some((ch, sfrom, sto)) = dash_line(text, cfrom, to) {
                if para.is_some_and(|(q, pind)| q == depth && indent >= pind) {
                    if ch == b'-' && sto - sfrom == 1 {
                        info[n].setext_dash = Some(SetextDash {
                            mark: (sfrom, sto),
                            ws_to: whitespace_end(text, sto, to),
                        });
                    }
                    info[n].content_from = cfrom;
                    para = None;
                    continue;
                }
            }
            if let Some(hr) = hr_line(text, cfrom, to) {
                info[n].content_from = cfrom;
                info[n].hr = Some(hr);
                para = None;
                continue;
            }
            if let Some(list) = list_item(text, cfrom, to) {
                // A list item interrupts a paragraph only when it has content
                // and (ordered) starts at 1, and only from an outer
                // container: an empty item at the paragraph's own indent is
                // either the setext ambiguity (handled above) or a paragraph
                // continuation (`- x\ncont\n- ` still opens a new item,
                // `para\n- ` does not).
                let same_container = para.is_some_and(|(q, pind)| q == depth && indent >= pind);
                let has_content = list.content_from < to;
                let ordered_one = !matches!(list.kind, ListKind::Ordered)
                    || ordered_number_is_one(text, list.mark);
                if !same_container || (has_content && ordered_one) {
                    let mut content_from = list.content_from;
                    let mut heading = None;
                    if let Some(h) = atx_heading(text, list.content_from, to) {
                        content_from = h.content_from;
                        heading = Some(h);
                    }
                    info[n].content_from = content_from;
                    info[n].heading = heading;
                    info[n].list = Some(ListInfo {
                        content_indent: list.content_from - base,
                        ..list
                    });
                    para = Some((depth, list.content_from - base));
                    continue;
                }
            }
        }
        info[n].content_from = cfrom;
        para = Some(match para {
            Some(p) if p.0 == depth => p,
            _ => (depth, indent),
        });
    }
}

/// Consumes leading `>` quote markers, returning the marker chunks (`>` plus
/// one following space/tab, per nesting level) and the container's content
/// start (TS `QuoteMark` children of nested `Blockquote` nodes). The chunks
/// are container context only — `decorateBlockquote` (livePreview.ts:913-928)
/// adds a line class and hides nothing, so no span is emitted for them.
fn quote_prefix(text: &str, from: usize, to: usize) -> (Vec<(usize, usize)>, usize) {
    let bytes = text.as_bytes();
    let mut chunks = Vec::new();
    let mut pos = from;
    loop {
        let mut p = pos;
        let mut spaces = 0;
        while p < to && spaces < 3 && bytes[p] == b' ' {
            p += 1;
            spaces += 1;
        }
        if p >= to || bytes[p] != b'>' {
            break;
        }
        let mut end = p + 1;
        if end < to && (bytes[end] == b' ' || bytes[end] == b'\t') {
            end += 1;
        }
        chunks.push((p, end));
        pos = end;
        if chunks.len() >= 32 {
            break; // defensive bound: absurd nesting depth
        }
    }
    (chunks, pos)
}

/// ATX heading at `pos`: `#{1,6}` followed by a space or the line end (the
/// lezer parser accepts only U+0020 there; `#\tH` is a paragraph). Only the
/// opening run plus the spaces after it are reported — `decorateHeading`
/// (livePreview.ts:807-838) takes the first `HeaderMark` child and hides
/// `mark.from..contentFrom`; a trailing closing `#` run is never hidden.
fn atx_heading(text: &str, pos: usize, to: usize) -> Option<HeadingInfo> {
    let bytes = text.as_bytes();
    let mut i = pos;
    while i < to && bytes[i] == b'#' {
        i += 1;
    }
    let level = i - pos;
    if level == 0 || level > 6 || (i < to && bytes[i] != b' ') {
        return None;
    }
    let mut content_from = i;
    while content_from < to && bytes[content_from] == b' ' {
        content_from += 1;
    }
    Some(HeadingInfo {
        prefix: (pos, content_from),
        content_from,
        level: level as u8,
    })
}

/// A line consisting of one run of `-` or `=` plus trailing whitespace — the
/// setext-underline shape (TS checks the `HeaderMark` text).
fn dash_line(text: &str, pos: usize, to: usize) -> Option<(u8, usize, usize)> {
    let bytes = text.as_bytes();
    let ch = *bytes.get(pos)?;
    if ch != b'-' && ch != b'=' {
        return None;
    }
    let mut i = pos;
    while i < to && bytes[i] == ch {
        i += 1;
    }
    if whitespace_end(text, i, to) != to {
        return None;
    }
    Some((ch, pos, i))
}

/// Horizontal rule: 3+ of the same `-`/`*`/`_`, spaces/tabs allowed between.
fn hr_line(text: &str, pos: usize, to: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let ch = *bytes.get(pos)?;
    if ch != b'-' && ch != b'*' && ch != b'_' {
        return None;
    }
    let mut count = 0usize;
    let mut end = pos;
    let mut i = pos;
    while i < to {
        match bytes[i] {
            b if b == ch => {
                count += 1;
                end = i + 1;
            }
            b' ' | b'\t' => {}
            _ => return None,
        }
        i += 1;
    }
    (count >= 3).then_some((pos, end))
}

/// A list item at `pos` (`- `/`* `/`+ `, `1.`/`1)`; GFM task when `[ ]`/`[x]`
/// is followed by whitespace).
fn list_item(text: &str, pos: usize, to: usize) -> Option<ListInfo> {
    let bytes = text.as_bytes();
    let first = *bytes.get(pos)?;
    let (mark_to, ordered) = if first == b'-' || first == b'*' || first == b'+' {
        (pos + 1, false)
    } else if first.is_ascii_digit() {
        let mut i = pos;
        while i < to && i - pos < 9 && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i >= to || (bytes[i] != b'.' && bytes[i] != b')') {
            return None;
        }
        (i + 1, true)
    } else {
        return None;
    };
    if mark_to < to && bytes[mark_to] != b' ' && bytes[mark_to] != b'\t' {
        return None;
    }
    let after_mark = whitespace_end(text, mark_to, to);
    let mut content_from = after_mark;
    let kind = if ordered {
        ListKind::Ordered
    } else if let Some((checked, task_from, task_to)) = task_marker(text, after_mark, to) {
        let trailing = whitespace_end(text, task_to, to);
        content_from = trailing;
        ListKind::Task {
            checked,
            task: (task_from, task_to),
            trailing,
        }
    } else {
        ListKind::Bullet
    };
    Some(ListInfo {
        mark: (pos, mark_to),
        kind,
        content_from,
        content_indent: 0, // filled by the caller, container-relative
    })
}

/// GFM task marker: `[ ]`/`[x]` right after the item's marker whitespace and
/// followed by whitespace (lezer: `/^\[[ xX]\][ \t]/`; `- [ ]` at EOL is not
/// a task).
fn task_marker(text: &str, pos: usize, to: usize) -> Option<(bool, usize, usize)> {
    let bytes = text.as_bytes();
    if pos + 3 >= to || bytes[pos] != b'[' || bytes[pos + 2] != b']' {
        return None;
    }
    let checked = match bytes[pos + 1] {
        b' ' => false,
        b'x' | b'X' => true,
        _ => return None,
    };
    if bytes[pos + 3] != b' ' && bytes[pos + 3] != b'\t' {
        return None;
    }
    Some((checked, pos, pos + 3))
}

fn ordered_number_is_one(text: &str, mark: (usize, usize)) -> bool {
    // `mark` is `digits + delimiter`; the digits are `[mark.0, mark.1 - 1)`.
    mark.1
        .checked_sub(1)
        .and_then(|digits_end| text.get(mark.0..digits_end))
        == Some("1")
}

/// End of the space/tab run starting at `pos`, capped at `limit` (TS
/// `whitespaceEnd`).
pub(super) fn whitespace_end(text: &str, pos: usize, limit: usize) -> usize {
    let bytes = text.as_bytes();
    let mut i = pos;
    while i < limit && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statics(text: &str) -> Statics {
        Statics::collect(text)
    }

    /// Line shape fixtures below were checked against the real lezer GFM
    /// parser (`@lezer/markdown` + GFM), which is what the TS decorations see.
    #[test]
    fn atx_heading_shape_matches_lezer() {
        let s = statics("# H1");
        let h = s.info[0].heading.clone().expect("heading");
        assert_eq!(h.prefix, (0, 2));
        assert_eq!(h.content_from, 2);
        // A closing `#` run is not part of the prefix: `decorateHeading`
        // (livePreview.ts:807-838) hides only the first HeaderMark plus the
        // spaces after it, never the trailing run.
        let s = statics("###  H3 ###   ");
        let h = s.info[0].heading.clone().expect("heading");
        assert_eq!(h.prefix, (0, 5));
        assert_eq!(h.content_from, 5);
        // Indented heading: the fence starts at the `#`.
        let s = statics("  # h");
        assert_eq!(s.info[0].heading.clone().expect("heading").prefix, (2, 4));
        // Non-headings (lezer): no space after the run, 7 hashes, a tab.
        for doc in ["#hashtag", "####### x", "#\tH"] {
            assert!(statics(doc).info[0].heading.is_none(), "{doc:?}");
        }
    }

    #[test]
    fn setext_dash_line_shape() {
        let doc = "段落行在此。\n- \n";
        let s = statics(doc);
        let dash = s.info[1].setext_dash.clone().expect("setext dash");
        assert_eq!(dash.mark, (19, 20));
        assert_eq!(dash.ws_to, 21);
        assert!(s.info[1].list.is_none());
        // `===` and multi-`-` underlines take the setext branch but carry no
        // dash decoration (TS `decorateSetextDash` bails on them).
        for doc in ["x\n===\n", "x\n---\n", "x\n--\n"] {
            let s = statics(doc);
            assert!(s.info[1].setext_dash.is_none(), "{doc:?}");
            assert!(s.info[1].hr.is_none(), "{doc:?} is a setext underline");
        }
    }

    #[test]
    fn dash_after_paragraph_resolves_like_lezer() {
        // `- ` after a paragraph is the setext ambiguity; `- ` at the start of
        // the document or after a list item is an empty list item.
        assert!(statics("- \n- \n").info[0].list.is_some());
        assert!(statics("- \n- \n").info[1].list.is_some());
        // A paragraph inside a list item keeps its own container: a dash line
        // at column zero closes the item instead of underlining it.
        let s = statics("- x\ncont\n- \n");
        assert!(s.info[2].list.is_some());
        assert!(s.info[2].setext_dash.is_none());
        // `---` after a paragraph is an underline; after a list item, a rule.
        let s = statics("- x\ncont\n---\n");
        assert!(
            s.info[2].hr.is_some(),
            "outside the item's indent it is a rule"
        );
        let s = statics("x\n\n---\n");
        assert!(s.info[2].hr.is_some());
        let s = statics("# h\n---\n");
        assert!(s.info[1].hr.is_some());
        let s = statics("```\nx\n```\n---\n");
        assert!(s.info[3].hr.is_some());
        // Indented continuation inside the item: it is an underline again.
        let s = statics("- x\n  ---\n");
        assert!(s.info[1].hr.is_none());
        assert!(s.info[1].heading.is_none());
    }

    #[test]
    fn list_and_task_shapes() {
        let s = statics("- [ ]  x\n- [ ]x\n- [ ]");
        assert!(matches!(
            s.info[0].list.as_ref().expect("list").kind,
            ListKind::Task {
                checked: false,
                task: (2, 5),
                trailing: 7
            }
        ));
        // No whitespace after `]`: a bullet, not a task (lezer GFM).
        assert!(matches!(
            s.info[1].list.as_ref().expect("list").kind,
            ListKind::Bullet
        ));
        assert!(matches!(
            s.info[2].list.as_ref().expect("list").kind,
            ListKind::Bullet
        ));
        let s = statics("- [X] x\n1. one\n1) one\n-\tx");
        assert!(matches!(
            s.info[0].list.as_ref().expect("list").kind,
            ListKind::Task { checked: true, .. }
        ));
        assert!(matches!(
            s.info[1].list.as_ref().expect("list").kind,
            ListKind::Ordered
        ));
        assert!(matches!(
            s.info[2].list.as_ref().expect("list").kind,
            ListKind::Ordered
        ));
        let mark = s.info[3].list.as_ref().expect("list").mark;
        assert_eq!(mark.0, s.lines[3].0);
        assert_eq!(mark.1 - mark.0, 1);
        // Not list markers: no space after the marker, >9 digits, `2.` cannot
        // interrupt a paragraph.
        for doc in ["-x", "1234567890. x", "--"] {
            assert!(statics(doc).info[0].list.is_none(), "{doc:?}");
        }
        let s = statics("para\n2. x\n- x");
        assert!(
            s.info[1].list.is_none(),
            "ordered item must start at 1 to interrupt"
        );
        assert!(s.info[2].list.is_some(), "bullet with content interrupts");
        // Indent is container-relative.
        let s = statics(">   - x");
        assert_eq!(s.info[0].base, 2);
        assert_eq!(s.info[0].list.as_ref().expect("list").content_indent, 4);
    }

    #[test]
    fn quote_prefixes_are_collected_per_level() {
        let s = statics("> > deep\n> lazy\nplain");
        assert_eq!(s.info[0].quotes, vec![(0, 2), (2, 4)]);
        assert_eq!(s.info[0].base, 4);
        assert_eq!(s.info[1].quotes, vec![(9, 11)]);
        assert!(s.info[2].quotes.is_empty());
        // A quote marker deeper than three columns is not one.
        assert!(statics("    > x").info[0].quotes.is_empty());
        // A quote-only line is blank (it ends a paragraph).
        let s = statics("> x\n> \n> ---\n");
        assert!(
            s.info[2].hr.is_some(),
            "blank quote line ends the paragraph"
        );
    }

    #[test]
    fn fence_blocks_carry_lang_and_node_range() {
        let s = statics("``` rust\ncode\n```\n");
        assert_eq!(s.fences.len(), 1);
        assert_eq!(s.fences[0].lang.as_deref(), Some("rust"));
        assert_eq!(s.fences[0].open_line, 0);
        assert_eq!(s.fences[0].close_line, Some(2));
        assert_eq!(s.fences[0].from, 0);
        assert_eq!(s.fences[0].to, 17);
        assert_eq!(s.info[0].skip, Some(Skip::FenceLine));
        assert_eq!(s.info[1].skip, Some(Skip::CodeBody));
        assert_eq!(s.info[2].skip, Some(Skip::FenceLine));
        // Only the first word of the info string is the language.
        assert_eq!(
            statics("```rust title=\"x\"\n").fences[0].lang.as_deref(),
            Some("rust")
        );
        // Indented fence: lezer's node starts at the fence char.
        assert_eq!(statics("  ```js\nx\n  ```\n").fences[0].from, 2);
        // Unclosed: runs to the end of the document.
        let s = statics("~~~\nx");
        assert_eq!(s.fences[0].close_line, None);
        assert_eq!(s.fences[0].to, 5);
        assert_eq!(s.info[1].skip, Some(Skip::CodeBody));
    }

    #[test]
    fn callout_edges_and_math_bodies_are_marked() {
        let s = statics("::: 提示\nbody\n:::\n");
        assert_eq!(s.info[0].callout, Some((0, true)));
        assert_eq!(s.info[0].skip, Some(Skip::CalloutEdge));
        assert_eq!(s.info[2].callout, Some((0, false)));
        assert!(s.info[1].callout.is_none(), "body lines are ordinary");
        // A `:::` inside a fence is literal.
        let s = statics("```\n:::\n```\n");
        assert!(s.info[1].callout.is_none());
        // Multi-line display math marks its lines; single-line does not.
        let s = statics("a\n$$\nx\n$$\nb");
        assert_eq!(s.info[1].skip, Some(Skip::MathBody));
        assert_eq!(s.info[3].skip, Some(Skip::MathBody));
        assert_eq!(s.info[4].skip, None);
        assert_eq!(s.math_blocks.len(), 1);
        let s = statics("a $$x$$ b");
        assert_eq!(s.math_inline, vec![true]);
        assert!(s.math_blocks.is_empty());
        // Maths inside fenced code are not regions at all.
        let s = statics("```\n$$\nx\n$$\n```\n");
        assert!(s.math_inline.iter().all(|inline| !inline));
        assert!(s.math_blocks.is_empty());
    }

    #[test]
    fn indented_code_lines_are_plain_text() {
        // Documented gap: `IndentedCode`/`CodeBlock` are not modelled.
        let s = statics("    code *x*\n");
        assert_eq!(s.info[0].list, None);
        assert_eq!(s.info[0].heading, None);
        assert_eq!(s.info[0].content_from, 4);
    }
}
