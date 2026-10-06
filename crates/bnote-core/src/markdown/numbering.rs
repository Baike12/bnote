//! Port of `src/editor/numbering.ts` — hierarchical heading auto-numbering.
//!
//! Offsets are UTF-8 byte offsets into the input `&str` (see [`crate::markdown`]).
//! Line numbers are 1-based, like CodeMirror's `doc.line(n)`.
//!
//! Hierarchical heading numbering: every ATX heading outside code gets a
//! `1.1.2`-style number based on document order (`##` after the first `#`
//! becomes `1.1`, the next `#` resets `##` to `2.1`, …). Existing number
//! prefixes are replaced, so toggling headings keeps the whole document
//! consistent. Replacement only touches the `## old-number` prefix, so the
//! cursor inside the title text maps through unchanged.
//!
//! Heading collection is a plain line scan, not a syntax-tree walk: right
//! after a file switch the tree is still unparsed and a tree query silently
//! misses headings (partial numbering that then sticks). A scan is complete
//! and deterministic at any time; fenced code is excluded by tracking ```
//! / ~~~ toggles (fences indented deeper than 3 spaces — inside nested list
//! items — are only recognized by the tree, which is fine since the scan is
//! only ever a fallback-grade approximation of the same rule).
//!
//! Callout 块(`:::` 容器)是独立的编号作用域:**每个区域**进栈时把外部计数器
//! 入栈并清零,出栈时原样恢复——块内标题从 1 重新数,块外序列像块内不存在一样
//! 继续。兄弟块(先后两个平级 callout)不共享计数器,各自从 1;嵌套块逐层
//! 入栈,内层再从头数。作用域按「区域身份路径」(外层→内层的区域链)对齐,
//! 不按深度数值——深度相同的两个兄弟块也是不同作用域。

/// One replacement produced by [`renumber_changes`] — same shape as the TS
/// `{ from, to, insert }` change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

/// `/^\d+(\.\d+)*[ \t]+/` — an existing number prefix, hand-parsed: digits
/// and `.digit+` groups, then at least one space/tab.
fn strip_old_number(rest: &str) -> &str {
    let bytes = rest.as_bytes();
    let mut i = 0usize;
    let start_digs = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start_digs {
        return rest;
    }
    loop {
        if i < bytes.len() && bytes[i] == b'.' {
            let dot = i;
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j == dot + 1 {
                break; // `\.\d+` needs at least one digit
            }
            i = j;
        } else {
            break;
        }
    }
    // `[ \t]+` required after the number.
    let mut j = i;
    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
        j += 1;
    }
    if j == i {
        return rest;
    }
    &rest[j..]
}

/// Length in bytes of a leading old-number prefix (`/^\d+(\.\d+)*[ \t]+/`),
/// 0 when the line has none. Used to clean the prefix a heading leaves behind
/// when it is demoted to a paragraph.
pub fn leading_number_len(line: &str) -> usize {
    line.len() - strip_old_number(line).len()
}

/// `/^(#{1,6})([ \t]+.*)?$/` — a heading owning its whole line from column 0.
/// Returns the level (hash count).
pub fn heading_level_of_line(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut level = 0usize;
    while level < bytes.len() && bytes[level] == b'#' && level < 6 {
        level += 1;
    }
    if level == 0 {
        return None;
    }
    // Greedy backtracking of `#{1,6}`: shrink until the remainder is
    // end-of-line or starts with space/tab.
    let mut l = level;
    loop {
        let rest = &bytes[l..];
        if rest.is_empty() || rest[0] == b' ' || rest[0] == b'\t' {
            return Some(l);
        }
        if l == 1 {
            return None;
        }
        l -= 1;
    }
}

