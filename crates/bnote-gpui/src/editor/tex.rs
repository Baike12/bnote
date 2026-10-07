//! TeX formulas through RaTeX — KaTeX-compatible typesetting in pure Rust.
//!
//! The Tauri shell renders formulas with KaTeX in the WebView; this shell
//! renders the *same syntax* with [RaTeX](https://github.com/erweixin/RaTeX)
//! (`ratex-parser` + `ratex-layout`), whose output is a substrate-neutral
//! **display list**: glyphs, rules, rectangles and outlines in em units. This
//! module is the substrate half of that pipeline and owns exactly three
//! things:
//!
//! - **fonts** — the 20 KaTeX TTFs RaTeX ships, registered once per process
//!   ([`register_fonts`]), plus the mapping from RaTeX's font names
//!   (`"Main-Italic"`) to the gpui face that paints them ([`Face`]; the
//!   mapping is match-exhaustive on [`ratex_font::FontId`], so a font a later
//!   engine version adds is a compile error rather than a dropped glyph);
//! - **scale** — em → px. RaTeX lays out in em and never sees a font size, so
//!   a formula's box and its "shrink to fit" are one multiplier ([`MathBox`]),
//!   not a re-layout;
//! - **paint** — walking the display list ([`MathBox::paint`]): each glyph as
//!   a shaped single-char run (memoized in [`GlyphCache`]; a formula reuses
//!   the same handful of glyphs every frame), each rule as a quad, each
//!   outline as a path.
//!
//! Two engine conventions the paint follows, both read off RaTeX's own Cairo
//! renderer (`ratex-cairo/src/lib.rs`): a glyph's `(x, y)` is its pen origin
//! with **y on the baseline**, and a `Line`'s `y` is its **centre** (the rule
//! is filled from `y - max(thickness, 0.5)/2`). A glyph's char code goes
//! through [`ratex_font::katex_ttf_glyph_char`] first: the display list carries
//! the logical codepoint, while the KaTeX faces keep styled math letters at
//! ASCII (or Private-Use) positions.
//!
//! Formulas the engine cannot parse are `None` from [`TexDoc::typeset`], which
//! every caller turns back into the formula's source — the same visible
//! fallback the KaTeX shell reads as its `throwOnError: false` output.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    App, Bounds, Font, FontStyle, FontWeight, Hsla, Path, PathBuilder, Pixels, Point, Rgba,
    ShapedLine, SharedString, TextAlign, TextRun, Window, fill, point, px, size,
};
use ratex_types::{Color, DisplayItem, DisplayList, MathStyle, PathCommand};

/// Cap on memoized glyph runs. Entries are tiny (a one-char shaped line) and
/// bounded by the characters a vault actually uses inside formulas; the cap
/// only exists so a pathological document cannot grow the map without bound.
const GLYPH_CACHE_MAX: usize = 4096;

/// Stroke width for the outline items RaTeX does not fill (in px, not em:
/// its own renderer strokes a fixed 1.5 — `ratex-cairo`'s `render_path`).
const OUTLINE_STROKE: f32 = 1.5;

/// The px size the loadability probe asks a face for (`Face::served_by`); any
/// size works, it only compares the advance the font itself declares.
const PROBE_SIZE: Pixels = px(16.);

// ------------------------------------------------------------------ 字体

/// One face a display-list item can ask for: the 20 KaTeX faces RaTeX ships,
/// plus the system-font route for CJK and emoji.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Face {
    Ams,
    Caligraphic,
    CaligraphicBold,
    Fraktur,
    FrakturBold,
    Main,
    MainBold,
    MainItalic,
    MainBoldItalic,
    MathItalic,
    MathBoldItalic,
    SansSerif,
    SansSerifBold,
    SansSerifItalic,
    Script,
    Size1,
    Size2,
    Size3,
    Size4,
    Typewriter,
    /// `CJK-Regular` / `CJK-Fallback` / `Emoji-Fallback`: RaTeX ships no CJK
    /// or emoji face, so these paint with the editor's own font — the font the
    /// surrounding prose uses, which is what the KaTeX shell gets from the
    /// browser's fallback stack.
    System,
}

impl Face {
    /// Every KaTeX face, in registration order. [`Face::System`] is not here:
    /// it has no file of its own.
    pub const KATEX: [Face; 20] = [
        Face::Ams,
        Face::Caligraphic,
        Face::CaligraphicBold,
        Face::Fraktur,
        Face::FrakturBold,
        Face::Main,
        Face::MainBold,
        Face::MainItalic,
        Face::MainBoldItalic,
        Face::MathItalic,
        Face::MathBoldItalic,
        Face::SansSerif,
        Face::SansSerifBold,
        Face::SansSerifItalic,
        Face::Script,
        Face::Size1,
        Face::Size2,
        Face::Size3,
        Face::Size4,
        Face::Typewriter,
    ];

    /// The face behind a display-list `font` string (`FontId::as_str`, e.g.
    /// `"Main-Regular"`). `None` for a name this engine version does not know:
    /// the item is skipped rather than painted in the wrong face.
    pub fn from_name(name: &str) -> Option<Face> {
        Some(Face::from_font_id(ratex_font::FontId::parse(name)?))
    }

