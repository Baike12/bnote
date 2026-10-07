//! The footprint zone: the block appended to the end of a daily document
//! (TS `footprint/widget.ts` + `render.ts` + the zone half of
//! `extension.ts`).
//!
//! "Zone → group (source file) → block" with session-local folding; each
//! block body renders as the editor would render that text — the same scan,
//! the same inline widgets (bullets, checkboxes, maths), the same line looks
//! (code/quote backgrounds, list indent). Read-only: a click opens the
//! source file, and the zone never edits.
//!
//! The host's block contract requires the element to fill exactly the box
//! `block_height` declared, so [`zone_height`] and [`zone_element`] walk the
//! same constants, and [`plan_body`] feeds both the measurement and the
//! render from one scan.

use std::collections::BTreeSet;
use std::rc::Rc;

use gpui::{
    AnyElement, App, FontStyle, FontWeight, HighlightStyle, Hsla, IntoElement as _, MouseButton,
    Pixels, SharedString, StyledText, TextRun, Window, div, prelude::*, px,
};

use bnote_core::footprint::view::FootprintGroupView;
use bnote_core::preview::{self as core, ScanInput};

use crate::editor::preview::{MathView, PreviewHost, callout_indent, line_table};

/// The zone's content as the shell computes it (fold included): the host
/// renders exactly this and nothing else.
#[derive(Clone, Debug, PartialEq)]
pub struct ZoneInput {
    /// The day the zone belongs to: today shows 「今日足迹」, a historical
    /// daily shows 「<day> 足迹」.
    pub day: String,
    pub is_today: bool,
    pub groups: Vec<FootprintGroupView>,
    pub zone_collapsed: bool,
    /// Collapsed group paths (source file absolute paths).
    pub collapsed: BTreeSet<String>,
}

impl ZoneInput {
    pub fn file_count(&self) -> usize {
        self.groups.len()
    }

    pub fn block_count(&self) -> usize {
        self.groups.iter().map(|g| g.blocks.len()).sum()
    }
}

// ---------------------------------------------------------------- 点击动作

/// Zone interactions, dispatched from the element's handlers and handled by
/// the workspace (`on_action`) — the widget itself holds no editor state.
#[derive(Clone, PartialEq, gpui::Action)]
#[action(namespace = footprint_zone, no_json)]
pub struct ToggleFootprintZone;

/// Collapse/expand one group (the arrow).
#[derive(Clone, PartialEq, gpui::Action)]
#[action(namespace = footprint_zone, no_json)]
pub struct ToggleFootprintGroup {
    pub path: String,
}

/// Jump to the source file: a group title opens the file, a block body opens
/// it at the block's first line (`line` 0 = the top).
#[derive(Clone, PartialEq, gpui::Action)]
#[action(namespace = footprint_zone, no_json)]
pub struct OpenFootprintSource {
    pub path: String,
    pub line: usize,
}

// ---------------------------------------------------------------- 尺寸表

/// `.footprint-zone { margin: 6px 0 2px; padding: 2px 0 4px }`.
const ZONE_MARGIN_TOP: f32 = 6.;
const ZONE_PAD_TOP: f32 = 2.;
const ZONE_PAD_BOTTOM: f32 = 4.;
/// `.footprint-zone-head { font-size: .8em; padding: 3px 0 }`.
const HEAD_EM: f32 = 0.8;
const HEAD_PAD: f32 = 3.;
/// `.footprint-group-head { font-size: .82em; padding: 3px 0 5px }`.
const GROUP_EM: f32 = 0.82;
const GROUP_PAD_TOP: f32 = 3.;
const GROUP_PAD_BOTTOM: f32 = 5.;
/// `.footprint-block { margin: 0 0 8px; padding: 1px 0 1px 10px;
/// border-left: 2px; font-size: .92em }`.
const BLOCK_MARGIN_BOTTOM: f32 = 8.;
const BLOCK_PAD_Y: f32 = 1.;
const BLOCK_PAD_LEFT: f32 = 10.;
const BLOCK_BORDER: f32 = 2.;
const BLOCK_EM: f32 = 0.92;
/// `.footprint-line { line-height: 1.55 }`, `.footprint-gap { height: .5em }`.
const BODY_LINE_HEIGHT: f32 = 1.55;
const BODY_GAP_EM: f32 = 0.5;
/// `.fp-hr { margin: .3em 0 }` around a 1px rule.
const RULE_MARGIN_EM: f32 = 0.3;

