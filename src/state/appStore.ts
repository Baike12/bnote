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

/** 快速添加命令：一键在指定文件夹创建新笔记（参考 Obsidian QuickAdd）。 */
export interface QuickAddCommand {
  /** 命令名，如 "add bnote file" */
  name: string;
  /** 仓库根目录下的目标文件夹，支持 "a/b" 子路径；不存在时自动创建 */
  folder: string;
}

export interface Settings {
  vim: boolean;
  typewriter: boolean;
  livePreview: boolean;
  mathPreview: boolean;
  snippets: boolean;
  autoSave: boolean;
  /** 标题自动编号：设置标题时按层级重排 1 / 1.1 / 1.1.2 这样的编号 */
  autoNumberHeadings: boolean;
  fontSize: number;
  ime: ImeSettings;
  quickAdd: QuickAddCommand[];
}

export const DEFAULT_SETTINGS: Settings = {
  vim: false,
  typewriter: false,
  livePreview: true,
  mathPreview: true,
  snippets: true,
  autoSave: true,
  autoNumberHeadings: false,
  fontSize: 16,
  ime: {
    enabled: true,
    insertSource: "com.sogou.inputmethod.sogou.pinyin",
    normalSource: "com.apple.keylayout.ABC",
    mathKeepsEnglish: true,
  },
  quickAdd: [],
};

export type ModalKind = "switcher" | "palette" | "settings" | "quickadd" | null;

export interface PersistedConfig {
  lastVault?: string;
  lastFile?: string;
  /** Recently-opened absolute note paths, most recent first (quick switcher). */
  recentFiles?: string[];
  settings?: Partial<Settings>;
  /** Last cursor position per absolute note path (remember-cursor-position). */
  cursorPositions?: Record<string, { pos: number; scroll: number }>;
}

/** Hard cap on remembered files — dropping the oldest entry beyond it. */
const CURSOR_POSITIONS_CAP = 100;

/**
 * Records where the user left off in a note (cursor offset + scroll top) so
 * reopening it lands in the same spot. No-op (and no re-persist) when nothing
 * changed since the last record.
 */
export function rememberCursorPosition(path: string, pos: number, scroll: number) {
  const snap = getConfigSnapshot();
  const saved = snap.cursorPositions?.[path];
  if (saved && saved.pos === pos && saved.scroll === scroll) return;
  const map: NonNullable<PersistedConfig["cursorPositions"]> = {
    ...(snap.cursorPositions ?? {}),
    [path]: { pos, scroll },
  };
  const keys = Object.keys(map);
  if (keys.length > CURSOR_POSITIONS_CAP) {
    for (const key of keys.slice(0, keys.length - CURSOR_POSITIONS_CAP)) delete map[key];
  }
  persistConfig({ ...snap, cursorPositions: map });
}

interface AppState {
  vaultPath: string | null;
  vaultName: string;
  tree: FileNode[];
  /** Flat note paths across the vault (quick switcher / wikilinks). */
  flatFiles: string[];
  /** Absolute paths of opened notes, most recent first. */
  recentFiles: string[];
  currentFile: string | null;
  dirty: boolean;
  settings: Settings;
  modal: ModalKind;
  sidebarOpen: boolean;
  /** Incremented by focusSidebar(); the Sidebar reacts by taking keyboard focus. */
  sidebarFocusTick: number;
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
  focusSidebar: () => void;
  showToast: (msg: string) => void;
  clearToast: () => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced persistence of app config (vault, last file, settings). The
 * in-memory snapshot is kept identical to the latest write intent, so a later
 * partial save (e.g. a cursor-position update) never rolls back fields that
 * an earlier save had changed.
 */
export function persistConfig(config: PersistedConfig) {
  configSnapshot = config;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void api.saveAppConfig(configSnapshot).catch((e) => console.warn("persist failed", e));
  }, 300);
}

/** True while a debounced write is still pending (flush before quitting). */
export function hasPendingPersist() {
  return persistTimer !== null;
}

/** Writes the pending config to disk immediately (app close / blur). */
export function flushPersistConfig() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  void api.saveAppConfig(configSnapshot).catch((e) => console.warn("persist failed", e));
}

export const useAppStore = create<AppState>((set, get) => ({
  vaultPath: null,
  vaultName: "",
  tree: [],
  flatFiles: [],
  recentFiles: [],
  currentFile: null,
  dirty: false,
  settings: { ...DEFAULT_SETTINGS },
  modal: null,
  sidebarOpen: true,
  sidebarFocusTick: 0,
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
    // Most-recent-first list (quick switcher ordering); persisted in config.
    const recentFiles = [path, ...get().recentFiles.filter((p) => p !== path)].slice(0, 100);
    set({ currentFile: path, dirty: false, recentFiles });
    persistConfig({ ...getConfigSnapshot(), lastFile: path, recentFiles });
  },
  closeFile: () => {
    set({ currentFile: null, dirty: false });
    persistConfig({ ...getConfigSnapshot(), lastFile: undefined });
  },
  // No-op when unchanged: the dirty flag flips on every keystroke, and a
  // redundant set() would re-render every subscribed component per keypress.
  markDirty: (dirty) => {
    if (get().dirty !== dirty) set({ dirty });
  },
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
  focusSidebar: () =>
    set({ sidebarOpen: true, sidebarFocusTick: get().sidebarFocusTick + 1 }),
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
