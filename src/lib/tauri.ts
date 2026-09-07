import { invoke } from "@tauri-apps/api/core";

export interface VaultInfo {
  path: string;
  name: string;
}

export interface FileNode {
  name: string;
  relPath: string;
  kind: "file" | "dir";
  /** null = 目录子层尚未加载（懒加载），调用 readDir 获取 */
  children: FileNode[] | null;
}

export interface CreatedEntry {
  path: string;
  relPath: string;
}

/** Whitelisted per-vault config files inside `<vault>/.bnote/`. */
export type VaultConfigFile = "vimrc" | "snippets.js" | "keybindings.json";

export interface InputSourceInfo {
  id: string;
  name: string;
  isCjk: boolean;
}

export interface SetImeOutcome {
  switched: boolean;
  fallbackUsed: boolean;
}

export const api = {
  setVault: (path: string) => invoke<VaultInfo>("set_vault", { path }),
  getVault: () => invoke<VaultInfo | null>("get_vault"),
  readTree: () => invoke<FileNode[]>("read_tree"),
  readDir: (relPath: string) => invoke<FileNode[]>("read_dir", { relPath }),
  listFiles: () => invoke<string[]>("list_files"),

  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, contents: string) =>
    invoke<void>("write_file", { path, contents }),
  createFile: (parent: string, name: string) =>
    invoke<CreatedEntry>("create_file", { parent, name }),
  createDir: (parent: string, name: string) =>
    invoke<CreatedEntry>("create_dir", { parent, name }),
  /** mkdir -p for a vault-relative path; missing directories only, no dedup. */
  ensureDir: (relPath: string) => invoke<void>("ensure_dir", { relPath }),
  renamePath: (path: string, newName: string) =>
    invoke<string>("rename_path", { path, newName }),
  trashPath: (path: string) => invoke<void>("trash_path", { path }),
  readVaultFile: (name: VaultConfigFile) =>
    invoke<string | null>("read_vault_file", { name }),
  writeVaultFile: (name: VaultConfigFile, contents: string) =>
    invoke<void>("write_vault_file", { name, contents }),

  loadAppConfig: () => invoke<unknown>("load_app_config"),
  saveAppConfig: (config: unknown) => invoke<void>("save_app_config", { config }),
  loadKeybindings: () => invoke<unknown>("load_keybindings"),
  saveKeybindings: (keybindings: unknown) =>
    invoke<void>("save_keybindings", { keybindings }),
  readVimrc: () => invoke<string | null>("read_vimrc"),
  saveVimrc: (contents: string) => invoke<void>("save_vimrc", { contents }),

  listInputSources: () => invoke<InputSourceInfo[]>("list_input_sources"),
  getCurrentInputSource: () => invoke<string>("get_current_input_source"),
  setInputSource: (id: string) => invoke<SetImeOutcome>("set_input_source", { id }),
};
