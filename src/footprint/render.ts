import { markdownLanguage } from "@codemirror/lang-markdown";
import { Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { scanMath } from "@/editor/mathScan";
import { renderMathHtml } from "@/editor/widgets";

/**
 * Markdown rendering of a footprint block: the goal is that what you see in the
 * daily note looks exactly like the source - the same lezer parse tree, the same
 * set of editor class names (md-heading, the md-h series, md-list-line, the li-i
 * series, md-bullet, md-quote, md-code-line, md-strong), the same formula scanner
 * (scanMath) and the same KaTeX entry point. The footprint blocks live inside
 * .cm-content, so the styles of these class names apply automatically and nothing
 * has to be copied.
 *
 * The structure is produced line by line (one .footprint-line per line), aligned
 * with the line decoration model of the editor: the hanging indent of a list is
 * reproduced by the li-i series plus the li-b/li-t/li-o geometry classes, so the
 * wrapping aligns with the source.
 * Inside the block it is a read only quote - todos, images and external links,
 * the things that would trigger editing semantics on a click, are only shown
 * statically (blocks with todos are already excluded as a whole at the diff layer
 * and never reach here, the Task branch is only a fallback), clicking the block
 * jumps to the source file.
 *
 * Pure function, zero IO; the structural contract is locked down in render.test.ts.
 */

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A span that cannot be split further inline (formula / wikilink): it replaces the whole range, the lezer subtree does not enter it. */
interface AtomicSpan {
  from: number;
  to: number;
  html: string;
}

const WIKI_LINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

/** Mark nodes that the recursive rendering skips (they produce no output, the position still advances). */
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

  // The formula regions use the same scanner as the editor: block level pairing,
  // the `\$` escape and "$5 and $10" not being a formula, so the decision is
  // exactly the same as in the source.
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

  // Multi line $$ block: the whole range of lines is taken out of the markdown
  // stream and rendered as one centered formula block; the later lines are skipped
  // during the final assembly (they are not blank lines, they are already part of
  // the formula).
  const mathBlockAt = new Map<number, string>();
  const claimed = new Set<number>();
  for (const r of regions) {
    if (!r.display) continue;
    const a = lineOf(r.from);
    const b = lineOf(Math.max(r.from, r.to - 1));
    if (b <= a) continue; // a single line $$...$$ stays inline
    mathBlockAt.set(
      a,
      `<div class="cw-math cw-math-block">${renderMathHtml(r.content, true)}</div>`,
    );
    for (let n = a; n <= b; n++) claimed.add(n);
  }

  // Inline atomics: inline formulas, single line $$...$$ and wikilinks (the editor
  // recognizes wikilinks without the syntax tree as well).
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

  // ---------------- inline: slice by atomics first, walk the lezer subtree inside a slice ----------------

  /** [from,to) = atomic slice plus markdown subtree, so a formula or wikilink appears as a whole. */
  function emitRange(node: SyntaxNode, from: number, to: number): string {
    let html = "";
    let pos = from;
    for (const a of atomics) {
      if (a.to <= pos) continue;
      if (a.from >= to) break;
      if (a.from > pos) html += emitMd(node, pos, Math.min(a.from, to));
      if (a.from < pos) {
        // It intersects an already emitted range (nested in an emphasis and the
        // like): keep it verbatim instead of splitting it further.
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
        // The child is cut by the slice boundary (next to an atomic): keep it
        // verbatim.
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
      // Same as in the editor: the label is blue and underlined, the URL is faint,
      // the parentheses (LinkMark) do not appear. The label text is no lezer node,
      // so the source between the first pair of LinkMark is taken.
      const marks: SyntaxNode[] = [];
      let url = "";
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "LinkMark") marks.push(c);
        if (c.name === "URL") url = escapeHtml(text.slice(c.from, c.to));
      }
      const label = marks.length >= 2 ? emitRange(node, marks[0].to, marks[1].from) : "";
      if (!url && marks.length >= 4) {
        url = escapeHtml(text.slice(marks[2].to, marks[3].from));
      }
      return `<span class="md-link">${label}</span><span class="md-url">${url}</span>`;
    }
    if (name === "Image") {
      // A read only quote embeds no image: the alt text is shown in a faint style,
      // clicking the block goes back to the source file to see the image.
      const marks: SyntaxNode[] = [];
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === "LinkMark") marks.push(c);
      }
      const alt = marks.length >= 2 ? text.slice(marks[0].to, marks[1].from).trim() : "";
      return `<span class="md-url">${escapeHtml(alt || "图")}</span>`;
    }
    // Unknown node: keep it verbatim (showing the source is better than dropping
    // content).
    return escapeHtml(text.slice(node.from, node.to));
  }

  // ---------------- block level: walk the tree, the html of every line lands in out[line number] ----------------
  // The values of out: null = a blank line (rendered as a small gap); "" = the line
  // produces no output (fence lines and the like); anything else is the div html of
  // that line.

  const out: (string | null)[] = new Array(lines.length).fill(null);

  const paragraphLine = (cls: string, content: string, n: number) => {
    out[n] = `<div class="footprint-line${cls}">${content}</div>`;
  };

  function emitListLine(
    cls: string,
    marker: string,
    node: SyntaxNode,
    from: number,
    to: number,
    n: number,
  ) {
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
    // Paragraph / SetextHeading / other unknown blocks: render them line by line as
    // paragraphs (an unknown block is kept verbatim as source).
    const a = lineOf(node.from);
    const b = lineOf(Math.max(node.from, node.to - 1));
    for (let n = a; n <= b; n++) {
      if (claimed.has(n)) continue; // the line is already part of a block level formula
      const bounds = lineBounds(n);
      // The line range is clipped to the node: the `>` of the first line of a quote
      // is a child of the Blockquote and not part of the paragraph.
      const from = Math.max(bounds.from, node.from);
      const to = Math.min(bounds.to, node.to);
      if (lines[n].trim() === "") continue; // a blank line keeps the gap
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
      // Paragraph / Task / others: every line of that content is a list line, with
      // the same geometry.
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
            contentFrom = mark.to; // same as the editor: the whitespace after the marker is swallowed
            while (contentFrom < lineTo && text[contentFrom] === " ") contentFrom++;
          } else if (kind === "li-t" && taskMarker) {
            marker = `<span class="md-task${text[taskMarker.from + 1] === "x" || text[taskMarker.from + 1] === "X" ? " checked" : ""}"></span>`;
            contentFrom = taskMarker.to;
            while (contentFrom < lineTo && text[contentFrom] === " ") contentFrom++;
          } else {
            marker = `<span class="md-listmark">${escapeHtml(markText)}</span>`;
            contentFrom = mark.to; // ordered list: the original gap after the marker is kept
          }
        }
        emitListLine(cls, marker, c, contentFrom, lineTo, n);
      }
    }
  }

  for (let c = markdownLanguage.parser.parse(text).topNode.firstChild; c; c = c.nextSibling) {
    emitBlock(c, false);
  }

  // ---------------- assembly ----------------
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
