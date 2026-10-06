//! Abstract text host for the vim core.
//!
//! The core never touches gpui or the rope directly; everything is expressed
//! over this trait so the whole state machine runs against a `String`-backed
//! test double. Implementations must be cheap: `len`, `char_at`, `line_*` and
//! `slice` are called O(local range) per motion — never O(whole document)
//! beyond what a rope already exposes in O(log n).

use std::ops::Range;

/// Minimal read-only text view the vim core operates on. Byte offsets are
/// UTF-8, matching gpui-kit's `EditorState::cursor()` semantics.
pub trait VimText {
    /// Byte length of the document.
    fn len(&self) -> usize;
    /// The char whose byte range contains `off` (an offset inside a
    /// multi-byte char resolves to that char). `None` only at/after the end.
    fn char_at(&self, off: usize) -> Option<char>;
    /// Byte range of the line containing `byte`, excluding the trailing
    /// newline (`\n`; `\r\n` keeps the `\r` in the line for v1 — bnote
    /// documents are `\n`).
    fn line_range(&self, byte: usize) -> Range<usize>;
    /// Number of lines. A trailing newline terminates the last line (i.e.
    /// `"a\n"` has 2 lines, the second empty).
    fn line_count(&self) -> usize;
    /// Line `idx` without its newline (empty slice when out of range).
    fn line(&self, idx: usize) -> &str;
    /// Clamped slice. Must return a `&str` that splits on char boundaries.
    fn slice(&self, range: Range<usize>) -> &str;
}

impl VimText for str {
    fn len(&self) -> usize {
        str::len(self)
    }
    fn char_at(&self, off: usize) -> Option<char> {
        if self.is_empty() {
            return None;
        }
        let off = clamp_char(self, off.min(self.len()));
        self[off..].chars().next()
    }
    fn line_range(&self, byte: usize) -> Range<usize> {
        let byte = byte.min(self.len());
        let start = self[..byte]
            .rfind('\n')
            .map_or(0, |i| i + 1);
        let end = self[byte..]
            .find('\n')
            .map_or(self.len(), |i| byte + i);
        start..end
    }
    fn line_count(&self) -> usize {
        self.bytes().filter(|&b| b == b'\n').count() + 1
    }
    fn line(&self, idx: usize) -> &str {
        if idx >= self.line_count() {
            return "";
        }
        let mut start = 0;
        for _ in 0..idx {
            start += self[start..].find('\n').map_or(self.len() - start, |i| i + 1);
        }
        let end = self[start..].find('\n').map_or(self.len(), |i| start + i);
        &self[start..end]
    }
    fn slice(&self, range: Range<usize>) -> &str {
        let start = clamp_char(self, range.start);
        let end = clamp_char(self, range.end.max(start));
        &self[start..end]
    }
}

impl VimText for String {
    fn len(&self) -> usize {
        self.as_str().len()
    }
    fn char_at(&self, off: usize) -> Option<char> {
        self.as_str().char_at(off)
    }
    fn line_range(&self, byte: usize) -> std::ops::Range<usize> {
        self.as_str().line_range(byte)
    }
    fn line_count(&self) -> usize {
        self.as_str().line_count()
    }
    fn line(&self, idx: usize) -> &str {
        self.as_str().line(idx)
    }
    fn slice(&self, range: std::ops::Range<usize>) -> &str {
        self.as_str().slice(range)
    }
}

impl<T: VimText + ?Sized> VimText for &T {
    fn len(&self) -> usize {
        (**self).len()
    }
    fn char_at(&self, off: usize) -> Option<char> {
        (**self).char_at(off)
    }
    fn line_range(&self, byte: usize) -> Range<usize> {
        (**self).line_range(byte)
    }
    fn line_count(&self) -> usize {
        (**self).line_count()
    }
    fn line(&self, idx: usize) -> &str {
        (**self).line(idx)
    }
    fn slice(&self, range: Range<usize>) -> &str {
        (**self).slice(range)
    }
}

/// Round `off` down to a char boundary (clamped).
pub fn clamp_char(text: &str, off: usize) -> usize {
    let mut off = off.min(text.len());
    while off > 0 && !text.is_char_boundary(off) {
        off -= 1;
    }
    off
}

/// Free-function form of [`VimText::char_at`] for `dyn` ergonomics.
pub fn char_at(doc: &dyn VimText, off: usize) -> Option<char> {
    doc.char_at(off)
}

/// Clamp `off` into `0..=len` and round to the *next* char boundary when it
/// lands inside a multi-byte char (used for range ends).
pub fn clamp_char_end(text: &str, off: usize) -> usize {
    let len = text.len();
    if off >= len {
        return len;
    }
    let mut off = off;
    while off < len && !text.is_char_boundary(off) {
        off += 1;
    }
    off
}

// ---------------------------------------------------------------------------
// Line helpers over the trait
// ---------------------------------------------------------------------------

/// Number of lines (free-function form for `dyn` ergonomics).
pub fn line_count(doc: &dyn VimText) -> usize {
    doc.line_count()
}

