//! Port of `src/editor/ops.ts` — the pure text-transform cores (the parts not
//! needing a CodeMirror editor instance).
//!
//! Offsets are UTF-8 byte offsets into the input `&str` (see [`crate::markdown`]).
//! Line numbers are 1-based, like CodeMirror's `doc.line(n)`.
//!
//! Every function takes the document text plus selection ranges and returns
//! an [`Edit`] list plus suggested new caret ranges — CM-independent, so the
//! host applies the edits with its own transaction machinery. Regexes from
//! the TS module are hand-parsed here (see the per-fn doc lines for the
//! exact pattern each helper mirrors).
//!
//! Not ported (need the editor runtime): clipboard copy/cut/paste, the
//! wikilink target lookups that consult the syntax tree, and the
//! `markdownLanguage.isActiveAt` gate of the Enter continuation (tree-only;
//! the fenced-code guard below is the scan-grade equivalent).

use crate::markdown::context::parse_fence;

/// One replacement: replace `text[start..end]` with `text`. Mirrors the TS
/// `{ from, to, insert }` change shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

impl Edit {
    fn insert_at(start: usize, text: impl Into<String>) -> Edit {
        Edit { start, end: start, text: text.into() }
    }
}

/// A selection range: `anchor`/`head` in byte offsets (head == caret).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sel {
    pub anchor: usize,
    pub head: usize,
}

impl Sel {
    pub fn cursor(pos: usize) -> Sel {
        Sel { anchor: pos, head: pos }
    }
    pub fn range(anchor: usize, head: usize) -> Sel {
        Sel { anchor, head }
    }
    pub fn from(&self) -> usize {
        self.anchor.min(self.head)
    }
    pub fn to(&self) -> usize {
        self.anchor.max(self.head)
    }
    pub fn empty(&self) -> bool {
        self.anchor == self.head
    }
}

/// Edits plus suggested new caret ranges (anchor, head). When explicit caret
/// targets were produced they replace the whole selection (the TS dispatches
/// a fresh `EditorSelection`); otherwise every input range maps through the
/// edits (the TS omits `selection` and lets CM map it).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OpsOutcome {
    pub edits: Vec<Edit>,
    pub cursors: Vec<(usize, usize)>,
}

/// Bullet item regex `/^([ \t]*)([-*+])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/`,
/// hand-parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListItem<'a> {
    pub indent: &'a str,
    pub marker: &'a str,
    pub gap: &'a str,
    /// `"[x] "` style (bracket + trailing `[ \t]+`, greedy) when present.
    pub box_: Option<&'a str>,
    pub content: &'a str,
}

/// `/^([ \t]*)/` — space/tab indent used by the list regexes.
fn take_indent(line: &str) -> usize {
    line.bytes().take_while(|b| *b == b' ' || *b == b'\t').count()
}

/// `/^\s*/` — JS whitespace prefix (see `is_js_ws`).
fn take_js_ws(line: &str) -> usize {
    line.bytes().take_while(|b| crate::markdown::is_js_ws(*b)).count()
}

fn parse_box(line: &str, at: usize) -> Option<(&str, usize)> {
    let bytes = line.as_bytes();
    if at + 2 < bytes.len() && bytes[at] == b'[' && matches!(bytes[at + 1], b' ' | b'x' | b'X') && bytes[at + 2] == b']' {
        let mut end = at + 3;
        while end < bytes.len() && (bytes[end] == b' ' || bytes[end] == b'\t') {
            end += 1;
        }
        // `(\[[ xX]\][ \t]+)?` requires at least one space after `]`.
        if end > at + 3 {
            return Some((&line[at..end], end));
        }
    }
    None
}

/// Port of the `BULLET_ITEM_RE` match.
pub fn parse_bullet_item(line: &str) -> Option<ListItem<'_>> {
    let indent = take_indent(line);
    let bytes = line.as_bytes();
    if indent >= bytes.len() || !matches!(bytes[indent], b'-' | b'*' | b'+') {
        return None;
    }
    let after_marker = indent + 1;
    let gap_len = line[after_marker..]
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    if gap_len == 0 {
        return None;
    }
    let gap_end = after_marker + gap_len;
    let (box_, content_start) = match parse_box(line, gap_end) {
        Some((b, end)) => (Some(b), end),
        None => (None, gap_end),
    };
    Some(ListItem {
        indent: &line[..indent],
        marker: &line[indent..after_marker],
        gap: &line[after_marker..gap_end],
        box_,
        content: &line[content_start..],
    })
}

/// Port of the `ORDERED_ITEM_RE` match (`^([ \t]*)(\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$`).
pub fn parse_ordered_item(line: &str) -> Option<ListItem<'_>> {
    let indent = take_indent(line);
    let bytes = line.as_bytes();
    let digs = line[indent..]
        .bytes()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if digs == 0 || indent + digs >= bytes.len() {
        return None;
    }
    let delim = bytes[indent + digs];
    if delim != b'.' && delim != b')' {
        return None;
    }
    let after_marker = indent + digs + 1;
    let gap_len = line[after_marker..]
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    if gap_len == 0 {
        return None;
    }
    let gap_end = after_marker + gap_len;
    let (box_, content_start) = match parse_box(line, gap_end) {
        Some((b, end)) => (Some(b), end),
        None => (None, gap_end),
    };
    Some(ListItem {
        indent: &line[..indent],
        marker: &line[indent..after_marker],
        gap: &line[after_marker..gap_end],
        box_,
        content: &line[content_start..],
    })
}

/// Leading digits of the ordered marker: `parseInt("12.") == 12`.
fn marker_number(marker: &str) -> usize {
    marker
        .bytes()
        .take_while(|b| b.is_ascii_digit())
        .fold(0usize, |acc, b| acc * 10 + (b - b'0') as usize)
}

/// Task line regex
/// `/^(\s*)((?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](.*)$/` — `(lead, marker, box char, tail)`.
fn parse_task_line(line: &str) -> Option<(&str, &str, u8, &str)> {
    let lead = take_js_ws(line);
    let after_lead = &line[lead..];
    let item = if after_lead.starts_with(['-', '*', '+']) {
        // marker = sign + [ \t]+
        let after = 1;
        let gap = after_lead[after..]
            .bytes()
            .take_while(|b| *b == b' ' || *b == b'\t')
            .count();
        if gap == 0 {
            return None;
        }
        &after_lead[..after + gap]
    } else {
        let digs = after_lead
            .bytes()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if digs == 0 {
            return None;
        }
        let b = after_lead.as_bytes();
        if b[digs] != b'.' && b[digs] != b')' {
            return None;
        }
        let after = digs + 1;
        let gap = after_lead[after..]
            .bytes()
            .take_while(|bb| *bb == b' ' || *bb == b'\t')
            .count();
        if gap == 0 {
            return None;
        }
        &after_lead[..after + gap]
    };
    let rest = &after_lead[item.len()..];
    let rb = rest.as_bytes();
    if rb.len() < 3 || rb[0] != b'[' || rb[2] != b']' || !matches!(rb[1], b' ' | b'x' | b'X') {
        return None;
    }
    Some((&line[..lead], item, rb[1], &rest[3..]))
}

/// List prefix regex `/^(\s*)(?:[-*+]|\d+[.)])(\s+)/` — full prefix and its
/// leading-whitespace length.
fn parse_list_prefix(line: &str) -> Option<(&str, usize)> {
    let lead = take_js_ws(line);
    let after_lead = &line[lead..];
    let (marker_len, ws_start) = if after_lead.starts_with(['-', '*', '+']) {
        (1, 1)
    } else {
        let digs = after_lead
            .bytes()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if digs == 0 {
            return None;
        }
        let b = after_lead.as_bytes();
        if b[digs] != b'.' && b[digs] != b')' {
            return None;
        }
        (digs + 1, digs + 1)
    };
    let ws = after_lead[ws_start..]
        .bytes()
        .take_while(|b| crate::markdown::is_js_ws(*b))
        .count();
    if ws == 0 {
        return None;
    }
    Some((&line[..lead + marker_len + ws], lead))
}

