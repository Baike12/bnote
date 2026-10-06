//! Host side of the markdown live preview.
//!
//! Three pieces meet here, one per side of the seam:
//!
//! - [`bnote_core::preview`] decides **what** to hide and what to paint
//!   (pure rules, ported from the Tauri shell's `livePreview.ts`);
//! - gpui-kit's `PreviewDecorations` carries it into the layout: hidden bytes
//!   take zero width, a widget reserves exactly the width the host declares;
//! - this module measures those widths against the editor's own font (so a
//!   formula's box matches the glyphs beside it) and builds the elements —
//!   formulas through [`bnote_mathml`], pictures out of [`ImageStore`]'s
//!   decoded bitmaps, everything else out of plain divs.
//!
//! Images are the one widget whose size the host cannot derive locally: it
//! needs the file's pixels, and reading is I/O. So the rule is *no span until
//! the size is known* — a miss leaves the source text visible and queues the
//! load ([`ImageStore`], run by the workspace on the background executor);
//! when it lands, the workspace re-scans and the widget appears. The engine
//! has no "measure later" channel (`PreviewSpan::widget` takes an explicit
//! width), so nothing else is possible without a flicker.
//!
//! The workspace pushes a snapshot whenever the text or the caret changes and
//! installs [`PreviewHost`] as the renderer once.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use bnote_core::preview::{self as core, ScanInput};
use bnote_mathml::{MathFontMetrics, MathItem, MathLayout, Measured};
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, Font, FontStyle, FontWeight, GlobalElementId,
    Hsla, InspectorElementId, IntoElement, LayoutId, Pixels, RenderImage, SharedString, Style,
    TextAlign, TextRun, Window, div, fill, img, point, prelude::*, px, size,
};
use gpui_kit::component::input::{
    PreviewBlock, PreviewBlockView, PreviewDecorations, PreviewRenderer, PreviewSpan,
    PreviewWidget,
};

use super::images::ImageStore;
use crate::theme::ActivePalette;

/// The font the preview measures against. The workspace styles the editor with
/// exactly these values, so a widget's declared width is measured in the same
/// font the engine lays the line out with.
#[derive(Clone)]
pub struct PreviewFont {
    pub family: SharedString,
    pub size: Pixels,
}

impl PreviewFont {
    fn font(&self) -> Font {
        Font {
            family: self.family.clone(),
            ..Default::default()
        }
    }
}

/// Text metrics over gpui's text system, for [`bnote_mathml`].
struct TextMetrics<'a> {
    window: &'a mut Window,
    font: Font,
}

impl MathFontMetrics for TextMetrics<'_> {
    fn measure(&self, text: &str, spec: bnote_mathml::FontSpec) -> Measured {
        let run = TextRun {
            len: text.len(),
            font: Font {
                style: if spec.italic {
                    FontStyle::Italic
                } else {
                    FontStyle::Normal
                },
                weight: if spec.bold {
                    FontWeight::BOLD
                } else {
                    FontWeight::NORMAL
                },
                ..self.font.clone()
            },
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let shaped = self.window.text_system().shape_line(
            text.to_owned().into(),
            px(spec.size),
            &[run],
            None,
        );
        Measured {
            width: shaped.width().as_f32(),
            ascent: shaped.ascent.as_f32(),
            descent: shaped.descent.as_f32(),
        }
    }
}

/// The engine's right margin around the editor's text area, and the space it
/// keeps between a line number and the text (`RIGHT_MARGIN` /
/// `LINE_NUMBER_RIGHT_MARGIN` in gpui-kit's editor element, `element.rs`).
const RIGHT_MARGIN: Pixels = px(10.);
const LINE_NUMBER_RIGHT_MARGIN: Pixels = px(6.);

/// Bytes of margin the scan adds on each side of the visible window.
///
/// Decorations are computed one frame behind the scroll that moved them, so
/// the window must cover a frame or two of scrolling: with a typical ~50-byte
/// line this is ~80 lines above and below the viewport, far more than one
/// frame scrolls. The margin is also what keeps the scan off the hot path:
/// `needs_rescan_for` only asks for a new pass when the viewport actually
/// leaves the covered window, not on every scrolled frame (a whole-document
/// scan per frame would be tens of milliseconds).
const SCAN_PAD: usize = 4 * 1024;

/// Digits the editor reserves for line numbers: at least three, at most
/// seven, otherwise as many as the line count needs — the engine's
/// `line_number_len` (`element.rs`).
fn line_number_digits(lines: usize) -> usize {
    (lines.max(1).ilog10() as usize + 1).clamp(3, 7)
}

/// The cache key of one typeset formula: `(tex, display, font size in
/// centi-px, column in centi-px)`. The column is `0` for an inline formula
/// (its budget is the line height) and the text column for a block one (its
/// budget is the page width) — the two never share an entry.
type MathKey = (String, bool, u32, u32);

