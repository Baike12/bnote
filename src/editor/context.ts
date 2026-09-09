import type { EditorState, Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
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
  let regions = mathCache.get(state.doc);
  if (!regions) {
    regions = scanMath(state.doc);
    mathCache.set(state.doc, regions);
  }
  return regions;
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