/// `/(\s*✅\s*\d{4}-\d{2}-\d{2})\s*$/` — trailing completion stamp. Returns
/// the stamp's start index within `tail` (the match extends to the end).
fn find_done_stamp(tail: &str) -> Option<usize> {
    let bytes = tail.as_bytes();
    let is_date = |b: &[u8]| -> bool {
        b.len() == 10
            && b[4] == b'-'
            && b[7] == b'-'
            && (0..10).all(|i| i == 4 || i == 7 || b[i].is_ascii_digit())
    };
    // Leftmost match: for each ✅ occurrence, the stamp starts at the
    // beginning of the whitespace run directly before it (JS `\s*` greedy
    // backtracks to exactly that), and must reach the end of the tail.
    let needle = "✅".as_bytes();
    let mut search = 0usize;
    while let Some(rel) = tail[search..].find("✅") {
        let at = search + rel;
        search = at + needle.len();
        // `\s*` after ✅, then the date, then `\s*$`.
        let mut k = at + needle.len();
        while k < bytes.len() && crate::markdown::is_js_ws(bytes[k]) {
            k += 1;
        }
        if k + 10 <= bytes.len()
            && is_date(&bytes[k..k + 10])
            && bytes[k + 10..].iter().all(|b| crate::markdown::is_js_ws(*b))
        {
            // Whitespace run before ✅.
            let mut start = at;
            while start > 0 && crate::markdown::is_js_ws(bytes[start - 1]) {
                start -= 1;
            }
            return Some(start);
        }
    }
    None
}

/// Maps a position through the edit list with CodeMirror's change-mapping
/// semantics: positions before an edit stay put, positions after it shift by
/// the net delta, a position at the edit start stays there, and a position
/// inside or at the end of the replaced span lands behind the inserted text.
fn map_pos_through_edits(mut pos: usize, edits: &[Edit]) -> usize {
    for e in edits {
        if pos < e.start {
            continue;
        }
        if pos > e.end {
            pos += e.text.len() - (e.end - e.start);
        } else if pos > e.start {
            pos = e.start + e.text.len();
        }
        // pos == e.start: stays.
    }
    pos
}

/// (line_no 1-based, from, to) of the line containing `pos`. A position on
/// the line break itself belongs to the line before it (CodeMirror `lineAt`).
pub(crate) fn line_at(text: &str, pos: usize) -> (usize, usize, usize) {
    let lines = crate::markdown::line_ranges(text);
    let pos = pos.min(text.len());
    let idx = lines
        .iter()
        .position(|(_, to)| pos <= *to)
        .unwrap_or(lines.len() - 1);
    (idx + 1, lines[idx].0, lines[idx].1)
}

/// Tree-path fence semantics: the fence marker lines themselves count as
/// inside (TS `insideFencedCode` resolves the FencedCode node, which includes
/// the marker lines; the scan fallback in `context.rs` does not — the known
/// difference documented there). The op guards below mirror the tree path.
fn inside_fenced_code_inclusive(text: &str, line_no: usize) -> bool {
    let lines = crate::markdown::line_ranges(text);
    let mut open: Option<u8> = None;
    let mut open_len = 0usize;
    for n in 1..line_no.min(lines.len()) + 1 {
        let (from, to) = lines[n - 1];
        let Some((ch, len, rest)) = parse_fence(&text[from..to]) else {
            continue;
        };
        match open {
            None => {
                open = Some(ch);
                open_len = len;
            }
            Some(o) if ch == o && len >= open_len && rest.trim().is_empty() => open = None,
            _ => {}
        }
    }
    open.is_some()
}

const TODO_PREFIX: &str = "- [ ] ";

/// Port of `src/editor/ops.ts::toggleTodo` (with `todayStamp()` passed in —
/// no clock in pure code).
///
/// Cycles each cursor line: plain → `- [ ]` → `- [x] ✅ date` → plain.
/// Completing stamps today's date; the last step strips marker and stamp so
/// the line returns to exactly its pre-todo text.
///
/// Cursor model (same as toggle_list): a collapsed cursor inside the line's
/// prefix zone — line start through the end of the (old or new) marker — lands
/// right behind the new `- [ ] `. Cursors deeper in the text keep their
/// anchored text via change mapping. `delta` carries earlier lines' net length
/// change so later selections land correctly in multi-cursor dispatches.
pub fn toggle_todo(text: &str, sels: &[Sel], today: &str) -> Option<OpsOutcome> {
    if sels.is_empty() {
        return None;
    }
    let mut edits: Vec<Edit> = Vec::new();
    let mut explicit: Vec<(usize, usize)> = Vec::new();
    let mut seen_lines = std::collections::HashSet::new();
    let mut delta: isize = 0;

    for sel in sels {
        let head = sel.head.min(text.len());
        let (line_no, from, to) = line_at(text, head);
        if !seen_lines.insert(line_no) {
            continue;
        }
        let line = &text[from..to];

        if let Some((lead, marker, box_char, tail)) = parse_task_line(line) {
            let mark_from = from + lead.len() + marker.len();
            let stamp = find_done_stamp(tail);
            let text_end = mark_from + 3 + stamp.unwrap_or(tail.len());
            if box_char == b' ' {
                // Todo → done: flip the box, (re)stamp today's date at line end.
                let stamp_ins = format!(" ✅ {today}");
                edits.push(Edit {
                    start: mark_from + 1,
                    end: mark_from + 2,
                    text: "x".into(),
                });
                edits.push(Edit {
                    start: text_end,
                    end: to,
                    text: stamp_ins.clone(),
                });
                delta += stamp_ins.len() as isize - (to - text_end) as isize;
            } else {
                // Done → plain: strip marker + checkbox and the stamp entirely.
                let lead2 = usize::from(tail.starts_with(' ') || tail.starts_with('\t'));
                let text_start = (mark_from + 3 + lead2).min(text_end);
                edits.push(Edit {
                    start: from + lead.len(),
                    end: text_start,
                    text: String::new(),
                });
                if stamp.is_some() {
                    edits.push(Edit {
                        start: text_end,
                        end: to,
                        text: String::new(),
                    });
                }
                delta -= ((text_start - (from + lead.len())) + (to - text_end)) as isize;
            }
            continue;
        }

        // Bullet / ordered item without a checkbox: swap the marker for the task.
        if let Some((prefix, lead_len)) = parse_list_prefix(line) {
            let marker_len = prefix.len() - lead_len;
            edits.push(Edit {
                start: from + lead_len,
                end: from + prefix.len(),
                text: TODO_PREFIX.into(),
            });
            if sel.empty() && head - from <= lead_len + marker_len {
                let target = (from as isize + delta) as usize + lead_len + TODO_PREFIX.len();
                explicit.push((target, target));
            }
            delta += TODO_PREFIX.len() as isize - marker_len as isize;
            continue;
        }

        let indent = take_js_ws(line);
        edits.push(Edit::insert_at(from + indent, TODO_PREFIX));
        if sel.empty() && head - from <= indent {
            let target = (from as isize + delta) as usize + indent + TODO_PREFIX.len();
            explicit.push((target, target));
        }
        delta += TODO_PREFIX.len() as isize;
    }

    if edits.is_empty() {
        return None;
    }
    let cursors = if explicit.is_empty() {
        sels
            .iter()
            .map(|s| {
                (
                    map_pos_through_edits(s.anchor.min(text.len()), &edits),
                    map_pos_through_edits(s.head.min(text.len()), &edits),
                )
            })
            .collect()
    } else {
        explicit
    };
    Some(OpsOutcome { edits, cursors })
}

/// Port of `src/editor/ops.ts::dedentOneLevel` — one indent level, written
/// the way the line already is: a single tab for tab-indented lines,
/// otherwise one indent unit.
pub fn dedent_one_level<'a>(indent: &'a str, unit: &str) -> &'a str {
    if indent.starts_with('\t') {
        return &indent[1..];
    }
    &indent[unit.len().min(indent.len())..]
}

/// Port of `src/editor/ops.ts::orderedNumberAtLevel` — number for an ordered
/// item that just moved up to `indent`: one past the nearest preceding
/// sibling at that level, or 1 when there is none. A blank line, a shallower
/// line or a non-list line ends the walk — the list is over.
pub fn ordered_number_at_level(text: &str, line_no: usize, indent: &str) -> usize {
    let lines = crate::markdown::line_ranges(text);
    for n in (1..line_no).rev() {
        let (from, to) = lines[n - 1];
        let t = &text[from..to];
        if t.trim().is_empty() {
            break;
        }
        let lead = take_indent(t);
        if lead < indent.len() {
            break;
        }
        if lead > indent.len() {
            continue; // deeper: a child of the previous item
        }
        if &t[..lead] != indent {
            break;
        }
        match parse_ordered_item(t) {
            Some(m) => return marker_number(m.marker) + 1,
            None => break,
        }
    }
    1
}