// ---------------------------------------------------------------- 测量

/// The height the zone reserves, measured with the same primitives the
/// renderer paints with.
pub fn zone_height(
    host: &PreviewHost,
    zone: &ZoneInput,
    column: Pixels,
    window: &mut Window,
    cx: &mut App,
) -> Pixels {
    let font = host.font().size;
    let mut height = px(ZONE_MARGIN_TOP + ZONE_PAD_TOP + ZONE_PAD_BOTTOM);
    height += head_height(font * HEAD_EM, font, window);
    if zone.zone_collapsed {
        return height;
    }
    for group in &zone.groups {
        height += head_height(font * GROUP_EM, font, window);
        if zone.collapsed.contains(&group.path) {
            continue;
        }
        for block in &group.blocks {
            let inner = column - px(BLOCK_PAD_LEFT + BLOCK_BORDER);
            height += body_height(host, &block.text, inner, window, cx)
                + px(BLOCK_PAD_Y) * 2.
                + px(BLOCK_BORDER)
                + px(BLOCK_MARGIN_BOTTOM);
        }
    }
    height
}

/// One light header row: its padding plus one text row (`line-height: normal`
/// in these rules — the ambient line height).
fn head_height(size: Pixels, font: Pixels, window: &mut Window) -> Pixels {
    let row = window.line_height().max(size * 1.4);
    let pad = if size == font * GROUP_EM {
        px(GROUP_PAD_TOP + GROUP_PAD_BOTTOM)
    } else {
        px(HEAD_PAD * 2.)
    };
    row + pad
}

/// The body content's height — the same planned lines the renderer builds.
fn body_height(
    host: &PreviewHost,
    text: &str,
    width: Pixels,
    window: &mut Window,
    cx: &mut App,
) -> Pixels {
    plan_body(host, text, width, window, cx)
        .iter()
        .map(|line| line.height)
        .sum()
}

// ---------------------------------------------------------------- 行计划

/// One planned body line: how tall it is and what it paints, from one scan.
struct PlannedLine {
    height: Pixels,
    line: BodyLine,
}

enum BodyLine {
    /// Shaped text with inline widget boxes (the list marker is one of them:
    /// the scan's bullet/checkbox widget spans).
    Text { parts: Vec<Part>, look: LineLook },
    /// A display formula inside the block.
    Math(Rc<crate::editor::tex::MathBox>),
    /// A `---` rule.
    Rule,
    /// A line the scan removed entirely (a fence line).
    Hidden,
    /// A blank line (`.footprint-gap`).
    Gap,
}

/// One piece of a body line.
enum Part {
    Text { text: String, runs: Vec<TextRun> },
    /// An inline widget box, already measured and built.
    Widget { width: Pixels, element: AnyElement },
}

/// The line's own look (from the scan's panels).
#[derive(Clone, Copy, Default)]
struct LineLook {
    background: Option<Hsla>,
    border: Option<(Pixels, Hsla)>,
    inset: Pixels,
    quote: bool,
}

