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
//!   formulas through [`bnote_mathml`], everything else out of plain divs.
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
    Hsla, InspectorElementId, IntoElement, LayoutId, Pixels, SharedString, Style, TextAlign,
    TextRun, Window, div, fill, point, prelude::*, px, size,
};
use gpui_kit::component::input::{
    PreviewDecorations, PreviewRenderer, PreviewSpan, PreviewWidget,
};

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

/// Builds the engine snapshot and the widget elements for it.
pub struct PreviewHost {
    font: PreviewFont,
    /// Typeset formulas, keyed by `(tex, display, size in centi-px)`.
    math: RefCell<HashMap<(String, bool, u32), Rc<MathLayout>>>,
    /// What each pushed widget span should render as, keyed by its start
    /// offset. Rebuilt with every snapshot, so a renderer call can only hit a
    /// span from the snapshot that is in effect.
    widgets: RefCell<HashMap<usize, core::Widget>>,
    revision: Cell<u64>,
}

impl PreviewHost {
    pub fn new(font: PreviewFont) -> Self {
        Self {
            font,
            math: RefCell::new(HashMap::new()),
            widgets: RefCell::new(HashMap::new()),
            revision: Cell::new(0),
        }
    }

    /// Scan `text` and turn the result into an engine snapshot.
    ///
    /// Widgets whose width cannot be established yet (images still need an
    /// async loader) are dropped: their source stays visible rather than
    /// collapsing into a box that is not there.
    pub fn decorations(
        &self,
        text: &str,
        selections: &[Range<usize>],
        window: &mut Window,
        cx: &mut App,
    ) -> PreviewDecorations {
        let snapshot = core::scan(ScanInput {
            text,
            selections,
            visible: 0..usize::MAX,
        });
        let line_height = window.line_height();
        let mut spans = Vec::with_capacity(snapshot.spans.len());
        let mut widgets = HashMap::new();
        for span in &snapshot.spans {
            let range = span.range.clone();
            match &span.kind {
                core::PreviewSpanKind::Hidden => spans.push(PreviewSpan::hidden(range)),
                core::PreviewSpanKind::Widget(widget) => {
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
        // Blocks (multi-line formulas, callout panels) need a line-range
        // widget the engine does not have yet: their source stays visible.
        PreviewDecorations {
            spans,
            revision: self.revision.get(),
        }
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
            core::Widget::Checkbox { .. } => base * 1.35,
            core::Widget::Bullet => base * 0.62,
            core::Widget::CodeLang { lang } => self.text_width(lang, window) + base * 0.4,
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
            // Images wait for the async loader; showing the source beats
            // showing nothing.
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
            core::Widget::CodeLang { lang } => {
                chip(&lang, widget.width, widget.line_height, self.font.size, color)
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
            core::Widget::Image { .. } => plain_source(&widget, color),
        }
    }
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
