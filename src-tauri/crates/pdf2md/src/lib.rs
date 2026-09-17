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

    // 3) Per page: tables, figures, structure.
    let mut all_blocks: Vec<structure::Block> = Vec::new();
    for (pi, items) in items_per_page.iter().enumerate() {
        let page_no = pi as u32 + 1;
        let lines = &lines_per_page[pi];

        // tables (they claim rules)
        let rule_refs: Vec<&content::Rule> = items.rules.iter().collect();
        let tables: Vec<table::Table> = table::detect(lines, &rule_refs, body)
            .map(|(t, _c)| vec![t])
            .unwrap_or_default();

        // figures
        let mut sink = graphics::AssetSink::new(&opts.asset_dir, page_no);
        let figures = graphics::extract_figures(doc, items, lines, body, &mut sink);

        // columns + blocks
        let columns = layout::order_columns(lines.clone(), items.page_width);
        let mut ctx = structure::AssembleCtx { items, body, rules: rule_refs };
        let blocks =
            structure::assemble_page(columns, &mut ctx, figures, tables, items.page_width);
        all_blocks.extend(blocks);
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
    for b in blocks {
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