/// Builds the engine snapshot and the widget elements for it.
pub struct PreviewHost {
    font: PreviewFont,
    /// Typeset formulas, keyed by [`MathKey`].
    math: RefCell<HashMap<MathKey, Rc<MathLayout>>>,
    /// What each pushed widget span should render as, keyed by its start
    /// offset. Rebuilt with every snapshot, so a renderer call can only hit a
    /// span from the snapshot that is in effect.
    widgets: RefCell<HashMap<usize, core::Widget>>,
    /// What each pushed block should render as, keyed by its first line. Like
    /// [`Self::widgets`], rebuilt with every snapshot.
    blocks: RefCell<HashMap<u64, core::BlockKind>>,
    /// Decoded images (background-loaded, read here on the UI thread).
    images: ImageStore,
    /// The editor width the last scan measured against; a change re-scans,
    /// because every image span's reserved width is a function of it.
    editor_width: Cell<Pixels>,
    /// The byte window the last scan emitted for (see [`SCAN_PAD`]), as a
    /// `Copy` pair. `(0, 0)` before the first scan, so any viewport asks for
    /// one.
    scanned: Cell<(usize, usize)>,
    /// The `mathPreview` setting: the live-rendered copy of a display formula
    /// while the caret is inside it (TS default true).
    math_preview: Cell<bool>,
    revision: Cell<u64>,
}

impl PreviewHost {
    pub fn new(font: PreviewFont) -> Self {
        Self {
            font,
            math: RefCell::new(HashMap::new()),
            widgets: RefCell::new(HashMap::new()),
            blocks: RefCell::new(HashMap::new()),
            images: ImageStore::new(),
            editor_width: Cell::new(Pixels::ZERO),
            scanned: Cell::new((0, 0)),
            math_preview: Cell::new(true),
            revision: Cell::new(0),
        }
    }

    /// The image cache and request queue; the workspace drains the requests
    /// and runs them on the background executor (see [`ImageStore`]).
    pub fn images(&self) -> &ImageStore {
        &self.images
    }

    /// Sets the `mathPreview` setting. Returns true when it changed, so the
    /// caller knows to mark the preview dirty (the next scan picks it up).
    pub fn set_math_preview(&self, enabled: bool) -> bool {
        if self.math_preview.get() == enabled {
            return false;
        }
        self.math_preview.set(enabled);
        true
    }

    /// True when the editor's width moved since the last scan: image spans
    /// were emitted (or withheld) against the old column, so the snapshot has
    /// to be rebuilt. The workspace calls this on every frame and marks the
    /// preview dirty; `input_bounds` is the previous frame's, so a resize
    /// settles one frame later.
    pub fn needs_rescan(&self, editor_width: Pixels) -> bool {
        (editor_width - self.editor_width.get()).as_f32().abs() > 0.5
    }

    /// True when the viewport left the byte window the last scan covered: the
    /// frame is showing (or about to show) lines nothing was emitted for, so
    /// the snapshot must be rebuilt. `visible` is the engine's last laid-out
    /// byte range ([`InputBaseState::visible_byte_range`]), `None` before the
    /// first layout.
    ///
    /// The scan window carries [`SCAN_PAD`] on each side, so this only fires
    /// when scrolling actually walks out of the covered range — not on every
    /// scrolled frame, which would mean a whole-document scan per frame.
    pub fn needs_rescan_for(&self, visible: Option<&Range<usize>>) -> bool {
        let (scanned_start, scanned_end) = self.scanned.get();
        visible.is_some_and(|visible| visible.start < scanned_start || visible.end > scanned_end)
    }

    /// The editor's text column: the width any widget may occupy before the
    /// engine wraps to the next visual line. The engine's own wrap width is
    /// the editor element's width minus the line-number gutter and its right
    /// margin (gpui-kit `element.rs`: `layout_line_numbers` + `RIGHT_MARGIN`),
    /// and images size themselves to that column, mirroring the Tauri shell's
    /// `max-width: 100%`.
    ///
    /// Before the first prepaint the editor has no bounds yet; the last
    /// measured column is reused (and, at startup, the window width minus the
    /// sidebar), so nothing is sized against a zero-width column.
    pub fn text_column(&self, editor_width: Pixels, text: &str, window: &mut Window) -> Pixels {
        if editor_width <= px(1.) {
            let last = self.editor_width.get();
            return if last > px(1.) {
                last - self.column_inset(text, window)
            } else {
                (window.viewport_size().width - px(240.)).max(px(80.))
            };
        }
        self.editor_width.set(editor_width);
        (editor_width - self.column_inset(text, window)).max(px(80.))
    }

