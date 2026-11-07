/**
 * The vim switch of the code editor.
 *
 * The global switch (`settings.vim`) is the one the user thinks in, so the
 * code area follows it by default. The two habits can differ (j/k moves in
 * code but formats a note), so an explicit "on" / "off" pins the code side
 * and stops it from following.
 */
export type CodeVimMode = "inherit" | "on" | "off";

export const DEFAULT_CODE_VIM: CodeVimMode = "inherit";

/**
 * However the stored value looks, turn it into a mode.
 *
 * A legacy config (before the inherit mode) stored a boolean whose default
 * was false. That false cannot be told apart from a deliberate "off", so it
 * migrates to "inherit" — the settings page can pin "off" again. The stored
 * type is what makes the migration one-off: strings are never re-migrated,
 * so an explicit "off" survives every later launch.
 */
export function normalizeCodeVim(value: unknown): CodeVimMode {
  if (value === "on" || value === "off" || value === "inherit") return value;
  if (value === true) return "on";
  return DEFAULT_CODE_VIM;
}

/** Whether the code editor runs vim right now. */
export function codeVimEnabled(settings: { vim: boolean; codeVim: CodeVimMode }): boolean {
  return settings.codeVim === "inherit" ? settings.vim : settings.codeVim === "on";
}
