//! Port of `src/editor/mathScan.ts` — math region scanning.
//!
//! Offsets are UTF-8 byte offsets into the input `&str` (see [`crate::markdown`]).
//! `scan_math` is a pure function of the text alone so the host can memoize
//! the result per document generation.

/// One math region. Field names mirror the TS `MathRegion` (`from`/`to`/
/// `display`/`content`); `display == true` is a `$$…$$` block, `false` an
/// inline `$…$`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MathRegion {
    pub from: usize,
    pub to: usize,
    pub display: bool,
    pub content: String,
}

/**
 * Scans the document for `$$…$$` (block) and `$…$` (inline) math regions.
 * Mirrors Obsidian's heuristics: `\$` is an escape, inline content may not
 * start/end with whitespace or contain a newline, and a closing `$` may not
 * be followed by a digit (so "$5 and $10" stays plain text).
 *
 * 块级配对模型(第一性原理):
 * - 配对永不跨"内部空行"——LaTeX 数学容不下空行。但打字流会产生**单侧**空行
 *   (`$$` 后连按两次回车再写公式,或写完补空行再闭合),这类块必须照常渲染;
 *   只有**两侧同时**留空(正文段落被两个落单 $$ 夹住,即删错 $$ 后的错位产物)
 *   才拒绝配对。
 * - **例外:空行落在配对完整的 `\begin{…}…\end{…}` 内部时不是段落边界**。
 *   多行环境里的空行是排版留白(`#@` 片段展开成 `$$\n\begin{align}\n$0\n\end{align}\n$$`
 *   后,在 `$0` 处回车就直接产生它),整块照常渲染;而"未闭合的 `\begin` 之后的
 *   空行"不给豁免,否则"打了个 \begin 还没 \end 就空行"会重新打开吞正文的口子。
 * - 配对栈式前进:一对被拒绝时,两个标记都不发区域(可见可删),闭候选继续
 *   向后找——删掉一个 $$ 后,下方完好的公式仍按原样配对渲染,不会整体移位
 *   ("公式怪追着跑")。
 * - 奇数个标记时的最终落单 $$ 是"打字中未闭合"形态,发实时区域封顶到本段
 *   (第一个空行);其余落单一律保持普通文本——错位产物里的正文永远不会被
 *   吞进任何区域,每个 $$ 始终可见可删。
 */
