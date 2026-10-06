//! Motions: `move_point` for cursor movement and `motion_range` for
//! operator+motion composition, with vim's exclusive/inclusive/linewise kinds
//! and the "exclusive adjustment" rules (see `:h exclusive`).

use super::doc::{
    big_char_class, char_class, first_non_blank, is_word_char, last_line, line_end, line_index,
    line_range, line_start, CharClass, VimText,
};
use super::state::{LastFind, Operator, VimState};

/// How an operator treats the end of a motion's range.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MotionKind {
    /// End excluded (`w`, `b`, `0`, `^`, `{`, `}`, `t`).
    Exclusive,
    /// End included (`e`, `$`, `f`, `%`, `g_`).
    Inclusive,
    /// Whole lines (`dd`, `dj`, `dG`, `'m`).
    Linewise,
}

/// A vim motion. `big` distinguishes word (`w`) from WORD (`W`) classes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Motion {
    Left,
    Right,
    Down,
    Up,
    NextWordStart { big: bool },
    NextWordEnd { big: bool },
    PrevWordStart { big: bool },
    PrevWordEnd { big: bool },
    LineStart,
    LineStartNonBlank,
    LineEnd,
    LastNonBlank,
    LineMiddle,
    FirstLine,
    LastLine,
    Line { index: usize },
    FindForward { ch: char, till: bool },
    FindBackward { ch: char, till: bool },
    /// `;` (same direction) and `,` (reversed).
    RepeatFind { reverse: bool },
    MatchingBracket,
    ParagraphStart,
    ParagraphEnd,
    ViewTop,
    ViewMiddle,
    ViewBottom,
    /// `` `x `` (exact) / `'x` (line, linewise).
    Mark { name: char, exact: bool },
    /// `n` / `N` over `VimState::last_search`.
    SearchNext { forward: bool },
}

/// Host-provided viewport for `H`/`M`/`L` (first and last visible line
/// index). `last_line < first_line` (unknown) makes those motions fail.
#[derive(Clone, Copy, Debug, Default)]
pub struct Viewport {
    pub first_line: usize,
    pub last_line: usize,
}

/// Result of a cursor move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Moved {
    pub cursor: usize,
}

impl Moved {
    fn at(cursor: usize) -> Self {
        Moved { cursor }
    }
}

