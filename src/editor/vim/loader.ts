import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { parseVimrc } from "./vimrc";
import { applyNativeMappings } from "./vim";
import type { VimMapping } from "./vimrc";

/** Loads the global vimrc plus the vault-level `.bnote/vimrc` (vault wins),
 *  applies key-sequence mappings to the vim engine and returns the
 *  command-mode mappings for the CM6 keymap. */
export async function loadVimrc(): Promise<VimMapping[]> {
  const global = await api.readVimrc().catch(() => null);
  const hasVault = !!useAppStore.getState().vaultPath;
  const vault = hasVault ? await api.readVaultFile("vimrc").catch(() => null) : null;

  const merged: VimMapping[] = [];
  const errors: string[] = [];
  for (const source of [global, vault]) {
    if (!source) continue;
    const res = parseVimrc(source);
    merged.push(...res.mappings);
    errors.push(...res.errors);
  }
  if (errors.length) {
    console.warn("[bnote] vimrc warnings:", errors);
  }
  applyNativeMappings(merged);
  return merged;
}
