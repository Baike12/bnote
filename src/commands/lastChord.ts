/**
 * The modifier chord that triggered the last command from a real keystroke
 * (recorded by the global keybinding dispatcher). The quick switcher reads it
 * when it opens so repeating the same chord — Cmd+S Cmd+S … — can cycle the
 * result list, like holding alt-tab.
 */

let last: { key: string; at: number } | null = null;

export function recordCommandChord(e: KeyboardEvent) {
  last = { key: e.key.toLowerCase(), at: Date.now() };
}

/** The chord that opened the current UI, when it came from a keystroke just now. */
export function recentCommandChord(maxAgeMs = 3000): { key: string } | null {
  return last && Date.now() - last.at <= maxAgeMs ? last : null;
}