/// Move the cursor by `motion` × `count`. Returns `None` when the motion
/// fails (cursor does not move; operators abort). Mutates `state` only for
/// curswant/jump bookkeeping — no text, no registers.
pub fn move_point(
    doc: &dyn VimText,
    state: &mut VimState,
    motion: Motion,
    count: u32,
    cursor: usize,
    viewport: Viewport,
) -> Option<Moved> {
    let count = count.max(1);
    let moved = match motion {
        Motion::Left => {
            // `h` stays on its line (vim's normal-mode default, matching the
            // Tauri shell's CM-vim): at the line start it does not move.
            let mut pos = cursor;
            for _ in 0..count {
                let ls = line_range(doc, pos).start;
                if pos <= ls {
                    break;
                }
                pos = char_before(doc, pos)?;
                if pos < ls {
                    pos = ls;
                }
            }
            Moved::at(pos)
        }
        Motion::Right => {
            // `l` moves right within the line and stops *after* the last
            // char (the end-of-line slot is a legal cursor position — that
            // is where CM-vim clips too). It never wraps.
            let mut pos = cursor;
            for _ in 0..count {
                let le = line_end(doc, line_index(doc, pos));
                if pos >= le {
                    break;
                }
                // Advance by the char's width; at the document end
                // `char_after` has no successor, so fall back to the line
                // end explicitly.
                let next = match char_at(doc, pos) {
                    Some(c) => pos + c.len_utf8(),
                    None => break,
                };
                pos = next.min(le);
            }
            Moved::at(pos)
        }
        Motion::Down | Motion::Up => vertical_move(doc, state, motion == Motion::Down, count, cursor)?,
        Motion::NextWordStart { big } => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = next_word_start(doc, big, pos)?;
            }
            Moved::at(pos)
        }
        Motion::NextWordEnd { big } => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = next_word_end(doc, big, pos)?;
            }
            Moved::at(pos)
        }
        Motion::PrevWordStart { big } => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = prev_word_start(doc, big, pos)?;
            }
            Moved::at(pos)
        }
        Motion::PrevWordEnd { big } => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = prev_word_end(doc, big, pos)?;
            }
            Moved::at(pos)
        }
        Motion::LineStart => Moved::at(line_range(doc, cursor).start),
        Motion::LineStartNonBlank => Moved::at(first_non_blank(doc, line_index(doc, cursor))),
        Motion::LineEnd => {
            let line = (line_index(doc, cursor) + count as usize - 1).min(last_line(doc));
            let le = line_end(doc, line);
            let pos = char_before(doc, le).unwrap_or(le);
            // After `$`, j/k should keep landing at EOL (vim sets curswant
            // to "far right").
            state.curswant = Some(usize::MAX);
            Moved::at(pos)
        }
        Motion::LastNonBlank => {
            let line = (line_index(doc, cursor) + count as usize - 1).min(last_line(doc));
            let range = super::doc::line_range_at(doc, line);
            let text = doc.slice(range.clone());
            let visible = text.trim_end().chars().count();
            if visible == 0 {
                Moved::at(range.start)
            } else {
                let col = visible - 1;
                let pos = text
                    .char_indices()
                    .nth(col)
                    .map_or(range.end, |(i, _)| range.start + i);
                Moved::at(pos)
            }
        }
        Motion::LineMiddle => {
            let range = line_range(doc, cursor);
            let text = doc.slice(range.clone());
            let chars = text.chars().count();
            let half = chars / 2;
            let pos = text
                .char_indices()
                .nth(half)
                .map_or(range.end, |(i, _)| range.start + i);
            Moved::at(pos)
        }
        Motion::FirstLine | Motion::LastLine | Motion::Line { .. } => {
            let target = match motion {
                Motion::Line { index } => (index.max(1) - 1).min(last_line(doc)),
                Motion::FirstLine => 0,
                _ => last_line(doc),
            };
            push_jump(doc, state, cursor);
            let dest = first_non_blank(doc, target);
            push_jump_dest(state, dest);
            Moved::at(dest)
        }
        Motion::FindForward { ch, till } => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = find_forward(doc, ch, pos)?;
            }
            if till {
                pos = char_before(doc, pos)?;
                if pos == cursor {
                    return None;
                }
            }
            Moved::at(pos)
        }
        Motion::FindBackward { ch, till } => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = find_backward(doc, ch, pos)?;
            }
            if till {
                pos = char_after(doc, pos)?;
                if pos == cursor {
                    return None;
                }
            }
            Moved::at(pos)
        }
        Motion::RepeatFind { reverse } => {
            let find: LastFind = state.last_find?;
            let forward = if reverse { !find.forward } else { find.forward };
            let motion = match (forward, find.till) {
                (true, false) => Motion::FindForward { ch: find.ch, till: false },
                (true, true) => Motion::FindForward { ch: find.ch, till: true },
                (false, false) => Motion::FindBackward { ch: find.ch, till: false },
                (false, true) => Motion::FindBackward { ch: find.ch, till: true },
            };
            move_point(doc, state, motion, count, cursor, viewport)?
        }
        Motion::MatchingBracket => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = matching_bracket(doc, pos)?;
            }
            Moved::at(pos)
        }
        Motion::ParagraphStart => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = paragraph_start(doc, pos)?;
            }
            Moved::at(pos)
        }
        Motion::ParagraphEnd => {
            let mut pos = cursor;
            for _ in 0..count {
                pos = paragraph_end(doc, pos)?;
            }
            Moved::at(pos)
        }
        Motion::ViewTop | Motion::ViewMiddle | Motion::ViewBottom => {
            if viewport.last_line < viewport.first_line {
                return None;
            }
            let span = viewport.last_line - viewport.first_line;
            let base = match motion {
                Motion::ViewTop => viewport.first_line,
                Motion::ViewMiddle => viewport.first_line + span / 2,
                _ => viewport.last_line,
            };
            let delta = (count as usize).saturating_sub(1);
            let target = match motion {
                Motion::ViewTop => (base + delta).min(viewport.last_line),
                Motion::ViewBottom => base.saturating_sub(delta).max(viewport.first_line),
                _ => base,
            };
            let target = target.min(last_line(doc));
            push_jump(doc, state, cursor);
            let dest = first_non_blank(doc, target);
            push_jump_dest(state, dest);
            Moved::at(dest)
        }
        Motion::Mark { name, exact } => {
            let byte = state.marks.get(name)?.min(doc.len());
            let pos = if exact {
                super::doc::clamp_char(doc.slice(0..doc.len()), byte)
            } else {
                first_non_blank(doc, line_index(doc, byte))
            };
            push_jump(doc, state, cursor);
            push_jump_dest(state, pos);
            Moved::at(pos)
        }
        Motion::SearchNext { forward } => {
            let pattern = state.last_search.clone()?;
            if pattern.is_empty() {
                return None;
            }
            let mut pos = cursor;
            for _ in 0..count {
                pos = search_next(doc, &pattern, pos, forward)?;
            }
            push_jump(doc, state, cursor);
            push_jump_dest(state, pos);
            Moved::at(pos)
        }
    };
    // Any successful move re-anchors the column goal — except j/k (they keep
    // it, anchored inside `vertical_move`) and `$` (which set it to MAX
    // above so following j/k land at EOL).
    match motion {
        Motion::Down | Motion::Up | Motion::LineEnd => {}
        _ => state.curswant = None,
    }
    Some(moved)
}

