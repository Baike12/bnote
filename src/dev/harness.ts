import { EditorView } from "@codemirror/view";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { insertNewlineAndIndent, redo, undo } from "@codemirror/commands";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import "katex/dist/katex.min.css";
import "@/styles/global.css";
import { createEditor, loadDocument, reconfigureTypewriter, reconfigureVim } from "@/editor/setup";
import { editorApi } from "@/editor/api";
import { adjustHeadingLevel, enterContinueListItem, insertCodeBlock, insertMathBlock, jumpHeaderTodos, toggleHeadingAny, toggleList, toggleTodo } from "@/editor/ops";
import { renumberHeadings } from "@/editor/numbering";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { currentVimMode, getCM, Vim } from "@/editor/vim/vim";
import { useAppStore } from "@/state/appStore";
import { api, type FileNode } from "@/lib/tauri";
import { relDirname } from "@/lib/path";
import * as actions from "@/app/actions";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "@/components/Sidebar";
import { LinkSuggest } from "@/components/LinkSuggest";
import "@/commands/builtin";
import { installGlobalKeybindings } from "@/commands/globalKeys";
import { installEditingChords } from "@/lib/editingChords";
import { setClipboardOverrides } from "@/lib/clipboard";
import { AgentPanel, renderAgentMarkdown } from "@/components/AgentPanel";
import { ContentPane } from "@/components/ContentPane";

const DOC = `# 公式与光标

上面的普通文本行。

\$\$
L_{total}(\\theta) = L_{data}(\\theta) + \\frac{\\lambda}{2}||\\theta||^2
\$\$

块后第一行。

块后第二行。

\$\$
\\begin{align}
g_{t} &= \\nabla L_{data}(\\theta) + \\lambda \\theta \\\\
m_{t} &= \\beta_1 m_{t-1} + (1 - \\beta_1) g_{t}
\\end{align}
\$\$

第二个块后第一行。

第二个块后第二行。

最后一行。
`;

declare global {
  interface Window {
    __view: EditorView;
    __cursor: () => { line: number; col: number; pos: number };
    __setCursor: (line: number, col: number) => void;
    __loadDoc: (text: string) => number;
    __toggleTodo: () => void;
    __toggleHeading: () => void;
    __toggleList: (kind: "bullet" | "numbered") => void;
    __headingTab: (delta: 1 | -1) => boolean;
    __setTypewriter: (on: boolean) => void;
    __enterAt: (
      text: string,
      line: number,
      col: number,
    ) => { which: string; after: string };
    /** 连续 Enter（`__enterAt` 的多次版），用于观察逐级回退。 */
    __enterTimes: (
      text: string,
      line: number,
      col: number,
      times: number,
    ) => { which: string[]; steps: string[]; cursors: { line: number; col: number }[] };
    /** 真实文件切换路径（setState，语法树清零），复现/验证首帧渲染。 */
    __loadFileDoc: (text: string) => void;
    /** loadDocument 后立即走 Enter 键序——空树窗口期的确定性复现。 */
    __enterAfterLoad: (
      text: string,
      line: number,
      col: number,
    ) => { which: string; after: string; cursor: { line: number; col: number } };
    /** 空树窗口期探针：isActiveAt / 树覆盖情况。 */
    __freshProbe: (text: string, pos: number) => {
      activeNeg: boolean;
      activePos: boolean;
      treeLen: number;
      docLen: number;
      treeComplete: boolean;
    };
    __setAutoNumber: (on: boolean) => void;
    __renumber: () => void;
    __undo: () => boolean;
    __redo: () => boolean;
    /** 头部疑问待办往返跳转。 */
    __jumpHeaderTodos: () => void;
    /** 插入代码块（语言取设置 codeBlockLang；有选区时包裹所选行）。 */
    __insertCodeBlock: () => void;
    /** 插入公式块（与代码块共用独占整行块的插入几何）。 */
    __insertMathBlock: () => void;
    /** 修改代码块语言设置（走真实 patchSettings 路径）。 */
    __setCodeBlockLang: (lang: string) => void;
    /** 当前 vim 模式；vim 未安装（compartment 清空）时为 null。 */
    __vimMode: () => string | null;
    /** 按设置开启/关闭 vim（与真实设置路径一致）。 */
    __setVim: (on: boolean) => void;
    /** 把按键序列喂给 vim 引擎（真实 handleKey 路径）。 */
    __vimKeys: (keys: string[]) => { mode: string | null; doc: string; panel: string | null };
    /** 直接走引擎的 openNotification，返回底部面板内容（没有面板则 null）。 */
    __vimNotify: (text: string, durationMs?: number) => string | null;
    /** 假仓库（内存目录树）+ 挂载真实 Sidebar（等索引就绪）。 */
    __mountSidebar: (entries: string[]) => Promise<string[]>;
    /** 假仓库（内存目录树），不挂侧栏——编辑器侧的链路只需要它。 */
    __fakeVault: (entries: string[]) => Promise<string[]>;
    /** 挂载真实 <LinkSuggest/>，返回卸载函数（A/B 测量用）。 */
    __mountLinkSuggest: () => () => void;
    /** 面板当前渲染状态（没挂载时为 null）。 */
    __linkPanel: () => LinkPanelState | null;
    /** 安装真实快捷键分发（走 globalKeys → runCommand）。 */
    __installGlobalKeys: () => void;
    /** 当前树行（含内联重命名状态）。 */
    __treeRows: () => TreeRow[];
    /** 跑真实 newFolder 并等链路收敛。 */
    __newFolder: (parent?: string, timeoutMs?: number) => Promise<TreeRow[]>;
    /** 在重命名输入框里敲入 name 并回车。 */
    __renameCommit: (name: string) => boolean;
    /** 内存剪贴板：注入内容（编辑器/表单的 ⌘C/⌘X/⌘V 断言用）。 */
    __setClipboard: (text: string) => void;
    /** 读回内存剪贴板（⌘C/⌘X 后断言写入内容）。 */
    __readClipboard: () => string;
    /** 应用 store（读取/驱动侧栏相关状态）。 */
    __store: typeof useAppStore;
    /** 应用层动作（openNote / openWikiLink / goBackLink…）。 */
    __actions: typeof actions;
    /** IPC 层（假仓库替换的对象）。 */
    __api: typeof api;
    /** 挂载真实学习模式组件（AgentPanel + ContentPane），返回卸载函数。 */
    __mountStudyLayout: () => () => void;
    /** 学习模式 Agent 回复的迷你 markdown 渲染器（返回 HTML）。 */
    __renderAgentMd: (text: string) => string;
    /** 当前文档语法树节点名（调试用）。 */
    __treeNames: () => string[];
  }
}

