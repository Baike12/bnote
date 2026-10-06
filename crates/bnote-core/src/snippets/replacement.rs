//! Port of `src/editor/snippets/engine.ts` — the replacement text layer:
//! latex-suite replacement syntax → plain text + tabstops, and the
//! `removeSnippetWhitespace` trim.

use super::trim_end_js_ws;

/// One tabstop occurrence in the produced text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stop {
    pub index: u32,
    /// Byte range inside [`ParsedReplacement::text`] (relative to its start).
    pub from: usize,
    pub to: usize,
}

/// Port of the TS `ParsedReplacement`: the expanded text plus every tabstop
/// occurrence (mirrored indices appear several times).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedReplacement {
    pub text: String,
    pub stops: Vec<Stop>,
}

/// `${VISUAL}` — the visual selection placeholder.
const VISUAL: &str = "${VISUAL}";

/// latex-suite replacement escaping: only `\$` and `\\` are escapes; any other
/// `\x` keeps the backslash (so `\[[1]]` = literal "\" + group ref, and `\{`
/// in `\left\{` survives).
fn is_escapable(b: u8) -> bool {
    b == b'$' || b == b'\\'
}

/// Port of `src/editor/snippets/engine.ts::parseReplacement`.
///
/// Expands latex-suite replacement syntax into plain text + tabstops: `$0`…
/// tabstops, `${0:default}` with placeholder text, `[[n]]` regex group
/// references, `${VISUAL}` the visual selection, `\x` escapes for the two
/// characters above (anything else after `\` stays literal).
///
/// `raw` marks the **function-type replacement return channel**: the TS passes
/// function returns through verbatim and only scans tabstops (`process` trusts
/// the return value; `[[n]]`/`\$`/`\\` handling happens at parse time for
/// *string* replacements only). Without that channel a function-returned `\\`
/// (matrix row separator) would lose one escaping layer and break the matrix.
pub fn parse_replacement(
    replacement: &str,
    groups: &[String],
    visual_text: Option<&str>,
    raw: bool,
) -> ParsedReplacement {
    let bytes = replacement.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut stops: Vec<Stop> = Vec::new();
    let mut i = 0usize;

    while i < n {
        let ch = bytes[i];

        if !raw && ch == b'\\' && i + 1 < n {
            let next = bytes[i + 1];
            if is_escapable(next) {
                out.push(next as char);
                i += 2;
            } else {
                out.push('\\');
                i += 1;
            }
            continue;
        }

        if ch == b'$' {
            if !raw && replacement[i..].starts_with(VISUAL) {
                out.push_str(visual_text.unwrap_or(""));
                i += VISUAL.len();
                continue;
            }
            if bytes.get(i + 1) == Some(&b'{') {
                let close = replacement[i + 2..].find('}').map(|rel| i + 2 + rel);
                if let Some(close) = close {
                    let inner = &replacement[i + 2..close];
                    let colon = inner.find(':');
                    if let Some(colon) = colon {
                        let digits = &inner[..colon];
                        if colon > 0
                            && !digits.is_empty()
                            && digits.bytes().all(|b| b.is_ascii_digit())
                        {
                            let index = digits.parse::<u32>().unwrap_or(u32::MAX);
                            let def = &inner[colon + 1..];
                            stops.push(Stop {
                                index,
                                from: out.len(),
                                to: out.len() + def.len(),
                            });
                            out.push_str(def);
                            i = close + 1;
                            continue;
                        }
                    }
                }
                out.push_str("${");
                i += 2;
                continue;
            }
            // `$digits` — an empty tabstop.
            let mut j = i + 1;
            while j < n && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 {
                let index = replacement[i + 1..j].parse::<u32>().unwrap_or(u32::MAX);
                stops.push(Stop { index, from: out.len(), to: out.len() });
                i = j;
                continue;
            }
            out.push('$');
            i += 1;
            continue;
        }

        if !raw && ch == b'[' {
            if let Some((group, len)) = parse_group_ref(&replacement[i..]) {
                out.push_str(groups.get(group).map(|s| s.as_str()).unwrap_or(""));
                i += len;
                continue;
            }
            out.push('[');
            i += 1;
            continue;
        }

        // Any other byte: copy one whole char (non-ASCII passes through).
        let c = replacement[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(c);
        i += c.len_utf8();
    }

    ParsedReplacement { text: out, stops }
}

/// `[[n]]` → `(n, consumed_bytes)`; the TS matches it with `/^\[\[(\d+)\]\]/`.
fn parse_group_ref(s: &str) -> Option<(usize, usize)> {
    let rest = s.strip_prefix("[[")?;
    let digits_len = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits_len == 0 || !rest[digits_len..].starts_with("]]") {
        return None;
    }
    let index = rest[..digits_len].parse::<usize>().ok()?;
    Some((index, 2 + digits_len + 2))
}

/// Port of `src/editor/snippets/engine.ts::trimSnippetWhitespace`.
///
/// latex-suite's `removeSnippetWhitespace`: no redundant space is left behind
/// after an expansion inside inline math. Two tail shapes: ends with a space →
/// drop all trailing whitespace; the last three characters are `" $" + digit`
/// (a whitespace before a `${n}` tabstop) → drop just that space, keep the
/// tabstop. Anything else is returned unchanged.
pub fn trim_snippet_whitespace(replacement: &str) -> String {
    if replacement.ends_with(' ') {
        return trim_end_js_ws(replacement).to_string();
    }
    let b = replacement.as_bytes();
    let n = b.len();
    if n >= 3 && b[n - 3] == b' ' && b[n - 2] == b'$' && b[n - 1].is_ascii_digit() {
        let mut out = String::with_capacity(n);
        out.push_str(&replacement[..n - 3]);
        out.push_str(&replacement[n - 2..]);
        return out;
    }
    replacement.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// engine.test.ts — `parseReplacement:制表位与转义`.
    #[test]
    fn dollar_stops_produce_empty_tabstops() {
        let r = parse_replacement("($0)$1", &[], None, false);
        assert_eq!(r.text, "()");
        assert_eq!(
            r.stops,
            vec![
                Stop { index: 0, from: 1, to: 1 },
                Stop { index: 1, from: 2, to: 2 },
            ]
        );
    }

    #[test]
    fn dollar_brace_default_carries_placeholder_text() {
        let r = parse_replacement("\\sum_{${0:i}=${1:1}}^{${2:N}} $3", &[], None, false);
        assert_eq!(r.text, "\\sum_{i=1}^{N} ");
        assert_eq!(
            r.stops,
            vec![
                Stop { index: 0, from: 6, to: 7 },
                Stop { index: 1, from: 8, to: 9 },
                Stop { index: 2, from: 12, to: 13 },
                Stop { index: 3, from: 15, to: 15 },
            ]
        );
    }

    #[test]
    fn group_refs_and_escaped_backslash_before_group_ref() {
        assert_eq!(
            parse_replacement("\\hat{[[0]]}", &["x".into()], None, false).text,
            "\\hat{x}"
        );
        assert_eq!(
            parse_replacement("\\[\\[0]]", &["x".into()], None, false).text,
            "\\[\\[0]]"
        );
    }

    #[test]
    fn escapes_cover_dollar_and_backslash_only() {
        assert_eq!(parse_replacement("\\$0", &[], None, false).text, "$0");
        assert_eq!(parse_replacement("\\\\", &[], None, false).text, "\\");
        assert_eq!(parse_replacement("\\vec{", &[], None, false).text, "\\vec{");
    }

    #[test]
    fn visual_placeholder_uses_selection_or_empty() {
        assert_eq!(parse_replacement("(${VISUAL})", &[], Some("a+b"), false).text, "(a+b)");
        assert_eq!(parse_replacement("(${VISUAL})", &[], None, false).text, "()");
    }

    /// The function-type return channel: escapes and `[[n]]` stay literal, the
    /// tabstops are still scanned (matrix `\\` must survive — load.test.ts).
    #[test]
    fn raw_mode_skips_escapes_group_refs_and_visual() {
        let r = parse_replacement("\\begin{pmatrix}\n1 \\\\\n\\end{pmatrix}$0", &["x".into()], Some("v"), true);
        assert_eq!(r.text, "\\begin{pmatrix}\n1 \\\\\n\\end{pmatrix}");
        assert_eq!(r.stops, vec![Stop { index: 0, from: r.text.len(), to: r.text.len() }]);
        assert_eq!(parse_replacement("[[0]]", &["x".into()], None, true).text, "[[0]]");
        assert_eq!(parse_replacement("${VISUAL}", &[], Some("v"), true).text, "${VISUAL}");
        // `\$0` raw: the backslash is NOT an escape (stays literal, then the
        // tabstop is still scanned) — text is one backslash, one stop.
        let r = parse_replacement("\\$0", &[], None, true);
        assert_eq!(r.text, "\\");
        assert_eq!(r.stops, vec![Stop { index: 0, from: 1, to: 1 }]);
    }

    #[test]
    fn out_of_range_group_ref_expands_to_empty() {
        assert_eq!(parse_replacement("[[3]]", &["x".into()], None, false).text, "");
        assert_eq!(parse_replacement("[[0]]", &[], None, false).text, "");
    }

    #[test]
    fn unterminated_brace_keeps_the_literal_prefix() {
        assert_eq!(parse_replacement("${0:i", &[], None, false).text, "${0:i");
        assert_eq!(parse_replacement("${i:x}", &[], None, false).text, "${i:x}");
    }

    #[test]
    fn trim_snippet_whitespace_tail_shapes() {
        assert_eq!(trim_snippet_whitespace("a "), "a");
        assert_eq!(trim_snippet_whitespace("a x $2"), "a x$2");
        assert_eq!(trim_snippet_whitespace("a"), "a");
        assert_eq!(trim_snippet_whitespace("a  $2"), "a $2");
        // The `" $" + digit` tail shape applies whenever it is the tail: the
        // leading space goes even at the very start of the text.
        assert_eq!(trim_snippet_whitespace("a $2"), "a$2");
        assert_eq!(trim_snippet_whitespace(" $2"), "$2");
        assert_eq!(trim_snippet_whitespace("$2"), "$2");
    }
}