/// Scan the block's text once and lay out the lines to paint. No selection:
/// a static read has no active line, so every mark hides.
fn plan_body(
    host: &PreviewHost,
    text: &str,
    width: Pixels,
    window: &mut Window,
    cx: &mut App,
) -> Vec<PlannedLine> {
    let snapshot = core::scan(ScanInput {
        text,
        selections: &[],
        visible: 0..usize::MAX,
        math_preview: false,
    });
    let font = host.font().size;
    let base = font * BLOCK_EM;
    let line_height = base * BODY_LINE_HEIGHT;
    let palette = host.palette(cx);
    let lines = line_table(text);

    let mut planned: Vec<PlannedLine> = Vec::with_capacity(lines.len());
    let mut n = 0usize;
    while n < lines.len() {
        // Blocks (display maths, rules, fence lines) claim their line range.
        if let Some(block) = snapshot.blocks.iter().find(|b| b.first_line == n) {
            let last = block.last_line.unwrap_or(block.first_line);
            match &block.kind {
                core::BlockKind::Math { tex, .. } => {
                    let (height, line) = match host.math_layout(tex, true, base, line_height)
                    {
                        Some(layout) => (
                            layout.height() + px(6.) * 2.,
                            BodyLine::Math(layout),
                        ),
                        None => (
                            line_height + px(6.) * 2.,
                            BodyLine::Text {
                                parts: vec![Part::Text {
                                    text: tex.split_whitespace().collect::<Vec<_>>().join(" "),
                                    runs: vec![plain_run(base, palette.color("danger"))],
                                }],
                                look: LineLook::default(),
                            },
                        ),
                    };
                    planned.push(PlannedLine { height, line });
                }
                core::BlockKind::Rule { .. } => planned.push(PlannedLine {
                    height: base * (RULE_MARGIN_EM * 2.) + px(1.),
                    line: BodyLine::Rule,
                }),
                core::BlockKind::HiddenLine => {
                    planned.push(PlannedLine { height: px(0.), line: BodyLine::Hidden })
                }
                _ => {}
            }
            n = last + 1;
            continue;
        }

        let (from, to) = lines[n];
        let raw = &text[from..to];
        if raw.trim().is_empty() {
            planned.push(PlannedLine {
                height: base * BODY_GAP_EM,
                line: BodyLine::Gap,
            });
            n += 1;
            continue;
        }

        let look = line_look(&snapshot, n, palette);
        let geometry = snapshot.lists.iter().find(|l| l.line == n).copied();
        let inset = geometry
            .map(|g| base * core::li_px_em(g.level))
            .unwrap_or(look.inset);
        let slot = geometry
            .and_then(|g| {
                core::li_hang_em(g.marker)
                    .map(|em| base * em)
                    .or(Some(px(core::LI_ORDERED_PX)))
            })
            .unwrap_or(px(0.));

        let text_width = (width - inset - slot).max(px(40.));
        let parts = line_parts(host, text, from, to, &snapshot, base, line_height, palette, window, cx);
        let height = parts_height(&parts, text_width, line_height, window);
        planned.push(PlannedLine { height, line: BodyLine::Text { parts, look } });
        n += 1;
    }
    planned
}

fn line_look(
    snapshot: &core::PreviewSnapshot,
    line: usize,
    palette: &'static crate::theme::Palette,
) -> LineLook {
    let mut look = LineLook::default();
    for panel in &snapshot.panels {
        if line < panel.first_line || line > panel.last_line {
            continue;
        }
        match &panel.kind {
            core::PanelKind::CodeBlock => {
                look.background = Some(palette.color("code-block-bg"));
            }
            core::PanelKind::Blockquote => {
                look.border = Some((px(3.), palette.color("h2-color").opacity(0.4)));
                look.quote = true;
                look.inset = px(12.);
            }
            core::PanelKind::Callout { depth, .. } => {
                look.border = Some((px(3.), palette.color("h2-color").opacity(0.5)));
                look.inset = callout_indent(*depth as usize);
            }
        }
    }
    look
}

