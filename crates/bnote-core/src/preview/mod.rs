//! Live-preview decorations: what the renderer hides and what it renders in
//! place of the hidden source (Obsidian-style live preview).
//!
//! This module is **pure data + rules**: it turns `(text, selections,
//! visible window)` into a [`PreviewSnapshot`] of byte ranges — and of line
//! numbers for the container looks ([`PreviewPanel`]). The renderer
//! (gpui-kit's editor seam) consumes the snapshot through four channels:
//! hidden bytes are removed from shaping, widget spans get an element
//! painted, block spans replace a whole line range, style spans restyle the
//! glyphs in place, and panels give the engine the per-line container looks
//! (backgrounds, left borders, indents). Nothing here knows about GPUI,
//! markdown trees or fonts.
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
    /// A markdown escape `\X` (X an ASCII punctuator): the pair is replaced by
    /// the character alone, drawn in normal text color (TS
    /// `EscapeCharWidget`, `.cw-escape`). `\,`/`\{` inside a formula are
    /// LaTeX and never reach this widget.
    Escape { char: String },
    /// `[ ]` / `[x]` of a todo item; the `- ` before it is a separate
    /// `Bullet`/`Hidden` span per the list-mark rules.
    Checkbox { checked: bool },
    /// The `- `/`* `/`+ ` marker of an unordered list item.
    Bullet,
}

/// A whole-line-range block element: either a **replacement** (the renderer
/// hides every line in `first_line..=last_line` and paints one element in
/// their place) or an **insertion** (nothing is replaced; the element adds its
/// height at the start of a line, the lines around it stay visible).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewBlock {
    /// 0-based, inclusive, like `str::lines()` numbering. For an insertion
    /// (`last_line == None`) this is the line the element is inserted **before**.
    pub first_line: usize,
    /// 0-based inclusive last replaced line, or `None` for an insertion at
    /// `first_line` — with `first_line == line count` meaning "after the last
    /// line" (the TS `MathPreviewWidget` anchors at `doc.length` there).
    pub last_line: Option<usize>,
    pub kind: BlockKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockKind {
    /// A `$$ … $$` multi-line display block (or `\[ … \]`), rendered in place
    /// of its source lines.
    ///
    /// `depth` is the nesting depth of the enclosing callout block, `None`
    /// when the region is outside every callout (TS `calloutDepthAt`, -1). A
    /// block replace removes the line element, so the element itself carries
    /// the callout face (background, left border, indent) for its own lines —
    /// the TS `MathWidget` adds `md-callout-line d{depth}` for exactly this.
    Math { tex: String, depth: Option<usize> },
    /// The live preview bnote shows **while the caret is inside** a display
    /// math block: a rendered copy of the formula, inserted *below* the source
    /// block (never replacing it, so the source stays editable). Emitted as an
    /// insertion ([`PreviewBlock::last_line`] is `None`). `depth` as in
    /// [`BlockKind::Math`] (TS `MathPreviewWidget`).
    MathPreview { tex: String, depth: Option<usize> },
    /// A whole line the preview removes entirely: the ```` ``` ```` fence lines
    /// of a fenced-code block. The engine collapses the line to **zero
    /// height** (TS `HiddenLineWidget` + `.cw-hidden-line { height: 0 }`), so
    /// the fence lines take no vertical space and show no line number.
    /// The TS widget carries no callout face — a fence line inside a callout
    /// is still zero height.
    HiddenLine,
    /// A `::: Title` container's edge line (`:::` marker line).
    ///
    /// This replaces an **edge** line only: the body stays source. The
    /// container look (background, left border, nesting) is the panel's job
    /// ([`PreviewPanel`]), exactly like the TS shell's `md-callout-line`
    /// classes — a block replace removes the line element, so the edge widget
    /// carries the panel face for its own line (TS `CalloutTitleWidget` /
    /// `CalloutEdgeWidget`, both with `.md-callout-line d{depth}`).
    ///
    /// - `title` non-empty → the opening edge shows the title label
    ///   (`cw-callout-title`, top cap);
    /// - `title` empty + `open` → the opening edge of an untitled block, and
    ///   with `open == false` the closing `:::` line (`cw-callout-edge`: an
    ///   8px cap, top rounding when `open`).
    Callout {
        /// The `:::` marker line's text after the colons, trimmed (empty for
        /// an untitled opening edge and for every closing edge).
        title: String,
        /// Nesting depth of the region, 0 = outermost (the TS caps the
        /// `d{depth}` class at `d2`).
        depth: usize,
        /// True for the opening edge, false for the closing `:::`.
        open: bool,
    },
    /// A `---`/`***` horizontal rule: the whole line is replaced by a rule
    /// element (TS `HrWidget`, `block: true`). `depth` as in
    /// [`BlockKind::Math`]: the rule carries the callout face for its own
    /// line.
    Rule { depth: Option<usize> },
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
    pub kind: PanelKind,
}

