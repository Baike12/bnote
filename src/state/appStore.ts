import { create } from "zustand";
import { api, type FileNode, type StudyContent, type VaultInfo } from "@/lib/tauri";
import { DEFAULT_LATEX_CONFIG, type LatexConfig } from "@/editor/snippets/config";

export interface ImeSettings {
  /** 跟随 vim 模式切换输入法（仅 macOS 生效） */
  enabled: boolean;
  /** insert 模式使用的输入法源 id */
  insertSource: string;
  /** normal / visual 模式使用的输入法源 id */
  normalSource: string;
  /** 光标位于公式内进入 insert 时保持英文输入法（公式内容是 ASCII） */
  mathKeepsEnglish: boolean;
  /** 光标位于围栏代码块内进入 insert 时保持英文输入法（代码是 ASCII） */
  codeKeepsEnglish: boolean;
}

/** 快速添加命令：一键在指定文件夹创建新笔记（参考 Obsidian QuickAdd）。 */
export interface QuickAddCommand {
  /** 命令名，如 "add bnote file" */
  name: string;
  /** 仓库根目录下的目标文件夹，支持 "a/b" 子路径；不存在时自动创建 */
  folder: string;
}

/** 界面主题：dark 是无 data-theme 属性时的默认；light 走 [data-theme="light"]
 *  变量覆盖（global.css 是唯一颜色来源）。 */
export type ThemeName = "dark" | "light";

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
  /** 界面主题（编辑器 + 侧栏 + 弹层 + 语法高亮整套变量） */
  theme: ThemeName;
  /**
   * 学习模式三栏宽度（占可用宽度的比例）：[左侧 Agent, 中间内容]。
   * 右侧笔记吃剩余宽度，所以只存前两栏。比例而非像素，窗口缩放时按比例跟随。
   */
  studySplit: [number, number];
  fontSize: number;
  ime: ImeSettings;
  /** LaTeX Suite 特性开关(对齐 obsidian-latex-suite,见 editor/snippets/config) */
  latex: LatexConfig;
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
  theme: "dark",
  studySplit: [0.24, 0.44],
  fontSize: 16,
  ime: {
    enabled: true,
    insertSource: "com.sogou.inputmethod.sogou.pinyin",
    normalSource: "com.apple.keylayout.ABC",
    mathKeepsEnglish: true,
    codeKeepsEnglish: true,
  },
  latex: { ...DEFAULT_LATEX_CONFIG },
  quickAdd: [],
};

export type ModalKind = "switcher" | "palette" | "settings" | "quickadd" | null;

/**
 * 一次画布会话:画布是全屏浮层,期间命令快捷键只放行快速跳转/命令面板
 * (见 globalKeys 的画布模式)。isNew 会话在「回到来源笔记」时把画好的图
 * 作为普通图片嵌入插回 originPos——插入动作发生在收尾,不是打开画布时。
 */