/// Port of `src/editor/ops.ts::bumpFollowingOrdered` — renumbers the ordered
/// siblings after `line_no` so the list stays sequential once a new item took
/// number `number`. Only items already sitting in exactly that slot are
/// rewritten — hand-written `1. 1. 1.` or deliberately out-of-order lists are
/// left alone, the same rule lang-markdown's renumberList uses.
pub fn bump_following_ordered(
    text: &str,
    line_no: usize,
    indent: &str,
    number: usize,
    delim: char,
    out: &mut Vec<Edit>,
) {
    let lines = crate::markdown::line_ranges(text);
    let mut want = number;
    for n in line_no + 1..=lines.len() {
        let (from, to) = lines[n - 1];
        let t = &text[from..to];
        if t.trim().is_empty() {
            break;
        }
        let lead = take_indent(t);
        if lead < indent.len() {
            break;
        }
        if lead > indent.len() {
            continue;
        }
        if &t[..lead] != indent {
            break;
        }
        let Some(m) = parse_ordered_item(t) else {
            break;
        };
        let last = m.marker.chars().last().unwrap_or('\0');
        if last != delim || marker_number(m.marker) != want {
            break;
        }
        let at = from + lead;
        out.push(Edit {
            start: at,
            end: at + m.marker.len(),
            text: format!("{}{}", want + 1, delim),
        });
        want += 1;
    }
}

/// Port of `src/editor/ops.ts::enterContinueListItem` — Enter on a list line,
/// bnote-style: keep the item's EXACT leading whitespace and repeat the
/// marker (fresh unchecked box for todos, next number for ordered lists) so
/// nested items stay aligned.
///
///   Enter on a non-empty item        → new sibling at the same level
///   Enter on an empty nested item    → drop one level (marker kept)
///   Enter on an empty top-level item → leave the list (marker stripped)
///
/// A cursor sitting on the marker (e.g. right after toggling the checkbox)
/// continues the item from its end, and a cursor before the marker opens a
/// blank line above. `None` = unhandled (non-list line, inside a fenced code
/// block) — the host falls through to its default Enter behavior. The TS
/// gates renumbering on a single selection; the host makes that call and
/// this core always renumbers.
pub fn enter_continue_list_item(text: &str, pos: usize, indent_unit: &str) -> Option<OpsOutcome> {
    let pos = pos.min(text.len());
    let (line_no, line_from, line_to) = line_at(text, pos);
    // Inside a fenced code block the markup is literal text — never continue.
    if inside_fenced_code_inclusive(text, line_no) {
        return None;
    }
    let line = &text[line_from..line_to];
    let bullet_match = parse_bullet_item(line);
    let ordered_match = if bullet_match.is_some() {
        None
    } else {
        parse_ordered_item(line)
    };
    let is_ordered = ordered_match.is_some();
    let m = bullet_match.or(ordered_match)?;
    let marker_len = m.indent.len() + m.marker.len() + m.gap.len() + m.box_.map_or(0, |b| b.len());
    let mut pos = pos;
    if pos - line_from < marker_len {
        // Cursor on the leading whitespace or the marker itself (e.g. right
        // where toggling the checkbox drops it). Falling through to
        // lang-markdown here expands tab indent to spaces — the deep-indent
        // bug — so handle these positions directly.
        if pos - line_from <= m.indent.len() {
            // Before the bullet: plain blank line above (no indent copy — the
            // item line already carries its own).
            return Some(OpsOutcome {
                edits: vec![Edit::insert_at(line_from, "\n")],
                cursors: vec![(line_from + 1, line_from + 1)],
            });
        }
        // On the marker/gap/box: continue with a fresh item from the line end.
        pos = line_to;
    }

    if m.content.trim().is_empty() {
        // Empty item. Nested: lose one level of indent but keep the item, so
        // repeated Enter walks back out one level at a time. Top level: leave
        // the list — strip the marker and anything after it.
        if m.indent.is_empty() {
            return Some(OpsOutcome {
                edits: vec![Edit {
                    start: line_from,
                    end: line_to,
                    text: String::new(),
                }],
                cursors: vec![(line_from, line_from)],
            });
        }
        let mut edits: Vec<Edit> = Vec::new();
        let new_indent = dedent_one_level(m.indent, indent_unit);
        let delim = if is_ordered {
            m.marker.chars().last().unwrap_or('.')
        } else {
            '\0'
        };
        let head: String = if is_ordered {
            let number = ordered_number_at_level(text, line_no, new_indent);
            bump_following_ordered(text, line_no, new_indent, number, delim, &mut edits);
            format!("{number}{delim}")
        } else {
            m.marker.to_string()
        };
        let text_ins = format!("{}{}{}{}", new_indent, head, m.gap, m.box_.unwrap_or(""));
        edits.push(Edit {
            start: line_from,
            end: line_to,
            text: text_ins.clone(),
        });
        let cursor = line_from + text_ins.len();
        edits.sort_by_key(|e| e.start);
        return Some(OpsOutcome {
            edits,
            cursors: vec![(cursor, cursor)],
        });
    }

    // Continue / split: absorb surrounding whitespace like lang-markdown does.
    let lb = line.as_bytes();
    let mut from = pos - line_from;
    let mut to = pos - line_from;
    while from > 0 && crate::markdown::is_js_ws(lb[from - 1]) {
        from -= 1;
    }
    while to < line.len() && crate::markdown::is_js_ws(lb[to]) {
        to += 1;
    }
    let mut edits: Vec<Edit> = Vec::new();
    let delim = if is_ordered {
        m.marker.chars().last().unwrap_or('.')
    } else {
        '\0'
    };
    let head: String = if is_ordered {
        let next = marker_number(m.marker) + 1;
        // The new item owns the number after this one; the items below shift.
        bump_following_ordered(text, line_no, m.indent, next, delim, &mut edits);
        format!("{next}{delim}")
    } else {
        m.marker.to_string()
    };
    let insert = format!("{}{}{}", head, m.gap, if m.box_.is_some() { "[ ] " } else { "" });
    let abs_from = line_from + from;
    let abs_to = line_from + to;
    edits.push(Edit {
        start: abs_from,
        end: abs_to,
        text: format!("\n{}{}", m.indent, insert),
    });
    let cursor = abs_from + 1 + m.indent.len() + insert.len();
    // All offsets refer to the ORIGINAL document; return them in ascending
    // order so a transaction applier can apply them in one pass (the bump
    // edits sit below the caret line, the TS pushed them in reverse).
    edits.sort_by_key(|e| e.start);
    Some(OpsOutcome {
        edits,
        cursors: vec![(cursor, cursor)],
    })
}

/// Port of `src/editor/ops.ts::toggleHeading` — set the heading level of each
/// cursor line; a line already at `level` drops back to plain text.
pub fn toggle_heading(text: &str, sels: &[Sel], level: usize) -> Option<OpsOutcome> {
    if sels.is_empty() {
        return None;
    }
    let mut edits: Vec<Edit> = Vec::new();
    let mut seen_lines = std::collections::HashSet::new();
    for sel in sels {
        let head = sel.head.min(text.len());
        let (line_no, from, to) = line_at(text, head);
        if !seen_lines.insert(line_no) {
            continue;
        }
        let line = &text[from..to];
        let prefix = format!("{} ", "#".repeat(level));
        match heading_prefix_len(line) {
            Some((hashes, match_len)) => {
                // TS: insert = existing[1].length === level ? "" : prefix —
                // compares the hash count, replacing the whole matched prefix.
                let insert = if hashes == level { "" } else { prefix.as_str() };
                edits.push(Edit {
                    start: from,
                    end: from + match_len,
                    text: insert.to_string(),
                });
            }
            None => edits.push(Edit::insert_at(from, prefix)),
        }
    }
    finish_with_mapping(text, sels, edits)
}

