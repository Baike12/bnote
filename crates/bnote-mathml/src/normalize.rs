//! TeX the emitter cannot convert, rewritten into the spelling it can.
//!
//! `latex2mathml` 0.2.3 has a fixed command table: `\le` is not in it while
//! `\leq` is, and unsupported commands do not fail the conversion — they leave a
//! `[PARSE ERROR: Undefined("Command(\"le\")")]` marker in the document, which
//! this crate treats as a failed parse and reports as a fallback to the raw
//! source. Real notes are full of the other spellings, so they are folded into
//! the supported ones before conversion.
//!
//! # What may go in the table
//!
//! Only rewrites whose replacement produces the *same rendering*: a synonym of
//! the same glyph (`\le` → `\leq`), a command for the same symbol that the
//! emitter does support (`\neg` → `\lnot`), or a literal character where the
//! emitter passes the codepoint through (`\ni` → `∋`, which also repairs the
//! emitter's own `\ni` → `∉` mix-up). Constructs that need a semantic decision —
//! a multi-line environment, a size or style switch, a class wrapper — are
//! deliberately absent and stay unsupported; [`TESTS_OF_RECORD`] and the
//! `macro_support` integration test record the split.
//!
//! # Scope of the pass
//!
//! The scan is token-wise: it only ever reads command *names*, never touches an
//! argument, and copies everything it does not recognise verbatim. The one place
//! that is off limits is a text-mode group — `\text{...}`, and `\mbox{...}` after
//! the rewrite — because its content is literal (and because the emitter cannot
//! convert commands inside it at all: `\text{a\,b}` is a parse error).
//!
//! Text groups have a single, narrow exception: the emitter silently drops every
//! ASCII space inside one, so a space the author typed is re-emitted as U+00A0,
//! which the emitter passes through. Without it `\text{for all}` renders as
//! "forall".
//!
//! Byte lengths may change; only the MathML matters, and nothing downstream
//! maps positions back into the TeX source.

/// Commands that mean the same thing as a supported command, or as a literal
/// the emitter passes through. Each entry was verified against
/// `latex2mathml` 0.2.3's actual output; see `tests/macro_support.rs`.
const REWRITES: &[(&str, &str)] = &[
    // Relations: the emitter knows the `eq` spellings only.
    ("le", "\\leq"),
    ("ge", "\\geq"),
    // Delimiters it has no commands for.
    ("lbrace", "\\{"),
    ("rbrace", "\\}"),
    ("lbrack", "["),
    ("rbrack", "]"),
    ("lvert", "|"),
    ("rvert", "|"),
    ("vert", "|"),
    ("lVert", "\\|"),
    ("rVert", "\\|"),
    ("Vert", "\\|"),
    // Symbols with a supported synonym.
    ("neg", "\\lnot"),
    ("dots", "\\ldots"),
    ("varnothing", "\\emptyset"),
    ("gcd", "\\operatorname{gcd}"),
    ("bmod", "\\operatorname{mod}"),
    ("mod", "\\operatorname{mod}"),
    // Symbols whose only supported spelling is the literal codepoint: the
    // emitter routes a literal through `mi`, and `\ni` is worse than absent —
    // it renders the *not-in* glyph.
    ("ni", "\u{220b}"),
    ("owns", "\u{220b}"),
    ("ast", "\u{2217}"),
    // Fractions: `\frac` is the same structure; what is lost is the style hint
    // (display/text), which the emitted subset cannot express at all.
    ("dfrac", "\\frac"),
    ("tfrac", "\\frac"),
    ("cfrac", "\\frac"),
    // Spaces: `\space` is an interword space, closest to the 0.2778em `\;`.
    ("space", "\\;"),
    // Text boxes.
    ("mbox", "\\text"),
    // Fixed-size delimiters: the emitter writes them as broken markup
    // (`</mro>`), which the parser rejects, so the pair is rewritten to the
    // auto-sizing `\left`/`\right`. The bracket is the same; the size is
    // content-driven instead of one of four fixed steps.
    ("bigl", "\\left"),
    ("Bigl", "\\left"),
    ("biggl", "\\left"),
    ("Biggl", "\\left"),
    ("bigr", "\\right"),
    ("Bigr", "\\right"),
    ("biggr", "\\right"),
    ("Biggr", "\\right"),
    // The unpaired sizes have no `\left`/`\right` to pair with, and the emitter
    // knows neither `\bigg` nor `\Bigg` at all, so the size is dropped: the
    // delimiter itself (`(`, `|`, `\{`) is kept and set at the base size.
    ("big", ""),
    ("Big", ""),
    ("bigg", ""),
    ("Bigg", ""),
];

