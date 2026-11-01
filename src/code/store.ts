import { create } from "zustand";
import { codeApi } from "./api";
import { useAppStore } from "@/state/appStore";
import type {
  CodeEntry,
  CodeProjectInfo,
  GitStatus,
  LspDiagnostic,
  LspPosition,
  ServerConfig,
} from "./types";

/**
 * 代码项目的状态。
 *
 * **唯一写入者**:所有改动都经这个 store 的 action;组件只读。这样
 * 「文件树 / 标签页 / 编辑器内容 / git 状态」不会各持一份,不会出现
 * 「树里改了、编辑器里没改」这种分叉。
 *
 * 缓冲区(tabs + buffers)在这里,不在 CodeMirror 里:CodeMirror 的实例随
 * 组件挂载卸载,状态不能放那儿(切走再切回来内容就没了)。
 */

/** 一个打开的文件。 */
export interface OpenFile {
  path: string;
  /** 打开时的内容(用于算「有没有改动」)。 */
  saved: string;
  /** 当前内容(有未保存改动时与 `saved` 不同)。 */
  content: string;
  languageId: string;
  binary: boolean;
  size: number;
  /**
   * 缩进宽度(打开时从内容里猜一次,之后不变)。
   *
   * 打开后再猜会让「内容变一次 → 缩进变一次 → 重建编辑器 → 撤销栈没了」
   * 这种连锁反应;猜一次定死更稳。
   */
  tabSize: number;
}

export interface CodeState {
  /** 当前打开的项目(null = 没开项目)。 */
  project: CodeProjectInfo | null;
  /** 打开的标签(项目相对路径)。 */
  tabs: string[];
  /** 当前标签。 */
  activePath: string | null;
  /** 路径 → 打开的文件。 */
  files: Record<string, OpenFile>;
  /** 路径 → 诊断。 */
  diagnostics: Record<string, LspDiagnostic[]>;
  /** git 状态。 */
  git: GitStatus | null;
  /** 语言 → "running"。 */
  lspStates: Record<string, string>;
  /** 语言服务器日志(最近若干条)。 */
  lspLog: { language: string; level: number; message: string }[];
  /** 文件树抽屉是否展开。 */
  treeOpen: boolean;
  /** 问题面板是否展开。 */
  problemsOpen: boolean;
  /** 正在看 diff 的文件(null = 不看)。 */
  diffPath: string | null;
  /** diff 的暂存区视角。 */
  diffStaged: boolean;
  /**
   * 待处理的跳转请求:目标文件 + 目标位置(LSP 坐标)。
   *
   * 用 LSP 坐标而不是文档偏移:目标文件可能还没打开,它的文档偏移此刻还
   * 不存在。编辑器把这份坐标换算成偏移再落光标。
   */
  jump: { path: string; position: LspPosition } | null;
  /** 引用列表(跳转到引用的结果)。 */
  references: {
    path: string;
    position: LspPosition;
    external: boolean;
  }[] | null;

  openProject: (root: string) => Promise<void>;
  closeProject: () => Promise<void>;
  rescan: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  refreshGit: () => Promise<void>;
  setDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void;
  setLspState: (language: string, state: string) => void;
  appendLspLog: (language: string, level: number, message: string) => void;
  ensureLsp: (language: string, overrides?: ServerConfig) => Promise<boolean>;
  setTreeOpen: (open: boolean) => void;
  setProblemsOpen: (open: boolean) => void;
  setDiff: (path: string | null, staged?: boolean) => void;
  toggleDiffStaged: () => void;
  /** 请求把光标落到某个位置(跳转/引用面板点击)。 */
  requestJump: (path: string, position: LspPosition) => void;
  /** 消费掉跳转请求(只消费一次)。 */
  clearJump: () => void;
  /** 设置引用列表。 */
  setReferences: (refs: { path: string; position: LspPosition; external: boolean }[] | null) => void;
  /** 直接替换文件内容(重命名后从盘上重读)。 */
  replaceContent: (path: string, content: string) => void;
}

/** 语言服务器日志最多留多少条(免得长会话把内存吃满)。 */
const LOG_LIMIT = 200;

/** 从内容里猜缩进宽度(取前若干行里最小的缩进)。 */
export function detectIndent(content: string): number {
  const lines = content.split("\n").slice(0, 200);
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (indent.length === 0) continue;
    if (indent.includes("\t")) return 1; // Tab 缩进:一个 Tab 一级
    return Math.min(indent.length, 8);
  }
  return 2;
}