/// The parts of one body line: text slices with runs, inline widgets in
/// place of their sources.
#[allow(clippy::too_many_arguments)]
fn line_parts(
    host: &PreviewHost,
    text: &str,
    from: usize,
    to: usize,
    snapshot: &core::PreviewSnapshot,
    base: Pixels,
    line_height: Pixels,
    palette: &'static crate::theme::Palette,
    window: &mut Window,
    cx: &mut App,
) -> Vec<Part> {
    // The line's cuts, in order: hidden ranges (drop the bytes) and widget
    // ranges (a box). The list marker's own widget is consumed by the marker
    // slot, so it is not repeated here.
    let mut cuts: Vec<(std::ops::Range<usize>, Option<core::Widget>)> = Vec::new();
    for span in &snapshot.spans {
        let start = span.range.start.max(from);
        let end = span.range.end.min(to);
        if start >= end {
            continue;
        }
        let widget = match &span.kind {
            core::PreviewSpanKind::Hidden => None,
            core::PreviewSpanKind::Widget(widget) => Some(widget.clone()),
        };
        cuts.push((start..end, widget));
    }
    cuts.sort_by_key(|(range, _)| range.start);

    let mut parts: Vec<Part> = Vec::new();
    let mut pos = from;
    for (range, widget) in cuts {
        if range.start > pos {
            let slice = &text[pos..range.start];
            if !slice.is_empty() {
                parts.push(Part::Text {
                    text: slice.to_string(),
                    runs: runs_for(snapshot, pos, range.start, palette, base, window),
                });
            }
        }
        if let Some(widget) = widget {
            if let Some(width) = host.widget_width_at(&widget, base, line_height, window) {
                let element = widget_element(host, &widget, width, line_height, base, cx);
                parts.push(Part::Widget { width, element });
            }
        }
        pos = range.end;
    }
    if pos < to {
        let slice = &text[pos..to];
        if !slice.is_empty() {
            parts.push(Part::Text {
                text: slice.to_string(),
                runs: runs_for(snapshot, pos, to, palette, base, window),
            });
        }
    }
    parts
}

/// Runs for one visible slice: the scan's styles clamped and sliced, in
/// order (later styles win, like the engine's composition).
fn runs_for(
    snapshot: &core::PreviewSnapshot,
    from: usize,
    to: usize,
    palette: &'static crate::theme::Palette,
    base: Pixels,
    window: &mut Window,
) -> Vec<TextRun> {
    let _ = window;
    let mut styled: Vec<(std::ops::Range<usize>, HighlightStyle)> = Vec::new();
    let mut boundaries = vec![from, to];
    for span in &snapshot.styles {
        let start = span.range.start.max(from);
        let end = span.range.end.min(to);
        if start >= end {
            continue;
        }
        boundaries.push(start);
        boundaries.push(end);
        styled.push((start..end, style_of(span.style, palette)));
    }
    boundaries.sort_unstable();
    boundaries.dedup();
    let mut runs = Vec::new();
    for pair in boundaries.windows(2) {
        let slice = pair[0]..pair[1];
        let len = slice.end - slice.start;
        if len == 0 {
            continue;
        }
        let win = styled
            .iter()
            .rev()
            .find(|(range, _)| range.start <= slice.start && range.end >= slice.end);
        let mut run = plain_run(base, palette.color("text"));
        run.len = len;
        if let Some((_, style)) = win {
            if let Some(color) = style.color {
                run.color = color;
            }
            if let Some(weight) = style.font_weight {
                run.font.weight = weight;
            }
            if let Some(italic) = style.font_style {
                run.font.style = italic;
            }
            run.background_color = style.background_color;
            run.underline = style.underline;
            run.strikethrough = style.strikethrough;
        }
        runs.push(run);
    }
    runs
}

/// A run template: `len` is filled by the caller per slice.
fn plain_run(_size: Pixels, color: Hsla) -> TextRun {
    TextRun {
        len: 0,
        font: gpui::Font {
            weight: FontWeight::NORMAL,
            style: FontStyle::Normal,
            ..Default::default()
        },
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    }
}

/// The same mapping `PreviewHost::style_decorations` uses, for one span.
fn style_of(style: core::SpanStyle, palette: &'static crate::theme::Palette) -> HighlightStyle {
    use core::SpanStyle as S;
    match style {
        S::Strong => HighlightStyle {
            font_weight: Some(FontWeight::BOLD),
            color: Some(palette.color("strong-color")),
            ..Default::default()
        },
        S::Emphasis => HighlightStyle {
            font_style: Some(FontStyle::Italic),
            color: Some(palette.color("strong-color")),
            ..Default::default()
        },
        S::InlineCode => HighlightStyle {
            background_color: Some(palette.color("code-inline-bg")),
            color: Some(palette.token("number")),
            ..Default::default()
        },
        S::Link | S::WikiLink => HighlightStyle {
            color: Some(palette.color("link")),
            ..Default::default()
        },
        S::LinkUrl => HighlightStyle {
            color: Some(palette.color("text-faint")),
            ..Default::default()
        },
        S::Heading { level } => HighlightStyle {
            font_weight: Some(FontWeight::BOLD),
            color: Some(palette.heading(level as usize)),
            ..Default::default()
        },
        S::Strikethrough => HighlightStyle {
            color: Some(palette.color("text-dim")),
            ..Default::default()
        },
        S::MathDelim => HighlightStyle {
            color: Some(palette.color("keyword")),
            ..Default::default()
        },
        S::MathCmd => HighlightStyle {
            color: Some(palette.color("danger")),
            ..Default::default()
        },
        S::MathBrace => HighlightStyle {
            color: Some(palette.token("number")),
            ..Default::default()
        },
        _ => HighlightStyle::default(),
    }
}

