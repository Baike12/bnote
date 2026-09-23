import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { setDocPath, docPathField } from "./docPath";
import { EditorView, keymap, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { search, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdownExtensions, codeHighlighting } from "./markdown";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { livePreviewExtension, configureLivePreview } from "./livePreview";
import { typewriterExtension } from "./typewriter";
import { imeSwitchExtension } from "./imeSwitch";
import { pythonLspExtension } from "@/python/lsp";
import { dailySyncExtension } from "@/daily/extension";
import { snippetsExtension } from "./snippets/extension";
import { installMathMotionClamp } from "./motionClamp";
import { renumberHeadings } from "./numbering";
import { vimModeExtension, commandMappingKeymap, vimVisualHighlight } from "./vim/vim";
import { cutSelection, copySelection, pasteClipboard } from "./ops";
import { useAppStore } from "@/state/appStore";
import { enterContinueListItem } from "./ops";
import type { VimMapping } from "./vim/vimrc";

export interface EditorCallbacks {
  /** Fired on any document change (autosave hook). */
  onDocChanged: () => void;
  /** Fired on cursor/selection moves (status bar). */
  onCursorMoved: () => void;
}

const vimCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const livePreviewCompartment = new Compartment();
const vimCommandMapCompartment = new Compartment();

export function baseExtensions(callbacks: EditorCallbacks): Extension[] {
  return [
    // Snippet Tab handling takes precedence over everything else.
    snippetsExtension(),

    // lang-markdown ships its own Enter/Backspace in a Prec.high keymap
    // (insertNewlineContinueMarkup / deleteMarkupBackward). Without a higher
    // precedence its Enter wins outright, and the list-specific behavior in
    // ops.ts never runs — tab indentation gets expanded to spaces and an empty
    // nested item grows a blank line instead of moving up a level. Prec.highest
    // keeps the list Enter in charge; every non-list line still falls through
    // to lang-markdown below.
    Prec.highest(keymap.of([{ key: "Enter", run: enterContinueListItem }])),

    markdownExtensions(),
    codeHighlighting(),

    docPathField,
    livePreviewCompartment.of(livePreviewExtension()),
    typewriterCompartment.of([]),
    vimCompartment.of([]),
    vimCommandMapCompartment.of([]),
    // IME follow (self-gates on settings.vim + settings.ime.enabled).
    imeSwitchExtension(),

    // ty LSP:文档变更防抖同步行对齐虚拟 python 文件,诊断贴回文档。
    // 自带门槛(无 docPath 的编辑器、无 python 围栏、项目 LSP 关闭都直通)。
    pythonLspExtension(),

    // 跨文件待办同步:勾选/子待办/改名镜像到日记(自带链接库未加载直通门槛)。
    dailySyncExtension(),

    history(),
    search({
      top: true,
    }),
    highlightSelectionMatches(),

    keymap.of([
      // ⌘C/⌘X/⌘V 必须在这里显式实现：wry 的 WKWebView 在视图层认领 ⌘ 和弦、
      // 作为普通 keydown 送进页面，AppKit Edit 菜单角色收不到事件，WebKit 也
      // 不会对 keydown 代行剪贴板动作（⌘A 之所以能用，是因为 defaultKeymap
      // 里有 Mod-a → selectAll 的 JS 绑定）。剪贴板本体走 lib/clipboard。
      { key: "Mod-c", run: copySelection },
      { key: "Mod-x", run: cutSelection },
      { key: "Mod-v", run: pasteClipboard },
      // Markdown-aware Enter/Backspace fallback: continue lists, but do NOT
      // carry indentation into code fences (a plain newline keeps fences
      // closable). List lines never get here — the Prec.highest binding above
      // takes them.
      { key: "Enter", run: insertNewlineContinueMarkup },
      { key: "Backspace", run: deleteMarkupBackward },
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      { key: "Tab", run: indentMore, shift: indentLess },
    ]),

    EditorView.lineWrapping,
    // 光标几何的唯一写入者：原生 caret 的绘制时序由 WebKit 内部决定——列表
    // 标记槽/缩进导致的 DOM 重构期间，它会按旧的内联偏移画出一帧（用户看到的
    // “光标闪到行首”），JS 侧选区状态再正确也约束不了它。drawSelection 把
    // caret 换成 CM6 测量绘制的 .cm-cursor，位置来自当帧 measure（下面的
    // updateListener 会在 vim 开启时把它冲刷到同帧），DOM 重构不再有可见窗口。
    // 普通/可视模式不受影响：shim 的 .cm-vimMode 规则照常隐藏 CM6 光标层、
    // 只显示引擎的块状光标。
    // 系统 caret 的闪烁节奏（引擎块光标的 blink 也读同一配置）。
    drawSelection({ cursorBlinkRate: 530 }),
    EditorView.theme({
      "&": { height: "100%" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-content": { caretColor: "var(--accent, #f5a83c)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent, #f5a83c)" },
    }),
    // Suppress the macOS inline predictive-text / autocorrect popup while
    // typing English in the note body.
    EditorView.contentAttributes.of({
      autocorrect: "off",
      autocapitalize: "off",
      autocomplete: "off",
      spellcheck: "false",
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) callbacks.onDocChanged();
      if (u.selectionSet || u.docChanged) callbacks.onCursorMoved();
      // 标题自动编号：文档变更后补一次重编号（input.bnote-renumber 事务
      // 不再触发，防循环）。updateListener 里禁止直接 dispatch，放微任务——
      // 仍在本次绘制前完成，撤销时与原编辑同组。
      // 撤销/重做绝不触发：否则编号被撤掉后立刻又被补回，撤销永远撤不净。
      if (
        u.docChanged &&
        !u.transactions.some(
          (t) =>
            t.isUserEvent("input.bnote-renumber") ||
            t.isUserEvent("undo") ||
            t.isUserEvent("redo"),
        ) &&
        useAppStore.getState().settings.autoNumberHeadings
      ) {
        const view = u.view;
        queueMicrotask(() => {
          // isConnected：微任务执行前视图可能已被销毁（文件切换/关窗）。
          if (
            useAppStore.getState().settings.autoNumberHeadings &&
            view.dom.isConnected
          ) {
            renumberHeadings(view);
          }
        });
      }
    }),
    // vim 的块光标不是原生光标：插件自己画在 .cm-vimCursorLayer 里，位置经
    // view.requestMeasure 推迟到下一帧才写入（@replit/codemirror-vim 的
    // BlockCursorPlugin.update → requestMeasure → rAF），而行与装饰的 DOM 更新
    // 是同步的。列表缩进让整行右移 28px，缩进后的那一帧里光标还停在旧 x——正好
    // 压在新项目符号上，下一帧才跳到符号后面。updateListener 在所有 view plugin
    // 与 DOM 同步之后运行，这里读一次光标坐标，把挂起的 measure 就地冲刷掉，
    // 让光标与文本同帧落位。纯光标移动（vim 的 j/k、h/l）同样慢一帧，一并冲刷。
    EditorView.updateListener.of((u) => {
      if (!useAppStore.getState().settings.vim) return;
      if (!u.docChanged && !u.selectionSet) return;
      u.view.coordsAtPos(u.state.selection.main.head);
    }),
  ];
}

/**
 * 每个编辑器实例自己的基础扩展。刻意按 view 记，而不是一份全局变量：学习模式
 * 的中栏内容编辑器与右栏笔记编辑器各建一个实例，而 loadDocument 是整份替换
 * state 的 extensions —— 全局变量会让后建的实例把自己的扩展（含它的
 * updateListener 回调）塞进先建的那个的 state，于是在中栏敲字会触发笔记编辑器
 * 的自动保存，把笔记文件覆盖成笔记栏当时的内容。
 */
const extensionsByView = new WeakMap<EditorView, Extension[]>();

/** 实例自己的扩展；不是 createEditor 建的实例返回 null，loadDocument 不动它。 */
function ownExtensions(view: EditorView): Extension[] | null {
  return extensionsByView.get(view) ?? null;
}

export function createEditor(parent: HTMLElement, doc: string, callbacks: EditorCallbacks): EditorView {
  const extensions = baseExtensions(callbacks);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  });
  extensionsByView.set(view, extensions);
  installMathMotionClamp(view);
  return view;
}

