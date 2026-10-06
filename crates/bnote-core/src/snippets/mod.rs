//! Port of `bnote/src/editor/snippets/` — the obsidian-latex-suite snippet
//! engine (trigger matching, replacement expansion, tabstop sessions) plus the
//! LaTeX Suite key features that share its geometry: auto-fraction, bracket
//! enlargement, matrix shortcuts, tabout and bracket coloring.
//!
//! Pure logic only: no IO, no clock, no editor runtime. The host (GPUI shell)
//! owns the document, the cursor and the key plumbing.
//!
//! # Offsets
//!
//! Every range in this module is a **UTF-8 byte offset into the input `&str`**,
//! the same convention as [`crate::markdown`]. The TS sources index UTF-16 code
//! units; the two coincide for ASCII (all snippet triggers, brackets and
//! delimiters) and the port keeps the byte semantics for the rest — every
//! position that is sliced is kept on a char boundary by the scanners.
//!
//! # Host contract
//!
//! * A document edit is described by [`Replace`] (`from`/`to`/`insert`, in
//!   **pre-edit** coordinates, the CodeMirror `ChangeSpec` shape).
//!   [`apply_replace`] / [`apply_replaces`] are provided for hosts that keep
//!   the document as a plain string.
//! * [`session::SessionStack`] is the single writer of snippet-session state.
//!   The `keys::*` entry points mutate it and return a [`keys::KeyAction`]:
//!   on `Apply`, the stack is already consistent with the returned `changes`
//!   (the host applies them to the document and moves the cursor); on `Pass`,
//!   the host applies its own default edit and must then remap the stack with
//!   [`session::SessionStack::apply_edit`].
//! * Everything else is a pure function of `(&str, position/range, settings)`;
//!   the memoized `scan_math` regions are always passed in, never recomputed.
//!
//! # Deliberate divergences from the TS port
//!
//! * The TS modules keep module-level mutable state (`snippetStore`,
//!   `latexConfig`, `snippetLoader`); here the state is explicit host-owned
//!   data ([`engine::SnippetStore`], [`config::LatexConfig`]) that is passed as
//!   a parameter. Settings and snippet-source ownership are host concerns.
//! * `load.ts`'s `SnippetLoader` (async blob-module import, content caching)
//!   is IO and stays a shell concern; [`load`] keeps the portable data shape
//!   and its validation.
//! * Regex triggers use the `regex` crate — see the rationale in
//!   [`engine`]'s module docs.

pub mod autofraction;
pub mod brackets;
pub mod config;
pub mod default_snippets;
pub mod engine;
pub mod enlarge;
pub mod keys;
pub mod load;
pub mod matrix;
pub mod replacement;
pub mod session;
pub mod tabout;

pub use config::{DEFAULT_LATEX_CONFIG, LATEX_SUITE_WORD_DELIMITERS, LatexConfig};
pub use engine::{
    CompiledSnippets, Expansion, MatchOptions, Snippet, SnippetMode, SnippetSource, SnippetStore,
};
pub use keys::KeyAction;
pub use replacement::{ParsedReplacement, Stop, parse_replacement};
pub use session::{Session, SessionStack, TabPlan};

/// One range in the document, in byte offsets, `to` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Range {
    pub from: usize,
    pub to: usize,
}

impl Range {
    pub const fn new(from: usize, to: usize) -> Self {
        Self { from, to }
    }

    /// A caret at `pos`.
    pub const fn caret(pos: usize) -> Self {
        Self { from: pos, to: pos }
    }

    pub const fn is_empty(&self) -> bool {
        self.from == self.to
    }
}

/// One document edit in pre-edit coordinates: replace `[from, to)` with
/// `insert`. Mirrors CodeMirror's `ChangeSpec` (the TS dispatches carry the
/// same shape).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replace {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

impl Replace {
    pub fn new(from: usize, to: usize, insert: impl Into<String>) -> Self {
        Self { from, to, insert: insert.into() }
    }

    /// Insert `text` at `pos`.
    pub fn insert_at(pos: usize, text: impl Into<String>) -> Self {
        Self { from: pos, to: pos, insert: text.into() }
    }

    /// Delete `[from, to)`.
    pub fn delete(from: usize, to: usize) -> Self {
        Self { from, to, insert: String::new() }
    }
}

/// Applies one [`Replace`] to a document string. Pure helper for hosts that
/// keep the document as a `String`; a host with its own rope only needs the
/// offsets.
pub fn apply_replace(doc: &str, r: &Replace) -> String {
    let mut out = String::with_capacity(doc.len() + r.insert.len());
    out.push_str(&doc[..r.from]);
    out.push_str(&r.insert);
    out.push_str(&doc[r.to..]);
    out
}

/// Applies several non-overlapping [`Replace`]s (all in pre-edit coordinates,
/// like a CodeMirror transaction) to a document string.
pub fn apply_replaces(doc: &str, changes: &[Replace]) -> String {
    if changes.len() == 1 {
        return apply_replace(doc, &changes[0]);
    }
    let mut ordered: Vec<&Replace> = changes.iter().collect();
    ordered.sort_by_key(|r| std::cmp::Reverse(r.from));
    let mut out = doc.to_string();
    for r in ordered {
        out = apply_replace(&out, r);
    }
    out
}