/// `j`/`k`: linewise move with a column goal. Char columns (not bytes) so
/// CJK text keeps the visual column. Does not touch `curswant` beyond
/// anchoring it on first use.
fn vertical_move(
    doc: &dyn VimText,
    state: &mut VimState,
    down: bool,
    count: u32,
    cursor: usize,
) -> Option<Moved> {
    let current_line = line_index(doc, cursor);
    let line = if down {
        let target = current_line + count as usize;
        if target > last_line(doc) {
            return None;
        }
        target
    } else {
        current_line.checked_sub(count as usize)?
    };

    let goal = *state.curswant.get_or_insert_with(|| {
        doc.slice(line_range(doc, cursor).start..cursor).chars().count()
    });

    let range = super::doc::line_range_at(doc, line);
    let text = doc.slice(range.clone());
    let len = text.chars().count();
    // Land on the goal column; a shorter line clamps to its end-of-line slot
    // (one past the last char — CM-vim's clip allows it), an empty line at
    // its only position (the newline).
    let col = goal.min(len);
    let pos = match text.char_indices().nth(col) {
        Some((i, _)) => range.start + i,
        None => range.end,
    };
    Some(Moved::at(pos))
}

// ---------------------------------------------------------------------------
// Primitive position helpers
// ---------------------------------------------------------------------------

/// The char whose byte range contains `off` (snapped down to a char
/// boundary). `None` only at/after the end of the document.
pub(crate) fn char_at(doc: &dyn VimText, off: usize) -> Option<char> {
    doc.char_at(off)
}

/// Byte offset of the char before `pos` (crosses newlines). `None` at 0.
pub fn char_before(doc: &dyn VimText, pos: usize) -> Option<usize> {
    if pos == 0 || doc.len() == 0 {
        return None;
    }
    // A window of 4 bytes back always contains exactly one whole char (UTF-8
    // chars are at most 4 bytes) unless pos is itself mid-char, which callers
    // avoid.
    let window = doc.slice(pos.saturating_sub(4)..pos);
    let c = window.chars().last()?;
    Some(pos - c.len_utf8())
}

/// Byte offset of the next char after boundary `pos` (crosses newlines,
/// may land on the newline char of an empty line). `None` at doc end.
pub fn char_after(doc: &dyn VimText, pos: usize) -> Option<usize> {
    let c = char_at(doc, pos)?;
    let next = pos + c.len_utf8();
    if next >= doc.len() {
        return None;
    }
    Some(next)
}

