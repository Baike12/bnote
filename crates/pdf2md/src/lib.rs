//! pdf2md — pure-Rust PDF → Markdown converter.
//!
//! No OCR, no ML models: glyph-level extraction from content streams plus
//! geometric reconstruction of layout (columns, headings, math → LaTeX,
//! tables, figures → SVG). Formulas and images keep their position because
//! reconstruction works from the same glyph/rule/image geometry the PDF uses.

pub mod content;
pub mod font;
pub mod geom;
pub mod glyphdata;
pub mod graphics;
pub mod layout;
pub mod math;
pub mod structure;
pub mod table;
pub mod toc;

/// Debug: dump glyphs grouped by baseline, optionally filtered by substring.
/// Debug: dump raw font dictionaries.
pub fn debug_fonts(path: &str) {
    let doc = lopdf::Document::load(path).expect("load");
    // walk all objects for font dicts
    for (num, id) in doc.get_pages() {
        let _ = num;
        let _ = id;
    }
    let objects: Vec<_> = doc.objects.iter().collect();
    for (id, obj) in objects {
        if let lopdf::Object::Stream(s) = obj {
            continue;
        }
        if let lopdf::Object::Dictionary(d) = obj {
            let subtype = d.get(b"Subtype").ok().map(|o| {
                o.as_name().map(|v| String::from_utf8_lossy(v).to_string()).unwrap_or_default()
            });
            if subtype.as_deref() == Some("Font") {
                println!("--- font obj {:?}", id);
                println!("{:?}", d);
            }
        }
    }
}

pub fn debug_dump(path: &str, filter: Option<&str>) {
    let doc = lopdf::Document::load(path).expect("load");
    let mut cache = std::collections::HashMap::new();
    let page_ids: Vec<(u32, lopdf::ObjectId)> = doc.get_pages().into_iter().collect();
    for (num, id) in page_ids {
        let interp = content::Interp::new(&doc, &mut cache);
        let items = match interp.run_page(id) {
            Ok(i) => i,
            Err(e) => {
                eprintln!("page {}: {}", num, e);
                continue;
            }
        };
        let lines = layout::build_lines(&items);
        let ymin = items.glyphs.iter().map(|g| g.y).fold(f64::MAX, f64::min);
        let ymax = items.glyphs.iter().map(|g| g.y).fold(f64::MIN, f64::max);
        println!("===== page {} ({:.0}x{:.0}) glyphs={} ymin={:.1} ymax={:.1} lines={} =====",
            num, items.page_width, items.page_height, items.glyphs.len(), ymin, ymax, lines.len());
        for f in items.fonts.iter().enumerate() {
            println!(
                "  font[{}] base={:?} two_byte={} math={} tex={:?} bold={} italic={} widths={} spacew={:.1}",
                f.0, f.1.base, f.1.two_byte, f.1.is_math, f.1.tex, f.1.is_bold, f.1.is_italic, f.1.widths.len(), f.1.space_width
            );
        }
        for l in &lines {
            let text = l.text();
            if let Some(f) = filter {
                if !text.contains(f) {
                    continue;
                }
            }
            println!("LINE y={:.1} x={:.1}..{:.1} size={:.1}", l.baseline, l.x0, l.x1, l.size);
            for &gi in &l.glyph_ids {
                let g = &items.glyphs[gi];
                println!(
                    "    G x={:.2} y={:.2} wx={:.2} sz={:.2} font={} code={} text={:?} latex={:?}",
                    g.x, g.y, g.wx, g.size, g.font, g.code, g.text, g.latex
                );
            }
        }
    }
}

/// Debug: print a page's decompressed content stream (recursing into forms).
pub fn debug_stream(path: &str, page: Option<u32>) {
    let doc = lopdf::Document::load(path).expect("load");
    for (num, id) in doc.get_pages() {
        if let Some(want) = page {
            if num != want {
                continue;
            }
        }
        let bytes = crate::content::page_content_bytes(&doc, id).expect("content");
        println!("===== page {} content stream ({} bytes) =====", num, bytes.len());
        print!("{}", String::from_utf8_lossy(&bytes));
        debug_stream_forms(&doc, id, 1);
    }
}