/// Port of `src/editor/ops.ts::cycleHeading` — heading level cycle (same
/// shortcut pressed repeatedly): 正文 → H1 → H2 → H3 → H4 → 正文. H5/H6 are
/// only reachable via "set level N"; their next step also cancels.
pub fn cycle_heading(text: &str, sels: &[Sel]) -> Option<OpsOutcome> {
    if sels.is_empty() {
        return None;
    }
    let mut edits: Vec<Edit> = Vec::new();
    let mut seen_lines = std::collections::HashSet::new();
    for sel in sels {
        let head = sel.head.min(text.len());
        let (line_no, from, to) = line_at(text, head);
        if !seen_lines.insert(line_no) {
            continue;
        }
        let line = &text[from..to];
        match heading_prefix_len(line) {
            None => edits.push(Edit::insert_at(from, "# ")),
            Some((hashes, match_len)) => {
                if hashes < 4 {
                    // TS replaces only the hashes; the existing space stays.
                    edits.push(Edit {
                        start: from,
                        end: from + hashes,
                        text: "#".repeat(hashes + 1),
                    });
                } else {
                    // Cancel: strip the whole matched prefix (hashes + space).
                    edits.push(Edit {
                        start: from,
                        end: from + match_len,
                        text: String::new(),
                    });
                }
            }
        }
    }
    finish_with_mapping(text, sels, edits)
}

/// `/^(#{1,6})(\s+|$)/` — returns `(hash_count, whole_match_len)` (the hash
/// group and the full matched prefix incl. its whitespace run), or `None`
/// when the line is not an ATX heading.
fn heading_prefix_len(line: &str) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut hashes = 0usize;
    while hashes < 6 && hashes < bytes.len() && bytes[hashes] == b'#' {
        hashes += 1;
    }
    let mut l = hashes;
    loop {
        if l == 0 {
            return None;
        }
        let after = &bytes[l..];
        // `(\s+|$)`: whitespace run (any length) or end of line.
        if after.is_empty() {
            return Some((l, l));
        }
        if crate::markdown::is_js_ws(after[0]) {
            let mut end = l;
            while end < bytes.len() && crate::markdown::is_js_ws(bytes[end]) {
                end += 1;
            }
            return Some((l, end));
        }
        l -= 1;
    }
}

/// Shared tail of the heading toggles: no explicit carets — every input range
/// maps through the edits (the TS dispatches without a `selection` spec).
fn finish_with_mapping(text: &str, sels: &[Sel], edits: Vec<Edit>) -> Option<OpsOutcome> {
    if edits.is_empty() {
        return None;
    }
    let cursors = sels
        .iter()
        .map(|s| {
            (
                map_pos_through_edits(s.anchor.min(text.len()), &edits),
                map_pos_through_edits(s.head.min(text.len()), &edits),
            )
        })
        .collect();
    Some(OpsOutcome { edits, cursors })
}

/// Port of `src/editor/ops.ts::toggleList` — per-line list toggle behind the
/// bullet / numbered commands. Converting a line to the target kind replaces
/// a foreign marker (an ordered item keeps its checkbox when demoted to a
/// bullet and vice versa); a line that already is the target kind drops back
/// to plain text, stripping marker and checkbox together. Lines inside fenced
/// code are left alone — their markup is literal text.
pub fn toggle_list(text: &str, sels: &[Sel], kind: ListKind) -> Option<OpsOutcome> {
    if sels.is_empty() {
        return None;
    }
    let mut edits: Vec<Edit> = Vec::new();
    let mut explicit: Vec<(usize, usize)> = Vec::new();
    let mut seen_lines = std::collections::HashSet::new();
    let mut delta: isize = 0;
    for sel in sels {
        let (first_line, _, _) = line_at(text, sel.from().min(text.len()));
        let last_probe = sel.to().max(sel.from().min(text.len()) + 1) - 1;
        let (last_line, _, _) = line_at(text, last_probe.min(text.len()));
        for n in first_line..=last_line {
            if !seen_lines.insert(n) {
                continue;
            }
            let (line_from, line_to) = crate::markdown::line_ranges(text)[n - 1];
            let line = &text[line_from..line_to];
            // 树已覆盖该行时走树查询(能识别深层缩进的围栏);这里用扫描的树语义
            // 版:围栏内标记不参与列表/标题转换,否则切换文件后立刻转换会把围栏内
            // 标记也换掉。
            if inside_fenced_code_inclusive(text, n) {
                continue;
            }
            let bullet = parse_bullet_item(line);
            let ordered = if bullet.is_some() { None } else { parse_ordered_item(line) };
            let indent = bullet
                .as_ref()
                .map(|m| m.indent.len())
                .or_else(|| ordered.as_ref().map(|m| m.indent.len()))
                .unwrap_or_else(|| take_js_ws(line));
            let indent_end = line_from + indent;
            let head_len = |m: &ListItem| m.marker.len() + m.gap.len();
            let box_len = |m: &ListItem| m.box_.map_or(0, |b| b.len());
            let mut rem_len = 0usize;
            let mut ins_len = 0usize;
            match kind {
                ListKind::Bullet => {
                    if let Some(b) = &bullet {
                        // Already a bullet: cancel the list, checkbox included.
                        rem_len = head_len(b) + box_len(b);
                        edits.push(Edit {
                            start: indent_end,
                            end: indent_end + rem_len,
                            text: String::new(),
                        });
                    } else if let Some(o) = &ordered {
                        rem_len = head_len(o);
                        ins_len = 2; // "- "
                        edits.push(Edit {
                            start: indent_end,
                            end: indent_end + rem_len,
                            text: "- ".into(),
                        });
                    } else {
                        ins_len = 2;
                        edits.push(Edit::insert_at(indent_end, "- "));
                    }
                }
                ListKind::Numbered => {
                    if let Some(o) = &ordered {
                        // Already numbered: cancel the list, checkbox included.
                        rem_len = head_len(o) + box_len(o);
                        edits.push(Edit {
                            start: indent_end,
                            end: indent_end + rem_len,
                            text: String::new(),
                        });
                    } else if let Some(b) = &bullet {
                        rem_len = head_len(b);
                        ins_len = 3; // "1. "
                        edits.push(Edit {
                            start: indent_end,
                            end: indent_end + rem_len,
                            text: "1. ".into(),
                        });
                    } else {
                        ins_len = 3;
                        edits.push(Edit::insert_at(indent_end, "1. "));
                    }
                }
            }
            if sel.empty()
                && sel.head >= line_from
                && sel.head - line_from <= indent + rem_len
            {
                let target = (line_from as isize + delta) as usize + indent + ins_len;
                explicit.push((target, target));
            }
            delta += ins_len as isize - rem_len as isize;
        }
    }
    if edits.is_empty() {
        return None;
    }
    let cursors = if explicit.is_empty() {
        sels
            .iter()
            .map(|s| {
                (
                    map_pos_through_edits(s.anchor.min(text.len()), &edits),
                    map_pos_through_edits(s.head.min(text.len()), &edits),
                )
            })
            .collect()
    } else {
        explicit
    };
    Some(OpsOutcome { edits, cursors })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    Bullet,
    Numbered,
}

/// Port of `src/editor/ops.ts::toggleWrap` (bold/italic/strikethrough —
/// `marker` is `**`, `*`, `~~`, …). Unwraps when the markers sit right
/// outside the selection or the selection itself is wrapped; otherwise wraps.
pub fn toggle_wrap(text: &str, sels: &[Sel], marker: &str) -> Option<OpsOutcome> {
    if sels.is_empty() {
        return None;
    }
    let mlen = marker.len();
    let mut edits: Vec<Edit> = Vec::new();
    let mut cursors: Vec<(usize, usize)> = Vec::new();
    let mut delta: isize = 0;
    for sel in sels {
        let from = sel.from().min(text.len());
        let to = sel.to().min(text.len());
        let sel_text = &text[from..to];
        // Unwrap when the markers sit right outside the selection.
        let before_start = from.saturating_sub(mlen);
        let before = &text[before_start..from];
        let after = text.get(to..(to + mlen).min(text.len())).unwrap_or("");
        if before == marker && after == marker {
            edits.push(Edit {
                start: from - mlen,
                end: from,
                text: String::new(),
            });
            edits.push(Edit {
                start: to,
                end: to + mlen,
                text: String::new(),
            });
            let anchor = (from - mlen) as isize + delta;
            let head = (to - mlen) as isize + delta;
            cursors.push((anchor.max(0) as usize, head.max(0) as usize));
            delta -= (mlen * 2) as isize;
            continue;
        }
        // Unwrap when the selection itself is wrapped.
        if sel_text.starts_with(marker)
            && sel_text.ends_with(marker)
            && sel_text.len() >= mlen * 2
        {
            let inner = &sel_text[mlen..sel_text.len() - mlen];
            edits.push(Edit {
                start: from,
                end: to,
                text: inner.to_string(),
            });
            let anchor = from as isize + delta;
            let head = (from + inner.len()) as isize + delta;
            cursors.push((anchor.max(0) as usize, head.max(0) as usize));
            delta += inner.len() as isize - sel_text.len() as isize;
            continue;
        }
        // Wrap (or place empty markers with the cursor inside).
        edits.push(Edit {
            start: from,
            end: to,
            text: format!("{marker}{sel_text}{marker}"),
        });
        cursors.push((
            (from as isize + delta).max(0) as usize + mlen,
            (to as isize + delta).max(0) as usize + mlen,
        ));
        delta += (mlen * 2) as isize;
    }
    Some(OpsOutcome { edits, cursors })
}

