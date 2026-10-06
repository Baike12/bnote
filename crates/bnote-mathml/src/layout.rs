//! Geometry for the parsed MathML subset.
//!
//! Everything here is pure arithmetic against [`MathFontMetrics`]: the module
//! owns the coordinate conventions, the math-style stack, the spacing table and
//! the placement rules, and nothing else. See the crate docs for the public
//! coordinate system; internally the composition happens baseline-relative (see
//! [`Canvas`]) because every placement rule is expressed as a distance from the
//! baseline, and only [`Canvas::finish`] converts to the top-left convention.

use crate::parse::{Elem, Node};
use crate::{FontSpec, MathFontMetrics, MathItem};

/// Fraction-bar / radical-bar thickness, as a fraction of the font size.
const RULE_THICKNESS: f32 = 0.04;
/// TeX's math-axis height above the baseline, as a fraction of the font size:
/// where a fraction's bar and a vcentred table's centre sit.
const AXIS: f32 = 0.25;
/// Gap between a fraction's bar and its numerator/denominator.
const FRAC_PADDING: f32 = 0.1;
/// Thin space (TeX's 3mu = 1/6em) around binary operators and relations.
const THIN_SPACE: f32 = 0.1667;
/// Gap between a base and its scripts.
const SCRIPT_GAP: f32 = 0.05;
/// How far a superscript's baseline is raised above the base's baseline.
const SUP_SHIFT: f32 = 0.45;
/// How far a subscript's baseline drops below the base's baseline.
const SUB_SHIFT: f32 = 0.15;
/// Clearance between a base and an accent or a display-style limit.
const STACK_GAP: f32 = 0.1;
/// Column gap in a table, as a fraction of the font size.
const COLUMN_GAP: f32 = 1.0;
/// Stretchy delimiters with no tall neighbour cover this much of the base size.
const DEFAULT_DELIMITER_COVER: f32 = 1.2;

/// The four math styles; the size factor each implies, and how each descends.
///
/// The factors are TeX's (10pt → 7pt → 5pt) and the descents are TeX's rules
/// 16-18 read literally: a fraction's numerator/denominator drop one style
/// (display → text → script → scriptscript) and a script drops one style from
/// display or text, reaching scriptscript from script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Level {
    Display,
    Text,
    Script,
    ScriptScript,
}

impl Level {
    pub(super) fn from_display(display: bool) -> Level {
        if display {
            Level::Display
        } else {
            Level::Text
        }
    }

    fn scale(self) -> f32 {
        match self {
            Level::Display | Level::Text => 1.0,
            Level::Script => 0.7,
            Level::ScriptScript => 0.5,
        }
    }

    /// The style a script is set in.
    fn script(self) -> Level {
        match self {
            Level::Display | Level::Text => Level::Script,
            Level::Script | Level::ScriptScript => Level::ScriptScript,
        }
    }

    /// The style a fraction's numerator and denominator are set in.
    fn frac_child(self) -> Level {
        match self {
            Level::Display => Level::Text,
            Level::Text => Level::Script,
            Level::Script | Level::ScriptScript => Level::ScriptScript,
        }
    }

    fn index(self) -> usize {
        match self {
            Level::Display => 0,
            Level::Text => 1,
            Level::Script => 2,
            Level::ScriptScript => 3,
        }
    }

    fn at(index: i32) -> Level {
        match index.clamp(0, 3) {
            0 => Level::Display,
            1 => Level::Text,
            2 => Level::Script,
            _ => Level::ScriptScript,
        }
    }

    pub(super) fn size(self, base_size: f32) -> f32 {
        self.scale() * base_size
    }
}

/// The `mathvariant` a token carries, narrowed to what the renderer can honour.
///
/// `double-struck`, `script`, `fraktur`, sans-serif and monospace have no font
/// in the renderer; they are set upright rather than rejected, so `\mathbb{R}`
/// renders as `R` instead of dropping the whole formula.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum Variant {
    /// Nothing declared: `mi` letters are italic, everything else upright.
    #[default]
    Auto,
    Normal,
    Bold,
    Italic,
    BoldItalic,
}

