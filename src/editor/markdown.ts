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

/** One-dark-ish palette for code content; markdown styling is applied by the
 *  live-preview decorations (classes) so only code tags are colored here. */
export const bnoteHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: "#d19a66" },
  { tag: t.strong, fontWeight: "700", color: "#e6e6e6" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "#8ab4f8" },
  { tag: t.url, color: "#7f848e" },
  { tag: t.monospace, color: "#d19a66" },

  // Embedded code
  { tag: t.keyword, color: "#c678dd" },
  { tag: t.controlKeyword, color: "#c678dd" },
  { tag: t.moduleKeyword, color: "#c678dd" },
  { tag: t.operatorKeyword, color: "#c678dd" },
  { tag: t.definitionKeyword, color: "#c678dd" },
  { tag: t.string, color: "#98c379" },
  { tag: t.special(t.string), color: "#98c379" },
  { tag: t.number, color: "#d19a66" },
  { tag: t.bool, color: "#d19a66" },
  { tag: t.atom, color: "#d19a66" },
  { tag: t.null, color: "#d19a66" },
  { tag: t.comment, color: "#7f848e", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "#61afef" },
  { tag: t.function(t.propertyName), color: "#61afef" },
  { tag: t.typeName, color: "#e5c07b" },
  { tag: t.className, color: "#e5c07b" },
  { tag: t.propertyName, color: "#e06c75" },
  { tag: t.variableName, color: "#e06c75" },
  { tag: t.definition(t.variableName), color: "#e06c75" },
  { tag: t.operator, color: "#56b6c2" },
  { tag: t.punctuation, color: "#abb2bf" },
  { tag: t.regexp, color: "#98c379" },
  { tag: t.escape, color: "#56b6c2" },
  { tag: t.meta, color: "#7f848e" },
  { tag: t.invalid, color: "#f66" },
]);

export function codeHighlighting(): Extension {
  return syntaxHighlighting(bnoteHighlightStyle);
}