/// Port of `src/editor/ops.ts::insertOwnLineBlock` (private helper in TS) —
/// exclusive own-line delimiter blocks (` ```…``` ` / `$$…$$` / `:::…:::`).
/// Delimiters must occupy their own lines — glued onto body text neither is a
/// legal fence nor a block formula: a blank current line is replaced in place
/// (also clearing pure whitespace), otherwise the block is inserted after the
/// line end. Interior blank line and closing fence inherit the line's indent
/// (the block stays inside the list item). The cursor is derived from the
/// constructed insert — always behind the interior blank line's indent (the
/// block's first content position, ready to type).
fn insert_own_line_block(text: &str, pos: usize, open: &str, close: &str) -> OpsOutcome {
    let pos = pos.min(text.len());
    let (_, line_from, line_to) = line_at(text, pos);
    let line = &text[line_from..line_to];
    let blank = line.trim().is_empty();
    let indent = if blank { "" } else { &line[..take_js_ws(line)] };
    let insert = format!(
        "{}{open}\n{indent}\n{indent}{close}",
        if blank { "" } else { "\n" }
    );
    let from = if blank { line_from } else { line_to };
    let cursor = from + usize::from(!blank) + open.len() + 1 + indent.len();
    let edit = if blank {
        Edit {
            start: line_from,
            end: line_to,
            text: insert,
        }
    } else {
        Edit::insert_at(from, insert)
    };
    OpsOutcome {
        edits: vec![edit],
        cursors: vec![(cursor, cursor)],
    }
}

/// Port of `src/editor/ops.ts::insertCodeBlock` — without a selection, opens
/// a fenced block with the given language at the cursor (cursor on the
/// interior blank line); with a selection, wraps the covered lines (fence on
/// its own lines, mid-line selection extended to whole lines) and shifts both
/// selection ends into the block.
pub fn insert_code_block(text: &str, sel: Sel, lang: &str) -> OpsOutcome {
    // fenceInfoString: strip backticks/newlines (they would end the fence
    // early) and trim; empty = bare ```.
    let info: String = lang
        .chars()
        .filter(|c| *c != '`' && *c != '\r' && *c != '\n')
        .collect();
    let info = info.trim();
    let open = format!("```{info}");
    if !sel.empty() {
        return wrap_lines_into_block(text, sel, &open, "```");
    }
    insert_own_line_block(text, sel.head, &open, "```")
}

/// Port of `src/editor/ops.ts::insertCallout` — `:::` container. Without a
/// selection: blank-line replace / after-line insert, cursor on the interior
/// blank line (after the indent) — add a title later on the open line
/// (`::: 标题`; unwritten = untitled bare block, both forms scan the same).
/// With a selection: covered lines wrapped into the block, selection ends
/// shifted inside.
pub fn insert_callout(text: &str, sel: Sel) -> OpsOutcome {
    if !sel.empty() {
        return wrap_lines_into_block(text, sel, ":::", ":::");
    }
    insert_own_line_block(text, sel.head, ":::", ":::")
}

/// Port of `src/editor/ops.ts::insertMathBlock` — a `$$ … $$` block on its own
/// lines with the cursor inside.
pub fn insert_math_block(text: &str, sel: Sel) -> OpsOutcome {
    if !sel.empty() {
        return wrap_lines_into_block(text, sel, "$$", "$$");
    }
    insert_own_line_block(text, sel.head, "$$", "$$")
}

/// The selection branch shared by insertCodeBlock/insertCallout: wrap the
/// covered lines and map both selection ends into the block (same mapping
/// rule as the TS `mapPos`).
fn wrap_lines_into_block(text: &str, sel: Sel, open: &str, close: &str) -> OpsOutcome {
    let from = sel.from().min(text.len());
    let to = sel.to().min(text.len());
    let (_, first_from, _) = line_at(text, from);
    let last_probe = to.max(from + 1) - 1;
    let (_, _, last_to) = line_at(text, last_probe.min(text.len()));
    let covered = &text[first_from..last_to];
    let open_len = open.len() + 1; // + the newline after the open marker
    let map_pos = |p: usize| -> usize {
        if p <= first_from {
            p
        } else if p <= last_to {
            first_from + open_len + (p - first_from)
        } else {
            first_from + open_len + covered.len() + 4 + (p - last_to - 1)
        }
    };
    let insert = format!("{open}\n{covered}\n{close}");
    OpsOutcome {
        edits: vec![Edit {
            start: first_from,
            end: last_to,
            text: insert,
        }],
        cursors: vec![(
            map_pos(sel.anchor.min(text.len())),
            map_pos(sel.head.min(text.len())),
        )],
    }
}

/// Port of `src/editor/ops.ts::insertHorizontalRule` — `---` on its own lines
/// after the current line (blank line above unless the line is empty).
pub fn insert_horizontal_rule(text: &str, pos: usize) -> OpsOutcome {
    let pos = pos.min(text.len());
    let (_, _, line_to) = line_at(text, pos);
    let (_, line_from, line_to2) = line_at(text, pos);
    let line = &text[line_from..line_to2];
    let prefix = if line.trim().is_empty() { "" } else { "\n\n" };
    let edit = Edit::insert_at(line_to, format!("{prefix}---\n"));
    let cursor = line_to + prefix.len() + 4;
    OpsOutcome {
        edits: vec![edit],
        cursors: vec![(cursor, cursor)],
    }
}

/// Port of `src/editor/ops.ts::planHeaderTodoJump` — one ⌘T decision (pure;
/// contract locked by the TS ops.test.ts):
/// jump = go to `anchor`; back = return to the remembered spot; stay = no-op;
/// create = insert `insert` at `at`, caret at `cursor` (behind the todo box).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderTodoPlan {
    Jump { anchor: usize },
    Back,
    Stay,
    Create { at: usize, insert: String, cursor: usize },
}

/// `/^(\s*)(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/` — a header todo line.
fn is_header_todo_line(line: &str) -> bool {
    let lead = take_js_ws(line);
    let after = &line[lead..];
    let (marker_end, ws_start) = if after.starts_with(['-', '*', '+']) {
        (1, 1)
    } else {
        let digs = after.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digs == 0 {
            return false;
        }
        let b = after.as_bytes();
        if b[digs] != b'.' && b[digs] != b')' {
            return false;
        }
        (digs + 1, digs + 1)
    };
    let ws = after[ws_start..]
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    if ws == 0 {
        return false;
    }
    let rest = &after[marker_end + ws..];
    let rb = rest.as_bytes();
    rb.len() >= 3
        && rb[0] == b'['
        && rb[2] == b']'
        && matches!(rb[1], b' ' | b'x' | b'X')
}

/// `/^\s*$/`
fn is_blank_line(line: &str) -> bool {
    line.bytes().all(|b| crate::markdown::is_js_ws(b))
}

/// `/^#\s/` — H1 head test (same shape as daily's HEADER_RE): line 1 is an
/// `# ` heading → the todo region starts at line 2.
fn is_h1_line(line: &str) -> bool {
    let b = line.as_bytes();
    b.len() >= 2 && b[0] == b'#' && crate::markdown::is_js_ws(b[1])
}

