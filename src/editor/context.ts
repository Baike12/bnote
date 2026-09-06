import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { scanMath, type MathRegion } from "./mathScan";

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