fn debug_stream_forms(doc: &lopdf::Document, page_id: lopdf::ObjectId, depth: usize) {
    let form_res = crate::content::page_attrs(doc, page_id).1
        .and_then(|r| r.get(b"XObject").ok().cloned())
        .and_then(|x| match x {
            lopdf::Object::Dictionary(d) => Some(d),
            lopdf::Object::Reference(rid) => doc.get_object(rid).ok().and_then(|o| o.as_dict().ok().cloned()),
            _ => None,
        });
    let Some(xobjs) = form_res else { return };
    for (k, v) in xobjs.iter() {
        let lopdf::Object::Reference(rid) = v else { continue };
        let Ok(lopdf::Object::Stream(s)) = doc.get_object(*rid) else { continue };
        let subtype = s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok().map(|n| n.to_vec())).unwrap_or_default();
        if subtype != b"Form" {
            continue;
        }
        let mut sc = s.clone();
        let dres = sc.decode_content();
        let decompressed = sc.decompressed_content();
        println!(
            "----- form /{} decode={:?} decompressed={:?} dict={:?} -----",
            String::from_utf8_lossy(&k),
            dres.is_ok(),
            decompressed.as_ref().map(|d| d.len()).map_err(|e| e.to_string()),
            s.dict
        );
        if let Ok(bytes) = decompressed {
            print!("{}", String::from_utf8_lossy(&bytes));
        }
        println!("----- form /{} ({} bytes) -----", String::from_utf8_lossy(&k), sc.content.len());
        print!("{}", String::from_utf8_lossy(&sc.content));
    }
}

pub struct ConvertOptions {
    /// Directory where figure/image assets are written (created if needed).
    pub asset_dir: std::path::PathBuf,
    /// Prefix used in markdown image references, e.g. "assets/paper".
    pub asset_prefix: String,
}

impl ConvertOptions {
    pub fn new(asset_dir: std::path::PathBuf, asset_prefix: String) -> Self {
        ConvertOptions { asset_dir, asset_prefix }
    }
}

pub struct ConvertOutput {
    pub markdown: String,
    pub page_count: usize,
    pub warnings: Vec<String>,
}

/// Converts a PDF file to markdown.
pub fn convert_file(path: &str, opts: &ConvertOptions) -> Result<ConvertOutput, String> {
    let doc = lopdf::Document::load(path).map_err(|e| format!("load: {}", e))?;
    convert_doc(&doc, opts)
}

/// Converts a PDF from memory.
pub fn convert_bytes(bytes: &[u8], opts: &ConvertOptions) -> Result<ConvertOutput, String> {
    let doc = lopdf::Document::load_mem(bytes).map_err(|e| format!("load: {}", e))?;
    convert_doc(&doc, opts)
}

