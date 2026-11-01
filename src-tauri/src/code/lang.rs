//! 扩展名 → LSP languageId。
//!
//! 这是**唯一**的扩展名→语言映射来源:前端拿后端回的 languageId 去挑
//! CodeMirror 的语法包,两边不必各维护一张表。
//!
//! languageId 用 LSP 约定的名字(`typescript` / `rust` / `go` / `python` …),
//! 与语言服务器 `didOpen` 里要填的 languageId 是同一个词。

use std::path::Path;

/// 由文件扩展名推断 LSP languageId;不认识的后缀返回 "plaintext"。
///
/// 复合后缀优先(`d.ts` → typescript、`tar.gz` → 不认识)。同名文件
/// (`Dockerfile`、`Makefile`)按整个文件名认。
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
        "svelte" => "svelte",
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
