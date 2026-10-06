//! The keystroke interpreter: `feed` turns one normalized key into an
//! [`Outcome`] given the current [`VimState`]. All text access goes through
//! [`VimText`]; all host capabilities through [`HostContext`].

use super::doc::{first_non_blank, last_line, line_end, line_index, line_start, VimText};
use super::key::Key;
use super::motion::{motion_range, move_point, Motion, MotionKind, Moved, Viewport};
use super::object::{object_for_key, object_range};
use super::ops::{
    apply_operator, delete_chars, delete_chars_before, increment, join_lines, open_line, paste,
    replace_chars, search_word_under_cursor, toggle_case_chars, CursorPlan, Execution,
    HostContext, HostIntent, Outcome,
};
use super::state::{
    InsertEntry, LastFind, Mode, OpPending, Operator, Pending, RegisterContent, RecordedOp,
    VimState,
};

/// Feed one key. `state` carries mode, pending sequence, registers, …;
/// `doc` is the current text; `ctx` the host snapshot. This is the ONLY
/// entry point the host needs.
/// Feed one key and write the planned mode back into the state.
///
/// This is the whole host protocol in one call: `feed` only *plans* the mode
/// change (`Execution.mode_after`), and a host that forgets to apply it leaves
/// the engine in the old mode — every later key is then interpreted in the
/// wrong mode. The engine's tests did the write-back by hand, which is exactly
/// how the shell came to miss it.
pub fn feed_apply(state: &mut VimState, doc: &dyn VimText, key: Key, ctx: &HostContext) -> Outcome {
    let outcome = feed(state, doc, key, ctx);
    if let Outcome::Executed(exec) = &outcome {
        if let Some(mode) = exec.mode_after {
            state.mode = mode;
        }
    }
    outcome
}

pub fn feed(state: &mut VimState, doc: &dyn VimText, key: Key, ctx: &HostContext) -> Outcome {
    match state.mode {
        Mode::Insert => feed_insert(state, doc, key, ctx),
        Mode::Replace => feed_replace(state, doc, key, ctx),
        Mode::Normal => feed_normal(state, doc, key, ctx),
        Mode::Visual | Mode::VisualLine | Mode::VisualBlock => feed_visual(state, doc, key, ctx),
    }
}

// ---------------------------------------------------------------------------
// Bookkeeping helpers
// ---------------------------------------------------------------------------

/// Log a key as part of the command under construction.
fn log(state: &mut VimState, key: Key) {
    if !state.replaying {
        state.keylog.push(key);
    }
}

/// Abort a pending sequence (Escape or failed resolution): no record for `.`.
fn abort(state: &mut VimState) -> Outcome {
    state.pending = Pending::None;
    state.keylog.clear();
    Outcome::Pending
}

/// A command resolved but does nothing (failed motion/object). Consumed,
/// unrecorded.
fn failed(state: &mut VimState) -> Outcome {
    state.pending = Pending::None;
    state.keylog.clear();
    Outcome::Executed(Execution::nothing())
}

/// Finish a command: record it for `.` (unless suppressed or non-repeatable)
/// and return the execution.
fn finish(state: &mut VimState, execution: Execution, recordable: bool) -> Outcome {
    if !state.replaying {
        if recordable && !state.keylog.is_empty() {
            state.repeat = Some(RecordedOp::Keys(state.keylog.drain(..).collect()));
        } else {
            state.keylog.clear();
        }
    }
    state.pending = Pending::None;
    Outcome::Executed(execution)
}

fn take_register(state: &mut VimState) -> Option<char> {
    state.registers.requested.take()
}

fn combine(pre: Option<u32>, post: Option<u32>) -> u32 {
    VimState::combine_counts(pre, post)
}

fn viewport_of(ctx: &HostContext) -> Viewport {
    ctx.viewport
}

/// Selection end extended over the char under `head` (visual selections are
/// head-inclusive like vim).
fn head_inclusive_end(doc: &dyn VimText, head: usize) -> usize {
    match doc.char_at(head) {
        Some(c) => head + c.len_utf8(),
        None => head,
    }
    .min(doc.len())
}

fn visual_selection(doc: &dyn VimText, anchor: usize, head: usize) -> std::ops::Range<usize> {
    let (lo, hi) = if anchor <= head {
        (anchor, head)
    } else {
        (head, anchor)
    };
    lo..head_inclusive_end(doc, hi)
}

// ---------------------------------------------------------------------------
// Insert mode
// ---------------------------------------------------------------------------

fn feed_insert(state: &mut VimState, doc: &dyn VimText, key: Key, ctx: &HostContext) -> Outcome {
    match key {
        Key::Escape => {
            let cursor = ctx.cursor;
            // Vim moves the cursor one char left on leaving insert (never
            // across the line start).
            let ls = super::doc::line_start_of(doc, cursor);
            let exit_pos = if cursor > ls {
                super::motion::char_before(doc, cursor).unwrap_or(cursor)
            } else {
                cursor
            };
            state.marks.set('^', exit_pos);
            state.last_insert_exit = Some(cursor);
            let recorded = state.end_insert_session();
            let mut execution = Execution::default()
                .with_cursor(CursorPlan::Collapse(exit_pos))
                .with_mode(Mode::Normal);
            // Count replay (`3iab<esc>`) + `.` recording.
            if let Some(op) = recorded {
                if !state.replaying {
                    let replay: Option<(usize, String)> = match &op {
                        RecordedOp::Insert { text, count } if *count > 1 => Some((
                            exit_pos.max(cursor),
                            text.repeat(*count as usize - 1),
                        )),
                        RecordedOp::InsertOpenLine { text, indent, count } if *count > 1 => {
                            let unit = format!("\n{}{}", indent, text);
                            Some((line_end(doc, line_index(doc, cursor)), unit.repeat(*count as usize - 1)))
                        }
                        _ => None,
                    };
                    if let Some((pos, extra)) = replay {
                        execution = execution.with_edit(pos..pos, extra.clone());
                        execution.cursor = Some(CursorPlan::Collapse(pos + extra.len()));
                    }
                    state.repeat = Some(op);
                }
            }
            finish(state, execution, false)
        }
        _ => Outcome::Unhandled, // native typing / IME; host records via record_insert
    }
}

