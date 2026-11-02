/**
 * When to ask the language server for completions, and how to ask.
 *
 * CodeMirror calls the completion source on every edit. The server must not be
 * bothered for every punctuation keystroke, but the **highest-value** moment —
 * typing the dot of `np.` and expecting the members of the module — has no
 * word before the caret at all. That case used to be dropped by "no typed word,
 * no request", so `np.` showed nothing.
 *
 * Pure functions so the rule is testable without an editor or IPC.
 */

/**
 * Characters after which the server offers members with no typed word yet.
 * Taken from ty's `completionProvider.triggerCharacters`; the dot is the one
 * every language we ship cares about (property access), ty adds the two quote
 * characters for Python string literals.
 */
export const TRIGGER_CHARS: ReadonlySet<string> = new Set([".", "\"", "'"]);

/** The trigger character the caret sits right after, or null. */
export function triggerCharacterFor(prevChar: string): string | null {
  return TRIGGER_CHARS.has(prevChar) ? prevChar : null;
}

/**
 * The `context` of `textDocument/completion` (LSP 3.17).
 *
 * TriggerKind 2 must carry the character that caused it; every other request —
 * automatic after typing a word, and the explicit `Ctrl-Space` — is
 * `Invoked` (1). Sending 2 without a character is what the old code did, which
 * no server should have to guess about.
 */
export function completionRequestContext(
  trigger: string | null,
): { triggerKind: number; triggerCharacter?: string } {
  if (trigger) return { triggerKind: 2, triggerCharacter: trigger };
  return { triggerKind: 1 };
}