impl Variant {
    fn from_attr(value: &str) -> Variant {
        match value {
            "bold" => Variant::Bold,
            "italic" => Variant::Italic,
            "bold-italic" => Variant::BoldItalic,
            _ => Variant::Normal,
        }
    }

    fn bold(self) -> bool {
        matches!(self, Variant::Bold | Variant::BoldItalic)
    }
}

/// The math style at a point in the tree: the current level plus any inherited
/// `mathvariant` (from an enclosing `mstyle`).
#[derive(Clone, Copy, Debug)]
pub(super) struct Style {
    level: Level,
    variant: Variant,
}

impl Style {
    pub(super) fn new(display: bool) -> Style {
        Style {
            level: Level::from_display(display),
            variant: Variant::Auto,
        }
    }

    fn with_level(self, level: Level) -> Style {
        Style { level, ..self }
    }

    fn size(self, env: &Env) -> f32 {
        self.level.size(env.base_size)
    }
}

/// What the layout needs besides the tree.
pub(super) struct Env<'a> {
    pub(super) metrics: &'a dyn MathFontMetrics,
    pub(super) base_size: f32,
}

/// A laid-out subtree in its own space: top-left origin, baseline at `a`.
pub(super) struct Bx {
    w: f32,
    a: f32,
    d: f32,
    items: Vec<MathItem>,
}

impl Bx {
    fn empty() -> Bx {
        Bx {
            w: 0.0,
            a: 0.0,
            d: 0.0,
            items: Vec::new(),
        }
    }

    fn height(&self) -> f32 {
        self.a + self.d
    }
}

/// Collects placed content in coordinates relative to the *enclosing baseline*
/// (`y` grows downward, so anything above the baseline is negative).
///
/// Placing children by baseline and letting the union of what was actually put
/// down decide `ascent`/`descent` keeps the box consistent with the items: a
/// stretched delimiter or a raised index grows the box instead of clipping,
/// because nothing tracks the extent twice.
struct Canvas {
    items: Vec<MathItem>,
    top: f32,
    bottom: f32,
    right: f32,
}

impl Canvas {
    fn new() -> Canvas {
        Canvas {
            items: Vec::new(),
            top: 0.0,
            bottom: 0.0,
            right: 0.0,
        }
    }

    /// Places `b` with its left edge at `x` and its own baseline at `baseline`.
    fn place(&mut self, b: &Bx, x: f32, baseline: f32) {
        let top = baseline - b.a;
        for item in &b.items {
            let mut item = item.clone();
            match &mut item {
                MathItem::Run {
                    x: ix,
                    baseline: ib,
                    ..
                } => {
                    *ix += x;
                    *ib += top;
                }
                MathItem::Rule { x: rx, y, .. } => {
                    *rx += x;
                    *y += top;
                }
            }
            self.items.push(item);
        }
        self.top = self.top.min(top);
        self.bottom = self.bottom.max(baseline + b.d);
        self.right = self.right.max(x + b.w);
    }

    fn rule(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.items.push(MathItem::Rule { x, y, w, h });
        self.top = self.top.min(y);
        self.bottom = self.bottom.max(y + h);
        self.right = self.right.max(x + w);
    }

    fn finish(mut self) -> Bx {
        let a = -self.top;
        for item in &mut self.items {
            match item {
                MathItem::Run { baseline, .. } => *baseline += a,
                MathItem::Rule { y, .. } => *y += a,
            }
        }
        Bx {
            w: self.right.max(0.0),
            a: a.max(0.0),
            d: self.bottom.max(0.0),
            items: self.items,
        }
    }
}

/// The style a token element is set in. `Auto` is the MathML rule: a
/// single-letter identifier is italic, multi-character ones (`sin`, `lim`) are
/// upright, and everything else is upright.
fn token_spec(text: &str, variant: Variant, size: f32) -> FontSpec {
    let italic = match variant {
        Variant::Auto => {
            let mut chars = text.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => c.is_alphabetic(),
                _ => false,
            }
        }
        Variant::Italic | Variant::BoldItalic => true,
        Variant::Normal | Variant::Bold => false,
    };
    FontSpec {
        size,
        italic,
        bold: variant.bold(),
    }
}

