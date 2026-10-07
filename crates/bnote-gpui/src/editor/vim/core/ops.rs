//! Operator application: turns (operator, range, kind) into an
//! [`Execution`] plan the host applies in one pass.
//!
//! Contract for [`Execution::edits`]: every `Edit.range` is expressed against
//! the *original* document and the host applies the edits in **descending
//! `range.start` order** (equal starts: later vec entry first), so earlier
//! offsets stay valid. The core guarantees disjoint or empty ranges.

use super::doc::{
    char_at, first_non_blank, last_line, line_end, line_index, line_range, line_start, VimText,
};
use super::motion::{char_before};
use super::state::{Mode, Operator, RegisterContent, Registers, VimState};

/// One replacement: `range` (original-document bytes) → `text`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Edit {
    pub range: std::ops::Range<usize>,
    pub text: String,
}

/// Where the cursor goes after an execution.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CursorPlan {
    /// Normal-mode cursor (empty selection).
    Collapse(usize),
    /// Visual-mode selection: the anchor stays fixed, the head is the
    /// active end. The host renders `min..=max` (head char included) and
    /// keeps the cursor on `head`.
    Select { anchor: usize, head: usize },
}

/// Undo hints for the host's undo manager.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[allow(dead_code)] // `New` reserved: transaction-boundary hints for the host undo manager
pub enum UndoIntent {
    #[default]
    None,
    New,
}

/// Requests the host performs outside the text model.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HostIntent {
    Undo,
    Redo,
    OpenSearch,
    /// `zz`/`zt`/`zb`: put the cursor's row at the viewport center/top/
    /// bottom without moving the caret (the host owns the pixels).
    Scroll(ScrollAnchor),
}

/// Where in the viewport a `z` scroll puts the cursor's row.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScrollAnchor {
    Center,
    Top,
    Bottom,
}

/// The result of one executed command.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Execution {
    pub edits: Vec<Edit>,
    pub cursor: Option<CursorPlan>,
    pub mode_after: Option<Mode>,
    pub undo: UndoIntent,
    /// Text the host should mirror into the system clipboard (`"+` writes).
    pub clipboard_write: Option<String>,
    /// Range to flash (yank feedback).
    pub flash: Option<std::ops::Range<usize>>,
    pub host_intents: Vec<HostIntent>,
}

impl Execution {
    pub fn nothing() -> Self {
        Execution::default()
    }

    pub fn with_cursor(mut self, cursor: CursorPlan) -> Self {
        self.cursor = Some(cursor);
        self
    }

    pub fn with_mode(mut self, mode: Mode) -> Self {
        self.mode_after = Some(mode);
        self
    }

    pub fn with_edit(mut self, range: std::ops::Range<usize>, text: impl Into<String>) -> Self {
        self.edits.push(Edit {
            range,
            text: text.into(),
        });
        self
    }

    pub fn with_flash(mut self, range: std::ops::Range<usize>) -> Self {
        self.flash = Some(range);
        self
    }

    pub fn with_intent(mut self, intent: HostIntent) -> Self {
        self.host_intents.push(intent);
        self
    }
}

/// Everything a command needs from the host for one `feed` call.
#[derive(Clone, Debug)]
#[allow(dead_code)] // selection: consumed by visual-mode ops as they land
pub struct HostContext {
    /// Active cursor (the selection's active end), UTF-8 byte offset.
    pub cursor: usize,
    /// Active selection (start..end bytes, end exclusive).
    pub selection: std::ops::Range<usize>,
    /// First and last visible line indices (for H/M/L).
    pub viewport: super::motion::Viewport,
    /// Indent step for `>`/`<`.
    pub shiftwidth: usize,
    /// System clipboard text (reads of register `+`).
    pub clipboard: Option<String>,
}

impl Default for HostContext {
    fn default() -> Self {
        HostContext {
            cursor: 0,
            selection: 0..0,
            viewport: super::motion::Viewport::default(),
            shiftwidth: 4,
            clipboard: None,
        }
    }
}

