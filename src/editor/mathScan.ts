import type { Text } from "@codemirror/state";

export interface MathRegion {
  from: number;
  to: number;
  display: boolean;
  content: string;
}

/**
 * Scans the document for `$$…$$` (block) and `$…$` (inline) math regions.
 * Mirrors Obsidian's heuristics: `\$` is an escape, inline content may not
 * start/end with whitespace or contain a newline, and a closing `$` may not
 * be followed by a digit (so "$5 and $10" stays plain text).
 *
 * 块级配对模型(第一性原理):
 * - 配对永不跨"内部空行"——LaTeX 数学容不下空行。但打字流会产生**单侧**空行
 *   (`$$` 后连按两次回车再写公式,或写完补空行再闭合),这类块必须照常渲染;
 *   只有**两侧同时**留空(正文段落被两个落单 $$ 夹住,即删错 $$ 后的错位产物)
 *   才拒绝配对。
 * - **例外:空行落在配对完整的 `\begin{…}…\end{…}` 内部时不是段落边界**。
 *   多行环境里的空行是排版留白(`#@` 片段展开成 `$$\n\begin{align}\n$0\n\end{align}\n$$`
 *   后,在 `$0` 处回车就直接产生它),整块照常渲染;而"未闭合的 `\begin` 之后的
 *   空行"不给豁免,否则"打了个 \begin 还没 \end 就空行"会重新打开吞正文的口子。
 * - 配对栈式前进:一对被拒绝时,两个标记都不发区域(可见可删),闭候选继续
 *   向后找——删掉一个 $$ 后,下方完好的公式仍按原样配对渲染,不会整体移位
 *   ("公式怪追着跑")。
 * - 奇数个标记时的最终落单 $$ 是"打字中未闭合"形态,发实时区域封顶到本段
 *   (第一个空行);其余落单一律保持普通文本——错位产物里的正文永远不会被
 *   吞进任何区域,每个 $$ 始终可见可删。
 */