// ---------------------------------------------------------------------------
// Replace mode
// ---------------------------------------------------------------------------

fn feed_replace(state: &mut VimState, doc: &dyn VimText, key: Key, ctx: &HostContext) -> Outcome {
    match key {
        Key::Escape => {
            let cursor = ctx.cursor;
            let ls = super::doc::line_start_of(doc, cursor);
            let exit_pos = if cursor > ls {
                super::motion::char_before(doc, cursor).unwrap_or(cursor)
            } else {
                cursor
            };
            state.marks.set('^', exit_pos);
            state.insert_session = None;
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Collapse(exit_pos))
                    .with_mode(Mode::Normal),
                false,
            )
        }
        Key::Char(c) => {
            let cursor = ctx.cursor;
            log(state, key);
            let execution = match doc.char_at(cursor) {
                Some(existing) if existing != '\n' => {
                    let end = cursor + existing.len_utf8();
                    Execution::default()
                        .with_edit(cursor..end, c.to_string())
                        .with_cursor(CursorPlan::Collapse(end))
                        .with_mode(Mode::Replace)
                }
                _ => {
                    // Past end of line: insert (vim R behavior).
                    Execution::default()
                        .with_edit(cursor..cursor, c.to_string())
                        .with_cursor(CursorPlan::Collapse(cursor + c.len_utf8()))
                        .with_mode(Mode::Replace)
                }
            };
            Outcome::Executed(execution)
        }
        _ => Outcome::Unhandled,
    }
}

// ---------------------------------------------------------------------------
// Normal mode
// ---------------------------------------------------------------------------

fn feed_normal(state: &mut VimState, doc: &dyn VimText, key: Key, ctx: &HostContext) -> Outcome {
    log(state, key);
    if state.pending.is_none() {
        start_command(state, doc, key, ctx, None)
    } else {
        let pending = std::mem::replace(&mut state.pending, Pending::None);
        dispatch_pending(state, doc, key, ctx, pending)
    }
}

fn dispatch_pending(
    state: &mut VimState,
    doc: &dyn VimText,
    key: Key,
    ctx: &HostContext,
    pending: Pending,
) -> Outcome {
    match pending {
        Pending::None => start_command(state, doc, key, ctx, None),
        Pending::Count { digits, op } => match key.char() {
            Some(c) if c.is_ascii_digit() => {
                if c == '0' && digits.is_empty() {
                    // `0` is a motion even behind an operator (d0).
                    return match op {
                        None => motion_command(state, doc, ctx, Motion::LineStart, 1),
                        Some(op) => operator_motion(state, doc, ctx, *op, None, Motion::LineStart),
                    };
                }
                let mut d = digits;
                VimState::push_count_digit(&mut d, c);
                state.pending = Pending::Count { digits: d, op };
                Outcome::Pending
            }
            _ => {
                let count = digits.parse::<u32>().ok();
                match op {
                    Some(op) => {
                        // The digits may precede an object (`d2iw`) rather
                        // than a motion: fold them into the operator and
                        // enter the object state again.
                        let mut op = *op;
                        op.pre_count = Some(VimState::combine_counts(op.pre_count, count));
                        match key.char() {
                            Some(c @ ('i' | 'a')) => {
                                state.pending = Pending::Object {
                                    inner: c == 'i',
                                    op: Box::new(op),
                                };
                                Outcome::Pending
                            }
                            _ => dispatch_with_operator(state, doc, key, ctx, op, None),
                        }
                    }
                    None => start_command(state, doc, key, ctx, count),
                }
            }
        },
        Pending::Operator(op) => {
            if let Some(c) = key.char() {
                // Doubled operator (`dd`, `yy`, `>>`, `guu`, …).
                if op_char(op.op) == Some(c) && op.op.doubled_is_linewise() {
                    return linewise_operator(state, doc, ctx, &op, op.pre_count);
                }
                if c.is_ascii_digit() {
                    return if c == '0' {
                        operator_motion(state, doc, ctx, *op, None, Motion::LineStart)
                    } else {
                        state.pending = Pending::Count {
                            digits: c.to_string(),
                            op: Some(Box::new(*op)),
                        };
                        Outcome::Pending
                    };
                }
                match c {
                    'i' | 'a' => {
                        state.pending = Pending::Object {
                            inner: c == 'i',
                            op: Box::new(*op),
                        };
                        Outcome::Pending
                    }
                    'g' => {
                        state.pending = Pending::GPrefix {
                            count: op.pre_count,
                            op: Some(Box::new(OpPending {
                                op: op.op,
                                register: op.register,
                                pre_count: op.pre_count,
                            })),
                        };
                        Outcome::Pending
                    }
                    _ => dispatch_with_operator(state, doc, key, ctx, *op, None),
                }
            } else {
                failed(state)
            }
        }
        Pending::Object { inner, op } => match key.char().and_then(|c| object_for_key(inner, c)) {
            Some(object) => {
                let count = combine(op.pre_count, None);
                match object_range(doc, object, ctx.cursor, count) {
                    Some((range, obj_linewise)) => {
                        let kind = if obj_linewise {
                            MotionKind::Linewise
                        } else {
                            MotionKind::Exclusive
                        };
                        execute_operator(state, doc, ctx, op.op, range, kind, op.register, count)
                    }
                    None => failed(state),
                }
            }
            None => failed(state),
        },
        Pending::Find {
            forward,
            till,
            count,
            op,
        } => match key.char() {
            Some(c) => {
                let motion = find_motion(forward, till, c);
                state.last_find = Some(LastFind {
                    ch: c,
                    forward,
                    till,
                });
                match op {
                    Some(op) => operator_motion(state, doc, ctx, *op, count, motion),
                    None => motion_command(state, doc, ctx, motion, combine(count, None)),
                }
            }
            None => failed(state),
        },
        Pending::ReplaceChar { count, visual } => match key.char() {
            Some(c) => {
                if visual {
                    replace_visual(state, doc, ctx, c)
                } else {
                    match replace_chars(doc, state, ctx.cursor, c, count) {
                        Some(execution) => finish(state, execution, true),
                        None => failed(state),
                    }
                }
            }
            None => abort(state),
        },
        Pending::SetMark => match key.char() {
            Some(c) if c.is_ascii_alphabetic() => {
                state.marks.set(c, ctx.cursor);
                finish(state, Execution::nothing(), false)
            }
            _ => failed(state),
        },
        Pending::GotoMark { exact, op } => {
            if exact && (key.char() == Some('`') || key.char() == Some('\'')) {
                // `` `` `` / `''`: back to the position before the last jump.
                return match state.jump_from {
                    Some(pos) if pos <= doc.len() => finish(
                        state,
                        Execution::default()
                            .with_cursor(CursorPlan::Collapse(pos))
                            .with_mode(Mode::Normal),
                        false,
                    ),
                    _ => failed(state),
                };
            }
            if !exact && (key.char() == Some('\'') || key.char() == Some('`')) {
                return match state.jump_from {
                    Some(pos) if pos <= doc.len() => {
                        let pos = first_non_blank(doc, line_index(doc, pos));
                        finish(
                            state,
                            Execution::default()
                                .with_cursor(CursorPlan::Collapse(pos))
                                .with_mode(Mode::Normal),
                            false,
                        )
                    }
                    _ => failed(state),
                };
            }
            let motion = match key.char() {
                Some(c)
                    if c.is_ascii_alphabetic()
                        || c == '^'
                        || c == '<'
                        || c == '>'
                        || c == '.' =>
                {
                    Motion::Mark { name: c, exact }
                }
                _ => return failed(state),
            };
            match op {
                Some(op) => operator_motion(state, doc, ctx, *op, None, motion),
                None => motion_command(state, doc, ctx, motion, 1),
            }
        }
        Pending::RegisterPrefix => match key.char() {
            Some(c)
                if c.is_ascii_alphanumeric()
                    || c == '_'
                    || c == '+'
                    || c == '-'
                    || c == '"' =>
            {
                state.registers.requested = Some(c);
                finish(state, Execution::nothing(), false)
            }
            _ => failed(state),
        },
        Pending::GPrefix { count, op } => match key.char() {
            Some(c) => g_prefix(state, doc, ctx, c, count, op),
            None => failed(state),
        },
        Pending::ZPrefix => finish(state, Execution::nothing(), false),
    }
}

