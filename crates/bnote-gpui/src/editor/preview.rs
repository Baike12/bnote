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
    PreviewDecorations, PreviewRenderer, PreviewSpan, PreviewWidget,
};

use super::images::ImageStore;

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

/// Digits the editor reserves for line numbers: at least three, at most
/// seven, otherwise as many as the line count needs — the engine's
/// `line_number_len` (`element.rs`).
fn line_number_digits(lines: usize) -> usize {
    (lines.max(1).ilog10() as usize + 1).clamp(3, 7)
}

/// Builds the engine snapshot and the widget elements for it.
pub struct PreviewHost {
    font: PreviewFont,
    /// Typeset formulas, keyed by `(tex, display, size in centi-px)`.
    math: RefCell<HashMap<(String, bool, u32), Rc<MathLayout>>>,
    /// What each pushed widget span should render as, keyed by its start
    /// offset. Rebuilt with every snapshot, so a renderer call can only hit a
    /// span from the snapshot that is in effect.
    widgets: RefCell<HashMap<usize, core::Widget>>,
    /// Decoded images (background-loaded, read here on the UI thread).
    images: ImageStore,
    /// The editor width the last scan measured against; a change re-scans,
    /// because every image span's reserved width is a function of it.
    editor_width: Cell<Pixels>,
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
            images: ImageStore::new(),
            editor_width: Cell::new(Pixels::ZERO),
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
    /// an image sizes itself to.
    ///
    /// Widgets whose width cannot be established yet (an image whose file has
    /// not been decoded) are dropped: their source stays visible rather than
    /// collapsing into a box that is not there.
    pub fn decorations(
        &self,
        text: &str,
        selections: &[Range<usize>],
        column: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) -> PreviewDecorations {
        let snapshot = core::scan(ScanInput {
            text,
            selections,
            visible: 0..usize::MAX,
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
        self.revision.set(self.revision.get() + 1);
        // No block widgets: multi-line constructs (fenced code, callout
        // panels) keep their source visible for now.
        PreviewDecorations {
            spans,
            blocks: Vec::new(),
            revision: self.revision.get(),
        }
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
            core::Widget::CalloutTitle { kind, title } => {
                let label = if title.is_empty() {
                    kind.clone()
                } else {
                    format!("{kind} {title}")
                };
                self.text_width(&label, window) + base * 0.8
            }
            // A rule is drawn as a line; give it a width the text after it can
            // sit behind rather than measuring "---" itself.
            core::Widget::Rule => base * 4.,
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

    /// Typeset `tex`, scaled down to fit a text line when it has to.
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
        let key = (tex.to_owned(), display, (base.as_f32() * 100.) as u32);
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
            core::Widget::CalloutTitle { kind, title } => {
                let label = if title.is_empty() {
                    kind
                } else {
                    format!("{kind}  {title}")
                };
                chip(&label, widget.width, widget.line_height, self.font.size, color)
            }
            core::Widget::Rule => div()
                .w(widget.width)
                .h(widget.line_height)
                .flex()
                .items_center()
                .child(div().w_full().h(px(1.)).bg(color.opacity(0.35)))
                .into_any_element(),
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

/// A small rounded label (code-fence language, callout title).
fn chip(label: &str, width: Pixels, height: Pixels, size: Pixels, color: Hsla) -> AnyElement {
    div()
        .w(width)
        .h(height)
        .flex()
        .items_center()
        .child(
            div()
                .px(size * 0.4)
                .py(size * 0.1)
                .rounded_sm()
                .bg(color.opacity(0.12))
                .text_size(size * 0.8)
                .text_color(color.opacity(0.9))
                .child(label.to_owned()),
        )
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
