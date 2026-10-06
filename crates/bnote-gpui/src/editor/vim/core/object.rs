//! Text objects: `iw`, `aw`, `iW`, `aW`, quoted strings, bracket blocks,
//! paragraphs. Ranges are byte ranges over the abstract doc; the caller
//! decides linewise vs charwise application (objects are always charwise
//! except `ip`/`ap`, which report whole lines and are linewise for
//! operators like `dip`).

use super::doc::{
    big_char_class, char_at, char_class, last_line, line_index, line_is_blank,
    line_start, CharClass, VimText,
};
use super::motion::char_before;
use std::ops::Range;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Object {
    InnerWord { big: bool },
    AroundWord { big: bool },
    InnerQuote { quote: char },
    AroundQuote { quote: char },
    /// `ib`/`i(`/`i)` — inner bracket block (all bracket types share this).
    InnerBracket { open: char, close: char },
    /// `ab`/`a(`/`a)` — bracket block including brackets and surrounding
    /// whitespace (trailing first, then leading).
    AroundBracket { open: char, close: char },
    /// `ip` — inner paragraph (block of blank or non-blank lines).
    InnerParagraph,
    /// `ap` — paragraph plus one following blank line (or preceding when
    /// there is none after).
    AroundParagraph,
}

/// Compute the object range at `cursor`. `count` extends word objects over
/// subsequent words (vim's `v2iw`); other objects ignore it.
pub fn object_range(
    doc: &dyn VimText,
    object: Object,
    cursor: usize,
    count: u32,
) -> Option<(Range<usize>, bool)> {
    // (range, linewise)
    match object {
        Object::InnerWord { big } => inner_word(doc, big, cursor, count).map(|r| (r, false)),
        Object::AroundWord { big } => around_word(doc, big, cursor, count).map(|r| (r, false)),
        Object::InnerQuote { quote } => quote_range(doc, quote, cursor, false).map(|r| (r, false)),
        Object::AroundQuote { quote } => quote_range(doc, quote, cursor, true).map(|r| (r, false)),
        Object::InnerBracket { open, close } => {
            bracket_range(doc, open, close, cursor, false).map(|r| (r, false))
        }
        Object::AroundBracket { open, close } => {
            bracket_range(doc, open, close, cursor, true).map(|r| (r, false))
        }
        Object::InnerParagraph => paragraph_range(doc, cursor, false).map(|r| (r, true)),
        Object::AroundParagraph => paragraph_range(doc, cursor, true).map(|r| (r, true)),
    }
}

/// Map a text-object key to its [`Object`]. `inner` is the `i` prefix
/// (`false` = `a` prefix). Returns `None` for unknown object letters (the
/// operator aborts).
pub fn object_for_key(inner: bool, key: char) -> Option<Object> {
    match (inner, key) {
        (true, 'w') => Some(Object::InnerWord { big: false }),
        (false, 'w') => Some(Object::AroundWord { big: false }),
        (true, 'W') => Some(Object::InnerWord { big: true }),
        (false, 'W') => Some(Object::AroundWord { big: true }),
        (_, '"') if inner => Some(Object::InnerQuote { quote: '"' }),
        (_, '"') => Some(Object::AroundQuote { quote: '"' }),
        (_, '\'') if inner => Some(Object::InnerQuote { quote: '\'' }),
        (_, '\'') => Some(Object::AroundQuote { quote: '\'' }),
        (_, '`') if inner => Some(Object::InnerQuote { quote: '`' }),
        (_, '`') => Some(Object::AroundQuote { quote: '`' }),
        (_, 'b') | (_, '(') | (_, ')') => Some(Object::make_bracket(inner, '(', ')')),
        (_, 'B') | (_, '{') | (_, '}') => Some(Object::make_bracket(inner, '{', '}')),
        (_, '[') | (_, ']') => Some(Object::make_bracket(inner, '[', ']')),
        (_, '<') | (_, '>') => Some(Object::make_bracket(inner, '<', '>')),
        (true, 'p') => Some(Object::InnerParagraph),
        (false, 'p') => Some(Object::AroundParagraph),
        _ => None,
    }
}

