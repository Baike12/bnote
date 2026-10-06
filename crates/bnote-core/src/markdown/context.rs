//! Port of `src/editor/context.ts` — fence-state scanning, fenced-code
//! detection and `\text{}` nesting (the pieces that are pure logic and do not
//! need a CodeMirror syntax tree).
//!
//! Offsets are UTF-8 byte offsets into the input `&str` (see [`crate::markdown`]).
//! Line numbers are 1-based, like CodeMirror's `doc.line(n)`.
//!
//! Not ported: the syntax-tree branch of TS `insideFencedCode` / the
//! `InlineCode` / `CodeInfo` lookups of TS `getContextAt` — those need the
//! lezer tree. The scan path below is the fallback-grade semantics the TS
//! module itself defines; the host wires tree availability on top.

/// CommonMark 围栏标记:行首最多 3 个空格 + 至少 3 个 ` 或 ~。
/// Returns the fence char, its run length and the rest of the line.
pub(crate) fn parse_fence(line: &str) -> Option<(u8, usize, &str)> {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < 3 && i < bytes.len() && bytes[i] == b' ' {
        i += 1;
    }
    if i >= bytes.len() || (bytes[i] != b'`' && bytes[i] != b'~') {
        return None;
    }
    let ch = bytes[i];
    let start = i;
    while i < bytes.len() && bytes[i] == ch {
        i += 1;
    }
    if i - start < 3 {
        return None;
    }
    Some((ch, i - start, &line[i..]))
}

/**
 * Port of `src/editor/context.ts::fenceStateScan`.
 *
 * 单遍扫描整篇文档,返回每行是否处于 ``` / ~~~ 围栏代码内(下标 = 行号-1;
 * 该行自身的围栏标记不影响它自己是否"在围栏内")。语法树在文件刚载入时
 * 还是空的(后台解析未完成),树查询会把围栏/标题整体漏掉——凡是必须在
 * 那个窗口期内给出确定答案的逻辑(回车续行、标题重编号)都用这个兜底。
 */
pub fn fence_state_scan(text: &str) -> Vec<bool> {
    let lines = super::line_ranges(text);
    let mut inside = Vec::with_capacity(lines.len());
    let mut open: Option<u8> = None;
    let mut open_len = 0usize;
    for (from, to) in lines {
        inside.push(open.is_some());
        let Some((ch, len, rest)) = parse_fence(&text[from..to]) else {
            continue;
        };
        match open {
            None => {
                open = Some(ch);
                open_len = len;
            }
            Some(o) if ch == o && len >= open_len && rest.trim().is_empty() => {
                open = None;
            }
            _ => {}
        }
    }
    inside
}

/// Port of `src/editor/context.ts::insideFencedCodeByScan`.
///
/// 第 `line_no` 行是否处于围栏代码内(按该行之前的行做围栏状态扫描)。
pub fn inside_fenced_code_by_scan(text: &str, line_no: usize) -> bool {
    let lines = super::line_ranges(text);
    let mut open: Option<u8> = None;
    let mut open_len = 0usize;
    // TS scans lines strictly BEFORE lineNo (`for (let n = 1; n < lineNo; n++)`).
    for n in 1..line_no.min(lines.len() + 1) {
        let (from, to) = lines[n - 1];
        let Some((ch, len, rest)) = parse_fence(&text[from..to]) else {
            continue;
        };
        match open {
            None => {
                open = Some(ch);
                open_len = len;
            }
            Some(o) if ch == o && len >= open_len && rest.trim().is_empty() => {
                open = None;
            }
            _ => {}
        }
    }
    open.is_some()
}

/// Snippet context classification, mirroring the TS `EditContext` fields.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EditContext {
    /// Inside $…$
    pub inline_math: bool,
    /// Inside $$…$$
    pub block_math: bool,
    /// Inside \text{…} within math
    pub text_env: bool,
    /// Inside a fenced code block (scan-based: inline code needs the tree).
    pub code: bool,
    /// Language of the enclosing fenced code block, `None` when not in one
    /// (TS models "no lang" as `true`; here `Some("")`).
    pub code_block: Option<String>,
    /// None of the above (plain markdown text)
    pub is_text: bool,
}

