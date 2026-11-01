import { LanguageDescription } from "@codemirror/language";
import { languages as dataLanguages } from "@codemirror/language-data";

/**
 * languageId → CodeMirror 语法包。
 *
 * languageId 由后端按扩展名判定(Rust 侧 `code/lang.rs` 是唯一来源),这里
 * 只负责把它变成一套语法支持。四种主力语言(ts / rust / go / python)用
 * 专门的 lezer 语法包——tree-sitter 级的解析质量,增量解析,大文件不卡;
 * 其余语言退回 `@codemirror/language-data` 的通用集合。
 *
 * 语法包都是**动态载入**的:打开一个 Go 文件才拉 Go 的解析器,首屏不必
 * 为四种语言都付钱。
 */

/** 核心四种语言的描述(languageId → 描述)。 */
const CORE: Record<string, LanguageDescription> = {
  typescript: LanguageDescription.of({
    name: "TypeScript",
    alias: ["typescript", "ts"],
    extensions: ["ts", "mts", "cts"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
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

/** language-data 里的通用集合按别名建的索引(找不到就当没这门语言)。 */
const DATA_BY_ALIAS = new Map<string, LanguageDescription>();
for (const desc of dataLanguages) {
  for (const alias of desc.alias) {
    if (!DATA_BY_ALIAS.has(alias)) DATA_BY_ALIAS.set(alias, desc);
  }
}

/** 这个 languageId 有没有语法包。 */
export function hasLanguage(languageId: string): boolean {
  return findLanguage(languageId) !== null;
}

/** 找 languageId 对应的描述;没有就 null(纯文本)。 */
export function findLanguage(languageId: string): LanguageDescription | null {
  if (!languageId || languageId === "plaintext") return null;
  const core = CORE[languageId];
  if (core) return core;
  return DATA_BY_ALIAS.get(languageId) ?? null;
}