    /// What the engine keeps out of a line's width: the line-number gutter
    /// plus its right margin.
    fn column_inset(&self, text: &str, window: &mut Window) -> Pixels {
        let lines = text.bytes().filter(|b| *b == b'\n').count() + 1;
        let gutter = self.text_width(&"+".repeat(line_number_digits(lines)), window);
        gutter + LINE_NUMBER_RIGHT_MARGIN + RIGHT_MARGIN
    }

    /// Scan `text` and turn the result into an engine snapshot.
    ///
    /// `column` is the editor's text width ([`Self::text_column`]): the budget
    /// an image sizes itself to. `visible` is the engine's last laid-out byte
    /// range: emission is limited to it (plus [`SCAN_PAD`] on each side) so a
    /// long document's snapshot only carries what the frame can paint. `None`
    /// (before the first layout) scans the whole document.
    ///
    /// Widgets whose width cannot be established yet (an image whose file has
    /// not been decoded) are dropped: their source stays visible rather than
    /// collapsing into a box that is not there.
    pub fn decorations(
        &self,
        text: &str,
        selections: &[Range<usize>],
        column: Pixels,
        visible: Option<&Range<usize>>,
        window: &mut Window,
        cx: &mut App,
    ) -> PreviewDecorations {
        let scan_window = match visible {
            Some(visible) => visible.start.saturating_sub(SCAN_PAD)
                ..visible.end.saturating_add(SCAN_PAD),
            None => 0..usize::MAX,
        };
        self.scanned.set((scan_window.start, scan_window.end));
        let snapshot = core::scan(ScanInput {
            text,
            selections,
            visible: scan_window,
            // The display-formula preview while the caret is inside it (the
            // TS `mathPreview` setting, default on).
            math_preview: self.math_preview.get(),
        });
        let line_height = window.line_height();
        let mut spans = Vec::with_capacity(snapshot.spans.len());
        let mut widgets = HashMap::new();
        for span in &snapshot.spans {
            let range = span.range.clone();
            match &span.kind {
                core::PreviewSpanKind::Hidden => spans.push(PreviewSpan::hidden(range)),
                core::PreviewSpanKind::Widget(widget) => {
                    // Images carry their own decision: ready (a span with the
                    // cached display size) or not (source text stays, and the
                    // miss queues a load for the workspace to spawn).
                    if let core::Widget::Image { src, .. } = widget {
                        if let Some(image) = self.image_span(text, range, src, column) {
                            widgets.insert(image.range.start, widget.clone());
                            spans.push(image);
                        }
                        continue;
                    }
                    let Some(width) = self.widget_width(widget, line_height, window, cx) else {
                        continue;
                    };
                    let source = text
                        .get(range.clone())
                        .unwrap_or_default()
                        .to_owned();
                    widgets.insert(range.start, widget.clone());
                    spans.push(PreviewSpan::widget(range, width, source));
                }
            }
        }
        *self.widgets.borrow_mut() = widgets;

        // Blocks: whole-line replacements (display maths, fence lines, callout
        // edges, rules) and insertions (the math preview under an edited
        // region). The host declares each block's height, measured with the
        // same layout the renderer will paint, so the reserved box and the
        // element inside it can never disagree.
        let mut blocks = Vec::with_capacity(snapshot.blocks.len());
        let mut block_kinds = HashMap::with_capacity(snapshot.blocks.len());
        for block in &snapshot.blocks {
            let first = block.first_line as u64;
            let lines = first..block.last_line.map_or(first, |last| last as u64 + 1);
            let Some(height) = self.block_height(&block.kind, column, window, cx) else {
                // A block whose content cannot be laid out (a formula neither
                // engine typesets) leaves its source visible rather than
                // collapsing to a box that is not there — the image rule.
                continue;
            };
            let text: SharedString = match &block.kind {
                core::BlockKind::Math { tex, .. } | core::BlockKind::MathPreview { tex, .. } => {
                    tex.clone().into()
                }
                core::BlockKind::Callout { title, .. } => title.clone().into(),
                core::BlockKind::HiddenLine | core::BlockKind::Rule { .. } => "".into(),
            };
            block_kinds.insert(first, block.kind.clone());
            blocks.push(PreviewBlock::new(lines, height, text));
        }
        *self.blocks.borrow_mut() = block_kinds;

        self.revision.set(self.revision.get() + 1);
        PreviewDecorations {
            spans,
            blocks,
            revision: self.revision.get(),
        }
    }

