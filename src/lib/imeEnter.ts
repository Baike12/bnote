/**
 * Whether this Enter belongs to an IME session (composing, or confirming a
 * candidate) rather than "send".
 *
 * All three signals have to be checked:
 * - composing: the session state the component records itself via
 *   compositionstart/end, independent of the engine;
 * - isComposing: the standard field, true while a composition is active;
 * - keyCode === 229: WKWebView reports 229 on the IME confirmation key while
 *   isComposing is still false (the vim engine's composing check relies on the
 *   same pair, see src/editor/vim/vim.ts).
 *
 * Watching isComposing alone makes "type latin letters in Chinese mode and
 * confirm with Enter" send the message straight away.
 */
export function isImeEnter(
  event: { isComposing?: boolean; keyCode?: number },
  composing: boolean,
): boolean {
  return composing || event.isComposing === true || event.keyCode === 229;
}