fn op_char(op: Operator) -> Option<char> {
    match op {
        Operator::Change => Some('c'),
        Operator::Delete => Some('d'),
        Operator::Yank => Some('y'),
        Operator::Indent => Some('>'),
        Operator::Outdent => Some('<'),
        Operator::Lowercase => Some('u'),
        Operator::Uppercase => Some('U'),
        Operator::ToggleCase => Some('~'),
        Operator::ReplaceWith(_) => None,
        Operator::Join => Some('J'),
        Operator::Filter => None,
    }
}

fn find_motion(forward: bool, till: bool, ch: char) -> Motion {
    match (forward, till) {
        (true, false) => Motion::FindForward { ch, till: false },
        (true, true) => Motion::FindForward { ch, till: true },
        (false, false) => Motion::FindBackward { ch, till: false },
        (false, true) => Motion::FindBackward { ch, till: true },
    }
}

// ---------------------------------------------------------------------------
// Command starts (no pending)
// ---------------------------------------------------------------------------

fn start_command(
    state: &mut VimState,
    doc: &dyn VimText,
    key: Key,
    ctx: &HostContext,
    count: Option<u32>,
) -> Outcome {
    let Some(c) = key.char() else {
        return special_key(state, doc, ctx, key, count);
    };

    // Digits start a count; a lone `0` is the line-start motion.
    if c.is_ascii_digit() {
        if c == '0' {
            return motion_command(state, doc, ctx, Motion::LineStart, 1);
        }
        state.pending = Pending::Count {
            digits: c.to_string(),
            op: None,
        };
        return Outcome::Pending;
    }

    // Operator starters.
    let operator = match c {
        'd' => Some(Operator::Delete),
        'c' => Some(Operator::Change),
        'y' => Some(Operator::Yank),
        '>' => Some(Operator::Indent),
        '<' => Some(Operator::Outdent),
        _ => None,
    };
    if let Some(op) = operator {
        state.pending = Pending::Operator(Box::new(OpPending {
            op,
            register: take_register(state),
            pre_count: count,
        }));
        return Outcome::Pending;
    }

    match c {
        'g' => {
            state.pending = Pending::GPrefix { count, op: None };
            Outcome::Pending
        }
        'z' => {
            state.pending = Pending::ZPrefix;
            Outcome::Pending
        }
        'h' => motion_command(state, doc, ctx, Motion::Left, count.unwrap_or(1)),
        'l' => motion_command(state, doc, ctx, Motion::Right, count.unwrap_or(1)),
        'j' => motion_command(state, doc, ctx, Motion::Down, count.unwrap_or(1)),
        'k' => motion_command(state, doc, ctx, Motion::Up, count.unwrap_or(1)),
        ' ' => space_motion(state, doc, ctx, count.unwrap_or(1)),
        '^' => motion_command(state, doc, ctx, Motion::LineStartNonBlank, 1),
        '$' => motion_command(state, doc, ctx, Motion::LineEnd, count.unwrap_or(1)),
        '{' => motion_command(state, doc, ctx, Motion::ParagraphStart, count.unwrap_or(1)),
        '}' => motion_command(state, doc, ctx, Motion::ParagraphEnd, count.unwrap_or(1)),
        '%' => motion_command(state, doc, ctx, Motion::MatchingBracket, count.unwrap_or(1)),
        ';' => motion_command(
            state,
            doc,
            ctx,
            Motion::RepeatFind { reverse: false },
            count.unwrap_or(1),
        ),
        ',' => motion_command(
            state,
            doc,
            ctx,
            Motion::RepeatFind { reverse: true },
            count.unwrap_or(1),
        ),
        'G' => match count {
            Some(n) => motion_command(state, doc, ctx, Motion::Line { index: n as usize }, 1),
            None => motion_command(state, doc, ctx, Motion::LastLine, 1),
        },
        'n' => motion_command(
            state,
            doc,
            ctx,
            Motion::SearchNext { forward: true },
            count.unwrap_or(1),
        ),
        'N' => motion_command(
            state,
            doc,
            ctx,
            Motion::SearchNext { forward: false },
            count.unwrap_or(1),
        ),
        'H' => motion_command(state, doc, ctx, Motion::ViewTop, count.unwrap_or(1)),
        'M' => motion_command(state, doc, ctx, Motion::ViewMiddle, 1),
        'L' => motion_command(state, doc, ctx, Motion::ViewBottom, count.unwrap_or(1)),
        'w' => motion_command(
            state,
            doc,
            ctx,
            Motion::NextWordStart { big: false },
            count.unwrap_or(1),
        ),
        'W' => motion_command(
            state,
            doc,
            ctx,
            Motion::NextWordStart { big: true },
            count.unwrap_or(1),
        ),
        'e' => motion_command(
            state,
            doc,
            ctx,
            Motion::NextWordEnd { big: false },
            count.unwrap_or(1),
        ),
        'E' => motion_command(
            state,
            doc,
            ctx,
            Motion::NextWordEnd { big: true },
            count.unwrap_or(1),
        ),
        'b' => motion_command(
            state,
            doc,
            ctx,
            Motion::PrevWordStart { big: false },
            count.unwrap_or(1),
        ),
        'B' => motion_command(
            state,
            doc,
            ctx,
            Motion::PrevWordStart { big: true },
            count.unwrap_or(1),
        ),
        'f' => start_find(state, true, false, count, None),
        'F' => start_find(state, false, false, count, None),
        't' => start_find(state, true, true, count, None),
        'T' => start_find(state, false, true, count, None),
        'r' => {
            state.pending = Pending::ReplaceChar {
                count: count.unwrap_or(1),
                visual: false,
            };
            Outcome::Pending
        }
        'm' => {
            state.pending = Pending::SetMark;
            Outcome::Pending
        }
        '`' => {
            state.pending = Pending::GotoMark {
                exact: true,
                op: None,
            };
            Outcome::Pending
        }
        '\'' => {
            state.pending = Pending::GotoMark {
                exact: false,
                op: None,
            };
            Outcome::Pending
        }
        '"' => {
            state.pending = Pending::RegisterPrefix;
            Outcome::Pending
        }
        'x' => {
            let register = take_register(state);
            match delete_chars(doc, state, ctx.cursor, count.unwrap_or(1), register) {
                Some(execution) => finish(state, execution, true),
                None => failed(state),
            }
        }
        'X' => {
            let register = take_register(state);
            match delete_chars_before(doc, state, ctx.cursor, count.unwrap_or(1), register) {
                Some(execution) => finish(state, execution, true),
                None => failed(state),
            }
        }
        's' => {
            let register = take_register(state);
            match delete_chars(doc, state, ctx.cursor, count.unwrap_or(1), register) {
                Some(execution) => {
                    state.begin_insert_session(count.unwrap_or(1), InsertEntry::Plain);
                    finish(state, execution.with_mode(Mode::Insert), true)
                }
                None => failed(state),
            }
        }
        'D' => {
            let register = take_register(state);
            operator_motion(
                state,
                doc,
                ctx,
                OpPending { op: Operator::Delete, register, pre_count: None },
                None,
                Motion::LineEnd,
            )
        }
        'C' => {
            let register = take_register(state);
            operator_motion(
                state,
                doc,
                ctx,
                OpPending { op: Operator::Change, register, pre_count: None },
                None,
                Motion::LineEnd,
            )
        }
        'S' => {
            let register = take_register(state);
            linewise_operator(
                state,
                doc,
                ctx,
                &OpPending { op: Operator::Change, register, pre_count: count },
                count,
            )
        }
        '~' => match toggle_case_chars(doc, ctx.cursor, count.unwrap_or(1)) {
            Some(execution) => finish(state, execution, true),
            None => failed(state),
        },
        'J' => match join_lines(doc, ctx.cursor, count.unwrap_or(1), None) {
            Some(execution) => finish(state, execution, true),
            None => failed(state),
        },
        'p' => {
            let register = take_register(state);
            match paste(doc, state, ctx, true, count.unwrap_or(1), register) {
                Some(execution) => finish(state, execution, true),
                None => failed(state),
            }
        }
        'P' => {
            let register = take_register(state);
            match paste(doc, state, ctx, false, count.unwrap_or(1), register) {
                Some(execution) => finish(state, execution, true),
                None => failed(state),
            }
        }
        'o' => {
            let line = line_index(doc, ctx.cursor);
            let execution = open_line(doc, ctx.cursor, true);
            let indent = super::doc::line_indent(doc, line).to_string();
            state.begin_insert_session(
                count.unwrap_or(1),
                InsertEntry::OpenLine { below: true, indent },
            );
            finish(state, execution, true)
        }
        'O' => {
            let line = line_index(doc, ctx.cursor);
            let execution = open_line(doc, ctx.cursor, false);
            let indent = super::doc::line_indent(doc, line).to_string();
            state.begin_insert_session(
                count.unwrap_or(1),
                InsertEntry::OpenLine { below: false, indent },
            );
            finish(state, execution, true)
        }
        'i' => enter_insert(state, ctx.cursor, count),
        'a' => {
            let le = super::doc::line_end_of(doc, ctx.cursor);
            let pos = if ctx.cursor < le {
                ctx.cursor + doc.char_at(ctx.cursor).map_or(0, |c| c.len_utf8())
            } else {
                ctx.cursor
            };
            enter_insert(state, pos, count)
        }
        'I' => enter_insert(state, first_non_blank(doc, line_index(doc, ctx.cursor)), count),
        'A' => enter_insert(state, line_end(doc, line_index(doc, ctx.cursor)), count),
        'R' => {
            state.begin_insert_session(1, InsertEntry::Plain);
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Collapse(ctx.cursor))
                    .with_mode(Mode::Replace),
                false,
            )
        }
        '.' => replay(state, doc, ctx),
        'u' => finish(
            state,
            Execution::default().with_intent(HostIntent::Undo),
            false,
        ),
        '*' => match search_word_under_cursor(doc, state, ctx.cursor) {
            Some(execution) => finish(state, execution, false),
            None => failed(state),
        },
        '/' | '?' => finish(
            state,
            Execution::default().with_intent(HostIntent::OpenSearch),
            false,
        ),
        'v' => enter_visual(state, ctx, Mode::Visual),
        'V' => enter_visual(state, ctx, Mode::VisualLine),
        _ => Outcome::Unhandled,
    }
}