    /// Exhaustive over the engine's `FontId`.
    fn from_font_id(id: ratex_font::FontId) -> Face {
        use ratex_font::FontId as F;
        match id {
            F::AmsRegular => Face::Ams,
            F::CaligraphicRegular => Face::Caligraphic,
            F::FrakturRegular => Face::Fraktur,
            F::FrakturBold => Face::FrakturBold,
            F::MainBold => Face::MainBold,
            F::MainBoldItalic => Face::MainBoldItalic,
            F::MainItalic => Face::MainItalic,
            F::MainRegular => Face::Main,
            F::MathBoldItalic => Face::MathBoldItalic,
            F::MathItalic => Face::MathItalic,
            F::SansSerifBold => Face::SansSerifBold,
            F::SansSerifItalic => Face::SansSerifItalic,
            F::SansSerifRegular => Face::SansSerif,
            F::ScriptRegular => Face::Script,
            F::Size1Regular => Face::Size1,
            F::Size2Regular => Face::Size2,
            F::Size3Regular => Face::Size3,
            F::Size4Regular => Face::Size4,
            F::TypewriterRegular => Face::Typewriter,
            F::CjkRegular | F::CjkFallback | F::EmojiFallback => Face::System,
        }
    }

    /// The engine-side id [`ratex_font::katex_ttf_glyph_char`] remaps against.
    fn ratex(self) -> ratex_font::FontId {
        use ratex_font::FontId as F;
        match self {
            Face::Ams => F::AmsRegular,
            Face::Caligraphic => F::CaligraphicRegular,
            Face::CaligraphicBold => F::CaligraphicRegular,
            Face::Fraktur => F::FrakturRegular,
            Face::FrakturBold => F::FrakturBold,
            Face::Main => F::MainRegular,
            Face::MainBold => F::MainBold,
            Face::MainItalic => F::MainItalic,
            Face::MainBoldItalic => F::MainBoldItalic,
            Face::MathItalic => F::MathItalic,
            Face::MathBoldItalic => F::MathBoldItalic,
            Face::SansSerif => F::SansSerifRegular,
            Face::SansSerifBold => F::SansSerifBold,
            Face::SansSerifItalic => F::SansSerifItalic,
            Face::Script => F::ScriptRegular,
            Face::Size1 => F::Size1Regular,
            Face::Size2 => F::Size2Regular,
            Face::Size3 => F::Size3Regular,
            Face::Size4 => F::Size4Regular,
            Face::Typewriter => F::TypewriterRegular,
            Face::System => F::CjkRegular,
        }
    }

    /// The TTF RaTeX ships for this face (`ratex-katex-fonts`); `None` for
    /// [`Face::System`]. `Caligraphic` and `CaligraphicBold` share one family —
    /// the weight picks the file at resolution time.
    fn ttf(self) -> Option<&'static str> {
        Some(match self {
            Face::Ams => "KaTeX_AMS-Regular.ttf",
            Face::Caligraphic => "KaTeX_Caligraphic-Regular.ttf",
            Face::CaligraphicBold => "KaTeX_Caligraphic-Bold.ttf",
            Face::Fraktur => "KaTeX_Fraktur-Regular.ttf",
            Face::FrakturBold => "KaTeX_Fraktur-Bold.ttf",
            Face::Main => "KaTeX_Main-Regular.ttf",
            Face::MainBold => "KaTeX_Main-Bold.ttf",
            Face::MainItalic => "KaTeX_Main-Italic.ttf",
            Face::MainBoldItalic => "KaTeX_Main-BoldItalic.ttf",
            Face::MathItalic => "KaTeX_Math-Italic.ttf",
            Face::MathBoldItalic => "KaTeX_Math-BoldItalic.ttf",
            Face::SansSerif => "KaTeX_SansSerif-Regular.ttf",
            Face::SansSerifBold => "KaTeX_SansSerif-Bold.ttf",
            Face::SansSerifItalic => "KaTeX_SansSerif-Italic.ttf",
            Face::Script => "KaTeX_Script-Regular.ttf",
            Face::Size1 => "KaTeX_Size1-Regular.ttf",
            Face::Size2 => "KaTeX_Size2-Regular.ttf",
            Face::Size3 => "KaTeX_Size3-Regular.ttf",
            Face::Size4 => "KaTeX_Size4-Regular.ttf",
            Face::Typewriter => "KaTeX_Typewriter-Regular.ttf",
            Face::System => return None,
        })
    }

    /// The gpui font this face shapes with. [`Face::System`] keeps the caller's
    /// font — family, weight, style and fallback stack — which inside a
    /// formula is the editor's own text style, the one that carries CJK.
    ///
    /// A face gpui cannot load ([`Face::served_by`]) never reaches the text
    /// system: its glyphs are painted from their outlines ([`GlyphCache`]).
    fn font(self, system: &Font) -> Font {
        let (family, weight, style) = match self {
            Face::System => return system.clone(),
            Face::Ams => ("KaTeX_AMS", FontWeight::NORMAL, FontStyle::Normal),
            Face::Caligraphic => ("KaTeX_Caligraphic", FontWeight::NORMAL, FontStyle::Normal),
            Face::CaligraphicBold => ("KaTeX_Caligraphic", FontWeight::BOLD, FontStyle::Normal),
            Face::Fraktur => ("KaTeX_Fraktur", FontWeight::NORMAL, FontStyle::Normal),
            Face::FrakturBold => ("KaTeX_Fraktur", FontWeight::BOLD, FontStyle::Normal),
            Face::Main => ("KaTeX_Main", FontWeight::NORMAL, FontStyle::Normal),
            Face::MainBold => ("KaTeX_Main", FontWeight::BOLD, FontStyle::Normal),
            Face::MainItalic => ("KaTeX_Main", FontWeight::NORMAL, FontStyle::Italic),
            Face::MainBoldItalic => ("KaTeX_Main", FontWeight::BOLD, FontStyle::Italic),
            Face::MathItalic => ("KaTeX_Math", FontWeight::NORMAL, FontStyle::Italic),
            Face::MathBoldItalic => ("KaTeX_Math", FontWeight::BOLD, FontStyle::Italic),
            Face::SansSerif => ("KaTeX_SansSerif", FontWeight::NORMAL, FontStyle::Normal),
            Face::SansSerifBold => ("KaTeX_SansSerif", FontWeight::BOLD, FontStyle::Normal),
            Face::SansSerifItalic => ("KaTeX_SansSerif", FontWeight::NORMAL, FontStyle::Italic),
            Face::Script => ("KaTeX_Script", FontWeight::NORMAL, FontStyle::Normal),
            Face::Size1 => ("KaTeX_Size1", FontWeight::NORMAL, FontStyle::Normal),
            Face::Size2 => ("KaTeX_Size2", FontWeight::NORMAL, FontStyle::Normal),
            Face::Size3 => ("KaTeX_Size3", FontWeight::NORMAL, FontStyle::Normal),
            Face::Size4 => ("KaTeX_Size4", FontWeight::NORMAL, FontStyle::Normal),
            Face::Typewriter => ("KaTeX_Typewriter", FontWeight::NORMAL, FontStyle::Normal),
        };
        Font {
            family: family.into(),
            weight,
            style,
            ..Default::default()
        }
    }

    /// Whether the loaded text system can actually *serve* this face: resolve
    /// the family and ask for the advance of a glyph the TTF itself defines.
    /// A face gpui cannot load resolves to the platform fallback instead, and
    /// the advance then belongs to another font — which is what this measures.
    ///
    /// The check is deliberately about the outcome, not about any reason:
    /// `gpui-pre-macos`'s 'm'-glyph gate is today's cause (see [`GlyphCache`]),
    /// and a gpui that lifts it makes this probe pass without a code change.
    fn served_by(self, font: &ab_glyph::FontVec, text_system: &gpui::TextSystem) -> bool {
        let Some((ch, expected)) = probe_glyph(font) else {
            // No glyph to compare on (an empty face): treat it as served, the
            // shaped path paints nothing either way.
            return true;
        };
        let id = text_system.resolve_font(&self.font(&Font::default()));
        match text_system.advance(id, PROBE_SIZE, ch) {
            Ok(advance) => (advance.width.as_f32() - expected).abs() < 0.5,
            Err(_) => false,
        }
    }
}