/// The variant of a token: its own `mathvariant`, else what it inherits.
fn token_variant(node: &Node, st: Style) -> Variant {
    match node.variant_attr() {
        Some(value) => Variant::from_attr(value),
        None => st.variant,
    }
}

/// A box holding one shaped run. Empty text produces an empty box: an
/// `<mo></mo>` is how `latex2mathml` writes `\right.`'s absent delimiter.
fn run_box(text: &str, spec: FontSpec, env: &Env) -> Bx {
    if text.is_empty() {
        return Bx::empty();
    }
    let measured = env.metrics.measure(text, spec);
    Bx {
        w: measured.width,
        a: measured.ascent,
        d: measured.descent,
        items: vec![MathItem::Run {
            x: 0.0,
            baseline: measured.ascent,
            text: text.to_string(),
            spec,
        }],
    }
}

/// How an atom spaces against its neighbours (TeX's class table, narrowed to the
/// three cases the emitted operators need).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MoClass {
    Binary,
    Relation,
    Ordinary,
}

/// Characters TeX classes as relations (class 3).
const RELATIONS: &str = "=<>≤≥≠≈≅≡∼≃≂≺≻≼≽⊂⊃⊆⊇⊊⊋∈∋∉∣∥⊥⊢⊨⊩≪≫∝≐≑≒≓≍≎≏≦≧≨≩:→←↔⇒⇐⇔↦↗↘↖↙";
/// Characters TeX classes as binary operators (class 2).
const BINARIES: &str = "+−-±∓×÷·⋅∗∘∙∪∩∧∨⊕⊖⊗⊘⊙⊚⊛∖⋆⋄△▽†‡≀∔∸*";

/// The spacing class of a single character, whichever element carries it.
fn symbol_class(c: char) -> MoClass {
    if RELATIONS.contains(c) {
        MoClass::Relation
    } else if BINARIES.contains(c) {
        MoClass::Binary
    } else {
        MoClass::Ordinary
    }
}

/// The class of an element that is a single symbol.
///
/// `latex2mathml` writes its own operators as `mo`, but a symbol it does not
/// know — a literal `∋` in the source, or the replacement
/// [`crate::normalize`] substitutes for an unsupported command — arrives as an
/// upright `mi`. MathML Core gives an `mi` holding one non-alphabetic character
/// the operator spacing of that character's class, and without this the
/// substituted symbols would run into their neighbours.
fn symbol_node_class(node: &Node) -> MoClass {
    if !matches!(node.elem, Elem::Mo | Elem::Mi) {
        return MoClass::Ordinary;
    }
    // `form="prefix"/"postfix"` is what `latex2mathml` emits for `\left`/`\right`
    // delimiters: TeX gives those no spacing whatever their glyph's class is.
    if node.attr("form").is_some() {
        return MoClass::Ordinary;
    }
    let mut chars = node.text.trim().chars();
    match (chars.next(), chars.next()) {
        // An identifier letter is an ordinary atom (an italic `x` never spaces).
        (Some(c), None) if !c.is_alphabetic() => symbol_class(c),
        _ => MoClass::Ordinary,
    }
}

/// The thin space an element demands on either side; zero for everything that
/// is not a binary operator or a relation (`(`, `)`, `|`, `!`, `,`, `∑` and the
/// rest of the ordinary atoms).
fn spacing(node: &Node, size: f32) -> f32 {
    match symbol_node_class(node) {
        MoClass::Binary | MoClass::Relation => THIN_SPACE * size,
        MoClass::Ordinary => 0.0,
    }
}

/// A delimiter whose glyph must be stretched to cover its neighbour.
fn is_stretchy_delimiter(node: &Node) -> bool {
    node.elem == Elem::Mo
        && (node.attr("stretchy") == Some("true") || node.attr("largeop").is_some())
}