fn special_key(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    key: Key,
    count: Option<u32>,
) -> Outcome {
    match key {
        Key::Enter => {
            // `+`: first non-blank of the line `count` rows below.
            let line = (line_index(doc, ctx.cursor) + count.unwrap_or(1) as usize)
                .min(last_line(doc));
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Collapse(first_non_blank(doc, line)))
                    .with_mode(Mode::Normal),
                false,
            )
        }
        Key::Backspace => motion_command(state, doc, ctx, Motion::Left, count.unwrap_or(1)),
        Key::Delete => match delete_chars(doc, state, ctx.cursor, count.unwrap_or(1), None) {
            Some(execution) => finish(state, execution, true),
            None => failed(state),
        },
        Key::Up => motion_command(state, doc, ctx, Motion::Up, count.unwrap_or(1)),
        Key::Down => motion_command(state, doc, ctx, Motion::Down, count.unwrap_or(1)),
        Key::Left => motion_command(state, doc, ctx, Motion::Left, count.unwrap_or(1)),
        Key::Right => motion_command(state, doc, ctx, Motion::Right, count.unwrap_or(1)),
        Key::Ctrl('r') => finish(
            state,
            Execution::default().with_intent(HostIntent::Redo),
            false,
        ),
        Key::Ctrl('a') => match increment(doc, ctx.cursor, count.unwrap_or(1) as i64) {
            Some(execution) => finish(state, execution, true),
            None => failed(state),
        },
        Key::Ctrl('x') => match increment(doc, ctx.cursor, -(count.unwrap_or(1) as i64)) {
            Some(execution) => finish(state, execution, true),
            None => failed(state),
        },
        Key::Escape => {
            if state.pending.is_none() {
                Outcome::Unhandled
            } else {
                abort(state)
            }
        }
        Key::Ctrl('o') => match state.jumplist.back(1, doc.len()) {
            Some(pos) => finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Collapse(pos))
                    .with_mode(Mode::Normal),
                false,
            ),
            None => failed(state),
        },
        Key::Ctrl('d') => motion_command(
            state, doc, ctx, Motion::Page { forward: true, half: true }, count.unwrap_or(1),
        ),
        Key::Ctrl('u') => motion_command(
            state, doc, ctx, Motion::Page { forward: false, half: true }, count.unwrap_or(1),
        ),
        Key::Ctrl('f') => motion_command(
            state, doc, ctx, Motion::Page { forward: true, half: false }, count.unwrap_or(1),
        ),
        Key::Ctrl('b') => motion_command(
            state, doc, ctx, Motion::Page { forward: false, half: false }, count.unwrap_or(1),
        ),
        Key::Tab => Outcome::Unhandled,
        _ => Outcome::Unhandled,
    }
}

