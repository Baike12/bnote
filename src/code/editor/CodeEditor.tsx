import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { codeHighlighting } from "@/editor/markdown";
import {
  vimModeExtension,
  vimKeyCaptureExtension,
  vimActiveLine,
  vimVisualHighlight,
} from "@/editor/vim/vim";
import { getCM } from "@replit/codemirror-vim";
import { useAppStore } from "@/state/appStore";
import { typewriterExtension } from "@/editor/typewriter";
import { useCodeStore, type OpenFile } from "../store";
import { codeApi } from "../api";
import { findLanguage } from "./language";
import { lspCompletion, lspDiagnosticsLinter, lspHoverTooltip } from "./lsp";
import { registerCodeEditor, setActiveCodeEditor, unregisterCodeEditor } from "./registry";

/**
 * 代码编辑器本体(CodeMirror 6)。
 *
 * 与笔记编辑器**完全分开**:自己的扩展、自己的键位、自己的 vim 开关
 * (`settings.codeVim`)。笔记区与代码区是两个编辑上下文,笔记的键位不会
 * 渗进代码里,代码的键位也不会渗进笔记里。
 *
 * ## 状态归属
 *
 * 文档内容在 store 里(不在编辑器里):编辑器实例会随标签切换重建/换文档,
 * 内容放进去就丢了。每个文件的 `EditorState` 缓存在组件里,切回来时
 * `setState` 换回去——撤销栈因此也留在各自的文件上。
 *
 * ## 单一写入者
 *
 * 文档内容只由编辑器往 store 写(`updateContent`),store 往编辑器写只有
 * 一处:外部改动(重命名后重读盘)时的整篇替换。两边都先比一次当前内容,
 * 相同就不动——不比较就会出现「写回自己触发自己」的循环。
 */

const languageCompartment = new Compartment();
const vimCompartment = new Compartment();
const wrapCompartment = new Compartment();
const typewriterCompartment = new Compartment();

export interface CodeEditorProps {
  file: OpenFile;
  /** 光标位置变化(状态栏用)。 */
  onCursor?: (line: number, column: number) => void;
  /** vim 模式变化(状态栏显示 NORMAL / INSERT)。 */
  onMode?: (mode: string) => void;
}