/// The constructs the probe list exercises that stay unsupported, with why. Kept
/// next to the table so a new entry has to argue with the reasons.
pub const TESTS_OF_RECORD: &[(&str, &str)] = &[
    (
        r"\begin{cases}",
        "multi-line environment; the case alignment has no equivalent in the subset",
    ),
    (
        r"\begin{aligned}",
        "multi-line environment (only `matrix`-family tables are emitted)",
    ),
    (
        r"\begin{align}",
        "multi-line; and the emitted `columnalign=left` attribute is not even well-formed XML",
    ),
    (r"\\", "a table row separator; meaningless outside an environment"),
    (
        r"\displaystyle",
        "a style switch: dropping it changes the inline size, and the subset cannot express it",
    ),
    (
        r"\textstyle",
        "a style switch (same as \\displaystyle)",
    ),
    (
        r"\limits",
        "changes an operator's limit placement, which the subset encodes only through the operator's class",
    ),
    (
        r"\nolimits",
        "same as \\limits, in the other direction",
    ),
    (
        r"\substack",
        "a stacked subscript: needs a multi-line box",
    ),
    (
        r"\phantom",
        "an invisible box of the argument's size: no equivalent in the subset",
    ),
    (r"\hspace", "an arbitrary length; only the fixed spaces are expressible"),
    (
        r"\pmod",
        "expands to a parenthesised `mod` with a leading space: a macro expansion, not a spelling",
    ),
    (
        r"\mathcal",
        "no calligraphic font in the renderer, and no supported spelling of the glyph",
    ),
    (
        r"\mathord",
        "a spacing-class wrapper around arbitrary content; the class is not expressible",
    ),
    (
        r"\mathrel",
        "a spacing-class wrapper (same as \\mathord)",
    ),
    (
        r"\mathbin",
        "a spacing-class wrapper (same as \\mathord)",
    ),
    (
        r"\text{a\,b}",
        "a command inside a text group, which the emitter cannot convert at all",
    ),
];