/// Port of `src/editor/context.ts::getContextAt`, scan-grade: fenced-code
/// membership comes from [`fence_state_scan`] semantics (a fence marker line
/// itself counts as inside, matching the TS tree path), math membership from
/// the caller-provided memoized regions. Inline-code detection needs the
/// syntax tree and stays host-side; the returned `code` therefore only
/// reflects fenced blocks.
pub fn context_at_scan(
    text: &str,
    pos: usize,
    math: &[super::math_scan::MathRegion],
) -> EditContext {
    let lines = super::line_ranges(text);
    let line_no = lines
        .iter()
        .position(|(from, to)| pos >= *from && pos <= *to)
        .map_or(lines.len(), |i| i + 1);
    // The tree path counts the fence marker line itself as inside; reproduce
    // that by scanning lines up to and including this one.
    let code_block = in_fenced_block_with_lang(text, line_no);

    let mut ctx = EditContext::default();
    if let Some(lang) = code_block {
        ctx.code = true;
        ctx.code_block = Some(lang);
    } else {
        for region in math {
            if pos >= region.from && pos <= region.to {
                if region.display {
                    ctx.block_math = true;
                } else {
                    ctx.inline_math = true;
                }
                ctx.text_env = inside_text_env(region, pos);
                break;
            }
        }
    }
    ctx.is_text = !ctx.code && !ctx.inline_math && !ctx.block_math;
    ctx
}

/// Walks lines 1..=upto and returns the fence info string of the still-open
/// block (the TS tree query resolves the enclosing FencedCode node; the scan
/// equivalent is the open fence's rest-of-line, trimmed — `Some("")` for a
/// bare fence). `None` when not inside a fence.
fn in_fenced_block_with_lang(text: &str, upto: usize) -> Option<String> {
    let lines = super::line_ranges(text);
    let mut open: Option<u8> = None;
    let mut open_len = 0usize;
    let mut lang = String::new();
    for n in 1..upto.min(lines.len()) + 1 {
        let (from, to) = lines[n - 1];
        let Some((ch, len, rest)) = parse_fence(&text[from..to]) else {
            continue;
        };
        match open {
            None => {
                open = Some(ch);
                open_len = len;
                lang = rest.trim().to_string();
            }
            Some(o) if ch == o && len >= open_len && rest.trim().is_empty() => {
                open = None;
            }
            _ => {}
        }
    }
    open.map(|_| lang)
}

