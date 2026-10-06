//! Port of `src/editor/snippets/config.ts` — LaTeX Suite settings.
//!
//! The TS module keeps the settings in module-level mutable state
//! (`latexConfig()` / `configureLatexSuite`); the port drops the global and
//! passes `&LatexConfig` into every entry point, so the host stays the single
//! writer (see the crate's "one writer per state" rule).

/// latex-suite `wordDelimiters` default: `"., +-\n\t:;!?\\/{}[]()=~$"`.
///
/// The `\n`/`\t` here are real control characters (as in the TS string
/// literal). A user settings string carrying the literal two-character `\n` is
/// restored to a newline at use site — see [`crate::snippets::engine::is_word_boundary`].
pub const LATEX_SUITE_WORD_DELIMITERS: &str = "., +-\n\t:;!?\\/{}[]()=~$";

/// Port of `src/editor/snippets/config.ts::LatexConfig`.
///
/// Field names/`snake_case` mirror the plugin settings; defaults mirror
/// `DEFAULT_LATEX_CONFIG` (the plugin defaults, which are also the owner's
/// `data.json` values).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatexConfig {
    /// Auto-upgrade brackets to `\left…\right` when a trigger word appears
    /// inside them (runs once after every auto-fraction).
    pub auto_enlarge_brackets: bool,
    /// Enlargement trigger words, substring-matched (plugin `autoEnlargeBracketsTriggers`).
    pub auto_enlarge_triggers: Vec<String>,
    /// Matrix envs: Shift+Tab inserts ` & `, Enter inserts ` \\` (plugin `matrixShortcutsEnabled`).
    pub matrix_shortcuts: bool,
    /// Matrix environment names (plugin `matrixShortcutsEnvNames`).
    pub matrix_envs: Vec<String>,
    /// Tab exits brackets / math blocks once the snippet session is done (plugin `taboutEnabled`).
    pub tabout: bool,
    /// Colored paired brackets (plugin `colorPairedBracketsEnabled`).
    pub bracket_colors: bool,
    /// Highlight the bracket at the cursor and its pair (plugin `highlightCursorBracketsEnabled`).
    pub highlight_cursor_brackets: bool,
    /// Backspace between two `$` deletes both at once (plugin `autoDelete$`).
    pub auto_delete_dollar: bool,
    /// Drop redundant whitespace after expanding inside inline math (plugin `removeSnippetWhitespace`).
    pub remove_snippet_whitespace: bool,
    /// Word delimiters for `w` snippets (plugin `wordDelimiters`; a literal `\n`
    /// in the settings string is restored to a newline at use site).
    pub word_delimiters: String,
}

/// Port of `src/editor/snippets/config.ts::DEFAULT_LATEX_CONFIG`.
pub fn default_latex_config() -> LatexConfig {
    LatexConfig {
        auto_enlarge_brackets: true,
        auto_enlarge_triggers: ["sum", "int", "frac", "prod", "bigcup", "bigcap"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        matrix_shortcuts: true,
        matrix_envs: [
            "pmatrix", "cases", "align", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "array",
            "matrix",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        bracket_colors: true,
        highlight_cursor_brackets: true,
        auto_delete_dollar: true,
        remove_snippet_whitespace: true,
        tabout: true,
        word_delimiters: LATEX_SUITE_WORD_DELIMITERS.to_string(),
    }
}

impl Default for LatexConfig {
    fn default() -> Self {
        default_latex_config()
    }
}

/// A `LatexConfig` value usable in `const` contexts (mirrors the TS default).
/// `LatexConfig` itself cannot be `const`-constructed because of its `Vec`s;
/// this static is the shared reference for code that must not allocate.
pub static DEFAULT_LATEX_CONFIG: std::sync::LazyLock<LatexConfig> =
    std::sync::LazyLock::new(default_latex_config);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_mirror_the_plugin() {
        let cfg = LatexConfig::default();
        assert!(cfg.auto_enlarge_brackets);
        assert_eq!(
            cfg.auto_enlarge_triggers,
            vec!["sum", "int", "frac", "prod", "bigcup", "bigcap"]
        );
        assert!(cfg.matrix_shortcuts);
        assert_eq!(
            cfg.matrix_envs,
            vec![
                "pmatrix", "cases", "align", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "array",
                "matrix"
            ]
        );
        assert!(cfg.bracket_colors);
        assert!(cfg.highlight_cursor_brackets);
        assert!(cfg.auto_delete_dollar);
        assert!(cfg.remove_snippet_whitespace);
        assert!(cfg.tabout);
        assert_eq!(cfg.word_delimiters, LATEX_SUITE_WORD_DELIMITERS);
        assert_eq!(*DEFAULT_LATEX_CONFIG, cfg);
    }

    #[test]
    fn delimiter_set_carries_real_newline_and_tab() {
        // The TS string literal holds real control characters; the port keeps
        // them, and the two-character `\n` form is handled by is_word_boundary.
        assert!(LATEX_SUITE_WORD_DELIMITERS.contains('\n'));
        assert!(LATEX_SUITE_WORD_DELIMITERS.contains('\t'));
        assert!(LATEX_SUITE_WORD_DELIMITERS.contains('\\'));
        assert!(!LATEX_SUITE_WORD_DELIMITERS.contains('*'));
    }
}
