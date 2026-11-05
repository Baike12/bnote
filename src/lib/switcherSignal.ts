/**
 * The quick switcher's chord-repeat hook, as a signal.
 *
 * Holding the opening chord repeats the command, and each repeat has to move the
 * selection inside the switcher — a UI behaviour the command layer needs. The
 * command used to import `components/QuickSwitcher` directly (a controller
 * depending on a component); now the component registers its handler here and
 * the command calls the signal.
 */

/** Returns whether the selection moved (false = the switcher is closed or empty). */
export type SwitcherCycle = (dir: 1 | -1) => boolean;

let cycle: SwitcherCycle | null = null;

/** Called by the switcher while it is open; the cleanup passes `null`. */
export function registerSwitcherCycle(fn: SwitcherCycle | null): void {
  cycle = fn;
}

/** Chord repeat (⌘S ⌘S … while the switcher is open) moves the selection. */
export function cycleQuickSwitcher(dir: 1 | -1): boolean {
  return cycle ? cycle(dir) : false;
}
