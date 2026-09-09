import { EditorView } from "@codemirror/view";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { insertNewlineAndIndent, redo, undo } from "@codemirror/commands";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import "katex/dist/katex.min.css";
import "@/styles/global.css";
import { createEditor, loadDocument, reconfigureTypewriter, reconfigureVim } from "@/editor/setup";
import { editorApi } from "@/editor/api";
import { adjustHeadingLevel, enterContinueListItem, jumpHeaderTodos, toggleHeadingAny, toggleList, toggleTodo } from "@/editor/ops";
import { renumberHeadings } from "@/editor/numbering";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { currentVimMode } from "@/editor/vim/vim";
import { useAppStore } from "@/state/appStore";

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
    /** 当前 vim 模式；vim 未安装（compartment 清空）时为 null。 */
    __vimMode: () => string | null;
    /** 按设置开启/关闭 vim（与真实设置路径一致）。 */
    __setVim: (on: boolean) => void;
  }
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
window.__vimMode = () => currentVimMode(view);
window.__setVim = (on) => {
  useAppStore.getState().patchSettings({ vim: on });
  reconfigureVim(view, on, []);
};
