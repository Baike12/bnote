import type { EditorView } from "@codemirror/view";
import { mathRegions } from "../context";
import { findMatchingBracket } from "./brackets";
import { latexConfig } from "./config";

/**
 * latex-suite 的 autoEnlargeBrackets:括号里出现 `\sum`/`\frac` 这类"大个子"时,
 * 把 `( … )` 升级成 `\left( … \right)`,免去手写。语义逐条对齐插件:
 *
 * - 触发时机不是"打括号",而是**一次片段展开或自动分数之后**:插入的文本里
 *   出现某个触发词(子串匹配 `\` + 词)就整段方程扫一遍。自动分数必然含
 *   `\frac`,所以它总是触发。
 * - 写进方程的是 `\left(` + 空格 与 空格 + `\right)`,两侧各留一个空格。
 * - 括号内容里没有触发词时整对跳过(不深入内层);**有触发词时只前进一格**,
 *   于是嵌套的内层括号也会被各自放大。
 * - 已经是 `\left…\right` 的跳过,不重复加。
 */

const LEFT = "\\left";
const RIGHT = "\\right";

/** 插件的八种开括号(键序照抄:先匹配者胜)。 */
const BRACKET_PAIRS: [string, string][] = [
  ["(", ")"],
  ["[", "]"],
  ["\\{", "\\}"],
  ["\\langle", "\\rangle"],
  ["\\lvert", "\\rvert"],
  ["\\lVert", "\\rVert"],
  ["\\lceil", "\\rceil"],
  ["\\lfloor", "\\rfloor"],
];

export interface BracketEdit {
  from: number;
  to: number;
  insert: string;
}

/** 纯函数:在 `[start, end)` 这段方程文本里找出该放大的括号对,返回插入编辑
 *  (绝对坐标,已排序)。找不到返回空数组。 */
export function enlargeBracketEdits(
  text: string,
  start: number,
  end: number,
  triggers: string[],
): BracketEdit[] {
  const out: BracketEdit[] = [];
  for (let i = start; i < end; i++) {
    const pair = BRACKET_PAIRS.find(([open]) => text.startsWith(open, i));
    if (!pair) continue;
    const [open, close] = pair;
    const j = findMatchingBracket(text, i, open, close, false, end);
    if (j === -1) continue;
    const alreadyEnlarged =
      text.slice(i - LEFT.length, i) === LEFT && text.slice(j - RIGHT.length, j) === RIGHT;
    if (alreadyEnlarged) continue;
    const contents = text.slice(i + 1, j);
    if (!triggers.some((word) => contents.includes("\\" + word))) {
      i = j; // 这对里没有大个子:整对跳过,不看内层
      continue;
    }
    out.push({ from: i, to: i + open.length, insert: LEFT + open + " " });
    out.push({ from: j, to: j + open.length, insert: " " + RIGHT + close });
  }
  return out;
}

/** 片段展开后按需放大括号;返回是否真的改了文档。 */
export function autoEnlargeBrackets(view: EditorView, inserted: string): boolean {
  const cfg = latexConfig();
  if (!cfg.autoEnlargeBrackets) return false;
  if (!cfg.autoEnlargeTriggers.some((word) => inserted.includes("\\" + word))) return false;
  const head = view.state.selection.main.head;
  const region = mathRegions(view.state).find((r) => head >= r.from && head <= r.to);
  if (!region) return false;
  const edits = enlargeBracketEdits(
    view.state.doc.toString(),
    region.from,
    region.to,
    cfg.autoEnlargeTriggers,
  );
  if (edits.length === 0) return false;
  view.dispatch({ changes: edits, userEvent: "input.snippet-enlarge" });
  return true;
}
