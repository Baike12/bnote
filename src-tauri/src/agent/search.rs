//! glob / grep: the coding agent's code-finding tools.
//!
//! Both walk with the `ignore` crate so `.gitignore` is respected — without
//! that, `glob **` in a project with `node_modules` drowns the model in
//! vendored files. Output is capped: a tool result that fills the context
//! window is worse than a truncated one.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Hard caps shared by both tools.
const MAX_ENTRIES: usize = 500;
const MAX_MATCHES: usize = 200;
const MAX_LINE_BYTES: usize = 300;

/// Lists files matching a glob pattern under `root` (relative paths, sorted).
pub async fn glob(root: &Path, pattern: &str) -> Result<String, String> {
    let root = root.to_path_buf();
    let pattern = pattern.to_string();
    tokio::task::spawn_blocking(move || glob_sync(&root, &pattern))
        .await
        .map_err(|e| format!("join failed: {}", e))?
}

fn glob_sync(root: &Path, pattern: &str) -> Result<String, String> {
    let matcher = globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| format!("invalid glob: {}", e))?
        .compile_matcher();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut truncated = false;
    for entry in crate::code::project::walk_for_agent(root.to_path_buf()) {
        let Ok(path) = entry else { continue };
        if !path.is_file() {
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        if matcher.is_match(&rel) || matcher.is_match(path.clone()) {
            if files.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            files.push(PathBuf::from(rel));
        }
    }
    files.sort();
    if files.is_empty() {
        return Ok(format!("(no files match {pattern})"));
    }
    let mut out = files
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    if truncated {
        out.push(format!(
            "…(超过 {MAX_ENTRIES} 个,已截断;用更精确的 pattern)"
        ));
    }
    Ok(out.join("\n"))
}

/// Greps a regex over the files under `root`. `include` optionally filters the
/// file names by glob (e.g. `*.rs`). Output is `path:line: text`.
pub async fn grep(root: &Path, pattern: &str, include: Option<String>) -> Result<String, String> {
    let root = root.to_path_buf();
    let pattern = pattern.to_string();
    tokio::task::spawn_blocking(move || grep_sync(&root, &pattern, include))
        .await
        .map_err(|e| format!("join failed: {}", e))?
}

fn grep_sync(root: &Path, pattern: &str, include: Option<String>) -> Result<String, String> {
    let re = regex::RegexBuilder::new(pattern)
        .size_limit(4 << 20)
        .build()
        .map_err(|e| format!("invalid regex: {}", e))?;
    let include = match include.as_deref() {
        Some(g) if !g.is_empty() => Some(
            globset::GlobBuilder::new(g)
                .literal_separator(false)
                .build()
                .map_err(|e| format!("invalid include glob: {}", e))?
                .compile_matcher(),
        ),
        _ => None,
    };
    let mut out = String::new();
    let mut matched_files = 0usize;
    let mut matches = 0usize;
    let mut truncated = false;
    'files: for entry in crate::code::project::walk_for_agent(root.to_path_buf()) {
        let Ok(path) = entry else { continue };
        if !path.is_file() {
            continue;
        }
        let rel = match path.strip_prefix(&root) {
            Ok(r) => r.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        if let Some(inc) = &include {
            if !inc.is_match(&rel) {
                continue;
            }
        }
        // Binary files: skip by NUL sniff on the first chunk, like grep -I.
        let Ok(content) = std::fs::read(&path) else {
            continue;
        };
        if content.is_empty() || content.contains(&0u8) {
            continue;
        }
        let Ok(text) = String::from_utf8(content) else {
            continue;
        };
        let mut file_matches = 0usize;
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                if file_matches == 0 {
                    matched_files += 1;
                }
                file_matches += 1;
                matches += 1;
                out.push_str(&format!("{}:{}: {}\n", rel, i + 1, clip(line)));
                if matches >= MAX_MATCHES {
                    truncated = true;
                    break 'files;
                }
                // One match per line is enough; report the first hit line.
            }
        }
        if out.len() > 60_000 {
            truncated = true;
            break;
        }
    }
    if matches == 0 {
        return Ok(format!("(no matches for {pattern})"));
    }
    if truncated {
        let _ = writeln!(
            out,
            "…(已截断:命中 {} 处 / {} 个文件后停止;缩小 pattern 或 include)",
            matches, matched_files
        );
    } else {
        let _ = writeln!(out, "({matches} 处命中,{matched_files} 个文件)");
    }
    Ok(out)
}

/// One output line per match, clipped to keep wide minified lines from
/// dominating the result.
fn clip(line: &str) -> String {
    let t = line.trim_end();
    if t.len() <= MAX_LINE_BYTES {
        t.to_string()
    } else {
        let mut cut = MAX_LINE_BYTES;
        while !t.is_char_boundary(cut) {
            cut += 1;
        }
        format!("{}…", &t[..cut])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> PathBuf {
        // Unique per run: tests execute in parallel and a shared directory is
        // torn down by one test while another is still writing to it.
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("bnote-search-{}-{}", std::process::id(), unique));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(
            dir.join("src/main.rs"),
            "fn main() {\n    let alpha = 1;\n}\n",
        )
        .unwrap();
        std::fs::write(dir.join("src/deep/util.rs"), "pub fn beta() -> u32 { 2 }\n").unwrap();
        std::fs::write(dir.join("README.md"), "# alpha project\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(dir.join("node_modules/pkg/i.js"), "alpha").unwrap();
        dir
    }

    #[tokio::test]
    async fn glob_matches_relative_patterns_and_respects_gitignore() {
        let root = tree();
        let out = glob(&root, "**/*.rs").await.unwrap();
        assert_eq!(out, "src/deep/util.rs\nsrc/main.rs", "{}", out);
        let out = glob(&root, "node_modules/**").await.unwrap();
        // .gitignore hides node_modules from the agent on purpose.
        assert!(out.contains("no files match"), "{}", out);
        let out = glob(&root, "*.{md,rs}").await.unwrap();
        // `*` does not cross path separators (literal_separator): top level only.
        assert_eq!(out, "README.md", "{}", out);
        let out = glob(&root, "**/*.{md,rs}").await.unwrap();
        assert!(
            out.contains("README.md") && out.contains("src/main.rs"),
            "{}",
            out
        );
    }

    #[tokio::test]
    async fn grep_finds_matches_with_file_line_and_reports_counts() {
        let root = tree();
        let out = grep(&root, "alpha", None).await.unwrap();
        assert!(out.contains("src/main.rs:2:"), "{}", out);
        assert!(out.contains("README.md:1:"), "{}", out);
        assert!(!out.contains("node_modules"), "{}", out);
        assert!(out.contains("(2 处命中,2 个文件)"), "{}", out);

        let out = grep(&root, "beta", Some("*.rs".into())).await.unwrap();
        assert!(out.contains("src/deep/util.rs:1:"), "{}", out);

        let out = grep(&root, "nomatch-xyz", None).await.unwrap();
        assert!(out.contains("no matches"), "{}", out);
    }

    #[tokio::test]
    async fn invalid_patterns_are_reported_not_panicked() {
        let root = tree();
        assert!(grep(&root, "([", None)
            .await
            .unwrap_err()
            .contains("invalid regex"));
        assert!(glob(&root, "[[")
            .await
            .unwrap_err()
            .contains("invalid glob"));
    }
}
