//! The MathML `latex2mathml` 0.2.3 emits, pinned as documentation.
//!
//! These assertions are not about this crate's layout: they record the *input
//! format* the parser and the layout are written against, so that a dependency
//! bump that changes the emitted shape fails here instead of silently
//! mis-rendering formulas. Several entries are upstream quirks that the layout
//! has to live with; they are marked as such.
//!
//! `cargo test -p bnote-mathml --test probe -- --nocapture` prints every case
//! with its raw output, which is how this file was written.

use latex2mathml::{latex_to_mathml, DisplayStyle};

fn inline(tex: &str) -> String {
    latex_to_mathml(tex, DisplayStyle::Inline).expect("inline conversion")
}

fn block(tex: &str) -> String {
    latex_to_mathml(tex, DisplayStyle::Block).expect("block conversion")
}

/// A document without its root element, for comparing inline against block.
fn body(doc: &str) -> &str {
    let start = doc.find('>').expect("root open tag") + 1;
    let end = doc.rfind("</math>").expect("root close tag");
    &doc[start..end]
}

/// The elements and attributes seen in the emitted documents, as a checklist
/// against the parser's `Elem` set and the layout's attribute reads.
#[test]
fn the_emitted_element_set_is_closed() {
    let docs = [
        inline("x"),                                     // math, mi
        inline("1"),                                     // mn
        inline(r"a+b"),                                  // mo
        inline(r"x^2"),                                  // msup
        inline(r"\log_2 x"),                             // msub
        inline(r"\int_0^1 f"),                           // msubsup
        inline(r"\hat{x}"),                              // mover
        inline(r"\underline{x}"),                        // munder
        inline(r"\sum_{i=1}^{n} i"),                     // munderover
        inline(r"\sqrt{x}"),                             // msqrt
        inline(r"\sqrt[3]{x}"),                          // mroot
        inline(r"\frac{a}{b}"),                          // mfrac
        inline(r"\text{hi}"),                            // mtext
        inline(r"x\,y"),                                 // mspace
        inline(r"\left(\frac{a}{b}\right)"),             // mrow
        inline(r"\begin{pmatrix}a&b\\c&d\end{pmatrix}"), // mtable, mtr, mtd
        inline(r"\dbinom{a}{b}"),                        // mstyle
        inline(r"\mathbb{R}"),                           // mathvariant
        block(r"\frac{a}{b}"),                           // display="block"
    ];
    let tags = [
        "<math",
        "<mi",
        "<mn",
        "<mo",
        "<mtext",
        "<mspace",
        "<mrow",
        "<mfrac",
        "<msup",
        "<msub",
        "<msubsup",
        "<mover",
        "<munder",
        "<munderover",
        "<msqrt",
        "<mroot",
        "<mtable",
        "<mtr",
        "<mtd",
        "<mstyle",
    ];
    for tag in tags {
        assert!(
            docs.iter().any(|d| d.contains(tag)),
            "{tag} is part of the format but no fixture emits it"
        );
    }
    // Attributes the layout reads or deliberately ignores.
    for attr in [
        "xmlns=",
        "display=",
        "stretchy=",
        "form=",
        "accent=",
        "mathvariant=",
        "width=\"",
        "linethickness=",
        "displaystyle=",
    ] {
        assert!(
            docs.iter().any(|d| d.contains(attr)),
            "{attr} is part of the format but no fixture emits it"
        );
    }
}

