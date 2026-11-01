/**
 * MRU model for recently opened vaults (modelled on zed's recent projects, with two decisions: dedupe by identity key,
 * and filter the current entry on read). The identity key is the canonicalized path string the backend produces in
 * set_vault -- the folder picker, startup restore and the switch in this module all get the same canonical form,
 * so a second normalization pass is not needed.
 */

/** Hard cap: config.json is a single JSON file, so the oldest entries are dropped once it overflows (zed has no cap and relies on GC; the list here is small, so a cap is enough). */
export const RECENT_VAULTS_CAP = 10;

/** Open/switch to a vault: move it to the front, dedupe by path, drop the tail past the cap. Pure function, does not mutate its input. */
export function touchRecentVault(list: string[], path: string): string[] {
  if (!path) return list.slice();
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_VAULTS_CAP);
}

/**
 * Switch target: the first non-current path in the MRU. The current vault is filtered on read instead of removed on
 * write (same as zed), so it always stays in the list -- that is what makes toggling between two vaults work.
 * Returns null for an empty list or one that only holds the current vault; with no vault open (current is null) it
 * returns the most recent one, so the welcome page can jump back to the last vault in one click.
 */
export function recentVaultTarget(list: string[], current: string | null): string | null {
  return list.find((p) => p !== current && p !== "") ?? null;
}