/// Rewrite `tex` into the spelling `latex2mathml` accepts. Pure: no state, no
/// allocation beyond the result, and identical output for identical input.
pub fn normalize(tex: &str) -> String {
    let mut out = String::with_capacity(tex.len());
    let mut rest = tex;
    let mut depth = 0usize;
    // The brace depth a text-mode group was opened at; while it is set, nothing
    // inside is rewritten.
    let mut text_group: Option<usize> = None;
    // Set between a `\text` and the `{` that opens its argument.
    let mut expecting_text = false;

    while let Some(c) = rest.chars().next() {
        match c {
            '\\' => {
                let len = command_len(rest);
                let name = &rest[1..len];
                match (text_group.is_some(), rewrite(name)) {
                    // Inside a text group nothing is rewritten — but the group's
                    // extent still has to be tracked.
                    (true, _) => {
                        out.push_str(&rest[..len]);
                    }
                    (false, Some(replacement)) => {
                        out.push_str(replacement);
                        expecting_text = replacement == "\\text";
                    }
                    (false, None) => {
                        out.push_str(&rest[..len]);
                        expecting_text = name == "text";
                    }
                }
                rest = &rest[len..];
            }
            '{' => {
                depth += 1;
                if expecting_text {
                    text_group = Some(depth);
                }
                expecting_text = false;
                out.push('{');
                rest = &rest[1..];
            }
            '}' => {
                if text_group == Some(depth) {
                    text_group = None;
                }
                depth = depth.saturating_sub(1);
                expecting_text = false;
                out.push('}');
                rest = &rest[1..];
            }
            _ => {
                // `\text {a}` is legal TeX; anything else ends the wait.
                if !c.is_whitespace() {
                    expecting_text = false;
                }
                if text_group.is_some() && c.is_ascii_whitespace() {
                    // The one exception to "text groups are literal": the
                    // emitter *drops* every ASCII space it finds in there
                    // (`\text{for all}` becomes `<mtext>forall</mtext>`), while
                    // U+00A0 survives untouched. The author's space is kept as
                    // the codepoint that survives it.
                    out.push('\u{a0}');
                } else {
                    out.push(c);
                }
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    out
}

/// The rewrite table, for callers that want to report what happened to a
/// formula and for the tests that keep it honest.
pub fn rewrites() -> &'static [(&'static str, &'static str)] {
    REWRITES
}

/// The rewrite for a command name (without the backslash), if it has one. A
/// linear scan: the table is short and the pass runs once per formula, next to a
/// full TeX parse.
fn rewrite(name: &str) -> Option<&'static str> {
    REWRITES
        .iter()
        .find(|(from, _)| *from == name)
        .map(|(_, to)| *to)
}

/// The byte length of the command starting this slice: the backslash plus its
/// letters (TeX's rule), or the bare backslash for a one-character command
/// (`\\`, `\{`, `\ `).
fn command_len(rest: &str) -> usize {
    let mut len = 1;
    for c in rest[1..].chars() {
        if c.is_ascii_alphabetic() {
            len += c.len_utf8();
        } else {
            break;
        }
    }
    len
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tex` → what `latex2mathml` makes of the rewrite. The assertion is on the
    /// rewritten *source*, so a rewrite that stops being a synonym shows up here
    /// rather than as a silent rendering change.
    #[track_caller]
    fn rewrites(from: &str, to: &str) {
        assert_eq!(normalize(from), to, "{from:?}");
    }

    #[test]
    fn unsupported_commands_become_supported_ones() {
        rewrites(r"\le", r"\leq");
        rewrites(r"\ge", r"\geq");
        rewrites(r"a \le b", r"a \leq b");
        rewrites(r"\neg p", r"\lnot p");
        rewrites(r"\dots", r"\ldots");
        rewrites(r"\varnothing", r"\emptyset");
        rewrites(r"\lbrace x \rbrace", r"\{ x \}");
        rewrites(r"\lbrack x \rbrack", r"[ x ]");
        rewrites(r"\lvert x \rvert", r"| x |");
        rewrites(r"\vert x \Vert", r"| x \|");
        rewrites(r"\lVert x \rVert", r"\| x \|");
        rewrites(r"\gcd(a, b)", r"\operatorname{gcd}(a, b)");
        rewrites(r"a \bmod n", r"a \operatorname{mod} n");
        rewrites(r"a \mod n", r"a \operatorname{mod} n");
        rewrites(r"\dfrac{1}{2}", r"\frac{1}{2}");
        rewrites(r"\tfrac{1}{2}", r"\frac{1}{2}");
        rewrites(r"\cfrac{1}{2}", r"\frac{1}{2}");
        rewrites(r"a \space b", r"a \; b");
        rewrites(r"\mbox{hi}", r"\text{hi}");
    }

    #[test]
    fn glyph_aliases_that_only_a_literal_can_spell() {
        // `\ni` renders the *not-in* glyph upstream, so the literal is both the
        // fix for an unsupported command and for a wrong one.
        rewrites(r"a \ni b", "a \u{220b} b");
        rewrites(r"a \owns b", "a \u{220b} b");
        rewrites(r"a \ast b", "a \u{2217} b");
    }

    #[test]
    fn fixed_size_delimiters_become_auto_sized_pairs() {
        rewrites(r"\bigl(x\bigr)", r"\left(x\right)");
        rewrites(r"\Bigl(x\Bigr)", r"\left(x\right)");
        rewrites(r"\biggl(x\biggr)", r"\left(x\right)");
        rewrites(r"\Biggl(x\Biggr)", r"\left(x\right)");
        rewrites(r"\biggl| x \biggr|", r"\left| x \right|");
        // Unpaired: the size goes, the delimiter stays.
        rewrites(r"\big(x\big)", r"(x)");
        rewrites(r"\Big|", r"|");
        rewrites(r"\bigg\{", r"\{");
    }

    #[test]
    fn already_supported_tex_is_untouched() {
        for tex in [
            r"\leq \geq \to \ldots \cdot \infty \sqrt[3]{x}",
            r"\frac{a}{b} \binom{n}{k} \operatorname{arg}",
            r"x^2_i + y_{ij} - \sum_{i=1}^{n} \int_0^1",
            r"\text{hi} \mathrm{d}x \mathbf{v} \mathbb{R} \hat{x} \vec{x}",
            r"\left(\frac{a}{b}\right] \begin{pmatrix}a&b\\c&d\end{pmatrix}",
            r"100\% \& \# \_ \{x\} \|x\|",
        ] {
            assert_eq!(normalize(tex), tex, "{tex:?} should pass through");
        }
    }

    #[test]
    fn text_group_content_is_literal() {
        // A command inside `\text{}` is left alone: the emitter cannot convert
        // it either way, and the content is literal text.
        rewrites(r"\text{\le}", r"\text{\le}");
        rewrites(r"\text{\mbox{x}}", r"\text{\mbox{x}}");
        // ... but the rewrite *into* a text group takes effect, and the group it
        // opens is protected from then on.
        rewrites(r"\mbox{\le}", r"\text{\le}");
        // After the group closes, rewriting resumes.
        rewrites(r"\text{x} \le y", r"\text{x} \leq y");
        // A nested group inside the text group does not end it early, and the
        // spaces in there survive as U+00A0 (see the next test).
        rewrites(
            r"\text{a {b} \le c} \ge",
            "\\text{a\u{a0}{b}\u{a0}\\le\u{a0}c} \\geq",
        );
    }

    #[test]
    fn spaces_inside_a_text_group_are_kept_as_the_codepoint_that_survives() {
        // The emitter drops ASCII whitespace inside a text group, so the only
        // way an author's space reaches the MathML is U+00A0.
        rewrites(r"\text{for all}", "\\text{for\u{a0}all}");
        rewrites(r"\mbox{a b}", "\\text{a\u{a0}b}");
        // A space that is already non-ASCII is left as it is.
        rewrites("\\text{a\u{2009}b}", "\\text{a\u{2009}b}");
        // Outside a text group, whitespace is untouched.
        rewrites(r"a b", r"a b");
    }

    #[test]
    fn rewrites_inside_math_groups() {
        rewrites(r"\sqrt{\le}", r"\sqrt{\leq}");
        rewrites(r"\frac{\le}{\ge}", r"\frac{\leq}{\geq}");
        rewrites(r"{\le}", r"{\leq}");
    }

    #[test]
    fn normalize_is_idempotent_and_total() {
        for tex in [
            r"\bigl( \le \dfrac{1}{2} \mbox{x} \ni \ast",
            r"",
            "\\",
            r"\",
            r"{{\{}",
            r"}}}",
            r"\text{",
            r"\text{a \le",
            "αβγ \\le",
            r"\le\le\le\le",
        ] {
            let once = normalize(tex);
            assert_eq!(normalize(&once), once, "{tex:?} is not idempotent");
        }
    }
}