    /// The height a block reserves, measured with the layout its renderer will
    /// paint. `None` when the content cannot be laid out (the same "no span
    /// until the size is known" rule inline widgets follow).
    ///
    /// The numbers are the TS shell's CSS, in px:
    /// `.cw-math-block { margin: 6px 0 }`; `.cw-math-preview { margin: 2px 0
    /// 10px; padding: 4px 0 }`; `.cw-callout-title { padding: 8px top, 4px
    /// bottom }` around a 0.88em label; `.cw-callout-edge { height: 8px }`;
    /// `.cw-hr { margin: 10px 0 }` around a 2px rule; `.cw-hidden-line
    /// { height: 0 }`.
    fn block_height(
        &self,
        kind: &core::BlockKind,
        column: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Pixels> {
        Some(match kind {
            core::BlockKind::Math { tex, .. } => {
                let layout = self.block_math_layout(tex, column, window, cx)?;
                px(layout.height()) + px(6.) * 2.
            }
            core::BlockKind::MathPreview { tex, .. } => {
                let layout = self.block_math_layout(tex, column, window, cx)?;
                // 4px padding top and bottom, 2px margin above, 10px below.
                px(layout.height()) + px(20.)
            }
            core::BlockKind::HiddenLine => px(0.),
            core::BlockKind::Callout { title, .. } if !title.is_empty() => {
                px(8.) + window.line_height() * 0.88 + px(4.)
            }
            core::BlockKind::Callout { .. } => px(8.),
            core::BlockKind::Rule { .. } => px(22.),
        })
    }

    /// The span an image widget emits, or `None` while its display size is
    /// unknown (the source text stays visible).
    ///
    /// A miss records a load request inside the store; the workspace drains it
    /// after the scan and runs it on the background executor.
    pub(crate) fn image_span(
        &self,
        text: &str,
        range: Range<usize>,
        src: &str,
        column: Pixels,
    ) -> Option<PreviewSpan> {
        let width = self.images.hit(src, column)?;
        let source = text.get(range.clone()).unwrap_or_default().to_owned();
        Some(PreviewSpan::widget(range, width, source))
    }

    /// The width a widget reserves, or `None` to leave its source visible.
    fn widget_width(
        &self,
        widget: &core::Widget,
        line_height: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Pixels> {
        let base = self.font.size;
        Some(match widget {
            core::Widget::Math { tex, display } => {
                let layout = self.math_layout(tex, *display, base, line_height, window, cx)?;
                px(layout.width).max(px(base.as_f32() * 0.6)) + px(2.)
            }
            // `\X` renders as `X` in body colour: the glyph's own width, plus
            // the same hair of padding the other text-like widgets take.
            core::Widget::Escape { char } => self.text_width(char, window) + base * 0.2,
            core::Widget::Checkbox { .. } => base * 1.35,
            core::Widget::Bullet => base * 0.62,
            // Images are decided in `image_span` before this runs: they need
            // the decoded bitmap, not a font measurement.
            core::Widget::Image { .. } => return None,
        })
    }

    fn text_width(&self, text: &str, window: &mut Window) -> Pixels {
        let run = TextRun {
            len: text.len(),
            font: self.font.font(),
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        window
            .text_system()
            .shape_line(text.to_owned().into(), self.font.size, &[run], None)
            .width()
    }

    /// Typeset `tex` for an **inline** widget, scaled down to fit a text line
    /// when it has to.
    fn math_layout(
        &self,
        tex: &str,
        display: bool,
        base: Pixels,
        line_height: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Rc<MathLayout>> {
        let _ = cx;
        let key = (
            tex.to_owned(),
            display,
            (base.as_f32() * 100.) as u32,
            0,
        );
        if let Some(hit) = self.math.borrow().get(&key) {
            return Some(hit.clone());
        }
        let metrics = TextMetrics {
            window,
            font: self.font.font(),
        };
        let mut layout = bnote_mathml::layout(tex, display, base.as_f32(), None, &metrics)?;
        // The engine boxes an inline widget to the line's height, so a tall
        // formula is re-typeset smaller rather than clipped.
        let budget = line_height.as_f32() * 0.98;
        if layout.height() > budget && layout.height() > 0. {
            let scaled = base.as_f32() * (budget / layout.height());
            if let Some(fitted) = bnote_mathml::layout(tex, display, scaled, None, &metrics) {
                layout = fitted;
            }
        }
        let layout = Rc::new(layout);
        self.math.borrow_mut().insert(key, layout.clone());
        Some(layout)
    }

    /// Typeset a display formula for a **block**: budgeted by the text column,
    /// not the line height. An inline formula sits inside a line and shrinks
    /// to fit one; a block formula owns its lines and only shrinks when it
    /// would overflow the column (the TS `.cw-math-block` centres a wide
    /// formula and lets it scroll horizontally; GPUI has no scroll box inside
    /// a block, so a wide formula is typeset smaller until it fits).
    fn block_math_layout(
        &self,
        tex: &str,
        column: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Rc<MathLayout>> {
        let _ = cx;
        let base = self.font.size;
        let key = (
            tex.to_owned(),
            true,
            (base.as_f32() * 100.) as u32,
            (column.as_f32() * 100.) as u32,
        );
        if let Some(hit) = self.math.borrow().get(&key) {
            return Some(hit.clone());
        }
        let metrics = TextMetrics {
            window,
            font: self.font.font(),
        };
        let mut layout = bnote_mathml::layout(tex, true, base.as_f32(), None, &metrics)?;
        let budget = column.as_f32();
        if layout.width > budget + 0.5 && layout.width > 0. && budget > 1. {
            let scaled = base.as_f32() * (budget / layout.width);
            if let Some(fitted) = bnote_mathml::layout(tex, true, scaled, None, &metrics) {
                layout = fitted;
            }
        }
        let layout = Rc::new(layout);
        self.math.borrow_mut().insert(key, layout.clone());
        Some(layout)
    }
}

impl PreviewRenderer for PreviewHost {
    fn render(
        &self,
        widget: PreviewWidget<'_>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let _ = cx;
        let Some(kind) = self.widgets.borrow().get(&widget.range.start).cloned() else {
            // A span the snapshot no longer describes (a frame in flight):
            // an empty box is better than a wrong one.
            return div().w(widget.width).h(widget.line_height).into_any_element();
        };
        let color = window.text_style().color;
        match kind {
            core::Widget::Math { tex, display } => {
                let Some(layout) = self.math_layout(
                    &tex,
                    display,
                    self.font.size,
                    widget.line_height,
                    window,
                    cx,
                ) else {
                    return plain_source(&widget, color);
                };
                MathView { layout, color }.into_any_element()
            }
            // The escaped punctuator, drawn as plain body text (no chip, no
            // dimming): the source `\*` reads as `*`.
            core::Widget::Escape { char } => div()
                .w(widget.width)
                .h(widget.line_height)
                .flex()
                .items_center()
                .text_color(color)
                .child(char)
                .into_any_element(),
            core::Widget::Checkbox { checked } => {
                let size = widget.line_height * 0.75;
                let mark = if checked { "✓" } else { "" };
                div().w(widget.width).h(widget.line_height).flex().items_center().child(
                    div()
                        .w(size)
                        .h(size)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_sm()
                        .border_1()
                        .border_color(color.opacity(0.6))
                        .text_size(size * 0.8)
                        .text_color(color)
                        .child(mark),
                )
                .into_any_element()
            }
            core::Widget::Bullet => {
                let dot = self.font.size * 0.28;
                div()
                    .w(widget.width)
                    .h(widget.line_height)
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .w(dot)
                            .h(dot)
                            .rounded_full()
                            .bg(color.opacity(0.85)),
                    )
                    .into_any_element()
            }
            core::Widget::Image { src, .. } => match self.images.image_at(&src, widget.width) {
                Some((image, height)) => {
                    image_view(image, widget.width, height, widget.line_height, color)
                }
                // The span was emitted from the cache, so this only happens
                // when the entry was dropped between the scan and the paint;
                // the source text beats an empty box.
                None => plain_source(&widget, color),
            },
        }
    }

    /// The element painted in place of a block's lines, or in the space an
    /// insertion reserves.
    ///
    /// The engine lays the element out with `Definite(width) ×
    /// Definite(height)` at the block's top-left corner, so every arm fills
    /// exactly the box [`PreviewHost::block_height`] measured with the same
    /// layout — the reserved space and the element's own content are one
    /// measurement, never two.
    fn render_block(
        &self,
        block: PreviewBlockView<'_>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let Some(kind) = self.blocks.borrow().get(&block.lines.start).cloned() else {
            // A block the snapshot no longer describes (a frame in flight).
            return div().into_any_element();
        };
        let color = window.text_style().color;
        match kind {
            core::BlockKind::Math { tex, depth } => {
                let Some(layout) = self.block_math_layout(&tex, block.width, window, cx) else {
                    return div().into_any_element();
                };
                // 6px margin above the formula (`.cw-math-block`).
                block_shell(block.width, block.height, depth, px(6.), cx)
                    .child(MathView { layout, color })
                    .into_any_element()
            }
            core::BlockKind::MathPreview { tex, depth } => {
                let Some(layout) = self.block_math_layout(&tex, block.width, window, cx) else {
                    return div().into_any_element();
                };
                // 2px margin + 4px padding above the formula (`.cw-math-preview`).
                block_shell(block.width, block.height, depth, px(6.), cx)
                    .child(MathView { layout, color })
                    .into_any_element()
            }
            // `.cw-hidden-line { height: 0 }`: the line is removed, and the
            // host declared zero height, so there is nothing to paint.
            core::BlockKind::HiddenLine => div().into_any_element(),
            core::BlockKind::Callout { title, depth, open } => {
                callout_edge(block, &title, depth, open, self.font.size, cx)
            }
            core::BlockKind::Rule { depth } => {
                rule_block(block.width, block.height, depth, cx)
            }
        }
    }
}

/// The box a block paints in: exactly the `width × height` the host declared,
/// with its content centred horizontally (the TS `.cw-math-block`
/// `text-align: center`).
///
/// A block nested in a callout also carries the callout face for its lines —
/// background, 3px left border and the per-depth indent — because a block
/// replace removes the line element the TS `md-callout-line` class would have
/// styled. The colour mix mirrors `color-mix(in srgb, var(--h2-color) 8%,
/// var(--bg1))` by layering the accent at 8% over the editor background.
fn block_shell(
    width: Pixels,
    height: Pixels,
    depth: Option<usize>,
    top: Pixels,
    cx: &App,
) -> gpui::Div {
    let mut shell = div()
        .w(width)
        .h(height)
        .pt(top)
        .flex()
        .flex_col()
        .items_center();
    if let Some(depth) = depth {
        let accent = callout_accent(cx);
        shell = shell
            .bg(accent.opacity(0.08))
            .border_l_3()
            .border_color(accent.opacity(0.5))
            .pl(callout_indent(depth));
    }
    shell
}

/// The `::: Title` opening edge / `:::` closing edge element (TS
/// `CalloutTitleWidget` / `CalloutEdgeWidget`): the cap of the container look
/// for the marker line the block replaced.
///
/// The opening edge with a title is `8px padding + a 0.88em semibold label +
/// 4px padding` and rounds its top corners; every other edge is the bare 8px
/// cap (`.cw-callout-edge`) rounding its own side.
fn callout_edge(
    block: PreviewBlockView<'_>,
    title: &str,
    depth: usize,
    open: bool,
    font_size: Pixels,
    cx: &App,
) -> AnyElement {
    let accent = callout_accent(cx);
    let mut edge = div()
        .w(block.width)
        .h(block.height)
        .bg(accent.opacity(0.08))
        .border_l_3()
        .border_color(accent.opacity(0.5))
        .pl(callout_indent(depth));
    edge = if open {
        edge.rounded_t(px(4.))
    } else {
        edge.rounded_b(px(4.))
    };
    if title.is_empty() {
        edge.into_any_element()
    } else {
        // The label's line box: the host measured it as `line_height × 0.88`
        // (the ratio the renderer gets for free from the font size below).
        edge.pt(px(8.))
            .pb(px(4.))
            .text_size(font_size * 0.88)
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(accent)
            .overflow_hidden()
            .child(title.to_owned())
            .into_any_element()
    }
}

/// A horizontal rule (TS `HrWidget` + `.cw-hr`): a 2px line centred in the
/// block's 10px vertical margins, colour `--border`.
fn rule_block(width: Pixels, height: Pixels, depth: Option<usize>, cx: &App) -> AnyElement {
    let border = cx
        .try_global::<ActivePalette>()
        .map(|palette| palette.0.color("border"))
        .unwrap_or_default();
    let mut shell = div()
        .w(width)
        .h(height)
        .flex()
        .flex_col()
        .justify_center();
    if let Some(depth) = depth {
        let accent = callout_accent(cx);
        shell = shell
            .bg(accent.opacity(0.08))
            .border_l_3()
            .border_color(accent.opacity(0.5))
            .pl(callout_indent(depth));
    }
    shell
        .child(div().w_full().h(px(2.)).bg(border))
        .into_any_element()
}

/// `--h2-color`, the callout accent every container token mixes from
/// (`global.css` `.md-callout-line` / `.cw-callout-title`).
fn callout_accent(cx: &App) -> Hsla {
    cx.global::<ActivePalette>().0.color("h2-color")
}

/// The TS `md-callout-line` indents, per nesting depth (the class caps at
/// `d2`): `d0` 11px, `d1` 25px, `d2` 39px.
fn callout_indent(depth: usize) -> Pixels {
    px(match depth.min(2) {
        0 => 11.,
        1 => 25.,
        _ => 39.,
    })
}

/// The picture, inside the box the engine reserved (it lays the element out
/// with the span's width × the line height and centres it vertically): the
/// image keeps its aspect ratio at the width the span declared, and a tall
/// picture overflows the line box symmetrically instead of being clipped.
fn image_view(
    image: std::sync::Arc<RenderImage>,
    width: Pixels,
    height: Pixels,
    line_height: Pixels,
    color: Hsla,
) -> AnyElement {
    div()
        .w(width)
        .h(line_height)
        .flex()
        .items_center()
        .child(
            img(image)
                .w(width)
                .h(height)
                .rounded_sm()
                .border_1()
                .border_color(color.opacity(0.15)),
        )
        .into_any_element()
}

fn plain_source(widget: &PreviewWidget<'_>, color: Hsla) -> AnyElement {
    div()
        .w(widget.width)
        .h(widget.line_height)
        .flex()
        .items_center()
        .text_color(color)
        .child(widget.text.to_string())
        .into_any_element()
}

/// A typeset formula: the layout's runs and rules, painted at their own
/// positions inside the box the engine reserved.
struct MathView {
    layout: Rc<MathLayout>,
    color: Hsla,
}

impl IntoElement for MathView {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for MathView {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = px(self.layout.width.max(1.)).into();
        style.size.height = px(self.layout.height().max(1.)).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let family = window.text_style().font().family;
        for item in &self.layout.items {
            match item {
                MathItem::Run {
                    x,
                    baseline,
                    text,
                    spec,
                } => {
                    let font = Font {
                        family: family.clone(),
                        style: if spec.italic {
                            FontStyle::Italic
                        } else {
                            FontStyle::Normal
                        },
                        weight: if spec.bold {
                            FontWeight::BOLD
                        } else {
                            FontWeight::NORMAL
                        },
                        ..Default::default()
                    };
                    let run = TextRun {
                        len: text.len(),
                        font,
                        color: self.color,
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    };
                    let shaped = window.text_system().shape_line(
                        text.clone().into(),
                        px(spec.size),
                        &[run],
                        None,
                    );
                    // `ShapedLine::paint` centres the glyphs in the line box
                    // it is given, so handing it the run's own height puts the
                    // baseline exactly where the layout says.
                    let origin =
                        bounds.origin + point(px(*x), px(*baseline) - shaped.ascent);
                    let _ = shaped.paint(
                        origin,
                        shaped.ascent + shaped.descent,
                        TextAlign::Left,
                        None,
                        window,
                        cx,
                    );
                }
                MathItem::Rule { x, y, w, h } => {
                    let rect = Bounds::new(
                        bounds.origin + point(px(*x), px(*y)),
                        size(px(*w).max(px(1.)), px(*h).max(px(1.))),
                    );
                    window.paint_quad(fill(rect, self.color));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Context, Render, TestAppContext};
    use gpui_kit::component::theme::{Theme, ThemeMode};

    #[test]
    fn line_number_digits_follow_the_engine() {
        // The engine reserves at least three digits, at most seven
        // (`line_number_len` in gpui-kit's element.rs).
        assert_eq!(line_number_digits(0), 3);
        assert_eq!(line_number_digits(1), 3);
        assert_eq!(line_number_digits(999), 3);
        assert_eq!(line_number_digits(1000), 4);
        assert_eq!(line_number_digits(123_456), 6);
        assert_eq!(line_number_digits(1_000_000), 7);
        assert_eq!(line_number_digits(12_345_678), 7);
    }

    /// The TS `md-callout-line` indents (`d0`/`d1`/`d2`, capped).
    #[test]
    fn callout_indents_cap_at_d2() {
        assert_eq!(callout_indent(0), px(11.));
        assert_eq!(callout_indent(1), px(25.));
        assert_eq!(callout_indent(2), px(39.));
        assert_eq!(callout_indent(5), px(39.));
    }

    /// Before the first layout there is nothing worth scanning for, and after
    /// a scan anything inside the covered window is left alone — the property
    /// that keeps whole-document scans off the scroll path.
    #[test]
    fn the_scan_window_gates_rescans() {
        let host = PreviewHost::new(PreviewFont {
            family: "Helvetica".into(),
            size: px(14.),
        });
        assert!(
            !host.needs_rescan_for(None),
            "no layout yet: the frame cannot show anything new"
        );
        assert!(
            host.needs_rescan_for(Some(&(0..1))),
            "nothing scanned yet: any viewport asks for a pass"
        );
    }

    /// The host's block mapping through the real text system: every core
    /// block becomes an engine block with the same line range and with the
    /// height [`PreviewHost::block_height`] measured — the same layout
    /// [`PreviewHost::render_block`] paints, so this pins the promise that the
    /// reserved box and its element are one measurement.
    #[gpui::test]
    fn the_host_declares_every_block_with_the_height_its_renderer_paints(
        cx: &mut TestAppContext,
    ) {
        // Every block family in one document: a display formula (lines 1-3),
        // a rule (6), a callout's two edges (7, 9) and a fence's two zero
        // height lines (10, 12). The blank line before the rule keeps the
        // parser from reading it as a setext underline.
        const DOC: &str = "\
a
$$
x = 1
$$
b

---
::: 提示
body
:::
```rust
let a = 1;
```
";
        struct Root;
        impl Render for Root {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div()
            }
        }

        cx.update(|cx| {
            // The production boot order (main.rs): the kit's globals, then the
            // theme — `theme::apply` also registers `ActivePalette`, which the
            // block renderers read their callout colours from.
            gpui_kit::init(cx);
            Theme::change(ThemeMode::Dark, None, cx);
            crate::theme::apply(ThemeMode::Dark, cx);
            cx.open_window(Default::default(), |window, cx| {
                let host = PreviewHost::new(PreviewFont {
                    family: "Helvetica".into(),
                    size: px(14.),
                });
                let decorations = host.decorations(DOC, &[], px(700.), None, window, cx);

                let lines: Vec<Range<u64>> = decorations
                    .blocks
                    .iter()
                    .map(|block| block.lines.clone())
                    .collect();
                assert_eq!(
                    lines,
                    vec![1..4, 6..7, 7..8, 9..10, 10..11, 12..13],
                    "{:?}",
                    decorations.blocks
                );

                let math = host
                    .block_math_layout("\nx = 1\n", px(700.), window, cx)
                    .expect("the formula typesets");
                let heights: Vec<Pixels> =
                    decorations.blocks.iter().map(|block| block.height).collect();
                assert_eq!(heights[0], px(math.height()) + px(12.), "6px margins");
                assert_eq!(heights[1], px(22.), "the rule's 10px margins + 2px line");
                assert_eq!(
                    heights[2],
                    px(8.) + window.line_height() * 0.88 + px(4.),
                    "the titled edge's padding around a 0.88em label"
                );
                assert_eq!(heights[3], px(8.), "the closing edge's bare cap");
                assert_eq!(heights[4], px(0.), "fence lines collapse");
                assert_eq!(heights[5], px(0.));

                // The text each renderer arm consumes: the formula's body, the
                // callout's label, nothing for the caps.
                assert_eq!(decorations.blocks[0].text.as_ref(), "\nx = 1\n");
                assert_eq!(decorations.blocks[2].text.as_ref(), "提示");
                assert_eq!(decorations.blocks[3].text.as_ref(), "");

                // A windowed scan pins the covered window: the viewport that
                // asked for it (and anything near it, inside the pad) asks for
                // nothing, while a viewport past the pad asks for a pass.
                let viewport = 0..40usize;
                let _ = host.decorations(DOC, &[], px(700.), Some(&viewport), window, cx);
                assert!(!host.needs_rescan_for(Some(&viewport)));
                assert!(!host.needs_rescan_for(Some(&(4..30))), "inside the window");
                assert!(
                    host.needs_rescan_for(Some(&(SCAN_PAD + 100..SCAN_PAD + 200))),
                    "past the pad"
                );
                assert!(
                    !host.needs_rescan_for(Some(&(SCAN_PAD - 100..SCAN_PAD - 40))),
                    "a scroll that stays inside the pad asks for nothing"
                );
                cx.new(|_| Root)
            })
            .expect("a test window");
        });
    }

    /// The whole image path, minus the engine: a miss emits no span and
    /// queues the work, the real loader (filesystem + decode) runs it, and
    /// the next scan emits the span with exactly the fitted width.
    #[test]
    fn an_image_span_appears_only_once_the_bitmap_is_ready() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Notes")).unwrap();
        image::RgbaImage::from_pixel(600, 300, image::Rgba([10, 20, 30, 255]))
            .save(root.join("Notes/pic.png"))
            .unwrap();

        let host = PreviewHost::new(PreviewFont {
            family: "Helvetica".into(),
            size: px(14.),
        });
        host.images().set_vault_root(root.to_path_buf());
        host.images().set_doc_dir(Some(root.join("Notes")));

        let text = "before ![alt](pic.png) after";
        let range = 7..22;
        assert_eq!(&text[range.clone()], "![alt](pic.png)");

        // Not ready: no span, and the load is queued exactly once.
        assert!(host.image_span(text, range.clone(), "pic.png", px(700.)).is_none());
        let mut pending = host.images().take_pending();
        assert_eq!(pending.len(), 1);
        assert!(host.image_span(text, range.clone(), "pic.png", px(700.)).is_none());
        assert!(host.images().take_pending().is_empty(), "already in flight");

        // The workspace's half of the contract: run it on the background
        // executor, then install the result.
        let outcome = crate::editor::images::load(&pending.remove(0));
        assert!(host.images().finish(outcome));

        let span = host
            .image_span(text, range.clone(), "pic.png", px(700.))
            .expect("span after the load");
        assert_eq!(span.range, range);
        assert!(span.is_widget());
        assert_eq!(span.width(), px(600.), "600 ≤ 700: the intrinsic width");
        assert!(host.images().take_pending().is_empty(), "a hit queues nothing");

        // The column is the only thing the width depends on: a narrow editor
        // re-scans to the fitted width.
        let narrow = host
            .image_span(text, range, "pic.png", px(500.))
            .expect("still ready");
        assert_eq!(narrow.width(), px(500.));
    }
}