fn start_find(
    state: &mut VimState,
    forward: bool,
    till: bool,
    count: Option<u32>,
    op: Option<OpPending>,
) -> Outcome {
    state.pending = Pending::Find {
        forward,
        till,
        count,
        op: op.map(Box::new),
    };
    Outcome::Pending
}

fn enter_insert(state: &mut VimState, pos: usize, count: Option<u32>) -> Outcome {
    state.begin_insert_session(count.unwrap_or(1), InsertEntry::Plain);
    finish(
        state,
        Execution::default()
            .with_cursor(CursorPlan::Collapse(pos))
            .with_mode(Mode::Insert),
        false,
    )
}

fn enter_visual(state: &mut VimState, ctx: &HostContext, mode: Mode) -> Outcome {
    state.visual_anchor = ctx.cursor;
    finish(
        state,
        Execution::default()
            .with_cursor(CursorPlan::Collapse(ctx.cursor))
            .with_mode(mode),
        false,
    )
}

// ---------------------------------------------------------------------------
// g prefix
// ---------------------------------------------------------------------------

fn g_prefix(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    c: char,
    count: Option<u32>,
    op: Option<Box<OpPending>>,
) -> Outcome {
    match c {
        'g' => {
            let motion = match count {
                Some(n) => Motion::Line { index: n as usize },
                None => Motion::FirstLine,
            };
            match op {
                Some(op) => operator_motion(state, doc, ctx, *op, None, motion),
                None => motion_command(state, doc, ctx, motion, 1),
            }
        }
        '_' => match op {
            Some(op) => operator_motion(state, doc, ctx, *op, count, Motion::LastNonBlank),
            None => motion_command(state, doc, ctx, Motion::LastNonBlank, count.unwrap_or(1)),
        },
        'm' => motion_command(state, doc, ctx, Motion::LineMiddle, 1),
        'e' => match op {
            Some(op) => operator_motion(state, doc, ctx, *op, count, Motion::PrevWordEnd { big: false }),
            None => motion_command(
                state,
                doc,
                ctx,
                Motion::PrevWordEnd { big: false },
                count.unwrap_or(1),
            ),
        },
        'E' => match op {
            Some(op) => operator_motion(state, doc, ctx, *op, count, Motion::PrevWordEnd { big: true }),
            None => motion_command(
                state,
                doc,
                ctx,
                Motion::PrevWordEnd { big: true },
                count.unwrap_or(1),
            ),
        },
        'u' => operator_pending(state, Operator::Lowercase, count),
        'U' => operator_pending(state, Operator::Uppercase, count),
        '~' => operator_pending(state, Operator::ToggleCase, count),
        'i' => match state.last_insert_exit {
            Some(pos) if pos <= doc.len() => enter_insert(state, pos, None),
            _ => failed(state),
        },
        _ => failed(state),
    }
}

