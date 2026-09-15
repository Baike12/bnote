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
  /** 「插入代码块」在开栏预填的语言标识；空串 = 不带语言 */
  codeBlockLang: string;
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
  codeBlockLang: "ts",
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

/** 链接补全面板的锚点：光标所在行的视口坐标（面板 position: fixed 直接用它）。 */
export interface LinkAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** 一次链接跳转：从 from 跳到 to。 */
export interface LinkHop {
  from: string;
  to: string;
}

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
  /** Flat directory paths across the vault (folder picker suggestions). */
  folders: string[];
  /** Absolute paths of opened notes, most recent first. */
  recentFiles: string[];
  currentFile: string | null;
  dirty: boolean;
  settings: Settings;
  modal: ModalKind;
  sidebarOpen: boolean;
  /** Incremented by focusSidebar(); the Sidebar reacts by taking keyboard focus. */
  sidebarFocusTick: number;
  /**
   * 树里某一行请求进入内联重命名（新建文件夹后直接改名）。Sidebar 取走后置空，
   * 所以请求只被消费一次，不会在侧栏重新挂载时复活。
   */
  renameRequest: string | null;
  /**
   * 链接补全面板的锚点（插入链接的光标行）。同样是取走即清空的一次性请求，
   * 面板只在它非空时挂载——关闭即卸载，查询/选中都回到初始态。
   */
  linkSuggest: LinkAnchor | null;
  /**
   * 链接跳转链（每条记录一跳 from → to），供「回退到链接跳转前的文件」逐层往回走。
   * 只在链接跳转时压栈；中间用别的方式打开过文件，回退时按 to 与当前文件比对
   * 就知道链断了（见 popLinkBack）。
   */
  linkBack: LinkHop[];
  toast: string | null;

  setVault: (info: VaultInfo) => void;
  closeVault: () => void;
  setTree: (tree: FileNode[]) => void;
  setFlatFiles: (files: string[]) => void;
  setFolders: (folders: string[]) => void;
  openFile: (path: string) => void;
  closeFile: () => void;
  markDirty: (dirty: boolean) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  replaceSettings: (s: Settings) => void;
  setModal: (m: ModalKind) => void;
  toggleSidebar: () => void;
  focusSidebar: () => void;
  requestRename: (relPath: string) => void;
  clearRenameRequest: () => void;
  openLinkSuggest: (anchor: LinkAnchor) => void;
  closeLinkSuggest: () => void;
  pushLinkBack: (from: string, to: string) => void;
  /** 回退一层：返回要打开的路径；链已断或本来就是起点时返回 null。 */
  popLinkBack: () => string | null;
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
  folders: [],
  recentFiles: [],
  currentFile: null,
  dirty: false,
  settings: { ...DEFAULT_SETTINGS },
  modal: null,
  sidebarOpen: true,
  sidebarFocusTick: 0,
  renameRequest: null,
  linkSuggest: null,
  linkBack: [],
  toast: null,

  setVault: (info) =>
    set({
      vaultPath: info.path,
      vaultName: info.name,
      tree: [],
      flatFiles: [],
      folders: [],
      currentFile: null,
      dirty: false,
      linkBack: [],
    }),
  closeVault: () =>
    set({
      vaultPath: null,
      vaultName: "",
      tree: [],
      flatFiles: [],
      folders: [],
      currentFile: null,
      dirty: false,
      linkBack: [],
    }),
  setTree: (tree) => set({ tree }),
  setFlatFiles: (flatFiles) => set({ flatFiles }),
  setFolders: (folders) => set({ folders }),
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
  // 侧栏收起时 Sidebar 未挂载，请求会一直悬着——一并展开侧栏，保证有人消费。
  requestRename: (relPath) => set({ sidebarOpen: true, renameRequest: relPath }),
  clearRenameRequest: () => {
    if (get().renameRequest !== null) set({ renameRequest: null });
  },
  openLinkSuggest: (anchor) => set({ linkSuggest: anchor }),
  closeLinkSuggest: () => {
    if (get().linkSuggest !== null) set({ linkSuggest: null });
  },
  pushLinkBack: (from, to) => set({ linkBack: [...get().linkBack, { from, to }] }),
  // 最后一跳的落点就是当前文件，链才还有效；否则说明中间用别的方式打开过
  // （侧栏、快速跳转、新建…），链已断——顺手清掉，免得留着过时的路径。
  popLinkBack: () => {
    const { linkBack, currentFile } = get();
    const top = linkBack[linkBack.length - 1];
    if (!top || top.to !== currentFile) {
      if (linkBack.length > 0) set({ linkBack: [] });
      return null;
    }
    set({ linkBack: linkBack.slice(0, -1) });
    return top.from;
  },
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
