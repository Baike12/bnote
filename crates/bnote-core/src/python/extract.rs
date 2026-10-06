//! markdown 里 python 围栏代码块的提取与「行对齐虚拟文件」合成
//! (`src/python/extract.ts` 的移植)。
//!
//! 核心模型:一篇 markdown 的所有 ```python 围栏内容,按行号原位拼成一个
//! 虚拟 .py 文件 —— 非 python 行一律置空。虚拟文件与 markdown 逐行等长,
//! 所以 LSP 诊断、traceback 的行列号与 markdown 完全一致,零换算。
//!
//! 「把所有代码片段当一个 py 文件」的语义由空行保证:python 里空行不会闭合
//! 缩进块,原位拼接与直接顺序拼接在语法上等价,但行号对齐让错误定位免费。

/// 一段 python 围栏内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonBlock {
    /// 围栏内容首行(0 基,不含 ``` 开栏行)。
    pub start_line: usize,
    /// 围栏内容末行(0 基,不含闭栏行;未闭合围栏到文档末尾)。
    pub end_line: usize,
    /// 剥掉围栏公共缩进后的代码文本。
    pub text: String,
    /// 开栏行的缩进数;虚拟文件每行剥掉 min(indent, 行首空格) 列。
    pub indent: usize,
}

/// [`extract_python`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonExtract {
    pub blocks: Vec<PythonBlock>,
    /// 与原文档逐行等长的虚拟文件(非 python 行为空行)。
    pub virtual_text: String,
    /// 虚拟文件里识别到的模块级 main。
    pub has_main: bool,
    /// 原文里已有 `__name__` 守卫(用户自己管调用,不再追加)。
    pub has_main_guard: bool,
    /// 为「有 main 无守卫」追加的行数(0 或 3)。
    pub appended_lines: usize,
    /// 实际交给 python / LSP 的文本 = virtualText + 可能的 main 守卫。
    pub effective_text: String,
}

/// 识别为 python 的 info string 首词。
const PYTHON_LANGS: [&str; 3] = ["python", "py", "python3"];

/// 追加的守卫文本(与 TS 逐字节一致)。
const MAIN_GUARD: &str = "\n\nif __name__ == \"__main__\":\n    main()";

/// 快速判负:文档里连围栏标记都没有就无需解析(每次同步 tick 的省路)。
pub fn has_python_fence_hint(doc: &str) -> bool {
    doc.contains("```") || doc.contains("~~~")
}

/// 提取 python 围栏并合成行对齐虚拟文件。
pub fn extract_python(doc: &str) -> PythonExtract {
    let lines: Vec<&str> = doc.split('\n').collect();
    let mut virtual_lines: Vec<&str> = vec![""; lines.len()];
    let mut blocks: Vec<PythonBlock> = Vec::new();

    let mut i = 0usize;
    while i < lines.len() {
        let Some(open) = open_fence_of(lines[i]) else {
            i += 1;
            continue;
        };
        // 围栏内容区:从开栏下一行到闭栏前一行(或文档末尾)。
        let start_line = i + 1;
        let mut j = start_line;
        while j < lines.len() && !is_close_fence(lines[j], &open) {
            j += 1;
        }
        let end_line = j.saturating_sub(1);
        if PYTHON_LANGS.contains(&open.lang.as_str()) {
            let body = lines[start_line..j]
                .iter()
                .map(|l| strip_indent(l, open.indent))
                .collect::<Vec<_>>()
                .join("\n");
            blocks.push(PythonBlock { start_line, end_line, text: body, indent: open.indent });
            for k in start_line..=end_line {
                virtual_lines[k] = &lines[k][strip_col(lines[k], open.indent)..];
            }
        }
        i = if j < lines.len() { j + 1 } else { j };
    }

    let virtual_text = virtual_lines.join("\n");
    let has_main = virtual_text.split('\n').any(is_main_def);
    let has_main_guard = virtual_text.split('\n').any(is_main_guard);
    // 运行语义与跑一个 .py 文件一致:模块顶层 def main 存在且没人调它时,
    // 追加标准守卫;用户已写 __name__ 守卫就尊重原文。
    let append_guard = has_main && !has_main_guard;
    let effective_text = if append_guard {
        format!("{virtual_text}{MAIN_GUARD}")
    } else {
        virtual_text.clone()
    };
    PythonExtract {
        blocks,
        virtual_text,
        has_main,
        has_main_guard,
        appended_lines: if append_guard { 3 } else { 0 },
        effective_text,
    }
}

struct OpenFence {
    char: char,
    length: usize,
    /// 开栏行前导空格数(≤3),内容行剥掉不超过这个数的缩进。
    indent: usize,
    lang: String,
}

