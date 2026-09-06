import { create } from "zustand";
import { api, type FileNode, type VaultInfo } from "@/lib/tauri";

export interface ImeSettings {
  /** 跟随 vim 模式切换输入法（仅 macOS 生效） */
  enabled: boolean;
  /** insert 模式使用的输入法源 id */
  insertSource: string;
  /** normal / visual 模式使用的输入法源 id */
  normalSource: string;
  /** 光标位于公式内进入 insert 时保持英文输入法（公式内容是 ASCII） */
  mathKeepsEnglish: boolean;
}

export interface Settings {
  vim: boolean;
  typewriter: boolean;
  livePreview: boolean;
  mathPreview: boolean;
  snippets: boolean;
  autoSave: boolean;
  fontSize: number;
  ime: ImeSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  vim: false,
  typewriter: false,
  livePreview: true,
  mathPreview: true,
  snippets: true,
  autoSave: true,
  fontSize: 16,
  ime: {
    enabled: true,
    insertSource: "com.sogou.inputmethod.sogou.pinyin",
    normalSource: "com.apple.keylayout.ABC",
    mathKeepsEnglish: true,
  },
};

export type ModalKind = "switcher" | "palette" | "settings" | null;

export interface PersistedConfig {
  lastVault?: string;
  lastFile?: string;
  settings?: Partial<Settings>;
}

interface AppState {
  vaultPath: string | null;
  vaultName: string;
  tree: FileNode[];
  /** Flat note paths across the vault (quick switcher / wikilinks). */
  flatFiles: string[];
  currentFile: string | null;
  dirty: boolean;
  settings: Settings;
  modal: ModalKind;
  sidebarOpen: boolean;
  toast: string | null;

  setVault: (info: VaultInfo) => void;
  closeVault: () => void;
  setTree: (tree: FileNode[]) => void;
  setFlatFiles: (files: string[]) => void;
  openFile: (path: string) => void;
  closeFile: () => void;
  markDirty: (dirty: boolean) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  replaceSettings: (s: Settings) => void;
  setModal: (m: ModalKind) => void;
  toggleSidebar: () => void;
  showToast: (msg: string) => void;
  clearToast: () => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced persistence of app config (vault, last file, settings). */
export function persistConfig(config: PersistedConfig) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void api.saveAppConfig(config).catch((e) => console.warn("persist failed", e));
  }, 300);
}

export const useAppStore = create<AppState>((set, get) => ({
  vaultPath: null,
  vaultName: "",
  tree: [],
  flatFiles: [],
  currentFile: null,
  dirty: false,
  settings: { ...DEFAULT_SETTINGS },
  modal: null,
  sidebarOpen: true,
  toast: null,

  setVault: (info) =>
    set({
      vaultPath: info.path,
      vaultName: info.name,
      tree: [],
      flatFiles: [],
      currentFile: null,
      dirty: false,
    }),
  closeVault: () =>
    set({ vaultPath: null, vaultName: "", tree: [], flatFiles: [], currentFile: null, dirty: false }),
  setTree: (tree) => set({ tree }),
  setFlatFiles: (flatFiles) => set({ flatFiles }),
  openFile: (path) => {
    if (get().currentFile === path) return;
    set({ currentFile: path, dirty: false });
    persistConfig({ ...getConfigSnapshot(), lastFile: path });
  },
  closeFile: () => {
    set({ currentFile: null, dirty: false });
    persistConfig({ ...getConfigSnapshot(), lastFile: undefined });
  },
  markDirty: (dirty) => set({ dirty }),
  patchSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    persistConfig({ ...getConfigSnapshot(), settings });
  },
  replaceSettings: (settings) => {
    set({ settings });
    persistConfig({ ...getConfigSnapshot(), settings });
  },
  setModal: (modal) => set({ modal }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  showToast: (msg) => set({ toast: msg }),
  clearToast: () => set({ toast: null }),
}));

let configSnapshot: PersistedConfig = {};
export function setConfigSnapshot(c: PersistedConfig) {
  configSnapshot = c;
}
export function getConfigSnapshot(): PersistedConfig {
  return configSnapshot;
}