pub fn scan_math(text: &str) -> Vec<MathRegion> {
    let mut out: Vec<MathRegion> = Vec::new();
    // TS caps on UTF-16 length; bytes are the equivalent guard here.
    if text.len() > 2_000_000 {
        return out;
    }
    let bytes = text.as_bytes();

    // `\begin{name}` / `\end{name}` tokens, precomputed once. The env name
    // never crosses a line (`[^}\n]*`), but `\s*` before `{` may (JS `\s`
    // includes `\n`).
    let envs = scan_env_tokens_all(text);

    // [`from, to`) 之间还有该环境的 `\end` 吗——没有就说明环境没闭合。
    let has_closing_end = |from: usize, to: usize, env_name: &str| -> bool {
        envs
            .iter()
            .any(|(at, begin, name)| *at >= from && *at < to && !begin && name == env_name)
    };

    // 把行 [from,to) 里的 `\begin`/`\end` 反映到环境栈上(只弹最近的同名环境)。
    let scan_env_tokens = |from: usize, to: usize, stack: &mut Vec<String>| {
        for (at, begin, name) in &envs {
            if *at < from {
                continue;
            }
            if *at >= to {
                break;
            }
            if *begin {
                stack.push(name.clone());
            } else if stack.last().map(|s| s.as_str()) == Some(name.as_str()) {
                stack.pop();
            }
        }
    };

    // 行 [start,end) 是否只含空白。
    let line_is_blank = |start: usize, end: usize| -> bool {
        bytes[start..end]
            .iter()
            .all(|b| *b == b' ' || *b == b'\t')
    };

    // 开闭标记之间的内容能否构成一个公式块。单行配对(`$$x$$`)天然合法;
    // 多行时数内部行:开头连续空行(lead)与结尾连续空行(trail)剥掉之后,
    // 中间不容空行,且两侧不得同时留空(那是正文被夹的错位产物);
    // 落在配对完整环境内部的空行不算空行(见文件头)。
    let pair_valid = |open: usize, close: usize| -> bool {
        let open_nl = match text[open..].find('\n') {
            Some(off) => open + off,
            None => return true,
        };
        if open_nl + 1 > close {
            return true; // 同行配对
        }
        let mut lead = 0usize;
        let mut trail = 0usize;
        let mut pending_trail = 0usize;
        let mut saw_content = false;
        let mut interior_blank = false;
        let mut env_stack: Vec<String> = Vec::new();
        let mut pos = open_nl + 1;
        while pos < close {
            let mut nl = text[pos..].find('\n').map(|off| pos + off);
            if nl.map_or(true, |n| n >= close) {
                nl = Some(close); // 闭标记所在行的行首片段
            }
            let nl = nl.unwrap_or(close);
            let blank = line_is_blank(pos, nl);
            // 空行是不是"环境内部的留白":栈顶环境在本块之内还有配对的 \end。
            let env_top = env_stack.last().cloned();
            let env_blank =
                blank && env_top.is_some() && has_closing_end(nl, close, env_top.as_deref().unwrap());
            if blank && !env_blank {
                if !saw_content {
                    lead += 1;
                } else {
                    pending_trail += 1;
                }
            } else {
                if pending_trail > 0 {
                    interior_blank = true;
                }
                saw_content = true;
                trail = pending_trail;
                pending_trail = 0;
            }
            if !blank {
                scan_env_tokens(pos, nl, &mut env_stack);
            }
            pos = nl + 1;
        }
        trail += pending_trail;
        if lead > 0 && trail > 0 {
            return false;
        }
        !interior_blank
    };

    // --- Block math: stack-pair up unescaped $$ occurrences. ---
    let mut marks: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        if bytes[i] == b'$' && bytes[i + 1] == b'$' {
            if i > 0 && bytes[i - 1] == b'\\' {
                i += 1;
                continue;
            }
            marks.push(i);
            i += 2; // consume both dollars
        } else {
            i += 1;
        }
    }

    let mut open: Option<usize> = None;
    for &m in &marks {
        match open {
            None => open = Some(m),
            Some(o) => {
                if pair_valid(o, m) {
                    out.push(MathRegion {
                        from: o,
                        to: m + 2,
                        display: true,
                        content: text[o + 2..m].to_string(),
                    });
                    open = None;
                } else {
                    // 错位配对:两个标记都不发区域(保持可见可删),当前标记成为新的开候选
                    // ——下方完好的公式因此仍能按原样配对(公式怪不再整体移位)。
                    open = Some(m);
                }
            }
        }
    }
    // 只有奇数个标记时的最终落单 $$ 是"打字中未闭合"形态,发实时区域(封顶到
    // 本段);偶数个标记还剩落单,说明它是错位产物里被挤掉的闭合标记,其下方
    // 是无关正文——保持普通文本,不吞进任何区域。
    if let Some(o) = open {
        if marks.len() % 2 == 1 {
            push_stray_region(&mut out, text, o);
        }
    }

    // --- Inline math, per line, outside block regions. ---
    // Inline matches never overlap each other (the scan advances past each
    // match, and lines are disjoint), so checking against the frozen block
    // list is exactly the TS `inRanges(..., out)` semantics.
    let blocks = out.clone();
    for (pos, line_end) in super::line_ranges(text) {
        let line = &text[pos..line_end];
        if !line.contains('$') || in_ranges(pos, line_end, &blocks) {
            continue;
        }
        scan_inline_in_line(line, pos, &blocks, &mut out);
    }

    out.sort_by_key(|r| r.from);
    out
}