/// An inline widget's element, reusing the host's widget renderers.
fn widget_element(
    host: &PreviewHost,
    widget: &core::Widget,
    width: Pixels,
    line_height: Pixels,
    base: Pixels,
    cx: &mut App,
) -> AnyElement {
    let color = host.palette(cx).color("text");
    match widget {
        core::Widget::Math { tex, display } => host
            .math_layout(tex, *display, base, line_height)
            .map(|layout| {
                MathView {
                    layout,
                    color,
                    glyphs: host.glyphs(),
                }
                .into_any_element()
            })
            .unwrap_or_else(|| div().w(width).into_any_element()),
        core::Widget::Escape { char } => div()
            .w(width)
            .text_color(color)
            .child(char.to_string())
            .into_any_element(),
        core::Widget::Checkbox { checked } => checkbox_element(*checked, base, width, color),
        core::Widget::Bullet => {
            let dot = base * 0.34;
            div()
                .w(width)
                .flex()
                .items_center()
                .child(div().w(dot).h(dot).rounded_full().bg(color.opacity(0.85)))
                .into_any_element()
        }
        // A read-only reference embeds no picture (the TS renders the alt
        // text): the click target is the whole block.
        core::Widget::Image { .. } => div().into_any_element(),
    }
}

fn checkbox_element(checked: bool, base: Pixels, width: Pixels, color: Hsla) -> AnyElement {
    let size = base * 0.9;
    let mark = if checked { "✓" } else { "" };
    div()
        .w(width)
        .flex()
        .items_center()
        .child(
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

/// The rows the parts occupy: a lone text part wraps at `width`; anything
/// else is one row (widgets are inline boxes, and a mixed line keeps its
/// parts on one row — the TS inline flow cannot be reproduced by boxes, so
/// such a line does not re-wrap).
fn parts_height(
    parts: &[Part],
    width: Pixels,
    line_height: Pixels,
    window: &mut Window,
) -> Pixels {
    let mut rows = 0usize;
    let single = parts.len() == 1;
    for part in parts {
        match part {
            Part::Text { text, runs } => {
                let wrapped = window
                    .text_system()
                    .shape_text(
                        SharedString::from(text.clone()),
                        line_height / BODY_LINE_HEIGHT,
                        runs,
                        single.then_some(width),
                        None,
                    )
                    .map(|lines| lines.len())
                    .unwrap_or(1);
                rows += wrapped.max(1);
            }
            Part::Widget { .. } => rows += 1,
        }
    }
    line_height * rows.max(1) as f32
}

// ---------------------------------------------------------------- 渲染

/// The zone element, filling exactly the box [`zone_height`] declared.
pub fn zone_element(
    host: &PreviewHost,
    zone: &ZoneInput,
    column: Pixels,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let font = host.font().size;
    let palette = host.palette(cx);
    let faint = palette.color("text-faint");
    let accent = palette.color("accent");
    let border = palette.color("border");

    let arrow = |collapsed: bool| if collapsed { "▸" } else { "▾" };
    let title = if zone.is_today {
        "今日足迹".to_string()
    } else {
        format!("{} 足迹", zone.day)
    };
    let mut zone_el = div()
        .w(column)
        .pt(px(ZONE_MARGIN_TOP + ZONE_PAD_TOP))
        .pb(px(ZONE_PAD_BOTTOM))
        .border_t_1()
        .border_color(border)
        .child(
            div()
                .py(px(HEAD_PAD))
                .text_size(font * HEAD_EM)
                .text_color(faint)
                .cursor_pointer()
                .on_mouse_down(MouseButton::Left, |_, window, cx| {
                    window.dispatch_action(Box::new(ToggleFootprintZone), cx)
                })
                .child(format!(
                    "{} {} · {} 个文件 · {} 段",
                    arrow(zone.zone_collapsed),
                    title,
                    zone.file_count(),
                    zone.block_count()
                )),
        );

    if zone.zone_collapsed {
        return zone_el.into_any_element();
    }

    for group in &zone.groups {
        let collapsed = zone.collapsed.contains(&group.path);
        let path_toggle = group.path.clone();
        let path_open = group.path.clone();
        let mut group_el = div().child(
            div()
                .pt(px(GROUP_PAD_TOP))
                .pb(px(GROUP_PAD_BOTTOM))
                .text_size(font * GROUP_EM)
                .text_color(faint)
                .flex()
                .child(
                    div()
                        .cursor_pointer()
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            window.dispatch_action(
                                Box::new(ToggleFootprintGroup { path: path_toggle.clone() }),
                                cx,
                            )
                        })
                        .child(arrow(collapsed).to_string()),
                )
                .child(
                    div()
                        .cursor_pointer()
                        .text_color(accent)
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            window.dispatch_action(
                                Box::new(OpenFootprintSource { path: path_open.clone(), line: 0 }),
                                cx,
                            )
                        })
                        .child(format!("《{}》", group.label)),
                )
                .child(format!(" · {} 段", group.blocks.len())),
        );
        if !collapsed {
            for block in &group.blocks {
                let path = group.path.clone();
                let line = block.start;
                group_el = group_el.child(
                    div()
                        .mb(px(BLOCK_MARGIN_BOTTOM))
                        .py(px(BLOCK_PAD_Y))
                        .pl(px(BLOCK_PAD_LEFT))
                        .border_l_2()
                        .border_color(border)
                        .cursor_pointer()
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            window.dispatch_action(
                                Box::new(OpenFootprintSource { path: path.clone(), line }),
                                cx,
                            )
                        })
                        .child(body_element(
                            host,
                            &block.text,
                            column - px(BLOCK_PAD_LEFT + BLOCK_BORDER),
                            window,
                            cx,
                        )),
                );
            }
        }
        zone_el = zone_el.child(group_el);
    }
    zone_el.into_any_element()
}