interface TreeRow {
  relPath: string | null;
  name: string | null;
  renaming: boolean;
  value: string | null;
  selection: [number | null, number | null] | null;
  focused: boolean;
  kbdCursor: boolean;
}

interface LinkPanelState {
  /** 面板外框的视口坐标（断言贴光标行 / 翻到上方 / 夹进视口）。 */
  rect: { left: number; top: number; right: number; bottom: number };
  query: string | null;
  rows: { name: string; path: string; active: boolean }[];
  /** 光标行（视口坐标）——与面板位置对照用。 */
  caretRect: { left: number; top: number; bottom: number } | null;
}

const view = createEditor(document.getElementById("editor-host")!, DOC, {
  onDocChanged: () => {},
  onCursorMoved: () => {},
});
reconfigureVim(view, true, []);
editorApi.view = view; // 与 App 保持一致：钩子和守卫按单编辑器实例工作
view.focus();

window.__view = view;
window.__cursor = () => {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, col: head - line.from, pos: head };
};
window.__setCursor = (line: number, col: number) => {
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: Math.min(l.from + col, l.to) } });
  view.focus();
};
window.__loadDoc = (text: string) => {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  return view.state.doc.lines;
};
window.__toggleTodo = () => toggleTodo(view);
window.__toggleHeading = () => toggleHeadingAny(view);
window.__toggleList = (kind) => toggleList(view, kind);
window.__headingTab = (delta) => adjustHeadingLevel(view, delta);
window.__setTypewriter = (on) => {
  useAppStore.getState().patchSettings({ typewriter: on });
  reconfigureTypewriter(view, on);
};
// Enter 键真实键序（bnote 列表续行 → lang-markdown 续行 → defaultKeymap），用于调试续行行为。
const runEnterChain = () =>
  enterContinueListItem(view)
    ? "bnote"
    : insertNewlineContinueMarkup(view)
      ? "md"
      : (insertNewlineAndIndent(view), "default");