/// Port of `src/editor/context.ts::insideTextEnv` — checks whether `pos`
/// falls inside a `\text{…}` group of a math region.
///
/// Note kept from the TS source: `base = region.from + 2` assumes the 2-char
/// `$$` delimiter even for inline regions (an off-by-one the TS ships with);
/// ported verbatim to preserve behavior.
pub fn inside_text_env(region: &super::math_scan::MathRegion, pos: usize) -> bool {
    if !region.content.contains("\\text") {
        return false;
    }
    let base = region.from + 2; // content offset within region
    let content = &region.content;
    let idx = match pos.checked_sub(base) {
        Some(i) => i,
        None => return false,
    };
    if idx > content.len() {
        return false;
    }
    let bytes = content.as_bytes();

    // /\\text\s*\{/g — find each `\text` opener.
    let mut search = 0usize;
    while let Some(rel) = content[search..].find("\\text") {
        let at = search + rel;
        search = at + 5;
        let mut j = at + 5;
        while j < bytes.len() && super::is_js_ws(bytes[j]) {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b'{' {
            continue;
        }
        let open_brace = j;
        let mut depth = 0i32;
        let mut i = open_brace;
        while i < content.len() {
            let ch = content[i..].chars().next().unwrap();
            if ch == '\\' {
                i += ch.len_utf8();
                // skip escaped char
                if let Some(esc) = content[i..].chars().next() {
                    i += esc.len_utf8();
                }
                continue;
            }
            if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                if depth == 0 {
                    if idx > open_brace && idx <= i {
                        return true;
                    }
                    break;
                }
            }
            i += ch.len_utf8();
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /** 「光标在不在围栏代码块内」的共享判定(IME 保持英文、回车续行守卫共用):
     *  - 树就绪:走语法树查询,围栏标记行自身也算块内;
     *  - 树未就绪(文件刚载入,后台解析未完成):退回行扫描,围栏标记行不算。
     *
     *  node 环境里语法树在 EditorState.create 时就同步解析完成,insideFencedCode
     *  的兜底分支在 TS 单测里无法驱动——这里直接锁住兜底所用的纯函数
     *  (与 fenceStateScan 同一扫描模型),两条路径的差异(围栏行自身)在
     *  断言里写死,防止只改一边。 */

    const DOC: &str = "```python\nx = 1\n```\n正文\n\n```ts\nconst b = 2;";

    #[test]
    fn content_lines_inside_open_line_outside() {
        assert!(!inside_fenced_code_by_scan(DOC, 1)); // ```python 开栏行:处理到它才开栏
        assert!(inside_fenced_code_by_scan(DOC, 2));
        assert!(inside_fenced_code_by_scan(DOC, 3)); // ``` 闭栏行:该行之前的行仍开着
        assert!(!inside_fenced_code_by_scan(DOC, 4));
    }

    #[test]
    fn unclosed_fence_runs_to_document_end() {
        assert!(inside_fenced_code_by_scan(DOC, 7));
    }

    #[test]
    fn known_tree_vs_scan_difference_is_only_the_marker_line() {
        // 树:FencedCode 含标记行;扫描:开栏行不算(语义差异写死在此)。
        assert!(!inside_fenced_code_by_scan(DOC, 1));
        assert!(!fence_state_scan(DOC)[0]); // 开栏行自身不在
        assert!(fence_state_scan(DOC)[2]); // 闭栏行按扫描语义算在内
    }

    #[test]
    fn fence_state_scan_marks_whole_document() {
        let doc =
            "正文一段\n\n```python\nx = 1\nprint(x)\n```\n\n~~~ts\nconst a = 1;\n~~~\n";
        let inside = fence_state_scan(doc);
        assert_eq!(inside.len(), 11); // trailing \n → one final empty line
        assert!(!inside[0]);
        assert!(!inside[1]);
        assert!(!inside[2]); // 开栏行自身不在
        assert!(inside[3]);
        assert!(inside[4]);
        assert!(inside[5]); // 闭栏行:之前的行仍开着
        assert!(!inside[6]);
        assert!(!inside[7]);
        assert!(inside[8]);
        assert!(inside[9]);
        assert!(!inside[10]);
    }

    #[test]
    fn tilde_fence_recognized_and_deep_indent_ignored() {
        // 波浪号围栏同样识别;4 空格缩进的 ``` 不是栏 0 围栏(缩进 > 3)。
        let doc = "~~~\na\n~~~\n    ```\nb\n```";
        let inside = fence_state_scan(doc);
        // Last line's ``` opens a NEW block (the 4-space ``` never opened),
        // so it is not "inside" itself.
        assert_eq!(inside, vec![false, true, true, false, false, false]);
    }

    #[test]
    fn text_env_inside_group() {
        // content: "\n\\text{abc} + x\n", from = 0 → base = 2,
        // group braces at content idx 7 ('{') .. 11 ('}') → pos 8..=11 inside.
        let region = super::super::math_scan::MathRegion {
            from: 0,
            to: 30,
            display: true,
            content: "\n\\text{abc} + x\n".into(),
        };
        assert!(inside_text_env(&region, 9));
        assert!(!inside_text_env(&region, 13)); // after the closing brace
        assert!(!inside_text_env(&region, 1)); // before any \text
    }

    #[test]
    fn text_env_brace_depth_and_escapes() {
        // content: \text{a\{b} — escaped brace does not close the group.
        let region = super::super::math_scan::MathRegion {
            from: 0,
            to: 20,
            display: true,
            content: "\\text{a\\{b}".into(),
        };
        // base = 2; open brace at content idx 5, real close at idx 10.
        // Inside: idx in 6..=10 → pos in 8..=12.
        assert!(inside_text_env(&region, 8));
        assert!(!inside_text_env(&region, 7)); // idx 5 = the open brace itself
        assert!(!inside_text_env(&region, 13)); // past the real closing brace
    }

    #[test]
    fn text_env_requires_the_marker() {
        let region = super::super::math_scan::MathRegion {
            from: 0,
            to: 10,
            display: true,
            content: "\nx=1\n".into(),
        };
        assert!(!inside_text_env(&region, 3));
    }

    #[test]
    fn context_at_scan_classifies_math_and_fence() {
        let doc = "$$x$$\n正文 $y$\n```\ncode\n```";
        let math = super::super::math_scan::scan_math(doc);
        // pos 2: inside the block math region
        let ctx = context_at_scan(doc, 2, &math);
        assert!(ctx.block_math);
        assert!(!ctx.is_text);
        // pos inside fenced code
        let ctx = context_at_scan(doc, doc.find("code").unwrap(), &math);
        assert!(ctx.code);
        assert_eq!(ctx.code_block, Some(String::new()));
        // plain text position
        let ctx = context_at_scan(doc, doc.find("正文").unwrap(), &math);
        assert!(ctx.is_text);
        // inline math
        let ctx = context_at_scan(doc, doc.find("y").unwrap(), &math);
        assert!(ctx.inline_math);
    }
}
