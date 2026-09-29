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
  const env = matrixEnvAt(view.state, range.from);
  if (!env) return false;
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
  // align 是对齐环境,不是数据表格:行分隔还按矩阵插 ` \\` 会让等号永远对不齐
  // (对齐点 `&` 要人手补)。对齐环境的 Enter 走 alignEnter——只接管"能接手的
  // 行"(非空、非 begin/end、行尾尚无 `\\`),其余行交回默认换行。
  if (env === "align") return alignEnter(view);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: MATRIX_ROW_BREAK },
    userEvent: "input.matrix-row",
    scrollIntoView: true,
  });
  return true;
}

/**
 * align 续行的纯决策(导出供门禁):光标前的行文本 → 该前半的替换文本
 * (行尾含 ` \\` 与换行),null = 不接管(光标在行首、`\begin`/`\end` 行、
 * 前半行尾已有 `\\`——这些情况按回车就是普通换行,补 ` \\` 反而弄脏渲染)。
 *
 * 接管时的两处补全,对齐用户手写 align 的形状(`a &= b \\`):
 * - 前半没有 `&`:第一个裸关系符(`=` / `<=` / `>=`)前补 `&` 作对齐点;
 *   已有 `&` 时尊重用户自己选的对齐点,不再插。
 * - 前半行尾补 ` \\`(LaTeX 行分隔符)。
 *
 * 以光标为断点(与普通换行同语义):替换 [行首, 光标],光标后的文本自然
 * 成为新行——`\end{align}` 永远不会被吞进补全的行里。
 */
export function alignEnterPlan(headText: string): string | null {
  if (headText.trim() === "") return null;
  if (/^\s*\\(begin|end)\{/.test(headText)) return null;
  if (/\\{2}\s*$/.test(headText)) return null;
  let out = headText;
  if (!out.includes("&")) {
    const m = /(^|[^\\])([<>]?=)/.exec(out);
    if (m) {
      const at = m.index + m[1].length;
      out = `${out.slice(0, at)}&${out.slice(at)}`;
    }
  }
  // 行分隔与矩阵同源(MATRIX_ROW_BREAK = ` \\` + 换行),转义只写一处。
  return `${out}${MATRIX_ROW_BREAK}`;
}

/** align 环境内的 Enter(空选区):补全光标前半行并换行,光标落新行行首。
 *  仅由 matrixEnter 在已判定 align 环境后调用。 */
function alignEnter(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const line = view.state.doc.lineAt(range.head);
  const headText = line.text.slice(0, range.head - line.from);
  const plan = alignEnterPlan(headText);
  if (plan === null) return false;
  view.dispatch({
    changes: { from: line.from, to: range.head, insert: plan },
    selection: EditorSelection.cursor(line.from + plan.length),
    userEvent: "input.align-row",
    scrollIntoView: true,
  });
  return true;
}