#[test]
fn tokens_and_structure() {
    assert_eq!(
        inline("x"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>x</mi></math>"#
    );
    // A multi-letter identifier is one `mi`; the layout uprights it by length.
    assert_eq!(
        inline(r"\sin x"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>sin</mi><mi>x</mi></math>"#
    );
    // Numbers are one `mn`; a thin space is a self-closing `mspace` in em.
    assert_eq!(
        inline(r"x\,y"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>x</mi><mspace width="0.16666667em"/><mi>y</mi></math>"#
    );
    assert_eq!(
        inline(r"a+b=c"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>a</mi><mo>+</mo><mi>b</mi><mo>=</mo><mi>c</mi></math>"#
    );
    // Inline vs block only changes the root attribute; the layout takes the
    // style from the caller, and a fraction's halves are script size inline and
    // full size in display style.
    assert!(block(r"\frac{a}{b}").contains(r#"display="block""#));
    assert_eq!(
        inline(r"\frac{a}{b}"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>"#
    );
    // `\binom` is a fraction with no bar.
    assert_eq!(
        inline(r"\binom{1}{2}"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mo stretchy="true" form="prefix">(</mo><mfrac linethickness="0"><mn>1</mn><mn>2</mn></mfrac><mo stretchy="true" form="postfix">)</mo></mrow></math>"#
    );
}

#[test]
fn scripts_and_limits() {
    assert_eq!(
        inline(r"x^2"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><msup><mi>x</mi><mn>2</mn></msup></math>"#
    );
    // Quirk: `x_i^2` is emitted as `msub(x, msup(i, 2))` — the superscript ends
    // up on the subscript, not on `x`. The layout renders what it is given.
    assert_eq!(
        inline(r"x_i^2"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><msub><mi>x</mi><msup><mi>i</mi><mn>2</mn></msup></msub></math>"#
    );
    // Quirk: `\sqrt{x}^2` folds the superscript *into* the radical, so a script
    // over a radical needs `{\sqrt{x}}^2` to become an `msup`.
    assert!(inline(r"\sqrt{x}^2").contains("<msqrt><msup>"));
    assert!(inline(r"{\sqrt{x}}^2").contains("<msup><msqrt>"));
    // `\sum` becomes `munderover` in *both* styles, so display/inline placement
    // is the layout's decision, not the emitter's. `\int` becomes `msubsup` and
    // therefore always sets its limits beside the operator.
    assert_eq!(
        body(&inline(r"\sum_{i=1}^{n} i")),
        body(&block(r"\sum_{i=1}^{n} i")),
        "the same document in both styles"
    );
    assert!(inline(r"\sum_{i=1}^{n} i").contains("<munderover><mo>∑</mo>"));
    assert!(inline(r"\int_0^1 f").contains("<msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup>"));
    assert!(block(r"\lim_{x\to\infty}").contains("<munder><mi>lim</mi>"));
    assert!(inline(r"\lim_{x\to\infty}").contains("<munder><mi>lim</mi>"));
}

#[test]
fn accents_and_radicals() {
    // Accents are `mover`/`munder` with `accent="true"` on an `mo` mark.
    assert_eq!(
        inline(r"\hat{x}"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mover><mi>x</mi><mo accent="true">^</mo></mover></math>"#
    );
    assert_eq!(
        inline(r"\underline{x}"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><munder><mi>x</mi><mo accent="true">_</mo></munder></math>"#
    );
    // Quirk: `\overline` uses an ASCII underscore for its mark (U+005F), not the
    // macron `\bar` gets (U+00AF); the layout places whatever glyph is emitted.
    assert!(inline(r"\overline{AB}").contains("<mo accent=\"true\">_</mo>"));
    assert!(inline(r"\bar{x}").contains("<mo accent=\"true\">¯</mo>"));
    assert_eq!(
        inline(r"\sqrt[3]{x}"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mroot><mi>x</mi><mn>3</mn></mroot></math>"#
    );
}

#[test]
fn stretchy_delimiters_and_tables() {
    // `\left...\right` is an `mrow` of stretchy `mo`s with a `form`; `\right.`
    // is an empty `mo`, which the layout renders as a zero-width box.
    assert_eq!(
        inline(r"\left(\frac{a}{b}\right)"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mo stretchy="true" form="prefix">(</mo><mfrac><mi>a</mi><mi>b</mi></mfrac><mo stretchy="true" form="postfix">)</mo></mrow></math>"#
    );
    assert!(inline(r"\left(x\right.").contains(r#"<mo stretchy="true" form="postfix"></mo>"#));
    assert_eq!(
        inline(r"\begin{pmatrix}a&b\\c&d\end{pmatrix}"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mo stretchy="true" form="prefix">(</mo><mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable><mo stretchy="true" form="postfix">)</mo></mrow></math>"#
    );
    assert_eq!(
        inline(r"\begin{matrix}a\\b\end{matrix}"),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mtable><mtr><mtd><mi>a</mi></mtd></mtr><mtr><mtd><mi>b</mi></mtd></mtr></mtable></math>"#
    );
}

#[test]
fn mathvariant_covers_more_than_the_renderer_can_set() {
    assert!(inline(r"\mathbb{R}").contains(r#"<mi mathvariant="double-struck">R</mi>"#));
    assert!(inline(r"\mathbf{v}").contains(r#"<mi mathvariant="bold">v</mi>"#));
    assert!(inline(r"\mathrm{d}x").contains(r#"<mi mathvariant="normal">d</mi>"#));
    assert!(inline(r"\partial").contains(r#"<mo mathvariant="italic">∂</mo>"#));
    // The layout maps every unknown variant to upright rather than rejecting it.
}

#[test]
fn mstyle_only_comes_from_the_binomial_family() {
    // `\dbinom`/`\tbinom` are the only commands that emit `mstyle`, and they
    // carry the style in `displaystyle`.
    assert!(block(r"\dbinom{a}{b}").contains(r#"<mstyle displaystyle="true">"#));
    assert!(block(r"\tbinom{a}{b}").contains(r#"<mstyle displaystyle="false">"#));
    assert!(!inline(r"\binom{a}{b}").contains("mstyle"));
}

#[test]
fn unparsable_tex_is_a_marker_or_an_error() {
    // Unsupport-ed commands come back as `Ok` with a marker embedded in the
    // document, which is why the parser has to reject it.
    assert!(inline(r"1 \le 2").contains("[PARSE ERROR: Undefined"));
    assert!(inline(r"x_").contains("[PARSE ERROR"));
    assert!(inline(r"\dfrac{a}{b}").contains("[PARSE ERROR"));
    // Actually broken TeX is an `Err`.
    assert!(latex_to_mathml(r"\frac{", DisplayStyle::Inline).is_err());
    assert!(latex_to_mathml(r"\begin{unknown}", DisplayStyle::Inline).is_err());
    assert!(latex_to_mathml(r"\begin{cases}a&b\end{cases}", DisplayStyle::Inline).is_err());
    // An empty document is a valid `math` with no children.
    assert_eq!(
        inline(""),
        r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"></math>"#
    );
}

#[test]
fn two_upstream_bugs_the_layout_falls_back_from() {
    // `\bigl`-family delimiters emit a *malformed* document: the closing tag is
    // `</mro>`. The parser rejects it, so the caller paints the raw source —
    // the alternative would be guessing at a size the emitter never states.
    let broken = block(r"\Bigl(x\Bigr)");
    assert!(broken.contains("</mro>"), "{broken}");
    // Text is not XML-escaped either: `\&` emits a bare ampersand.
    assert!(inline(r"a \& b").contains("<mi mathvariant=\"normal\">&</mi>"));
}

#[test]
fn the_probe_prints_everything_for_a_dependency_bump() {
    let cases = [
        "x",
        r"\frac{a}{b}",
        r"x_i^2",
        r"\sqrt[3]{x}",
        r"\sum_{i=1}^{n} i",
        r"\lim_{x\to\infty}",
        r"\alpha",
        r"\vec{x}",
        r"\text{hi}",
        r"\left(\frac{a}{b}\right)",
        r"\begin{pmatrix}a&b\\c&d\end{pmatrix}",
        r"\log_2 x",
        r"\overline{AB}",
        r"\dbinom{a}{b}",
    ];
    for tex in cases {
        println!(
            "{tex:?}\n  inline: {}\n  block:  {}",
            inline(tex),
            block(tex)
        );
    }
}