/// A glyph to compare the text system's answer against: the first character of
/// a fixed preference list that this face's TTF actually has, and the advance
/// the TTF declares for it at [`PROBE_SIZE`]. `'m'` first — a face that has it
/// is loadable by construction (it is exactly gpui's own gate).
fn probe_glyph(font: &ab_glyph::FontVec) -> Option<(char, f32)> {
    use ab_glyph::Font as _;

    let units_per_em = font.units_per_em().unwrap_or(1000.);
    for ch in ['m', 'M', '(', '∑'] {
        let id = font.glyph_id(ch);
        if id.0 != 0 {
            let advance_em = font.h_advance_unscaled(id) / units_per_em;
            return Some((ch, advance_em * PROBE_SIZE.as_f32()));
        }
    }
    None
}

/// Register the KaTeX TTFs with the app's text system. Call once at boot,
/// before any formula is painted; the app, the harness and the off-screen
/// screenshot channel each do it in their own boot path.
pub fn register_fonts(cx: &App) {
    let fonts: Vec<std::borrow::Cow<'static, [u8]>> = Face::KATEX
        .iter()
        .filter_map(|face| face.ttf())
        .filter_map(ratex_katex_fonts::ttf_bytes)
        .collect();
    let _ = cx.text_system().add_fonts(fonts);
}

// ------------------------------------------------------------------ 排版

/// A typeset formula: RaTeX's display list, size-independent (em units).
pub struct TexDoc {
    list: DisplayList,
}

impl TexDoc {
    /// Parse and lay out `tex` (KaTeX syntax; the delimiters are the caller's).
    /// `None` when the engine rejects it — the caller paints the source
    /// instead.
    pub fn typeset(tex: &str, display: bool) -> Option<TexDoc> {
        let tex = without_auto_numbers(tex);
        let nodes = ratex_parser::parse(&tex).ok()?;
        let style = if display {
            MathStyle::Display
        } else {
            MathStyle::Text
        };
        let options = ratex_layout::LayoutOptions {
            style,
            ..Default::default()
        };
        let laid_out = ratex_layout::layout(&nodes, &options);
        Some(TexDoc {
            list: ratex_layout::to_display_list(&laid_out),
        })
    }

    pub fn width_em(&self) -> f32 {
        self.list.width as f32
    }

    /// Above the baseline.
    pub fn ascent_em(&self) -> f32 {
        self.list.height as f32
    }

    /// Below the baseline (positive).
    pub fn descent_em(&self) -> f32 {
        self.list.depth as f32
    }

    pub fn height_em(&self) -> f32 {
        self.ascent_em() + self.descent_em()
    }

