//! Port of `src/editor/callout.ts` — `:::` container (callout) region scan.
//!
//! Offsets are UTF-8 byte offsets into the input `&str` (see [`crate::markdown`]).
//! Line numbers are 1-based, like CodeMirror's `doc.line(n)`. `compute_callout_regions`
//! is a pure function of (text, fences, maths) so the host can memoize per
//! document generation.
//!
//! Callout 块(`:::` 容器):笔记里承接「与正文不那么一体的外部内容」的块——
//! 独立底色 + 左侧竖线,内容照常按 markdown 渲染(标题/公式/代码块全部走既有
//! 装饰路径),块内标题编号独立于外部(numbering 按这里的区域重置计数器)。
//!
//! 语法(只认栏 0,3 个及以上冒号):
//!   `::: 可选标题` → 开。有非空文字 = 标题,渲染成块顶的小标签;无文字 = 无
//!                    标题的裸块(不需要 Obsidian 的 [!note] 类型名)。
//!   `:::`          → 栈式语义:在块外 = 开一个无标题块,在块内 = 关最内层。
//!                    与代码围栏「同一标记开关」的手感一致;带文字的标记必开,
//!                    嵌套内层因此用 `::: 标题` 开。
//!
//! 扫描与 fence_state_scan 同一条模型:纯行扫描(不依赖语法树,文件刚载入树未
//! 解析时答案也完整确定),按行推进配对;围栏代码行与公式块内的 `:::` 一律
//! 忽略(代码围栏里它是字面量,`$$` 块里它属于公式源码);未闭合延伸到文末,
//! 与未闭合围栏同款。

/// One `:::` container region. Field names mirror the TS `CalloutRegion`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalloutRegion {
    /// 开标记行行首。整块范围 [from, to) 含两行边界标记。
    pub from: usize,
    /// 关标记行行尾;未闭合时为文末行行尾。
    pub to: usize,
    /// 开标记行号(1-based)。
    pub open_line: usize,
    /// 关标记行号(1-based);未闭合 = 最后一行。
    pub close_line: usize,
    /// 开标记 `:::` 之后的文字(trim 过;空串 = 无标题)。
    pub title: String,
    /// 嵌套深度,0 = 最外层。
    pub depth: usize,
    /// false = 未闭合(延伸到文末)。
    pub closed: bool,
}