/// 落单 $$ 的实时区域:`$$` 起到本段(第一个空行)末尾——打字中的公式保持
/// 实时渲染,又绝不吞进后续段落。区域止于段落最后一个字符(不含末尾换行),
/// 否则单行区域会越过行尾,行内替换装饰跨行抛
/// "Decorations that replace line breaks may not be specified via plugins"。
fn push_stray_region(out: &mut Vec<MathRegion>, text: &str, from: usize) {
    if text.len() - from > 10_000 {
        return;
    }
    let rest = &text[(from + 2).min(text.len())..(from + 2 + 10_000).min(text.len())];
    let rest_bytes = rest.as_bytes();
    // /\n[ \t]*\n/ 的首个匹配:第一个 `\n` 后跟可选空白再一个 `\n`。
    let mut blank_at: Option<usize> = None;
    let mut i = 0usize;
    while i < rest_bytes.len() {
        if rest_bytes[i] == b'\n' {
            let mut j = i + 1;
            while j < rest_bytes.len() && (rest_bytes[j] == b' ' || rest_bytes[j] == b'\t') {
                j += 1;
            }
            if j < rest_bytes.len() && rest_bytes[j] == b'\n' {
                blank_at = Some(i);
                break;
            }
        }
        i += 1;
    }
    // 区域止于段落最后一个字符(不含末尾换行)——区域跨行与否由换行决定,
    // 把换行算进来会让单行区域越过了行尾,行内替换装饰会跨行抛错。
    let para_end = blank_at.unwrap_or(rest.len());
    out.push(MathRegion {
        from,
        to: from + 2 + para_end,
        display: true,
        content: rest[..para_end].to_string(),
    });
}

fn in_ranges(from: usize, to: usize, ranges: &[MathRegion]) -> bool {
    ranges.iter().any(|r| from < r.to && to > r.from)
}

/// Precomputes every `\begin{name}` / `\end{name}` token of `text` with its
/// byte index (the TS regex `\\(begin|end)\s*\{([^}\n]*)\}` walked lazily;
/// a single pass gives the same tokens and lets the pair checks filter by
/// range instead of re-scanning).
fn scan_env_tokens_all(text: &str) -> Vec<(usize, bool, String)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let kind_start = i + 1;
        let is_begin = text[kind_start..].starts_with("begin");
        let is_end = !is_begin && text[kind_start..].starts_with("end");
        let word_len = if is_begin {
            5
        } else if is_end {
            3
        } else {
            i += 1;
            continue;
        };
        let mut j = kind_start + word_len;
        while j < bytes.len() && super::is_js_ws(bytes[j]) {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b'{' {
            i += 1;
            continue;
        }
        j += 1;
        let name_start = j;
        while j < bytes.len() && bytes[j] != b'}' && bytes[j] != b'\n' {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b'}' {
            i += 1;
            continue;
        }
        out.push((i, is_begin, text[name_start..j].to_string()));
        i = j + 1;
    }
    out
}