    /// The drawing instructions, for the painter (and the tests).
    pub fn items(&self) -> &[DisplayItem] {
        &self.list.items
    }
}

/// A formula fitted to a box: the display list plus **the em it paints at**.
/// RaTeX never sees a font size, so shrinking an inline formula to its line
/// height (or a block formula to its column) is one multiplier on every
/// coordinate — no second layout pass.
#[derive(Clone)]
pub struct MathBox {
    doc: Rc<TexDoc>,
    em: Pixels,
}

impl MathBox {
    pub fn new(doc: Rc<TexDoc>, em: Pixels) -> Self {
        MathBox { doc, em }
    }

    pub fn width(&self) -> Pixels {
        px(self.doc.width_em() * self.em.as_f32())
    }

    pub fn height(&self) -> Pixels {
        px(self.doc.height_em() * self.em.as_f32())
    }

    /// Paint the formula with its top-left at `bounds.origin`.
    pub fn paint(
        &self,
        bounds: Bounds<Pixels>,
        color: Hsla,
        glyphs: &GlyphCache,
        window: &mut Window,
        cx: &mut App,
    ) {
        let em = self.em.as_f32();
        let system = window.text_style().font().clone();
        for item in self.doc.items() {
            match item {
                DisplayItem::GlyphPath {
                    x,
                    y,
                    scale,
                    font,
                    char_code,
                    color: item_color,
                } => {
                    let Some(face) = Face::from_name(font) else {
                        continue;
                    };
                    let ch = ratex_font::katex_ttf_glyph_char(face.ratex(), *char_code);
                    let ink = resolve_color(item_color, color);
                    let size = px(*scale as f32 * em);
                    let pen = bounds.origin + point(px(*x as f32 * em), px(*y as f32 * em));
                    if glyphs.paints_from_outline(face, window) {
                        // Faces the text system cannot load: fill the face's
                        // own outline at the pen (see [`GlyphCache`]).
                        if let Some(path) = glyphs.outline_path(face, ch, size) {
                            paint_outline(&path, pen, ink, window);
                        }
                        continue;
                    }
                    let shaped = glyphs.shaped(face, size, ch, ink, &system, window);
                    // `ShapedLine::paint` centres the glyphs in the line box it
                    // is given, so handing it the run's own height puts the
                    // baseline exactly where the display list says.
                    let origin = point(pen.x, pen.y - shaped.ascent);
                    let _ = shaped.paint(
                        origin,
                        shaped.ascent + shaped.descent,
                        TextAlign::Left,
                        None,
                        window,
                        cx,
                    );
                }
                DisplayItem::Line {
                    x,
                    y,
                    width,
                    thickness,
                    color: item_color,
                    dashed,
                } => {
                    let ink = resolve_color(item_color, color);
                    let t = (*thickness as f32 * em).max(0.5);
                    let x0 = bounds.origin.x + px(*x as f32 * em);
                    let centre = bounds.origin.y + px(*y as f32 * em);
                    if *dashed {
                        // RaTeX's own pattern: t wide, 3t on, 3t off.
                        let mut path = PathBuilder::stroke(px(t)).dash_array(&[px(t * 3.), px(t * 3.)]);
                        path.move_to(point(x0, centre));
                        path.line_to(point(x0 + px(*width as f32 * em), centre));
                        if let Ok(path) = path.build() {
                            window.paint_path(path, ink);
                        }
                    } else {
                        let rect = Bounds::new(
                            point(x0, centre - px(t / 2.)),
                            size(px(*width as f32 * em), px(t)),
                        );
                        window.paint_quad(fill(rect, ink));
                    }
                }
                DisplayItem::Rect {
                    x,
                    y,
                    width,
                    height,
                    color: item_color,
                } => {
                    let ink = resolve_color(item_color, color);
                    let rect = Bounds::new(
                        bounds.origin + point(px(*x as f32 * em), px(*y as f32 * em)),
                        size(px(*width as f32 * em), px(*height as f32 * em)),
                    );
                    window.paint_quad(fill(rect, ink));
                }
                DisplayItem::Path {
                    x,
                    y,
                    commands,
                    fill: is_fill,
                    color: item_color,
                } => {
                    let ink = resolve_color(item_color, color);
                    let start = point(px(*x as f32 * em), px(*y as f32 * em));
                    let at = |dx: f64, dy: f64| {
                        bounds.origin + start + point(px(dx as f32 * em), px(dy as f32 * em))
                    };
                    let mut path = if *is_fill {
                        PathBuilder::fill()
                    } else {
                        PathBuilder::stroke(px(OUTLINE_STROKE))
                    };
                    for command in commands {
                        match command {
                            PathCommand::MoveTo { x, y } => path.move_to(at(*x, *y)),
                            PathCommand::LineTo { x, y } => path.line_to(at(*x, *y)),
                            PathCommand::CubicTo {
                                x1,
                                y1,
                                x2,
                                y2,
                                x,
                                y,
                            } => path.cubic_bezier_to(at(*x, *y), at(*x1, *y1), at(*x2, *y2)),
                            // lyon's `curve_to` is the quadratic form (the cubic
                            // is `cubic_bezier_to`) — the same shape RaTeX's own
                            // quad → cubic conversion draws.
                            PathCommand::QuadTo { x1, y1, x, y } => {
                                path.curve_to(at(*x, *y), at(*x1, *y1))
                            }
                            PathCommand::Close => path.close(),
                        }
                    }
                    if let Ok(path) = path.build() {
                        window.paint_path(path, ink);
                    }
                }
            }
        }
    }
}

