//! 转换质量门禁:用 `tests/data/pdf/` 下的真实论文夹具锁住结构性质量。
//!
//! 对应学习模式导入 PDF 的三类高价值内容(用户验收标准:准确优先,其次对齐、工整):
//! - 公式:产出的 `$$` 块与行内公式数量不低于实测基线的一半,`$$` 定界符成对;
//! - 图片:markdown 里每个图片引用都解析到 `assets/<stem>/` 下存在的非 0 字节文件;
//! - 目录:Contents 渲染成缩进一致的列表,条目完整,页码要么全有要么全无。
//!
//! 阈值按 2026-09 本机实测值取半标定(计数坍塌即公式/图片提取整体失效)。
//! 夹具缺失时测试失败并指明缺哪个文件——夹具随仓库留存,转换在临时目录进行。

use std::path::{Path, PathBuf};

/// 相对 `CARGO_MANIFEST_DIR`(src-tauri/crates/pdf2md)的夹具目录。
const FIXTURES_REL: &str = "../../../tests/data/pdf";

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURES_REL)
}

struct Converted {
    markdown: String,
    asset_dir: PathBuf,
    stem: String,
}

fn convert_fixture(file: &str) -> Converted {
    let pdf = fixtures_dir().join(file);
    assert!(pdf.is_file(), "缺少测试夹具:{}", pdf.display());
    let stem = file.trim_end_matches(".pdf").to_string();
    let out_dir = std::env::temp_dir().join("pdf2md-gate");
    std::fs::create_dir_all(&out_dir).expect("创建临时输出目录");
    let asset_dir = out_dir.join("assets").join(&stem);
    let opts = pdf2md::ConvertOptions::new(asset_dir.clone(), format!("assets/{}", stem));
    let output = pdf2md::convert_file(pdf.to_str().expect("夹具路径为 UTF-8"), &opts)
        .unwrap_or_else(|e| panic!("转换夹具 {file} 失败:{e}"));
    Converted {
        markdown: output.markdown,
        asset_dir,
        stem,
    }
}

/// 非空 `$$` 块的数量。
fn display_block_count(md: &str) -> usize {
    let mut blocks = 0;
    let mut current: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in md.lines() {
        if line.trim() == "$$" {
            if inside {
                if !current.join("").trim().is_empty() {
                    blocks += 1;
                }
                current.clear();
                inside = false;
            } else {
                inside = true;
            }
        } else if inside {
            current.push(line);
        }
    }
    blocks
}

/// `$$` 定界符必须成对(奇数说明有块被截断)。
fn display_delimiters_balanced(md: &str) -> bool {
    md.lines().filter(|l| l.trim() == "$$").count() % 2 == 0
}

/// 形如 `$...$` 的行内公式数量(`$$` 定界符不计入)。
fn inline_math_count(md: &str) -> usize {
    let chars: Vec<char> = md.chars().collect();
    let mut count = 0;
    let mut open = false;
    let mut body_len = 0;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '$' {
            if i + 1 < chars.len() && chars[i + 1] == '$' {
                open = false;
                body_len = 0;
                i += 2;
                continue;
            }
            if open {
                if body_len > 0 {
                    count += 1;
                }
                open = false;
                body_len = 0;
            } else {
                open = true;
                body_len = 0;
            }
        } else if open {
            if c == '\n' {
                open = false;
                body_len = 0;
            } else {
                body_len += 1;
            }
        }
        i += 1;
    }
    count
}

/// 抽出所有 markdown 图片引用的目标路径。
fn image_refs(md: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut rest = md;
    while let Some(start) = rest.find("![") {
        let after = &rest[start + 2..];
        let Some(label_end) = after.find("](") else { break };
        let url_start = label_end + 2;
        let Some(paren) = after[url_start..].find(')') else { break };
        refs.push(after[url_start..url_start + paren].to_string());
        rest = &after[url_start + paren..];
    }
    refs
}