fn convert_doc(doc: &lopdf::Document, opts: &ConvertOptions) -> Result<ConvertOutput, String> {
    std::fs::create_dir_all(&opts.asset_dir).ok();
    let mut warnings = Vec::new();

    // Ordered pages.
    let page_ids: Vec<lopdf::ObjectId> = {
        let mut v: Vec<(u32, lopdf::ObjectId)> =
            doc.get_pages().into_iter().map(|(n, id)| (n, id)).collect();
        v.sort_by_key(|(n, _)| *n);
        v.into_iter().map(|(_, id)| id).collect()
    };
    if page_ids.is_empty() {
        return Err("no pages".into());
    }

    // 1) Extract per page.
    let mut cache = std::collections::HashMap::new();
    let mut items_per_page: Vec<content::PageItems> = Vec::new();
    let mut lines_per_page: Vec<Vec<layout::Line>> = Vec::new();
    for &id in &page_ids {
        let interp = content::Interp::new(doc, &mut cache);
        let items = interp.run_page(id)?;
        let lines = layout::build_lines(&items);
        items_per_page.push(items);
        lines_per_page.push(lines);
    }
    // 2) Document-level stats + header/footer removal.
    let body = layout::body_size(&lines_per_page);
    let page_height = items_per_page[0].page_height;
    layout::strip_headers_footers(&mut lines_per_page, page_height);

    // Page-furniture rules: a horizontal rule whose y position repeats on
    // ≥40% of pages is the running header/footer separator (the same
    // statistical model strip_headers_footers applies to text). It is page
    // decoration, never a table row border.
    let furniture_y: std::collections::HashSet<i64> = {
        let page_count = items_per_page.len();
        let mut ys_seen: std::collections::HashMap<i64, u32> = std::collections::HashMap::new();
        for items in &items_per_page {
            let mut ys: std::collections::HashSet<i64> = std::collections::HashSet::new();
            for r in &items.rules {
                if r.rect.height() <= 2.5 {
                    ys.insert(((r.rect.y0 + r.rect.y1) / 2.0).round() as i64);
                }
            }
            for y in ys {
                *ys_seen.entry(y).or_insert(0) += 1;
            }
        }
        let threshold = ((page_count as f64) * 0.4).ceil() as u32;
        ys_seen
            .into_iter()
            .filter(|(_, c)| *c >= threshold)
            .map(|(y, _)| y)
            .collect()
    };

    // 3) Per page: tables, figures, structure.
    let mut all_blocks: Vec<structure::Block> = Vec::new();
    for (pi, items) in items_per_page.iter().enumerate() {
        let page_no = pi as u32 + 1;
        let mut lines = std::mem::take(&mut lines_per_page[pi]);

        // figures first: they claim their labels, their raster assets and
        // their drawing strokes
        let mut sink = graphics::AssetSink::new(&opts.asset_dir, page_no);
        let page_figs = graphics::extract_figures(
            doc,
            items,
            &lines,
            body,
            &mut sink,
            &mut warnings,
        );

        // tables: row borders exclude rules a figure claimed (a diagram's own
        // horizontal arrows are not table borders) and page-furniture rules,
        // but row construction sees the full line set — table detection is
        // calibrated on it.
        let fig_rules = &page_figs.claimed_rules;
        let table_rules: Vec<&content::Rule> = items
            .rules
            .iter()
            .enumerate()
            .filter(|(ri, r)| {
                !fig_rules.contains(ri)
                    && !furniture_y.contains(&(((r.rect.y0 + r.rect.y1) / 2.0).round() as i64))
            })
            .map(|(_ri, r)| r)
            .collect();
        let tables: Vec<table::Table> = table::detect(&lines, &table_rules, body)
            .map(|(t, _c)| vec![t])
            .unwrap_or_default();
        if std::env::var("PDF2MD_TAB_DEBUG").ok().as_deref() == Some(page_no.to_string().as_str()) {
            match tables.first() {
                Some(t) => eprintln!(
                    "[tabdbg] page {} table bbox=({:.1},{:.1})-({:.1},{:.1}) rows={} cols={}",
                    page_no, t.bbox.x0, t.bbox.y0, t.bbox.x1, t.bbox.y1,
                    t.rows.len(),
                    t.rows.first().map(|r| r.len()).unwrap_or(0)
                ),
                None => eprintln!("[tabdbg] page {} no table", page_no),
            }
        }

        // Text claimed by a figure (labels rendered inside its asset) leaves
        // the flow, the same way table rules belong to the table.
        let claimed = page_figs.claimed_lines;
        let mut flow_lines: Vec<layout::Line> = Vec::with_capacity(lines.len());
        for (li, l) in lines.into_iter().enumerate() {
            if !claimed.contains(&li) {
                flow_lines.push(l);
            }
        }

        // structure assembly keeps ALL rules: fraction bars inside text lines
        // feed math reconstruction even when a figure sits on the same page.
        let rule_refs: Vec<&content::Rule> = items.rules.iter().collect();

        // Table of contents: recognized on visual rows BEFORE the per-line
        // heuristics run; its lines leave the flow so a TOC title can never
        // be re-judged as a heading, a bare page number as a bold heading or
        // a math-bearing title as a display formula.
        let page_toc = toc::detect_page_toc(&flow_lines, items, &rule_refs, &mut warnings);
        if let Some(t) = &page_toc {
            let consumed: std::collections::HashSet<usize> = t.line_ids.iter().copied().collect();
            flow_lines = flow_lines
                .into_iter()
                .enumerate()
                .filter(|(i, _)| !consumed.contains(i))
                .map(|(_, l)| l)
                .collect();
        }

        // columns + blocks
        let columns = layout::order_columns(flow_lines, items.page_width);
        let mut ctx = structure::AssembleCtx { items, body, rules: rule_refs, warnings: Vec::new() };
        let blocks = structure::assemble_page(
            columns,
            &mut ctx,
            page_figs.figures,
            tables,
            items.page_width,
            page_toc.as_ref(),
        );
        all_blocks.extend(blocks);
        for w in ctx.warnings {
            if !warnings.contains(&w) {
                warnings.push(w);
            }
        }
    }

    // 4) Markdown assembly.
    let md = write_markdown(&all_blocks, &opts.asset_prefix);
    Ok(ConvertOutput {
        markdown: md,
        page_count: page_ids.len(),
        warnings,
    })
}

