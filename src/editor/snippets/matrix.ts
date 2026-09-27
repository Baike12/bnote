import { EditorSelection } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getContextAt, mathRegions } from "../context";
import { withinEnv } from "./brackets";
import { latexConfig } from "./config";

/**
 * latex-suite 的 matrixShortcuts:矩阵环境里 **Shift+Tab** 补 ` & `(对齐下一列)、
 * Enter 补 ` \\` 换行(Shift+Enter 只把光标送到下一行行尾,不动文档)。语义
 * 对齐插件 runmatrixshortcuts:
 *
 * - 只在**块级公式**里生效(inline math 不触发);
 * - 环境靠 `\begin{名字}` 配对判定,名字取自设置(默认 pmatrix/cases/align/
 *   bmatrix/Bmatrix/vmatrix/Vmatrix/array/matrix);
 * - 插件里 `&`/`\\`/Backspace 没有独立处理,"空矩阵自动清理"和"列对齐重排"
 *   也都不存在(逐处 grep 确认过),所以这里同样不做。
 *
 * **分隔符挂在 Shift+Tab 上**是插件作者改的(handleKeydown 里那句
 * `// Shift+Tab 时输入 &，普通 Tab 让给 tabout`):普通 Tab 留给 tabout,
 * `&` 只能由 Shift+Tab 触发。照抄这个分工——否则矩阵里 Tab 永远走不到
 * "跳出括号"那一层,括号嵌套时 Tab 只会往公式里插 ` & `。
 */

/** 矩阵行分隔:空格 + LaTeX 的 `\\` + 换行。iden 片段与这里共用同一条
 *  常量——转义层数写错一处,矩阵就渲染错。 */
export const MATRIX_ROW_BREAK = String.raw` \\` + "\n";

/** 光标所在位置的矩阵环境名;不在任何矩阵环境里(或不在块级公式里)返回 null。 */
export function matrixEnvAt(state: EditorState, pos: number): string | null {
  const ctx = getContextAt(state, pos);
  if (!ctx.blockMath) return null;
  const region = mathRegions(state).find((r) => pos >= r.from && pos <= r.to);
  if (!region) return null;
  const content = state.doc.sliceString(region.from, region.to);
  const rel = pos - region.from;
  for (const env of latexConfig().matrixEnvs) {
    if (withinEnv(content, rel, `\\begin{${env}}`, `\\end{${env}}`)) return env;
  }
  return null;
}

/** 矩阵列分隔:插入 ` & `(替换选区)。不在矩阵环境里返回 false,交回后续处理。 */
export function matrixSeparator(view: EditorView): boolean {
  if (!latexConfig().matrixShortcuts) return false;
  const range = view.state.selection.main;
  if (!matrixEnvAt(view.state, range.from)) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: " & " },
    userEvent: "input.matrix-tab",
    scrollIntoView: true,
  });
  return true;
}

/** Enter:插入 ` \\` 换行;Shift+Enter 移到下一行行尾(空文档末行则不动)。 */
export function matrixEnter(view: EditorView, shift = false): boolean {
  if (!latexConfig().matrixShortcuts) return false;
  const range = view.state.selection.main;
  if (!matrixEnvAt(view.state, range.from)) return false;
  if (shift) {
    const line = view.state.doc.lineAt(range.to);
    if (line.number >= view.state.doc.lines) return false;
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.line(line.number + 1).to),
      userEvent: "select.matrix-next-row",
      scrollIntoView: true,
    });
    return true;
  }
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: MATRIX_ROW_BREAK },
    userEvent: "input.matrix-row",
    scrollIntoView: true,
  });
  return true;
}
