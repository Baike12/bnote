//! A hand-written parser for the MathML subset `latex2mathml` 0.2 emits.
//!
//! Why hand-written: the emitted markup is regular — a closed element set, only
//! `key="value"` attributes, no namespace prefixes beyond the root's `xmlns`, no
//! comments, no CDATA, and exactly one self-closing element (`mspace`). An XML
//! crate would buy nothing here.
//!
//! Two properties of the input drive the design:
//!
//! * `latex2mathml` reports *unsupported TeX* not as `Err` but by embedding
//!   `<mtext>[PARSE ERROR: ...]</mtext>` in an otherwise valid document (`\le`,
//!   `x_`, `\dfrac` all take that path). [`parse_mathml`] treats any
//!   `[PARSE ERROR` marker as a parse failure, so the caller falls back to the
//!   raw source instead of painting an error string into the note.
//! * Text is *not* XML-escaped: `\&` emits a bare `&` in an `mi`, and the error
//!   marker above is emitted raw as well. Decoding therefore tolerates a stray
//!   `&` and leaves any sequence it does not recognise untouched.
//!
//! One shape is normalised rather than reported as-is: the emitter flattens a
//! base with two scripts into a nested script pair, which
//! [`absorb_flattened_scripts`] turns back into an `msubsup` (see its docs for
//! the ambiguity that costs).

/// Element names the layout supports — the complete set `latex2mathml` 0.2.3
/// can emit (`math` plus the nineteen below; verified by probing every
/// construct the layout claims to handle).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Elem {
    /// The document root; carries `display="inline|block"`.
    Math,
    Mi,
    Mn,
    Mo,
    Mtext,
    Mspace,
    Mrow,
    Mfrac,
    Msup,
    Msub,
    Msubsup,
    Mover,
    Munder,
    Munderover,
    Msqrt,
    Mroot,
    Mtable,
    Mtr,
    Mtd,
    /// `displaystyle="true|false"`; the only element that changes the math style
    /// mid-formula.
    Mstyle,
}

impl Elem {
    /// `None` for anything outside the supported set — the caller then falls
    /// back to the raw TeX rather than guessing at an element's geometry.
    fn from_tag(tag: &str) -> Option<Elem> {
        Some(match tag {
            "math" => Elem::Math,
            "mi" => Elem::Mi,
            "mn" => Elem::Mn,
            "mo" => Elem::Mo,
            "mtext" => Elem::Mtext,
            "mspace" => Elem::Mspace,
            "mrow" => Elem::Mrow,
            "mfrac" => Elem::Mfrac,
            "msup" => Elem::Msup,
            "msub" => Elem::Msub,
            "msubsup" => Elem::Msubsup,
            "mover" => Elem::Mover,
            "munder" => Elem::Munder,
            "munderover" => Elem::Munderover,
            "msqrt" => Elem::Msqrt,
            "mroot" => Elem::Mroot,
            "mtable" => Elem::Mtable,
            "mtr" => Elem::Mtr,
            "mtd" => Elem::Mtd,
            "mstyle" => Elem::Mstyle,
            _ => return None,
        })
    }

    /// The source tag, for error messages and test assertions.
    pub fn tag(self) -> &'static str {
        match self {
            Elem::Math => "math",
            Elem::Mi => "mi",
            Elem::Mn => "mn",
            Elem::Mo => "mo",
            Elem::Mtext => "mtext",
            Elem::Mspace => "mspace",
            Elem::Mrow => "mrow",
            Elem::Mfrac => "mfrac",
            Elem::Msup => "msup",
            Elem::Msub => "msub",
            Elem::Msubsup => "msubsup",
            Elem::Mover => "mover",
            Elem::Munder => "munder",
            Elem::Munderover => "munderover",
            Elem::Msqrt => "msqrt",
            Elem::Mroot => "mroot",
            Elem::Mtable => "mtable",
            Elem::Mtr => "mtr",
            Elem::Mtd => "mtd",
            Elem::Mstyle => "mstyle",
        }
    }
}

/// One parsed element.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub elem: Elem,
    pub attrs: Vec<(String, String)>,
    /// Character data directly inside the element. Only token elements
    /// (`mi`/`mn`/`mo`/`mtext`) read it; whitespace between tags in the
    /// container elements is ignored by the layout.
    pub text: String,
    pub children: Vec<Node>,
}

impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// The `mathvariant` of this element, if it carries one.
    pub fn variant_attr(&self) -> Option<&str> {
        self.attr("mathvariant")
    }
}

/// Upper bound on nesting. The parser and the layout both recurse once per
/// level, so an unbounded document could overflow the stack on adversarial
/// input; no real formula comes near this (a 20-deep `\frac` chain is 20 levels).
const MAX_DEPTH: usize = 256;

