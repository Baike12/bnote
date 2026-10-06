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
//! - `panels` are sorted by `first_line`; nested callouts make them overlap,
//!   and a panel's range is clipped to the visible window;
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
    /// A whole line the preview removes entirely: the ```` ``` ```` fence lines
    /// of a fenced-code block. The engine collapses the line to **zero
    /// height** (TS `HiddenLineWidget` + `.cw-hidden-line { height: 0 }`), so
    /// the fence lines take no vertical space and show no line number.
    HiddenLine,
    /// A `::: kind Title` container. `body_first_line..=body_last_line` is
    /// the body (between the opening line and the closing `:::`).
    ///
    /// Note this replaces an **edge** line only: the body stays source. The
    /// container look (background, left border, nesting) is the panel's job
    /// ([`PreviewPanel`]), exactly like the TS shell's `md-callout-line`
    /// classes — a block replace removes the line element, so the edge widget
    /// carries the panel face for its own line.
    Callout {
        kind: String,
        title: String,
        body_first_line: usize,
        body_last_line: usize,
    },
}

/// A line range drawn as a container panel — the `:::` callout look: a
/// per-line background and left border, nested regions shifting inward. The
/// lines stay visible and editable (a panel is a *look*, never a
/// replacement), and unlike a [`PreviewBlock`] it is emitted no matter where
/// the caret is: only the edge lines' widgets are caret-gated (TS
/// `md-callout-line d{depth}`, livePreview.ts 577-604).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewPanel {
    /// 0-based inclusive line range, clipped to the visible window.
    pub first_line: usize,
    pub last_line: usize,
    /// Nesting depth, 0 = outermost (the TS caps the class at `d2`).
    pub depth: u8,
    /// The opening edge line (top rounding / top padding), 0-based.
    /// Unbounded by the window clip: the renderer compares it with the lines
    /// it is painting.
    pub open_line: usize,
    /// The closing edge line, `None` when the region never closed.
    pub close_line: Option<usize>,
}

/// Everything the renderer needs for one pass.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PreviewSnapshot {
    /// Sorted by `range.start`, pairwise disjoint.
    pub spans: Vec<PreviewSpan>,
    /// Sorted by `first_line`, disjoint line ranges.
    pub blocks: Vec<PreviewBlock>,
    /// Sorted by `first_line`. Nested callouts mean overlapping ranges by
    /// design: the renderer paints them in order, so the inner panel lands on
    /// top of the outer one.
    pub panels: Vec<PreviewPanel>,
}

impl PreviewSnapshot {
    pub fn is_empty(&self) -> bool {
        self.spans.is_empty() && self.blocks.is_empty() && self.panels.is_empty()
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
