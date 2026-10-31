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
 *  Markdown inline text styling (strong / emphasis / strikethrough) is NOT here:
 *  a tag paints the parser's whole node, and lezer pairs the `_` of LaTeX
 *  subscripts inside formulas into one bogus Emphasis spanning the prose
 *  between them — no decoration-side filter can undo that. Those marks are
 *  drawn by `emphasisMarksExtension` (math-aware) instead, identically in live
 *  preview and raw mode. */
export const bnoteHighlightStyle = HighlightStyle.define([
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