/// RaTeX carries `LayoutOptions.color` into every item, and its default is
/// black — in KaTeX terms "unset", where a glyph takes the colour of the text
/// around it (the display list has no `currentColor`). Anything else is an
/// explicit `\color` / `\textcolor`, which keeps its own value.
fn resolve_color(item: &Color, fallback: Hsla) -> Hsla {
    if *item == Color::BLACK {
        return fallback;
    }
    Hsla::from(Rgba {
        r: item.r,
        g: item.g,
        b: item.b,
        a: item.a,
    })
}

/// `\begin{equation}` → `\begin{equation*}` and friends — the TS shell's
/// `withoutAutoNumbers` (`src/editor/widgets.ts:14-20`), ported so both shells
/// paint the same formula: KaTeX ≥ 0.18 auto-numbers rows of these
/// environments, tags the notes never asked for. Starred environments and an
/// explicit `\tag` keep their behaviour. The scan is textual, exactly like the
/// TS one: it rewrites the environment's name and copies everything else
/// verbatim, so a half-typed `\begin{align` comes back untouched.
fn without_auto_numbers(src: &str) -> String {
    const AUTO_NUMBERED: [&str; 6] = [
        "align", "alignat", "gather", "equation", "flalign", "eqnarray",
    ];
    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    loop {
        // `\begin{` and `\end{` are different lengths, and the earlier of the
        // two wins (an `\end{…}` can precede a later `\begin{…}`).
        let begin = rest.find("\\begin{").map(|at| (at, at + 7));
        let end = rest.find("\\end{").map(|at| (at, at + 5));
        let Some((_, name_at)) = begin.into_iter().chain(end).min_by_key(|(at, _)| *at) else {
            break;
        };
        let Some(close) = rest[name_at..].find('}') else {
            break;
        };
        let name = &rest[name_at..name_at + close];
        // Everything up to (not including) the closing brace, so the star
        // lands *inside* it — `\begin{align*}`.
        out.push_str(&rest[..name_at + close]);
        if AUTO_NUMBERED.contains(&name) {
            out.push('*');
        }
        out.push('}');
        rest = &rest[name_at + close + 1..];
    }
    out.push_str(rest);
    out
}

// ------------------------------------------------------------------ 字形记忆