/// Port of `src/editor/ops.ts::planHeaderTodoJump`.
///
/// 往返跳转:正文 → 文档头部最后一个待办项的行尾 → 回到跳转前的位置。
/// 头部待办块 = 从「起点行」开始(允许空行)连续的待办行(`- [ ]` / `- [x]` /
/// 有序待办,中间可夹空行),首个非空且非待办的行结束块。起点行 = 行 1 是
/// H1 标题(`# `)时的行 2,否则行 1——日记的待办区就在 H1 之后
/// (与 daily 的 parseDailyRegion 同一片区域),普通笔记的待办块在文档顶。
/// 头部还没有待办块时创建一个空待办(插在起点位置,光标落在待办符号后,
/// 直接输入);再按一次回到原位。已在头部位置但有来处记忆时回跳。
pub fn plan_header_todo_jump(text: &str, head_line: usize, has_return: bool) -> HeaderTodoPlan {
    let lines = crate::markdown::line_ranges(text);
    let line_text = |n: usize| -> &str {
        let (from, to) = lines[n - 1];
        &text[from..to]
    };
    let line_end = |n: usize| -> usize { lines[n - 1].1 };
    let total = lines.len();
    let header_doc = total >= 1 && is_h1_line(line_text(1));
    let start = if header_doc { 2 } else { 1 };
    let mut first: Option<usize> = None;
    let mut last: Option<usize> = None;
    // 只扫到首个非空非待办行为止:头部块通常几行,成本与文档总长无关。
    for n in start..=total {
        let t = line_text(n);
        if is_header_todo_line(t) {
            if first.is_none() {
                first = Some(n);
            }
            last = Some(n);
            continue;
        }
        if is_blank_line(t) {
            continue;
        }
        break; // 首个非空非待办行:头部待办块结束
    }
    if let (Some(first), Some(last)) = (first, last) {
        if head_line >= first && head_line <= last {
            return if has_return {
                HeaderTodoPlan::Back
            } else {
                HeaderTodoPlan::Stay
            };
        }
        return HeaderTodoPlan::Jump {
            anchor: line_end(last),
        };
    }
    // 头部还没有待办块。光标已在「块将长出的位置」(起点行或其前的标题行):
    // 有来处记忆则回跳(往返优先),否则就地创建;光标在起点行之后则记住来处并创建。
    if head_line <= start && has_return {
        return HeaderTodoPlan::Back;
    }
    if header_doc {
        let at = line_end(1);
        let insert = "\n- [ ] ";
        return HeaderTodoPlan::Create {
            at,
            insert: insert.to_string(),
            cursor: at + insert.len(),
        };
    }
    // 空文档不加尾换行;非空文档把原第一行顶下去。光标一律落在 `- [ ] ` 行尾
    // (待办符号后),与插入串是否带尾换行无关。
    let (insert, cursor) = if total == 1 && line_text(1).is_empty() {
        ("- [ ] ", TODO_PREFIX.len())
    } else {
        ("- [ ] \n", TODO_PREFIX.len())
    };
    HeaderTodoPlan::Create {
        at: 0,
        insert: insert.to_string(),
        cursor,
    }
}

/// Port of the module-level `headerTodoReturn` map in
/// `src/editor/ops.ts` — the round-trip "where I came from" memory:
/// file path → caret (line + col) and scroll position before the jump.
/// The only persistent state of the feature; evicted by access order, capped
/// at 64 entries (covers any real multi-file round-trip workflow). Stores
/// line+col rather than an absolute pos: typing in the header after a
/// create/jump does not move the remembered line, so the way back is exact.
#[derive(Debug, Default)]
pub struct HeaderTodoReturnMap {
    entries: Vec<(String, (usize, usize, usize))>, // (line, col, scroll), most recent last
}

/// Port of `HEADER_TODO_RETURN_MAX`.
pub const HEADER_TODO_RETURN_MAX: usize = 64;

