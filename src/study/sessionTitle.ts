/**
 * Session titles: the local fallback (the first message, truncated) and the
 * model-generated title share one cleaning rule set.
 *
 * A model title often carries quotes, book title marks, a `Title:` prefix or
 * a trailing full stop; the list and the header are both narrow single-line
 * spots that ellipsize, so the cleaning must happen before the title is
 * stored — otherwise those characters eat the visible width.
 */

/** The session's own first user message (skipping the prefix copied over by a fork). */
export function firstOwnUserText(
  entries: ReadonlyArray<{ role: string; text: string }>,
  forkAt: number,
): string {
  const start = Math.max(0, Math.min(forkAt, entries.length));
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry?.role !== "user") continue;
    const text = entry.text.trim();
    if (text) return text;
  }
  return "";
}

/** A pair of characters that may wrap a model title (only stripped when both are present). */
const WRAPPERS: Array<[string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["「", "」"],
  ["《", "》"],
  ["'", "'"],
  ["`", "`"],
  ["*", "*"],
];

/** Prefixes models like to add: a CJK title label followed by a colon or dash, or "Title:". */
const PREFIX_RE = /^(?:会话)?标题\s*[:：\-–—]\s*|^title\s*[:：\-–—]\s*/i;

/**
 * Clean a model-provided title: take the first line, strip quotes / prefix,
 * drop the trailing punctuation, collapse whitespace, truncate. Returns an
 * empty string when nothing is left; the caller then keeps its fallback
 * title.
 */
export function cleanGeneratedTitle(raw: string, limit = 24): string {
  const firstLine =
    (raw ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .find((l) => l.trim()) ?? "";
  let text = firstLine.replace(/\s+/g, " ").trim();
  text = text.replace(PREFIX_RE, "").trim();
  for (const [open, close] of WRAPPERS) {
    while (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
    }
  }
  text = text.replace(/[。．.、,，;；:：!！?？]+$/u, "").trim();
  return Array.from(text).slice(0, limit).join("").trim();
}

/** Sub-session title prefix: the hierarchy has to be obvious at a glance in both the header button and the history list. */
export const AUX_TITLE_PREFIX = "↳ ";

/** The final display title for a session level (the main session has no prefix). */
export function displayTitle(title: string, isAux: boolean): string {
  const clean = title.trim();
  if (!isAux) return clean;
  return clean.startsWith(AUX_TITLE_PREFIX) ? clean : `${AUX_TITLE_PREFIX}${clean}`;
}