fn write_markdown(blocks: &[structure::Block], asset_prefix: &str) -> String {
    let mut out = String::new();
    let mut ordered_counter: u64 = 0;
    let mut prev_was_list = false;
    for (i, b) in blocks.iter().enumerate() {
        match b {
            structure::Block::Heading { level, text } => {
                out.push_str(&"#".repeat((*level).clamp(1, 6)));
                out.push(' ');
                out.push_str(&escape_heading(text));
                out.push_str("\n\n");
                prev_was_list = false;
            }
            structure::Block::Paragraph(text) => {
                out.push_str(text);
                out.push_str("\n\n");
                prev_was_list = false;
            }
            structure::Block::MathBlock(latex) => {
                out.push_str("$$\n");
                out.push_str(latex.trim());
                out.push_str("\n$$\n\n");
                prev_was_list = false;
            }
            structure::Block::ListItem { ordered, text } => {
                match ordered {
                    Some(n) => {
                        ordered_counter = if prev_was_list { ordered_counter + 1 } else { *n };
                        out.push_str(&format!("{}. {}\n", ordered_counter, text));
                    }
                    None => out.push_str(&format!("- {}\n", text)),
                }
                prev_was_list = true;
            }
            structure::Block::TableBlock { rows } => {
                out.push_str(&write_table(rows));
                out.push('\n');
                prev_was_list = false;
            }
            structure::Block::Figure { asset, alt } => {
                out.push_str(&format!("![{}]({}/{})\n\n", alt, asset_prefix, asset));
                prev_was_list = false;
            }
            structure::Block::TocEntry { level, text, page } => {
                // One entry per line, fixed 2-space indent per level. Leader
                // dots and the page number are kept as a uniform unit: every
                // entry ends with the same fixed separator + page number (or,
                // when the row carried no number, none does — never mixed).
                let indent = "  ".repeat((*level).clamp(1, 6) - 1);
                match page {
                    Some(p) => out.push_str(&format!("{}- {} ..... {}\n", indent, text, p)),
                    None => out.push_str(&format!("{}- {}\n", indent, text)),
                }
                // close the list when the next block is not a TOC entry
                if !matches!(blocks.get(i + 1), Some(structure::Block::TocEntry { .. })) {
                    out.push('\n');
                }
                prev_was_list = false;
            }
        }
    }
    out
}

fn escape_heading(s: &str) -> String {
    s.replace('$', "\\$")
}

fn write_table(rows: &[Vec<String>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(1).max(1);
    let padded: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            let mut r = r.clone();
            while r.len() < ncols {
                r.push(String::new());
            }
            r
        })
        .collect();
    let mut out = String::new();
    for (i, row) in padded.iter().enumerate() {
        let cells: Vec<String> = row
            .iter()
            .map(|c| table::cell_to_md(c).trim().to_string())
            .collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
        if i == 0 {
            out.push_str(&format!("|{}|\n", vec![" --- "; ncols].join("|")));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use structure::Block;

    /// TOC entries render as one nested list: fixed 2-space indent per level,
    /// one line per entry, page numbers uniform ("..... N" or none at all).
    #[test]
    fn toc_entries_render_as_nested_list() {
        let blocks = vec![
            Block::Heading { level: 2, text: "Contents".into() },
            Block::TocEntry { level: 1, text: "1 Introduction".into(), page: Some("1".into()) },
            Block::TocEntry { level: 2, text: "1.1 Motivation".into(), page: Some("2".into()) },
            Block::TocEntry { level: 2, text: "1.2 Plan".into(), page: Some("3".into()) },
            Block::TocEntry { level: 1, text: "2 Setup".into(), page: Some("6".into()) },
            Block::TocEntry { level: 1, text: "Index".into(), page: None },
        ];
        let md = write_markdown(&blocks, "assets/x");
        let lines: Vec<&str> = md.lines().collect();
        assert_eq!(lines[0], "## Contents");
        assert_eq!(lines[2], "- 1 Introduction ..... 1");
        assert_eq!(lines[3], "  - 1.1 Motivation ..... 2");
        assert_eq!(lines[4], "  - 1.2 Plan ..... 3");
        assert_eq!(lines[5], "- 2 Setup ..... 6");
        assert_eq!(lines[6], "- Index");
        // the list is closed with a blank line before the next block
        assert_eq!(lines[7], "");
        // every numbered entry uses the same separator: uniform treatment
        let dotted = lines.iter().filter(|l| l.contains(" ..... ")).count();
        assert_eq!(dotted, 4);
    }
}
