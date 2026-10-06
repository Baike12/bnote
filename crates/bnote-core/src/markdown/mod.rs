//! Markdown pure-logic ported from `bnote/src/editor/` and `src/lib/` —
//! math scan, callout scan, heading numbering, fuzzy ranking, list/heading
//! text transforms.
//!
//! # Offset convention
//!
//! Every range in this module uses **UTF-8 byte offsets into the input
//! `&str`** (the same convention CodeMirror uses for its documents). Line
//! numbers, where a function takes or returns them, are **1-based** like
//! CodeMirror's `doc.line(n)`. All scanners are pure functions of the text
//! alone, so the host can memoize results per document generation.

pub mod callout;
pub mod context;
pub mod fuzzy;
pub mod math_scan;
pub mod numbering;
pub mod ops;
pub mod recent;
pub mod switcher;
pub mod tree;
pub mod wikilink;

/// Line ranges of `text` as `[(start, end)]` byte offsets, `end` exclusive and
/// pointing at the `\n` (i.e. the line text is `&text[start..end]`). Mirrors
/// CodeMirror's `doc.line(n)` (`from`/`to` exclude the line break).
pub(crate) fn line_ranges(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            out.push((start, i));
            start = i + 1;
        }
    }
    out.push((start, bytes.len()));
    out
}

/// JS-style whitespace for the hand-written scanners that mirror `\s` /
/// `[ \t]` regex classes: ASCII whitespace only. Real note text virtually
/// never carries the unicode extras (`\u00a0` & co) the JS class would match.
#[inline]
pub(crate) fn is_js_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C)
}

#[cfg(test)]
mod tests {
    use super::line_ranges;

    #[test]
    fn line_ranges_splits_on_newlines_and_keeps_last_line() {
        assert_eq!(line_ranges(""), vec![(0, 0)]);
        assert_eq!(line_ranges("ab"), vec![(0, 2)]);
        assert_eq!(line_ranges("ab\ncd\n"), vec![(0, 2), (3, 5), (6, 6)]);
        assert_eq!(line_ranges("\n\nx"), vec![(0, 0), (1, 1), (2, 3)]);
    }
}