/// One block body: the planned lines as elements at `width`.
fn body_element(
    host: &PreviewHost,
    text: &str,
    width: Pixels,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let plan = plan_body(host, text, width, window, cx);
    let font = host.font().size;
    let base = font * BLOCK_EM;
    let line_height = base * BODY_LINE_HEIGHT;
    let palette = host.palette(cx);

    let mut body = div().w(width).text_size(base).line_height(line_height);
    for planned in plan {
        match planned.line {
            BodyLine::Gap => {
                body = body.child(div().h(base * BODY_GAP_EM));
            }
            BodyLine::Hidden => {}
            BodyLine::Rule => {
                body = body.child(
                    div()
                        .py(base * RULE_MARGIN_EM)
                        .child(div().h(px(1.)).w_full().bg(palette.color("border"))),
                );
            }
            BodyLine::Math(layout) => {
                body = body.child(
                    div()
                        .py(px(6.))
                        .flex()
                        .justify_center()
                        .child(MathView {
                            layout,
                            color: palette.color("text"),
                            glyphs: host.glyphs(),
                        }),
                );
            }
            BodyLine::Text { parts, look } => {
                let mut row = div().flex().items_start().pl(look.inset);
                if let Some(background) = look.background {
                    row = row.bg(background);
                }
                if let Some((width, color)) = look.border {
                    row = row.border_l(width).border_color(color);
                }
                if look.quote {
                    row = row.text_color(palette.color("h2-color")).italic();
                }
                for part in parts {
                    match part {
                        Part::Text { text, runs } => {
                            row = row.child(
                                div()
                                    .child(StyledText::new(SharedString::from(text)).with_runs(runs)),
                            );
                        }
                        Part::Widget { width, element } => {
                            row = row.child(div().w(width).child(element));
                        }
                    }
                }
                body = body.child(row);
            }
        }
    }
    body.into_any_element()
}
