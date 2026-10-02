import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { setDocPath, docPathField } from "./docPath";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { search, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdownExtensions, codeHighlighting } from "./markdown";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { livePreviewExtension, configureLivePreview, selectionAffectsDecos } from "./livePreview";
import { typewriterExtension } from "./typewriter";
import { imeSwitchExtension } from "./imeSwitch";
import { pythonLspExtension } from "@/python/lsp";
import { dailySyncExtension } from "@/daily/extension";
import { dailyMarksExtension } from "@/daily/marks";
import { footprintZoneExtension, footprintMarksExtension } from "@/footprint/extension";
import { snippetsExtension, deleteDollarPair, deleteScriptBraces } from "./snippets/extension";
import { matrixEnter } from "./snippets/matrix";
import { configureLatexSuite } from "./snippets/config";
import { installMathMotionClamp } from "./motionClamp";
import { renumberHeadings } from "./numbering";
import {
  vimModeExtension,
  vimKeyCaptureExtension,
  commandMappingKeymap,
  vimVisualHighlight,
  currentVimMode,
  vimDrawsBlockCursor,
  vimActiveLine,
} from "./vim/vim";
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

/**
 * vim 的 normal/visual 模式里 Backspace/Enter 是"移动"而不是"编辑",这些
 * LaTeX Suite 的按键增强必须原样放行。闸门放在绑定点(setup)而不是特性模块
 * 里,是为了不让 snippets 反向依赖 vim 引擎。
 */
function vimAllowsEdit(view: EditorView): boolean {
  return !useAppStore.getState().settings.vim || currentVimMode(view) === "insert";
}

/** Backspace:LaTeX Suite 的 autoDelete$ 先手(公式里光标夹在两个 `$` 之间时
 *  一次删掉两个),bnote 追加的上下标空花括号同理(`_{|}`/`^{|}` 连 `_`/`^`
 *  一起删);其余情况交回下面的 markdown 删除逻辑。 */
function backspace(view: EditorView): boolean {
  if (!vimAllowsEdit(view)) return false;
  return deleteDollarPair(view) || deleteScriptBraces(view);
}

/** 矩阵环境里的 Enter 补 ` \\` 换行(Shift+Enter 只移动光标)。 */
function enterInMatrix(view: EditorView, shift: boolean): boolean {
  if (!vimAllowsEdit(view)) return false;
  return matrixEnter(view, shift);
}

const vimCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const livePreviewCompartment = new Compartment();
const vimCommandMapCompartment = new Compartment();