fn operator_pending(state: &mut VimState, op: Operator, count: Option<u32>) -> Outcome {
    state.pending = Pending::Operator(Box::new(OpPending {
        op,
        register: take_register(state),
        pre_count: count,
    }));
    Outcome::Pending
}

// ---------------------------------------------------------------------------
// Motion execution
// ---------------------------------------------------------------------------

fn motion_command(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    motion: Motion,
    count: u32,
) -> Outcome {
    let cursor = ctx.cursor;
    match move_point(doc, state, motion, count, cursor, viewport_of(ctx)) {
        Some(Moved { cursor: target }) => {
            // `l` may legally rest in the end-of-line slot (CM-vim's clip);
            // every other motion clamps to the last char at the doc end.
            let target = match motion {
                Motion::Right => target.min(doc.len()),
                _ => super::motion::clamp_to_char(doc, target),
            };
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Collapse(target))
                    .with_mode(Mode::Normal),
                false,
            )
        }
        None => failed(state),
    }
}

fn space_motion(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    count: u32,
) -> Outcome {
    // `<Space>` is `l`: one char right within the line, stopping after the
    // last char; it never wraps (CM-vim semantics).
    let mut pos = ctx.cursor;
    for _ in 0..count {
        let le = line_end(doc, line_index(doc, pos));
        if pos >= le {
            break;
        }
        let next = match doc.char_at(pos) {
            Some(c) => pos + c.len_utf8(),
            None => break,
        };
        pos = next.min(le);
    }
    state.curswant = None;
    finish(
        state,
        Execution::default()
            .with_cursor(CursorPlan::Collapse(pos))
            .with_mode(Mode::Normal),
        false,
    )
}

// ---------------------------------------------------------------------------
// Operator + motion / object / linewise
// ---------------------------------------------------------------------------

fn dispatch_with_operator(
    state: &mut VimState,
    doc: &dyn VimText,
    key: Key,
    ctx: &HostContext,
    op: OpPending,
    post_count: Option<u32>,
) -> Outcome {
    match key.char().and_then(motion_from_char) {
        Some(motion) => operator_motion(state, doc, ctx, op, post_count, motion),
        None => {
            if key == Key::Enter {
                operator_motion(state, doc, ctx, op, post_count, Motion::Down)
            } else {
                abort(state)
            }
        }
    }
}

fn operator_motion(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    op: OpPending,
    post_count: Option<u32>,
    motion: Motion,
) -> Outcome {
    let count = combine(op.pre_count, post_count);
    match motion_range(doc, state, op.op, motion, count, ctx.cursor, viewport_of(ctx)) {
        Some((range, kind)) => {
            execute_operator(state, doc, ctx, op.op, range, kind, op.register, count)
        }
        None => failed(state),
    }
}

fn execute_operator(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    op: Operator,
    range: std::ops::Range<usize>,
    kind: MotionKind,
    register: Option<char>,
    count: u32,
) -> Outcome {
    let register = register.or(take_register(state));
    let execution = apply_operator(
        doc,
        state,
        op,
        range,
        kind,
        register,
        count,
        ctx.cursor,
        ctx.shiftwidth,
    );
    finish(state, execution, true)
}

/// `dd`/`cc`/`yy`/`>>`/`<<`/`guu`/…: operator over whole lines.
fn linewise_operator(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    op: &OpPending,
    count: Option<u32>,
) -> Outcome {
    let lo = line_index(doc, ctx.cursor);
    let hi = (lo + count.unwrap_or(1).max(1) as usize - 1).min(last_line(doc));
    let range = line_start(doc, lo)..line_end(doc, hi);
    execute_operator(
        state,
        doc,
        ctx,
        op.op,
        range,
        MotionKind::Linewise,
        op.register,
        count.unwrap_or(1),
    )
}

