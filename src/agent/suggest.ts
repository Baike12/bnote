/**
 * Two completion triggers in the creative-mode input:
 * - `/skill-name`: pick a skill (only when / appears at the start of the text or after whitespace, so paths and code are not swallowed);
 * - `@path/to/file`: reference a vault file (triggers anywhere).
 *
 * The trigger is sent to the model verbatim; the semantics (/ invokes the skill
 * tool, @ reads the file) are explained by the creative-mode system prompt.
 */

export interface SuggestTrigger {
  kind: "skill" | "file";
  /** Index of the trigger start (including the / or @) in the text. */
  start: number;
  /** The query after / or @ (trigger start to caret, no whitespace). */
  query: string;
}

/** Nearest whitespace/word boundary before the caret. */
function lastWordStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === " " || ch === "\n" || ch === "\t") break;
    i -= 1;
  }
  return i;
}

/**
 * Parse the completion trigger at the caret. null means no trigger.
 *
 * skill(`/`) fires only at the start of a line; file(`@`) fires anywhere,
 * because a file reference usually follows prose directly.
 */
export function parseSuggestTrigger(text: string, caret: number): SuggestTrigger | null {
  if (caret < 0 || caret > text.length) return null;
  const wordStart = lastWordStart(text, caret);
  const word = text.slice(wordStart, caret);
  if (word.startsWith("/")) {
    // Line-anchored: only the start of the text or a line break counts, so
    // `/data/2026` and a slash in a mid-line path never trigger it; @ has no such limit, a file reference usually follows prose.
    if (wordStart !== 0 && text[wordStart - 1] !== "\n") return null;
    return { kind: "skill", start: wordStart, query: word.slice(1) };
  }
  if (word.startsWith("@")) {
    return { kind: "file", start: wordStart, query: word.slice(1) };
  }
  return null;
}

/** Replace the trigger with the full reference; returns the new text and caret. */
export function applySuggestion(
  text: string,
  trigger: SuggestTrigger,
  replacement: string,
): { text: string; caret: number } {
  const insert = `${replacement} `;
  const next =
    text.slice(0, trigger.start) + insert + text.slice(trigger.start + 1 + trigger.query.length);
  const caret = trigger.start + insert.length;
  return { text: next, caret };
}
