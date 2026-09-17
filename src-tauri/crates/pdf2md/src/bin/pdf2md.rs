//! CLI: convert a PDF to markdown (writes .md into an output dir).
use pdf2md::ConvertOptions;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: pdf2md <file.pdf> [outdir]");
        std::process::exit(1);
    }
    let input = &args[1];
    let outdir = args.get(2).cloned().unwrap_or_else(|| "./out".to_string());

    if args.iter().any(|a| a == "--fontdump") {
        pdf2md::debug_fonts(input);
        return;
    }
    if let Some(pos) = args.iter().position(|a| a == "--dump") {
        pdf2md::debug_dump(input, args.get(pos + 1).map(|s| s.as_str()));
        return;
    }

    let stem = std::path::Path::new(input)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let asset_dir = PathBuf::from(&outdir).join("assets").join(&stem);
    let opts = ConvertOptions::new(asset_dir, format!("assets/{}", stem));
    let started = std::time::Instant::now();
    match pdf2md::convert_file(input, &opts) {
        Ok(out) => {
            let md_path = PathBuf::from(&outdir).join(format!("{}.md", stem));
            std::fs::write(&md_path, &out.markdown).expect("write md");
            eprintln!(
                "converted {} pages in {:.2?} → {} ({} bytes)",
                out.page_count,
                started.elapsed(),
                md_path.display(),
                out.markdown.len()
            );
            for w in &out.warnings {
                eprintln!("warn: {}", w);
            }
        }
        Err(e) => {
            eprintln!("error: {}", e);
            std::process::exit(1);
        }
    }
}
