//! LaTeX → MathML → positioned boxes, for bnote's GPUI renderer.
//!
//! The pipeline is deliberately split so that all *geometry* is testable
//! without a window: `latex2mathml` turns TeX into a MathML string, this
//! crate parses the MathML subset it emits into a node tree, lays that tree
//! out against a [`MathFontMetrics`] implementation, and produces a flat
//! list of [`MathItem`]s in a local coordinate system. The GPUI layer only
//! walks the items and paints them (shaped runs at their origins, filled
//! rects for rules) — it makes no layout decisions of its own.
//!
//! # Coordinate system
//!
//! A [`MathLayout`] has its own top-left origin. Its baseline sits at
//! `y = ascent`; `x` runs left to right. Items carry absolute local
//! coordinates in that space: a [`MathItem::Run`]'s baseline is at
//! `(x, baseline)`, a [`MathItem::Rule`] is a filled rectangle
//! `(x, y, w, h)`.
//!
//! # Sizing contract
//!
//! [`layout`] renders at `base_size` (px) and never exceeds `max_width` when
//! one is given (long `mtable`s and unwrappable `mrow`s are allowed to
//! overflow only when `max_width` is `None`). The caller decides how to fit
//! a tall formula into a text line: it re-runs `layout` with a smaller
//! `base_size` until `ascent + descent` fits the available height.
//!
//! `None` comes back whenever the pipeline cannot produce geometry worth
//! painting: TeX that `latex2mathml` rejects (or reports with its inline
//! `[PARSE ERROR]` marker), MathML outside the supported subset, a degenerate
//! `base_size`, or an empty result. Every `None` is a signal to the caller to
//! paint the raw source instead.

pub mod normalize;
pub mod parse;

mod layout;

/// What a text run measured to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Measured {
    pub width: f32,
    /// Above the baseline.
    pub ascent: f32,
    /// Below the baseline (positive).
    pub descent: f32,
}

/// Font metrics the layout needs. Implementations must be deterministic for
/// the same `(text, spec)` pair; the layout caches nothing and may call
/// `measure` repeatedly.
pub trait MathFontMetrics {
    fn measure(&self, text: &str, spec: FontSpec) -> Measured;
}

/// How a run is set.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FontSpec {
    /// Font size in px.
    pub size: f32,
    /// Math italic for single-letter identifiers; upright otherwise.
    pub italic: bool,
    pub bold: bool,
}

/// One positioned painting instruction.
#[derive(Clone, Debug, PartialEq)]
pub enum MathItem {
    /// A text run whose left edge is `x` and whose baseline is `baseline`.
    Run {
        x: f32,
        baseline: f32,
        text: String,
        spec: FontSpec,
    },
    /// A filled rectangle, e.g. a fraction bar or a radical's overbar.
    Rule { x: f32, y: f32, w: f32, h: f32 },
}

/// A laid-out formula in its own coordinate space.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MathLayout {
    pub width: f32,
    /// Distance from the top of the layout down to the baseline.
    pub ascent: f32,
    /// Distance from the baseline down to the bottom.
    pub descent: f32,
    pub items: Vec<MathItem>,
}

impl MathLayout {
    pub fn height(&self) -> f32 {
        self.ascent + self.descent
    }
}

/// Lay out `tex`.
///
/// Returns `None` when the TeX cannot be converted to MathML or the MathML
/// tree has no supported shape; the caller falls back to painting the raw
/// source text. The TeX is passed through [`normalize::normalize`] first, so
/// spellings the emitter does not know (`\le`, `\dfrac`, `\bigl`) are folded
/// into ones it does before conversion.
pub fn layout(
    tex: &str,
    display: bool,
    base_size: f32,
    max_width: Option<f32>,
    metrics: &dyn MathFontMetrics,
) -> Option<MathLayout> {
    if !base_size.is_finite() || base_size <= 0.0 {
        return None;
    }
    let style = if display {
        latex2mathml::DisplayStyle::Block
    } else {
        latex2mathml::DisplayStyle::Inline
    };
    let mathml = latex2mathml::latex_to_mathml(&normalize::normalize(tex), style).ok()?;
    let tree = parse::parse_mathml(&mathml)?;
    layout::run(&tree, display, base_size, max_width, metrics)
}

#[cfg(test)]
mod tests;
