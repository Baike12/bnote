import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { parseVimrc } from "./vimrc";
import { applyNativeMappings, setVimClipboardUnnamed } from "./vim";
import type { VimMapping } from "./vimrc";

/** The mappings of the last load: the one copy every vim surface reconfigures from. */
let current: VimMapping[] = [];
/** Whether a load has completed (an empty vimrc is a result, not a missing one). */
let loaded = false;
const listeners = new Set<(mappings: VimMapping[]) => void>();

/** The mappings the engine and every keymap were last configured with. */
export function vimMappings(): VimMapping[] {
  return current;
}

/** Notified after every load, so each vim surface (notes editors, agent
 *  composer) rebuilds its command keymap against the same list. */
export function onVimMappingsChanged(listener: (mappings: VimMapping[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the global vimrc plus the vault-level `.bnote/vimrc` (vault wins),
 * applies key-sequence mappings to the vim engine and returns the
 * command-mode mappings for the CM6 keymap.
 */
export async function loadVimrc(): Promise<VimMapping[]> {
  const global = await api.readVimrc().catch(() => null);
  const hasVault = !!useAppStore.getState().vaultPath;
  const vault = hasVault ? await api.readVaultFile("vimrc").catch(() => null) : null;

  const merged: VimMapping[] = [];
  const errors: string[] = [];
  let clipboardUnnamed = false;
  for (const source of [global, vault]) {
    if (!source) continue;
    const res = parseVimrc(source);
    merged.push(...res.mappings);
    errors.push(...res.errors);
    clipboardUnnamed = clipboardUnnamed || res.clipboardUnnamed;
  }
  if (errors.length) {
    console.warn("[bnote] vimrc warnings:", errors);
  }
  setVimClipboardUnnamed(clipboardUnnamed);
  applyNativeMappings(merged);
  current = merged;
  loaded = true;
  for (const listener of listeners) listener(merged);
  return merged;
}

/**
 * The load-once entry point of a vim surface that can mount before any notes
 * editor exists (the agent panel in a window with no note open): a settings
 * change reaches `applySettingsToEditor` first, but that function returns
 * before loading the vimrc when it has no editor to configure. Surfaces that
 * only need the mappings call this so the engine still gets its `imap jj
 * <Esc>`; a real vimrc edit still goes through `loadVimrc` and notifies.
 */
export function ensureVimrcLoaded(): Promise<VimMapping[]> {
  return loaded ? Promise.resolve(current) : loadVimrc();
}