export const useCodeStore = create<CodeState>((set, get) => ({
  project: null,
  tabs: [],
  activePath: null,
  files: {},
  diagnostics: {},
  git: null,
  lspStates: {},
  lspLog: [],
  treeOpen: false,
  problemsOpen: false,
  diffPath: null,
  diffStaged: false,
  jump: null,
  references: null,

  async openProject(root) {
    const info = await codeApi.openProject(root);
    set({
      project: info,
      tabs: [],
      activePath: null,
      files: {},
      diagnostics: {},
      git: null,
      lspStates: {},
      lspLog: [],
      treeOpen: false,
      problemsOpen: false,
      diffPath: null,
      jump: null,
      references: null,
    });
    await get().refreshGit();
  },

  async closeProject() {
    // 关项目前把所有有改动的文件落盘(缓冲区会随项目一起清空)。
    for (const path of Object.keys(get().files)) {
      if (isDirty(get(), path)) await get().saveFile(path);
    }
    const root = get().project?.root;
    if (root) {
      // 语言服务器是按项目起的:关项目就把它们都停掉,不留孤儿进程。
      await codeApi.lspStop(root).catch(() => {});
    }
    set({
      project: null,
      tabs: [],
      activePath: null,
      files: {},
      diagnostics: {},
      git: null,
      lspStates: {},
      lspLog: [],
      treeOpen: false,
      problemsOpen: false,
      diffPath: null,
      jump: null,
      references: null,
    });
  },

  async rescan() {
    const root = get().project?.root;
    if (!root) return;
    const tree = await codeApi.rescan(root);
    const project = get().project;
    if (!project) return;
    set({ project: { ...project, tree } });
  },

  async openFile(path) {
    const root = get().project?.root;
    if (!root) return;
    const existing = get().files[path];
    if (existing) {
      // 已经开着:只切过去,别重读盘(会把未保存的改动冲掉)。
      set((s) => ({
        tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path],
        activePath: path,
      }));
      return;
    }
    const file = await codeApi.readFile(root, path);
    set((s) => ({
      tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path],
      activePath: path,
      files: {
        ...s.files,
        [path]: {
          path,
          saved: file.content,
          content: file.content,
          languageId: file.languageId,
          binary: file.binary,
          size: file.size,
          tabSize: detectIndent(file.content),
        },
      },
    }));
    // 语言服务器起来了就顺手把文档推上去,补全/跳转立刻可用。
    void get().ensureLsp(file.languageId);
  },

  closeTab(path) {
    // 有未保存的改动就先落盘:缓冲区随标签一起消失,不存就丢了。
    if (isDirty(get(), path)) void get().saveFile(path);
    set((s) => {
      const tabs = s.tabs.filter((p) => p !== path);
      const files = { ...s.files };
      delete files[path];
      const activePath =
        s.activePath === path ? (tabs[tabs.length - 1] ?? null) : s.activePath;
      return { tabs, files, activePath };
    });
  },

  setActiveTab(path) {
    if (get().activePath === path) return;
    set({ activePath: path, diffPath: null });
  },

  updateContent(path, content) {
    set((s) => {
      const file = s.files[path];
      if (!file || file.content === content) return s;
      return { files: { ...s.files, [path]: { ...file, content } } };
    });
  },

  async saveFile(path) {
    const root = get().project?.root;
    const file = get().files[path];
    if (!root || !file) return;
    await codeApi.writeFile(root, path, file.content);
    set((s) => {
      const current = s.files[path];
      if (!current) return s;
      return { files: { ...s.files, [path]: { ...current, saved: current.content } } };
    });
    await get().refreshGit();
  },

  async refreshGit() {
    const root = get().project?.root;
    if (!root) return;
    try {
      const git = await codeApi.gitStatus(root);
      set({ git });
    } catch {
      set({ git: null });
    }
  },

  setDiagnostics(path, diagnostics) {
    set((s) => ({ diagnostics: { ...s.diagnostics, [path]: diagnostics } }));
  },

  setLspState(language, state) {
    set((s) => ({ lspStates: { ...s.lspStates, [language]: state } }));
  },

  appendLspLog(language, level, message) {
    set((s) => ({
      lspLog: [...s.lspLog, { language, level, message }].slice(-LOG_LIMIT),
    }));
  },

  async ensureLsp(language, overrides) {
    const root = get().project?.root;
    if (!root || !language || language === "plaintext") return false;
    if (get().lspStates[language] === "running") return true;
    // 起过一次没起来(本机没装这个服务器)就不再反复试:每开一个文件
    // 就拉一次进程、等一次握手超时,体验很差。要重试就重开项目(或者在
    // 设置里改好服务器路径后重新打开)。
    if (get().lspStates[language] === "off") return false;
    // 覆盖来源:调用方显式给的优先,否则用设置里的全局那层(项目内
    // `.bnote/lsp.json` 由后端再盖一层,优先级最高)。
    const global = useAppStore.getState().settings.codeLspServers?.[language];
    const override = overrides ?? (global ? { command: global.command, args: global.args ?? [] } : undefined);
    try {
      await codeApi.lspStart(root, language, override);
      get().setLspState(language, "running");
      // 已经在编辑区的文件要补一次 didOpen,服务器才知道有这个文档。
      const s = get();
      for (const file of Object.values(s.files)) {
        if (file.languageId === language) {
          await codeApi.lspSync(root, file.path, file.content).catch(() => {});
        }
      }
      return true;
    } catch {
      get().setLspState(language, "off");
      return false;
    }
  },

  setTreeOpen(open) {
    set({ treeOpen: open });
  },

  setProblemsOpen(open) {
    set({ problemsOpen: open });
  },

  setDiff(path, staged) {
    set((s) => ({
      diffPath: path,
      diffStaged: staged ?? s.diffStaged,
    }));
  },

  toggleDiffStaged() {
    set((s) => ({ diffStaged: !s.diffStaged }));
  },

  requestJump(path, position) {
    set({ jump: { path, position } });
  },

  clearJump() {
    set({ jump: null });
  },

  setReferences(refs) {
    set({ references: refs });
  },

  replaceContent(path, content) {
    set((s) => {
      const file = s.files[path];
      if (!file) return s;
      return {
        files: { ...s.files, [path]: { ...file, content, saved: content } },
      };
    });
  },
}));

/** 这个文件有没有未保存的改动。 */
export function isDirty(state: CodeState, path: string): boolean {
  const file = state.files[path];
  return !!file && file.content !== file.saved;
}

/** 全部诊断(跨文件),按文件分组。 */
export function allDiagnostics(state: CodeState): {
  path: string;
  diagnostics: LspDiagnostic[];
}[] {
  return Object.entries(state.diagnostics)
    .filter(([, list]) => list.length > 0)
    .map(([path, diagnostics]) => ({ path, diagnostics }));
}

/** 文件树条目(拍平的)。 */
export function treeEntries(state: CodeState): CodeEntry[] {
  return state.project?.tree.entries ?? [];
}