/// `## Contents` 之后的列表条目:(缩进空格数, 文本)。
fn toc_entries(md: &str) -> Vec<(usize, String)> {
    let mut entries = Vec::new();
    let mut in_toc = false;
    for line in md.lines() {
        if line.starts_with('#') {
            in_toc = line.trim_start_matches('#').trim().eq_ignore_ascii_case("contents");
            continue;
        }
        if !in_toc {
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let body = line.trim_start();
        if let Some(text) = body.strip_prefix("- ").or_else(|| body.strip_prefix("* ")) {
            entries.push((indent, text.to_string()));
        } else if !entries.is_empty() {
            // 目录列表结束后遇到正文/标题:停止收集。
            break;
        }
    }
    entries
}

/// 条目尾部是否带页码(`... 12`)。
fn ends_with_page_number(text: &str) -> bool {
    let tail = text.trim_end();
    let digits: String = tail
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    !digits.is_empty() && tail.len() > digits.len()
}

fn assert_image_refs_resolve(c: &Converted, min_refs: usize) {
    let refs = image_refs(&c.markdown);
    assert!(
        refs.len() >= min_refs,
        "{}:图片引用只有 {} 个,低于门禁下限 {}",
        c.stem,
        refs.len(),
        min_refs
    );
    let prefix = format!("assets/{}/", c.stem);
    for r in &refs {
        assert!(
            r.starts_with(&prefix),
            "{}:图片引用 `{}` 不在 {} 下(位置/路径写错)",
            c.stem,
            r,
            prefix
        );
        let path = c.asset_dir.join(r.trim_start_matches(&prefix));
        let meta = std::fs::metadata(&path)
            .unwrap_or_else(|e| panic!("{}:引用 `{}` 指向的文件不存在:{e}", c.stem, r));
        assert!(meta.len() > 0, "{}:引用 `{}` 是 0 字节文件", c.stem, r);
        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "svg"))
            .unwrap_or(false);
        assert!(ext_ok, "{}:引用 `{}` 不是可渲染的图片格式", c.stem, r);
    }
}

#[test]
fn formula_fixtures_keep_display_and_inline_math() {
    // attention:公式密集的正文;ricci:全篇行内公式极多。
    for (file, min_blocks, min_inline) in [
        ("1706.03762-attention.pdf", 6, 60),
        ("math0211159-ricci.pdf", 30, 900),
    ] {
        let c = convert_fixture(file);
        assert!(
            display_delimiters_balanced(&c.markdown),
            "{}:`$$` 定界符不成对(有块被截断)",
            c.stem
        );
        let blocks = display_block_count(&c.markdown);
        assert!(
            blocks >= min_blocks,
            "{}:非空 `$$` 块只有 {},低于门禁下限 {}",
            c.stem,
            blocks,
            min_blocks
        );
        let inline = inline_math_count(&c.markdown);
        assert!(
            inline >= min_inline,
            "{}:行内公式只有 {},低于门禁下限 {}",
            c.stem,
            inline,
            min_inline
        );
    }
}

#[test]
fn image_fixtures_resolve_every_reference() {
    // attention/gan:插图为主的论文,每个引用都必须落到真实文件。
    for (file, min_refs) in [
        ("1706.03762-attention.pdf", 4),
        ("1406.2661-gan.pdf", 6),
    ] {
        let c = convert_fixture(file);
        assert_image_refs_resolve(&c, min_refs);
    }
}

#[test]
fn toc_fixture_renders_consistent_nested_list() {
    let c = convert_fixture("2609.27549-cartier-toc.pdf");
    let entries = toc_entries(&c.markdown);
    assert!(
        entries.len() >= 9,
        "{}:Contents 条目只有 {} 条,应为 9 条以上(目录被吞或截断)",
        c.stem,
        entries.len()
    );
    for (indent, text) in &entries {
        assert!(!text.trim().is_empty(), "{}:目录有空条目", c.stem);
        assert_eq!(
            indent % 2,
            0,
            "{}:目录条目 `{}` 缩进 {} 不是 2 的倍数(层级不齐)",
            c.stem,
            text,
            indent
        );
    }
    // 页码要么全有要么全无,不允许一篇里混着来。
    let with_pages = entries.iter().filter(|(_, t)| ends_with_page_number(t)).count();
    assert!(
        with_pages == 0 || with_pages == entries.len(),
        "{}:目录页码处理不一致({}/{} 条带页码)",
        c.stem,
        with_pages,
        entries.len()
    );
}

#[test]
fn image_fixture_extracts_assets_to_disk() {
    let c = convert_fixture("1406.2661-gan.pdf");
    let count = std::fs::read_dir(&c.asset_dir)
        .map(|d| d.filter_map(Result::ok).count())
        .unwrap_or(0);
    assert!(
        count >= 6,
        "{}:assets 目录只有 {} 个文件,低于门禁下限 6",
        c.stem,
        count
    );
}