/// Port of `src/editor/callout.ts::computeCalloutRegions` (the TS module's
/// memoized `calloutRegions(view.state)` wrapper is host-side caching and
/// stays there).
///
/// 纯函数版扫描:调用方已持有围栏状态/公式区域时直接传入(numbering 的重编号
/// 本来就算了一遍围栏扫描,不重复付)。返回按 from 升序——外层区域必在嵌套
/// 内层之前,依赖顺序的消费者(逐行深度标注)可安全覆盖。
pub fn compute_callout_regions(
    text: &str,
    fences: &[bool],
    maths: &[super::math_scan::MathRegion],
) -> Vec<CalloutRegion> {
    let lines = super::line_ranges(text);
    let mut out: Vec<CalloutRegion> = Vec::new();
    struct Open {
        open_line: usize,
        from: usize,
        title: String,
        depth: usize,
    }
    let mut stack: Vec<Open> = Vec::new();
    // 只有可能跨行的 display 公式区域容得下一个栏 0 的 `:::`(行内区域起点是
    // `$`,起点在栏 0 的行首不可能是 `:::` 行);按 from 有序,随行推进一次扫过。
    let display: Vec<&super::math_scan::MathRegion> =
        maths.iter().filter(|r| r.display).collect();
    let mut mi = 0usize;
    for (n, (from, to)) in lines.iter().enumerate() {
        let n = n + 1; // 1-based, like the TS loop
        while mi < display.len() && display[mi].to < *from {
            mi += 1;
        }
        let in_math =
            mi < display.len() && display[mi].from <= *from && *from <= display[mi].to;
        if fences.get(n - 1).copied().unwrap_or(false) || in_math {
            continue;
        }
        let line = &text[*from..*to];
        // /^(:{3,})(.*)$/ — the greedy run swallows every leading colon.
        let colons = line.bytes().take_while(|b| *b == b':').count();
        if colons < 3 {
            continue;
        }
        let rest = line[colons..].trim();
        if !stack.is_empty() && rest.is_empty() {
            let open = stack.pop().unwrap();
            out.push(CalloutRegion {
                from: open.from,
                to: *to,
                open_line: open.open_line,
                close_line: n,
                title: open.title,
                depth: open.depth,
                closed: true,
            });
        } else {
            stack.push(Open {
                open_line: n,
                from: *from,
                title: rest.to_string(),
                depth: stack.len(),
            });
        }
    }
    let last_to = lines.last().map_or(0, |(_, to)| *to);
    while let Some(open) = stack.pop() {
        out.push(CalloutRegion {
            from: open.from,
            to: last_to,
            open_line: open.open_line,
            close_line: lines.len(),
            title: open.title,
            depth: open.depth,
            closed: false,
        });
    }
    out.sort_by_key(|r| r.from);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::context::fence_state_scan;
    use crate::markdown::math_scan::scan_math;

    /// 纯行扫描入口:围栏状态与公式区域按同一份文档现算。
    fn scan(text: &str) -> Vec<CalloutRegion> {
        compute_callout_regions(text, &fence_state_scan(text), &scan_math(text))
    }

    fn region_of(text: &str) -> CalloutRegion {
        let regions = scan(text);
        assert_eq!(regions.len(), 1);
        regions.into_iter().next().unwrap()
    }

    #[test]
    fn untitled_block_open_close_span_both_markers() {
        let doc = ":::\n内容行\n:::";
        let r = region_of(doc);
        assert_eq!(r.open_line, 1);
        assert_eq!(r.close_line, 3);
        assert_eq!(r.title, "");
        assert_eq!(r.depth, 0);
        assert!(r.closed);
        assert_eq!(r.from, 0);
        assert_eq!(r.to, doc.len());
    }

    #[test]
    fn titled_block_trims_marker_text() {
        let r = region_of(":::  注意事项  \n内容\n:::");
        assert_eq!(r.title, "注意事项");
    }

    #[test]
    fn bare_marker_outside_opens_inside_closes() {
        let regions = scan(":::\n甲\n:::\n乙\n:::\n丙");
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].open_line, 1);
        assert_eq!(regions[0].close_line, 3);
        assert_eq!(regions[1].open_line, 5);
        assert!(!regions[1].closed); // 最后一个 ::: 开块未闭合
    }

    #[test]
    fn nesting_titled_always_opens_output_sorted_by_from() {
        let regions = scan("::: 外\n::: 内\n甲\n:::\n:::");
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].open_line, 1);
        assert_eq!(regions[0].close_line, 5);
        assert_eq!(regions[0].depth, 0);
        assert_eq!(regions[1].open_line, 2);
        assert_eq!(regions[1].close_line, 4);
        assert_eq!(regions[1].depth, 1);
        assert_eq!(regions[1].title, "内");
    }

    #[test]
    fn markers_inside_code_fence_ignored() {
        let r = region_of(":::\n```\n:::\n```\n:::");
        assert_eq!(r.open_line, 1);
        assert_eq!(r.close_line, 5);
    }

    #[test]
    fn markers_inside_math_block_ignored() {
        assert!(scan("$$\n:::\n$$").is_empty());
        // 公式块之后正文里的 ::: 照常生效
        let r = region_of("$$\n:::\n$$\n:::\n内容\n:::");
        assert_eq!(r.open_line, 4);
    }

    #[test]
    fn unclosed_extends_to_document_end() {
        let r = region_of(":::\n甲\n乙");
        assert!(!r.closed);
        assert_eq!(r.close_line, 3);
    }

    #[test]
    fn only_column_zero_counts() {
        let r = region_of("  :::\n甲\n:::");
        assert_eq!(r.open_line, 3);
        assert!(!r.closed);
    }

    #[test]
    fn four_or_more_colons_same_as_three_mid_line_not_a_marker() {
        let r = region_of("::::\n甲\n::::");
        assert_eq!(r.open_line, 1);
        assert_eq!(r.close_line, 3);
        assert!(scan("文字 ::: 文字").is_empty());
    }

    #[test]
    fn inline_math_in_title_does_not_break_opening() {
        let r = region_of("::: 命题 $P \\Rightarrow Q$\n甲\n:::");
        assert_eq!(r.title, "命题 $P \\Rightarrow Q$");
    }

    #[test]
    fn math_block_inside_callout_pairs_normally() {
        let r = region_of(":::\n$$\nx\n$$\n:::");
        assert_eq!(r.open_line, 1);
        assert_eq!(r.close_line, 5);
    }

    #[test]
    fn blocks_separated_by_blank_line_are_independent() {
        let regions = scan("::: 甲\n一\n:::\n\n::: 乙\n二\n:::");
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].title, "甲");
        assert_eq!(regions[1].title, "乙");
    }
}