/// Per-glyph paint state, keyed so a formula reuses it frame after frame.
///
/// Two routes to a glyph, chosen per **face** by measurement, not by guess:
///
/// - the text system ([`Self::shaped`]) — gpui's shaping + glyph atlas, the
///   same rasterizer the prose uses. This is the fast path and covers every
///   face gpui can load.
/// - the face's own outlines ([`Self::outline_path`]) — for faces the text
///   system *cannot* load: `gpui-pre-macos`'s `load_family` drops any font
///   without an 'm' glyph ("font '…' has no 'm' character and was not
///   loaded"), and the KaTeX delimiter/symbol faces are exactly those
///   (measured: no 'm' in AMS, Caligraphic, Script, Size1–4). Resolution then
///   quietly returns the platform fallback — a Helvetica paren where a
///   `Size3` one belongs — so asking the text system for such a face is not
///   an option at all. The outlines come from the same TTFs RaTeX's own
///   renderers fill (`ratex-render`'s `append_outline_path`), which keeps the
///   two drawings identical.
///
/// Which route a face takes is decided by [`Face::served_by`] — a probe of
/// the *loaded* text system, so a gpui that grows the ability to serve these
/// faces automatically moves them back onto the fast path.
#[derive(Default)]
pub struct GlyphCache {
    shaped: RefCell<HashMap<GlyphKey, Rc<ShapedLine>>>,
    /// Built glyph outlines, in px at their own size, positioned with the pen
    /// origin at `(0, 0)`. Cloned and translated per paint (`Path` carries
    /// public vertices); the map is keyed like [`GlyphKey`] minus the colour,
    /// which the fill carries instead.
    outlines: RefCell<HashMap<OutlineKey, Option<Rc<Path<Pixels>>>>>,
    /// Parsed KaTeX faces, for the outline route (one parse per face).
    fonts: RefCell<HashMap<Face, Option<Rc<ab_glyph::FontVec>>>>,
    /// Whether the text system serves a face, measured once per face (the
    /// probe needs no window state, only the text system).
    served: RefCell<HashMap<Face, bool>>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct GlyphKey {
    face: Face,
    /// Font size in centi-px (the display list's `scale * em`).
    size: u32,
    ch: char,
    /// The ink, packed — `ShapedLine` carries its decoration colours, so a
    /// recoloured glyph is a different entry, never a wrong paint.
    color: u32,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct OutlineKey {
    face: Face,
    size: u32,
    ch: char,
}

impl GlyphCache {
    fn shaped(
        &self,
        face: Face,
        size: Pixels,
        ch: char,
        color: Hsla,
        system: &Font,
        window: &mut Window,
    ) -> Rc<ShapedLine> {
        let key = GlyphKey {
            face,
            size: centi(size),
            ch,
            color: pack_color(color),
        };
        if let Some(hit) = self.shaped.borrow().get(&key) {
            return hit.clone();
        }
        let text: SharedString = ch.to_string().into();
        let run = TextRun {
            len: text.len(),
            font: face.font(system),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let shaped = Rc::new(window.text_system().shape_line(text, size, &[run], None));
        let mut cache = self.shaped.borrow_mut();
        if cache.len() >= GLYPH_CACHE_MAX {
            evict_quarter(&mut cache, |key| key.clone());
        }
        cache.insert(key, shaped.clone());
        shaped
    }

    /// Whether this face has to be painted from its outlines (measured, once
    /// per face).
    fn paints_from_outline(&self, face: Face, window: &Window) -> bool {
        if face == Face::System {
            return false;
        }
        if let Some(hit) = self.served.borrow().get(&face) {
            return !hit;
        }
        let Some(font) = self.font(face) else {
            return false;
        };
        let served = face.served_by(&font, window.text_system());
        self.served.borrow_mut().insert(face, served);
        !served
    }

    /// The face's TTF, parsed once (`ratex-katex-fonts`' embedded bytes).
    fn font(&self, face: Face) -> Option<Rc<ab_glyph::FontVec>> {
        if let Some(hit) = self.fonts.borrow().get(&face) {
            return hit.clone();
        }
        let parsed = face
            .ttf()
            .and_then(ratex_katex_fonts::ttf_bytes)
            .and_then(|bytes| ab_glyph::FontVec::try_from_vec(bytes.into_owned()).ok())
            .map(Rc::new);
        self.fonts.borrow_mut().insert(face, parsed.clone());
        parsed
    }

    /// A glyph as a filled outline at `size` px, built once per
    /// `(face, char, size)`; `None` when the face has no such glyph.
    fn outline_path(&self, face: Face, ch: char, size: Pixels) -> Option<Rc<Path<Pixels>>> {
        let key = OutlineKey {
            face,
            size: centi(size),
            ch,
        };
        if let Some(hit) = self.outlines.borrow().get(&key) {
            return hit.clone();
        }
        let built = self.build_outline(face, ch, size).map(Rc::new);
        let mut cache = self.outlines.borrow_mut();
        if cache.len() >= GLYPH_CACHE_MAX {
            evict_quarter(&mut cache, |key| key.clone());
        }
        cache.insert(key, built.clone());
        built
    }

    fn build_outline(&self, face: Face, ch: char, size: Pixels) -> Option<Path<Pixels>> {
        use ab_glyph::{Font as _, OutlineCurve};

        let font = self.font(face)?;
        let glyph_id = font.glyph_id(ch);
        if glyph_id.0 == 0 {
            return None;
        }
        let outline = font.outline(glyph_id)?;
        // Font units are y-up with the pen on the baseline; the host is y-down
        // with glyph origins on the baseline, so y flips — the same mapping
        // `ratex-cairo` draws the identical curves with (`point.y - p.y * s`).
        let scale = size.as_f32().max(0.) / font.units_per_em().unwrap_or(1000.);
        let at = |p: ab_glyph::Point| point(px(p.x * scale), px(-p.y * scale));

        let mut path = PathBuilder::fill();
        let mut current: Option<ab_glyph::Point> = None;
        for curve in outline.curves.iter() {
            // ab_glyph's curves are contour-relative: a new contour starts
            // where the previous one ended, so the move is ours to emit.
            let start = match curve {
                OutlineCurve::Line(p0, _) => *p0,
                OutlineCurve::Quad(p0, _, _) => *p0,
                OutlineCurve::Cubic(p0, _, _, _) => *p0,
            };
            let needs_move = match current {
                None => true,
                Some(last) => {
                    (last.x - start.x).abs() > 0.001 || (last.y - start.y).abs() > 0.001
                }
            };
            if needs_move {
                path.move_to(at(start));
            }
            match *curve {
                OutlineCurve::Line(_, p1) => path.line_to(at(p1)),
                OutlineCurve::Quad(_, p1, p2) => path.curve_to(at(p2), at(p1)),
                OutlineCurve::Cubic(_, p1, p2, p3) => {
                    path.cubic_bezier_to(at(p3), at(p1), at(p2))
                }
            }
            current = Some(match curve {
                OutlineCurve::Line(_, p1) => *p1,
                OutlineCurve::Quad(_, _, p2) => *p2,
                OutlineCurve::Cubic(_, _, _, p3) => *p3,
            });
        }
        path.build().ok()
    }
}

/// Paint a cached outline at `origin` (its pen position on the baseline).
fn paint_outline(path: &Path<Pixels>, origin: Point<Pixels>, ink: Hsla, window: &mut Window) {
    let mut path = path.clone();
    for vertex in &mut path.vertices {
        vertex.xy_position += origin;
    }
    path.bounds.origin += origin;
    window.paint_path(path, ink);
}

fn centi(size: Pixels) -> u32 {
    (size.as_f32() * 100.).max(0.) as u32
}

fn pack_color(color: Hsla) -> u32 {
    let rgba = Rgba::from(color);
    let c = |v: f32| (v.clamp(0., 1.) * 255.) as u32;
    (c(rgba.r) << 24) | (c(rgba.g) << 16) | (c(rgba.b) << 8) | c(rgba.a)
}

/// Drop a quarter of a cache's entries (arbitrary order: every entry is
/// rebuildable from the text it came from).
fn evict_quarter<K: Clone + std::hash::Hash + Eq, V>(
    map: &mut HashMap<K, V>,
    clone_key: impl Fn(&K) -> K,
) {
    let doomed: Vec<K> = map.keys().take(map.len() / 4 + 1).map(clone_key).collect();
    for key in doomed {
        map.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::hsla;

    /// The TS regex's exact case list (`widgets.ts:14`): begin/end, starred
    /// stays, nothing else is touched.
    #[test]
    fn auto_numbered_environments_get_starred() {
        for env in [
            "align", "alignat", "gather", "equation", "flalign", "eqnarray",
        ] {
            let src = format!("\\begin{{{env}}} a \\end{{{env}}}");
            let want = format!("\\begin{{{env}*}} a \\end{{{env}*}}");
            assert_eq!(without_auto_numbers(&src), want);
        }
    }

    #[test]
    fn starred_and_other_environments_are_untouched() {
        for src in [
            "\\begin{align*} a \\end{align*}",
            "\\begin{pmatrix} a & b \\end{pmatrix}",
            "\\begin{cases} 1 & x > 0 \\end{cases}",
            "\\tag{1} x",
            "\\begin{aligned} a \\end{aligned}",
        ] {
            assert_eq!(without_auto_numbers(src), src);
        }
    }

    /// The rewrite is textual, like the TS one: a half-typed environment
    /// (mid-keystroke) must come back unchanged rather than eat the tail.
    #[test]
    fn a_truncated_environment_leaves_the_source_alone() {
        for src in ["\\begin{align", "\\begin{", "\\end", "a \\begin{ali"] {
            assert_eq!(without_auto_numbers(src), src);
        }
    }

    /// The engine covers the formulas the TS shell renders — including the
    /// three the previous MathML engine gave up on (`cases`, `\mathcal`,
    /// `aligned`), which used to fall back to source.
    #[test]
    fn the_engine_typesets_what_the_ts_shell_renders() {
        for tex in [
            "a_2",
            "x^2 + y^2 = z^2",
            "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
            "\\alpha \\le \\beta \\cdot \\sum_{i=1}^{n} i",
            "\\text{for all } \\epsilon > 0",
            "\\mathcal{L}\\{f\\}(s) = \\int_0^\\infty f(t)e^{-st}\\,dt",
            "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
            "f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}",
            "\\begin{aligned} f(x) &= x^2 \\\\ &= (x+1)^2 \\end{aligned}",
        ] {
            let doc = TexDoc::typeset(tex, false).unwrap_or_else(|| panic!("{tex}"));
            assert!(doc.width_em() > 0., "{tex} has no width");
            assert!(doc.height_em() > 0., "{tex} has no height");
            assert!(!doc.items().is_empty(), "{tex} has no items");
        }
    }

    /// A formula the engine cannot parse is `None` — the caller's cue to paint
    /// the source.
    #[test]
    fn an_unparseable_formula_is_none() {
        assert!(TexDoc::typeset("\\frac{", false).is_none());
        assert!(TexDoc::typeset("\\nosuchcommand{x}", false).is_none());
    }

    /// Display and inline styles differ in *geometry* (display-style spacing,
    /// `\sum` limits): the block/inline split is the layout, not a scale.
    #[test]
    fn display_style_is_not_the_inline_style() {
        let display = TexDoc::typeset("\\sum_{i=1}^{n} i", true).expect("display");
        let inline = TexDoc::typeset("\\sum_{i=1}^{n} i", false).expect("inline");
        assert!(display.height_em() > inline.height_em());
    }

    /// The em is the whole size model: the box scales with it, exactly.
    #[test]
    fn the_box_is_the_em_multiplier() {
        let doc = Rc::new(TexDoc::typeset("x^2", false).expect("typeset"));
        let small = MathBox::new(doc.clone(), px(16.));
        let big = MathBox::new(doc, px(32.));
        assert_eq!(big.width(), small.width() * 2.);
        assert_eq!(big.height(), small.height() * 2.);
    }

    /// Every face the engine can name has an embedded file — and the files a
    /// display list asks for are exactly the ones registered.
    #[test]
    fn every_katex_face_has_an_embedded_ttf() {
        for face in Face::KATEX {
            let ttf = face.ttf().unwrap_or_else(|| panic!("{face:?} has no ttf"));
            assert!(ttf.starts_with("KaTeX_"), "{ttf}");
            assert!(
                ratex_katex_fonts::ttf_bytes(ttf).is_some(),
                "{ttf} is not embedded"
            );
        }
        assert!(Face::System.ttf().is_none());
    }

    /// Every font name the engine can emit resolves; an unknown name is
    /// skipped, never guessed.
    #[test]
    fn display_list_font_names_resolve() {
        assert_eq!(Face::from_name("Main-Regular"), Some(Face::Main));
        assert_eq!(Face::from_name("Main-Italic"), Some(Face::MainItalic));
        assert_eq!(Face::from_name("Math-Italic"), Some(Face::MathItalic));
        assert_eq!(Face::from_name("Size3-Regular"), Some(Face::Size3));
        assert_eq!(Face::from_name("CJK-Regular"), Some(Face::System));
        assert_eq!(Face::from_name("Emoji-Fallback"), Some(Face::System));
        assert_eq!(Face::from_name("NoSuchFont-Regular"), None);
    }

    /// A CJK request keeps its codepoint on the system route — the check that
    /// `\text{中文}` does not lose characters — while the math-alphanumeric
    /// remap still fires for the KaTeX faces (U+1D400 → 'A' on Main-Bold,
    /// which is why the call is not optional).
    #[test]
    fn glyph_char_codes_are_remapped_per_face() {
        assert_eq!(ratex_font::katex_ttf_glyph_char(Face::System.ratex(), '中' as u32), '中');
        assert_eq!(
            ratex_font::katex_ttf_glyph_char(Face::MainBold.ratex(), 0x1D400),
            'A'
        );
    }

    /// An uncolored item takes the caller's ink; an explicit `\color` keeps its
    /// own — the KaTeX `currentColor` contract.
    #[test]
    fn item_colors_default_to_the_callers_ink() {
        let caller = hsla(0.5, 0.4, 0.8, 1.);
        assert_eq!(resolve_color(&Color::BLACK, caller), caller);
        // Pure red is hue 0, full saturation, half lightness.
        let resolved = resolve_color(&Color::new(1.0, 0.0, 0.0, 1.0), caller);
        assert!(
            resolved.h.abs() < 0.01 && (resolved.s - 1.0).abs() < 0.01,
            "{resolved:?}"
        );
    }

    /// 手感门禁:一次公式排版(parse + layout + display list)的量级成本。
    /// 输入事务里只有光标所在的那一条公式会重排,其余全走缓存,所以这条链必须
    /// 停在微秒级——本机 release 实测约 40µs,预算按调试构建(慢一个量级)放宽,
    /// 拦的是"每条公式全文扫描 / 布局失稳"这类量级回归。
    #[test]
    fn typesetting_a_formula_stays_cheap() {
        let tex = "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";
        let n = 200u32;
        let start = std::time::Instant::now();
        for _ in 0..n {
            let _ = TexDoc::typeset(tex, false).expect("typeset");
        }
        let per = start.elapsed() / n;
        println!("tex: per formula (parse + layout + display list): {per:?}");
        assert!(
            per < std::time::Duration::from_millis(2),
            "formula typesetting exploded: {per:?}"
        );
    }

    /// The platform gate this module compensates for, as a fact about the
    /// embedded fonts: `gpui-pre-macos` refuses every font without an 'm'
    /// glyph, and exactly these faces are the ones that lack it. If a future
    /// KaTeX font embeds an 'm', this test says the outline route can be
    /// dropped for that face.
    #[test]
    fn the_delimiter_and_symbol_faces_are_the_ones_without_an_m_glyph() {
        use ab_glyph::Font as _;
        let mut unloadable = Vec::new();
        for face in Face::KATEX {
            let bytes =
                ratex_katex_fonts::ttf_bytes(face.ttf().expect("a ttf")).expect("embedded");
            let font = ab_glyph::FontVec::try_from_vec(bytes.into_owned()).expect("parses");
            if font.glyph_id('m').0 == 0 {
                unloadable.push(face);
            }
            // The probe always finds a comparison glyph on these faces.
            assert!(probe_glyph(&font).is_some(), "{face:?} has no probe glyph");
        }
        assert_eq!(
            unloadable,
            vec![
                Face::Ams,
                Face::Caligraphic,
                Face::CaligraphicBold,
                Face::Script,
                Face::Size1,
                Face::Size2,
                Face::Size3,
                Face::Size4,
            ],
        );
    }

    /// The outline route draws the glyph the *face* declares — the check that
    /// a `Size3` paren comes out at delimiter size, not at the base size a
    /// silent fallback face would give.
    #[test]
    fn an_outline_glyph_is_the_faces_own_shape_at_the_asked_size() {
        let cache = GlyphCache::default();
        let size = px(16.);
        let paren = cache
            .outline_path(Face::Size3, '(', size)
            .expect("Size3 has a paren");
        // The KaTeX delimiter paren is ~2.4em tall; a base-size paren from a
        // fallback face is ~0.95em — that gap is what the route exists for.
        assert!(
            paren.bounds.size.height > size * 2.0,
            "Size3 paren ink: {:?}",
            paren.bounds.size
        );
        // Which chars a face has is the face's own business: Size3 has no 'M'.
        assert!(cache.outline_path(Face::Size3, 'M', size).is_none());
        // …and the symbol faces resolve their own glyphs too.
        assert!(cache.outline_path(Face::Ams, 'M', size).is_some());
        assert!(cache.outline_path(Face::Caligraphic, 'A', size).is_some());
    }

    /// 手感门禁:轮廓面每次绘制只做"克隆 + 平移"——曲线只在首次
    /// `(face, char, size)` 时解析一次并缓存,所以每帧成本必须是内存拷贝级,
    /// 不是重新取轮廓并三角化。
    #[test]
    fn painting_an_outline_glyph_is_a_copy_per_frame() {
        let cache = GlyphCache::default();
        let path = cache
            .outline_path(Face::Size4, '(', px(32.))
            .expect("Size4 has a paren");
        println!("tex: outline glyph vertices = {}", path.vertices.len());
        let n = 2000u32;
        let origin = point(px(37.5), px(41.25));
        let start = std::time::Instant::now();
        for _ in 0..n {
            let mut copy = (*path).clone();
            for vertex in &mut copy.vertices {
                vertex.xy_position += origin;
            }
            std::hint::black_box(&copy);
        }
        let per = start.elapsed() / n;
        println!("tex: per paint (clone + translate) = {per:?}");
        assert!(
            per < std::time::Duration::from_micros(50),
            "outline paint is no longer a copy: {per:?}"
        );
    }
}