/// Nearest char boundary at or before `pos`.
pub(crate) fn boundary_before(text: &str, pos: usize) -> usize {
    let mut p = pos.min(text.len());
    while p > 0 && !text.is_char_boundary(p) {
        p -= 1;
    }
    p
}

/// The char starting at `pos` (None at/after the end). Byte-based counterpart
/// of the TS single-code-unit slices.
pub(crate) fn char_at(text: &str, pos: usize) -> Option<char> {
    let pos = boundary_before(text, pos);
    text.get(pos..)?.chars().next()
}

/// The char ending at `pos` (the one before it), None at the document start.
pub(crate) fn prev_char(text: &str, pos: usize) -> Option<char> {
    let pos = boundary_before(text, pos);
    text[..pos].chars().next_back()
}

/// Start index of the char ending at `pos`.
pub(crate) fn prev_char_start(text: &str, pos: usize) -> Option<usize> {
    let p = prev_char(text, pos)?;
    Some(boundary_before(text, pos) - p.len_utf8())
}

/// Start index of the char after the one starting at `pos`.
pub(crate) fn next_char_start(text: &str, pos: usize) -> Option<usize> {
    let pos = boundary_before(text, pos);
    let c = text.get(pos..)?.chars().next()?;
    Some(pos + c.len_utf8())
}

/// JS whitespace for the hand-rolled scans (`\s` / `trimEnd`): `char::is_whitespace`
/// covers the Unicode space separators JS also trims, plus the BOM which only
/// JS counts.
pub(crate) fn is_js_ws_char(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// JS `String.prototype.trimEnd`.
pub(crate) fn trim_end_js_ws(s: &str) -> &str {
    s.trim_end_matches(is_js_ws_char)
}

/// Byte offset of the start of the line containing `pos`.
pub(crate) fn line_start(text: &str, pos: usize) -> usize {
    let pos = boundary_before(text, pos);
    text[..pos].rfind('\n').map_or(0, |i| i + 1)
}

/// Byte offset of the end of the line containing `pos` (the `\n` or the
/// document end, excluding the line break — CodeMirror `doc.lineAt(pos).to`).
pub(crate) fn line_end(text: &str, pos: usize) -> usize {
    let pos = boundary_before(text, pos);
    text[pos..].find('\n').map_or(text.len(), |i| pos + i)
}

/// 1-based line number of `pos` (CodeMirror `doc.lineAt(pos).number`).
pub(crate) fn line_number(text: &str, pos: usize) -> usize {
    let pos = boundary_before(text, pos);
    1 + text[..pos].bytes().filter(|b| *b == b'\n').count()
}

/// Number of lines (CodeMirror `doc.lines`).
pub(crate) fn line_count(text: &str) -> usize {
    1 + text.bytes().filter(|b| *b == b'\n').count()
}

/// Byte offset of the start of line `n` (1-based, CodeMirror `doc.line(n).from`).
pub(crate) fn line_from_number(text: &str, n: usize) -> usize {
    if n <= 1 {
        return 0;
    }
    let mut count = 1usize;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            count += 1;
            if count == n {
                return i + 1;
            }
        }
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_replace_and_replaces() {
        let doc = "abcdef";
        assert_eq!(apply_replace(doc, &Replace::new(1, 3, "XY")), "aXYdef");
        assert_eq!(apply_replace(doc, &Replace::insert_at(6, "!")), "abcdef!");
        assert_eq!(apply_replace(doc, &Replace::delete(0, 2)), "cdef");
        // Multiple changes are pre-edit coordinates: applying them in any order
        // must yield the same result (CodeMirror transaction semantics).
        let changes = vec![Replace::new(1, 2, "Q"), Replace::new(4, 4, "Z")];
        assert_eq!(apply_replaces(doc, &changes), "aQcdZef");
    }

    #[test]
    fn char_helpers_stay_on_boundaries() {
        let doc = "值dm\nx";
        assert_eq!(char_at(doc, 0), Some('值'));
        assert_eq!(char_at(doc, 3), Some('d'));
        assert_eq!(char_at(doc, doc.len()), None);
        assert_eq!(prev_char(doc, 0), None);
        assert_eq!(prev_char(doc, 3), Some('值'));
        assert_eq!(prev_char_start(doc, 3), Some(0));
        assert_eq!(next_char_start(doc, 0), Some(3));
        // A mid-char position is clamped back to the boundary instead of
        // panicking (the caller's edits always sit on boundaries).
        assert_eq!(prev_char(doc, 1), None); // clamped to 0 → nothing before it
        assert_eq!(char_at(doc, 2), Some('值')); // clamped to 0 → that char
    }

    #[test]
    fn line_helpers_match_codemirror() {
        let doc = "ab\ncd\n";
        assert_eq!(line_start(doc, 0), 0);
        assert_eq!(line_start(doc, 4), 3);
        assert_eq!(line_end(doc, 0), 2);
        assert_eq!(line_end(doc, 3), 5);
        assert_eq!(line_number(doc, 0), 1);
        assert_eq!(line_number(doc, 3), 2);
        assert_eq!(line_count(doc), 3); // trailing \n → one empty last line
        assert_eq!(line_from_number(doc, 2), 3);
        assert_eq!(line_from_number(doc, 3), 6);
        assert_eq!(line_from_number(doc, 9), doc.len());
    }
}