/// Absorb how `latex2mathml` flattens a base that carries two scripts.
///
/// `x_i^2` comes out as `msub(x, msup(i, 2))` — the superscript sitting in the
/// subscript slot — and `x^2_i` as the mirror image `msup(x, msub(2, i))`. Both
/// are the emitter's spelling of "this base has a subscript and a superscript",
/// and a nested script of the *opposite* kind in a script slot has no other
/// source, so the node is rebuilt as the [`Elem::Msubsup`] the layout expects.
/// A script nested inside its own kind (`x_{i_j}` → `msub(x, msub(i, j))`) is a
/// genuine nesting and is left alone.
///
/// The cost: `x_{i^2}` is turned into the same markup as `x_i^2` by the emitter,
/// so it is read the same way. The two are indistinguishable once the tree
/// exists — no amount of care here can tell them apart — and the flat reading is
/// the common one.
fn absorb_flattened_scripts(node: Node) -> Node {
    let inner = match node.elem {
        Elem::Msub => Elem::Msup,
        Elem::Msup => Elem::Msub,
        _ => return node,
    };
    let [base, script] = node.children.as_slice() else {
        return node;
    };
    if script.elem != inner || script.children.len() != 2 {
        return node;
    }
    // `msub(x, msup(a, b))` keeps its order (`a` is the subscript); the mirror
    // `msup(x, msub(a, b))` has them the other way round.
    let (sub, sup) = if inner == Elem::Msup {
        (script.children[0].clone(), script.children[1].clone())
    } else {
        (script.children[1].clone(), script.children[0].clone())
    };
    Node {
        elem: Elem::Msubsup,
        attrs: node.attrs,
        text: node.text,
        children: vec![base.clone(), sub, sup],
    }
}

/// Parse a `latex2mathml` document.
///
/// Returns the `<math>` root, or `None` when the document is not well-formed,
/// contains an element outside [`Elem`], has unbalanced tags, or carries a
/// `[PARSE ERROR` marker (see the module docs).
pub fn parse_mathml(src: &str) -> Option<Node> {
    let mut p = Parser {
        src,
        bytes: src.as_bytes(),
        pos: 0,
        depth: 0,
    };
    let root = p.element()?;
    if root.elem != Elem::Math {
        return None;
    }
    p.skip_whitespace();
    if p.pos != p.bytes.len() {
        return None;
    }
    Some(root)
}

struct Parser<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    /// `<name attrs>` children `</name>` or `<name attrs/>`.
    fn element(&mut self) -> Option<Node> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        self.expect(b'<')?;
        let name = self.name()?;
        let elem = Elem::from_tag(name)?;
        let attrs = self.attributes()?;
        self.skip_whitespace();
        if self.eat(b'/') {
            self.expect(b'>')?;
            return Some(Node {
                elem,
                attrs,
                text: String::new(),
                children: Vec::new(),
            });
        }
        self.expect(b'>')?;

        let mut children = Vec::new();
        let mut text = String::new();
        loop {
            if self.pos >= self.bytes.len() {
                // Unclosed element.
                return None;
            }
            if self.bytes[self.pos] == b'<' {
                if self.bytes[self.pos..].starts_with(b"</") {
                    self.pos += 2;
                    let close = self.name()?;
                    if close != name {
                        return None;
                    }
                    self.skip_whitespace();
                    self.expect(b'>')?;
                    break;
                }
                self.depth += 1;
                let child = self.element()?;
                self.depth -= 1;
                children.push(child);
            } else {
                let start = self.pos;
                while self.pos < self.bytes.len() && self.bytes[self.pos] != b'<' {
                    self.pos += 1;
                }
                // Slicing at an ASCII `<' boundary is always a char boundary.
                text.push_str(&decode_entities(&self.src[start..self.pos]));
            }
        }

        if text.contains(PARSE_ERROR_MARKER) {
            return None;
        }
        Some(absorb_flattened_scripts(Node {
            elem,
            attrs,
            text,
            children,
        }))
    }

    fn name(&mut self) -> Option<&'a str> {
        let start = self.pos;
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b':' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            return None;
        }
        self.src.get(start..self.pos)
    }

    fn attributes(&mut self) -> Option<Vec<(String, String)>> {
        let mut attrs = Vec::new();
        loop {
            if !self.whitespace() {
                // The tag can only continue with an attribute, and attributes
                // are whitespace-separated in every document this parser sees.
                return self.tag_end(attrs);
            }
            if self.pos >= self.bytes.len() {
                return None;
            }
            if self.bytes[self.pos] == b'>' || self.bytes[self.pos] == b'/' {
                return Some(attrs);
            }
            let key = self.name()?.to_string();
            self.skip_whitespace();
            self.expect(b'=')?;
            self.skip_whitespace();
            self.expect(b'"')?;
            let value_start = self.pos;
            while self.pos < self.bytes.len() && self.bytes[self.pos] != b'"' {
                self.pos += 1;
            }
            let value = self.src.get(value_start..self.pos)?.to_string();
            self.expect(b'"')?;
            attrs.push((key, decode_entities(&value)));
        }
    }

    fn skip_whitespace(&mut self) {
        self.whitespace();
    }

    /// Skips whitespace, reporting whether any was there.
    fn whitespace(&mut self) -> bool {
        let start = self.pos;
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
        self.pos != start
    }

    /// The remainder of an open tag: `>` or `/>`.
    fn tag_end(&mut self, attrs: Vec<(String, String)>) -> Option<Vec<(String, String)>> {
        match self.bytes.get(self.pos) {
            Some(b'>') | Some(b'/') => Some(attrs),
            _ => None,
        }
    }

    fn eat(&mut self, b: u8) -> bool {
        if self.pos < self.bytes.len() && self.bytes[self.pos] == b {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, b: u8) -> Option<()> {
        if self.eat(b) {
            Some(())
        } else {
            None
        }
    }
}

