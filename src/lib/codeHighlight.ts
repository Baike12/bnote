import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { bnoteHighlightStyle } from "@/editor/highlightStyle";
import { languageDescriptions } from "@/code/editor/language";

/**
 * Syntax highlighting for **read-only** code (agent replies and the
 * code-mode markdown preview).
 *
 * The prose renderers produce HTML strings, so the editor's syntax packages
 * cannot be mounted there. This module reuses exactly the same parsers and
 * the same palette as the code editor (`editor/highlightStyle.ts`): the fence
 * language name is resolved against the same descriptions, the parser builds
 * a tree, and `highlightTree` writes one `<span style="…">` per colored range
 * with the HighlightStyle's own CSS (which reads the sheet's variables, so the
 * theme switch applies without re-rendering).
 *
 * Everything else is escaped: the output is built by this module only from
 * escaped source text, never from the reply's own HTML. A fence whose language
 * is unknown returns null and the caller renders plain text.
 */

/** Escape text for a `<code>` element; attribute escaping is not needed here. */
export function escapeCodeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Fence names that mean "plain text". They must not reach the extension
 * fallback: `text` is an extension of the LaTeX package, and a ```text block
 * colored as LaTeX would be nonsense.
 */
const PLAIN_LANGUAGES = new Set(["text", "txt", "plain", "plaintext", "none", "output", "log"]);

/**
 * Resolve a fence language name (`ts`, `tsx`, `yaml`, `sh`, `c++`…) to a
 * description. Aliases decide first (the same match the note editor's fenced
 * blocks use); an extension name is the fallback, because fences often write
 * `c++` or `objective-c++`, which are extensions rather than aliases.
 */
export function findFenceLanguage(name: string): LanguageDescription | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted || PLAIN_LANGUAGES.has(wanted)) return null;
  const byAlias = LanguageDescription.matchLanguageName(languageDescriptions(), wanted, false);
  if (byAlias) return byAlias;
  return languageDescriptions().find((d) => d.extensions.includes(wanted)) ?? null;
}

/**
 * Mount the palette's CSS once.
 *
 * A HighlightStyle emits generated class names and keeps the matching rules in
 * its `module`; inside an editor `syntaxHighlighting` mounts them. Rendered
 * code has no editor, so the same rules are appended to the document head
 * here — one <style> for the whole app, however many code blocks there are.
 */
let cssMounted = false;

function ensureHighlightCss(): void {
  if (cssMounted || typeof document === "undefined") return;
  cssMounted = true;
  const rules = bnoteHighlightStyle.module?.getRules();
  if (!rules) return;
  const style = document.createElement("style");
  style.dataset.bnoteHighlight = "";
  style.textContent = rules;
  document.head.appendChild(style);
}

/** One parser per language: the first code block pays the load, the rest reuse it. */
const supports = new Map<string, Promise<LanguageSupport | null>>();

function loadSupport(desc: LanguageDescription): Promise<LanguageSupport | null> {
  const cached = supports.get(desc.name);
  if (cached) return cached;
  const promise = desc.load().catch(() => null);
  supports.set(desc.name, promise);
  return promise;
}

/**
 * The highlighted HTML of one block, keyed by language and content.
 *
 * A streamed reply re-renders the last block on every chunk; the cache keeps
 * the work bounded to "one parse per distinct content". The map is a plain
 * insertion-ordered LRU with a hard cap, so a long session cannot grow it
 * without bound.
 */
const htmlCache = new Map<string, string>();
const HTML_CACHE_LIMIT = 200;

/** Highlight `code` as `lang`; null when the language is unknown or its parser failed to load. */
export async function highlightCodeHtml(code: string, lang: string): Promise<string | null> {
  const desc = findFenceLanguage(lang);
  if (!desc) return null;
  const key = `${desc.name}\u0000${code}`;
  const cached = htmlCache.get(key);
  if (cached !== undefined) {
    htmlCache.delete(key);
    htmlCache.set(key, cached);
    return cached;
  }
  const support = await loadSupport(desc);
  const language = support?.language;
  if (!language) return null;
  ensureHighlightCss();
  const tree = language.parser.parse(code);
  const parts: string[] = [];
  let pos = 0;
  highlightTree(tree, bnoteHighlightStyle, (from, to, classes) => {
    if (from > pos) parts.push(escapeCodeHtml(code.slice(pos, from)));
    parts.push(`<span class="${classes}">${escapeCodeHtml(code.slice(from, to))}</span>`);
    pos = to;
  });
  if (pos < code.length) parts.push(escapeCodeHtml(code.slice(pos)));
  const html = parts.join("");
  htmlCache.set(key, html);
  if (htmlCache.size > HTML_CACHE_LIMIT) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  return html;
}
