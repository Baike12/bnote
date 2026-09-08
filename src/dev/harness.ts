import { EditorView } from "@codemirror/view";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { insertNewlineAndIndent } from "@codemirror/commands";
import "katex/dist/katex.min.css";
import "@/styles/global.css";
import { createEditor, reconfigureTypewriter, reconfigureVim } from "@/editor/setup";
import { adjustHeadingLevel, enterContinueListItem, toggleHeadingAny, toggleTodo } from "@/editor/ops";
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
    __headingTab: (delta: 1 | -1) => boolean;
    __setTypewriter: (on: boolean) => void;
    __enterAt: (
      text: string,
      line: number,
      col: number,
    ) => { which: string; after: string };
  }
}

const view = createEditor(document.getElementById("editor-host")!, DOC, {
  onDocChanged: () => {},
  onCursorMoved: () => {},
});
reconfigureVim(view, true, []);
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
window.__headingTab = (delta) => adjustHeadingLevel(view, delta);
window.__setTypewriter = (on) => {
  useAppStore.getState().patchSettings({ typewriter: on });
  reconfigureTypewriter(view, on);
};
// Enter 键真实键序（bnote 列表续行 → lang-markdown 续行 → defaultKeymap），用于调试续行行为。
window.__enterAt = (text, line, col) => {
  window.__loadDoc(text);
  const l = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: col < 0 ? l.to : Math.min(l.from + col, l.to) } });
  const which = enterContinueListItem(view)
    ? "bnote"
    : insertNewlineContinueMarkup(view)
      ? "md"
      : (insertNewlineAndIndent(view), "default");
  return { which, after: view.state.doc.toString() };
};
