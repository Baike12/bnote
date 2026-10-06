//! Live-preview decorations: what the renderer hides and what it renders in
//! place of the hidden source (Obsidian-style live preview).
//!
//! This module is **pure data + rules**: it turns `(text, selections,
//! visible window)` into a [`PreviewSnapshot`] of byte ranges. The renderer
//! (gpui-kit's editor seam) consumes the snapshot: hidden bytes are removed
//! from shaping, widget spans get an element painted, block spans replace a
//! whole line range. Nothing here knows about GPUI, markdown trees or fonts.
//!
//! # Offset convention
//!
//! Byte offsets into the document `&str`, exactly like the rest of
//! `bnote-core::markdown`: half-open `Range<usize>`, no line separators
//! included. Lines are 0-based `usize` where a line index appears.
//!
//! # The activity rule (bnote's core live-preview semantics)
//!
//! A span is only rendered when the caret is **not** able to sit inside it
//! (bnote: "隐藏只发生在光标不在的行"): the line holding the caret shows
//! its raw source, every other line shows the rendered form. Two
//! consequences the rules must respect:
//!
//! - the caret line never carries hidden spans, so the caret can never land
//!   inside a hidden region;
//! - moving the caret on or off a line flips exactly that line's rendering.
//!
//! # Invariants (the renderer relies on these)
//!
//! - `spans` are sorted by `range.start` and pairwise disjoint;
//! - `blocks` are sorted by `first_line` and disjoint line ranges, and never
//!   contain the caret's line;
//! - every range is on a `char` boundary of `text`.

use std::ops::Range;

/// A span of the document the preview layer treats specially.
///
/// `Hidden` removes bytes from the display; `Widget` removes the bytes *and*
/// paints an element in their place. Both kinds make the covered bytes take
/// zero width in the shaped line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewSpan {
    /// Half-open UTF-8 byte range into the document.
    pub range: Range<usize>,
    pub kind: PreviewSpanKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreviewSpanKind {
    /// Bytes removed from the display, nothing painted.
    Hidden,
    /// Bytes removed from the display, an inline element painted instead.
    Widget(Widget),
}

/// Inline elements the host knows how to render.
///
/// The strings are the *raw* source text (already trimmed of delimiters), so
/// the host can resolve them (image path → absolute path, tex → layout)
/// without re-scanning the document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Widget {
    /// `$…$` (inline) or a single-line `$$…$$`/`\[…\]` (display).
    Math { tex: String, display: bool },
    /// `![alt](src)` / `![[src]]` — `src` is the raw target as written.
    Image { src: String, alt: String },
    /// `[ ]` / `[x]` of a todo item; the `- ` before it is a separate
    /// `Bullet`/`Hidden` span per the list-mark rules.
    Checkbox { checked: bool },
    /// The `- `/`* `/`+ ` marker of an unordered list item.
    Bullet,
    /// Fenced-code language: ```` ```rust ```` → the label `rust`.
    CodeLang { lang: String },
    /// Title chip of a `::: kind Title` callout.
    CalloutTitle { kind: String, title: String },
    /// `---`/`***` horizontal rule line.
    Rule,
}

/// A whole-line-range replacement (callout panel, multi-line math block,
/// table). The renderer hides every line in `first_line..=last_line` and
/// paints one block element in their place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewBlock {
    /// 0-based, inclusive, like `str::lines()` numbering.
    pub first_line: usize,
    /// 0-based, inclusive.
    pub last_line: usize,
    pub kind: BlockKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockKind {
    /// A `$$ … $$` multi-line display block (or `\[ … \]`).
    Math { tex: String, display: bool },
    /// A `::: kind Title` container. `body_first_line..=body_last_line` is
    /// the body (between the opening line and the closing `:::`).
    Callout {
        kind: String,
        title: String,
        body_first_line: usize,
        body_last_line: usize,
    },
}

/// Everything the renderer needs for one pass.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PreviewSnapshot {
    /// Sorted by `range.start`, pairwise disjoint.
    pub spans: Vec<PreviewSpan>,
    /// Sorted by `first_line`, disjoint line ranges.
    pub blocks: Vec<PreviewBlock>,
}

impl PreviewSnapshot {
    pub fn is_empty(&self) -> bool {
        self.spans.is_empty() && self.blocks.is_empty()
    }

    /// The byte ranges the display removes, sorted and disjoint — the
    /// engine-facing view of `spans`.
    pub fn hidden_ranges(&self) -> Vec<Range<usize>> {
        self.spans.iter().map(|s| s.range.clone()).collect()
    }
}

/// What `scan` looks at.
pub struct ScanInput<'a> {
    pub text: &'a str,
    /// Every selection range, sorted by start. A bare caret is an empty
    /// range. The activity rule reads all of them (a line is "active" when
    /// any selection touches it).
    pub selections: &'a [Range<usize>],
    /// Byte range the caller is about to display (the visible lines plus a
    /// margin). Spans entirely outside it are not reported; the block
    /// classification still reads the whole document.
    pub visible: Range<usize>,
}

mod scan;
#[cfg(test)]
mod perf_tests;

pub use scan::scan;
