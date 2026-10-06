//! Which common TeX constructs the pipeline accepts, and the evidence behind
//! [`normalize`]'s rewrite table.
//!
//! Acceptance here is the *whole* pipeline: `latex2mathml` converts without a
//! `[PARSE ERROR]` marker **and** this crate's parser accepts the document it
//! produced. That second half matters — `\bigl(x\bigr)` converts "successfully"
//! into markup with a broken `</mro>` closing tag, which the parser rejects, so
//! it is unsupported even though the emitter reports no error.
//!
//! Run with `cargo test -p bnote-mathml --test macro_support -- --nocapture` to
//! print the table.

use latex2mathml::{latex_to_mathml, DisplayStyle};

/// The constructs under test: one entry per macro, with a plausible argument
/// where the command takes one.
pub const PROBE: &[&str] = &[
    // Relations and arrows.
    r"\le",
    r"\leq",
    r"\ge",
    r"\geq",
    r"\ne",
    r"\neq",
    r"a \to b",
    r"a \rightarrow b",
    r"a \leftarrow b",
    r"a \Rightarrow b",
    r"a \Leftrightarrow b",
    r"\infty",
    r"\approx",
    r"\equiv",
    r"\sim",
    r"\propto",
    r"\in",
    r"\notin",
    r"\ni",
    r"\owns",
    r"\subset",
    r"\subseteq",
    r"\supset",
    r"\supseteq",
    r"\cong",
    r"\simeq",
    r"\ll x \gg",
    r"\emptyset",
    r"\varnothing",
    // Operators.
    r"a \cdot b",
    r"a \cdots b",
    r"a \ldots b",
    r"a \times b",
    r"a \div b",
    r"\pm",
    r"\mp",
    r"a \cup b",
    r"a \cap b",
    r"a \wedge b",
    r"a \vee b",
    r"\forall x",
    r"\exists x",
    r"\nabla",
    r"\partial",
    r"\ast",
    r"a \star b",
    r"a \circ b",
    r"a \oplus b",
    r"a \setminus b",
    r"a \mid b",
    r"\neg p",
    r"\lnot p",
    r"a \bmod n",
    r"a \mod n",
    r"\pmod{n}",
    // Big operators and functions.
    r"\sum_{i=1}^{n}",
    r"\prod_{i=1}^{n}",
    r"\int_0^1",
    r"\iint",
    r"\oint",
    r"\lim_{x\to 0}",
    r"\log x",
    r"\ln x",
    r"\sin x",
    r"\cos x",
    r"\tan x",
    r"\exp x",
    r"\max x",
    r"\min x",
    r"\arg x",
    r"\det A",
    r"\gcd(a,b)",
    // Letters.
    r"\alpha",
    r"\beta",
    r"\Gamma",
    r"\Delta",
    r"\Omega",
    r"\phi",
    r"\varphi",
    r"\epsilon",
    r"\varepsilon",
    r"\theta",
    r"\lambda",
    r"\mu",
    r"\pi",
    r"\rho",
    r"\sigma",
    r"\tau",
    r"\omega",
    r"\ell",
    r"\hbar",
    r"\aleph",
    // Accents and decorations.
    r"\hat{x}",
    r"\bar{x}",
    r"\vec{x}",
    r"\tilde{x}",
    r"\dot{x}",
    r"\ddot{x}",
    r"\overline{AB}",
    r"\underline{x}",
    r"\overbrace{x}",
    r"\underbrace{x}",
    r"\overset{!}{=}",
    r"\underset{a}{b}",
    // Fonts, text and class wrappers.
    r"\text{hi}",
    r"\text{a\,b}",
    r"\mbox{hi}",
    r"\mathrm{d}",
    r"\mathbf{v}",
    r"\mathit{v}",
    r"\mathbb{R}",
    r"\mathcal{L}",
    r"\boldsymbol{\alpha}",
    r"\operatorname{arg}",
    r"\mathord{x}",
    r"\mathrel{=}",
    r"\mathbin{+}",
    // Delimiters.
    r"\left(x\right)",
    r"\left. x \right|",
    r"\big(x\big)",
    r"\Big(x\Big)",
    r"\bigl(x\bigr)",
    r"\Bigl(x\Bigr)",
    r"\biggl(x\biggr)",
    r"\Bigg(x\Bigg)",
    r"\lvert x \rvert",
    r"\lVert x \rVert",
    r"\vert x \Vert",
    r"\lbrace x \rbrace",
    r"\lbrack x \rbrack",
    r"\langle x \rangle",
    r"\lfloor x \rfloor",
    r"\lceil x \rceil",
    // Spaces.
    r"\dots",
    r"\space",
    r"a \quad b",
    r"a \qquad b",
    r"a\,b",
    r"a\;b",
    r"a\:b",
    r"a\!b",
    r"\hspace{1em}",
    // Environments and structures.
    r"\begin{cases} a & b \end{cases}",
    r"\begin{aligned} a & b \end{aligned}",
    r"\begin{align} a & b \end{align}",
    r"\begin{pmatrix} a & b \end{pmatrix}",
    r"\begin{bmatrix} a & b \end{bmatrix}",
    r"\begin{vmatrix} a & b \end{vmatrix}",
    r"\begin{matrix} a & b \end{matrix}",
    r"\binom{n}{k}",
    r"\dfrac{a}{b}",
    r"\tfrac{a}{b}",
    r"\cfrac{a}{b}",
    r"\frac{a}{b}",
    r"\sqrt[3]{x}",
    r"\substack{a\\b}",
    r"\phantom{x}",
    r"\displaystyle\sum_{i=1}^n",
    r"\textstyle\sum_{i=1}^n",
    r"\sum\limits_{i=1}^n",
    r"\sum\nolimits_{i=1}^n",
    // Escapes and line breaks.
    r"\\",
    r"\%",
    r"\&",
    r"\#",
    r"\_",
    r"\{",
    r"\}",
    r"\|",
];