/// Byte offset of the previous char position from a doc-end-ish offset
/// (clamps mid-char positions down). Never `None` for `pos > 0`.
/// Clamp a raw motion target to a placeable cursor position (the last char
/// when the motion ran to the document end). Callers whose motion may
/// legally rest in the end-of-line slot (`l`, `<Space>`) skip this.
pub fn clamp_to_char(doc: &dyn VimText, pos: usize) -> usize {
    if pos >= doc.len() {
        prev_char_boundary(doc, doc.len())
    } else {
        pos
    }
}

fn prev_char_boundary(doc: &dyn VimText, pos: usize) -> usize {
    if pos == 0 {
        return 0;
    }
    char_before(doc, pos).unwrap_or(pos - 1)
}

// ---------------------------------------------------------------------------
// Word motions
// ---------------------------------------------------------------------------

pub(crate) fn next_char_pos(doc: &dyn VimText, pos: usize) -> Option<usize> {
    let c = char_at(doc, pos)?;
    let next = pos + c.len_utf8();
    (next <= doc.len()).then_some(next)
}

/// `w`/`W`: start of the next word. Empty lines count as words. At the end
/// of the document the cursor lands on the last char.
/// `w`/`W`: start of the next word. Empty lines count as words. At the end
/// of the document the cursor lands on the last char.
pub fn next_word_start(doc: &dyn VimText, big: bool, pos: usize) -> Option<usize> {
    let class = if big { big_char_class } else { char_class };
    let mut pos = pos;
    // Already at the document end: stay there. (Without this guard a repeat
    // count would walk *back* onto the last char and oscillate, so `6w`
    // could end one char short of the tail and an operator would miss the
    // final character.)
    if pos >= doc.len() {
        return Some(doc.len());
    }
    // Phase 1: if we sit on a word char, run to the end of that run (same
    // class), then step off it.
    if let Some(c) = char_at(doc, pos) {
        if class(c) != CharClass::White {
            loop {
                match next_char_pos(doc, pos) {
                    Some(p) => match char_at(doc, p) {
                        Some(c2) if class(c2) == class(c) => pos = p,
                        _ => break,
                    },
                    None => break,
                }
            }
            match next_char_pos(doc, pos) {
                Some(p) => pos = p,
                None => return Some(pos), // doc end: stay on the last char
            }
        } else {
            match next_char_pos(doc, pos) {
                Some(p) => pos = p,
                None => return Some(prev_char_boundary(doc, doc.len())),
            }
        }
    } else {
        return Some(prev_char_boundary(doc, doc.len()));
    }
    // Phase 2: skip whitespace, stopping on empty lines (a blank line is
    // itself a word). Hitting the document end yields the raw `doc.len()`
    // position so operator ranges cover the tail; cursor placement clamps.
    loop {
        let range = doc.line_range(pos);
        if range.start == range.end && char_at(doc, pos) == Some('\n') {
            return Some(pos);
        }
        match char_at(doc, pos) {
            Some(c) if class(c) == CharClass::White => match next_char_pos(doc, pos) {
                Some(p) => pos = p,
                None => return Some(doc.len()),
            },
            Some(_) => return Some(pos),
            None => return Some(doc.len()),
        }
    }
}

/// `b`/`B`: start of the previous word. Empty lines count as words.
pub fn prev_word_start(doc: &dyn VimText, big: bool, pos: usize) -> Option<usize> {
    let class = if big { big_char_class } else { char_class };
    let mut pos = pos;
    for _ in 0..10_000 {
        pos = if pos == 0 {
            return None;
        } else {
            char_before(doc, pos)?
        };
        // Sitting on the newline of an empty line: that line is a word.
        let range = doc.line_range(pos);
        if range.start == range.end && char_at(doc, pos) == Some('\n') {
            return Some(pos);
        }
        match char_at(doc, pos) {
            Some(c) if class(c) == CharClass::White => continue,
            Some(cur) => {
                let cur_class = class(cur);
                // Walk back to the start of this word run.
                while pos > 0 {
                    let prev = match char_before(doc, pos) {
                        Some(p) => p,
                        None => break,
                    };
                    match char_at(doc, prev) {
                        Some(pc) if pc != '\n' && class(pc) == cur_class => pos = prev,
                        _ => break,
                    }
                }
                return Some(pos);
            }
            None => return Some(pos),
        }
    }
    None
}

