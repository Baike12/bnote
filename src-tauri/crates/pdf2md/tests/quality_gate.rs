//! Conversion quality gate: locks structural quality against the real paper
//! fixtures under `tests/data/pdfs/`.
//!
//! It covers the three high-value content classes of a PDF imported into study
//! mode (acceptance order: accuracy first, then alignment, then tidiness):
//! - Formulas: the number of `$$` blocks and inline formulas must not fall below
//!   half of the measured baseline, and the `$$` delimiters must be balanced;
//! - Images: every image reference in the markdown must resolve to an existing
//!   non-empty file under `assets/<stem>/`;
//! - Table of contents: Contents renders as a list with consistent indentation
//!   and complete entries, and page numbers that are either all present or all
//!   absent.
//!
//! The thresholds are calibrated at half of the values measured on this machine
//! in 2026-09 (a collapsed count means formula/image extraction broke wholesale).
//! A missing fixture fails the test naming the missing file: the fixtures live
//! with the repository while conversion runs in a temp directory.

use std::path::{Path, PathBuf};

/// Fixture directory relative to `CARGO_MANIFEST_DIR` (src-tauri/crates/pdf2md).
const FIXTURES_REL: &str = "../../../tests/data/pdfs";

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
    assert!(pdf.is_file(), "missing test fixture:{}", pdf.display());
    let stem = file.trim_end_matches(".pdf").to_string();
    let out_dir = std::env::temp_dir().join("pdf2md-gate");
    std::fs::create_dir_all(&out_dir).expect("create the temporary output directory");
    let asset_dir = out_dir.join("assets").join(&stem);
    let opts = pdf2md::ConvertOptions::new(asset_dir.clone(), format!("assets/{}", stem));
    let output = pdf2md::convert_file(pdf.to_str().expect("the fixture path is UTF-8"), &opts)
        .unwrap_or_else(|e| panic!("converting the fixture {file} failed:{e}"));
    Converted {
        markdown: output.markdown,
        asset_dir,
        stem,
    }
}

/// Number of non-empty `$$` blocks.
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

/// The `$$` delimiters must be balanced (an odd count means a block was truncated).
fn display_delimiters_balanced(md: &str) -> bool {
    md.lines().filter(|l| l.trim() == "$$").count() % 2 == 0
}

/// Number of inline formulas of the form `$...$` (`$$` delimiters excluded).
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

/// Extracts the target path of every markdown image reference.
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

/// List entries after `## Contents`: (indent in spaces, text).
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
            // Body text or a heading after the toc list ends: stop collecting.
            break;
        }
    }
    entries
}

/// Whether the entry ends with a page number (`... 12`).
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
        "{}:only {} image references, below the gate minimum {}",
        c.stem,
        refs.len(),
        min_refs
    );
    let prefix = format!("assets/{}/", c.stem);
    for r in &refs {
        assert!(
            r.starts_with(&prefix),
            "{}:image reference `{}` is not under {} (wrong location or path)",
            c.stem,
            r,
            prefix
        );
        let path = c.asset_dir.join(r.trim_start_matches(&prefix));
        let meta = std::fs::metadata(&path)
            .unwrap_or_else(|e| panic!("{}:file `{}` does not exist:{e}", c.stem, r));
        assert!(meta.len() > 0, "{}:the file referenced by `{}` is 0 bytes", c.stem, r);
        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "svg"))
            .unwrap_or(false);
        assert!(ext_ok, "{}:`{}` is not a renderable image format", c.stem, r);
    }
}

#[test]
fn formula_fixtures_keep_display_and_inline_math() {
    // attention: formula-dense body text; ricci: inline formulas throughout.
    for (file, min_blocks, min_inline) in [
        ("1706.03762-attention.pdf", 6, 60),
        ("math0211159-ricci.pdf", 30, 900),
    ] {
        let c = convert_fixture(file);
        assert!(
            display_delimiters_balanced(&c.markdown),
            "{}:the `$$` delimiters are unbalanced (a block was truncated)",
            c.stem
        );
        let blocks = display_block_count(&c.markdown);
        assert!(
            blocks >= min_blocks,
            "{}:only {} non-empty `$$` blocks, below the gate minimum {}",
            c.stem,
            blocks,
            min_blocks
        );
        let inline = inline_math_count(&c.markdown);
        assert!(
            inline >= min_inline,
            "{}:only {} inline formulas, below the gate minimum {}",
            c.stem,
            inline,
            min_inline
        );
    }
}

#[test]
fn image_fixtures_resolve_every_reference() {
    // attention/gan: illustration-heavy papers, every reference must land on a real file.
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
        "{}:the Contents list has only {} entries, expected 9+ (swallowed or truncated)",
        c.stem,
        entries.len()
    );
    for (indent, text) in &entries {
        assert!(!text.trim().is_empty(), "{}:the table of contents has an empty entry", c.stem);
        assert_eq!(
            indent % 2,
            0,
            "{}:toc entry `{}` has indent {}, not a multiple of 2 (uneven levels)",
            c.stem,
            text,
            indent
        );
    }
    // Page numbers must be all present or all absent; a mixed document is not allowed.
    let with_pages = entries.iter().filter(|(_, t)| ends_with_page_number(t)).count();
    assert!(
        with_pages == 0 || with_pages == entries.len(),
        "{}:page numbers in the table of contents are inconsistent ({}/{} entries carry one)",
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
        "{}:the assets directory has only {} files, below the gate minimum 6",
        c.stem,
        count
    );
}
