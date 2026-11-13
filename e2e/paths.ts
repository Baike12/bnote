import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every artifact of an E2E run lives under `e2e/.tmp`, never in the user's
 * real app-data directory or vault. The config (launcher) and the specs
 * (worker) derive the same paths from this module.
 */
export const E2E_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TMP_DIR = path.join(E2E_ROOT, ".tmp");
export const DATA_DIR = path.join(TMP_DIR, "data");
export const VAULT_DIR = path.join(TMP_DIR, "vault");
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const APP_BINARY = path.resolve(E2E_ROOT, "..", "src-tauri", "target", "debug", "bnote");
export const FIXTURES_DIR = path.join(E2E_ROOT, "fixtures", "vault");