impl Object {
    fn make_bracket(inner: bool, open: char, close: char) -> Object {
        if inner {
            Object::InnerBracket { open, close }
        } else {
            Object::AroundBracket { open, close }
        }
    }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/// Run of same-class chars containing `cursor` (empty when on whitespace
/// class boundary positions resolve to the whitespace run).
fn class_run(doc: &dyn VimText, cursor: usize, big: bool) -> Range<usize> {
    let class_fn = if big { big_char_class } else { char_class };
    let c = match char_at(doc, cursor) {
        Some(c) => c,
        None => return cursor..cursor,
    };
    let cls = class_fn(c);
    let ls = super::doc::line_range(doc, cursor).start;
    let le = super::doc::line_range(doc, cursor).end;

    let mut start = cursor;
    while start > ls {
        match char_before(doc, start) {
            Some(prev) if prev >= ls => match char_at(doc, prev) {
                Some(pc) if class_fn(pc) == cls => start = prev,
                _ => break,
            },
            _ => break,
        }
    }
    let mut end = cursor;
    while let Some(c2) = char_at(doc, end) {
        if end >= le || class_fn(c2) != cls {
            break;
        }
        end += c2.len_utf8();
    }
    start..end
}

/// `iw`/`iW`: the run under the cursor (the whitespace run when the cursor
/// is on whitespace). With a count, each further "run" — word *or*
/// whitespace — takes one step, ending at whatever the last run was. That
/// run-alternation is exactly how CM-vim's `expandWordUnderCursor` loop
/// behaves (`d2iw` on "bar" extends over "bar "): the Tauri shell's engine,
/// which is the behavior to match.
fn inner_word(doc: &dyn VimText, big: bool, cursor: usize, count: u32) -> Option<Range<usize>> {
    let first = class_run(doc, cursor, big);
    if count <= 1 {
        return Some(first);
    }
    let mut end = first.end;
    let mut taken = 1u32;
    while taken < count {
        if end >= doc.len() {
            break;
        }
        let run = class_run(doc, end, big);
        if run.end <= end {
            break;
        }
        end = run.end;
        taken += 1;
    }
    Some(first.start..end)
}

/// `aw`/`aW`: inner word plus trailing whitespace; when there is none (word
/// ends the line), the leading whitespace before it.
fn around_word(doc: &dyn VimText, big: bool, cursor: usize, count: u32) -> Option<Range<usize>> {
    let inner = inner_word(doc, big, cursor, count)?;
    // Only extend when the last covered run is a word (not whitespace).
    let on_word = char_at(doc, inner.start)
        .map(|c| {
            if big {
                big_char_class(c)
            } else {
                char_class(c)
            }
        })
        .is_some_and(|c| c != CharClass::White);
    if !on_word {
        return Some(inner);
    }
    let ls = super::doc::line_start_of(doc, inner.start);
    let le = super::doc::line_end_of(doc, inner.start);
    let mut end = inner.end;
    while end < le {
        match char_at(doc, end) {
            Some(c) if c.is_whitespace() => end += c.len_utf8(),
            _ => break,
        }
    }
    if end > inner.end {
        return Some(inner.start..end);
    }
    // No trailing whitespace: take leading whitespace instead.
    let mut start = inner.start;
    while start > ls {
        match char_before(doc, start) {
            Some(prev) if prev >= ls => match char_at(doc, prev) {
                Some(c) if c.is_whitespace() => start = prev,
                _ => break,
            },
            _ => break,
        }
    }
    Some(start..inner.end)
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/// Scan the cursor's line for `quote` pairs; select the pair surrounding the
/// cursor (a cursor ON a quote belongs to the pair it opens or closes).
/// Returns `None` when no enclosing pair exists on the line.
fn quote_range(doc: &dyn VimText, quote: char, cursor: usize, around: bool) -> Option<Range<usize>> {
    let line = super::doc::line_range(doc, cursor);
    let text = doc.slice(line.clone());
    let mut pairs: Vec<(usize, usize)> = Vec::new(); // byte offsets within line (open, close)
    let mut open: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if c == quote {
            match open {
                Some(o) => {
                    pairs.push((o, i));
                    open = None;
                }
                None => open = Some(i),
            }
        }
    }
    let cursor_in_line = cursor - line.start;
    for (o, c) in pairs {
        let inner = (o + quote.len_utf8())..c;
        if cursor_in_line >= o && cursor_in_line <= c {
            // Cursor touches this pair (on either quote or inside).
            let exact_on_quote = cursor_in_line == o || cursor_in_line == c;
            let strictly_inside = cursor_in_line > o && cursor_in_line < c;
            if strictly_inside || exact_on_quote {
                return if around {
                    // Include quotes + surrounding whitespace like `aw`.
                    let a_start = line.start + o;
                    let a_end = line.start + c + quote.len_utf8();
                    expand_around(doc, a_start, a_end)
                } else {
                    Some(line.start + inner.start..line.start + inner.end)
                };
            }
        }
    }
    None
}

/// `aw`-style whitespace extension for `a"`/`a(`/`a[`: trailing whitespace
/// first, else leading.
fn expand_around(doc: &dyn VimText, start: usize, end: usize) -> Option<Range<usize>> {
    let ls = super::doc::line_start_of(doc, start);
    let le = super::doc::line_end_of(doc, start);
    let mut e = end;
    while e < le {
        match char_at(doc, e) {
            Some(c) if c.is_whitespace() => e += c.len_utf8(),
            _ => break,
        }
    }
    if e > end {
        return Some(start..e);
    }
    let mut s = start;
    while s > ls {
        match char_before(doc, s) {
            Some(prev) if prev >= ls => match char_at(doc, prev) {
                Some(c) if c.is_whitespace() => s = prev,
                _ => break,
            },
            _ => break,
        }
    }
    Some(s..end)
}

// ---------------------------------------------------------------------------
// Brackets
// ---------------------------------------------------------------------------

/// Innermost bracket pair of `(open, close)` surrounding `cursor` (nesting
/// aware; the cursor may sit on either bracket). Inner excludes the brackets
/// and is trimmed of surrounding whitespace; around includes the brackets
/// plus surrounding whitespace.
fn bracket_range(
    doc: &dyn VimText,
    open: char,
    close: char,
    cursor: usize,
    around: bool,
) -> Option<Range<usize>> {
    // Find the close: scan forward tracking depth.
    let mut depth: i32 = 0;
    let mut close_pos = None;
    let mut pos = cursor;
    loop {
        match char_at(doc, pos) {
            Some(c) => {
                if c == close {
                    if depth == 0 {
                        close_pos = Some(pos);
                        break;
                    }
                    depth -= 1;
                } else if c == open {
                    depth += 1;
                }
                pos += c.len_utf8();
                if pos > doc.len() {
                    return None;
                }
            }
            None => return None,
        }
    }
    let close_pos = close_pos?;
    // Find the open: scan backward tracking depth. The close bracket we are
    // matching (at `close_pos`) is consumed, not counted.
    let mut depth: i32 = 0;
    let mut open_pos = None;
    let mut pos = close_pos;
    loop {
        match char_at(doc, pos) {
            Some(c) => {
                if c == close && pos != close_pos {
                    depth += 1;
                } else if c == open {
                    if depth == 0 {
                        open_pos = Some(pos);
                        break;
                    }
                    depth -= 1;
                }
                if pos == 0 {
                    return None;
                }
                pos = char_before(doc, pos)?;
            }
            None => return None,
        }
    }
    let open_pos = open_pos?;
    let inner_start = open_pos + open.len_utf8();
    if !around {
        // Trim whitespace at both ends of the inner range; keep the (empty)
        // span when the inside is only whitespace.
        let raw = doc.slice(inner_start..close_pos);
        let lead = raw.len() - raw.trim_start().len();
        let trail = raw.len() - raw.trim_end().len();
        let s = inner_start + lead;
        let e = close_pos - trail;
        return Some(s.max(e.min(s))..e.max(s));
    }
    // `a(`-style: the brackets themselves — no whitespace extension (vim
    // reserves that for `a"`/`aw`; `da(` on "f(a, (bc), d)" leaves the
    // spaces around the pair intact).
    Some(open_pos..close_pos + close.len_utf8())
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

/// Block of lines around the cursor that are all-blank or all-non-blank.
fn paragraph_range(doc: &dyn VimText, cursor: usize, around: bool) -> Option<Range<usize>> {
    let line = line_index(doc, cursor);
    let blank = line_is_blank(doc, line);
    let mut lo = line;
    while lo > 0 && line_is_blank(doc, lo - 1) == blank {
        lo -= 1;
    }
    let mut hi = line;
    while hi < last_line(doc) && line_is_blank(doc, hi + 1) == blank {
        hi += 1;
    }
    if !blank {
        // Inner paragraph of content: exact block.
    }
    if around {
        // Include ONE following blank line when present; otherwise the
        // preceding blank line (vim's `ap`).
        if hi < last_line(doc) && line_is_blank(doc, hi + 1) {
            hi += 1;
        } else if lo > 0 && line_is_blank(doc, lo - 1) {
            lo -= 1;
        }
    }
    let start = line_start(doc, lo);
    let end = if hi < last_line(doc) {
        line_start(doc, hi + 1)
    } else {
        doc.len()
    };
    Some(start..end)
}

/// Skip helper shared with exec: does `c` open a quote-object context?
pub fn is_quote(c: char) -> bool {
    matches!(c, '"' | '\'' | '`')
}
