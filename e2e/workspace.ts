import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, DATA_DIR, FIXTURES_DIR, TMP_DIR, VAULT_DIR } from "./paths";

/**
 * Seeds a disposable app-data dir and vault before the app launches:
 *
 *   config.json { lastVault }  -> the app opens the fixture vault on boot
 *   vault/*                    -> real files on disk, so every read/write the
 *                                 spec observes went through the Rust backend
 *
 * Recreated per run, removed only after a passing run (a failure keeps the
 * vault and driver logs for inspection).
 */
export function prepareWorkspace(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.cpSync(FIXTURES_DIR, VAULT_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ lastVault: VAULT_DIR, settings: { autoSave: true } }, null, 2),
  );
}

export function cleanupWorkspace(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

/** The canonical vault path: the backend canonicalizes the path it stores. */
export function vaultRoot(): string {
  return fs.realpathSync(VAULT_DIR);
}

export function noteOnDisk(relPath: string): string {
  return path.join(vaultRoot(), relPath);
}