/// What the pipeline does with a construct.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    /// Converted and parsed.
    Ok,
    /// Converted, but with a `[PARSE ERROR: …]` marker inside.
    Marker,
    /// Converted into markup the parser rejects (a broken tag, an unquoted
    /// attribute): `latex2mathml` reports no error at all here.
    Malformed,
    /// `latex_to_mathml` returned `Err`.
    Error,
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Status::Ok => write!(f, "ok"),
            Status::Marker => write!(f, "marker"),
            Status::Malformed => write!(f, "malformed"),
            Status::Error => write!(f, "err"),
        }
    }
}

/// The pipeline's verdict on `tex`, before any normalization.
pub fn status(tex: &str) -> Status {
    match latex_to_mathml(tex, DisplayStyle::Inline) {
        Err(_) => Status::Error,
        Ok(doc) if doc.contains("[PARSE ERROR") => Status::Marker,
        Ok(doc) if bnote_mathml::parse::parse_mathml(&doc).is_none() => Status::Malformed,
        Ok(_) => Status::Ok,
    }
}

/// The same verdict after [`bnote_mathml::normalize::normalize`].
pub fn normalized_status(tex: &str) -> Status {
    status(&bnote_mathml::normalize::normalize(tex))
}

/// The constructs that do not render as written, with the verdict. Everything
/// else in [`PROBE`] renders today.
pub const UNSUPPORTED: &[(&str, Status)] = &[
    (r"\le", Status::Marker),
    (r"\ge", Status::Marker),
    (r"\gcd(a,b)", Status::Marker),
    (r"\ast", Status::Marker),
    (r"\neg p", Status::Marker),
    (r"\varnothing", Status::Marker),
    (r"\lvert x \rvert", Status::Marker),
    (r"\lVert x \rVert", Status::Marker),
    (r"\vert x \Vert", Status::Marker),
    (r"\lbrace x \rbrace", Status::Marker),
    (r"\lbrack x \rbrack", Status::Marker),
    (r"a \bmod n", Status::Marker),
    (r"a \mod n", Status::Marker),
    (r"\owns", Status::Marker),
    (r"\pmod{n}", Status::Marker),
    (r"\dots", Status::Marker),
    (r"\space", Status::Marker),
    (r"\hspace{1em}", Status::Marker),
    (r"\mbox{hi}", Status::Marker),
    (r"\text{a\,b}", Status::Marker),
    (r"\mathcal{L}", Status::Marker),
    (r"\mathord{x}", Status::Marker),
    (r"\mathrel{=}", Status::Marker),
    (r"\mathbin{+}", Status::Marker),
    (r"\dfrac{a}{b}", Status::Marker),
    (r"\tfrac{a}{b}", Status::Marker),
    (r"\cfrac{a}{b}", Status::Marker),
    (r"\substack{a\\b}", Status::Marker),
    (r"\phantom{x}", Status::Marker),
    (r"\displaystyle\sum_{i=1}^n", Status::Marker),
    (r"\textstyle\sum_{i=1}^n", Status::Marker),
    (r"\sum\limits_{i=1}^n", Status::Marker),
    (r"\sum\nolimits_{i=1}^n", Status::Marker),
    (r"\\", Status::Marker),
    (r"\big(x\big)", Status::Marker),
    (r"\Big(x\Big)", Status::Marker),
    (r"\Bigg(x\Bigg)", Status::Marker),
    (r"\bigl(x\bigr)", Status::Malformed),
    (r"\Bigl(x\Bigr)", Status::Malformed),
    (r"\biggl(x\biggr)", Status::Malformed),
    (r"\begin{cases} a & b \end{cases}", Status::Error),
    (r"\begin{aligned} a & b \end{aligned}", Status::Error),
    (r"\begin{align} a & b \end{align}", Status::Malformed),
];