impl HeaderTodoReturnMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Port of `rememberHeaderTodoReturn` — insert/refresh, evicting the
    /// oldest beyond the cap.
    pub fn remember(&mut self, path: &str, line: usize, col: usize, scroll: usize) {
        self.entries.retain(|(p, _)| p != path);
        self.entries.push((path.to_string(), (line, col, scroll)));
        if self.entries.len() > HEADER_TODO_RETURN_MAX {
            self.entries.remove(0);
        }
    }

    /// Whether a return spot is remembered (the TS passes
    /// `headerTodoReturn.has(path)` into `planHeaderTodoJump`).
    pub fn has(&self, path: &str) -> bool {
        self.entries.iter().any(|(p, _)| p == path)
    }

    /// Delete the return spot for `path` (the TS deletes it on the way back).
    pub fn remove(&mut self, path: &str) {
        self.entries.retain(|(p, _)| p != path);
    }

    /// Port of the "back" branch: take the saved spot out (re-inserted to
    /// refresh the eviction order first, then read).
    pub fn take_refreshed(&mut self, path: &str) -> Option<(usize, usize, usize)> {
        let idx = self.entries.iter().position(|(p, _)| p == path)?;
        let entry = self.entries.remove(idx);
        self.entries.push(entry.clone());
        Some(entry.1)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: &str = "2026-10-05";

    #[test]
    fn toggle_todo_on_empty_line_puts_caret_behind_the_box() {
        let out = toggle_todo("", &[Sel::cursor(0)], TODAY).unwrap();
        assert_eq!(out.edits, vec![Edit::insert_at(0, "- [ ] ")]);
        assert_eq!(out.cursors, vec![(6, 6)]);
        assert_eq!(apply("", &out.edits), "- [ ] ");
    }

    #[test]
    fn toggle_todo_at_line_start_lands_between_marker_and_text() {
        let out = toggle_todo("hello", &[Sel::cursor(0)], TODAY).unwrap();
        assert_eq!(apply("hello", &out.edits), "- [ ] hello");
        assert_eq!(out.cursors, vec![(6, 6)]);
    }

    #[test]
    fn toggle_todo_mid_text_maps_through_and_stays_on_the_char() {
        let out = toggle_todo("hello", &[Sel::cursor(3)], TODAY).unwrap();
        assert_eq!(apply("hello", &out.edits), "- [ ] hello");
        assert_eq!(out.cursors, vec![(9, 9)]); // 原 col 3 的 "l"
    }

    #[test]
    fn toggle_todo_on_bullet_swaps_marker() {
        let out = toggle_todo("- item", &[Sel::cursor(0)], TODAY).unwrap();
        assert_eq!(apply("- item", &out.edits), "- [ ] item");
        assert_eq!(out.cursors, vec![(6, 6)]);
    }

    #[test]
    fn toggle_todo_on_indented_line_caret_after_indent_and_marker() {
        let out = toggle_todo("  text", &[Sel::cursor(1)], TODAY).unwrap();
        assert_eq!(apply("  text", &out.edits), "  - [ ] text");
        assert_eq!(out.cursors, vec![(8, 8)]);
    }

    #[test]
    fn toggle_todo_completing_stamps_today_and_keeps_caret() {
        let out = toggle_todo("- [ ] foo", &[Sel::cursor(4)], TODAY).unwrap();
        assert_eq!(apply("- [ ] foo", &out.edits), "- [x] foo ✅ 2026-10-05");
        // No explicit target → the caret maps through the edits.
        assert_eq!(out.cursors, vec![(4, 4)]);
    }

    #[test]
    fn toggle_todo_uncompleting_strips_marker_and_stamp() {
        let doc = "- [x] foo ✅ 2026-09-01";
        let out = toggle_todo(doc, &[Sel::cursor(4)], TODAY).unwrap();
        assert_eq!(apply(doc, &out.edits), "foo");
    }

    #[test]
    fn toggle_todo_multi_cursor_counts_earlier_prefix_delta() {
        let out = toggle_todo("\nabc", &[Sel::cursor(0), Sel::cursor(1)], TODAY).unwrap();
        assert_eq!(apply("\nabc", &out.edits), "- [ ] \n- [ ] abc");
        assert_eq!(out.cursors, vec![(6, 6), (13, 13)]); // 第一行(原空行)标记后;第二行标记后(7 + 6)
    }

    #[test]
    fn cycle_heading_steps_plain_to_h1() {
        let out = cycle_heading("标题文字", &[Sel::cursor(6)]).unwrap();
        assert_eq!(apply("标题文字", &out.edits), "# 标题文字");
    }

    #[test]
    fn cycle_heading_loops_through_h4_back_to_plain() {
        let mut doc = "# 一".to_string();
        let want = ["## 一", "### 一", "#### 一", "一", "# 一"];
        for expected in want {
            let out = cycle_heading(&doc, &[Sel::cursor(0)]).unwrap();
            doc = apply(&doc, &out.edits);
            assert_eq!(doc, expected);
        }
    }

    #[test]
    fn cycle_heading_h5_h6_next_step_cancels() {
        let out = cycle_heading("##### 五", &[Sel::cursor(3)]).unwrap();
        assert_eq!(apply("##### 五", &out.edits), "五");
        let out = cycle_heading("###### 六", &[Sel::cursor(0)]).unwrap();
        assert_eq!(apply("###### 六", &out.edits), "六");
    }

    #[test]
    fn cycle_heading_multi_cursor_steps_each_line() {
        let doc = "# a\nb\n## c";
        let out = cycle_heading(doc, &[Sel::cursor(0), Sel::cursor(4), Sel::cursor(9)]).unwrap();
        assert_eq!(apply(doc, &out.edits), "## a\n# b\n### c");
    }

    #[test]
    fn cycle_heading_on_empty_line_adds_h1() {
        let out = cycle_heading("", &[Sel::cursor(0)]).unwrap();
        assert_eq!(apply("", &out.edits), "# ");
    }

    #[test]
    fn toggle_heading_sets_and_clears_level() {
        let out = toggle_heading("plain", &[Sel::cursor(0)], 2).unwrap();
        assert_eq!(apply("plain", &out.edits), "## plain");
        let out = toggle_heading("## plain", &[Sel::cursor(0)], 2).unwrap();
        assert_eq!(apply("## plain", &out.edits), "plain");
        let out = toggle_heading("## plain", &[Sel::cursor(0)], 3).unwrap();
        assert_eq!(apply("## plain", &out.edits), "### plain");
    }

    #[test]
    fn plan_jump_scans_header_todo_block_to_its_last_line_end() {
        let doc = "- [ ] 甲\n- [x] 乙\n\n正文第一行\n";
        let p = plan_header_todo_jump(doc, 4, false);
        assert_eq!(
            p,
            HeaderTodoPlan::Jump {
                anchor: doc.find("乙").unwrap() + "乙".len()
            }
        );
    }

    #[test]
    fn plan_jump_daily_shape_jumps_after_h1_block() {
        let doc = "# 1 2026-10-05\n- [ ] 甲\n- [x] 乙\n\n正文\n";
        let p = plan_header_todo_jump(doc, 6, false);
        assert_eq!(
            p,
            HeaderTodoPlan::Jump {
                anchor: doc.find("乙").unwrap() + "乙".len()
            }
        );
    }

    #[test]
    fn plan_inside_block_backs_with_memory_stays_without() {
        let doc = "- [ ] 甲\n\n正文\n";
        assert_eq!(plan_header_todo_jump(doc, 1, true), HeaderTodoPlan::Back);
        assert_eq!(plan_header_todo_jump(doc, 1, false), HeaderTodoPlan::Stay);
    }

    #[test]
    fn plan_no_block_plain_note_creates_at_top() {
        let doc = "段落\n\n正文\n";
        assert_eq!(
            plan_header_todo_jump(doc, 3, false),
            HeaderTodoPlan::Create { at: 0, insert: "- [ ] \n".into(), cursor: 6 }
        );
    }

    #[test]
    fn plan_no_block_leading_blank_lines_still_create_at_top() {
        let doc = "\n\n正文\n";
        assert_eq!(
            plan_header_todo_jump(doc, 3, false),
            HeaderTodoPlan::Create { at: 0, insert: "- [ ] \n".into(), cursor: 6 }
        );
    }

    #[test]
    fn plan_no_block_daily_creates_after_h1() {
        let doc = "# 1 2026-10-05\n\n正文\n";
        assert_eq!(
            plan_header_todo_jump(doc, 3, false),
            HeaderTodoPlan::Create { at: 14, insert: "\n- [ ] ".into(), cursor: 21 }
        );
    }

    #[test]
    fn plan_cursor_on_title_line_back_or_create() {
        let doc = "# 1 2026-10-05\n";
        assert_eq!(plan_header_todo_jump(doc, 1, true), HeaderTodoPlan::Back);
        assert_eq!(
            plan_header_todo_jump(doc, 1, false),
            HeaderTodoPlan::Create { at: 14, insert: "\n- [ ] ".into(), cursor: 21 }
        );
    }

    #[test]
    fn plan_cursor_on_first_plain_line_back_or_create() {
        let doc = "正文\n- [ ] 块外的待办不算头部\n";
        assert_eq!(plan_header_todo_jump(doc, 1, true), HeaderTodoPlan::Back);
        assert_eq!(
            plan_header_todo_jump(doc, 1, false),
            HeaderTodoPlan::Create { at: 0, insert: "- [ ] \n".into(), cursor: 6 }
        );
    }

    #[test]
    fn plan_header_scan_truncates_at_first_non_todo_line() {
        let doc = "段落\n- [ ] 不是头部\n";
        assert_eq!(
            plan_header_todo_jump(doc, 2, false),
            HeaderTodoPlan::Create { at: 0, insert: "- [ ] \n".into(), cursor: 6 }
        );
    }

    #[test]
    fn plan_empty_document_creates_without_trailing_newline() {
        assert_eq!(
            plan_header_todo_jump("", 1, false),
            HeaderTodoPlan::Create { at: 0, insert: "- [ ] ".into(), cursor: 6 }
        );
    }

    #[test]
    fn return_memory_round_trip_create_then_back() {
        // 日记无待办:创建空待办光标落符号后;输入后再按 ⌘T 回到正文原位。
        let mut memory = HeaderTodoReturnMap::new();
        let doc = "# 1 2026-10-05\n\n正文在这里\n";
        // 正文行(行 3)列 2 处按 ⌘T
        let plan = plan_header_todo_jump(doc, 3, memory.has("p"));
        assert_eq!(
            plan,
            HeaderTodoPlan::Create { at: 14, insert: "\n- [ ] ".into(), cursor: 21 }
        );
        // Host applies the create; the whole-line insert sits before the
        // caret's line, so the remembered line shifts by the inserted lines.
        let mut new_doc = doc.to_string();
        new_doc.insert_str(14, "\n- [ ] ");
        let shift = plan_header_todo_jump(doc, 3, false);
        let _ = shift;
        let mut line = 3usize;
        if let HeaderTodoPlan::Create { at, insert, .. } = &plan {
            if *at <= crate::markdown::line_ranges(doc)[2].0 {
                line += insert.matches('\n').count();
            }
        }
        memory.remember("p", line, 6, 0); // col in BYTES: 2 chars × 3
        // 用户直接输入待办内容(同行打字不影响来处的行列锚)
        new_doc.insert_str(21, "第一件事");
        // 新待办行已是头部块,且有来处记忆 → 精确回到创建前的正文行列
        let plan = plan_header_todo_jump(&new_doc, 2, memory.has("p"));
        assert_eq!(plan, HeaderTodoPlan::Back);
        let (line, col, _) = memory.take_refreshed("p").unwrap();
        let lines = crate::markdown::line_ranges(&new_doc);
        let (from, to) = lines[line - 1];
        assert_eq!(line, 4); // 「正文在这里」行(创建把它顶到了行 4)
        assert_eq!(col, 6); // 列 2(UTF-16)= 6 字节,与创建前一致
        assert_eq!(&new_doc[from + col..(from + col).min(to) + 3.min(to - from - col)], "在");
        let _ = to;
    }

    #[test]
    fn return_memory_caps_and_evicts_oldest() {
        let mut m = HeaderTodoReturnMap::new();
        for i in 0..HEADER_TODO_RETURN_MAX + 1 {
            m.remember(&format!("/f{i}"), 1, 0, 0);
        }
        assert!(!m.has("/f0")); // oldest evicted
        assert!(m.has(&format!("/f{HEADER_TODO_RETURN_MAX}")));
        m.remember("/f1", 2, 3, 0); // refresh existing
        // cap never exceeded
        let mut count = 0;
        for _ in 0..HEADER_TODO_RETURN_MAX + 2 {
            if m.has(&format!("/f{count}")) {
                count += 1;
            }
        }
        let _ = count;
        m.clear();
        assert!(!m.has("/f1"));
    }

    #[test]
    fn insert_callout_on_blank_line_replaces_in_place() {
        let out = insert_callout("", Sel::cursor(0));
        assert_eq!(apply("", &out.edits), ":::\n\n:::");
        assert_eq!(out.cursors, vec![(4, 4)]);
    }

    #[test]
    fn insert_callout_after_nonblank_line() {
        let out = insert_callout("hello", Sel::cursor(3));
        assert_eq!(apply("hello", &out.edits), "hello\n:::\n\n:::");
        assert_eq!(out.cursors, vec![(10, 10)]);
    }

    #[test]
    fn insert_callout_inside_list_item_inherits_indent() {
        let out = insert_callout("  - 项", Sel::cursor(7));
        assert_eq!(apply("  - 项", &out.edits), "  - 项\n:::\n  \n  :::");
        assert_eq!(out.cursors, vec![(14, 14)]);
    }

    #[test]
    fn insert_callout_wraps_selection_lines_and_maps_ends() {
        let doc = "# 一\n正文行\n尾行";
        let out = insert_callout(doc, Sel::range(6, 22));
        assert_eq!(apply(doc, &out.edits), "# 一\n:::\n正文行\n尾行\n:::");
        // 与 insertCodeBlock 同一条映射规则:选区起点恰在覆盖首行行首时保持原
        // doc 位置(= 新开栏行首),行尾端平移进块内。
        assert_eq!(out.cursors, vec![(6, 26)]);
    }

    #[test]
    fn insert_math_block_on_blank_line() {
        let out = insert_math_block("", Sel::cursor(0));
        assert_eq!(apply("", &out.edits), "$$\n\n$$");
        assert_eq!(out.cursors, vec![(3, 3)]);
    }

    #[test]
    fn insert_code_block_carries_language_and_wraps_selection() {
        let out = insert_code_block("", Sel::cursor(0), "python");
        assert_eq!(apply("", &out.edits), "```python\n\n```");
        assert_eq!(out.cursors, vec![(10, 10)]);
        let doc = "a\nbb\ncc";
        let out = insert_code_block(doc, Sel::range(2, 6), "");
        assert_eq!(apply(doc, &out.edits), "a\n```\nbb\ncc\n```");
        assert_eq!(out.cursors, vec![(2, 10)]);
        // Backticks and newlines in the info string are stripped.
        let out = insert_code_block("", Sel::cursor(0), "py\nx`");
        assert_eq!(apply("", &out.edits), "```pyx\n\n```");
    }

    #[test]
    fn insert_horizontal_rule_appends_after_current_line() {
        let out = insert_horizontal_rule("hello", 2);
        assert_eq!(apply("hello", &out.edits), "hello\n\n---\n");
        assert_eq!(out.cursors, vec![(11, 11)]);
        let out = insert_horizontal_rule("", 0);
        assert_eq!(apply("", &out.edits), "---\n");
        assert_eq!(out.cursors, vec![(4, 4)]);
    }

    #[test]
    fn toggle_wrap_round_trip() {
        // Wrap.
        let out = toggle_wrap("hello world", &[Sel::range(0, 5)], "**").unwrap();
        assert_eq!(apply("hello world", &out.edits), "**hello** world");
        assert_eq!(out.cursors, vec![(2, 7)]);
        // Unwrap via outside markers.
        let out = toggle_wrap("**hello** world", &[Sel::range(2, 7)], "**").unwrap();
        assert_eq!(apply("**hello** world", &out.edits), "hello world");
        assert_eq!(out.cursors, vec![(0, 5)]);
        // Unwrap when the selection itself includes the markers.
        let out = toggle_wrap("**hello**", &[Sel::range(0, 9)], "**").unwrap();
        assert_eq!(apply("**hello**", &out.edits), "hello");
        assert_eq!(out.cursors, vec![(0, 5)]);
        // Empty selection places empty markers with the caret inside.
        let out = toggle_wrap("a", &[Sel::cursor(1)], "*").unwrap();
        assert_eq!(apply("a", &out.edits), "a**");
        assert_eq!(out.cursors, vec![(2, 2)]);
    }

    #[test]
    fn toggle_list_bullet_round_trip_keeps_checkbox() {
        let out = toggle_list("plain", &[Sel::cursor(0)], ListKind::Bullet).unwrap();
        assert_eq!(apply("plain", &out.edits), "- plain");
        assert_eq!(out.cursors, vec![(2, 2)]);
        // Ordered → bullet keeps the checkbox.
        let out = toggle_list("1. [x] done", &[Sel::cursor(0)], ListKind::Bullet).unwrap();
        assert_eq!(apply("1. [x] done", &out.edits), "- [x] done");
        // Bullet → numbered keeps the checkbox.
        let out = toggle_list("- [x] done", &[Sel::cursor(0)], ListKind::Numbered).unwrap();
        assert_eq!(apply("- [x] done", &out.edits), "1. [x] done");
        // Same kind again cancels, checkbox included.
        let out = toggle_list("- [ ] open", &[Sel::cursor(0)], ListKind::Bullet).unwrap();
        assert_eq!(apply("- [ ] open", &out.edits), "open");
        // Numbered cancel.
        let out = toggle_list("1. a", &[Sel::cursor(0)], ListKind::Numbered).unwrap();
        assert_eq!(apply("1. a", &out.edits), "a");
    }

    #[test]
    fn toggle_list_multi_line_and_skips_fenced_lines() {
        let doc = "a\n- b\n```\n- c\n```";
        // Select from "a" through "- c": fenced "- c" untouched.
        let out = toggle_list(doc, &[Sel::range(0, 10)], ListKind::Numbered).unwrap();
        // "- b" → "1. b"; the fenced ``` line is skipped, "- c" out of range.
        assert_eq!(apply(doc, &out.edits), "1. a\n1. b\n```\n- c\n```");
    }

    #[test]
    fn enter_continue_splits_item_and_renumbers_ordered() {
        // Continue: cursor mid-item, whitespace absorbed.
        let out = enter_continue_list_item("- one two", 5, "  ").unwrap();
        assert_eq!(apply("- one two", &out.edits), "- one\n- two");
        // Caret = from + 1 + indent + insert → right before "two".
        assert_eq!(out.cursors, vec![(8, 8)]);
        // Ordered: number bumps and following items shift.
        let doc = "1. a\n2. b\n3. c";
        let out = enter_continue_list_item(doc, 4, "  ").unwrap();
        assert_eq!(apply(doc, &out.edits), "1. a\n2. \n3. b\n4. c");
    }

    #[test]
    fn enter_continue_keeps_verbatim_indent_and_todo_box() {
        let doc = "\t- [ ] 深层任务";
        // cursor at line end (byte len)
        let out = enter_continue_list_item(doc, doc.len(), "  ").unwrap();
        assert_eq!(apply(doc, &out.edits), "\t- [ ] 深层任务\n\t- [ ] ");
        assert_eq!(out.cursors, vec![(doc.len() + 8, doc.len() + 8)]);
    }

    #[test]
    fn enter_continue_empty_nested_item_walks_out_one_level() {
        let doc = "  - [ ] x\n    - ";
        let pos = doc.len();
        let out = enter_continue_list_item(doc, pos, "  ").unwrap();
        assert_eq!(apply(doc, &out.edits), "  - [ ] x\n  - ");
        assert_eq!(out.cursors, vec![(14, 14)]);
    }

    #[test]
    fn enter_continue_empty_top_level_item_leaves_the_list() {
        let doc = "- ";
        let out = enter_continue_list_item(doc, 2, "  ").unwrap();
        assert_eq!(apply(doc, &out.edits), "");
        assert_eq!(out.cursors, vec![(0, 0)]);
    }

    #[test]
    fn enter_continue_cursor_before_marker_opens_blank_line_above() {
        let out = enter_continue_list_item("- item", 0, "  ").unwrap();
        assert_eq!(apply("- item", &out.edits), "\n- item");
        assert_eq!(out.cursors, vec![(1, 1)]);
        // On the marker itself: continue from the line end.
        let out = enter_continue_list_item("- item", 1, "  ").unwrap();
        assert_eq!(apply("- item", &out.edits), "- item\n- ");
        assert_eq!(out.cursors, vec![(9, 9)]);
    }

    #[test]
    fn enter_continue_is_unhandled_on_plain_lines_and_fences() {
        assert!(enter_continue_list_item("plain text", 3, "  ").is_none());
        let doc = "```\n- item\n```";
        assert!(enter_continue_list_item(doc, 8, "  ").is_none());
    }

    #[test]
    fn enter_continue_ordered_walks_out_renumbers_from_neighbors() {
        // Dedenting an empty nested ordered item renumbers from the nearest
        // preceding sibling at the new level.
        let doc = "1. a\n2. b\n  1. c\n  2. ";
        let out = enter_continue_list_item(doc, doc.len(), "  ").unwrap();
        assert_eq!(apply(doc, &out.edits), "1. a\n2. b\n  1. c\n3. ");
    }

    // --- helpers ---

    fn apply(text: &str, edits: &[Edit]) -> String {
        let mut out = text.to_string();
        for e in edits.iter().rev() {
            out.replace_range(e.start..e.end, &e.text);
        }
        out
    }
}