/// Sizes a stretchy delimiter so its glyph covers `target`.
///
/// v1 approximation: the delimiter is a single scaled glyph, never a stack of
/// pieces, so a very tall neighbour gets a proportionally fat parenthesis; and
/// the size only ever grows from the base size, where TeX also *shrinks*
/// delimiters to the smallest size that covers the content. The run is centred
/// on the tall neighbour's vertical centre — for a fraction that is exactly the
/// bar, for a table the axis — so the usual `\left(\frac{a}{b}\right)` and
/// `\begin{pmatrix}…\end{pmatrix}` shapes land where TeX puts them.
fn delimiter(node: &Node, st: Style, env: &Env, target: f32) -> Bx {
    let text = node.text.trim();
    if text.is_empty() {
        return Bx::empty();
    }
    let size = st.size(env);
    let variant = token_variant(node, st);
    let natural = env.metrics.measure(text, token_spec(text, variant, size));
    let natural_height = natural.ascent + natural.descent;
    let scale = if natural_height > 0.0 {
        (target / natural_height).max(1.0)
    } else {
        1.0
    };
    run_box(text, token_spec(text, variant, size * scale), env)
}

/// Horizontal packing, one shared baseline.
///
/// Stretchy delimiters need the height of their tall neighbour *before* they can
/// be sized, so the row runs in two passes: everything else is laid out first to
/// find the tallest child, then the delimiters are laid out against it. The
/// second pass reuses the already-computed boxes, so each child is measured once.
fn row(children: &[Node], st: Style, env: &Env) -> Option<Bx> {
    let size = st.size(env);
    let mut boxes: Vec<Option<Bx>> = Vec::with_capacity(children.len());
    let mut tallest: Option<(f32, f32, f32)> = None;
    for child in children {
        if is_stretchy_delimiter(child) {
            boxes.push(None);
            continue;
        }
        let b = layout_elem(child, st, env)?;
        if tallest.is_none_or(|(height, _, _)| b.height() > height) {
            tallest = Some((b.height(), b.a, b.d));
        }
        boxes.push(Some(b));
    }
    let target = tallest.map_or(DEFAULT_DELIMITER_COVER * size, |(height, _, _)| height);
    // The tall child is baseline-aligned, so its centre sits here.
    let target_centre = tallest.map_or(0.0, |(_, a, d)| (d - a) / 2.0);

    let mut canvas = Canvas::new();
    let mut x = 0.0;
    let mut pending: f32 = 0.0;
    let mut first = true;
    for (child, b) in children.iter().zip(boxes) {
        let stretchy = is_stretchy_delimiter(child);
        let b = match b {
            Some(b) => b,
            None => delimiter(child, st, env, target),
        };
        let gap = if first {
            0.0
        } else {
            pending.max(spacing(child, size))
        };
        x += gap;
        // A delimiter is centred on the tall neighbour instead of the baseline.
        let baseline = if stretchy {
            target_centre - (b.d - b.a) / 2.0
        } else {
            0.0
        };
        canvas.place(&b, x, baseline);
        x += b.w;
        pending = spacing(child, size);
        first = false;
    }
    Some(canvas.finish())
}

/// Fraction: numerator over denominator, split by a rule that sits on the math
/// axis so a run of fractions shares one bar line.
fn frac(node: &Node, st: Style, env: &Env) -> Option<Bx> {
    if node.children.len() != 2 {
        return None;
    }
    let size = st.size(env);
    let child_style = st.with_level(st.level.frac_child());
    let num = layout_elem(&node.children[0], child_style, env)?;
    let den = layout_elem(&node.children[1], child_style, env)?;

    let thickness = line_thickness(node, size);
    let padding = FRAC_PADDING * size;
    let axis = AXIS * size;
    let width = num.w.max(den.w);

    let mut canvas = Canvas::new();
    canvas.place(
        &num,
        (width - num.w) / 2.0,
        -(axis + thickness / 2.0 + padding + num.d),
    );
    if thickness > 0.0 {
        canvas.rule(0.0, -(axis + thickness / 2.0), width, thickness);
    }
    canvas.place(
        &den,
        (width - den.w) / 2.0,
        -axis + thickness / 2.0 + padding + den.a,
    );
    Some(canvas.finish())
}

