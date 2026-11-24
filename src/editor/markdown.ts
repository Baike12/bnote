import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { bnoteHighlightStyle } from "./highlightStyle";

/** Markdown with GFM (tables, strikethrough, task lists, autolinks)
 *  and lazy-loaded embedded languages for fenced code blocks. */
export function markdownExtensions(): Extension {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    extensions: [GFM],
  });
}

// The palette itself lives in ./highlightStyle (shared with the read-only
// code blocks of the agent panel and the markdown preview).
export { bnoteHighlightStyle } from "./highlightStyle";

export function codeHighlighting(): Extension {
  return syntaxHighlighting(bnoteHighlightStyle);
}