/// CommonMark 围栏开栏:≤3 空格缩进 + ≥3 个相同字符。反引号围栏的 info
/// string 里不许再出现反引号(出现即不是围栏);波浪号无此限制。
fn open_fence_of(line: &str) -> Option<OpenFence> {
    let indent = leading_spaces(line);
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker_char = rest.chars().next()?;
    if marker_char != '`' && marker_char != '~' {
        return None;
    }
    let length = rest.chars().take_while(|c| *c == marker_char).count();
    if length < 3 {
        return None;
    }
    let info = &rest[length * marker_char.len_utf8()..];
    if marker_char == '`' && info.contains('`') {
        return None;
    }
    let lang = info
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    Some(OpenFence { char: marker_char, length, indent, lang })
}

fn is_close_fence(line: &str, open: &OpenFence) -> bool {
    let indent = leading_spaces(line);
    if indent > 3 {
        return false;
    }
    let rest = &line[indent..];
    let count = rest.chars().take_while(|c| *c == open.char).count();
    if count < open.length {
        return false;
    }
    rest[count * open.char.len_utf8()..]
        .chars()
        .all(|c| c == ' ' || c == '\t')
}

fn leading_spaces(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ').count()
}

/// 虚拟行 = markdown 行 slice 掉 `min(indent, 行首空格)` 列后的字节下标。
fn strip_col(line: &str, indent: usize) -> usize {
    std::cmp::min(indent, leading_spaces(line))
}

fn strip_indent(line: &str, indent: usize) -> &str {
    &line[strip_col(line, indent)..]
}

/// TS `/^def\s+main\s*\(/`:模块级(行首无空白)`def main(`。
fn is_main_def(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("def") else {
        return false;
    };
    let ws = rest.trim_start_matches(is_js_ws);
    if ws.len() == rest.len() {
        return false; // `\s+` 要求至少一个空白
    }
    let Some(rest) = ws.strip_prefix("main") else {
        return false;
    };
    rest.trim_start_matches(is_js_ws).starts_with('(')
}

/// TS `/if\s+__name__\s*==\s*['"]__main__['"]/`:不锚定,行内任何位置。
fn is_main_guard(line: &str) -> bool {
    let mut from = 0;
    while let Some(at) = line[from..].find("if").map(|rel| from + rel) {
        if guard_at(&line[at + 2..]) {
            return true;
        }
        from = at + 2;
    }
    false
}

/// [`is_main_guard`] 的余部:`\s+__name__\s*==\s*['"]__main__['"]`,引号成对。
fn guard_at(rest: &str) -> bool {
    let ws = rest.trim_start_matches(is_js_ws);
    if ws.len() == rest.len() {
        return false;
    }
    let Some(rest) = ws.strip_prefix("__name__") else {
        return false;
    };
    let rest = rest.trim_start_matches(is_js_ws);
    let Some(rest) = rest.strip_prefix("==") else {
        return false;
    };
    let rest = rest.trim_start_matches(is_js_ws);
    let (quote, rest) = match rest.chars().next() {
        Some(q @ ('\'' | '"')) => (q, &rest[q.len_utf8()..]),
        _ => return false,
    };
    match rest.strip_prefix("__main__") {
        Some(rest) => rest.starts_with(quote),
        None => false,
    }
}