/// `linethickness`, in px: absent → the default rule; `0` (what `\binom` emits)
/// → no rule; the named widths → a fraction of the font size; a numeric value
/// with a unit → that length. An unparsable value falls back to the default
/// rather than dropping the formula.
fn line_thickness(node: &Node, size: f32) -> f32 {
    let Some(value) = node.attr("linethickness") else {
        return RULE_THICKNESS * size;
    };
    match value.trim() {
        "thin" => 0.02 * size,
        "medium" => RULE_THICKNESS * size,
        "thick" => 0.06 * size,
        other => parse_length(other, size).unwrap_or(RULE_THICKNESS * size),
    }
}

/// A length attribute value, in px. Unitless values are px (CSS), `em`/`ex`
/// resolve against the current font size.
fn parse_length(value: &str, size: f32) -> Option<f32> {
    let value = value.trim();
    let parsed = if let Some(em) = value.strip_suffix("em") {
        em.trim().parse::<f32>().ok().map(|n| n * size)
    } else if let Some(ex) = value.strip_suffix("ex") {
        ex.trim().parse::<f32>().ok().map(|n| n * size * 0.5)
    } else if let Some(px) = value.strip_suffix("px") {
        px.trim().parse::<f32>().ok()
    } else {
        value.parse::<f32>().ok()
    };
    parsed.filter(|n| n.is_finite())
}

/// `mspace`: a horizontal advance and nothing to paint. A negative width (TeX's
/// `\!`) is honoured, so the following atoms overlap the previous one.
fn mspace(node: &Node, st: Style, env: &Env) -> Option<Bx> {
    let width = parse_length(node.attr("width")?, st.size(env))?;
    Some(Bx {
        w: width,
        ..Bx::empty()
    })
}

/// Superscript and/or subscript to the right of the base, at script size. An
/// `msubsup`'s two scripts share one left edge, which is what TeX does for the
/// `\int_0^1` shape.
fn scripts(node: &Node, st: Style, env: &Env) -> Option<Bx> {
    // MathML's child order is base, *sub*, sup for `msubsup`, whichever order
    // the TeX scripts were written in.
    let (sub_index, sup_index) = match node.elem {
        Elem::Msub => (Some(1), None),
        Elem::Msup => (None, Some(1)),
        Elem::Msubsup => (Some(1), Some(2)),
        _ => return None,
    };
    let expected = 1 + usize::from(sub_index.is_some()) + usize::from(sup_index.is_some());
    if node.children.len() != expected {
        return None;
    }
    let size = st.size(env);
    let script_style = st.with_level(st.level.script());

    let base_node = &node.children[0];
    let base = layout_elem(base_node, st, env)?;
    let sub_box = match sub_index {
        Some(i) => Some(layout_elem(&node.children[i], script_style, env)?),
        None => None,
    };
    let sup_box = match sup_index {
        Some(i) => Some(layout_elem(&node.children[i], script_style, env)?),
        None => None,
    };

    let gap = SCRIPT_GAP * size;
    let mut canvas = Canvas::new();
    canvas.place(&base, 0.0, 0.0);
    if let Some(b) = &sup_box {
        // TeX raises the superscript of a single character to the font's
        // x-height, and puts the superscript of anything bigger (a fraction, a
        // radical, a delimited group) on top of the nucleus instead — a flat
        // x-height raise would drop it inside such a nucleus.
        let simple_nucleus = matches!(base_node.elem, Elem::Mi | Elem::Mn | Elem::Mo);
        let shift = if simple_nucleus {
            SUP_SHIFT * size
        } else {
            base.a
        };
        canvas.place(b, base.w + gap, -shift);
    }
    if let Some(b) = &sub_box {
        canvas.place(b, base.w + gap, SUB_SHIFT * size);
    }
    Some(canvas.finish())
}