fn motion_from_char(c: char) -> Option<Motion> {
    Some(match c {
        'h' => Motion::Left,
        'l' => Motion::Right,
        'j' => Motion::Down,
        'k' => Motion::Up,
        'w' => Motion::NextWordStart { big: false },
        'W' => Motion::NextWordStart { big: true },
        'e' => Motion::NextWordEnd { big: false },
        'E' => Motion::NextWordEnd { big: true },
        'b' => Motion::PrevWordStart { big: false },
        'B' => Motion::PrevWordStart { big: true },
        '0' => Motion::LineStart,
        '^' => Motion::LineStartNonBlank,
        '$' => Motion::LineEnd,
        '{' => Motion::ParagraphStart,
        '}' => Motion::ParagraphEnd,
        '%' => Motion::MatchingBracket,
        'n' => Motion::SearchNext { forward: true },
        'N' => Motion::SearchNext { forward: false },
        'G' => Motion::LastLine,
        'H' => Motion::ViewTop,
        'M' => Motion::ViewMiddle,
        'L' => Motion::ViewBottom,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// `.` repeat
// ---------------------------------------------------------------------------

fn replay(state: &mut VimState, doc: &dyn VimText, ctx: &HostContext) -> Outcome {
    let Some(op) = state.repeat.clone() else {
        return Outcome::Unhandled;
    };
    state.replaying = true;
    let result = match op {
        RecordedOp::Keys(keys) => {
            let mut last = Outcome::Unhandled;
            for key in keys {
                last = match state.mode {
                    Mode::Normal => feed_normal(state, doc, key, ctx),
                    Mode::Visual | Mode::VisualLine | Mode::VisualBlock => {
                        feed_visual(state, doc, key, ctx)
                    }
                    _ => Outcome::Unhandled,
                };
            }
            last
        }
        RecordedOp::Insert { text, count } => {
            let n = count.max(1) as usize;
            let inserted = text.repeat(n);
            Outcome::Executed(
                Execution::default()
                    .with_edit(ctx.cursor..ctx.cursor, inserted.clone())
                    .with_cursor(CursorPlan::Collapse(ctx.cursor + inserted.len()))
                    .with_mode(Mode::Normal),
            )
        }
        RecordedOp::InsertOpenLine { text, indent, count } => {
            let unit = format!("\n{}{}", indent, text);
            let total = unit.repeat((count.max(1) as usize).saturating_sub(1));
            let pos = line_end(doc, line_index(doc, ctx.cursor));
            Outcome::Executed(
                Execution::default()
                    .with_edit(pos..pos, total.clone())
                    .with_cursor(CursorPlan::Collapse(pos + total.len()))
                    .with_mode(Mode::Normal),
            )
        }
    };
    state.replaying = false;
    result
}

// ---------------------------------------------------------------------------
// Visual mode
// ---------------------------------------------------------------------------

fn feed_visual(state: &mut VimState, doc: &dyn VimText, key: Key, ctx: &HostContext) -> Outcome {
    log(state, key);
    if state.pending.is_none() {
        visual_command(state, doc, key, ctx, None)
    } else {
        let pending = std::mem::replace(&mut state.pending, Pending::None);
        dispatch_pending_visual(state, doc, key, ctx, pending)
    }
}

fn dispatch_pending_visual(
    state: &mut VimState,
    doc: &dyn VimText,
    key: Key,
    ctx: &HostContext,
    pending: Pending,
) -> Outcome {
    match pending {
        Pending::Count { digits, op: _ } => match key.char() {
            Some(c) if c.is_ascii_digit() && !(c == '0' && digits.is_empty()) => {
                let mut d = digits;
                VimState::push_count_digit(&mut d, c);
                state.pending = Pending::Count { digits: d, op: None };
                Outcome::Pending
            }
            _ => {
                let count = digits.parse::<u32>().unwrap_or(1);
                visual_command(state, doc, key, ctx, Some(count))
            }
        },
        Pending::Find {
            forward,
            till,
            count,
            op: _,
        } => match key.char() {
            Some(c) => {
                state.last_find = Some(LastFind {
                    ch: c,
                    forward,
                    till,
                });
                visual_move_count(
                    state,
                    doc,
                    ctx,
                    find_motion(forward, till, c),
                    count.unwrap_or(1),
                )
            }
            None => failed(state),
        },
        Pending::ReplaceChar { count: _, visual } if visual => match key.char() {
            Some(c) => replace_visual(state, doc, ctx, c),
            None => abort(state),
        },
        Pending::GotoMark { exact, op: _ } => match key.char() {
            Some(c) if c.is_ascii_alphabetic() => {
                visual_move_count(state, doc, ctx, Motion::Mark { name: c, exact }, 1)
            }
            _ => failed(state),
        },
        Pending::GPrefix { count, op: _ } => match key.char() {
            Some('g') => {
                let motion = match count {
                    Some(n) => Motion::Line { index: n as usize },
                    None => Motion::FirstLine,
                };
                visual_move_count(state, doc, ctx, motion, 1)
            }
            Some('_') => visual_move_count(state, doc, ctx, Motion::LastNonBlank, count.unwrap_or(1)),
            Some('e') => visual_move_count(state, doc, ctx, Motion::PrevWordEnd { big: false }, count.unwrap_or(1)),
            Some('E') => visual_move_count(state, doc, ctx, Motion::PrevWordEnd { big: true }, count.unwrap_or(1)),
            _ => failed(state),
        },
        Pending::Object { inner, op: _ } => match key.char().and_then(|c| object_for_key(inner, c)) {
            Some(object) => match object_range(doc, object, ctx.cursor, 1) {
                Some((range, _linewise)) => {
                    let head = super::motion::char_before(doc, range.end).unwrap_or(range.start);
                    state.visual_anchor = range.start;
                    finish(
                        state,
                        Execution::default()
                            .with_cursor(CursorPlan::Select {
                                anchor: range.start,
                                head,
                            })
                            .with_mode(state.mode),
                        false,
                    )
                }
                None => failed(state),
            },
            None => failed(state),
        },
        _ => failed(state),
    }
}

fn visual_command(
    state: &mut VimState,
    doc: &dyn VimText,
    key: Key,
    ctx: &HostContext,
    count: Option<u32>,
) -> Outcome {
    let anchor = state.visual_anchor;
    let head = ctx.cursor;
    let linewise = state.mode == Mode::VisualLine;

    let Some(c) = key.char() else {
        return special_key_visual(state, doc, ctx, key);
    };

    if c.is_ascii_digit() && c != '0' {
        state.pending = Pending::Count {
            digits: c.to_string(),
            op: None,
        };
        return Outcome::Pending;
    }

    match c {
        'f' | 'F' | 't' | 'T' => {
            state.pending = Pending::Find {
                forward: c == 'f' || c == 't',
                till: c == 't' || c == 'T',
                count,
                op: None,
            };
            Outcome::Pending
        }
        'g' => {
            state.pending = Pending::GPrefix { count, op: None };
            Outcome::Pending
        }
        '`' => {
            state.pending = Pending::GotoMark {
                exact: true,
                op: None,
            };
            Outcome::Pending
        }
        '\'' => {
            state.pending = Pending::GotoMark {
                exact: false,
                op: None,
            };
            Outcome::Pending
        }
        'r' => {
            state.pending = Pending::ReplaceChar {
                count: 1,
                visual: true,
            };
            Outcome::Pending
        }
        'i' | 'a' => {
            state.pending = Pending::Object {
                inner: c == 'i',
                op: Box::new(OpPending {
                    op: Operator::Delete,
                    register: None,
                    pre_count: None,
                }),
            };
            Outcome::Pending
        }
        'v' => finish(
            state,
            Execution::default()
                .with_cursor(CursorPlan::Collapse(head))
                .with_mode(Mode::Normal),
            false,
        ),
        'V' => {
            let next = if linewise { Mode::Normal } else { Mode::VisualLine };
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Select { anchor, head })
                    .with_mode(next),
                false,
            )
        }
        'o' | 'O' => {
            state.visual_anchor = head;
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Select {
                        anchor: head,
                        head: anchor,
                    })
                    .with_mode(state.mode),
                false,
            )
        }
        'I' => {
            // v1 single-cursor: insert at the selection start.
            let selection = visual_selection(doc, anchor, head);
            let pos = if linewise {
                first_non_blank(doc, line_index(doc, selection.start))
            } else {
                selection.start
            };
            state.begin_insert_session(1, InsertEntry::Plain);
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Collapse(pos))
                    .with_mode(Mode::Insert),
                false,
            )
        }
        'A' => {
            let selection = visual_selection(doc, anchor, head);
            let pos = if linewise {
                line_end(doc, line_index(doc, selection.end.saturating_sub(1)))
            } else {
                selection.end
            };
            state.begin_insert_session(1, InsertEntry::Plain);
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Collapse(pos))
                    .with_mode(Mode::Insert),
                false,
            )
        }
        _ => {
            // Operator-style commands over the selection.
            let selection = visual_selection(doc, anchor, head);
            let kind = if linewise {
                MotionKind::Linewise
            } else {
                MotionKind::Exclusive
            };
            let op = match c {
                'd' | 'x' | 'X' => Some(Operator::Delete),
                'y' => Some(Operator::Yank),
                'c' | 's' => Some(Operator::Change),
                '~' => Some(Operator::ToggleCase),
                'u' => Some(Operator::Lowercase),
                'U' => Some(Operator::Uppercase),
                '>' => Some(Operator::Indent),
                '<' => Some(Operator::Outdent),
                _ => None,
            };
            if let Some(op) = op {
                return execute_visual_operator(state, doc, ctx, op, selection, kind);
            }
            if c == 'J' {
                let lines = line_index(doc, selection.start)
                    ..line_index(doc, selection.end.saturating_sub(1).max(selection.start)) + 1;
                return match join_lines(doc, ctx.cursor, 1, Some(lines)) {
                    Some(execution) => finish(state, execution, true),
                    None => failed(state),
                };
            }
            if c == 'p' {
                return visual_paste(state, doc, ctx, selection, linewise);
            }
            // Motions.
            let motion = motion_from_char(c);
            match motion {
                Some(motion) => visual_move_count(state, doc, ctx, motion, count.unwrap_or(1)),
                None => Outcome::Unhandled,
            }
        }
    }
}