window.__enterAt = (text, line, col) => {
  window.__loadDoc(text);
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: col < 0 ? l.to : Math.min(l.from + col, l.to) } });
  const which = runEnterChain();
  return { which, after: view.state.doc.toString() };
};
// 连续 Enter：逐级回退行为（同级 → 上一级 → … → 顶级取消标记）靠重复按键
// 才能观察，单次 __enterAt 看不到。steps 是每次按键后的完整文档。
window.__enterTimes = (text, line, col, times) => {
  window.__loadDoc(text);
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: col < 0 ? l.to : Math.min(l.from + col, l.to) } });
  const which: string[] = [];
  const steps: string[] = [];
  const cursors: { line: number; col: number }[] = [];
  for (let i = 0; i < times; i++) {
    which.push(runEnterChain());
    steps.push(view.state.doc.toString());
    const c = window.__cursor();
    cursors.push({ line: c.line, col: c.col });
  }
  return { which, steps, cursors };
};
window.__loadFileDoc = (text) => {
  loadDocument(view, text);
};
window.__enterAfterLoad = (text, line, col) => {
  loadDocument(view, text);
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: col < 0 ? l.to : Math.min(l.from + col, l.to) } });
  const which = runEnterChain();
  const cur = window.__cursor();
  return { which, after: view.state.doc.toString(), cursor: { line: cur.line, col: cur.col } };
};
window.__freshProbe = (text, pos) => {
  loadDocument(view, text);
  const tree = syntaxTree(view.state);
  return {
    activeNeg: markdownLanguage.isActiveAt(view.state, pos, -1),
    activePos: markdownLanguage.isActiveAt(view.state, pos, 1),
    treeLen: tree.length,
    docLen: view.state.doc.length,
    treeComplete: syntaxTreeAvailable(view.state, view.state.doc.length),
  };
};
window.__setAutoNumber = (on) => {
  useAppStore.getState().patchSettings({ autoNumberHeadings: on });
};
window.__renumber = () => renumberHeadings(view);
window.__undo = () => undo(view);
window.__redo = () => redo(view);
window.__jumpHeaderTodos = () => jumpHeaderTodos(view);
window.__insertCodeBlock = () => insertCodeBlock(view);
window.__insertMathBlock = () => insertMathBlock(view);
window.__setCodeBlockLang = (lang) => {
  useAppStore.getState().patchSettings({ codeBlockLang: lang });
};
window.__vimMode = () => currentVimMode(view);
window.__setVim = (on) => {
  useAppStore.getState().patchSettings({ vim: on });
  reconfigureVim(view, on, []);
};
/** 把按键序列喂给 vim 引擎，走的就是真实 keydown 用的那条路
    （wrapper 的 handleKey → Vim.multiSelectHandleKey），返回文档/模式/底部面板内容。 */
window.__vimKeys = (keys: string[]) => {
  const cm = getCM(view);
  if (!cm) throw new Error("vim engine not attached");
  for (const k of keys) Vim.multiSelectHandleKey(cm, k, "user");
  return {
    mode: currentVimMode(view),
    doc: view.state.doc.toString(),
    panel: document.querySelector(".cm-vim-panel")?.textContent ?? null,
  };
};

/** 直接走引擎的 openNotification（showConfirm 的唯一出口），复刻它的元素形状。 */
window.__vimNotify = (text: string, durationMs = 1500) => {
  const cm = getCM(view);
  if (!cm) throw new Error("vim engine not attached");
  const pre = document.createElement("div");
  pre.className = "cm-vim-message";
  pre.textContent = text;
  cm.openNotification(pre, { bottom: true, duration: durationMs });
  return document.querySelector(".cm-vim-panel")?.textContent ?? null;
};
/** 直接读/改应用状态（侧栏流程调试用）。 */
window.__store = useAppStore;
/** 应用层动作（openNote / openWikiLink / goBackLink…）——按真实链路驱动。 */
window.__actions = actions;
/** IPC 层（假仓库拦的就是它）——测量/计次用。 */
window.__api = api;

// ---- 侧栏文件树：浏览器里没有 Tauri（也没有 vault），用内存假仓库顶替 IPC，
// 挂载真实的 <Sidebar/> 跑真实 actions，验证「新建文件夹 → 自动重命名」链路。
const FAKE_ROOT = "/fake-vault";
/** 假 createDir 最终落地的 relPath——重命名要盯住的正是它（不是请求里的名字）。 */
let lastCreatedDir: string | null = null;