export interface DrawingSession {
  /** 画图文件的绝对路径(磁盘上的唯一事实,画布每次保存都写它)。 */
  path: string;
  /** 本次会话新建的文件:收尾时若什么都没画,直接删文件。 */
  isNew: boolean;
  /** 来源笔记(⌘D 时的当前笔记);回填嵌入的目标。 */
  originNote: string | null;
  /** ⌘D 时的光标位置;回填插入点。编辑已有画图时为 null。 */
  originPos: number | null;
}

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
  /** 旧版的「上次文件」全局单值。已被 lastFileByVault 取代,只作启动迁移的种子读一次。 */
  lastFile?: string;
  /** 每仓各自的「上次文件」:快照跟着仓库走,切仓再切回来落点还是本仓那篇(参考 zed per-project 恢复)。 */
  lastFileByVault?: Record<string, string>;
  /** 最近打开的仓库(MRU,队首最新)。切换目标 = 第一个非当前仓,见 vault/recent.ts。 */
  recentVaults?: string[];
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
  /** Flat media paths(图片/PDF),图片渲染按文件名解析时要用。 */
  flatAssets: string[];
  /** Flat directory paths across the vault (folder picker suggestions). */
  folders: string[];
  /** Absolute paths of opened notes, most recent first. */
  recentFiles: string[];
  currentFile: string | null;
  dirty: boolean;
  settings: Settings;
  modal: ModalKind;
  sidebarOpen: boolean;
  /**
   * 待处理的「聚焦侧边栏」请求（null = 没有）。Sidebar 取走即置空——它是一次性
   * 票据，不是「历史上按过几次」的计数器：计数器会被新挂载的侧栏重新读成
   * 「刚收到的请求」，于是 ⌘\ 展开侧栏也会去抢焦点、把正在打字的编辑器甩掉。
   */
  sidebarFocusRequest: number | null;
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
  /**
   * ⌘⇧O 跳回槽:最近一次「跳到今日日记」前的文件。日记内再按 ⌘⇧O 时消费并跳回;
   * 每次新的跳转都覆盖它(单槽,toggle 语义只有一层)。不与 linkBack 混用——
   * 那条链是 wiki 链接的逐层回退,懒失效判定对 toggle 会给出过时的落点。
   */
  dailyBackFrom: string | null;
  toast: string | null;
  /** 学习模式:激活时主区变为 agent | 内容 | 笔记 三栏 */
  studyMode: boolean;
  /** 学习模式中间栏的当前内容(null = 空态,等待拖入 PDF 或输入 URL) */
  studyContent: StudyContent | null;
  /** 画布会话(null = 没开)。全屏浮层 + 命令快捷键挂起。 */
  drawingSession: DrawingSession | null;
  /**
   * Agent 配置(模型/Key/MCP)的保存次数。会话在创建时就把 provider 固化了,
   * 保存配置后必须重建会话才会生效——AgentPanel 监听这个计数重开会话。
   */
  agentConfigVersion: number;

  setVault: (info: VaultInfo) => void;
  closeVault: () => void;
  setTree: (tree: FileNode[]) => void;
  setFlatFiles: (files: string[]) => void;
  setFlatAssets: (assets: string[]) => void;
  setFolders: (folders: string[]) => void;
  openFile: (path: string) => void;
  closeFile: () => void;
  markDirty: (dirty: boolean) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  replaceSettings: (s: Settings) => void;
  setModal: (m: ModalKind) => void;
  toggleSidebar: () => void;
  focusSidebar: () => void;
  clearSidebarFocus: () => void;
  requestRename: (relPath: string) => void;
  clearRenameRequest: () => void;
  openLinkSuggest: (anchor: LinkAnchor) => void;
  closeLinkSuggest: () => void;
  pushLinkBack: (from: string, to: string) => void;
  /** 回退一层：返回要打开的路径；链已断或本来就是起点时返回 null。 */
  popLinkBack: () => string | null;
  /** ⌘⇧O 跳回槽的写入者(null = 清空)。 */
  setDailyBackFrom: (path: string | null) => void;
  showToast: (msg: string) => void;
  clearToast: () => void;
  setStudyMode: (active: boolean) => void;
  setStudyContent: (content: StudyContent | null) => void;
  openDrawingSession: (session: DrawingSession) => void;
  closeDrawingSession: () => void;
  /** Agent 配置已保存:让学习模式重建会话(见 agentConfigVersion)。 */
  bumpAgentConfigVersion: () => void;
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
  flatAssets: [],
  folders: [],
  recentFiles: [],
  currentFile: null,
  dirty: false,
  settings: { ...DEFAULT_SETTINGS },
  modal: null,
  sidebarOpen: true,
  sidebarFocusRequest: null,
  renameRequest: null,
  linkSuggest: null,
  linkBack: [],
  dailyBackFrom: null,
  toast: null,
  studyMode: false,
  studyContent: null,
  drawingSession: null,
  agentConfigVersion: 0,

  setVault: (info) =>
    set({
      vaultPath: info.path,
      vaultName: info.name,
      tree: [],
      flatFiles: [],
      flatAssets: [],
      folders: [],
      currentFile: null,
      dirty: false,
      linkBack: [],
      dailyBackFrom: null,
    }),
  closeVault: () =>
    set({
      vaultPath: null,
      vaultName: "",
      tree: [],
      flatFiles: [],
      flatAssets: [],
      folders: [],
      currentFile: null,
      dirty: false,
      linkBack: [],
      dailyBackFrom: null,
    }),
  setTree: (tree) => set({ tree }),
  setFlatFiles: (flatFiles) => set({ flatFiles }),
  setFlatAssets: (flatAssets) => set({ flatAssets }),
  setFolders: (folders) => set({ folders }),
  openFile: (path) => {
    if (get().currentFile === path) return;
    // Most-recent-first list (quick switcher ordering); persisted in config.
    const recentFiles = [path, ...get().recentFiles.filter((p) => p !== path)].slice(0, 100);
    set({ currentFile: path, dirty: false, recentFiles });
    // 「上次文件」按仓库各记各的:切仓再切回来,落点还是本仓那篇。
    const vault = get().vaultPath;
    const lastFileByVault = vault
      ? { ...(getConfigSnapshot().lastFileByVault ?? {}), [vault]: path }
      : getConfigSnapshot().lastFileByVault;
    persistConfig({ ...getConfigSnapshot(), lastFileByVault, recentFiles });
  },
  closeFile: () => {
    set({ currentFile: null, dirty: false });
    // 当前文件已关(删除/外部改动):本仓的恢复点一并清掉,免得下次开仓
    // 对着不存在的路径报「打开上次文件失败」。
    const vault = get().vaultPath;
    if (vault && getConfigSnapshot().lastFileByVault?.[vault]) {
      const lastFileByVault = { ...getConfigSnapshot().lastFileByVault };
      delete lastFileByVault[vault];
      persistConfig({ ...getConfigSnapshot(), lastFileByVault });
    }
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
    set({ sidebarOpen: true, sidebarFocusRequest: (get().sidebarFocusRequest ?? 0) + 1 }),
  clearSidebarFocus: () => {
    if (get().sidebarFocusRequest !== null) set({ sidebarFocusRequest: null });
  },
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
  setDailyBackFrom: (path) => set({ dailyBackFrom: path }),
  showToast: (msg) => set({ toast: msg }),
  clearToast: () => set({ toast: null }),
  setStudyMode: (active) => set({ studyMode: active }),
  setStudyContent: (content) => set({ studyContent: content }),
  openDrawingSession: (session) => set({ drawingSession: session }),
  closeDrawingSession: () => {
    if (get().drawingSession !== null) set({ drawingSession: null });
  },
  bumpAgentConfigVersion: () =>
    set({ agentConfigVersion: get().agentConfigVersion + 1 }),
}));

export function toggleStudyMode() {
  const store = useAppStore.getState();
  store.setStudyMode(!store.studyMode);
}

let configSnapshot: PersistedConfig = {};
export function setConfigSnapshot(c: PersistedConfig) {
  configSnapshot = c;
}
export function getConfigSnapshot(): PersistedConfig {
  return configSnapshot;
}