fn visual_paste(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    selection: std::ops::Range<usize>,
    _linewise: bool,
) -> Outcome {
    let register = take_register(state);
    let content = match register {
        Some('+') => ctx.clipboard.clone().map(|text| RegisterContent {
            linewise: ctx.clipboard.as_ref().is_some_and(|t| t.contains('\n')),
            text,
        }),
        other => state.registers.read(other).cloned(),
    };
    let Some(content) = content else {
        return failed(state);
    };
    if content.linewise {
        let lo = line_index(doc, selection.start);
        let hi = line_index(doc, selection.end.saturating_sub(1).max(selection.start));
        let range = line_start(doc, lo)..line_end(doc, hi);
        let cursor = first_non_blank(doc, lo);
        finish(
            state,
            Execution::default()
                .with_edit(range, content.text)
                .with_cursor(CursorPlan::Collapse(cursor))
                .with_mode(Mode::Normal),
            true,
        )
    } else {
        let cursor = selection.start;
        finish(
            state,
            Execution::default()
                .with_edit(selection.clone(), content.text.clone())
                .with_cursor(CursorPlan::Collapse(
                    (cursor + content.text.len()).saturating_sub(1),
                ))
                .with_mode(Mode::Normal),
            true,
        )
    }
}

fn visual_move_count(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    motion: Motion,
    count: u32,
) -> Outcome {
    let anchor = state.visual_anchor;
    match move_point(doc, state, motion, count, ctx.cursor, viewport_of(ctx)) {
        Some(Moved { cursor: new_head }) => finish(
            state,
            Execution::default()
                .with_cursor(CursorPlan::Select {
                    anchor,
                    head: super::motion::clamp_to_char(doc, new_head),
                })
                .with_mode(state.mode),
            false,
        ),
        None => failed(state),
    }
}

fn special_key_visual(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    key: Key,
) -> Outcome {
    let anchor = state.visual_anchor;
    let head = ctx.cursor;
    match key {
        Key::Escape => {
            // Vim collapses to the start of the selection.
            let pos = anchor.min(head);
            finish(
                state,
                Execution::default()
                    .with_cursor(CursorPlan::Collapse(pos))
                    .with_mode(Mode::Normal),
                false,
            )
        }
        Key::Up => visual_move_count(state, doc, ctx, Motion::Up, 1),
        Key::Down => visual_move_count(state, doc, ctx, Motion::Down, 1),
        Key::Left => visual_move_count(state, doc, ctx, Motion::Left, 1),
        Key::Right => visual_move_count(state, doc, ctx, Motion::Right, 1),
        Key::Enter => {
            let line = (line_index(doc, head) + 1).min(last_line(doc));
            visual_move_count(state, doc, ctx, Motion::Line { index: line + 1 }, 1)
        }
        _ => Outcome::Unhandled,
    }
}

fn replace_visual(state: &mut VimState, doc: &dyn VimText, ctx: &HostContext, c: char) -> Outcome {
    let anchor = state.visual_anchor;
    let selection = visual_selection(doc, anchor, ctx.cursor);
    // Replace every non-newline char with `c`, preserving line structure.
    let mut out = String::new();
    for ch in doc.slice(selection.clone()).chars() {
        if ch == '\n' {
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    let cursor = selection.start;
    finish(
        state,
        Execution::default()
            .with_edit(selection, out)
            .with_cursor(CursorPlan::Collapse(cursor))
            .with_mode(Mode::Normal),
        true,
    )
}

fn execute_visual_operator(
    state: &mut VimState,
    doc: &dyn VimText,
    ctx: &HostContext,
    op: Operator,
    selection: std::ops::Range<usize>,
    kind: MotionKind,
) -> Outcome {
    // Visual ops always leave visual mode (except Change, which enters
    // insert mode with the cursor at the deletion point).
    let register = take_register(state);
    let execution = apply_operator(
        doc,
        state,
        op,
        selection,
        kind,
        register,
        1,
        ctx.cursor,
        ctx.shiftwidth,
    );
    let execution = match execution.mode_after {
        Some(Mode::Insert) => execution,
        _ => execution.with_mode(Mode::Normal),
    };
    finish(state, execution, true)
}
