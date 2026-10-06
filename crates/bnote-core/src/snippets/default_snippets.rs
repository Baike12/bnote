//! Port of `src/editor/snippets/default-snippets.ts` and
//! `default-variables.ts` — the owner's real obsidian-latex-suite `data.json`
//! configuration (223 entries), ported verbatim: same order, same options,
//! same priorities, duplicates included. Do not editorialize; the user vault
//! file (`.bnote/snippets.js`) replaces this set wholesale when present.

use super::engine::{RawReplacement, RawSnippet, RawTrigger, ReplacementArg, SnippetSource};
use super::matrix::MATRIX_ROW_BREAK;

/// Snippet variables, ported from obsidian-latex-suite. Substituted into
/// snippet triggers before regex compilation.
pub const DEFAULT_SNIPPET_VARIABLES: &[(&str, &str)] = &[
    (
        "${GREEK}",
        "(?:alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|vartheta|Theta|iota|kappa|lambda|Lambda|mu|nu|xi|omicron|pi|rho|varrho|sigma|Sigma|tau|upsilon|Upsilon|phi|varphi|Phi|chi|psi|omega|Omega)",
    ),
    (
        "${SYMBOL}",
        "(?:parallel|perp|partial|nabla|hbar|ell|infty|oplus|ominus|otimes|oslash|square|star|dagger|vee|wedge|subseteq|subset|supseteq|supset|emptyset|exists|nexists|forall|implies|impliedby|iff|setminus|neg|lor|land|bigcup|bigcap|cdot|times|simeq|approx)",
    ),
    (
        "${MORE_SYMBOLS}",
        "(?:leq|geq|neq|gg|ll|equiv|sim|propto|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|to|mapsto|cap|cup|in|sum|prod|exp|ln|log|det|dots|vdots|ddots|pm|mp|int|iint|iiint|oint)",
    ),
    (
        "${ACCENT}",
        "(?:dot|ddot|hat|bar|tilde|vec|underline|overline|mathbf|mathcal|mathrm|mathbb)",
    ),
];

use super::engine::{lit, lit_p, lit_pd, rx, rx_p, rx_pd};

/// `iden(\d)` → N×N identity matrix (the plugin's only function-type builtin;
/// its return value goes through the raw channel, so the `\\` row separator
/// survives — see `parse_replacement`).
fn iden_replacement(arg: ReplacementArg<'_>) -> Option<String> {
    let n: usize = match arg {
        ReplacementArg::Groups(groups) => groups.first()?.parse().ok()?,
        _ => return None,
    };
    let mut rows: Vec<String> = Vec::with_capacity(n);
    for j in 0..n {
        let row: Vec<&str> = (0..n).map(|i| if i == j { "1" } else { "0" }).collect();
        rows.push(row.join(" & "));
    }
    Some(format!(
        "\\begin{{pmatrix}}\n{}\n\\end{{pmatrix}}",
        rows.join(MATRIX_ROW_BREAK)
    ))
}

/// Raw snippet data for the function-type `iden` entry (the two `const fn`
/// builders cannot express a function pointer replacement).
const IDEN: RawSnippet<'static> = RawSnippet {
    trigger: RawTrigger::Regex { source: r"iden(\d)", flags: "" },
    replacement: RawReplacement::Fn(iden_replacement),
    options: "mA",
    priority: 0,
    description: "N x N identity matrix",
    source: SnippetSource::Builtin,
};

