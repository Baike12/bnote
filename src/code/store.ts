import { create } from "zustand";
import { codeApi } from "./api";
import { ancestorDirs } from "./tree";
import { useAppStore } from "@/state/appStore";
import type {
  CodeEntry,
  CodeFile,
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
   * 缩进单位(打开时从内容里猜一次,之后不变):`"  "` / `"\t"` 之类。
   *
   * 打开后再猜会让「内容变一次 → 缩进变一次 → 重建编辑器 → 撤销栈没了」
   * 这种连锁反应;猜一次定死更稳。
   */
  indentUnit: string;
  /** Tab 的显示宽度(空格缩进时就是缩进宽度,制表符按 4 显示)。 */
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
  /**
   * 文件树里展开的目录路径集合。**空集 = 只显示顶层**(默认不展开所有
   * 文件夹);关掉抽屉再打开、重扫之后都保留,换项目才清空。
   */
  expandedDirs: Set<string>;
  /**
   * 「把焦点交给文件树」的请求(路径为 null = 落在第一行)。
   *
   * 走请求而不是命令层直接摸 DOM:抽屉可能还没挂载,而且文件树是虚拟滚动
   * 的——目标行要先展开、滚动进窗口,才有元素可以聚焦。FileTree 消费一次
   * 就清掉,关掉抽屉再打开不会又抢一次焦点。
   */
  treeFocus: { path: string | null; seq: number } | null;
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
  /** 切换一个目录的展开态。 */
  toggleDir: (path: string) => void;
  /** 请求把焦点交给文件树(null = 第一行)。 */
  requestTreeFocus: (path: string | null) => void;
  /** 消费掉焦点请求(只消费一次)。 */
  clearTreeFocus: () => void;
  /** 展开到某个文件:把它的每一层祖先目录都打开。 */
  expandTo: (path: string) => void;
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

/** 制表符按几列显示(缩进单位是 "\t" 时的 tabSize)。 */
const TAB_DISPLAY_WIDTH = 4;

/**
 * `openFile` 的请求序号:连点两个文件时只认最后一次。
 *
 * 模块级而不是 state:它不驱动渲染,只是个丢弃过期读盘结果的闸门。
 */
let openSeq = 0;

/**
 * 文件树聚焦请求的序号。同一路径连按快捷键也要重新定位(用户可能已经把
 * 焦点挪走),所以每次请求都自增,消费方按对象/序号触发。
 */
let treeFocusSeq = 0;

/**
 * 从内容里猜缩进单位(取前若干行里第一条缩进行)。
 *
 * 返回**真要写进文本的东西**:制表符文件返回 `"\t"`,空格文件返回对应个数
 * 的空格。它同时供两处用:`indentUnit`(回车 / Tab 真的插什么)与 `tabSize`
 * (一个 Tab 画多宽)。只给宽度不给单位的话,4 空格缩进的项目会被回车敲成
 * 2 空格,一座文件里混进两种缩进。
 */
export function detectIndent(content: string): string {
  const lines = content.split("\n").slice(0, 200);
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (indent.length === 0) continue;
    if (indent.includes("\t")) return "\t"; // Tab 缩进:一个 Tab 一级
    return " ".repeat(Math.min(indent.length, 8));
  }
  return "  ";
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
  expandedDirs: new Set<string>(),
  treeFocus: null,
  problemsOpen: false,
  diffPath: null,
  diffStaged: false,
  jump: null,
  references: null,

  async openProject(root) {
    const info = await codeApi.openProject(root);
    const previous = get().project;
    // 同一个项目重开(点了历史菜单里的当前项目):只换一份新文件树,**不动
    // 标签与缓冲区**。走下面那条清空路的话,未保存的改动与撤销栈一起没了。
    if (previous && previous.root === info.root) {
      set({ project: info });
      return;
    }
    // 换项目 = 换沙箱边界。旧项目起的语言服务器必须停掉:它们按根路径存活,
    // 不停就是一组孤儿进程(还各自攥着一份文件树)。
    if (previous) await codeApi.lspStop(previous.root).catch(() => {});
    // 缓冲区随项目一起清空:先把有改动的文件落盘,不存就丢了(与关项目同一条纪律)。
    for (const path of Object.keys(get().files)) {
      if (isDirty(get(), path)) await get().saveFile(path);
    }
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
      expandedDirs: new Set<string>(),
      treeFocus: null,
      problemsOpen: false,
      diffPath: null,
      diffStaged: false,
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
      expandedDirs: new Set<string>(),
      treeFocus: null,
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
    // 外部新建/删除文件同样会改 git 状态(新增未跟踪、删除),顺手刷一次。
    await get().refreshGit();
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
    // 连点两个文件时,读盘有先后:只认最后一次请求的结果。不认序的话,
    // 先点的那份晚到一步就会把光标夺回旧文件。
    const seq = ++openSeq;
    let file: CodeFile;
    try {
      file = await codeApi.readFile(root, path);
    } catch (e) {
      useAppStore.getState().showToast(`打开 ${path} 失败: ${String(e)}`);
      return;
    }
    if (seq !== openSeq) return;
    const indentUnit = detectIndent(file.content);
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
          indentUnit,
          tabSize: indentUnit === "\t" ? TAB_DISPLAY_WIDTH : indentUnit.length,
        },
      },
    }));
    // 语言服务器起来了就顺手把文档推上去,补全/跳转立刻可用。
    if (!file.binary) void get().ensureLsp(file.languageId);
  },

  closeTab(path) {
    // 有未保存的改动就先落盘:缓冲区随标签一起消失,不存就丢了。
    if (isDirty(get(), path)) void get().saveFile(path);
    const root = get().project?.root;
    set((s) => {
      const tabs = s.tabs.filter((p) => p !== path);
      const files = { ...s.files };
      delete files[path];
      const activePath =
        s.activePath === path ? (tabs[tabs.length - 1] ?? null) : s.activePath;
      return { tabs, files, activePath };
    });
    // 服务器那边的文档也要关:不关它会把已关闭文件的诊断继续推回来
    // (问题面板里挂着一个「幽灵文件」),还一直攥着那份文本。
    if (root) void codeApi.lspClose(root, path).catch(() => {});
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
    // 二进制 / 超大文件的内容根本没读进来(content 是空串)。放过去就等于
    // 把整篇文件写成空——宁可什么都不做。
    if (file.binary) return;
    try {
      await codeApi.writeFile(root, path, file.content);
    } catch (e) {
      useAppStore.getState().showToast(`保存 ${path} 失败: ${String(e)}`);
      return;
    }
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

  toggleDir(path) {
    set((s) => {
      const next = new Set(s.expandedDirs);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedDirs: next };
    });
  },

  requestTreeFocus(path) {
    treeFocusSeq += 1;
    set({ treeFocus: { path, seq: treeFocusSeq } });
  },

  clearTreeFocus() {
    set({ treeFocus: null });
  },

  expandTo(path) {
    const dirs = ancestorDirs(path);
    if (dirs.length === 0) return;
    set((s) => {
      const next = new Set(s.expandedDirs);
      let changed = false;
      for (const dir of dirs) {
        if (!next.has(dir)) {
          next.add(dir);
          changed = true;
        }
      }
      return changed ? { expandedDirs: next } : s;
    });
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