/// An optional child: `None` when it is absent, and a failed layout of a present
/// child still aborts the whole formula.
fn optional_box(node: Option<&Node>, st: Style, env: &Env) -> Option<Option<Bx>> {
    match node {
        Some(node) => Some(Some(layout_elem(node, st, env)?)),
        None => Some(None),
    }
}

/// `mover`/`munder`/`munderover`.
///
/// Three cases, in this order:
///
/// * an accent (`accent="true"` on the over-child) is a small mark stacked above
///   the base, in any style — `\hat`, `\vec`, `\bar`;
/// * a limit in display style stacks centred above/below the base — `\sum`,
///   `\lim`;
/// * a limit in text style goes to the side like a script, which is what TeX
///   does with `\sum` inline, and what `\int` does in every style (it emits
///   `msubsup` and so never reaches this function).
fn stack(node: &Node, st: Style, env: &Env) -> Option<Bx> {
    let (over, under) = match node.elem {
        Elem::Mover => (true, false),
        Elem::Munder => (false, true),
        Elem::Munderover => (true, true),
        _ => return None,
    };
    let expected = 1 + usize::from(over) + usize::from(under);
    if node.children.len() != expected {
        return None;
    }
    let size = st.size(env);
    let script_style = st.with_level(st.level.script());
    let base = layout_elem(&node.children[0], st, env)?;

    // MathML orders the children base, under, over — so `munderover`'s second
    // child is the *lower* limit, which is what `\sum_{i=1}^{n}` puts first.
    let under_node = if under { Some(&node.children[1]) } else { None };
    let over_node = if over {
        Some(&node.children[if under { 2 } else { 1 }])
    } else {
        None
    };
    let accent = over_node.is_some_and(|n| n.attr("accent") == Some("true"));

    if !accent && st.level != Level::Display {
        // Text style: side scripts.
        let over_box = optional_box(over_node, script_style, env)?;
        let under_box = optional_box(under_node, script_style, env)?;
        let gap = SCRIPT_GAP * size;
        let mut canvas = Canvas::new();
        canvas.place(&base, 0.0, 0.0);
        if let Some(b) = &over_box {
            canvas.place(b, base.w + gap, -SUP_SHIFT * size);
        }
        if let Some(b) = &under_box {
            canvas.place(b, base.w + gap, SUB_SHIFT * size);
        }
        return Some(canvas.finish());
    }

    // An accent keeps its own size; a display limit is a script.
    let mark_style = if accent { st } else { script_style };
    let over_box = optional_box(over_node, mark_style, env)?;
    let under_box = optional_box(under_node, mark_style, env)?;

    // Stacked marks are centred on the base, so the widest of the three sets the
    // box width.
    let over_w = over_box.as_ref().map_or(0.0, |b| b.w);
    let under_w = under_box.as_ref().map_or(0.0, |b| b.w);
    let width = base.w.max(over_w).max(under_w);

    let mut canvas = Canvas::new();
    canvas.place(&base, (width - base.w) / 2.0, 0.0);
    if let Some(b) = &over_box {
        canvas.place(b, (width - b.w) / 2.0, -(base.a + STACK_GAP * size));
    }
    if let Some(b) = &under_box {
        canvas.place(b, (width - b.w) / 2.0, base.d + STACK_GAP * size);
    }
    Some(canvas.finish())
}

