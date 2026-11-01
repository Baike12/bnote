import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import {
  KEY_REGION_IDS,
  applyOverrides,
  bindingEquals,
  defaultBindingsFor,
  flattenOverrides,
  normalizeOverrides,
  regionOfCommand,
  serializeOverrides,
  type BindingMap,
  type BindingValue,
  type KeyRegion,
  type OverrideMap,
} from "./keys";

/**
 * The single writer of keybinding overrides.
 *
 * The config follows the vault: `<vault>/.bnote/keybindings.json` (the same
 * folder as vimrc / snippets.js), written through the whitelisted
 * `write_vault_file` command. Without an open vault it falls back to the
 * legacy `<app_data>/keybindings.json`, so rebinding on the welcome screen
 * is not lost either.
 *
 * One-time migration on read: when the vault has no keybindings.json yet but
 * the app data still holds the legacy flat table (command → binding), the
 * table is split by each command's default region and written into the
 * vault, after which the legacy file is cleared — from then on there is one
 * source only and two configs can no longer overwrite each other.
 */

let overrides: OverrideMap = {};
let vaultRoot: string | null = null;
let revision = 0;

const listeners = new Set<() => void>();

export function subscribeKeymap(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** The useSyncExternalStore snapshot: incremented on every override table change. */
export function getKeymapRevision(): number {
  return revision;
}

export function keybindingsFilePath(vaultPath: string | null): string | null {
  return vaultPath ? `${vaultPath}/.bnote/keybindings.json` : null;
}

function cloneOverrides(source: OverrideMap): OverrideMap {
  const next: OverrideMap = {};
  for (const region of KEY_REGION_IDS) {
    const map = source[region];
    if (map) next[region] = { ...map };
  }
  return next;
}

function setOverrides(next: OverrideMap): void {
  overrides = next;
  applyOverrides(next);
  notify();
}

function toast(message: string): void {
  useAppStore.getState().showToast(message);
}

function parseFile(text: string | null): OverrideMap | null {
  if (text === null) return null;
  try {
    return normalizeOverrides(JSON.parse(text));
  } catch {
    toast("快捷键配置解析失败,已改用默认键位(文件:.bnote/keybindings.json)");
    return {};
  }
}

/**
 * Serialized writes: clicking unbind/rebind quickly fires two IPCs at once and
 * their completion order is not guaranteed — with a queue, the last write to
 * finish is guaranteed to carry the last in-memory snapshot (single writer).
 */
let writeChain: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  const path = vaultRoot;
  // The snapshot is taken when the write is queued: a write that is already
  // ahead in the queue cannot push out a newer change prematurely.
  const text = path ? serializeOverrides(overrides) : null;
  const flat = path ? null : flattenOverrides(overrides);
  writeChain = writeChain.then(async () => {
    try {
      if (path && text !== null) {
        await api.writeVaultFile("keybindings.json", text);
      } else if (flat) {
        await api.saveKeybindings(flat);
      }
    } catch (e) {
      toast(`保存快捷键失败: ${String(e)}`);
    }
  });
  return writeChain;
}

/**
 * Read the keybinding config of the current vault. Passing null means no
 * vault is open yet, so only the legacy app config is read.
 * Calling it repeatedly is safe (switching vaults and watcher triggers both
 * come through here).
 */
export async function loadKeymap(vaultPath: string | null): Promise<void> {
  vaultRoot = vaultPath;

  if (!vaultPath) {
    const legacy = (await api.loadKeybindings().catch(() => null)) as Record<
      string,
      BindingValue
    > | null;
    setOverrides(normalizeOverrides(legacy));
    return;
  }

  const text = await api.readVaultFile("keybindings.json").catch(() => null);
  const parsed = parseFile(text);
  if (parsed !== null) {
    setOverrides(parsed);
    return;
  }

  // The vault has no config file yet: migrate the legacy app config in
  // (one-time).
  const legacy = (await api.loadKeybindings().catch(() => null)) as Record<
    string,
    BindingValue
  > | null;
  const migrated = normalizeOverrides(legacy);
  setOverrides(migrated);
  if (Object.keys(flattenOverrides(migrated)).length === 0) return;
  try {
    await api.writeVaultFile("keybindings.json", serializeOverrides(migrated));
    // The legacy table is cleared only after a successful migration: if the
    // vault write fails, the next startup can migrate again.
    await api.saveKeybindings({});
  } catch (e) {
    toast(`迁移快捷键配置失败: ${String(e)}`);
  }
}

/** Re-read the config of the current vault (external edit / after switching vaults). */
export async function reloadKeymap(): Promise<void> {
  await loadKeymap(vaultRoot);
}

export async function setOverride(
  id: string,
  value: BindingValue,
  region: KeyRegion = regionOfCommand(id),
): Promise<void> {
  const next = cloneOverrides(overrides);
  // Only this one region is touched: the same command's binding in the other
  // regions stays as it is.
  const isDefault = bindingEquals(defaultBindingsFor(id, region), value);
  if (isDefault) {
    if (next[region]) delete next[region][id];
  } else {
    (next[region] ??= {})[id] = value;
  }
  setOverrides(next);
  await persist();
}

/** Drop the override of one region (back to the built-in default). Omitting the region means all regions. */
export async function clearOverride(id: string, region?: KeyRegion): Promise<void> {
  const next = cloneOverrides(overrides);
  for (const r of region ? [region] : KEY_REGION_IDS) {
    if (next[r]) delete next[r][id];
  }
  setOverrides(next);
  await persist();
}

export async function resetAllOverrides(): Promise<void> {
  setOverrides({});
  await persist();
}

/** Read the current override table (the "changed" marker in settings, and tests). */
export function getOverrides(): OverrideMap {
  return overrides;
}

export type { BindingMap, BindingValue, KeyRegion, OverrideMap };