/**
 * setState 之后语法树是空壳（后台解析尚未开始），装饰会按空树绘制——切换
 * 文件后"不动光标就不渲染"的根因。预算内同步把解析推到位，再用一个空事务
 * 触发装饰 field/plugin 按新树重建，保证首帧即为渲染态。大文档没推完的
 * 部分由后台解析完成后按树推进继续重建。
 */
function primeSyntaxTree(view: EditorView) {
  ensureSyntaxTree(view.state, view.state.doc.length, 50);
  view.dispatch({});
}

/**
 * setState 会把全部 compartment 清零（vim/typewriter/livePreview 一并失效），
 * 而恢复它们的 applySettingsToEditor 是异步的（vimrc 走 IPC）——这个窗口期里
 * vim 不存在，normal 模式下的 gg/G 会被当作普通输入打进文档。这里用缓存的
 * mappings 同步恢复，窗口期归零；异步路径随后仍会用最新 vimrc 再对齐一次。
 */
function restoreCompartments(view: EditorView) {
  const { settings } = useAppStore.getState();
  configureLivePreview({ mathPreview: settings.mathPreview });
  reconfigureVim(view, settings.vim, lastVimMappings);
  reconfigureTypewriter(view, settings.typewriter);
  reconfigureLivePreview(view, settings.livePreview);
}