/// Radical: the content with a rule across its top and a "√" hook to the left of
/// it; `mroot` adds the index at the upper-left in script size.
///
/// v1 approximation: the hook is one glyph at the current size, never stretched,
/// so a tall radicand gets a normal-sized check mark next to a bar that covers
/// the full width; and the overbar's height does not grow with the radicand
/// either, exactly like TeX's `\sqrt` between sizes.
fn radical(node: &Node, st: Style, env: &Env) -> Option<Bx> {
    // `\sqrt` emits one child (an `mrow` when the radicand is not a single
    // atom); `\sqrt[3]` emits the radicand then the index.
    let indexed = node.elem == Elem::Mroot;
    let expected = if indexed { 2 } else { 1 };
    if node.children.len() < expected {
        return None;
    }
    let size = st.size(env);
    let inner = if indexed || node.children.len() == 1 {
        layout_elem(&node.children[0], st, env)?
    } else {
        // Tolerate a bare sequence of children, which MathML also allows.
        row(&node.children, st, env)?
    };
    let index_box = if indexed {
        Some(layout_elem(
            &node.children[1],
            st.with_level(st.level.script()),
            env,
        )?)
    } else {
        None
    };

    let thickness = RULE_THICKNESS * size;
    let bar_top = -(inner.a + thickness);
    let hook = run_box(
        "√",
        FontSpec {
            size,
            italic: false,
            bold: st.variant.bold(),
        },
        env,
    );

    let mut canvas = Canvas::new();
    // The index sits up-left of the bar, its baseline on the bar's top edge.
    let index_w = index_box.as_ref().map_or(0.0, |b| b.w);
    if let Some(b) = &index_box {
        canvas.place(b, 0.0, bar_top);
    }
    canvas.place(&hook, index_w, 0.0);
    canvas.rule(index_w + hook.w, bar_top, inner.w, thickness);
    canvas.place(&inner, index_w + hook.w, 0.0);
    Some(canvas.finish())
}

/// Table (only `matrix`/`pmatrix`/`bmatrix` reach here).
///
/// Cells are left-aligned in their column and vertically centred in their row
/// (TeX's `\vcenter`): a row is as tall as its tallest cell and every cell's
/// own vertical centre lies on the row's axis, which is what makes a cell with a
/// fraction line up with one that is a plain letter.
fn table(node: &Node, st: Style, env: &Env) -> Option<Bx> {
    let size = st.size(env);
    let mut rows: Vec<Vec<Bx>> = Vec::new();
    for row_node in &node.children {
        if row_node.elem != Elem::Mtr {
            return None;
        }
        let mut cells = Vec::with_capacity(row_node.children.len());
        for cell in &row_node.children {
            if cell.elem != Elem::Mtd {
                return None;
            }
            // A cell's children are packed like a row (an `mtd` is an implicit
            // `mrow`), so a cell may hold several atoms without an explicit mrow.
            cells.push(row(&cell.children, st, env)?);
        }
        rows.push(cells);
    }
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    if columns == 0 {
        return Some(Bx::empty());
    }

    let mut column_width = vec![0.0f32; columns];
    let mut row_height = vec![0.0f32; rows.len()];
    for (i, cells) in rows.iter().enumerate() {
        for (j, cell) in cells.iter().enumerate() {
            column_width[j] = column_width[j].max(cell.w);
            row_height[i] = row_height[i].max(cell.height());
        }
    }

    let gap = COLUMN_GAP * size;
    let table_height: f32 = row_height.iter().sum();
    // The table's centre sits on the math axis, so it lines up with the
    // delimiters around it and with the baseline of the surrounding line.
    let top = -(AXIS * size + table_height / 2.0);

    let mut canvas = Canvas::new();
    let mut y = top;
    for (i, cells) in rows.iter().enumerate() {
        let mut x = 0.0;
        for (j, cell) in cells.iter().enumerate() {
            let cell_top = y + (row_height[i] - cell.height()) / 2.0;
            canvas.place(cell, x, cell_top + cell.a);
            x += column_width[j] + gap;
        }
        y += row_height[i];
    }
    Some(canvas.finish())
}

/// `mstyle`: `displaystyle`/`scriptlevel` set the style, `mathvariant` the
/// default variant for the tokens inside. Children pack like a row.
fn mstyle(node: &Node, st: Style, env: &Env) -> Option<Bx> {
    let mut style = st;
    if let Some(value) = node.attr("displaystyle") {
        style.level = if value == "true" {
            Level::Display
        } else {
            Level::Text
        };
    }
    if let Some(value) = node.attr("scriptlevel") {
        let step = value.trim().parse::<i32>().ok()?;
        style.level = Level::at(style.level.index() as i32 + step);
    }
    if let Some(value) = node.variant_attr() {
        style.variant = Variant::from_attr(value);
    }
    row(&node.children, style, env)
}