function installFakeVault(entries: string[]) {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const contents = new Map<string, string>();
  for (const e of entries) (e.endsWith("/") ? dirs : files).add(e.replace(/\/$/, ""));

  const nodeOf = (rel: string, kind: "file" | "dir"): FileNode => ({
    name: rel.slice(rel.lastIndexOf("/") + 1),
    relPath: rel,
    kind,
    children: null,
  });
  const childrenOf = (parent: string): FileNode[] => [
    ...[...dirs].filter((d) => relDirname(d) === parent).sort().map((d) => nodeOf(d, "dir")),
    ...[...files].filter((f) => relDirname(f) === parent).sort().map((f) => nodeOf(f, "file")),
  ];
  const created = (rel: string) => ({ path: `${FAKE_ROOT}/${rel}`, relPath: rel });

  Object.assign(api, {
    setVault: async () => ({ path: FAKE_ROOT, name: "fake-vault" }),
    readTree: async () => childrenOf(""),
    readDir: async (rel: string) => childrenOf(rel),
    listFiles: async () => ({ files: [...files].sort(), dirs: [...dirs].sort() }),
    createDir: async (parent: string, name: string) => {
      let rel = parent ? `${parent}/${name}` : name;
      let counter = 2;
      while (dirs.has(rel) || files.has(rel)) rel = `${parent ? `${parent}/` : ""}${name} ${counter++}`;
      dirs.add(rel);
      lastCreatedDir = rel;
      return created(rel);
    },
    createFile: async (parent: string, name: string) => {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let rel = parent ? `${parent}/${name}` : name;
      let counter = 2;
      while (dirs.has(rel) || files.has(rel)) rel = `${parent ? `${parent}/` : ""}${stem} ${counter++}${ext}`;
      files.add(rel);
      return created(rel);
    },
    renamePath: async (path: string, newName: string) => {
      const rel = path.slice(FAKE_ROOT.length + 1);
      const to = `${relDirname(rel) ? `${relDirname(rel)}/` : ""}${newName}`;
      if (dirs.delete(rel)) dirs.add(to);
      else {
        files.delete(rel);
        files.add(to);
      }
      return `${FAKE_ROOT}/${to}`;
    },
    trashPath: async (path: string) => {
      const rel = path.slice(FAKE_ROOT.length + 1);
      for (const set of [dirs, files]) {
        for (const p of set) if (p === rel || p.startsWith(`${rel}/`)) set.delete(p);
      }
    },
    // 链接跳转要真的换文件：readFile/writeFile 走同一个内存内容表；文件不存在
    // 就抛错——真后端也是这样，别用默认内容把"已删除"糊过去。
    readFile: async (path: string) => {
      const rel = path.startsWith(FAKE_ROOT) ? path.slice(FAKE_ROOT.length + 1) : path;
      if (!files.has(rel)) throw new Error(`文件不存在: ${rel}`);
      return contents.get(rel) ?? `# ${rel}\n`;
    },
    writeFile: async (path: string, text: string) => {
      const rel = path.startsWith(FAKE_ROOT) ? path.slice(FAKE_ROOT.length + 1) : path;
      contents.set(rel, text);
    },
    saveAppConfig: async () => {},
  });

  useAppStore.getState().setVault({ path: FAKE_ROOT, name: "fake-vault" });
  return [...dirs].sort();
}

/**
 * 假仓库 + 挂载真实 Sidebar；等索引就绪后返回初始目录列表。
 * setVault 会清空 tree，不 refresh 的话树里一行都没有（要 refreshTree 才有根层级）。
 */
window.__mountSidebar = async (entries: string[]) => {
  const dirs = installFakeVault(entries);
  const host = document.createElement("div");
  host.id = "sidebar-host";
  // display:flex 是照真实 .app 抄的：侧栏被拉伸成固定高度，.sidebar-tree 才会滚。
  host.style.cssText = "position:fixed;left:0;top:0;width:280px;height:100vh;z-index:99;display:flex";
  document.body.appendChild(host);
  createRoot(host).render(createElement(Sidebar));
  await actions.refreshTree();
  return dirs;
};

/** 假仓库（不挂侧栏）+ 索引就绪：链接补全面板吃的是 flatFiles/recentFiles。 */
window.__fakeVault = async (entries: string[]) => {
  const dirs = installFakeVault(entries);
  await actions.refreshTree();
  return dirs;
};