/**
 * Replaces the document (file switch) while keeping extension config.
 * `docPath` is the file the doc came from — image references resolve against
 * its directory (see livePreview.ts).
 */
export function loadDocument(view: EditorView, doc: string, docPath: string | null = null) {
  const extensions = ownExtensions(view);
  if (!extensions) return;
  view.setState(EditorState.create({ doc, extensions }));
  restoreCompartments(view);
  primeSyntaxTree(view);
  view.dispatch({ effects: setDocPath.of(docPath) });
}

/** Reloads fresh disk content (external edit) while keeping the cursor and
 *  scroll position as far as the new document allows. Callers must re-apply
 *  settings afterwards — setState() resets the extension compartments. */
export function reloadDocument(view: EditorView, doc: string, docPath: string | null = null) {
  const extensions = ownExtensions(view);
  if (!extensions) return;
  const ranges = view.state.selection.ranges;
  const scrollTop = view.scrollDOM.scrollTop;
  view.setState(EditorState.create({ doc, extensions }));
  restoreCompartments(view);
  primeSyntaxTree(view);
  view.dispatch({ effects: setDocPath.of(docPath) });
  const max = view.state.doc.length;
  view.dispatch({
    selection: EditorSelection.create(
      ranges.map((r) => EditorSelection.range(Math.min(r.anchor, max), Math.min(r.head, max))),
    ),
  });
  view.scrollDOM.scrollTop = Math.min(scrollTop, view.scrollDOM.scrollHeight);
}

let lastVimMappings: VimMapping[] = [];

export function reconfigureVim(view: EditorView, enabled: boolean, mappings: VimMapping[]) {
  lastVimMappings = mappings;
  view.dispatch({
    effects: [
      // highlightActiveLine rides along with vim: CSS shows the shade only
      // while the vim plugin tags the scroller `.cm-vimMode` (normal/visual).
      vimCompartment.reconfigure(
        enabled ? [vimModeExtension(), highlightActiveLine(), vimVisualHighlight()] : [],
      ),
      vimCommandMapCompartment.reconfigure(enabled ? commandMappingKeymap(mappings) : []),
    ],
  });
}

export function reconfigureTypewriter(view: EditorView, enabled: boolean) {
  view.dispatch({
    effects: typewriterCompartment.reconfigure(enabled ? typewriterExtension() : []),
  });
}

export function reconfigureLivePreview(view: EditorView, enabled: boolean) {
  view.dispatch({
    effects: livePreviewCompartment.reconfigure(enabled ? livePreviewExtension() : []),
  });
}