/// One element → one box. `None` for an unsupported shape, which aborts the
/// whole layout: a partially laid out formula would be worse than falling back
/// to the source text.
fn layout_elem(node: &Node, st: Style, env: &Env) -> Option<Bx> {
    let size = st.size(env);
    match node.elem {
        Elem::Mi => {
            let text = node.text.trim();
            let variant = token_variant(node, st);
            Some(run_box(text, token_spec(text, variant, size), env))
        }
        Elem::Mn => {
            // A number is always upright, whatever the variant says; bold still
            // applies, and so does the size the style asks for.
            let text = node.text.trim();
            let variant = token_variant(node, st);
            let spec = FontSpec {
                size,
                italic: false,
                bold: variant.bold(),
            };
            Some(run_box(text, spec, env))
        }
        Elem::Mo => {
            let text = node.text.trim();
            let variant = token_variant(node, st);
            Some(run_box(text, token_spec(text, variant, size), env))
        }
        Elem::Mtext => {
            let variant = token_variant(node, st);
            Some(run_box(
                &node.text,
                FontSpec {
                    size,
                    italic: false,
                    bold: variant.bold(),
                },
                env,
            ))
        }
        Elem::Mspace => mspace(node, st, env),
        Elem::Mrow => row(&node.children, st, env),
        Elem::Mfrac => frac(node, st, env),
        Elem::Msup | Elem::Msub | Elem::Msubsup => scripts(node, st, env),
        Elem::Mover | Elem::Munder | Elem::Munderover => stack(node, st, env),
        Elem::Msqrt | Elem::Mroot => radical(node, st, env),
        Elem::Mtable => table(node, st, env),
        Elem::Mstyle => mstyle(node, st, env),
        // Only meaningful inside their parent element, or handled by `layout`.
        Elem::Math | Elem::Mtr | Elem::Mtd => None,
    }
}

/// The whole document: the `<math>` element's children pack like a row.
fn layout_tree(tree: &Node, st: Style, env: &Env) -> Option<Bx> {
    if tree.elem != Elem::Math || tree.children.is_empty() {
        return None;
    }
    row(&tree.children, st, env)
}

/// A box → the public layout; an empty box is not worth painting, so it is a
/// fallback to the raw source as well.
fn into_layout(b: Bx) -> Option<crate::MathLayout> {
    if b.items.is_empty() {
        return None;
    }
    Some(crate::MathLayout {
        width: b.w,
        ascent: b.a,
        descent: b.d,
        items: b.items,
    })
}

/// Everything below `latex2mathml`: tree → layout → width fitting.
pub(super) fn run(
    tree: &Node,
    display: bool,
    base_size: f32,
    max_width: Option<f32>,
    metrics: &dyn MathFontMetrics,
) -> Option<crate::MathLayout> {
    let style = Style::new(display);
    let env = Env { metrics, base_size };
    let mut boxed = layout_tree(tree, style, &env)?;

    // Fit the width by shrinking the base size. Every rule in this module is a
    // multiple of the font size and the metrics contract is "same input, same
    // output", so the layout is positively homogeneous in `base_size`: the first
    // correction already lands on the target, and the remaining passes only
    // absorb a metrics implementation that is not exactly linear (hinting).
    if let Some(max_width) = max_width.filter(|w| w.is_finite() && *w > 0.0) {
        let mut size = base_size;
        for _ in 0..4 {
            if boxed.w <= max_width {
                break;
            }
            size *= (max_width / boxed.w).min(1.0);
            let env = Env {
                metrics,
                base_size: size,
            };
            boxed = layout_tree(tree, style, &env)?;
        }
    }

    into_layout(boxed)
}