/// JS 的 `\s`(这里够用的子集:空白与换行)。
fn is_js_ws(c: char) -> bool {
    c.is_whitespace()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `extract.test.ts` 的名称与断言逐条对应,便于两边对照。
    fn vlines(eff: &PythonExtract) -> Vec<&str> {
        eff.virtual_text.split('\n').collect()
    }

    #[test]
    fn has_python_fence_hint_is_a_fast_negative() {
        assert!(!has_python_fence_hint("# 标题\n\n正文,没有代码块\n"));
        assert!(has_python_fence_hint("```python\nx = 1\n```"));
        assert!(has_python_fence_hint("~~~python\nx = 1\n~~~"));
    }

    #[test]
    fn extracts_one_fence_and_the_virtual_file_stays_line_aligned() {
        let doc = "# 标题\n\n```python\nx = 1\nprint(x)\n```\n\n正文\n";
        let eff = extract_python(doc);
        assert_eq!(eff.blocks.len(), 1);
        assert_eq!(eff.blocks[0].start_line, 3);
        assert_eq!(eff.blocks[0].end_line, 4);
        assert_eq!(eff.blocks[0].text, "x = 1\nprint(x)");
        let v = vlines(&eff);
        assert_eq!(v.len(), doc.split('\n').count());
        assert_eq!(v[3], "x = 1");
        assert_eq!(v[4], "print(x)");
        assert_eq!(v[0], "");
        assert_eq!(v[6], "");
        assert_eq!(eff.appended_lines, 0);
    }

    #[test]
    fn multiple_blocks_enter_one_virtual_file_and_ts_is_excluded() {
        let doc = "```python\na = 1\n```\n中间文字\n```ts\nconst b = 2\n```\n```python\nc = a + 1\nprint(c)\n```";
        let eff = extract_python(doc);
        let texts: Vec<&str> = eff.blocks.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, ["a = 1", "c = a + 1\nprint(c)"]);
        let v = vlines(&eff);
        assert_eq!(v[1], "a = 1");
        assert_eq!(v[3], "");
        assert_eq!(v[5], "");
        assert_eq!(v[8], "c = a + 1");
    }

    #[test]
    fn py_and_python3_info_strings_count_others_do_not() {
        assert_eq!(extract_python("```py\nx = 1\n```").blocks.len(), 1);
        assert_eq!(extract_python("```python3\nx = 1\n```").blocks.len(), 1);
        assert_eq!(extract_python("```ruby\nx = 1\n```").blocks.len(), 0);
        assert_eq!(extract_python("```\nx = 1\n```").blocks.len(), 0);
        assert_eq!(extract_python("```Python\nx = 1\n```").blocks.len(), 1);
        assert_eq!(extract_python("```python title=demo\nx = 1\n```").blocks.len(), 1);
    }

    #[test]
    fn tilde_fences_and_list_indent_strip_the_common_indent() {
        let eff = extract_python("~~~python\nx = 1\n~~~\n");
        assert_eq!(eff.blocks[0].text, "x = 1");

        let doc = "- 项\n\n  ```python\n  for i in range(2):\n      print(i)\n  ```\n";
        let eff = extract_python(doc);
        assert_eq!(eff.blocks[0].text, "for i in range(2):\n    print(i)");
        assert_eq!(vlines(&eff)[3], "for i in range(2):");
    }

    #[test]
    fn a_content_line_shallower_than_the_fence_stops_at_zero() {
        let eff = extract_python("  ```python\n  a = 1\nb = 2\n  ```\n");
        assert_eq!(eff.blocks[0].text, "a = 1\nb = 2");
    }

    #[test]
    fn short_inner_fences_are_content_and_a_longer_open_needs_a_longer_close() {
        let eff = extract_python("````python\nx = \"```\nl = ```python```\n````\n");
        assert_eq!(eff.blocks[0].text, "x = \"```\nl = ```python```");
    }

    #[test]
    fn a_backtick_in_a_backtick_fence_info_string_is_not_a_fence() {
        assert_eq!(extract_python("```py`thon\nx = 1\n```").blocks.len(), 0);
    }

    #[test]
    fn an_unclosed_fence_runs_to_the_end_of_the_document() {
        let eff = extract_python("# 标题\n```python\nx = 1\ny = 2\n");
        assert_eq!(eff.blocks[0].start_line, 2);
        assert_eq!(eff.blocks[0].text, "x = 1\ny = 2\n");
    }

    #[test]
    fn a_four_space_indented_fence_is_not_a_top_level_fence() {
        assert_eq!(extract_python("    ```python\n    x = 1\n    ```").blocks.len(), 0);
    }

    #[test]
    fn a_module_level_main_without_a_guard_gets_the_standard_guard() {
        let eff = extract_python("```python\ndef main():\n    print('hi')\n```");
        assert!(eff.has_main);
        assert!(!eff.has_main_guard);
        assert_eq!(eff.appended_lines, 3);
        assert!(eff.effective_text.ends_with("if __name__ == \"__main__\":\n    main()"));
        // 追加不改变已有行的行号映射。
        assert_eq!(eff.effective_text.split('\n').nth(1), Some("def main():"));
    }

    #[test]
    fn an_existing_name_guard_is_respected() {
        let doc = "```python\ndef main():\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n```";
        let eff = extract_python(doc);
        assert!(eff.has_main_guard);
        assert_eq!(eff.appended_lines, 0);
        assert_eq!(eff.effective_text, eff.virtual_text);
    }

    #[test]
    fn without_main_the_text_runs_as_is() {
        let eff = extract_python("```python\nprint('top')\n```");
        assert!(!eff.has_main);
        assert_eq!(eff.appended_lines, 0);
    }

    #[test]
    fn an_indented_def_main_nested_in_a_class_does_not_append() {
        let eff = extract_python("```python\nclass A:\n    def main(self):\n        pass\n```");
        assert!(!eff.has_main);
        assert_eq!(eff.appended_lines, 0);
    }

    #[test]
    fn single_quoted_guards_count_too() {
        let eff = extract_python("```python\ndef main():\n    pass\nif __name__=='__main__':\n    main()\n```");
        assert!(eff.has_main);
        assert!(eff.has_main_guard);
        assert_eq!(eff.appended_lines, 0);
    }

    /// 大文档提取是线性开销(防意外 O(n²)):TS 侧同一条护栏,10k 行远小于
    /// 一秒,这里给一个宽松的量级上限。
    #[test]
    fn extraction_of_a_large_document_stays_linear() {
        let mut doc = String::new();
        for i in 0..10_000 {
            if i % 500 == 0 {
                doc.push_str("```python\n");
            } else if i % 500 == 499 {
                doc.push_str("```\n");
            } else {
                doc.push_str("x = 1  # 一行普通内容\n");
            }
        }
        let started = std::time::Instant::now();
        let eff = extract_python(&doc);
        assert!(!eff.blocks.is_empty());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "10k 行提取 {:?}",
            started.elapsed()
        );
    }
}
