//! Extension → LSP languageId.
//!
//! This is the **only** source of the extension→language mapping: the front end
//! takes the languageId returned by the backend and picks the matching
//! CodeMirror syntax package, so both sides need no table of their own.
//!
//! The languageIds use the names the LSP convention defines (`typescript` /
//! `rust` / `go` / `python` …), the same word that goes into the `didOpen` of
//! the language server.

use std::path::Path;

/// Infers the LSP languageId from the file extension; an unknown suffix returns
/// "plaintext".
///
/// Compound suffixes win (`d.ts` → typescript, `tar.gz` → unknown). Well-known
/// file names (`Dockerfile`, `Makefile`) are recognized by the whole name.
pub fn language_for_path(path: &Path) -> &'static str {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match name.as_str() {
        "dockerfile" => return "dockerfile",
        "makefile" | "gnumakefile" => return "makefile",
        "justfile" => return "justfile",
        "cmakelists.txt" => return "cmake",
        "rakefile" | "gemfile" => return "ruby",
        _ => {}
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "go" => "go",
        "py" | "pyi" | "pyw" => "python",
        "rb" | "rake" | "gemspec" => "ruby",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "scala" | "sc" => "scala",
        "swift" => "swift",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "cs" => "csharp",
        "m" => "objective-c",
        "mm" => "objective-cpp",
        "php" => "php",
        "pl" | "pm" => "perl",
        "lua" => "lua",
        "zig" => "zig",
        "ex" | "exs" => "elixir",
        "erl" | "hrl" => "erlang",
        "hs" => "haskell",
        "jl" => "julia",
        "r" => "r",
        "nim" => "nim",
        "dart" => "dart",
        "vue" => "vue",
        "svelte" => "svelte",
        "sh" | "bash" | "zsh" | "ksh" => "shellscript",
        "fish" => "fish",
        "ps1" => "powershell",
        "sql" => "sql",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "less" => "less",
        "json" | "jsonc" | "json5" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" | "xsd" | "xsl" | "svg" | "plist" => "xml",
        "md" | "markdown" | "mdx" => "markdown",
        "txt" | "text" | "log" => "plaintext",
        "csv" | "tsv" => "plaintext",
        "proto" => "proto",
        "graphql" | "gql" => "graphql",
        "astro" => "astro",
        "tf" | "tfvars" => "terraform",
        "hcl" => "hcl",
        "ini" | "cfg" | "conf" | "properties" => "ini",
        "vim" => "vim",
        "el" => "emacs-lisp",
        "asm" | "s" => "assembly",
        "f90" | "f95" | "f03" => "fortran",
        "sol" => "solidity",
        "prisma" => "prisma",
        "tex" | "sty" | "cls" => "latex",
        "bib" => "bibtex",
        _ => "plaintext",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lang(p: &str) -> &'static str {
        language_for_path(Path::new(p))
    }

    #[test]
    fn maps_the_four_core_languages() {
        assert_eq!(lang("src/main.rs"), "rust");
        assert_eq!(lang("src/index.ts"), "typescript");
        assert_eq!(lang("src/index.tsx"), "typescriptreact");
        assert_eq!(lang("cmd/server/main.go"), "go");
        assert_eq!(lang("scripts/tool.py"), "python");
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        assert_eq!(lang("SRC/MAIN.RS"), "rust");
        assert_eq!(lang("README.MD"), "markdown");
    }

    #[test]
    fn known_filenames_without_extension() {
        assert_eq!(lang("Dockerfile"), "dockerfile");
        assert_eq!(lang("docker/Dockerfile.dev"), "plaintext");
        assert_eq!(lang("Makefile"), "makefile");
    }

    #[test]
    fn unknown_extension_falls_back_to_plaintext() {
        assert_eq!(lang("a.unknownext"), "plaintext");
        assert_eq!(lang("LICENSE"), "plaintext");
        assert_eq!(lang("a."), "plaintext");
    }
}