/// Port of the TS inline regex
/// `/(?<![\\$])\$(?!\s)((?:[^$\n\\]|\\.)*?)(?<!\s)\$(?!\d)/g` applied to one
/// line. `line_from` is the line's byte offset in the document; regions whose
/// span overlaps any entry of `existing` are dropped (`inRanges` guard).
fn scan_inline_in_line(
    line: &str,
    line_from: usize,
    existing: &[MathRegion],
    out: &mut Vec<MathRegion>,
) {
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;
    while i < len {
        if bytes[i] != b'$' {
            i += 1;
            continue;
        }
        // (?<![\\$])
        if i > 0 && (bytes[i - 1] == b'\\' || bytes[i - 1] == b'$') {
            i += 1;
            continue;
        }
        // (?!\s)
        if i + 1 >= len || super::is_js_ws(bytes[i + 1]) {
            i += 1;
            continue;
        }
        // Lazy content: scan for the first unescaped `$` (content cannot
        // contain `$`, so that is the only closing candidate).
        let mut j = i + 1;
        let mut close: Option<usize> = None;
        while j < len {
            if bytes[j] == b'\\' {
                if j + 1 >= len {
                    break; // `\\.` needs a char after the backslash
                }
                j += 2;
            } else if bytes[j] == b'$' {
                close = Some(j);
                break;
            } else {
                j += 1;
            }
        }
        let Some(close) = close else { break };
        // (?<!\s) before the closing `$` (empty content checks the opening
        // `$`, which is never whitespace).
        let ws_before = close > i + 1 && super::is_js_ws(bytes[close - 1]);
        // (?!\d) after the closing `$`.
        let digit_after = close + 1 < len && bytes[close + 1].is_ascii_digit();
        if !ws_before && !digit_after {
            // Match consumed up to the end of the closing `$` (an empty
            // content still advances lastIndex, mirroring the TS loop).
            if close > i + 1 {
                let from = line_from + i;
                let to = line_from + close + 1;
                if !in_ranges(from, to, existing) {
                    out.push(MathRegion {
                        from,
                        to,
                        display: false,
                        content: line[i + 1..close].to_string(),
                    });
                }
            }
            i = close + 1;
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regions(doc: &str) -> Vec<MathRegion> {
        scan_math(doc)
    }

    fn display(doc: &str) -> Vec<MathRegion> {
        regions(doc).into_iter().filter(|r| r.display).collect()
    }

    /** 正文片段是否被吞进任何公式区域(防"正文被吞"的核心断言)。 */
    fn inside_any(doc: &str, needle: &str) -> bool {
        let at = doc.find(needle).expect("needle must exist");
        regions(doc)
            .iter()
            .any(|r| at >= r.from && at + needle.len() <= r.to)
    }

    #[test]
    fn normal_block_math_is_recognized() {
        let rs = display("$$\nx=1\n$$\n后面");
        assert_eq!(
            rs,
            vec![MathRegion {
                from: 0,
                to: 9,
                display: true,
                content: "\nx=1\n".into()
            }]
        );
    }

    #[test]
    fn blocks_in_separate_paragraphs_pair_independently() {
        let rs = display("$$\na\n$$\n\n文字\n\n$$\nb\n$$\n\n结尾");
        let contents: Vec<&str> = rs.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(contents, ["\na\n", "\nb\n"]);
    }

    #[test]
    fn block_with_leading_blank_lines_still_renders() {
        let rs = display("$$\n\nE=mc^2\n$$\n\n正文");
        assert_eq!(
            rs,
            vec![MathRegion {
                from: 0,
                to: 13,
                display: true,
                content: "\n\nE=mc^2\n".into()
            }]
        );
    }

    #[test]
    fn block_with_trailing_blank_line_is_still_math() {
        let rs = display("$$\nx=1\n\n$$\n后面");
        assert_eq!(
            rs,
            vec![MathRegion {
                from: 0,
                to: 10,
                display: true,
                content: "\nx=1\n\n".into()
            }]
        );
    }

    #[test]
    fn empty_block_is_still_math() {
        let rs = display("$$\n\n$$\n后面");
        assert_eq!(
            rs,
            vec![MathRegion {
                from: 0,
                to: 6,
                display: true,
                content: "\n\n".into()
            }]
        );
    }

    #[test]
    fn blank_on_both_sides_is_mispairing_rejected_and_body_not_swallowed() {
        let doc = "$$\na\n\nb\n$$\n后面";
        assert!(display(doc).is_empty());
        assert!(!inside_any(doc, "a"));
        assert!(!inside_any(doc, "b"));
    }

    #[test]
    fn after_deleting_one_dollar_good_formula_below_still_pairs() {
        // 用户场景:四个 $$ 删掉一个,栈式配对让 m1-m2 被拒,m2-m3(完好公式)照常成对
        let doc = "因为\n1\n$$\n\n后面段落A\n\n$$\n.x\n$$\n\n结尾";
        let rs = display(doc);
        let contents: Vec<&str> = rs.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(contents, ["\n.x\n"]);
        assert!(!inside_any(doc, "后面段落A"));
        assert!(!inside_any(doc, "结尾"));
    }

    #[test]
    fn typing_above_a_formula_does_not_disturb_it_and_pairs_once_closed() {
        let doc = "$$\nE\n\n正文\n\n$$\nF\n$$";
        let rs = display(doc);
        let contents: Vec<&str> = rs.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(contents, ["\nF\n"]);
        assert!(!inside_any(doc, "正文"));
        // 上方补上闭合 $$ 后,打字中的公式也整体配对渲染
        let rs = display("$$\nE\n$$\n\n正文\n\n$$\nF\n$$");
        let contents: Vec<&str> = rs.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(contents, ["\nE\n", "\nF\n"]);
    }

    #[test]
    fn stray_dollar_pair_renders_only_to_paragraph_end() {
        let doc = "$$\nx=1\n\n后面文字";
        let rs = display(doc);
        assert_eq!(
            rs,
            vec![MathRegion {
                from: 0,
                to: 6,
                display: true,
                content: "\nx=1".into()
            }]
        );
        assert!(doc.find("后面文字").unwrap() > rs[0].to - 1);
    }

    #[test]
    fn stray_dollar_pair_before_blank_line_stays_on_its_own_line() {
        let rs = display("a\n\n$$\n\n结尾");
        assert_eq!(
            rs,
            vec![MathRegion {
                from: 3,
                to: 5,
                display: true,
                content: "".into()
            }]
        );
        assert!(!inside_any("a\n\n$$\n\n结尾", "结尾"));
    }

    #[test]
    fn unclosed_dollar_pair_runs_to_document_end() {
        // TS fixture asserts UTF-16 offsets (前文 = 2 units); here byte
        // offsets: 前文 = 6 bytes → $$ at 8, stray region to 8+2+4.
        let rs = display("前文\n\n$$\nx=1");
        assert_eq!(
            rs,
            vec![MathRegion {
                from: 8,
                to: 14,
                display: true,
                content: "\nx=1".into()
            }]
        );
    }

    #[test]
    fn blank_line_inside_complete_env_is_exempt() {
        let doc = "$$\n\\begin{align}\nE[q_{i}^{2}]=Var(q_{i})\n\n\\end{align}\n$$";
        let rs = display(doc);
        assert_eq!(rs.len(), 1);
        assert_eq!(
            rs[0].content,
            "\n\\begin{align}\nE[q_{i}^{2}]=Var(q_{i})\n\n\\end{align}\n"
        );
    }

    #[test]
    fn env_blank_lines_on_both_sides_are_exempt_too() {
        assert_eq!(display("$$\n\\begin{align}\n\nx\n\\end{align}\n$$").len(), 1);
        assert_eq!(display("$$\n\\begin{align}\nx\n\\end{align}\n\n$$").len(), 1);
    }

    #[test]
    fn blank_line_inside_nested_envs_is_exempt() {
        let doc = "$$\n\\begin{align}\n\\begin{cases}\n1\n\n2\n\\end{cases}\n\\end{align}\n$$";
        assert_eq!(display(doc).len(), 1);
    }

    #[test]
    fn blank_after_env_closed_still_a_paragraph_boundary() {
        let doc = "$$\n\\begin{align}\nx\n\\end{align}\n\n后面段落A\n\n$$";
        assert_eq!(display(doc).len(), 0);
        assert!(!inside_any(doc, "后面段落A"));
    }

    #[test]
    fn begin_without_end_gets_no_exemption() {
        let doc = "$$\n\\begin{align}\nx\n\n后面段落A\n$$";
        assert!(!inside_any(doc, "后面段落A"));
    }

    #[test]
    fn escaped_dollars_are_not_delimiters() {
        assert!(regions("\\$\\$ 不是公式").is_empty());
    }

    #[test]
    fn inline_math_still_works() {
        // TS fixture asserts UTF-16 offset 3; 因为 = 6 bytes → $ at 7.
        let rs = regions("因为 $x_1$ 文字");
        assert_eq!(
            rs,
            vec![MathRegion {
                from: 7,
                to: 12,
                display: false,
                content: "x_1".into()
            }]
        );
    }

    #[test]
    fn inline_math_not_lost_to_block_guard() {
        // 错位配对被拒后,该行文本回归普通行,行内公式照常识别
        let doc = "值 $a$ 与 $b$\n\n$$\n\n后面";
        let rs = regions(doc);
        assert!(rs.iter().any(|r| r.content == "a" && !r.display));
        assert!(rs.iter().any(|r| r.content == "b" && !r.display));
    }
}
