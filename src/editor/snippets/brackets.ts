import { Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { mathRegions } from "../context";
import { latexConfig } from "./config";

/**
 * 括号相关的全部几何:配对查找、彩色配对、光标括号高亮。语义逐条对齐
 * obsidian-latex-suite(函数名与插件同名,便于对照):
 *
 * - 配对查找是**字面计数**扫描,不跳转义——插件的 findMatchingBracket 就是
 *   slice 比较后计数,`\{` 里的 `{` 照样参与计数(所以 `\{`/`\}` 在彩色配对里
 *   也会被染色,与插件一致)。
 * - 彩色配对固定 3 色(插件 Ncolors = 3):一对括号闭合时按**弹出后**的栈深
 *   取色,于是最外层永远是 0 号色、逐层轮转。只染色这一个字符。
 * - 光标括号高亮只看光标处与光标前一个字符;都不在括号上且选区为空时,
 *   再退一步找**最内层包围括号**(getEnclosingBracketsPos)。
 */

/** 单字符括号表(插件 getOpenBracket / getCloseBracket 只有这三种)。 */
const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
export function getOpenBracket(close: string): string {
  return OPEN_OF[close];
}

const CLOSE_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
export function getCloseBracket(open: string): string {
  return CLOSE_OF[open];
}

const OPEN_BRACKETS = ["{", "[", "("];
const ALL_BRACKETS = ["{", "[", "(", "}", "]", ")"];

/**
 * 从 `from` 起找 `open` 的配对 `close`。按字面比较计数(与插件同款,不跳转义),
 * `stop` 为扫描右界;找不到返回 -1。`backwards` 时从 `from` 向左找配对的开括号
 * ——只用于单字符括号(彩色/高亮/包围括号三处都是)。
 */
export function findMatchingBracket(
  text: string,
  from: number,
  open: string,
  close: string,
  backwards = false,
  stop = text.length,
): number {
  if (backwards) {
    let depth = 0;
    for (let i = from; i >= 0; i--) {
      if (text.startsWith(close, i)) depth++;
      else if (text.startsWith(open, i) && --depth === 0) return i;
    }
    return -1;
  }
  let depth = 0;
  for (let i = from; i < stop; i++) {
    if (text.startsWith(open, i)) depth++;
    else if (text.startsWith(close, i)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 最内层包围 `pos` 的括号对(相对坐标);找不到返回 null。 */
export function enclosingBrackets(
  text: string,
  pos: number,
): { left: number; right: number } | null {
  let i = Math.min(pos - 1, text.length - 1);
  while (i >= 0) {
    const ch = text.charAt(i);
    if (ALL_BRACKETS.includes(ch)) {
      if (OPEN_OF[ch] !== undefined) {
        // 闭括号:连同它的开括号整组跳过(这组结束于 i < pos,不可能包围 pos)
        const j = findMatchingBracket(text, i, OPEN_OF[ch], ch, true);
        if (j === -1) return null;
        i = j - 1;
        continue;
      }
      const j = findMatchingBracket(text, i, ch, getCloseBracket(ch), false);
      if (j >= pos) return { left: i, right: j };
    }
    i--;
  }
  return null;
}

/**
 * `pos` 是否严格处于 `openSymbol`…`closeSymbol` 环境内。两种形态(对齐插件
 * isWithinEnvironment):
 * - **单括号环境**(`\pu{`、`^{`):开符以 `{`/`[`/`(` 结尾、闭符就是它对应的
 *   右括号,于是从 `lastIndexOf` 到的那个左括号本身起数配对;
 * - **多字符环境**(`\begin{pmatrix}`…`\end{pmatrix}`):首尾各是一个完整的命令,
 *   按整串计数配对。
 * 同名环境可能嵌套出现,逐个候选往前找,找到真正包住 pos 的那个。
 */
export function withinEnv(
  text: string,
  pos: number,
  openSymbol: string,
  closeSymbol: string,
): boolean {
  const trailing = openSymbol.slice(-1);
  const singleBracket =
    (trailing === "{" || trailing === "[" || trailing === "(") &&
    closeSymbol === getCloseBracket(trailing);
  // 定位一律搜**完整开符**(搜孤零零的 `{` 会命中普通花括号,把 `\pu{` 之外
  // 的位置也算进环境);只有配对扫描要从开括号本身起数,故单括号形态跳 offset。
  const matchOpen = singleBracket ? trailing : openSymbol;
  const offset = singleBracket ? openSymbol.length - 1 : 0;
  let left = text.lastIndexOf(openSymbol, pos - 1);
  while (left !== -1) {
    const right = findMatchingBracket(text, left + offset, matchOpen, closeSymbol, false);
    if (right === -1) return false;
    if (right >= pos && pos >= left + openSymbol.length) return true;
    if (left <= 0) return false;
    left = text.lastIndexOf(openSymbol, left - 1);
  }
  return false;
}

/** 括号字符的装饰(只覆盖这一个字符,与插件 getHighlightBracketMark 一致)。 */
function markAt(pos: number, className: string) {
  return Decoration.mark({ inclusive: true, class: className }).range(pos, pos + 1);
}

/** 彩色配对:按嵌套深度轮转 3 色(最外层 0 号色)。
 *  几何只来自文档 + 视口范围，**与选区无关**——插件因此不在 selectionSet
 *  上重建（见 bracketColorPlugin.update）。导出供门禁锁这条不变量。 */
export function buildBracketColors(view: { state: EditorState; visibleRanges: readonly { from: number; to: number }[] }): DecorationSet {
  const out: ReturnType<typeof markAt>[] = [];
  const doc = view.state.doc;
  for (const range of view.visibleRanges) {
    for (const region of mathRegions(view.state)) {
      if (region.to < range.from || region.from > range.to) continue;
      const text = doc.sliceString(region.from, region.to);
      const stack: string[] = [];
      const posStack: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (OPEN_BRACKETS.includes(ch)) {
          stack.push(ch);
          posStack.push(i);
        } else if (ALL_BRACKETS.includes(ch)) {
          if (getCloseBracket(stack[stack.length - 1]) !== ch) continue; // 类型不匹配:忽略
          stack.pop();
          const openPos = posStack.pop()!;
          const depth = stack.length % 3;
          out.push(markAt(openPos + region.from, `cw-bracket-${depth}`));
          out.push(markAt(i + region.from, `cw-bracket-${depth}`));
        }
      }
    }
  }
  return Decoration.set(out, true);
}

/** 光标处括号与配对括号高亮。导出供门禁锁几何（无 DOM 的假视图）。 */
export function buildCursorBrackets(view: { state: EditorState }): DecorationSet {
  const selection = view.state.selection;
  const doc = view.state.doc;
  const head = selection.main.to;
  const region = mathRegions(view.state).find((r) => head >= r.from && head <= r.to);
  if (!region) return Decoration.none;
  const eqn = doc.sliceString(region.from, region.to);
  /** 光标处只可能看两个字符（range.to 与它前一个），别为此把整篇文档
   *  toString()——本函数在**每次选区变化**都跑，全文拷贝是纯浪费。 */
  const charAt = (pos: number) => (pos < 0 || pos >= doc.length ? "" : doc.sliceString(pos, pos + 1));
  const out: ReturnType<typeof markAt>[] = [];
  let done = false;
  for (const range of selection.ranges) {
    // 光标处、光标前一个字符(与插件同:i 从 range.to 退到 range.from - 1)。
    for (let i = range.to; i > range.from - 2; i--) {
      const ch = charAt(i);
      if (!ALL_BRACKETS.includes(ch)) continue;
      const isOpen = OPEN_BRACKETS.includes(ch);
      const open = isOpen ? ch : getOpenBracket(ch);
      const close = isOpen ? getCloseBracket(ch) : ch;
      const j = findMatchingBracket(eqn, i - region.from, open, close, !isOpen);
      if (j === -1) continue;
      out.push(markAt(i, "cw-bracket-match"));
      out.push(markAt(j + region.from, "cw-bracket-match"));
      done = true;
      break;
    }
    if (done) break;
    if (!range.empty) continue;
    const enc = enclosingBrackets(eqn, range.from - 1 - region.from);
    if (!enc) continue;
    out.push(markAt(enc.left + region.from, "cw-bracket-match"));
    out.push(markAt(enc.right + region.from, "cw-bracket-match"));
    done = true;
    break;
  }
  return Decoration.set(out, true);
}

/** 彩色配对插件。开关变化本身不一定伴随文档/选区变化(设置面板里点一下),
 *  所以把上次的开关值记下来一起比较,点开关立刻重画。 */
const bracketColorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    enabled = latexConfig().bracketColors;

    constructor(view: EditorView) {
      this.decorations = this.enabled ? buildBracketColors(view) : Decoration.none;
    }

    update(u: ViewUpdate) {
      const on = latexConfig().bracketColors;
      // 彩色配对的几何只来自文档 + 视口（buildBracketColors 不读选区），
      // 选区变化不会改它一个装饰：选中/移动光标不该重建整片括号色。
      if (on === this.enabled && !u.docChanged && !u.viewportChanged) return;
      this.enabled = on;
      this.decorations = on ? buildBracketColors(u.view) : Decoration.none;
    }
  },
  { decorations: (v) => v.decorations },
);

/** 光标括号高亮插件。 */
const cursorBracketPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    enabled = latexConfig().highlightCursorBrackets;

    constructor(view: EditorView) {
      this.decorations = this.enabled ? buildCursorBrackets(view) : Decoration.none;
    }

    update(u: ViewUpdate) {
      const on = latexConfig().highlightCursorBrackets;
      if (on === this.enabled && !u.docChanged && !u.viewportChanged && !u.selectionSet) return;
      this.enabled = on;
      this.decorations = on ? buildCursorBrackets(u.view) : Decoration.none;
    }
  },
  { decorations: (v) => v.decorations },
);

export function bracketPlugins() {
  return [bracketColorPlugin, cursorBracketPlugin];
}