/// Default snippet set — the owner's real obsidian-latex-suite configuration.
pub static DEFAULT_SNIPPETS: &[RawSnippet<'static>] = &[
    lit("#@", "$$\n\\begin{align}\n$0\n\\end{align}\n$$", "tA"),
    lit("##@", "$$0$", "tA"),
    lit("ma", "$$0$", "tA"),
    lit("pa", "\\partial", "mA"),
    lit("in", "\\in", "mA"),
    lit("spa", "~", "mA"),
    lit("dl", "\\displaylines{ \\ \n $0 \n}", "mA"),
    lit("ad", "+", "mA"),
    lit("sb", "-", "mA"),
    lit("mt", "*", "mA"),
    lit("sj", "_{$0}", "mA"),
    lit("sk", "^{$0}", "mA"),
    lit("ap", "\\approx", "mA"),
    lit("eq", "=", "mA"),
    lit("dm", "$$\n\\begin{align}\n$0\n\\end{align}\n$$", "tAw"),
    lit("beg", "\\begin{$0}\n$1\n\\end{$0}", "mA"),
    lit("aa", "\\alpha", "mA"),
    lit("bb", "\\beta", "mA"),
    lit("gg", "\\gamma", "mA"),
    lit("GG", "\\Gamma", "mA"),
    lit("dd", "\\delta", "mA"),
    lit("DD", "\\Delta", "mA"),
    lit("ee", "\\epsilon", "mA"),
    lit(":e", "\\varepsilon", "mA"),
    lit("zz", "\\zeta", "mA"),
    lit("tt", "\\theta", "mA"),
    lit("TT", "\\Theta", "mA"),
    lit(":t", "\\vartheta", "mA"),
    lit("io", "\\iota", "mA"),
    lit("kk", "\\kappa", "mA"),
    lit("ll", "\\lambda", "mA"),
    lit("LL", "\\Lambda", "mA"),
    lit("ss", "\\sigma", "mA"),
    lit("SS", "\\Sigma", "mA"),
    lit("uu", "\\upsilon", "mA"),
    lit("UU", "\\Upsilon", "mA"),
    lit("oo", "\\omega", "mA"),
    lit("OO", "\\Omega", "mA"),
    lit("ome", "\\omega", "mA"),
    lit("Ome", "\\Omega", "mA"),
    lit("text", "\\text{$0}$1", "mA"),
    lit("\"", "\\text{$0}$1", "mA"),
    lit("sr", "^{2}", "mA"),
    lit("cb", "^{3}", "mA"),
    lit("rd", "^{$0}$1", "mA"),
    lit("_", "_{$0}$1", "mA"),
    lit("sts", "_\\text{$0}", "mA"),
    lit("sq", "\\sqrt{ $0 }$1", "mA"),
    lit("ee", "e^{ $0 }$1", "mA"),
    lit("invs", "^{-1}", "mA"),
    lit("conj", "^{*}", "mA"),
    lit("Re", "\\mathrm{Re}", "mA"),
    lit("Im", "\\mathrm{Im}", "mA"),
    lit("bf", "\\mathbf{$0}", "mA"),
    lit("rm", "\\mathrm{$0}$1", "mA"),
    lit("trace", "\\mathrm{Tr}", "mA"),
    rx("([a-zA-Z])hat", "\\hat{[[0]]}", "rmA"),
    rx("([a-zA-Z])bar", "\\bar{[[0]]}", "rmA"),
    rx_p("([a-zA-Z])dot", "\\dot{[[0]]}", "rmA", -1),
    rx_p("([a-zA-Z])ddot", "\\ddot{[[0]]}", "rmA", 1),
    rx("([a-zA-Z])til", "\\tilde{[[0]]}", "rmA"),
    rx("([a-zA-Z])und", "\\underline{[[0]]}", "rmA"),
    rx("ve([a-zA-Z])", "\\vec{[[0]]}", "rmA"),
    rx("ma([a-zA-Z])", "\\mathbf{[[0]]}", "rmA"),
    rx("mc([a-zA-Z])", "\\mathcal{[[0]]}", "rmA"),
    lit("([a-zA-Z]),\\.", "\\mathbf{[[0]]}", "rmA"),
    lit("([a-zA-Z])\\.,", "\\mathbf{[[0]]}", "rmA"),
    rx(r"\\(${GREEK}),\.", "\\boldsymbol{\\[[0]]}", "rmA"),
    rx(r"\\(${GREEK})\.,", "\\boldsymbol{\\[[0]]}", "rmA"),
    lit("hat", "\\hat{$0}$1", "mA"),
    lit("bar", "\\bar{$0}$1", "mA"),
    lit_p("dot", "\\dot{$0}$1", "mA", -1),
    lit("ddot", "\\ddot{$0}$1", "mA"),
    lit("cdot", "\\cdot", "mA"),
    lit("tilde", "\\tilde{$0}$1", "mA"),
    lit("und", "\\underline{$0}$1", "mA"),
    lit("vec", "\\vec{$0}$1", "mA"),
    lit("xnn", "x_{n}", "mA"),
    lit("xii", "x_{i}", "mA"),
    lit("xjj", "x_{j}", "mA"),
    lit("xp1", "x_{n+1}", "mA"),
    lit("ynn", "y_{n}", "mA"),
    lit("yii", "y_{i}", "mA"),
    lit("yjj", "y_{j}", "mA"),
    lit("ooo", "\\infty", "mA"),
    lit("sum", "\\sum_{${0:i}=${1:1}}^{${2:N}} $3", "mA"),
    lit("pr", "\\prod_{${0:i}=${1:1}}^{${2:N}} $3", "mA"),
    lit("lim", "\\lim_{ ${0:n} \\to ${1:\\infty} } $2", "mA"),
    lit("+-", "\\pm", "mA"),
    lit("-+", "\\mp", "mA"),
    lit("...", "\\dots", "mA"),
    lit("nabl", "\\nabla", "mA"),
    lit("del", "\\nabla", "mA"),
    lit("xx", "\\times", "mA"),
    lit("**", "\\cdot", "mA"),
    lit("para", "\\parallel", "mA"),
    lit("===", "\\equiv", "mA"),
    lit("!=", "\\neq", "mA"),
    lit(">=", "\\geq", "mA"),
    lit("<=", "\\leq", "mA"),
    lit(">>", "\\gg", "mA"),
    lit("<<", "\\ll", "mA"),
    lit("simm", "\\sim", "mA"),
    lit("sim=", "\\simeq", "mA"),
    lit("prop", "\\propto", "mA"),
    lit("<->", "\\leftrightarrow ", "mA"),
    lit("<-", "\\leftarrow ", "mA"),
    lit("->", "\\to", "mA"),
    lit("!>", "\\mapsto", "mA"),
    lit("=>", "\\implies", "mA"),
    lit("=<", "\\impliedby", "mA"),
    lit("and", "\\cap", "mA"),
    lit("orr", "\\cup", "mA"),
    lit("inc", "\\in", "mA"),
    lit("notin", "\\not\\in", "mA"),
    lit("\\\\\\", "\\setminus", "mA"),
    lit("sub=", "\\subseteq", "mA"),
    lit("sup=", "\\supseteq", "mA"),
    lit("eset", "\\emptyset", "mA"),
    lit("set", "\\{ $0 \\}$1", "mA"),
    lit_p("exs", "\\exists", "mA", 1),
    lit("LL", "\\mathcal{L}", "mA"),
    lit("HH", "\\mathcal{H}", "mA"),
    lit("CC", "\\mathbb{C}", "mA"),
    lit("RR", "\\mathbb{R}", "mA"),
    lit("ZZ", "\\mathbb{Z}", "mA"),
    lit("NN", "\\mathbb{N}", "mA"),
    rx_pd(
        r"([^\\])(${GREEK})",
        "[[0]]\\[[1]]",
        "rmA",
        0,
        "Add backslash before Greek letters",
    ),
    rx_pd(
        r"([^\\])(${SYMBOL})",
        "[[0]]\\[[1]]",
        "rmA",
        0,
        "Add backslash before symbols",
    ),
    rx(
        r"\\(${GREEK}|${SYMBOL}|${MORE_SYMBOLS})([A-Za-z])",
        "\\[[0]] [[1]]",
        "rmA",
    ),
    rx(r"\\(${GREEK}|${SYMBOL}) sr", "\\[[0]]^{2}", "rmA"),
    rx(r"\\(${GREEK}|${SYMBOL}) cb", "\\[[0]]^{3}", "rmA"),
    rx(r"\\(${GREEK}|${SYMBOL}) rd", "\\[[0]]^{$0}$1", "rmA"),
    rx(r"\\(${GREEK}|${SYMBOL}) hat", "\\hat{\\[[0]]}", "rmA"),
    rx(r"\\(${GREEK}|${SYMBOL}) dot", "\\dot{\\[[0]]}", "rmA"),
    rx(r"\\(${GREEK}|${SYMBOL}) bar", "\\bar{\\[[0]]}", "rmA"),
    rx(r"\\(${GREEK}|${SYMBOL}) vec", "\\vec{\\[[0]]}", "rmA"),
    rx(r"\\(${GREEK}|${SYMBOL}) tilde", "\\tilde{\\[[0]]}", "rmA"),
    rx(r"\\(${GREEK}|${SYMBOL}) und", "\\underline{\\[[0]]}", "rmA"),
    lit("par", "\\frac{ \\partial ${0:y} }{ \\partial ${1:x} } $2", "m"),
    lit("ddt", "\\frac{d}{dt} ", "mA"),
    lit("\\int", "\\int $0 \\, d${1:x} $2", "m"),
    lit("dint", "\\int_{${0:0}}^{${1:1}} $2 \\, d${3:x} $4", "mA"),
    lit("oint", "\\oint", "mA"),
    lit("iint", "\\iint", "mA"),
    lit("iiint", "\\iiint", "mA"),
    lit("oinf", "\\int_{0}^{\\infty} $0 \\, d${1:x} $2", "mA"),
    lit("infi", "\\int_{-\\infty}^{\\infty} $0 \\, d${1:x} $2", "mA"),
    lit("U", "\\underbrace{ ${VISUAL} }_{ $0 }", "mA"),
    lit("O", "\\overbrace{ ${VISUAL} }^{ $0 }", "mA"),
    lit("B", "\\underset{ $0 }{ ${VISUAL} }", "mA"),
    lit("C", "\\cancel{ ${VISUAL} }", "mA"),
    lit("K", "\\cancelto{ $0 }{ ${VISUAL} }", "mA"),
    lit("S", "\\sqrt{ ${VISUAL} }", "mA"),
    lit("kbt", "k_{B}T", "mA"),
    lit("msun", "M_{\\odot}", "mA"),
    lit("dag", "^{\\dagger}", "mA"),
    lit("o+", "\\oplus ", "mA"),
    lit("ox", "\\otimes ", "mA"),
    lit("bra", "\\bra{$0} $1", "mA"),
    lit("ket", "\\ket{$0} $1", "mA"),
    lit("brk", "\\braket{ $0 | $1 } $2", "mA"),
    lit("outer", "\\ket{${0:\\psi}} \\bra{${0:\\psi}} $1", "mA"),
    lit("pu", "\\pu{ $0 }", "mA"),
    lit("cee", "\\ce{ $0 }", "mA"),
    lit("he4", "{}^{4}_{2}He ", "mA"),
    lit("he3", "{}^{3}_{2}He ", "mA"),
    lit("iso", "{}^{${0:4}}_{${1:2}}${2:He}", "mA"),
    lit("pm", "\\begin{pmatrix}\n$0\n\\end{pmatrix}", "MA"),
    lit("bm", "\\begin{bmatrix}\n$0\n\\end{bmatrix}", "MA"),
    lit("Bm", "\\begin{Bmatrix}\n$0\n\\end{Bmatrix}", "MA"),
    lit("vm", "\\begin{vmatrix}\n$0\n\\end{vmatrix}", "MA"),
    lit("Vm", "\\begin{Vmatrix}\n$0\n\\end{Vmatrix}", "MA"),
    lit("matrix", "\\begin{matrix}\n$0\n\\end{matrix}", "MA"),
    lit("pmat", "\\begin{pmatrix}$0\\end{pmatrix}", "nA"),
    lit("bmat", "\\begin{bmatrix}$0\\end{bmatrix}", "nA"),
    lit("Bmat", "\\begin{Bmatrix}$0\\end{Bmatrix}", "nA"),
    lit("vmat", "\\begin{vmatrix}$0\\end{vmatrix}", "nA"),
    lit("Vmat", "\\begin{Vmatrix}$0\\end{Vmatrix}", "nA"),
    lit("matrix", "\\begin{matrix}$0\\end{matrix}", "nA"),
    lit("cases", "\\begin{cases}\n$0\n\\end{cases}", "mA"),
    lit("ali", "\\begin{align}\n$0\n\\end{align}", "mA"),
    lit("arr", "\\begin{array} \\ \n$0\n\\end{array}", "mA"),
    IDEN,
    lit("avg", "\\langle $0 \\rangle $1", "mA"),
    lit_p("norm", "\\lvert $0 \\rvert $1", "mA", 1),
    lit_p("Norm", "\\lVert $0 \\rVert $1", "mA", 1),
    lit("ceil", "\\lceil $0 \\rceil $1", "mA"),
    lit("flo", "\\lfloor $0 \\rfloor $1", "mA"),
    lit("mod", "|$0|$1", "mA"),
    lit("(", "(${VISUAL})", "mA"),
    lit("[", "[${VISUAL}]", "mA"),
    lit("{", "{${VISUAL}}", "mA"),
    lit("(", "($0)$1", "mA"),
    lit("{", "{$0}$1", "mA"),
    lit("[", "[$0]$1", "mA"),
    lit("lr(", "\\left( $0 \\right) $1", "mA"),
    lit("lr{", "\\left\\{ $0 \\right\\} $1", "mA"),
    lit("lr[", "\\left[ $0 \\right] $1", "mA"),
    lit("lr|", "\\left| $0 \\right| $1", "mA"),
    lit("lra", "\\left< $0 \\right> $1", "mA"),
    lit_pd(
        "tayl",
        "${0:f}(${1:x} + ${2:h}) = ${0:f}(${1:x}) + ${0:f}'(${1:x})${2:h} + ${0:f}''(${1:x}) \\frac{${2:h}^{2}}{2!} + \\dots$3",
        "mA",
        0,
        "Taylor expansion",
    ),
    rx_pd(
        r"([A-Za-z])(\d)",
        "[[0]]_{[[1]]}",
        "rmA",
        -1,
        "Auto letter subscript",
    ),
    lit("al", "\\alpha", "m"),
    lit("mk", "$$0$", "tA"),
    lit("mk", "\\($0\\)", "TA"),
    rx_p(
        r"(\S\s*)dm",
        "[[0]]\n$$\n\\begin{align}\n$0\n\\end{align}\n$$",
        "tAw",
        1,
    ),
    rx_p(
        r"(\\${GREEK}|[A-Za-z])_{(\d+)}(\d)",
        "[[0]]_{[[1]][[2]]}",
        "rmA",
        -1,
    ),
    rx_p(
        r"\\(${ACCENT})\{(\\${GREEK}|[A-Za-z])\}(\d)",
        "\\[[0]]{[[1]]}_{[[2]]}",
        "rmA",
        -1,
    ),
    rx_p(
        r"\\(${ACCENT})\{(\\${GREEK}|[A-Za-z])\}_\{(\d+)\}(\d)",
        "\\[[0]]{[[1]]}_{[[2]][[3]]}",
        "rmA",
        -1,
    ),
    rx_p(
        r"\\(${ACCENT})\{\\(${ACCENT})\{(\\${GREEK}|[A-Za-z])\}\}(\d)",
        "\\[[0]]{\\[[1]]{[[2]]}}_{[[3]]}",
        "rmA",
        -1,
    ),
    rx_p(
        r"\\(${ACCENT})\{\\(${ACCENT})\{(\\${GREEK}|[A-Za-z])\}_\{(\d+)\}(\d)",
        "\\[[0]]{\\[[1]]{[[2]]}}_{[[3]][[4]]}",
        "rmA",
        -1,
    ),
    lit_pd(
        "pmod",
        "\\pmod{${0:n}}$1",
        "mA",
        0,
        "Parenthesized modulo (\\pmod{n})",
    ),
    lit("QQ", "\\mathbb{Q}", "mA"),
    lit("deg", "\\degree", "mA"),
    lit("floor", "\\lfloor $0 \\rfloor $1", "mA"),
    rx("par([0-9])", "\\frac{ \\partial^{[[0]]} ${0:y} }{ \\partial ${1:x}^{[[0]]} } $2", "mA"),
    rx("parn", "\\frac{ \\partial^{${0:n}} ${1:y} }{ \\partial ${2:x}^{${0:n}} } $2", "mA"),
    rx_pd(
        r"(arccsc|arcsec|arccot)",
        "\\operatorname{[[0]]}$0",
        "mA",
        1,
        "Inverse trig functions, not built-in KaTeX functions",
    ),
    lit("\\sum", "\\sum_{${0:i}=${1:1}}^{${2:N}} $3", "m"),
    lit("\\prod", "\\prod_{${0:i}=${1:1}}^{${2:N}} $3", "m"),
    rx_p(r"(n?)e\\xi sts", "\\[[0]]exists", "mA", 1),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snippets::engine::{CompiledSnippets, MatchOptions, SnippetStore};

    /// Dumper used to verify the ported data against the TS source: a `node`
    /// dump of `DEFAULT_SNIPPETS` (one JSON object per entry: trigger source,
    /// regex-ness, options, priority, replacement) was diffed against this
    /// output — 222 entries, every field equal (the only difference is that
    /// entries the TS writes as strings with the `r` option are
    /// `RawTrigger::Regex` here; both compile to the same anchored pattern).
    /// Left ignored as a re-verification tool; `data_is_complete` below is the
    /// standing gate.
    #[test]
    #[ignore]
    fn dump_data_for_diff() {
        fn esc(s: &str) -> String {
            let mut out = String::new();
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    '\u{8}' => out.push_str("\\b"),
                    '\u{c}' => out.push_str("\\f"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out
        }
        for s in DEFAULT_SNIPPETS {
            let (t, is_re) = match s.trigger {
                RawTrigger::Literal(x) => (x, false),
                RawTrigger::Regex { source, .. } => (source, true),
            };
            let r = match s.replacement {
                RawReplacement::Text(x) => format!("\"{}\"", esc(x)),
                RawReplacement::Fn(_) => "null".to_string(),
            };
            println!(
                "{{\"t\":\"{}\",\"isRe\":{},\"o\":\"{}\",\"p\":{},\"r\":{}}}",
                esc(t),
                is_re,
                s.options,
                s.priority,
                r
            );
        }
    }

    /// The TS data array carries 222 entries; the port must not lose any.
    #[test]
    fn data_is_complete() {
        assert_eq!(DEFAULT_SNIPPETS.len(), 222, "snippet count must match default-snippets.ts");
        // Every built-in snippet compiles (a bad regex would silently drop it
        // from the compiled list — exactly the regression this guards).
        let compiled = CompiledSnippets::new(DEFAULT_SNIPPETS);
        assert_eq!(compiled.list.len(), DEFAULT_SNIPPETS.len());
        assert!(compiled.list.iter().all(|s| s.source == SnippetSource::Builtin));
    }

    /// Duplicate triggers are part of the data (the TS array keeps them).
    #[test]
    fn duplicate_triggers_are_kept() {
        let count = |t: &str| DEFAULT_SNIPPETS.iter().filter(|s| matches!(s.trigger, RawTrigger::Literal(l) if l == t)).count();
        assert_eq!(count("ee"), 2);
        assert_eq!(count("mk"), 2);
        assert_eq!(count("matrix"), 2);
        assert_eq!(count("LL"), 2);
        assert_eq!(count("("), 2);
    }

    /// latexSuite.test.ts — `dm 片段:公式块直接产出 align 环境`.
    #[test]
    fn builtin_dm_produces_an_align_block() {
        let dm = DEFAULT_SNIPPETS
            .iter()
            .find(|s| matches!(s.trigger, RawTrigger::Literal("dm")))
            .expect("builtin dm");
        match dm.replacement {
            RawReplacement::Text(t) => {
                assert_eq!(t, "$$\n\\begin{align}\n$0\n\\end{align}\n$$");
            }
            RawReplacement::Fn(_) => panic!("dm is a text snippet"),
        }
    }

    /// load.test.ts — `仓库文件里的函数被原样带进来,且返回值不过转义层`.
    #[test]
    fn builtin_iden_rows_keep_the_two_backslash_separator() {
        let store = SnippetStore::builtin();
        let math = crate::markdown::math_scan::scan_math("$iden2$");
        let ctx = crate::markdown::context::context_at_scan("$iden2$", 6, &math);
        let out = store
            .match_at("$iden2$", 6, &ctx, &MatchOptions::new(true, Some("2"), None))
            .expect("iden2 matches")
            .replacement
            .text;
        let lines: Vec<&str> = out.split('\n').collect();
        assert_eq!(lines.len(), 4); // \begin / row / row / \end
        assert!(lines[1].ends_with("\\\\"));
        assert_eq!(out.matches('\\').count(), 4); // \begin + one separator (2) + \end

        let doc = "$iden3$";
        let math = crate::markdown::math_scan::scan_math(doc);
        let ctx = crate::markdown::context::context_at_scan(doc, 6, &math);
        let out3 = store
            .match_at(doc, 6, &ctx, &MatchOptions::new(true, Some("3"), None))
            .expect("iden3 matches")
            .replacement
            .text;
        let lines3: Vec<&str> = out3.split('\n').collect();
        assert_eq!(lines3.len(), 5);
        assert!(lines3[1].ends_with("\\\\"));
        assert!(lines3[2].ends_with("\\\\"));
        assert!(!lines3[3].ends_with("\\\\"));
        assert_eq!(out3.matches('\\').count(), 6);
    }

    /// Variables are substituted into the regex triggers (a data-level check
    /// that the `${GREEK}` family still compiles and matches after
    /// substitution). `\alphaX` is the shape the rule repairs — it inserts the
    /// missing space: `\alpha X`.
    #[test]
    fn greek_variables_expand_into_triggers() {
        let store = SnippetStore::builtin();
        let doc = "$\\alphax$";
        let math = crate::markdown::math_scan::scan_math(doc);
        let pos = doc.find('x').unwrap() + 1; // the cursor sits after the typed `x`
        let ctx = crate::markdown::context::context_at_scan(doc, pos, &math);
        let m = store
            .match_at(doc, pos, &ctx, &MatchOptions::new(true, Some("x"), None))
            .expect("the Greek-letter rule matches `\\alphax`");
        assert_eq!(m.replacement.text, "\\alpha x");
    }
}