/// The constructs the normalizer rewrites, as the probe list spells them.
pub const REWRITTEN: &[&str] = &[
    r"\le",
    r"\ge",
    r"\gcd(a,b)",
    r"\owns",
    r"\ast",
    r"\neg p",
    r"\varnothing",
    r"\owns",
    r"\lvert x \rvert",
    r"\lVert x \rVert",
    r"\vert x \Vert",
    r"\lbrace x \rbrace",
    r"\lbrack x \rbrack",
    r"a \bmod n",
    r"a \mod n",
    r"\dots",
    r"\space",
    r"\mbox{hi}",
    r"\dfrac{a}{b}",
    r"\tfrac{a}{b}",
    r"\cfrac{a}{b}",
    r"\big(x\big)",
    r"\Big(x\Big)",
    r"\bigl(x\bigr)",
    r"\Bigl(x\Bigr)",
    r"\biggl(x\biggr)",
    r"\Bigg(x\Bigg)",
];

#[test]
fn the_unsupported_set_is_what_the_normaliser_assumes() {
    let mut wrong = Vec::new();
    for (tex, expected) in UNSUPPORTED {
        let actual = status(tex);
        if actual != *expected {
            wrong.push(format!("{tex:?}: expected {expected}, got {actual}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "latex2mathml 0.2.3 changed, update the normaliser's table:\n{}",
        wrong.join("\n")
    );
}

#[test]
fn everything_else_in_the_probe_list_renders() {
    let unsupported: Vec<&str> = UNSUPPORTED.iter().map(|(tex, _)| *tex).collect();
    let mut broken = Vec::new();
    for tex in PROBE {
        if unsupported.contains(tex) {
            continue;
        }
        let actual = status(tex);
        if actual != Status::Ok {
            broken.push(format!("{tex:?}: {actual}"));
        }
    }
    assert!(
        broken.is_empty(),
        "{} probe constructs are not covered by the table:\n{}",
        broken.len(),
        broken.join("\n")
    );
}

#[test]
fn normalization_moves_what_it_claims_to_move() {
    let mut stuck = Vec::new();
    for tex in REWRITTEN {
        let actual = normalized_status(tex);
        if actual != Status::Ok {
            stuck.push(format!(
                "{tex:?}: {actual} after {}",
                bnote_mathml::normalize::normalize(tex)
            ));
        }
    }
    assert!(
        stuck.is_empty(),
        "rewrites that do not help:\n{}",
        stuck.join("\n")
    );
}

#[test]
fn every_rewrite_is_for_a_construct_that_needed_one() {
    // A dead entry (one whose source already renders) would be churn in every
    // formula, so each is checked against the bare command. `\ni` is the one
    // deliberate exception: it renders today, but with the *not-in* glyph.
    const ALREADY_RENDERS_BUT_WRONG: &[&str] = &["ni"];
    let mut dead = Vec::new();
    for (from, _) in bnote_mathml::normalize::rewrites() {
        if ALREADY_RENDERS_BUT_WRONG.contains(from) {
            continue;
        }
        let bare = format!(r"\{from}");
        if status(&bare) == Status::Ok {
            dead.push(bare);
        }
    }
    assert!(dead.is_empty(), "these already render, drop them: {dead:?}");
}

#[test]
fn print_the_probe_table() {
    for tex in PROBE {
        let status = status(tex);
        let detail = match latex_to_mathml(tex, DisplayStyle::Inline) {
            Ok(doc) if doc.contains("[PARSE ERROR") => {
                let start = doc.find("[PARSE ERROR").unwrap_or(0);
                let end = doc[start..].find(']').map_or(doc.len(), |i| start + i + 1);
                doc[start..end].to_string()
            }
            Err(e) => format!("{e:?}"),
            Ok(doc) if bnote_mathml::parse::parse_mathml(&doc).is_none() => {
                String::from("parser rejects the emitted markup")
            }
            Ok(_) => String::new(),
        };
        println!("{status:>9}  {tex:<38} {detail}");
    }
}
