import { EditorSelection } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getContextAt, mathRegions } from "../context";
import { latexConfig } from "./config";

/**
 * latex-suite 的 `tabout`:片段与制表位都走完之后,Tab 的最后一层是"把光标
 * 从括号里带出来"(插件 features/tabout.ts + handleKeydown 末尾那段)。语义
 * 逐条对齐:
 *
 * 1. 只在公式里生效(inline/block math);正文里的 Tab 仍是缩进;
 * 2. 从光标起、向后扫到**公式内容末尾**(不含闭合定界符),撞上 `}` `)` `]`
 *    `>` `|` `$` 里任意一个就跨过去一格 —— 括号层层嵌套时,一次 Tab 出一层;
 * 3. 一路扫到内容末尾都是空白(光标已在公式尾巴上)才算"整块跳出":行内公式
 *    落到闭合 `$` 之后;块级公式落到底部 `$$` 那行的**下一行行首**,并把光标
 *    原本那行的行尾空白修掉;底部 `$$` 已在末行时先补一个换行,否则没有"下一
 *    行"可落。
 *
 * 与插件的三处有意差异(都写在门禁里):
 * - 收尾只 trimEnd,**不** trim 行首:插件用 `line.text.trim()`,在列表项里会
 *   把公式内容行的缩进一起吃掉,而那是 markdown 结构的一部分;
 * - 插件派发完改动再用**旧坐标** setCursor(光标会偏掉被吃掉的字符数),这里
 *   按改动量把落点映射到新文档;
 * - `codeMath`(```math 围栏里的公式)不参与:bnote 没有 forceMathLanguages,
 *   围栏公式不进 mathRegions。
 */
const TARGET_CHARS = "})]>|$";

/** 多字符闭合符:插件只特判 `\rangle`(它不以单个可扫字符收尾)。 */
const RIGHT_ANGLE = "\\rangle";

export interface TaboutPlan {
  /** 事务之后光标的落点(新文档坐标)。 */
  pos: number;
  /** 事务里的文档改动(块级公式的收尾清理)。 */
  changes: { from: number; to: number; insert: string }[];
}

/** 公式内容的右端(不含闭合定界符):块级 `$$` 两个字符,行内 `$` 一个。 */
function contentEnd(region: { display: boolean; to: number }): number {
  return region.display ? region.to - 2 : region.to - 1;
}

/** 公式内容的左端(不含开定界符)。 */
function contentStart(region: { display: boolean; from: number }): number {
  return region.display ? region.from + 2 : region.from + 1;
}

/** 纯决策:该不该跳出、跳到哪、要改什么;没有可跳的位置返回 null。 */
export function planTabout(state: EditorState, pos: number): TaboutPlan | null {
  const ctx = getContextAt(state, pos);
  if (!ctx.inlineMath && !ctx.blockMath) return null;
  const region = mathRegions(state).find((r) => pos >= r.from && pos <= r.to);
  if (!region) return null;
  const end = contentEnd(region);
  // 光标压在定界符上(公式的开头/结尾那一两个 $):不是跳出场景。插件那边
  // 这类位置被树判成 math-begin/math-end,`inMath()` 同为 false。
  if (pos > end || pos < contentStart(region)) return null;

  // 只看光标到内容末尾这一段:Tab 是高频键,别为一次扫描把整篇文档拉成字符串。
  const seg = state.doc.sliceString(pos, end);
  for (let i = 0; i < seg.length; i++) {
    if (TARGET_CHARS.includes(seg.charAt(i))) return { pos: pos + i + 1, changes: [] };
    if (seg.startsWith(RIGHT_ANGLE, i)) {
      return { pos: pos + i + RIGHT_ANGLE.length, changes: [] };
    }
  }

  // 光标到内容末尾之间只剩空白:整块跳出
  if (seg.trim() !== "") return null;
  if (!region.display) return { pos: region.to, changes: [] };

  return blockExit(state, pos, end);
}

/** 块级公式的整块跳出:落到底部 `$$` 下一行行首,顺手清掉光标那行的行尾空白。 */
function blockExit(state: EditorState, pos: number, end: number): TaboutPlan {
  const doc = state.doc;
  const closing = doc.lineAt(end);
  const changes: TaboutPlan["changes"] = [];
  let target: number;
  if (closing.number === doc.lines) {
    // 底部 $$ 已在末行:补一个换行,才有"下一行"可落
    target = doc.length + 1;
    changes.push({ from: doc.length, to: doc.length, insert: "\n" });
  } else {
    target = doc.line(closing.number + 1).from;
  }

  const line = doc.lineAt(pos);
  const trimmed = line.text.trimEnd();
  if (trimmed !== line.text) {
    // 行尾空白在落点之前被吃掉,落点跟着左移(插件在这一点上按旧坐标落,会偏)
    if (line.to <= target) target += trimmed.length - line.text.length;
    changes.push({ from: line.from, to: line.to, insert: trimmed });
  }
  return { pos: target, changes };
}

/** Tab 的最后一层:跳出括号/公式块。 */
export function tabout(view: EditorView): boolean {
  if (!latexConfig().tabout) return false;
  const plan = planTabout(view.state, view.state.selection.main.to);
  if (!plan) return false;
  view.dispatch({
    changes: plan.changes,
    selection: EditorSelection.cursor(plan.pos),
    userEvent: "select.tabout",
    scrollIntoView: true,
  });
  return true;
}
