import { LanguageDescription } from "@codemirror/language";
import { languages as dataLanguages } from "@codemirror/language-data";

/**
 * languageId → CodeMirror syntax package.
 *
 * The languageId is decided by the backend from the file extension (the Rust
 * side `code/lang.rs` is the only source); this module only turns it into a
 * set of syntax support. The four main languages (ts / rust / go / python)
 * get dedicated lezer packages — tree-sitter grade parsing quality,
 * incremental parsing, no stutter on large files; every other language falls
 * back to the generic set of `@codemirror/language-data`.
 *
 * All packages are **loaded dynamically**: the Go parser is fetched only when
 * a Go file is opened, so the first screen does not pay for four languages.
 */

/** Descriptions of the core languages (languageId → description). */
const CORE: Record<string, LanguageDescription> = {
  typescript: LanguageDescription.of({
    name: "TypeScript",
    alias: ["typescript", "ts"],
    extensions: ["ts", "mts", "cts"],
    load: async () =>
      (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  }),
  typescriptreact: LanguageDescription.of({
    name: "TypeScript JSX",
    alias: ["typescriptreact", "tsx"],
    extensions: ["tsx"],
    load: async () =>
      (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  }),
  javascript: LanguageDescription.of({
    name: "JavaScript",
    alias: ["javascript", "js"],
    extensions: ["js", "mjs", "cjs"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript(),
  }),
  javascriptreact: LanguageDescription.of({
    name: "JavaScript JSX",
    alias: ["javascriptreact", "jsx"],
    extensions: ["jsx"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  }),
  rust: LanguageDescription.of({
    name: "Rust",
    alias: ["rust", "rs"],
    extensions: ["rs"],
    load: async () => (await import("@codemirror/lang-rust")).rust(),
  }),
  go: LanguageDescription.of({
    name: "Go",
    alias: ["go", "golang"],
    extensions: ["go"],
    load: async () => (await import("@codemirror/lang-go")).go(),
  }),
  python: LanguageDescription.of({
    name: "Python",
    alias: ["python", "py"],
    extensions: ["py", "pyi"],
    load: async () => (await import("@codemirror/lang-python")).python(),
  }),
};

/** Index of the generic set of language-data, keyed by alias (a miss means the language is unknown). */
const DATA_BY_ALIAS = new Map<string, LanguageDescription>();
for (const desc of dataLanguages) {
  for (const alias of desc.alias) {
    if (!DATA_BY_ALIAS.has(alias)) DATA_BY_ALIAS.set(alias, desc);
  }
}

/** Find the description of a languageId; null when there is none (plain text). */
export function findLanguage(languageId: string): LanguageDescription | null {
  if (!languageId || languageId === "plaintext") return null;
  const core = CORE[languageId];
  if (core) return core;
  return DATA_BY_ALIAS.get(languageId) ?? null;
}