/// The whole feed result.
#[derive(Clone, Debug)]
pub enum Outcome {
    /// Not a vim command in this mode. The host still swallows printable
    /// keys in Normal/Visual (vim owns them), lets chords through.
    Unhandled,
    /// Consumed while a sequence is under construction; no action yet.
    Pending,
    Executed(Execution),
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Expand a line-range `[lo, hi]` byte range so the region ends after the
/// newline of the last line (unless it is the last line without one).
pub fn linewise_span(doc: &dyn VimText, range: std::ops::Range<usize>) -> std::ops::Range<usize> {
    let lo = line_index(doc, range.start);
    let hi = line_index(doc, range.end.saturating_sub(1).max(range.start));
    let start = line_start(doc, lo);
    let mut end = line_end(doc, hi);
    if hi < last_line(doc) {
        end += 1; // eat the newline
    }
    start..end
}

fn line_span(doc: &dyn VimText, range: &std::ops::Range<usize>) -> (usize, usize) {
    let lo = line_index(doc, range.start);
    let hi = line_index(doc, range.end.saturating_sub(1).max(range.start));
    (lo, hi)
}

fn lines_text(doc: &dyn VimText, lo: usize, hi: usize) -> String {
    (lo..=hi).map(|i| doc.line(i)).collect::<Vec<_>>().join("\n")
}

/// Register name + content bookkeeping shared by delete/yank/paste paths.
fn store_register(
    registers: &mut Registers,
    name: Option<char>,
    text: String,
    linewise: bool,
    is_delete: bool,
    is_multiline: bool,
) {
    registers.write(
        name,
        RegisterContent { text, linewise },
        is_delete,
        is_multiline,
    );
}

/// Cursor position after a charwise delete covering `range` (original doc).
fn cursor_after_charwise_delete(doc: &dyn VimText, range: std::ops::Range<usize>) -> usize {
    let ls = super::doc::line_start_of(doc, range.start);
    let le = super::doc::line_end_of(doc, range.start);
    if range.end >= le && range.start > ls {
        // Deleted through end of line: land on the char to the left.
        char_before(doc, range.start).unwrap_or(ls)
    } else if range.start >= le {
        le
    } else {
        range.start
    }
}

fn toggle_case(c: char) -> char {
    if c.is_lowercase() {
        c.to_uppercase().next().unwrap_or(c)
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

// ---------------------------------------------------------------------------
// Operator application
// ---------------------------------------------------------------------------

/// Apply `op` over `range`/`kind`. `count` repeats `>`/`<` shifts; `cursor`
/// is the pre-command cursor (kept for linewise yank); `shiftwidth` sizes
/// the indent unit.
#[allow(clippy::too_many_arguments)]
pub fn apply_operator(
    doc: &dyn VimText,
    state: &mut VimState,
    op: Operator,
    range: std::ops::Range<usize>,
    kind: super::motion::MotionKind,
    register: Option<char>,
    count: u32,
    cursor: usize,
    shiftwidth: usize,
) -> Execution {
    let linewise = kind == super::motion::MotionKind::Linewise;
    let text = doc.slice(range.clone()).to_string();
    let is_multiline = linewise || text.contains('\n');
    let _ = cursor;

    match op {
        Operator::Delete => {
            let (lo, hi) = line_span(doc, &range);
            let content = if linewise { lines_text(doc, lo, hi) } else { text.clone() };
            let del_range = if linewise {
                linewise_span(doc, range)
            } else {
                range.clone()
            };
            store_register(
                &mut state.registers,
                register,
                content,
                linewise,
                true,
                is_multiline,
            );
            let new_cursor = if linewise {
                let target_line = line_index(doc, del_range.start).min(last_line(doc));
                // When the whole tail was deleted, clamp to the new end.
                if del_range.start >= doc.len() {
                    0
                } else {
                    first_non_blank(doc, target_line).min(del_range.start.max(0))
                }
            } else {
                cursor_after_charwise_delete(doc, del_range.clone())
            };
            Execution::default()
                .with_edit(del_range, "")
                .with_cursor(CursorPlan::Collapse(new_cursor))
                .with_mode(Mode::Normal)
        }
        Operator::Change => {
            let (lo, hi) = line_span(doc, &range);
            let content = if linewise { lines_text(doc, lo, hi) } else { text.clone() };
            let (del_range, replacement, new_cursor) = if linewise {
                let indent = super::doc::line_indent(doc, lo).to_string();
                let span = linewise_span(doc, range);
                let pos = line_start(doc, line_index(doc, span.start)) + indent.len();
                (span, indent, pos)
            } else {
                (range.clone(), String::new(), range.start)
            };
            store_register(
                &mut state.registers,
                register,
                content,
                linewise,
                true,
                is_multiline,
            );
            Execution::default()
                .with_edit(del_range, replacement)
                .with_cursor(CursorPlan::Collapse(new_cursor))
                .with_mode(Mode::Insert)
        }
        Operator::Yank => {
            let (lo, hi) = line_span(doc, &range);
            let content = if linewise { lines_text(doc, lo, hi) } else { text.clone() };
            store_register(
                &mut state.registers,
                register,
                content,
                linewise,
                false,
                is_multiline,
            );
            // Charwise yank moves the cursor to the start of the range;
            // linewise yank keeps the cursor where it was.
            let new_cursor = if linewise { cursor } else { range.start };
            Execution::default()
                .with_cursor(CursorPlan::Collapse(new_cursor))
                .with_mode(Mode::Normal)
                .with_flash(range)
        }
        Operator::Indent | Operator::Outdent => {
            let out = shift_lines(doc, &range, op == Operator::Indent, count, shiftwidth);
            Execution::default()
                .with_edit(out.0, out.1)
                .with_cursor(CursorPlan::Collapse(out.2))
                .with_mode(Mode::Normal)
        }
        Operator::Lowercase | Operator::Uppercase | Operator::ToggleCase => {
            let (lo, hi) = line_span(doc, &range);
            let transformed = if linewise {
                (lo..=hi)
                    .map(|i| match op {
                        Operator::Lowercase => doc.line(i).to_lowercase(),
                        Operator::Uppercase => doc.line(i).to_uppercase(),
                        _ => doc.line(i).chars().map(toggle_case).collect(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                match op {
                    Operator::Lowercase => text.to_lowercase(),
                    Operator::Uppercase => text.to_uppercase(),
                    _ => text.chars().map(toggle_case).collect(),
                }
            };
            let new_cursor = if linewise {
                first_non_blank(doc, lo)
            } else {
                range.start
            };
            Execution::default()
                .with_edit(range, transformed)
                .with_cursor(CursorPlan::Collapse(new_cursor))
                .with_mode(Mode::Normal)
        }
        Operator::ReplaceWith(_) | Operator::Join | Operator::Filter => {
            // `r` and `J` route through their dedicated paths; Filter is
            // reserved and never dispatched in v1.
            Execution::nothing()
        }
    }
}

/// Re-indent lines `lo..=hi`. Returns (range, text, cursor).
fn shift_lines(
    doc: &dyn VimText,
    range: &std::ops::Range<usize>,
    indent: bool,
    count: u32,
    shiftwidth: usize,
) -> (std::ops::Range<usize>, String, usize) {
    let (lo, hi) = line_span(doc, range);
    let sw = shiftwidth.max(1);
    let unit = " ".repeat(sw.saturating_mul(count.max(1) as usize));
    let mut out = String::new();
    for line in lo..=hi {
        let text = doc.line(line);
        let existing = super::doc::line_indent(doc, line);
        let rest = &text[existing.len()..];
        let new_indent = if indent {
            format!("{}{}", unit, existing)
        } else {
            existing[unit.len().min(existing.len())..].to_string()
        };
        out.push_str(&new_indent);
        out.push_str(rest);
        if line != hi {
            out.push('\n');
        }
    }
    // Cursor: first non-blank of the first shifted line after the shift.
    let ls = line_start(doc, lo);
    let new_indent_len = if indent {
        unit.len() + super::doc::line_indent(doc, lo).len()
    } else {
        super::doc::line_indent(doc, lo)
            .len()
            .saturating_sub(unit.len())
    };
    let cursor = ls + new_indent_len;
    (line_start(doc, lo)..line_end(doc, hi), out, cursor)
}

// ---------------------------------------------------------------------------
// Direct commands (x, p, J, ~, o/O, …)
// ---------------------------------------------------------------------------

/// `x`: delete `count` chars from `cursor` within the line.
pub fn delete_chars(
    doc: &dyn VimText,
    state: &mut VimState,
    cursor: usize,
    count: u32,
    register: Option<char>,
) -> Option<Execution> {
    let le = super::doc::line_end_of(doc, cursor);
    let mut end = cursor;
    for _ in 0..count {
        match char_at(doc, end) {
            Some(c) if end + c.len_utf8() <= le => end += c.len_utf8(),
            _ => break,
        }
    }
    if end == cursor {
        return None; // empty line (or cursor on the newline): no-op
    }
    let text = doc.slice(cursor..end).to_string();
    store_register(&mut state.registers, register, text, false, true, false);
    let new_cursor = cursor_after_charwise_delete(doc, cursor..end);
    Some(
        Execution::default()
            .with_edit(cursor..end, "")
            .with_cursor(CursorPlan::Collapse(new_cursor))
            .with_mode(Mode::Normal),
    )
}

/// `X`: delete `count` chars before the cursor within the line.
pub fn delete_chars_before(
    doc: &dyn VimText,
    state: &mut VimState,
    cursor: usize,
    count: u32,
    register: Option<char>,
) -> Option<Execution> {
    let ls = super::doc::line_start_of(doc, cursor);
    if cursor <= ls {
        return None;
    }
    let mut start = cursor;
    for _ in 0..count {
        match char_before(doc, start) {
            Some(prev) if prev >= ls => start = prev,
            _ => break,
        }
    }
    let text = doc.slice(start..cursor).to_string();
    store_register(&mut state.registers, register, text, false, true, false);
    Some(
        Execution::default()
            .with_edit(start..cursor, "")
            .with_cursor(CursorPlan::Collapse(start))
            .with_mode(Mode::Normal),
    )
}

/// `r{char}`: replace `count` chars under the cursor (must stay on one line).
pub fn replace_chars(
    doc: &dyn VimText,
    _state: &mut VimState,
    cursor: usize,
    replacement: char,
    count: u32,
) -> Option<Execution> {
    let le = super::doc::line_end_of(doc, cursor);
    let mut end = cursor;
    for _ in 0..count {
        let c = char_at(doc, end)?;
        end += c.len_utf8();
        if end > le {
            return None; // not enough chars on this line
        }
    }
    let fill: String = std::iter::repeat(replacement).take(count.max(1) as usize).collect();
    let n = count.max(1) as usize;
    let new_cursor = cursor + replacement.len_utf8() * (n - 1);
    Some(
        Execution::default()
            .with_edit(cursor..end, fill)
            .with_cursor(CursorPlan::Collapse(new_cursor))
            .with_mode(Mode::Normal),
    )
}

/// `~`: toggle case of `count` chars; cursor moves onto the last toggled.
pub fn toggle_case_chars(doc: &dyn VimText, cursor: usize, count: u32) -> Option<Execution> {
    let le = super::doc::line_end_of(doc, cursor);
    let mut end = cursor;
    let mut out = String::new();
    for _ in 0..count {
        match char_at(doc, end) {
            Some(c) if end + c.len_utf8() <= le => {
                out.push(toggle_case(c));
                end += c.len_utf8();
            }
            _ => break,
        }
    }
    if end == cursor {
        return None;
    }
    // Vim moves the cursor right per toggle, clamped to the last char.
    let le = line_end(doc, cursor);
    let new_cursor = if end < le { end } else { char_before(doc, le).unwrap_or(cursor) };
    Some(
        Execution::default()
            .with_edit(cursor..end, out)
            .with_cursor(CursorPlan::Collapse(new_cursor))
            .with_mode(Mode::Normal),
    )
}

/// `p`/`P` with the requested register (`"` fallback; `+` reads the host
/// clipboard passed in `ctx`). Linewise registers paste whole lines with the
/// exact text (no auto-indent in v1).
pub fn paste(
    doc: &dyn VimText,
    state: &mut VimState,
    ctx: &HostContext,
    after: bool,
    count: u32,
    register: Option<char>,
) -> Option<Execution> {
    let content = match register {
        Some('+') => ctx.clipboard.clone().map(|text| RegisterContent {
            linewise: ctx.clipboard.as_ref().is_some_and(|t| t.contains('\n')),
            text,
        }),
        other => state.registers.read(other).cloned(),
    }?;
    let n = count.max(1) as usize;
    if content.linewise {
        let line_text = content.text.trim_end_matches('\n').to_string();
        let block = std::iter::repeat(line_text)
            .take(n)
            .collect::<Vec<_>>()
            .join("\n");
        let line = line_index(doc, ctx.cursor);
        let (pos, text) = if after {
            let le = line_end(doc, line);
            if line >= last_line(doc) {
                // Last line without newline: create one.
                (le, format!("\n{}", block))
            } else {
                (le + 1, format!("{}\n", block))
            }
        } else {
            (line_start(doc, line), format!("{}\n", block))
        };
        // Cursor positions are post-edit: the pasted block's first line
        // starts right after the inserted newline (or at the line start for
        // `P`), and the cursor sits on its first non-blank char.
        let pasted_indent = block
            .chars()
            .take_while(|c| c.is_whitespace())
            .count();
        // `pos` is the insertion point and — except for the append-on-last-
        // line case, where the leading "\n" is part of the inserted text —
        // already the start of the pasted block itself. Clamp against the
        // post-edit length (the paste is a pure insertion).
        let block_start = if after && line >= last_line(doc) { pos + 1 } else { pos };
        let cursor = (block_start + pasted_indent).min(doc.len() + text.len());
        Some(
            Execution::default()
                .with_edit(pos..pos, text)
                .with_cursor(CursorPlan::Collapse(cursor))
                .with_mode(Mode::Normal),
        )
    } else {
        // Charwise: `p` inserts after the char under the cursor; on an empty
        // line (or line end) it inserts at the cursor.
        let le = super::doc::line_end_of(doc, ctx.cursor);
        let pos = match (after, char_at(doc, ctx.cursor)) {
            (true, Some(c)) if ctx.cursor + c.len_utf8() <= le => ctx.cursor + c.len_utf8(),
            _ => ctx.cursor,
        };
        let text = content.text.repeat(n);
        let last_char_len = text.chars().last().map_or(1, |c| c.len_utf8());
        let cursor = if text.is_empty() {
            pos
        } else {
            pos + text.len() - last_char_len
        };
        Some(
            Execution::default()
                .with_edit(pos..pos, text)
                .with_cursor(CursorPlan::Collapse(cursor))
                .with_mode(Mode::Normal),
        )
    }
}

/// `J`: join the cursor line with the next, `count - 1` times (or the lines
/// of the visual selection). Separator rules: single space unless the next
/// line starts with `)`, the next line is empty, or the joined text already
/// ends with a space. Cursor lands on the first join point.
pub fn join_lines(
    doc: &dyn VimText,
    cursor: usize,
    count: u32,
    selected_lines: Option<std::ops::Range<usize>>,
) -> Option<Execution> {
    let (first, joins) = match selected_lines {
        Some(r) => (r.start, r.end.saturating_sub(1).saturating_sub(r.start)),
        None => (line_index(doc, cursor), count.max(1) as usize - 1),
    };
    let last = (first + joins.max(1)).min(last_line(doc));
    if last <= first {
        return None;
    }
    // Keep the first line's trailing whitespace: vim does not add another
    // space when the line already ends in one.
    let first_line = doc.line(first);
    let mut joined = first_line.to_string();
    let join_pos = first_line.len();
    for line in (first + 1)..=last {
        let next = doc.line(line);
        let trimmed = next.trim_start();
        let sep = if trimmed.starts_with(')')
            || trimmed.is_empty()
            || joined.ends_with(' ')
            || joined.is_empty()
        {
            ""
        } else {
            " "
        };
        joined.push_str(sep);
        joined.push_str(trimmed);
    }
    let start = line_start(doc, first);
    let range = if last < last_line(doc) {
        start..line_start(doc, last + 1)
    } else {
        start..doc.len()
    };
    Some(
        Execution::default()
            .with_edit(range, joined)
            .with_cursor(CursorPlan::Collapse(start + join_pos))
            .with_mode(Mode::Normal),
    )
}

/// `o`/`O`: open a line below/above with the current line's leading
/// whitespace copied verbatim (bnote's `patchVimNewlineIndent` semantics).
pub fn open_line(doc: &dyn VimText, cursor: usize, below: bool) -> Execution {
    let line = line_index(doc, cursor);
    let indent = super::doc::line_indent(doc, line).to_string();
    let (pos, text) = if below {
        (line_end(doc, line), format!("\n{}", indent))
    } else {
        (line_start(doc, line), format!("{}\n", indent))
    };
    // Cursor positions are post-edit: for `o` the new line starts right
    // after the inserted newline (pos + 1); for `O` at the line start.
    let cursor = if below {
        pos + 1 + indent.len()
    } else {
        line_start(doc, line) + indent.len()
    };
    Execution::default()
        .with_edit(pos..pos, text)
        .with_cursor(CursorPlan::Collapse(cursor))
        .with_mode(Mode::Insert)
}

/// `<C-a>` / `<C-x>`: increment/decrement the first number at or after the
/// cursor on the same line. Decimal only; a `-` directly before the digits
/// participates (`-5` + 2 → `-3`, `-1` + 1 → `0`); leading zeros are dropped
/// on change (`08` + 1 → `9`); crossing into negative inserts a `-`. Cursor
/// lands on the last digit of the new number.
pub fn increment(doc: &dyn VimText, cursor: usize, delta: i64) -> Option<Execution> {
    let ls = super::doc::line_start_of(doc, cursor);
    let le = super::doc::line_end_of(doc, cursor);
    let line_text = doc.slice(ls..le);

    // Find the number: first digit, or '-' followed by a digit, at or after
    // the cursor.
    let mut minus_pos = None;
    let mut digits_start = None;
    let chars: Vec<(usize, char)> = line_text.char_indices().collect();
    for (i, (idx, c)) in chars.iter().enumerate() {
        let byte = ls + idx;
        if byte < cursor {
            continue;
        }
        if c.is_ascii_digit() {
            digits_start = Some(byte);
            break;
        }
        if *c == '-' {
            if let Some((_, next)) = chars.get(i + 1) {
                if next.is_ascii_digit() {
                    minus_pos = Some(byte);
                    digits_start = Some(byte + 1);
                    break;
                }
            }
        }
    }
    let digits_start = digits_start?;
    let mut digits_end = digits_start - ls;
    let bytes = line_text.as_bytes();
    while digits_end < bytes.len() && bytes[digits_end].is_ascii_digit() {
        digits_end += 1;
    }
    if digits_end == digits_start - ls {
        return None;
    }
    let digits = &line_text[digits_start - ls..digits_end];
    let has_minus = minus_pos.is_some();
    let magnitude: i64 = digits.parse().ok()?;
    let signed = if has_minus { -magnitude } else { magnitude };
    let new = signed.checked_add(delta)?;

    let (range_start, text) = match (has_minus, new < 0) {
        (true, true) => (minus_pos.unwrap(), format!("-{}", new.unsigned_abs())),
        (true, false) => (minus_pos.unwrap(), new.to_string()),
        (false, true) => (digits_start, format!("-{}", new.unsigned_abs())),
        (false, false) => (digits_start, new.to_string()),
    };
    let range_end = ls + digits_end;
    let new_len = text.len();
    let new_cursor = range_start + new_len.saturating_sub(1);
    Some(
        Execution::default()
            .with_edit(range_start..range_end, text)
            .with_cursor(CursorPlan::Collapse(new_cursor))
            .with_mode(Mode::Normal),
    )
}

/// `*`: search for the word under the cursor; sets `last_search` and jumps
/// to the next occurrence (wrapping). Fails when the cursor is not on a
/// word char.
pub fn search_word_under_cursor(
    doc: &dyn VimText,
    state: &mut VimState,
    cursor: usize,
) -> Option<Execution> {
    use super::doc::{char_class, CharClass};
    if char_class(char_at(doc, cursor)?) != CharClass::Word {
        return None;
    }
    let range = line_range(doc, cursor);
    let text = doc.slice(range.clone());
    let byte_in_line = cursor - range.start;

    let mut start = byte_in_line;
    while start > 0 {
        let prev = text[..start].chars().last()?;
        if char_class(prev) != CharClass::Word {
            break;
        }
        start -= prev.len_utf8();
    }
    let mut end = byte_in_line;
    for (idx, c) in text[byte_in_line..].char_indices() {
        if char_class(c) != CharClass::Word {
            break;
        }
        end = byte_in_line + idx + c.len_utf8();
    }
    let word = &text[start..end];
    if word.is_empty() {
        return None;
    }
    state.last_search = Some(word.to_string());
    let next = super::motion::search_next(doc, word, cursor, true)?;
    Some(
        Execution::default()
            .with_cursor(CursorPlan::Collapse(next))
            .with_mode(Mode::Normal),
    )
}
