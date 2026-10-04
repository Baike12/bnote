import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/** Markdown with GFM (tables, strikethrough, task lists, autolinks)
 *  and lazy-loaded embedded languages for fenced code blocks. */
export function markdownExtensions(): Extension {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    extensions: [GFM],
  });
}

/** Code palette comes from global.css variables (:root dark, [data-theme="light"]
 *  override) so the highlight follows the theme switch without reconfiguring.
 *  Markdown styling is applied by the live-preview decorations (classes) so only
 *  code tags are colored here; markdown text tags mirror the same variables so
 *  lines stay consistently colored while the cursor edits them. */
export const bnoteHighlightStyle = HighlightStyle.define([
  { tag: t.strong, fontWeight: "700", color: "var(--strong-color, #ff82b2)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--strong-color, #ff82b2)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--link, #79a9ec)" },
  { tag: t.url, color: "var(--tok-comment, #7f848e)" },
  { tag: t.monospace, color: "var(--tok-number, #d19a66)" },

  // Embedded code
  { tag: t.keyword, color: "var(--keyword, #c678dd)" },
  { tag: t.controlKeyword, color: "var(--keyword, #c678dd)" },
  { tag: t.moduleKeyword, color: "var(--keyword, #c678dd)" },
  { tag: t.operatorKeyword, color: "var(--keyword, #c678dd)" },
  { tag: t.definitionKeyword, color: "var(--keyword, #c678dd)" },
  { tag: t.string, color: "var(--string, #98c379)" },
  { tag: t.special(t.string), color: "var(--string, #98c379)" },
  { tag: t.number, color: "var(--tok-number, #d19a66)" },
  { tag: t.bool, color: "var(--tok-number, #d19a66)" },
  { tag: t.atom, color: "var(--tok-number, #d19a66)" },
  { tag: t.null, color: "var(--tok-number, #d19a66)" },
  { tag: t.comment, color: "var(--tok-comment, #7f848e)", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "var(--tok-func, #61afef)" },
  { tag: t.function(t.propertyName), color: "var(--tok-func, #61afef)" },
  { tag: t.typeName, color: "var(--tok-type, #e5c07b)" },
  { tag: t.className, color: "var(--tok-type, #e5c07b)" },
  { tag: t.propertyName, color: "var(--tok-var, #e06c75)" },
  { tag: t.variableName, color: "var(--tok-var, #e06c75)" },
  { tag: t.definition(t.variableName), color: "var(--tok-var, #e06c75)" },
  { tag: t.operator, color: "var(--tok-operator, #56b6c2)" },
  { tag: t.punctuation, color: "var(--tok-punct, #abb2bf)" },
  { tag: t.regexp, color: "var(--string, #98c379)" },
  { tag: t.escape, color: "var(--tok-operator, #56b6c2)" },
  { tag: t.meta, color: "var(--tok-comment, #7f848e)" },
  { tag: t.invalid, color: "var(--tok-invalid, #f66)" },
]);

export function codeHighlighting(): Extension {
  return syntaxHighlighting(bnoteHighlightStyle);
}
