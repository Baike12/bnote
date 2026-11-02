/**
 * Pure model of the terminal drawer: the tab list and the drawer height.
 *
 * No React, no xterm, no IPC — the drawer component only renders what these
 * functions decide, which is what makes the tricky parts (closing the active
 * tab, numbering duplicate shells) testable without a DOM.
 */

export interface TermTab {
  /** Backend session id (the PTY lives in Rust). */
  id: number;
  /** Shell name, numbered when several shells share a name. */
  title: string;
  /** The shell process is gone; the tab stays until it is closed. */
  exited: boolean;
}

/** Smallest drawer that still shows a prompt plus a couple of output lines. */
export const TERM_MIN_HEIGHT = 90;
/** The height the drawer opens with, and the one a double-click restores. */
export const TERM_DEFAULT_HEIGHT = 220;
/**
 * Largest share of the code panel the drawer may take. The editor keeps the
 * rest: the terminal is a companion, not the main area.
 */
export const TERM_MAX_RATIO = 0.7;

/** A persisted height: bad data falls back to the default, the bounds are left to dragging and CSS. */
export function normalizeTermHeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : TERM_DEFAULT_HEIGHT;
}

/** While dragging: at least TERM_MIN_HEIGHT, at most 70% of the pane. */
export function clampTermHeight(height: number, paneHeight: number): number {
  const max = Math.max(TERM_MIN_HEIGHT, Math.round(Math.max(0, paneHeight) * TERM_MAX_RATIO));
  return Math.round(Math.min(Math.max(TERM_MIN_HEIGHT, height), max));
}

/**
 * The title a new tab gets. Shells all report the same base name, so the
 * second `zsh` becomes `zsh 2` — a tab strip of five identical names is
 * impossible to navigate.
 */
export function nextTitle(tabs: readonly TermTab[], base: string): string {
  const taken = new Set(tabs.map((tab) => tab.title));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Remove one tab and decide which tab takes the focus.
 *
 * Closing the active tab lands on its right neighbour, or on the left one when
 * the closed tab was last (the tab strip loses no context that way); closing
 * the last tab leaves `activeId` null, which is what makes the drawer close.
 * Closing a background tab never moves the focus.
 */
export function closeTab(
  tabs: readonly TermTab[],
  activeId: number | null,
  id: number,
): { tabs: TermTab[]; activeId: number | null } {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { tabs: [...tabs], activeId };
  const rest = tabs.filter((tab) => tab.id !== id);
  if (activeId !== id) return { tabs: rest, activeId };
  const next = rest[index] ?? rest[index - 1] ?? null;
  return { tabs: rest, activeId: next ? next.id : null };
}