/** 挂载真实 <LinkSuggest/>：面板挂不挂载由 store 的 linkSuggest 锚点决定。返回卸载函数。 */
window.__mountLinkSuggest = () => {
  const host = document.createElement("div");
  host.id = "link-suggest-host";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(LinkSuggest));
  return () => {
    root.unmount();
    host.remove();
  };
};

window.__linkPanel = () => {
  const box = document.querySelector<HTMLElement>(".link-suggest");
  if (!box) return null;
  const caret = view.coordsAtPos(view.state.selection.main.head);
  const r = box.getBoundingClientRect();
  return {
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    query: document.querySelector<HTMLInputElement>(".link-suggest-input")?.value ?? null,
    rows: [...document.querySelectorAll(".link-suggest-row")].map((el) => ({
      name: el.querySelector(".link-suggest-name")?.textContent ?? "",
      path: el.querySelector(".link-suggest-path")?.textContent ?? "",
      active: el.classList.contains("active"),
    })),
    caretRect: caret ? { left: caret.left, top: caret.top, bottom: caret.bottom } : null,
  };
};

/** 安装真实快捷键分发（globalKeys → runCommand），用于验证 Cmd-K 全链路。 */
window.__installGlobalKeys = () => installGlobalKeybindings();

/** 当前渲染出来的树行（含内联重命名输入框状态）。 */
window.__treeRows = () =>
  [...document.querySelectorAll(".sidebar-tree .tree-row")].map((row) => {
    const input = row.querySelector<HTMLInputElement>(".rename-input");
    return {
      relPath: (row as HTMLElement).dataset.path ?? null,
      name: row.querySelector(".tree-name")?.textContent ?? null,
      renaming: input !== null,
      value: input?.value ?? null,
      selection: input ? [input.selectionStart, input.selectionEnd] : null,
      focused: input !== null && document.activeElement === input,
      kbdCursor: row.classList.contains("kbd-cursor"),
    };
  });

/**
 * 跑真实 newFolder，等链路收敛后返回树行：具体等的是「刚建出来的那个 relPath 的行挂上
 * 输入框且拿到焦点」——其它重命名输入框（比如上一次遗留的）不算数。超时也返回当前行，
 * 由调用方断言，避免把等待变成断言。
 */
window.__newFolder = async (parent?: string, timeoutMs = 1000) => {
  lastCreatedDir = null;
  await actions.newFolder(parent);
  const want = lastCreatedDir;
  const settled = () => {
    const input = document.querySelector<HTMLInputElement>(".rename-input");
    const row = input?.closest(".tree-row") as HTMLElement | null;
    return input !== null && row?.dataset.path === want && document.activeElement === input;
  };
  const deadline = performance.now() + timeoutMs;
  while (!settled() && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return window.__treeRows();
};

window.__renameCommit = (name: string) => {
  const input = document.querySelector<HTMLInputElement>(".rename-input");
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, name);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return true;
};

// 内存剪贴板（无 Tauri IPC，navigator.clipboard 在受控环境不可靠）+ 全局 ⌘ 和弦兜底
let clipboardStub = "";
setClipboardOverrides({
  read: async () => clipboardStub,
  write: async (text) => {
    clipboardStub = text;
    return true;
  },
});
window.__setClipboard = (text) => {
  clipboardStub = text;
};
window.__readClipboard = () => clipboardStub;
installEditingChords();

// 学习模式调试钩子：挂载真实组件（浏览器里 invoke 不可用，组件需自愈）。
window.__mountStudyLayout = () => {
  const host = document.createElement("div");
  host.className = "study-layout";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "9999";
  host.style.background = "var(--panel, #faf8f3)";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    createElement("div", { style: { display: "contents" } },
      createElement(AgentPanel),
      createElement(ContentPane),
    ),
  );
  return () => {
    root.unmount();
    host.remove();
  };
};

window.__renderAgentMd = renderAgentMarkdown;

window.__treeNames = () => {
  const names: string[] = [];
  const walk = (node: { name: string; from: number; to: number; firstChild: unknown; nextSibling: unknown }, depth: number) => {
    names.push("  ".repeat(depth) + node.name);
    for (let child = node.firstChild as typeof node; child; child = child.nextSibling as typeof node) {
      walk(child, depth + 1);
    }
  };
  const tree = syntaxTree(editorApi.view!.state);
  walk(tree.topNode, 0);
  return names;
};