export function CodeEditor({ file, onCursor, onMode }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 每个文件的 EditorState:切标签时换回去,撤销栈不丢。 */
  const statesRef = useRef(new Map<string, EditorState>());
  const handleRef = useRef<{ root: string; path: string; language: string; view: EditorView } | null>(
    null,
  );
  /**
   * 往语言服务器推内容的防抖句柄(按文件分桶):打字的每一击都推会把服务器
   * 淹掉。按文件分是因为切文件时旧文件的待推内容不能被新文件的取消掉。
   *
   * 同时记下待推的 root 与文本:卸载(切去 PDF / 关项目)时要**先推完再走**,
   * 否则最后 300ms 里敲的内容服务器永远看不到,诊断停在旧文本上。
   */
  const syncTimersRef = useRef(
    new Map<string, { timer: ReturnType<typeof setTimeout>; root: string; text: string }>(),
  );

  const codeVim = useAppStore((s) => s.settings.codeVim);
  const codeWrap = useAppStore((s) => s.settings.codeWrap);
  // 打字机模式与笔记共用一份设置(含光标纵向位置):同一套模型,不为代码区
  // 再开一套开关。
  const typewriter = useAppStore((s) => s.settings.typewriter);
  const typewriterPosition = useAppStore((s) => s.settings.typewriterPosition);
  const jump = useCodeStore((s) => s.jump);
  const content = file.content;

  /**
   * 缩进:打开文件时猜一次,之后不变。
   *
   * `indentUnit` 是**回车/ Tab 真的写进去的东西**(2 空格、4 空格或一个制表
   * 符);`tabSize` 只决定 Tab 画出来多宽。两个都要给:只设 tabSize 的话
   * 自动缩进仍旧是 CodeMirror 默认的 2 空格,4 空格缩进的项目会被敲成混排。
   */
  const indentUnitText = file.indentUnit || "  ";
  const tabSize = file.tabSize || indentUnitText.length;

  // ---- 建视图(只建一次) ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 抓住这一份 Map:cleanup 里要用它,不能读 ref.current(那时的 ref 可能
    // 已经换过)。
    const timers = syncTimersRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: buildExtensions(),
      }),
    });
    viewRef.current = view;
    return () => {
      // 待推的内容先推完:clearTimeout 掉就等于最后几次输入永远不给服务器。
      for (const [path, pending] of timers) {
        clearTimeout(pending.timer);
        void codeApi.lspSync(pending.root, path, pending.text).catch(() => {});
      }
      timers.clear();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 把光标位置与 vim 模式报给状态条(切文件、换状态时用)。 */
  function reportCursor(view: EditorView): void {
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    onCursor?.(line.number, pos - line.from + 1);
    onMode?.(vimModeOf(view) ?? "");
  }

  /** 构造扩展集(建视图与换文件时共用)。 */
  function buildExtensions(): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter(),
      history(),
      drawSelection(),
      highlightSelectionMatches(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(tabSize),
      indentUnit.of(indentUnitText),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      search({ top: true }),
      codeHighlighting(),
      autocompletion({ override: [lspCompletion], activateOnTyping: true }),
      lspHoverTooltip,
      lspDiagnosticsLinter,
      keymap.of([
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      languageCompartment.of([]),
      vimCompartment.of([]),
      wrapCompartment.of(codeWrap ? EditorView.lineWrapping : []),
      typewriterCompartment.of(typewriter ? typewriterExtension(typewriterPosition) : []),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily:
            "var(--code-font, ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace)",
          fontSize: "var(--code-font-size, 12.5px)",
          lineHeight: "1.55",
        },
        "&.cm-focused": { outline: "none" },
        ".cm-gutters": {
          backgroundColor: "transparent",
          color: "var(--text-faint, #67676d)",
          border: "none",
        },
        ".cm-content": { caretColor: "var(--accent, #f5a83c)" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent, #f5a83c)" },
        ".cm-activeLine": { backgroundColor: "var(--code-active-line, rgba(127,127,127,0.08))" },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: "var(--code-selection, rgba(127,127,127,0.22))",
        },
      }),
      EditorView.contentAttributes.of({
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        autocomplete: "off",
      }),
      EditorView.updateListener.of((u) => {
        const handle = handleRef.current;
        if (u.docChanged) {
          if (handle) {
            const text = u.state.doc.toString();
            useCodeStore.getState().updateContent(handle.path, text);
            statesRef.current.set(handle.path, u.state);
            // 语言服务器只认自己手上那份内容:改了就得推给它,否则补全与
            // 跳转用的还是旧文本。防抖 300ms——每击都推会把服务器淹掉。
            const state = useCodeStore.getState();
            if (state.lspStates[handle.language] === "running") {
              const timers = syncTimersRef.current;
              const pending = timers.get(handle.path);
              if (pending) clearTimeout(pending.timer);
              timers.set(handle.path, {
                root: handle.root,
                text,
                timer: setTimeout(() => {
                  timers.delete(handle.path);
                  void codeApi.lspSync(handle.root, handle.path, text).catch(() => {});
                }, 300),
              });
            }
          }
        }
        if (u.selectionSet || u.docChanged) {
          // 光标也算「这份文件的状态」:只存 docChanged 的版本,切走再切回来
          // 会回到上次敲字那一刻的光标(甚至文首),「我上次读到哪」就丢了。
          if (handle) statesRef.current.set(handle.path, u.state);
          const pos = u.state.selection.main.head;
          const line = u.state.doc.lineAt(pos);
          onCursor?.(line.number, pos - line.from + 1);
          const mode = vimModeOf(u.view);
          if (mode) onMode?.(mode);
        }
      }),
    ];
  }

  // ---- 换文件:把该文件的 state 换进视图 ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const root = useCodeStore.getState().project?.root ?? "";
    const language = file.languageId;
    const handle = { root, path: file.path, language, view };
    handleRef.current = handle;
    registerCodeEditor(handle);

    let state = statesRef.current.get(file.path);
    if (!state) {
      state = EditorState.create({
        doc: file.content,
        extensions: buildExtensions(),
      });
      statesRef.current.set(file.path, state);
    }
    view.setState(state);
    // setState 已经把该文件上次的光标与选区一起换回来了。不要再 dispatch
    // `anchor: 0`——那样每切一次标签光标都跳回文首,缓存的 EditorState 只
    // 保住了撤销栈,却把「我上次读到哪」丢了。状态条也跟着刷一次。
    reportCursor(view);

    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      unregisterCodeEditor(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  // ---- 关掉的标签:把它的 EditorState 从缓存里删掉 ----
  //
  // 不删的话,一个长会话开过的每个文件都留一份完整文档 + 撤销栈。缓存只在
  // 标签还开着时有用(关掉的标签下次打开就是重新读盘)。
  //
  // 待推给语言服务器的内容也要一起丢掉:关标签时 store 已经发了 didClose,
  // 一个 300ms 后才到的 didChange 会在服务器那边把文档又「打开」一次。
  //
  // 订阅里先比 tabs 的引用:store 每敲一个键都会通知,不能每个键都建一次 Set。
  useEffect(() => {
    let lastTabs = useCodeStore.getState().tabs;
    return useCodeStore.subscribe((s) => {
      if (s.tabs === lastTabs) return;
      lastTabs = s.tabs;
      const open = new Set(s.tabs);
      for (const path of [...statesRef.current.keys()]) {
        if (!open.has(path)) statesRef.current.delete(path);
      }
      for (const [path, pending] of [...syncTimersRef.current]) {
        if (open.has(path)) continue;
        clearTimeout(pending.timer);
        syncTimersRef.current.delete(path);
      }
    });
  }, []);

  // ---- 语法包:按 languageId 动态载入 ----
  //
  // 依赖里带 file.path:两个文件是**同一种语言**时(两个 .rs),只盯
  // languageId 不会重跑,新文件的状态就停在「没有语法包」——高亮整个不见。
  // 依赖 path 保证每次换文件都重新配一次;已经载入过的语言是同步可用的,
  // 不会闪一下无色。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const desc = findLanguage(file.languageId);
    const apply = (support: Extension) => {
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    };
    if (!desc) {
      apply([]);
      return;
    }
    if (desc.support) {
      apply(desc.support);
      return;
    }
    let cancelled = false;
    desc
      .load()
      .then((support) => {
        if (!cancelled) apply(support);
      })
      .catch(() => {
        if (!cancelled) apply([]);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, file.languageId]);

  // ---- vim 开关 ----
  //
  // 依赖里带 file.path:换文件会换一份新的 EditorState,新状态的 vim 隔层
  // 是空的(见 buildExtensions)。不跟着重配一次,vim 就在换文件后悄悄失效。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: vimCompartment.reconfigure(
        codeVim
          ? [vimModeExtension(), vimKeyCaptureExtension(), vimActiveLine(), vimVisualHighlight()]
          : [],
      ),
    });
    if (!codeVim) onMode?.("");
  }, [codeVim, file.path, onMode]);

  // ---- 折行开关 ----
  //
  // 同样依赖 file.path:换文件换一份新 state,折行是每个 state 自己的扩展。
  // 用隔层重配而不是重建视图——切折行不该把撤销栈和光标一起丢掉。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.reconfigure(codeWrap ? EditorView.lineWrapping : []),
    });
  }, [codeWrap, file.path]);

  // ---- 打字机模式 ----
  //
  // 与笔记区同一个模型(编辑器/typewriter.ts):光标行停在视口固定比例处,
  // 上下留白由同一个比例推出(--typewriter-top / --typewriter-bottom 写在
  // scrollDOM 上,正文内边距在 CSS 里读它)。位置改了要重建插件,所以位置
  // 也在依赖里;换文件后同样要重配一次——隔层跟着 EditorState 走。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: typewriterCompartment.reconfigure(
        typewriter ? typewriterExtension(typewriterPosition) : [],
      ),
    });
  }, [typewriter, typewriterPosition, file.path]);

  // ---- 外部改动:整篇换掉(重命名后重读盘) ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === content) return;
    const cursor = Math.min(view.state.selection.main.head, content.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: cursor },
    });
    statesRef.current.set(file.path, view.state);
  }, [content, file.path]);

  // ---- 跳转请求:把光标落到目标位置 ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jump || jump.path !== file.path) return;
    const line = jump.position.line + 1;
    if (line < 1 || line > view.state.doc.lines) {
      useCodeStore.getState().clearJump();
      return;
    }
    const target = view.state.doc.line(line);
    const offset = Math.min(target.from + jump.position.character, target.to);
    view.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: "center" }),
    });
    view.focus();
    useCodeStore.getState().clearJump();
  }, [file.path, jump]);

  // ---- 焦点:进入编辑器就把命令目标切到它 ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const onFocus = () => {
      if (handleRef.current) setActiveCodeEditor(handleRef.current);
    };
    view.dom.addEventListener("focusin", onFocus);
    return () => view.dom.removeEventListener("focusin", onFocus);
  }, []);

  return <div className="code-editor-host" ref={hostRef} />;
}

/** vim 模式名(NORMAL / INSERT / VISUAL);vim 没开时返回 null。 */
function vimModeOf(view: EditorView): string | null {
  const cm = getCM(view);
  const vim = cm?.state?.vim as
    | { insertMode?: boolean; visualMode?: boolean }
    | undefined;
  if (!vim) return null;
  if (vim.visualMode) return "VISUAL";
  if (vim.insertMode) return "INSERT";
  return "NORMAL";
}
