import type { EditorState, Text } from "@codemirror/state";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { scanMath, type MathRegion } from "./mathScan";

/** CommonMark 围栏标记：行首最多 3 个空格 + 至少 3 个 ` 或 ~。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 单遍扫描整篇文档，返回每行是否处于 ``` / ~~~ 围栏代码内（下标 = 行号-1；
 * 该行自身的围栏标记不影响它自己是否"在围栏内"）。语法树在文件刚载入时
 * 还是空的（后台解析未完成），树查询会把围栏/标题整体漏掉——凡是必须在
 * 那个窗口期内给出确定答案的逻辑（回车续行、标题重编号）都用这个兜底。
 */
export function fenceStateScan(doc: Text): boolean[] {
  const inside = new Array<boolean>(doc.lines);
  let open: string | null = null;
  let openLen = 0;
  for (let n = 1; n <= doc.lines; n++) {
    inside[n - 1] = open !== null;
    const m = FENCE_RE.exec(doc.line(n).text);
    if (!m) continue;
    if (open === null) {
      open = m[1][0];
      openLen = m[1].length;
    } else if (m[1][0] === open && m[1].length >= openLen && m[2].trim() === "") {
      open = null;
    }
  }
  return inside;
}

/** 第 lineNo 行是否处于围栏代码内（按该行之前的行做围栏状态扫描）。 */
export function insideFencedCodeByScan(doc: Text, lineNo: number): boolean {
  let open: string | null = null;
  let openLen = 0;
  for (let n = 1; n < lineNo; n++) {
    const m = FENCE_RE.exec(doc.line(n).text);
    if (!m) continue;
    if (open === null) {
      open = m[1][0];
      openLen = m[1].length;
    } else if (m[1][0] === open && m[1].length >= openLen && m[2].trim() === "") {
      open = null;
    }
  }
  return open !== null;
}

/**
 * 光标位置是否在围栏代码块内：树可用走树查询（FencedCode 节点，含围栏
 * 标记行自身），树还没就绪（文件刚载入，后台解析未完成）退回行扫描。
 * 所有「光标在不在代码块里」的判定都走这里，不许各处自建——围栏行自身
 * 两条路有已知差异（树算在内、扫描不算），只在 IME 这种低风险判定上可容忍。
 */
export function insideFencedCode(state: EditorState, pos: number): boolean {
  if (syntaxTreeAvailable(state, pos + 1)) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    for (; node; node = node.parent) {
      if (node.name === "FencedCode") return true;
    }
    return false;
  }
  return insideFencedCodeByScan(state.doc, state.doc.lineAt(pos).number);
}

export interface EditContext {
  /** Inside $…$ */
  inlineMath: boolean;
  /** Inside $$…$$ */
  blockMath: boolean;
  /** Inside \text{…} within math */
  textEnv: boolean;
  /** Inside inline code (`…`) or a fenced code block */
  code: boolean;
  /** Language of the enclosing fenced code block, if any */
  codeBlock: string | boolean;
  /** None of the above (plain markdown text) */
  isText: boolean;
}

const mathCache = new WeakMap<object, MathRegion[]>();

/** Math regions of the document, memoized per Text generation. */
export function mathRegions(state: EditorState): MathRegion[] {
  return mathRegionsForDoc(state.doc);
}

/** Doc 键版本:不持有 EditorState 的模块(callout 扫描)与装饰路径共享同一份
 *  备忘录,同一份文档的全文公式扫描每代只付一次。 */
export function mathRegionsForDoc(doc: Text): MathRegion[] {
  let regions = mathCache.get(doc);
  if (!regions) {
    regions = scanMath(doc);
    mathCache.set(doc, regions);
  }
  return regions;
}

/**
 * 光标是否停在公式**正文**上——也就是「下一个键入的字符会不会写进公式源码」。
 *
 * 位置语义(CM6 里 position 是字符之间):`from` 是开定界符之前、`to` 是闭合
 * 定界符之后,两点都落在**正文侧**——在那里打字,字符落在公式外面。所以闭合
 * 区域只认严格内部;未闭合区域(unclosed:只有一个 `$$`、还在打字)没有闭合
 * 符,`to` 就是正文末尾,那里打字仍写进公式。
 *
 * 这是「打字意图」的唯一判定:输入法按它决定英文/中文源(公式是 ASCII),
 * 行内公式的源码展开也按它(光标在边界上=公式已渲染、光标在 widget 之外,
 * 再展源码就会把光标夹在源码与预览之间)。**块级**公式的活动规则是另一回事:
 * 整行 block widget 覆盖边界位置所在的行,收起时会把光标画到自己那一行之外,
 * 见 livePreview 的 active()。
 */