/// The marker `latex2mathml` uses to report TeX it could not convert.
const PARSE_ERROR_MARKER: &str = "[PARSE ERROR";

/// Decode the entities `latex2mathml` can emit. `&` is frequently *not* escaped
/// (see the module docs), so unknown sequences are copied verbatim instead of
/// being treated as an error.
fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp + 1..];
        let Some(semi) = tail.find(';').filter(|s| *s <= 12) else {
            out.push('&');
            rest = tail;
            continue;
        };
        let entity = &tail[..semi];
        match entity {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            "nbsp" => out.push('\u{a0}'),
            _ => match numeric_entity(entity) {
                Some(c) => out.push(c),
                None => {
                    out.push('&');
                    out.push_str(entity);
                    out.push(';');
                }
            },
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    out
}

fn numeric_entity(entity: &str) -> Option<char> {
    let digits = entity.strip_prefix('#')?;
    let code = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse::<u32>().ok()?,
    };
    char::from_u32(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_simple_document() {
        let root = parse_mathml(
            r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mi>x</mi><mo>+</mo><mn>1</mn></math>"#,
        )
        .expect("well-formed");
        assert_eq!(root.elem, Elem::Math);
        assert_eq!(root.attr("display"), Some("inline"));
        assert_eq!(root.children.len(), 3);
        assert_eq!(root.children[0].elem, Elem::Mi);
        assert_eq!(root.children[0].text, "x");
        assert_eq!(root.children[2].text, "1");
    }

    #[test]
    fn parses_self_closing_and_nested_elements() {
        let root = parse_mathml(
            r#"<math display="block"><mfrac linethickness="0"><mn>1</mn><mspace width="0.16666667em"/></mfrac></math>"#,
        )
        .expect("self-closing mspace");
        let frac = &root.children[0];
        assert_eq!(frac.elem, Elem::Mfrac);
        assert_eq!(frac.attr("linethickness"), Some("0"));
        assert_eq!(frac.children[1].elem, Elem::Mspace);
        assert!(frac.children[1].children.is_empty());
    }

    #[test]
    fn rejects_unknown_elements_and_malformed_input() {
        assert!(parse_mathml("<math><ms><mi>x</mi></ms></math>").is_none());
        assert!(parse_mathml("<math><mi>x</mi>").is_none());
        assert!(parse_mathml("<math><mi>x</mrow></math>").is_none());
        assert!(parse_mathml("").is_none());
        assert!(parse_mathml("not markup at all").is_none());
        assert!(parse_mathml("<mrow><mi>x</mi></mrow>").is_none());
    }

    #[test]
    fn rejects_the_latex2mathml_error_marker() {
        let root = parse_mathml(
            r#"<math display="inline"><mi>x</mi><mtext>[PARSE ERROR: Undefined("EOF")]</mtext></math>"#,
        );
        assert!(root.is_none());
    }

    #[test]
    fn keeps_unbalanced_text_and_decodes_entities() {
        // `\&` is emitted raw; the bare `&` must not derail the parse.
        let root = parse_mathml(r#"<math><mi>&</mi><mtext>a&lt;b&gt;&amp;c</mtext></math>"#)
            .expect("stray ampersand is legal text");
        assert_eq!(root.children[0].text, "&");
        assert_eq!(root.children[1].text, "a<b>&c");
    }

    #[test]
    fn deep_nesting_is_bounded_not_fatal() {
        let mut open = String::new();
        let mut close = String::new();
        for _ in 0..(MAX_DEPTH + 4) {
            open.push_str("<mrow>");
            close.push_str("</mrow>");
        }
        let doc = format!("<math>{open}<mi>x</mi>{close}</math>");
        assert!(parse_mathml(&doc).is_none());
    }
}
