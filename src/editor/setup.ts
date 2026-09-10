import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { search, highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdownExtensions, codeHighlighting } from "./markdown";
import { insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { livePreviewExtension, configureLivePreview } from "./livePreview";
import { typewriterExtension } from "./typewriter";
import { imeSwitchExtension } from "./imeSwitch";
import { snippetsExtension } from "./snippets/extension";
import { installMathMotionClamp } from "./motionClamp";
import { renumberHeadings } from "./numbering";
import { vimModeExtension, commandMappingKeymap, vimVisualHighlight } from "./vim/vim";
import { useAppStore } from "@/state/appStore";
import { adjustHeadingLevel, enterContinueListItem } from "./ops";
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

    // Heading lines own Tab / Shift-Tab (level up / down, see ops.ts); any
    // non-heading cursor falls through to the usual indent bindings below.
    keymap.of([
      { key: "Tab", run: (v) => adjustHeadingLevel(v, 1), shift: (v) => adjustHeadingLevel(v, -1) },
    ]),

    markdownExtensions(),
    codeHighlighting(),

    livePreviewCompartment.of(livePreviewExtension()),
    typewriterCompartment.of([]),
    vimCompartment.of([]),
    vimCommandMapCompartment.of([]),
    // IME follow (self-gates on settings.vim + settings.ime.enabled).
    imeSwitchExtension(),

    history(),
    search({
      top: true,
    }),
    highlightSelectionMatches(),

    keymap.of([
      // Bullet/todo Enter first: keeps tab indentation intact and exits empty
      // items (see ops.ts) — lang-markdown's continuation expands tabs.
      { key: "Enter", run: enterContinueListItem },
      // Markdown-aware Enter/Backspace: continue lists, but do NOT carry
      // indentation into code fences (a plain newline keeps fences closable).
      { key: "Enter", run: insertNewlineContinueMarkup },
      { key: "Backspace", run: deleteMarkupBackward },
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      { key: "Tab", run: indentMore, shift: indentLess },
    ]),

    EditorView.lineWrapping,
    EditorView.theme({
      "&": { height: "100%" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-content": { caretColor: "var(--accent, #f5a83c)" },
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
    // 让光标与文本同帧落位。
    EditorView.updateListener.of((u) => {
      if (!u.docChanged || !useAppStore.getState().settings.vim) return;
      u.view.coordsAtPos(u.state.selection.main.head);
    }),
  ];
}

let savedExtensions: Extension[] | null = null;

export function createEditor(parent: HTMLElement, doc: string, callbacks: EditorCallbacks): EditorView {
  savedExtensions = baseExtensions(callbacks);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: savedExtensions }),
    parent,
  });
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

/** Replaces the document (file switch) while keeping extension config. */
export function loadDocument(view: EditorView, doc: string) {
  if (!savedExtensions) return;
  view.setState(EditorState.create({ doc, extensions: savedExtensions }));
  restoreCompartments(view);
  primeSyntaxTree(view);
}

/** Reloads fresh disk content (external edit) while keeping the cursor and
 *  scroll position as far as the new document allows. Callers must re-apply
 *  settings afterwards — setState() resets the extension compartments. */
export function reloadDocument(view: EditorView, doc: string) {
  if (!savedExtensions) return;
  const ranges = view.state.selection.ranges;
  const scrollTop = view.scrollDOM.scrollTop;
  view.setState(EditorState.create({ doc, extensions: savedExtensions }));
  restoreCompartments(view);
  primeSyntaxTree(view);
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
