/**
 * latex-suite's default `wordDelimiters`: `"., +-\n\t:;!?\\/{}[]()=~$"`.
 * The `\n` in the comma string is a literal two-character sequence; it is
 * turned back into a real newline when used (see isWordBoundary in engine).
 */
export const LATEX_SUITE_WORD_DELIMITERS = "., +-\n\t:;!?\\/{}[]()=~$";

/**
 * The LaTeX Suite settings, one per same-named option of obsidian-latex-suite
 * (see the plugin with id=obsidian-latex-suite in
 * obsidian-vim-input-auto-switch/manifest.json; its source path is recorded in
 * AGENTS.md). The defaults are the plugin's own defaults, which are also the
 * values in the user's data.json; the field names follow the plugin so each
 * entry can be compared against the plugin source.
 *
 * This is module-level mutable state (like `snippetStore`): it is persisted
 * in the app settings and pushed in by applySettingsToEditor; the editor
 * extension reads it directly instead of threading the store through the
 * extension. This module deliberately imports nothing — appStore needs its
 * types and defaults and must not be dragged into the editor dependency graph.
 */
export interface LatexConfig {
  /** Upgrade to \left…\right when a trigger word appears inside brackets (runs unconditionally after auto-fraction) */
  autoEnlargeBrackets: boolean;
  /** The words that trigger enlargement, matched as substrings (the plugin's autoEnlargeBracketsTriggers) */
  autoEnlargeTriggers: string[];
  /** In a matrix environment, Shift+Tab inserts ` & ` and Enter inserts a ` \\` line break (the plugin's matrixShortcutsEnabled) */
  matrixShortcuts: boolean;
  /** The matrix environment names (the plugin's matrixShortcutsEnvNames) */
  matrixEnvs: string[];
  /** After Tab finishes a snippet, leave the bracket/formula block (the plugin's taboutEnabled) */
  tabout: boolean;
  /** Colored bracket pairs (the plugin's colorPairedBracketsEnabled) */
  bracketColors: boolean;
  /** Highlight the bracket at the caret and its partner (the plugin's highlightCursorBracketsEnabled) */
  highlightCursorBrackets: boolean;
  /** Delete both `$` at once with Backspace when the caret sits between them (the plugin's autoDelete$) */
  autoDeleteDollar: boolean;
  /** Remove the extra whitespace after a snippet expands inside inline math (the plugin's removeSnippetWhitespace) */
  removeSnippetWhitespace: boolean;
  /** The delimiter set for `w` (word boundary) snippets (the plugin's wordDelimiters, whose `\n` is a literal two-character sequence) */
  wordDelimiters: string;
}

export const DEFAULT_LATEX_CONFIG: LatexConfig = {
  autoEnlargeBrackets: true,
  autoEnlargeTriggers: ["sum", "int", "frac", "prod", "bigcup", "bigcap"],
  matrixShortcuts: true,
  matrixEnvs: [
    "pmatrix",
    "cases",
    "align",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
    "array",
    "matrix",
  ],
  bracketColors: true,
  highlightCursorBrackets: true,
  autoDeleteDollar: true,
  removeSnippetWhitespace: true,
  tabout: true,
  wordDelimiters: LATEX_SUITE_WORD_DELIMITERS,
};

let current: LatexConfig = { ...DEFAULT_LATEX_CONFIG };

/** The current settings (the editor extension calls this while reading keys,
 *  so do not cache it in a closure). */
export function latexConfig(): LatexConfig {
  return current;
}

export function configureLatexSuite(patch: Partial<LatexConfig>): void {
  current = { ...current, ...patch };
}

/** Restores the defaults (used by the tests and by "restore built-in"). */
export function resetLatexConfig(): void {
  current = { ...DEFAULT_LATEX_CONFIG };
}
