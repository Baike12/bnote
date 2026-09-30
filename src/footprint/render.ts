import { markdownLanguage } from "@codemirror/lang-markdown";
import { Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { scanMath } from "@/editor/mathScan";
import { renderMathHtml } from "@/editor/widgets";

/**
 * 足迹块的 markdown 渲染:目标是在日记里看到的和原文一样——同一棵 lezer
 * 解析树、同一套编辑器类名(md-heading、md-h 系列、md-list-line、li-i 系列、
 * md-bullet、md-quote、md-code-line、md-strong)、同一个公式扫描器(scanMath)
 * 与 KaTeX 入口。足迹块挂在 .cm-content 里,这些类名的样式自动生效,不需要复制。
 *
 * 结构逐行产出(每行一个 .footprint-line),与编辑器的行装饰模型对齐:列表
 * 悬挂缩进靠 li-i 系列 + li-b/li-t/li-o 几何类复现,折行对齐和原文一致。
 * 块内是只读引用——待办、图片、外链这些「点了会走编辑语义」的东西只做
 * 静态展示(待办块在 diff 层已整块排除,走不到这里,Task 分支只是兜底),
 * 点击整块跳源文件。
 *
 * 纯函数,零 IO;结构契约在 render.test.ts 锁死。
 */

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 行内不可再拆的 span(公式/wikilink):整段替换,lezer 子树不进。 */
interface AtomicSpan {
  from: number;
  to: number;
  html: string;
}

const WIKI_LINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

/** 递归渲染时跳过的 mark 节点(不产输出,位置照常推进)。 */
const MARK_NODES = new Set([
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "CodeMark",
  "EmphasisMark",
  "StrikethroughMark",
  "LinkMark",
  "TaskMarker",
]);

export function renderBlockHtml(text: string): string {
  const lines = text.split("\n");
  if (lines.every((l) => l.trim() === "")) return "";

  // 公式区域用编辑器同一个扫描器:块级配对、`\$` 转义、「$5 和 $10」不当公式,
  // 判定和原文完全一致。
  const regions = scanMath(Text.of(lines));
  const lineStarts: number[] = [];
  for (let i = 0, off = 0; i < lines.length; i++) {
    lineStarts.push(off);
    off += lines[i].length + 1;
  }
  const lineOf = (pos: number): number => {
    let n = 0;
    while (n + 1 < lineStarts.length && lineStarts[n + 1] <= pos) n++;
    return n;
  };
  const lineBounds = (n: number) => ({ from: lineStarts[n], to: lineStarts[n] + lines[n].length });

  // 多行 $$ 块:整段行从 markdown 流里摘出来,渲染成一个居中公式块;
  // 后续行在最终拼装时跳过(不是空行,是已并入公式)。
  const mathBlockAt = new Map<number, string>();
  const claimed = new Set<number>();
  for (const r of regions) {
    if (!r.display) continue;
    const a = lineOf(r.from);
    const b = lineOf(Math.max(r.from, r.to - 1));
    if (b <= a) continue; // 单行 $$…$$ 走行内
    mathBlockAt.set(a, `<div class="cw-math cw-math-block">${renderMathHtml(r.content, true)}</div>`);
    for (let n = a; n <= b; n++) claimed.add(n);
  }

  // 行内原子:行内公式 + 单行 $$…$$ + wikilink(wikilink 编辑器同样不靠语法树认)。
  const atomics: AtomicSpan[] = [];
  for (const r of regions) {
    if (r.display && lineOf(Math.max(r.from, r.to - 1)) > lineOf(r.from)) continue;
    atomics.push({
      from: r.from,
      to: r.to,
      html: `<span class="cw-math cw-math-inline">${renderMathHtml(r.content, false)}</span>`,
    });
  }
  for (const m of text.matchAll(WIKI_LINK_RE)) {
    const raw = m[1];
    const pipe = raw.indexOf("|");
    const target = (pipe >= 0 ? raw.slice(0, pipe) : raw).split("#")[0].trim();
    const label = (pipe >= 0 ? raw.slice(pipe + 1) : raw).trim();
    if (!target) continue;
    atomics.push({
      from: m.index,
      to: m.index + m[0].length,
      html: `<span class="md-wikilink">${escapeHtml(label || target)}</span>`,
    });
  }
  atomics.sort((a, b) => a.from - b.from);

  // ---------------- 行内:先按原子切片,片段内走 lezer 子树 ----------------

  /** [from,to) = 原子切片 + markdown 子树,保证公式/wikilink 整段出现。 */
  function emitRange(node: SyntaxNode, from: number, to: number): string {
    let html = "";
    let pos = from;
    for (const a of atomics) {
      if (a.to <= pos) continue;
      if (a.from >= to) break;
      if (a.from > pos) html += emitMd(node, pos, Math.min(a.from, to));
      if (a.from < pos) {
        // 与已 emission 相交(嵌套在 emphasis 里等):原样保真不再拆。
        const end = Math.min(a.to, to);
        if (end > pos) html += escapeHtml(text.slice(pos, end));
        pos = end;
        continue;
      }
      html += a.html;
      pos = Math.min(a.to, to);
    }
    if (pos < to) html += emitMd(node, pos, to);
    return html;
  }

  function emitMd(node: SyntaxNode, from: number, to: number): string {
    let html = "";
    let pos = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.to <= from || child.from >= to) continue;
      if (child.from > pos) html += escapeHtml(text.slice(pos, Math.min(child.from, to)));
      if (child.to > to) {
        // 被切片边界切开的孩子(原子邻座):原样保真。
        html += escapeHtml(text.slice(Math.max(child.from, pos), to));
        pos = to;
        break;
      }
      html += emitNode(child);
      pos = child.to;
    }
    if (pos < to) html += escapeHtml(text.slice(pos, to));
    return html;
  }

  function emitNode(node: SyntaxNode): string {
    const name = node.name;
    if (MARK_NODES.has(name)) return "";
    if (name === "InlineCode") {
      let first: SyntaxNode | null = null;
      let last: SyntaxNode | null = null;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "CodeMark") {
          if (!first) first = c;
          last = c;
        }
      }
      const inner = first && last ? text.slice(first.to, last.from) : "";
      return `<code class="md-inline-code">${escapeHtml(inner)}</code>`;
    }
    if (name === "Emphasis") return `<em class="md-em">${emitRange(node, node.from, node.to)}</em>`;
    if (name === "StrongEmphasis")
      return `<strong class="md-strong">${emitRange(node, node.from, node.to)}</strong>`;
    if (name === "Strikethrough")
      return `<del class="md-strike">${emitRange(node, node.from, node.to)}</del>`;
    if (name === "Escape") return escapeHtml(text.slice(node.from + 1, node.to));
    if (name === "HardBreak") return "";
    if (name === "URL" || name === "Autolink")
      return `<span class="md-url">${escapeHtml(text.slice(node.from, node.to))}</span>`;
    if (name === "Link") {
      // 编辑器同款:标签蓝色下划线,URL 淡色;括号(LinkMark)不出现。
      // 标签文本不是 lezer 节点,取首对 LinkMark 之间的原文。
      const marks: SyntaxNode[] = [];
      let url = "";
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "LinkMark") marks.push(c);
        if (c.name === "URL") url = escapeHtml(text.slice(c.from, c.to));
      }
      const label =
        marks.length >= 2 ? emitRange(node, marks[0].to, marks[1].from) : "";
      if (!url && marks.length >= 4) {
        url = escapeHtml(text.slice(marks[2].to, marks[3].from));
      }
      return `<span class="md-link">${label}</span><span class="md-url">${url}</span>`;
    }
    if (name === "Image") {
      // 只读引用不嵌图:alt 淡色示意,点击整块回源文件看原图。
      const marks: SyntaxNode[] = [];
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "LinkMark") marks.push(c);
      }
      const alt = marks.length >= 2 ? text.slice(marks[0].to, marks[1].from).trim() : "";
      return `<span class="md-url">${escapeHtml(alt || "图")}</span>`;
    }
    // 未知节点:原样保真(宁可显示源码,不吞内容)。
    return escapeHtml(text.slice(node.from, node.to));
  }

  // ---------------- 块级:树行走,每行 html 落到 out[行号] ----------------
  // out 值:null = 空行(渲染成小间隔);"" = 该行不产输出(围栏行等);
  // 其余为该行的 div html。

  const out: (string | null)[] = new Array(lines.length).fill(null);

  const paragraphLine = (cls: string, content: string, n: number) => {
    out[n] = `<div class="footprint-line${cls}">${content}</div>`;
  };

  function emitListLine(cls: string, marker: string, node: SyntaxNode, from: number, to: number, n: number) {
    out[n] = `<div class="footprint-line ${cls}">${marker}${emitRange(node, from, to)}</div>`;
  }

  function emitBlock(node: SyntaxNode, quote: boolean): void {
    const name = node.name;
    const quoteCls = quote ? " md-quote" : "";
    if (/^ATXHeading[1-6]$/.test(name)) {
      const level = Number(name.slice(-1));
      let mark: SyntaxNode | null = null;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "HeaderMark") {
          mark = c;
          break;
        }
      }
      if (!mark) return;
      let contentFrom = mark.to;
      while (contentFrom < node.to && text[contentFrom] === " ") contentFrom++;
      const n = lineOf(mark.from);
      paragraphLine(
        ` fp-h`,
        `<span class="md-heading md-h${level}">${emitRange(node, contentFrom, node.to)}</span>`,
        n,
      );
      return;
    }
    if (name === "BulletList" || name === "OrderedList") {
      for (let item = node.firstChild; item; item = item.nextSibling) {
        if (item.name === "ListItem") emitListItem(item);
      }
      return;
    }
    if (name === "Blockquote") {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "QuoteMark") continue;
        emitBlock(c, true);
      }
      return;
    }
    if (name === "FencedCode") {
      let openLine = -1;
      let closeLine = -1;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "CodeMark") {
          const n = lineOf(c.from);
          if (openLine === -1) openLine = n;
          else closeLine = n;
        }
      }
      if (openLine === -1) return;
      out[openLine] = "";
      if (closeLine !== -1) out[closeLine] = "";
      const last = closeLine === -1 ? lineOf(Math.max(node.from, node.to - 1)) : closeLine - 1;
      for (let n = openLine + 1; n <= last; n++) {
        out[n] = `<div class="footprint-line md-code-line">${escapeHtml(lines[n])}</div>`;
      }
      return;
    }
    if (name === "HorizontalRule") {
      out[lineOf(node.from)] = `<div class="fp-hr"><hr></div>`;
      return;
    }
    // Paragraph / SetextHeading / 其他未知块:逐行段落渲染(未知块保真为源码)。
    const a = lineOf(node.from);
    const b = lineOf(Math.max(node.from, node.to - 1));
    for (let n = a; n <= b; n++) {
      if (claimed.has(n)) continue; // 该行已并入块级公式
      const bounds = lineBounds(n);
      // 行范围裁到节点内:引用首行的 `>` 是 Blockquote 的孩子,不在段落里。
      const from = Math.max(bounds.from, node.from);
      const to = Math.min(bounds.to, node.to);
      if (lines[n].trim() === "") continue; // 空行保持 gap
      if (to <= from) continue;
      paragraphLine(quoteCls, emitRange(node, from, to), n);
    }
  }

  function emitListItem(item: SyntaxNode): void {
    let mark: SyntaxNode | null = null;
    let task: SyntaxNode | null = null;
    for (let c = item.firstChild; c; c = c.nextSibling) {
      if (c.name === "ListMark") mark = c;
      if (c.name === "Task") task = c;
    }
    if (!mark) return;
    const markLine = lineOf(mark.from);
    const markCol = mark.from - lineStarts[markLine];
    const d = Math.min(16, Math.floor(markCol / 2)) * 2;
    const markText = text.slice(mark.from, mark.to);
    const kind = task ? "li-t" : /^\d/.test(markText) ? "li-o" : "li-b";
    const cls = `md-list-line li-i${d} ${kind}`;
    const taskMarker =
      task && task.firstChild && task.firstChild.name === "TaskMarker" ? task.firstChild : null;

    for (let c = item.firstChild; c; c = c.nextSibling) {
      if (c.name === "ListMark") continue;
      if (c.name === "BulletList" || c.name === "OrderedList") {
        emitBlock(c, false);
        continue;
      }
      // Paragraph / Task / 其他:该内容的每一行都是列表行,几何同款。
      const a = lineOf(c.from);
      const b = lineOf(Math.max(c.from, c.to - 1));
      for (let n = a; n <= b; n++) {
        if (claimed.has(n)) continue;
        const { from: lineFrom, to: lineTo } = lineBounds(n);
        if (lines[n].trim() === "") continue;
        let marker = "";
        let contentFrom = lineFrom;
        if (n === markLine) {
          if (kind === "li-b") {
            marker = `<span class="md-bullet"></span>`;
            contentFrom = mark.to; // 编辑器同款:吞掉标记后的空白
            while (contentFrom < lineTo && text[contentFrom] === " ") contentFrom++;
          } else if (kind === "li-t" && taskMarker) {
            marker = `<span class="md-task${text[taskMarker.from + 1] === "x" || text[taskMarker.from + 1] === "X" ? " checked" : ""}"></span>`;
            contentFrom = taskMarker.to;
            while (contentFrom < lineTo && text[contentFrom] === " ") contentFrom++;
          } else {
            marker = `<span class="md-listmark">${escapeHtml(markText)}</span>`;
            contentFrom = mark.to; // 有序列表:保留标记后的原文间隙
          }
        }
        emitListLine(cls, marker, c, contentFrom, lineTo, n);
      }
    }
  }

  for (let c = markdownLanguage.parser.parse(text).topNode.firstChild; c; c = c.nextSibling) {
    emitBlock(c, false);
  }

  // ---------------- 拼装 ----------------
  let html = "";
  for (let n = 0; n < lines.length; n++) {
    if (claimed.has(n)) {
      html += mathBlockAt.get(n) ?? "";
      continue;
    }
    const line = out[n];
    html += line === null ? `<div class="footprint-gap"></div>` : line;
  }
  return html;
}