/// Index of the line containing `byte`.
pub fn line_index(doc: &dyn VimText, byte: usize) -> usize {
    doc.slice(0..byte.min(doc.len())).bytes().filter(|&b| b == b'\n').count()
}

/// Byte range of the line containing `byte` (free-function form of the
/// trait method, for `dyn` ergonomics).
pub fn line_range(doc: &dyn VimText, byte: usize) -> Range<usize> {
    doc.line_range(byte)
}

/// Byte range of line `idx` (by index) excluding the newline; clamped to the
/// last line.
pub fn line_range_at(doc: &dyn VimText, idx: usize) -> Range<usize> {
    if idx == 0 {
        return doc.line_range(0);
    }
    let mut start = 0usize;
    for _ in 0..idx {
        match doc.slice(start..doc.len()).find('\n') {
            Some(i) => start += i + 1,
            None => return doc.len()..doc.len(),
        }
    }
    let end = doc
        .slice(start..doc.len())
        .find('\n')
        .map_or(doc.len(), |i| start + i);
    start..end
}

/// Byte offset of the first char of the line CONTAINING `byte`.
pub fn line_start_of(doc: &dyn VimText, byte: usize) -> usize {
    doc.line_range(byte).start
}

/// Byte offset one past the last char of the line CONTAINING `byte`.
pub fn line_end_of(doc: &dyn VimText, byte: usize) -> usize {
    doc.line_range(byte).end
}

/// First non-whitespace byte on the line CONTAINING `byte`.
pub fn first_non_blank_at(doc: &dyn VimText, byte: usize) -> usize {
    first_non_blank(doc, line_index(doc, byte))
}

/// Byte offset of the first char of line `idx`.
pub fn line_start(doc: &dyn VimText, idx: usize) -> usize {
    line_range_at(doc, idx).start
}

/// Byte offset one past the last char of line `idx` (i.e. at the newline or
/// end of document).
pub fn line_end(doc: &dyn VimText, idx: usize) -> usize {
    line_range_at(doc, idx).end
}

/// Is the line empty or whitespace-only?
pub fn line_is_blank(doc: &dyn VimText, idx: usize) -> bool {
    doc.line(idx).trim().is_empty()
}

/// Index of the last line (never underflows; empty doc => line 0).
pub fn last_line(doc: &dyn VimText) -> usize {
    doc.line_count().saturating_sub(1)
}

/// First non-whitespace byte offset on line `idx` (line end when the line is
/// blank).
pub fn first_non_blank(doc: &dyn VimText, idx: usize) -> usize {
    let range = line_range_at(doc, idx);
    for (i, c) in doc.slice(range.clone()).char_indices() {
        if !c.is_whitespace() {
            return range.start + i;
        }
    }
    range.end
}

/// Indentation (leading whitespace) of line `idx` as a string.
pub fn line_indent(doc: &dyn VimText, idx: usize) -> &str {
    let text = doc.line(idx);
    let end = text
        .char_indices()
        .find(|(_, c)| !c.is_whitespace())
        .map_or(text.len(), |(i, _)| i);
    &text[..end]
}

// ---------------------------------------------------------------------------
// Word classification
// ---------------------------------------------------------------------------

/// Word classes mirroring vim's `iskeyword` split used by @replit/codemirror-vim:
/// Word (letters/digits/underscore/CJK — `char::is_alphanumeric` covers CJK
/// ideographs, which carry the Alphabetic property), Punctuation, and
/// Whitespace.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CharClass {
    Word,
    Punct,
    White,
}

pub fn char_class(c: char) -> CharClass {
    if c.is_whitespace() {
        CharClass::White
    } else if c.is_alphanumeric() || c == '_' {
        CharClass::Word
    } else {
        CharClass::Punct
    }
}

/// Big-word class: only whitespace separates words.
pub fn big_char_class(c: char) -> CharClass {
    if c.is_whitespace() {
        CharClass::White
    } else {
        CharClass::Word
    }
}

pub fn is_word_char(c: char) -> bool {
    char_class(c) == CharClass::Word
}

#[cfg(test)]
pub(crate) mod test_support {
    //! `StringDoc` — the `VimText` test double the whole suite runs against.

    use super::VimText;

    #[derive(Clone, PartialEq, Eq, Debug)]
    pub struct StringDoc(pub String);

    impl StringDoc {
        pub fn new(s: &str) -> Self {
            StringDoc(s.to_string())
        }
    }

    impl VimText for StringDoc {
        fn len(&self) -> usize {
            self.0.len()
        }
        fn char_at(&self, off: usize) -> Option<char> {
            self.0.char_at(off)
        }
        fn line_range(&self, byte: usize) -> std::ops::Range<usize> {
            self.0.line_range(byte)
        }
        fn line_count(&self) -> usize {
            self.0.line_count()
        }
        fn line(&self, idx: usize) -> &str {
            self.0.line(idx)
        }
        fn slice(&self, range: std::ops::Range<usize>) -> &str {
            self.0.slice(range)
        }
    }
}