/// `e`/`E`: end of the next (or current) word. Skips empty lines. From the
/// middle of a word this lands on that word's last char; from a word end it
/// hops to the next word.
pub fn next_word_end(doc: &dyn VimText, big: bool, pos: usize) -> Option<usize> {
    let class = if big { big_char_class } else { char_class };
    let mut pos = pos;
    // Are we already sitting on the last char of a word run?
    let at_word_end = match char_at(doc, pos) {
        Some(c) if class(c) != CharClass::White => match next_char_pos(doc, pos) {
            Some(p) => match char_at(doc, p) {
                Some(c2) => class(c2) != class(c),
                None => true,
            },
            None => true,
        },
        _ => false,
    };
    if at_word_end {
        // Step off the current word end; the caller's count loop re-enters
        // here for the next word.
        pos = next_char_pos(doc, pos)?;
    }
    // Skip whitespace (empty lines do not stop `e`).
    while let Some(c) = char_at(doc, pos) {
        if class(c) == CharClass::White {
            pos = next_char_pos(doc, pos)?;
        } else {
            break;
        }
    }
    // Run forward to the last char of this word.
    let cur = char_at(doc, pos)?;
    let cur_class = class(cur);
    loop {
        match next_char_pos(doc, pos) {
            Some(p) => match char_at(doc, p) {
                Some(c2) if class(c2) == cur_class => pos = p,
                _ => break,
            },
            None => break,
        }
    }
    Some(pos)
}

/// `ge`/`gE`: end of the previous word. Skips empty lines. From the middle
/// of a word this lands on the end of the word *before* it.
pub fn prev_word_end(doc: &dyn VimText, big: bool, pos: usize) -> Option<usize> {
    let class = if big { big_char_class } else { char_class };
    // Move to the start of the run containing `pos` (when on a word char).
    let mut p = pos;
    if let Some(c) = char_at(doc, p) {
        if class(c) != CharClass::White {
            while let Some(prev) = char_before(doc, p) {
                match char_at(doc, prev) {
                    Some(pc) if class(pc) == class(c) => p = prev,
                    _ => break,
                }
            }
        }
    }
    // Step back off the current run.
    p = char_before(doc, p)?;
    // Skip whitespace backward (empty lines do not stop `ge`).
    while let Some(c) = char_at(doc, p) {
        if class(c) == CharClass::White {
            p = char_before(doc, p)?;
        } else {
            break;
        }
    }
    Some(p)
}

// ---------------------------------------------------------------------------
// Find / bracket / paragraph / search
// ---------------------------------------------------------------------------

fn find_forward(doc: &dyn VimText, ch: char, cursor: usize) -> Option<usize> {
    let line = line_range(doc, cursor);
    let mut pos = cursor;
    loop {
        pos = char_after(doc, pos)?;
        if pos >= line.end {
            return None;
        }
        if char_at(doc, pos) == Some(ch) {
            return Some(pos);
        }
    }
}

fn find_backward(doc: &dyn VimText, ch: char, cursor: usize) -> Option<usize> {
    let line = line_range(doc, cursor);
    let mut pos = cursor;
    loop {
        if pos <= line.start {
            return None;
        }
        pos = char_before(doc, pos)?;
        if char_at(doc, pos) == Some(ch) {
            return Some(pos);
        }
    }
}

const OPEN: &[char] = &['(', '[', '{'];
const CLOSE: &[char] = &[')', ']', '}'];

fn bracket_partner(c: char) -> Option<(char, bool)> {
    // (partner, searches_forward)
    match c {
        '(' => Some((')', true)),
        '[' => Some((']', true)),
        '{' => Some(('}', true)),
        ')' => Some(('(', false)),
        ']' => Some(('[', false)),
        '}' => Some(('{', false)),
        _ => None,
    }
}