export function scanMath(doc: Text): MathRegion[] {
  const out: MathRegion[] = [];
  const text = doc.toString();
  if (text.length > 2_000_000) return out;

  // --- Block math: stack-pair up unescaped $$ occurrences. ---
  const marks: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text.charCodeAt(i) === 36 /* $ */ && text.charCodeAt(i + 1) === 36) {
      if (i > 0 && text.charCodeAt(i - 1) === 92 /* \ */) continue;
      marks.push(i);
      i++; // consume both dollars
    }
  }

  // 行 [start,end) 是否只含空白。
  const lineIsBlank = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      const ch = text.charCodeAt(i);
      if (ch !== 32 /* space */ && ch !== 9 /* tab */) return false;
    }
    return true;
  };

  // `\begin{name}` / `\end{name}`:环境名不跨行(`\begin{` 后换行不算环境)。
  const ENV_TOKEN = /\\(begin|end)\s*\{([^}\n]*)\}/g;

  /** [from,to) 之间还有该环境的 `\end` 吗——没有就说明环境没闭合。 */
  const hasClosingEnd = (from: number, to: number, envName: string): boolean => {
    ENV_TOKEN.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = ENV_TOKEN.exec(text)) !== null && m.index < to) {
      if (m[1] === "end" && m[2] === envName) return true;
    }
    return false;
  };

  /** 把行 [from,to) 里的 `\begin`/`\end` 反映到环境栈上(只弹最近的同名环境)。 */
  const scanEnvTokens = (from: number, to: number, stack: string[]): void => {
    if (text.indexOf("\\", from) < 0 || text.indexOf("\\", from) >= to) return;
    ENV_TOKEN.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = ENV_TOKEN.exec(text)) !== null && m.index < to) {
      if (m[1] === "begin") stack.push(m[2]);
      else if (stack[stack.length - 1] === m[2]) stack.pop();
    }
  };

  /** 开闭标记之间的内容能否构成一个公式块。单行配对(`$$x$$`)天然合法;
   *  多行时数内部行:开头连续空行(lead)与结尾连续空行(trail)剥掉之后,
   *  中间不容空行,且两侧不得同时留空(那是正文被夹的错位产物);
   *  落在配对完整环境内部的空行不算空行(见文件头)。 */
  const pairValid = (open: number, close: number): boolean => {
    const openNl = text.indexOf("\n", open);
    if (openNl === -1 || openNl + 1 > close) return true; // 同行配对
    let lead = 0;
    let trail = 0;
    let pendingTrail = 0;
    let sawContent = false;
    let interiorBlank = false;
    const envStack: string[] = [];
    let pos = openNl + 1;
    while (pos < close) {
      let nl = text.indexOf("\n", pos);
      if (nl === -1 || nl >= close) nl = close; // 闭标记所在行的行首片段
      const blank = lineIsBlank(pos, nl);
      // 空行是不是"环境内部的留白":栈顶环境在本块之内还有配对的 \end。
      const envTop = envStack[envStack.length - 1];
      const envBlank = blank && envTop !== undefined && hasClosingEnd(nl, close, envTop);
      if (blank && !envBlank) {
        if (!sawContent) lead++;
        else pendingTrail++;
      } else {
        if (pendingTrail > 0) interiorBlank = true;
        sawContent = true;
        trail = pendingTrail;
        pendingTrail = 0;
      }
      if (!blank) scanEnvTokens(pos, nl, envStack);
      pos = nl + 1;
    }
    trail += pendingTrail;
    if (lead > 0 && trail > 0) return false;
    return !interiorBlank;
  };

  let open = -1;
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    if (open === -1) {
      open = m;
      continue;
    }
    if (pairValid(open, m)) {
      out.push({ from: open, to: m + 2, display: true, content: text.slice(open + 2, m) });
      open = -1;
    } else {
      // 错位配对:两个标记都不发区域(保持可见可删),当前标记成为新的开候选
      // ——下方完好的公式因此仍能按原样配对(公式怪不再整体移位)。
      open = m;
    }
  }
  // 只有奇数个标记时的最终落单 $$ 是"打字中未闭合"形态,发实时区域(封顶到
  // 本段);偶数个标记还剩落单,说明它是错位产物里被挤掉的闭合标记,其下方
  // 是无关正文——保持普通文本,不吞进任何区域。
  if (open !== -1 && marks.length % 2 === 1) {
    pushStrayRegion(out, text, open);
  }

  // --- Inline math, per line, outside block regions. ---
  const inlineRe = /(?<![\\$])\$(?!\s)((?:[^$\n\\]|\\.)*?)(?<!\s)\$(?!\d)/g;
  const lines = doc.iterLines();
  let pos = 0;
  for (let res = lines.next(); !res.done; res = lines.next()) {
    const lineText = res.value as string;
    const lineEnd = pos + lineText.length;
    if (lineText.includes("$") && !inRanges(pos, lineEnd, out)) {
      inlineRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = inlineRe.exec(lineText))) {
        const from = pos + m.index;
        const to = from + m[0].length;
        if (!inRanges(from, to, out) && m[1].length > 0) {
          out.push({ from, to, display: false, content: m[1] });
        }
      }
    }
    pos = lineEnd + 1; // +1 for the newline
    if (pos > doc.length) break;
  }

  out.sort((a, b) => a.from - b.from);
  return out;
}

/**
 * 落单 $$ 的实时区域:`$$` 起到本段(第一个空行)末尾——打字中的公式保持
 * 实时渲染,又绝不吞进后续段落。区域止于段落最后一个字符(不含末尾换行),
 * 否则单行区域会越过行尾,行内替换装饰跨行抛
 * "Decorations that replace line breaks may not be specified via plugins"。
 */
function pushStrayRegion(out: MathRegion[], text: string, from: number): void {
  if (text.length - from > 10_000) return;
  const rest = text.slice(from + 2, Math.min(text.length, from + 2 + 10_000));
  const blank = /\n[ \t]*\n/.exec(rest);
  // 区域止于段落最后一个字符(不含末尾换行)——区域跨行与否由换行决定,
  // 把换行算进来会让单行区域越过了行尾,行内替换装饰会跨行抛错。
  const paraEnd = blank ? blank.index : rest.length;
  out.push({
    from,
    to: from + 2 + paraEnd,
    display: true,
    content: rest.slice(0, paraEnd),
  });
}

function inRanges(from: number, to: number, ranges: MathRegion[]): boolean {
  for (const r of ranges) {
    if (from < r.to && to > r.from) return true;
  }
  return false;
}