/// Which container look a [`PreviewPanel`] paints, and what activity rule
/// gates it (each mirrors its TS line class — see `livePreview.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PanelKind {
    /// `::: kind Title` container (TS `md-callout-line d{depth}`): background
    /// + left border + inward shift by depth, the first and last lines
    /// carrying the top/bottom cap. Emitted **regardless of the caret**: the
    /// TS emits these line classes unconditionally so that pure cursor
    /// movement never rebuilds the region.
    Callout {
        /// Nesting depth, 0 = outermost (the TS caps the class at `d2`).
        depth: u8,
        /// The opening edge line (top rounding / top padding), 0-based.
        /// Unbounded by the window clip: the renderer compares it with the
        /// lines it is painting.
        open_line: usize,
        /// The closing edge line, `None` when the region never closed.
        close_line: Option<usize>,
    },
    /// Fenced-code body lines (TS `md-code-line`: the code-block background
    /// and the mono font). Emitted only while the caret is **outside** the
    /// whole block — inside it the source is edited in plain style.
    CodeBlock,
    /// Blockquote lines (TS `md-quote`: left border, accent-colored italic
    /// text). Per the TS rule the class is only on **inactive** lines, so a
    /// quote touched by the caret yields no panel for that line.
    Blockquote,
}

/// One list line's hanging-indent geometry — the TS line class set
/// `md-list-line li-i{depth} {kind}`: the marker slot starts at
/// [`li_px_em(level)`], the item text hangs at the slot's right edge, and
/// every wrapped row aligns there. Emitted regardless of the caret, like the
/// TS line decoration ("the layout doesn't shift when the cursor enters or
/// leaves the line").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListGeometry {
    /// 0-based buffer line.
    pub line: usize,
    /// Nesting level: 0 is a top-level item, each level is two source spaces
    /// (`li-i{2*level}` in TS), capped like the TS class table at 16.
    pub level: u8,
    /// Which marker slot width the line uses.
    pub marker: ListMarkerKind,
}

/// The marker kind of a list item, which picks the slot width (TS `.li-b` /
/// `.li-t` / `.li-o`). Standard GFM: only `- [ ]` is a task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListMarkerKind {
    Bullet,
    Task,
    Ordered,
}

/// `--li-base`: the first level's marker offset, in em. The list geometry is
/// the same em scale `global.css` uses, so it tracks the editor font size;
/// ordered slots are the one fixed pixel value (digit widths are not
/// em-stable).
pub const LI_BASE_EM: f32 = 0.8125;
/// `--li-step`: each further nesting level, in em.
pub const LI_STEP_EM: f32 = 1.75;
/// `--li-gap`: the marker's right edge to the item text, in em.
pub const LI_GAP_EM: f32 = 0.5;
/// The bullet slot (`0.45em` dot + gap), in em.
pub const LI_BULLET_EM: f32 = 0.45;
/// The task checkbox slot (`0.9em` box + gap), in em.
pub const LI_TASK_EM: f32 = 0.9;
/// The ordered slot: a fixed `26px`, matching TS `.li-o`.
pub const LI_ORDERED_PX: f32 = 26.0;