/// `%`: match the bracket under the cursor (nesting-aware, both directions).
/// When the cursor is not on a bracket char, vim scans forward on the
/// current line for the first bracket char and matches that one. Quote pairs
/// are not matched (v1).
pub fn matching_bracket(doc: &dyn VimText, cursor: usize) -> Option<usize> {
    let line = line_range(doc, cursor);
    let mut start = cursor;
    let (target, forward) = match char_at(doc, start).and_then(bracket_partner) {
        Some(pair) => pair,
        None => {
            // Scan the rest of the line for the first bracket char.
            let mut pos = start;
            loop {
                let c = char_at(doc, pos)?;
                if pos >= line.end {
                    return None;
                }
                if bracket_partner(c).is_some() {
                    break;
                }
                pos += c.len_utf8();
            }
            let c = char_at(doc, pos)?;
            start = pos;
            bracket_partner(c)?
        }
    };
    let open = if forward { char_at(doc, start)? } else { target };
    let close = if forward { target } else { char_at(doc, start)? };
    debug_assert!(OPEN.contains(&open) && CLOSE.contains(&close));

    let mut depth: i32 = 0;
    let mut pos = start;
    loop {
        let c = char_at(doc, pos)?;
        if c == open {
            if forward {
                depth += 1;
            } else {
                depth -= 1;
                if depth == 0 {
                    return Some(pos);
                }
            }
        } else if c == close {
            if forward {
                depth -= 1;
                if depth == 0 {
                    return Some(pos);
                }
            } else {
                depth += 1;
            }
        }
        if forward {
            pos += c.len_utf8();
        } else if pos == 0 {
            return None;
        } else {
            pos = char_before(doc, pos)?;
        }
    }
}

fn paragraph_start(doc: &dyn VimText, cursor: usize) -> Option<usize> {
    let mut line = line_index(doc, cursor);
    loop {
        if line == 0 {
            return Some(0);
        }
        line -= 1;
        if super::doc::line_is_blank(doc, line) {
            return Some(line_start(doc, line));
        }
    }
}

fn paragraph_end(doc: &dyn VimText, cursor: usize) -> Option<usize> {
    let mut line = line_index(doc, cursor);
    let last = last_line(doc);
    loop {
        if line >= last {
            return Some(line_start(doc, last));
        }
        line += 1;
        if super::doc::line_is_blank(doc, line) {
            return Some(line_start(doc, line));
        }
    }
}

/// Substring search for `n`/`N`, wrapping around the document. Returns the
/// start of the match after (forward) or before (backward) the cursor; a
/// full wrap may land back on the cursor's own match.
pub fn search_next(
    doc: &dyn VimText,
    pattern: &str,
    cursor: usize,
    forward: bool,
) -> Option<usize> {
    let len = doc.len();
    if pattern.is_empty() || len == 0 {
        return None;
    }
    let hay = doc.slice(0..len);
    let from = cursor.min(len);
    if forward {
        let start = (from + 1).min(len);
        if let Some(i) = hay[start..].find(pattern) {
            return Some(start + i);
        }
        hay.find(pattern)
    } else {
        if let Some(i) = hay[..from].rfind(pattern) {
            return Some(i);
        }
        hay.rfind(pattern)
    }
}

/// Record the pre-jump position and push it onto the jump list. The jump's
/// destination is pushed once the motion resolves (`push_jump_dest`), so the
/// list reads as the sequence of visited positions.
fn push_jump(doc: &dyn VimText, state: &mut VimState, from: usize) {
    state.jump_from = Some(from);
    state.jumplist.push(from.min(doc.len()));
}

fn push_jump_dest(state: &mut VimState, dest: usize) {
    state.jumplist.push(dest);
}

// ---------------------------------------------------------------------------
// Operator ranges: motion → (range, kind) with vim's exclusive adjustments
// ---------------------------------------------------------------------------