export function baseExtensions(callbacks: EditorCallbacks): Extension[] {
  return [
    // Snippet Tab handling takes precedence over everything else.
    snippetsExtension(),

    // 多段选区：vim 的 blockwise（Ctrl-V）在引擎里就是"每行一段"——y/d/c/p 逐段
    // 执行（Vim.forEachSelection → cm.listSelections()），块选逐行增删也靠它。
    // CM6 默认关闭该 facet，任何多段选区在事务落库时都被
    // tr.newSelection.asSingle() 压成主段，于是块选只剩光标那一行生效：选中三行
    // 按 y 只复制一行（而绘制是完整的块，两边各说各话）。打开后引擎的逐行段原样
    // 进入 state，绘制与复制/删除看到同一份几何。
    EditorState.allowMultipleSelections.of(true),

    // lang-markdown ships its own Enter/Backspace in a Prec.high keymap
    // (insertNewlineContinueMarkup / deleteMarkupBackward). Without a higher
    // precedence its Enter wins outright, and the list-specific behavior in
    // ops.ts never runs — tab indentation gets expanded to spaces and an empty
    // nested item grows a blank line instead of moving up a level. Prec.highest
    // keeps the list Enter in charge; every non-list line still falls through
    // to lang-markdown below.
    // 矩阵环境里的 Enter 排在列表续行之前:在 \begin{pmatrix}…\end{pmatrix}
    // 里回车补 ` \\` 换行才是想要的(Tab 补 ` & ` 同理,snippet 键位表里)。
    Prec.highest(
      keymap.of([
        { key: "Enter", run: (view) => enterInMatrix(view, false) },
        { key: "Shift-Enter", run: (view) => enterInMatrix(view, true) },
        { key: "Enter", run: enterContinueListItem },
      ]),
    ),

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
    // 已链接待办的可视标识(视口内行装饰,只占标记槽的绝对定位伪元素)。
    dailyMarksExtension(),
    // 今日足迹:今天的日记末尾聚合其他文件今日记录的块(引用式,只读);
    // 源文件侧收录行打 pip。自带门槛:非今日日记、索引为空都直通。
    footprintZoneExtension(),
    footprintMarksExtension(),

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
      // LaTeX Suite 的 autoDelete$ 排在 markdown 的删除逻辑之前;vim 的
      // normal/visual 模式里 Backspace 是"左移",必须原样交回引擎。
      { key: "Backspace", run: backspace },
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
    // 压在新项目符号上，下一帧才跳到符号后面。这里读一次光标坐标，把挂起的
    // measure 冲刷掉，让光标与文本同帧落位。纯光标移动（vim 的 j/k、h/l）同样
    // 慢一帧，一并冲刷。
    //
    // 冲刷的时序契约：排进**微任务**，而不是 updateListener 里同步执行。引擎的
    // 模式类翻转（vim-mode-change → updateClass 翻 scrollDOM 上的 .cm-vimMode）
    // 发生在 dispatch 返回之后、同一按键任务内——同步读坐标会按「翻转前」的
    // 样式算一轮布局，随后的类翻转把成果作废，rAF 的 measure 再算一轮：一次
    // Esc 两轮布局。微任务仍在本次按键任务内、渲染（rAF/绘制）之前，块光标
    // 照旧同帧落位；但它排在任务内全部同步变更（含类翻转）之后，一轮 measure
    // 看到的就是最终样式，双轮归一。后续同任务的微任务事务（如标题重编号）
    // 也被这一冲刷顺带覆盖，不再各付一轮。
    //
    // 代价与闸门：coordsAtPos 会**同步**跑完整轮 measure（块光标 + 选区层 +
    // 打字机居中）并强制一次样式重算 + 布局，实测每次 doc/selection 事务
    // 2.0ms、公式块里 4.3ms（真实 app）。而它换来的只有「光标层同帧落位」，所以
    // 只在**真有层会动**时付：
    //   - 文档变了：行/装饰的 DOM 可能重构，插入态的锚点会按旧偏移画一帧；
    //   - 否则要引擎在画块光标（normal/visual/replace）——measureCursor 的
    //     判据下 insert 态块光标层是空的，冲刷没有对象；
    //   - 或者这次选择变化能改到装饰（跨标记槽、命中行内触发符），行盒可能
    //     移位（selectionAffectsDecos 就是这条上界）。
    // 三者都不成立时（normal→insert 这类空转、正文里的插入态光标移动）冲刷
    // 换不到任何同帧收益，只剩整轮强制布局。
    EditorView.updateListener.of((u) => {
      if (!useAppStore.getState().settings.vim) return;
      if (!u.docChanged && !u.selectionSet) return;
      if (!vimCursorNeedsFlush(u.startState, u.state, vimDrawsBlockCursor(u.view), u.docChanged)) {
        return;
      }
      scheduleVimCursorFlush(u.view);
    }),
  ];
}

/** 冲刷的最小视图面：导出纯结构是为了在无 DOM 门禁里锁「微任务内执行、视图
 *  已销毁则放弃」的时序契约。 */
export interface FlushableView {
  dom: { isConnected: boolean };
  state: { selection: { main: { head: number } } };
  coordsAtPos(pos: number): unknown;
}

/**
 * 把光标冲刷排进微任务（理由见 updateListener 上方的时序契约）。视图在微任务
 * 执行前被销毁（文件切换/关窗）则放弃——异步回调自证时效，不许盲写。
 */
export function scheduleVimCursorFlush(view: FlushableView): void {
  queueMicrotask(() => {
    if (!view.dom.isConnected) return;
    view.coordsAtPos(view.state.selection.main.head);
  });
}

/**
 * 光标冲刷的判据（理由见上面那段注释）。三条「真有层会动」的来源：
 *   - 文档变了：行/装饰的 DOM 可能重构，插入态的原生锚点会按旧偏移画一帧；
 *   - 引擎在画块光标（normal/visual/replace）：块光标层的几何只有 measure 后才有；
 *   - 这次选择变化能改到装饰（跨标记槽、命中行内触发符）：行盒可能移位。
 * 都不成立（normal→insert 这类空转、正文里的插入态光标移动）时冲刷换不到任何
 * 同帧收益，只剩整轮强制布局——导出供门禁锁这条模型，它是模式切换卡顿的根因。
 */
export function vimCursorNeedsFlush(
  start: EditorState,
  state: EditorState,
  drawsBlockCursor: boolean,
  docChanged: boolean,
): boolean {
  if (docChanged) return true;
  if (drawsBlockCursor) return true;
  if (start.selection.eq(state.selection)) return false;
  return selectionAffectsDecos(start, state);
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
  configureLatexSuite(settings.latex);
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
      // 当前行底 shade 跟 vim 一起挂：vimActiveLine 以装饰模型画
      // cm-activeLine,可见性判据与引擎的 cm-vimMode 类(块光标判据)逐字
      // 一致——不依赖祖先类选择器,样式失效圈不随 Esc/i 罩住整个视口。
      // vimKeyCaptureExtension:normal/visual 模式下引擎先于整条 keymap 链
      // 见键(根因与契约见 vim.ts 捕获分发注释块)。
      vimCompartment.reconfigure(
        enabled
          ? [vimModeExtension(), vimKeyCaptureExtension(), vimActiveLine(), vimVisualHighlight()]
          : [],
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