/// Port of `src/editor/numbering.ts::renumberChanges` — replacement list for
/// one renumbering pass, [] when the numbering is already up to date. Each
/// change rewrites one heading's prefix up to the title text. Pure function,
/// no view dependency.
pub fn renumber_changes(text: &str) -> Vec<Edit> {
    let fences = super::context::fence_state_scan(text);
    let maths = super::math_scan::scan_math(text);
    let regions =
        super::callout::compute_callout_regions(text, &fences, &maths);
    // 每个区域的最小包络父区域(区域按 from 升序且正确嵌套;从右往左找第一个
    // 装住自己的,就是最内层父区域)。
    let mut parent = vec![-1i64; regions.len()];
    for i in 0..regions.len() {
        for j in (0..i).rev() {
            if regions[j].open_line <= regions[i].open_line
                && regions[i].close_line <= regions[j].close_line
            {
                parent[i] = j as i64;
                break;
            }
        }
    }
    // 标题所在的作用域路径:外层→内层的区域下标链。
    let path_of = |line_no: usize| -> Vec<usize> {
        let mut idx: i64 = -1;
        for (i, r) in regions.iter().enumerate().rev() {
            if r.open_line <= line_no && line_no <= r.close_line {
                idx = i as i64;
                break;
            }
        }
        let mut path = Vec::new();
        let mut r = idx;
        while r != -1 {
            path.insert(0, r as usize);
            r = parent[r as usize];
        }
        path
    };

    let lines = super::line_ranges(text);
    let mut heads: Vec<(usize, usize)> = Vec::new(); // (line_no, level)
    for (n, (from, to)) in lines.iter().enumerate() {
        let n = n + 1;
        if fences.get(n - 1).copied().unwrap_or(false) {
            continue;
        }
        // Only headings that own their whole line from column 0 (not
        // list-embedded, matching the previous tree-based rule).
        if let Some(level) = heading_level_of_line(&text[*from..*to]) {
            heads.push((n, level));
        }
    }
    if heads.is_empty() {
        return Vec::new();
    }

    let mut counters = [0usize; 7];
    let mut saved: Vec<[usize; 7]> = Vec::new();
    let mut prev_path: Vec<usize> = Vec::new();
    let mut cur_depth = 0usize;
    let mut changes: Vec<Edit> = Vec::new();

    for (line_no, level) in heads {
        // Callout 作用域进出:与上一个标题的作用域路径求公共前缀,弹出的层恢复
        // 计数器,新进的层清零。深度可能一跳多层(嵌套块里第一个标题),循环补齐。
        let path = path_of(line_no);
        let mut common = 0usize;
        while common < path.len()
            && common < prev_path.len()
            && path[common] == prev_path[common]
        {
            common += 1;
        }
        while cur_depth > common {
            if let Some(outer) = saved.pop() {
                counters = outer;
            }
            cur_depth -= 1;
        }
        while cur_depth < path.len() {
            saved.push(counters);
            counters = [0; 7];
            cur_depth += 1;
        }
        prev_path = path;
        counters[level] += 1;
        for l in level + 1..=6 {
            counters[l] = 0;
        }
        // Strict level counters, then drop missing-parent (leading zero) parts so
        // a document starting at `##` numbers it "1" rather than "0.1".
        let mut parts: Vec<usize> = counters[1..=level].to_vec();
        while parts.len() > 1 && parts[0] == 0 {
            parts.remove(0);
        }
        let number = parts
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(".");

        let (from, to) = lines[line_no - 1];
        let line_text = &text[from..to];
        let hash = "#".repeat(level);
        // rest = line.text.slice(level).replace(/^[ \t]+/, "")
        let after_hash = &line_text[level.min(line_text.len())..];
        let rest = after_hash.trim_start_matches([' ', '\t']);
        let title = strip_old_number(rest);
        let title_start = to - title.len();
        let want = if !title.is_empty() {
            format!("{hash} {number} ")
        } else {
            format!("{hash} {number}")
        };
        let have = &line_text[..line_text.len() - title.len()];
        if have != want {
            changes.push(Edit {
                from,
                to: title_start,
                insert: want,
            });
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 跑一遍重编号并应用所有替换,返回结果文本。
    fn renumber(text: &str) -> String {
        let edits = renumber_changes(text);
        apply(text, &edits)
    }

    /// Applies edits back-to-front (they are produced in document order).
    fn apply(text: &str, edits: &[Edit]) -> String {
        let mut out = text.to_string();
        for e in edits.iter().rev() {
            out.replace_range(e.from..e.to, &e.insert);
        }
        out
    }

    #[test]
    fn callout_block_is_separate_numbering_scope() {
        assert_eq!(
            renumber("# 一\n:::\n## 定理\n:::\n# 二\n## 节"),
            "# 1 一\n:::\n## 1 定理\n:::\n# 2 二\n## 2.1 节"
        );
    }

    #[test]
    fn consecutive_blocks_restart_from_one() {
        assert_eq!(
            renumber(":::\n## 甲\n:::\n:::\n## 乙\n:::"),
            ":::\n## 1 甲\n:::\n:::\n## 1 乙\n:::"
        );
    }

    #[test]
    fn nested_blocks_reset_per_layer_and_restore_on_exit() {
        assert_eq!(
            renumber(":::\n## 甲\n::: 内\n## 乙\n:::\n## 丙\n:::\n# 后"),
            ":::\n## 1 甲\n::: 内\n## 1 乙\n:::\n## 2 丙\n:::\n# 1 后"
        );
    }

    #[test]
    fn old_numbers_normalized_and_second_pass_idempotent() {
        let once = renumber(":::\n## 3.1 旧\n### 2 深\n:::");
        assert_eq!(once, ":::\n## 1 旧\n### 1.1 深\n:::");
        assert_eq!(renumber(&once), once);
    }

    #[test]
    fn fenced_hash_lines_and_callout_marker_lines_are_not_headings() {
        assert_eq!(
            renumber(":::\n```\n## 不算\n```\n:::\n# 一"),
            ":::\n```\n## 不算\n```\n:::\n# 1 一"
        );
    }

    #[test]
    fn heading_without_number_gets_one_only_when_out_of_date() {
        assert_eq!(renumber("# 一"), "# 1 一");
        // Already correct: no changes.
        assert!(renumber_changes("# 1 一").is_empty());
    }

    #[test]
    fn leftover_number_length_is_the_prefix_the_demotion_must_strip() {
        // A heading demoted to a paragraph keeps its number text; this is the
        // span the command path deletes.
        assert_eq!(leading_number_len("1.2.3 标题"), 6);
        assert_eq!(leading_number_len("1\t标题"), 2);
        assert_eq!(leading_number_len("标题"), 0);
        assert_eq!(leading_number_len("1.2标题"), 0, "no separator, not a prefix");
        assert_eq!(leading_number_len(""), 0);
    }

    #[test]
    fn heading_level_reads_whole_line_atx_headings() {
        assert_eq!(heading_level_of_line("# a"), Some(1));
        assert_eq!(heading_level_of_line("###### a"), Some(6));
        assert_eq!(heading_level_of_line("#"), Some(1), "bare hashes are a heading");
        assert_eq!(heading_level_of_line("#a"), None, "needs a space");
        assert_eq!(heading_level_of_line("####### a"), None, "seven is not a heading");
        assert_eq!(heading_level_of_line("  # a"), None, "indented, not column 0");
    }

    #[test]
    fn level_skips_drop_leading_zero_parts() {
        // A document starting at ## numbers it "1", not "0.1".
        assert_eq!(renumber("## 甲\n## 乙\n### 丙"), "## 1 甲\n## 2 乙\n### 2.1 丙");
    }
}