/// Range a motion covers when used with an operator, anchored at `cursor`.
/// Applies the two "exclusive adjustment" rules from `:h exclusive`:
/// 1. exclusive + end in column 0 (on a later line) → end moves to the end
///    of the previous line and the motion becomes inclusive;
/// 2. additionally, when the start was at or before the first non-blank of
///    its line → the motion becomes linewise.
/// This is what makes `dw` at the last word of a line stop at EOL, and
/// `d}` over a whole paragraph linewise.
pub fn motion_range(
    doc: &dyn VimText,
    state: &mut VimState,
    op: Operator,
    motion: Motion,
    count: u32,
    cursor: usize,
    viewport: Viewport,
) -> Option<(std::ops::Range<usize>, MotionKind)> {
    // `cw` special case (Change only, no count): change on a word acts like
    // `ce`, so the trailing whitespace survives. `dw` keeps word semantics.
    let motion = if op == Operator::Change && count == 1 {
        if let Motion::NextWordStart { big: false } = motion {
            let on_word = char_at(doc, cursor).map(is_word_char).unwrap_or(false);
            if on_word {
                Motion::NextWordEnd { big: false }
            } else {
                motion
            }
        } else {
            motion
        }
    } else {
        motion
    };

    let start_line = line_index(doc, cursor);
    let kind = motion_kind(motion);
    if kind == MotionKind::Linewise {
        let target = move_point(doc, state, motion, count, cursor, viewport)?.cursor;
        let end_line = line_index(doc, target);
        let (lo, hi) = if end_line < start_line {
            (end_line, start_line)
        } else {
            (start_line, end_line)
        };
        let range = line_start(doc, lo)..line_end(doc, hi);
        return Some((range, MotionKind::Linewise));
    }

    let target = move_point(doc, state, motion, count, cursor, viewport)?.cursor;
    let (range, kind) = if target < cursor {
        match kind {
            MotionKind::Inclusive => {
                // Include the char under the (fixed) start cursor.
                let cur_char = char_at(doc, cursor)?;
                (target..cursor + cur_char.len_utf8(), MotionKind::Inclusive)
            }
            _ => (target..cursor, MotionKind::Exclusive),
        }
    } else if target == cursor {
        return None; // no-op motion: operator aborts
    } else {
        (cursor..target, kind)
    };

    let (range, kind) = match kind {
        MotionKind::Inclusive => {
            let end = char_at(doc, range.end)
                .map(|c| range.end + c.len_utf8())
                .unwrap_or(range.end);
            (range.start..end, MotionKind::Inclusive)
        }
        MotionKind::Exclusive => {
            let end_line = line_index(doc, range.end);
            let at_col0 = end_line > start_line && range.end == line_start(doc, end_line);
            if at_col0 {
                let prev_end = line_end(doc, end_line - 1);
                if cursor <= first_non_blank(doc, start_line) {
                    // Rule 2: linewise.
                    (line_start(doc, start_line)..prev_end, MotionKind::Linewise)
                } else {
                    // Rule 1: inclusive of the previous line's end.
                    (range.start..prev_end, MotionKind::Inclusive)
                }
            } else {
                (range, MotionKind::Exclusive)
            }
        }
        MotionKind::Linewise => unreachable!(),
    };
    Some((range, kind))
}

fn motion_kind(motion: Motion) -> MotionKind {
    match motion {
        Motion::Down
        | Motion::Up
        | Motion::FirstLine
        | Motion::LastLine
        | Motion::Line { .. }
        | Motion::Mark { exact: false, .. } => MotionKind::Linewise,
        Motion::LineEnd
        | Motion::LastNonBlank
        | Motion::NextWordEnd { .. }
        | Motion::PrevWordEnd { .. }
        | Motion::FindForward { till: false, .. }
        | Motion::FindBackward { till: false, .. }
        | Motion::MatchingBracket => MotionKind::Inclusive,
        _ => MotionKind::Exclusive,
    }
}

/// The recorded `f`/`F`/`t`/`T` for `;`/`,` resolution.
pub fn last_find(state: &VimState) -> Option<LastFind> {
    state.last_find
}

/// Is `c` a word character (for `*` word extraction)?
pub fn is_word(c: char) -> bool {
    is_word_char(c)
}