/// The marker slot offset (TS `--li-px`), in em.
pub fn li_px_em(level: u8) -> f32 {
    LI_BASE_EM + level as f32 * LI_STEP_EM
}

/// The marker slot width (TS `--li-hang`) in em, for the em-based kinds (a
/// bullet's dot and a checkbox both scale with the font). Ordered markers
/// return `None` — theirs is [`LI_ORDERED_PX`].
pub fn li_hang_em(marker: ListMarkerKind) -> Option<f32> {
    match marker {
        ListMarkerKind::Bullet => Some(LI_BULLET_EM + LI_GAP_EM),
        ListMarkerKind::Task => Some(LI_TASK_EM + LI_GAP_EM),
        ListMarkerKind::Ordered => None,
    }
}

/// A byte range the renderer draws with a **text style** — bnote's mark
/// decorations (`md-strong`, `md-inline-code`, `md-link`, …; TS
/// `Decoration.mark`). Unlike a [`PreviewSpan`] a style span hides nothing
/// and reserves no width: it only restyles glyphs the display already keeps,
/// so it may overlap hidden spans and other constructs freely and needs no
/// claim bookkeeping.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewStyleSpan {
    /// Half-open UTF-8 byte range into the document.
    pub range: Range<usize>,
    pub style: SpanStyle,
}

/// The text styles the host knows how to paint, one per TS mark class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpanStyle {
    /// `md-strong` (`**x**`, `__x__`): bold, `--strong-color`.
    Strong,
    /// `md-em` (`*x*`, `_x_`): italic, `--strong-color`.
    Emphasis,
    /// `md-strike` (`~~x~~`): strikethrough, `--text-dim`.
    Strikethrough,
    /// `md-inline-code` (`` `x` ``): `--code-inline-bg` behind,
    /// `--tok-number` text. Unconditional: the marks stay styled while the
    /// caret edits the span (TS `decorateInlineCode` marks the content even
    /// when the backticks show).
    InlineCode,
    /// `md-link`: the label of `[label](url)`.
    Link,
    /// `md-url`: the target of `[label](url)`.
    LinkUrl,
    /// `md-wikilink`: the displayed text of `[[target]]` / `[[target|alias]]`.
    WikiLink,
    /// `md-heading md-h{n}`: an ATX heading's content (1-based level).
    Heading {
        /// 1..=6, as written.
        level: u8,
    },
    /// `md-hmark`: the raw `#` run plus its spaces — only while the line is
    /// the caret's line (TS `decorateHeading` marks it exactly then).
    HeadingMark,
    /// `md-listmark`: an ordered list's `1.` marker, dimmed. (Bullets and
    /// checkboxes are widgets instead, so they carry no mark.)
    ListMark,
    /// `md-math-delim` (`$`, `$$`): raw maths source while the caret edits
    /// the region.
    MathDelim,
    /// `md-math-cmd` (`\cmd`): raw maths source.
    MathCmd,
    /// `md-math-brace` (`{}[]^_&~`): raw maths source.
    MathBrace,
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
    /// Sorted by `range.start`; **may overlap** each other and any span (a
    /// mark restyles what a widget or hidden span covers). The renderer
    /// merges them into the text styles.
    pub styles: Vec<PreviewStyleSpan>,
    /// Sorted by `line`, at most one entry per line: the list lines'
    /// hanging-indent geometry.
    pub lists: Vec<ListGeometry>,
}

impl PreviewSnapshot {
    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
            && self.blocks.is_empty()
            && self.panels.is_empty()
            && self.styles.is_empty()
            && self.lists.is_empty()
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
    /// The `mathPreview` setting (TS default `true`): show the live-rendered
    /// copy of a display formula while the caret is inside it.
    pub math_preview: bool,
}

mod scan;
#[cfg(test)]
mod perf_tests;

pub use scan::scan;
