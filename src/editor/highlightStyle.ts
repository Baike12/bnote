import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * The code palette is the GitHub one (Primer "prettylights"), read from
 * the sheet's variables (:root dark, [data-theme="light"] override) so the
 * highlight follows the theme switch without reconfiguring. One hue per
 * semantic role — keyword red, function purple, type/class orange, constant
 * blue, string pale blue, regex green, comment gray — and everything else
 * (identifiers, operators, punctuation) keeps the body color, the way GitHub
 * renders code. That restraint is the point: a function name, a parameter and
 * a module used to land on the same warm red because one `definition` rule sat
 * after the function rule and repainted every `def name`; now a colored token
 * always means the same thing.
 *
 * Rules run from general to specific: a function *definition* is tagged both
 * `definition(function(variableName))` and its ancestors, and the last matching
 * rule wins, so the function rules must come last.
 *
 * Lives outside markdown.ts because the agent panel and the code-mode markdown
 * preview reuse it for read-only code blocks (`lib/codeHighlight.ts`); pulling
 * the markdown editor extensions in there would bundle them for no reason.
 *
 * Markdown inline text styling (strong / emphasis / strikethrough) is NOT here:
 * a tag paints the parser's whole node, and lezer pairs the `_` of LaTeX
 * subscripts inside formulas into one bogus Emphasis spanning the prose
 * between them — no decoration-side filter can undo that. Those marks are
 * drawn by `emphasisMarksExtension` (math-aware) instead, identically in live
 * preview and raw mode.
 */
export const bnoteHighlightStyle = HighlightStyle.define([
  { tag: t.link, color: "var(--link, #79a9ec)" },
  { tag: t.url, color: "var(--tok-comment, #7f848e)" },
  { tag: t.monospace, color: "var(--tok-number, #d19a66)" },

  // Embedded code — plain roles first.
  { tag: t.comment, color: "var(--tok-comment, #7f848e)" },
  { tag: t.keyword, color: "var(--tok-keyword, #c678dd)" },
  { tag: t.controlKeyword, color: "var(--tok-keyword, #c678dd)" },
  { tag: t.moduleKeyword, color: "var(--tok-keyword, #c678dd)" },
  { tag: t.operatorKeyword, color: "var(--tok-keyword, #c678dd)" },
  { tag: t.definitionKeyword, color: "var(--tok-keyword, #c678dd)" },
  { tag: t.modifier, color: "var(--tok-keyword, #c678dd)" },
  { tag: t.string, color: "var(--tok-string, #98c379)" },
  { tag: t.special(t.string), color: "var(--tok-string, #98c379)" },
  { tag: t.escape, color: "var(--tok-string, #98c379)" },
  { tag: t.regexp, color: "var(--tok-regexp, #98c379)" },
  { tag: t.number, color: "var(--tok-const, #d19a66)" },
  { tag: t.bool, color: "var(--tok-const, #d19a66)" },
  { tag: t.null, color: "var(--tok-const, #d19a66)" },
  { tag: t.atom, color: "var(--tok-const, #d19a66)" },
  { tag: t.self, color: "var(--tok-const, #d19a66)" },
  { tag: t.constant(t.variableName), color: "var(--tok-const, #d19a66)" },
  { tag: t.typeName, color: "var(--tok-type, #e5c07b)" },
  { tag: t.className, color: "var(--tok-type, #e5c07b)" },
  { tag: t.namespace, color: "var(--tok-type, #e5c07b)" },
  { tag: t.tagName, color: "var(--tok-type, #e5c07b)" },
  { tag: t.invalid, color: "var(--tok-invalid, #f66)" },

  // Keys: YAML and JSON map keys, TOML keys, JS/TS object literal keys and
  // class fields. Without this rule a YAML document showed only its strings
  // and comments — every key stayed the body color, which read as "no
  // highlighting at all". Member access (`obj.key`) is plain `propertyName`
  // and deliberately keeps the body color, as on GitHub.
  { tag: t.definition(t.propertyName), color: "var(--tok-property, #79c0ff)" },

  // Names that are functions: a declaration, a call, a macro, a decorator.
  { tag: t.function(t.variableName), color: "var(--tok-func, #61afef)" },
  { tag: t.function(t.propertyName), color: "var(--tok-func, #61afef)" },
  { tag: t.macroName, color: "var(--tok-func, #61afef)" },
  { tag: t.annotation, color: "var(--tok-func, #61afef)" },
]);
