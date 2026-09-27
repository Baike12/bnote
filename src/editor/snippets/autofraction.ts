import type { EditorState } from "@codemirror/state";
import { getContextAt, mathRegions } from "../context";
import { findMatchingBracket, withinEnv } from "./brackets";
import { parseReplacement, type ParsedReplacement } from "./engine";

/**
 * latex-suite 的 auto-fraction:数学态内键入 `/` 时,把光标前的表达式扩成
 * `\frac{分子}{}`。移植自用户 Obsidian 插件(latex-suite 魔改版)捆绑的
 * src/features/autofraction.ts,语义逐条对应:
 *
 * - 分子起点反向扫描:停在空格/括号开符/换行/断字符(`+-=` 及 Tab)上;
 *   `) ] }` 先跳到配对开符再看是否停止——`\frac{a}{b}/` 的分子是整个
 *   `\frac{a}{b}`;
 * - 断字符在表达式里截断:`a+b/c` → `a+\frac{b}{c}`;
 * - 希腊字母命令后的空格不是边界:`\alpha x/` → `\frac{\alpha x}{}`;
 * - 分子整体是圆括号组时剥掉外层括号:`(a+b)/` → `\frac{a+b}{}`;
 * - `^{…}`、`\pu{…}` 内不展开(指数里的分数保持字面);
 * - `\text{…}` 内不展开,光标不在数学态也不展开。
 *
 * bnote 的时序与 latex-suite 不同:latex-suite 在按键上拦截 `/`(文档里没有
 * 它),这里 `/` 已由输入路径插入、光标停在其后——所以扫描从 cursor-2 开始,
 * 展开区间连同这个 `/` 一起被替换。
 */

const BREAKING_CHARS = "+-=\t";
const STOP_CHARS = " $([{\n" + BREAKING_CHARS;
const EXCLUDED_ENVS: [string, string][] = [
  ["^{", "}"],
  ["\\pu{", "}"],
];

// 与 latex-suite 相同的希腊字母表(缺 Yi/Psi 等罕见项,以原表为准)。
const GREEK =
  "alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|omicron|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|Upsilon|varphi|phi|Phi|chi|psi|Psi|omega|Omega";
/** 希腊字母命令后的空格临时换成 #(等长替换),扫描就不会在命令中间停下。 */
const GREEK_SPACE = new RegExp(`(${GREEK}) ([^ ])`, "g");

export interface AutoFractionResult {
  /** 替换区间(含光标前的 `/`)。 */
  start: number;
  end: number;
  replacement: ParsedReplacement;
}

/** 判定 `/` 是否应扩成分数;返回 null 表示不适用,`/` 保持字面。 */
export function autoFraction(
  state: EditorState,
  cursor: number,
  visualText: string | null,
): AutoFractionResult | null {
  const region = mathRegions(state).find((r) => cursor >= r.from && cursor <= r.to);
  if (!region) return null;
  const ctx = getContextAt(state, cursor);
  if (ctx.textEnv || !(ctx.inlineMath || ctx.blockMath)) return null;

  const contentStart = region.from + (region.display ? 2 : 1);
  const to = cursor;

  // 排除环境:^{…}、\pu{…} 内的 / 保持字面(指数里扩分数会破坏语义)。
  const content = state.sliceDoc(contentStart, region.to);
  const relCursor = to - contentStart;
  for (const [open, close] of EXCLUDED_ENVS) {
    if (withinEnv(content, relCursor, open, close)) return null;
  }

  // 选中文本即分子:"/" 刚替换了选区,占位在 cursor-1。
  if (visualText !== null) {
    return build(to - 1, to, visualText);
  }

  const scanned = state
    .sliceDoc(contentStart, to - 1)
    .replace(GREEK_SPACE, "$1#$2");
  let start = 0; // 相对 contentStart
  for (let i = scanned.length - 1; i >= 0; i--) {
    const ch = scanned[i];
    if (ch === ")" || ch === "]" || ch === "}") {
      const open = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      const j = findMatchingBracket(scanned, i, open, ch, true);
      if (j === -1) return null;
      i = j;
      if (i < 0) break; // 组开在区域之外:分子从区域头算
    }
    if (STOP_CHARS.includes(ch)) {
      start = i + 1;
      break;
    }
  }
  if (start >= scanned.length) return null; // 空分子
  const numeratorStart = contentStart + start;
  const numerator = state.sliceDoc(numeratorStart, to - 1);
  return build(numeratorStart, to, numerator);
}

function build(start: number, end: number, numerator: string) {
  let inner = numerator;
  if (inner[0] === "(" && inner[inner.length - 1] === ")") {
    const closing = findMatchingBracket(inner, 0, "(", ")", false);
    if (closing === inner.length - 1) inner = inner.slice(1, -1);
  }
  return {
    start,
    end,
    replacement: parseReplacement(`\\frac{${inner}}{$0}$1`, [], null),
  };
}