export function caretInMathBody(region: MathRegion, pos: number): boolean {
  return pos > region.from && (pos < region.to || region.unclosed === true);
}

/**
 * 选区是否压在公式正文上:空选区按光标判定,非空选区与正文相交即算
 * (用户正在选中公式文本,要能看见自己选了什么)。
 */
export function selectionInMathBody(region: MathRegion, from: number, to: number): boolean {
  if (from === to) return caretInMathBody(region, from);
  const bodyEnd = region.unclosed === true ? region.to : region.to - 1;
  return from <= bodyEnd && to >= region.from + 1;
}

/** 公式正文的位置区间,夹进定界符之内(点击渲染态公式时落进正文用)。
 *  闭合区域去掉两侧定界符;未闭合区域的 `to` 本身就是正文末尾。 */
export function mathBodySpan(region: MathRegion): { from: number; to: number } {
  const open = region.display ? region.from + 2 : region.from + 1;
  const close = region.unclosed === true ? region.to : region.to - (region.display ? 2 : 1);
  return { from: open, to: Math.max(open, close) };
}

/**
 * 行内节点的分隔符是否落在公式里——公式内容不是 markdown。
 *
 * lezer 不认识 `$$…$$` / `$…$`,公式里的 `_`(下标)会被当成斜体标记;两个
 * 不同公式里的 `_` 一旦配成一对 Emphasis,中间整段正文(哪怕跨十几行)都会
 * 被染成斜体。节点**首字符或末字符**落在公式区里,就说明这对分隔符至少有一
 * 端是 LaTeX 文本,节点应整体作废。只查两端是有意的:强调合法地包住一个行内
 * 公式(`_文字 $x$ 文字_`)时两端都在正文里,必须保留。
 */
export function mathOwnsEndpoints(
  regions: readonly MathRegion[],
  from: number,
  to: number,
): boolean {
  if (to <= from) return false;
  const last = to - 1;
  return regions.some(
    (r) => (from >= r.from && from < r.to) || (last >= r.from && last < r.to),
  );
}

/** Classifies the cursor position for snippet-mode matching, in the spirit of
 *  latex-suite's Context (math / code / \text{} environments). */
export function getContextAt(state: EditorState, pos: number): EditContext {
  let codeBlock: string | boolean = false;
  let inlineCode = false;

  let cur: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (cur) {
    const name = cur.name;
    if (name === "FencedCode" || name === "CodeBlock" || name === "IndentedCode") {
      let lang: string | false = false;
      for (let child = cur.firstChild; child; child = child.nextSibling) {
        if (child.name === "CodeInfo") {
          lang = state.sliceDoc(child.from, child.to);
          break;
        }
      }
      codeBlock = lang || true;
      break;
    }
    if (name === "InlineCode") {
      inlineCode = true;
      break;
    }
    cur = cur.parent;
  }

  let inlineMath = false;
  let blockMath = false;
  let textEnv = false;
  if (!codeBlock && !inlineCode) {
    for (const region of mathRegions(state)) {
      if (pos >= region.from && pos <= region.to) {
        if (region.display) blockMath = true;
        else inlineMath = true;
        textEnv = insideTextEnv(region, pos);
        break;
      }
    }
  }

  const code = inlineCode || codeBlock !== false;
  return {
    inlineMath,
    blockMath,
    textEnv,
    code,
    codeBlock,
    isText: !code && !inlineMath && !blockMath,
  };
}

/** Checks whether `pos` falls inside a \text{…} group of a math region. */
function insideTextEnv(region: MathRegion, pos: number): boolean {
  if (!region.content.includes("\\text")) return false;
  const base = region.from + 2; // content offset within region
  const content = region.content;
  const idx = pos - base;
  if (idx < 0 || idx > content.length) return false;

  const openRe = /\\text\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(content))) {
    const openBrace = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = openBrace; i < content.length; i++) {
      const ch = content[i];
      if (ch === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          if (idx > openBrace && idx <= i) return true;
          break;
        }
      }
    }
  }
  return false;
}
