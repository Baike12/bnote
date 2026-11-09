/**
 * The markdown renderer of the agent panel.
 *
 * A pure function that escapes everything first and then lets the rules
 * through one by one: the model output goes straight into innerHTML, so every
 * character that no rule recognizes has to stay literal. Supported: headings
 * / ordered and unordered lists (nested) / quotes / horizontal rules /
 * tables / fenced code blocks / inline code / bold, italic and strikethrough /
 * links, plus KaTeX math ($…$, $$…$$, \(…\), \[…\]).
 *
 * No markdown dependency is pulled in — the answers are usually short
 * structured text, and the behavior of this implementation is locked down
 * entirely by agentMarkdown.test.ts.
 */
import katex from "katex";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(unescapeHtml(tex), {
      displayMode: display,
      throwOnError: false,
      output: "html",
    });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

// ---------------------------------------------------------------------------
// Inline rules
// ---------------------------------------------------------------------------

/** Inline rendering: escape first, then let code / math / bold-italic-strike / links through in turn. */
export function renderInline(src: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `\x00${stash.push(html) - 1}\x00`;

  let out = escapeHtml(src);
  // Inline code is handled first: the code content is kept verbatim and takes no part in the later rules.
  out = out.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`));
  // Inline math: protected by a placeholder, katex needs the raw text without HTML escaping. Both sides must hug a non-space,
  // so that a lone dollar sign such as in "price $5 and $6" is not taken for a formula.
  out = out.replace(/\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$/g, (_, tex: string) =>
    keep(renderMath(tex, false)),
  );
  out = out.replace(/\\\(([^]+?)\\\)/g, (_, tex: string) => keep(renderMath(tex, false)));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  out = out.replace(/\x00(\d+)\x00/g, (_, i: string) => stash[Number(i)]);
  return out;
}

// ---------------------------------------------------------------------------
// Block rules
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s{0,3}```\s*(\S*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^\s{0,3}>/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** The nesting level of a list: one level per 2 spaces (or 1 tab). */
const LIST_INDENT = 2;
const MAX_LIST_DEPTH = 6;

function isTableSeparator(line: string): boolean {
  return (
    /^\s*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-+:?[ \t]*\|?\s*$/.test(line) && line.includes("-")
  );
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((c) => c.trim());
}

function renderTable(header: string[], rows: string[][]): string {
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

interface ListItem {
  indent: number;
  ordered: boolean;
  /** The number in the marker (ordered list); `<ol start>` takes the one of the first item. */
  number: number;
  text: string[];
  children: ListItem[];
}

/**
 * Whether the list continues after a blank line: the next non-empty line is
 * a marker of the **same kind** (switching between ordered and unordered
 * means another list), or an indented continuation of the previous item.
 */
function listContinues(lines: string[], from: number, ordered: boolean): boolean {
  let i = from;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return false;
  const m = ITEM_RE.exec(lines[i]);
  if (m) return /\d/.test(m[2]) === ordered;
  return /^\s{2,}\S/.test(lines[i]);
}

/** Collect the list items starting at `start` (including the indented continuation lines), build the tree by the indentation and render it as HTML. */
function renderList(lines: string[], start: number): [string, number] {
  const items: ListItem[] = [];
  /** A blank line between the items = a loose list: the items keep paragraph-level spacing between them. */
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A loose list: a blank line between the items is still the same list (a loose list in CommonMark).
      // Without this rule the model's common "1. …/blank line/1. …" becomes a run of <ol> that each start at 1,
      // and the screen shows 1. 1. 1. 1.
      if (items.length === 0 || !listContinues(lines, i + 1, items[0].ordered)) break;
      loose = true;
      i += 1;
      continue;
    }
    const m = ITEM_RE.exec(line);
    if (m) {
      const ordered = /\d/.test(m[2]);
      // The marker switched between ordered and unordered: that is another list, the outer level starts over.
      if (items.length > 0 && ordered !== items[0].ordered) break;
      items.push({
        indent: Math.floor(m[1].replace(/\t/g, "  ").length / LIST_INDENT),
        ordered,
        number: ordered ? parseInt(m[2], 10) : 0,
        text: [m[3]],
        children: [],
      });
      i += 1;
      continue;
    }
    // An indented continuation line belongs to the previous list item (a non-list line after a blank line ends the list).
    if (items.length && /^\s{2,}\S/.test(line)) {
      items[items.length - 1].text.push(line.trim());
      i += 1;
      continue;
    }
    break;
  }
  // The tree is hung by the indentation depth: stack[i] = the last node of the
  // i-th level, and every level below `stack.length` is filled (an item hangs
  // under `stack[depth - 1]`). Two rules keep that invariant:
  // - the first item defines the list's base indentation, so a list that starts
  //   indented (the common hanging-indent list under "实现:") keeps its items at
  //   level 0 instead of hanging off level 0, which does not exist;
  // - a jump deeper than the levels built so far clamps to the deepest existing
  //   level (this mini implementation does not chase perfect nesting).
  // Without the clamp, `stack[stack.length - 1]` could be a hole and reading
  // `.children` threw during render — which unmounted the whole app, because an
  // agent reply renders inside React with no error boundary above it.
  const root: ListItem[] = [];
  const stack: ListItem[] = [];
  const baseIndent = items[0]?.indent ?? 0;
  for (const item of items) {
    const depth = Math.min(Math.max(item.indent - baseIndent, 0), MAX_LIST_DEPTH, stack.length);
    stack.length = depth;
    if (depth === 0) {
      root.push(item);
    } else {
      stack[depth - 1].children.push(item);
    }
    stack[depth] = item;
  }

  function renderItems(list: ListItem[]): string {
    const ordered = list[0]?.ordered ?? false;
    const tag = ordered ? "ol" : "ul";
    // The start number comes from the marker of the first item (models often write every item as "1.": the auto-increment then gives
    // exactly 1/2/3/4; a list that really starts at "3." still lines up).
    const startAttr = ordered && list[0].number > 1 ? ` start="${list[0].number}"` : "";
    // Every item of a loose list is a separate paragraph in the source; once they are merged into one list, the spacing keeps that
    // boundary (root level only: the looseness of a nested list does not deserve a second bookkeeping).
    const looseAttr = list === root && loose ? ' class="is-loose"' : "";
    const inner = list
      .map((item) => {
        const body = renderTextLines(item.text);
        const nested = item.children.length > 0 ? renderItems(item.children) : "";
        return `<li>${body}${nested}</li>`;
      })
      .join("");
    return `<${tag}${startAttr}${looseAttr}>${inner}</${tag}>`;
  }
  return [renderItems(root), i];
}

function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    ITEM_RE.test(line) ||
    /^\s*\$\$/.test(line)
  );
}

/** A paragraph: consecutive non-empty lines are merged (a single newline is intentional in a chat and is rendered as <br>). */
function renderParagraph(lines: string[], start: number): [string, number] {
  const buf: string[] = [];
  let i = start;
  while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
    buf.push(lines[i].trim());
    i += 1;
  }
  return [`<p>${buf.map(renderInline).join("<br>")}</p>`, i];
}

/** A math block $$…$$ or \[…\]: collected up to the closing delimiter (or the end of the text). */
function collectMath(
  lines: string[],
  start: number,
  openRe: RegExp,
  closeToken: string,
): [string, number] {
  const body = lines[start].replace(openRe, "");
  const firstClose = body.indexOf(closeToken);
  if (firstClose >= 0) {
    return [renderMath(body.slice(0, firstClose), true), start + 1];
  }
  const buf = [body];
  let i = start + 1;
  while (i < lines.length && !lines[i].includes(closeToken)) {
    buf.push(lines[i]);
    i += 1;
  }
  if (i < lines.length) {
    buf.push(lines[i].slice(0, lines[i].indexOf(closeToken)));
    i += 1;
  }
  return [renderMath(buf.join("\n"), true), i];
}

/**
 * A group of rich text lines (the content of a list item): text lines mixed
 * with block math. Models often indent a $$…$$ block under a list item, and
 * with renderInline alone the whole display formula leaks out verbatim — so
 * the block math delimiters are scanned first, the math part goes into KaTeX
 * and the remaining text lines are rendered inline and joined with <br>.
 */
function renderTextLines(lines: string[]): string {
  const parts: string[] = [];
  let buf: string[] = [];
  let i = 0;
  const flush = () => {
    if (buf.length) {
      parts.push(buf.map(renderInline).join("<br>"));
      buf = [];
    }
  };
  while (i < lines.length) {
    if (/^\s*\$\$/.test(lines[i])) {
      flush();
      const [html, next] = collectMath(lines, i, /^\s*\$\$/, "$$");
      parts.push(html);
      i = next;
      continue;
    }
    if (/^\s*\\\[/.test(lines[i])) {
      flush();
      const [html, next] = collectMath(lines, i, /^\s*\\\[/, "\\]");
      parts.push(html);
      i = next;
      continue;
    }
    buf.push(lines[i]);
    i += 1;
  }
  flush();
  return parts.join("<br>");
}

/** One block of an agent reply: rendered markdown, or an html code block the
 *  panel renders as a live preview (the code travels verbatim so the React
 *  component can own the iframe, its toggle and its height messages). */
export type AgentBlock = { kind: "markdown"; html: string } | { kind: "html"; code: string };

/** A fenced code block rendered like every other language's block. */
function renderCodeBlock(code: string, lang: string): string {
  const cls = lang ? ` agent-code language-${escapeHtml(lang)}` : " agent-code";
  return `<pre class="${cls.trim()}"><code>${escapeHtml(code)}</code></pre>`;
}

/** The panel previews html fences live; `htm` is the same language. */
function isHtmlLanguage(lang: string): boolean {
  const name = lang.toLowerCase();
  return name === "html" || name === "htm";
}

/**
 * Splits a reply at top level, keeping closed `html` fences whole as preview
 * blocks. Only top-level fences split: a fence nested in a list or quote is
 * consumed by the recursive rendering and stays a plain code block, exactly
 * as before.
 */
export function splitAgentMarkdown(src: string): AgentBlock[] {
  if (!src) return [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: AgentBlock[] = [];
  let out: string[] = [];
  const flush = () => {
    if (out.length) {
      blocks.push({ kind: "markdown", html: out.join("") });
      out = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1];
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      // No closing fence means the reply is still streaming (or malformed):
      // render code, never a half-preview.
      const closed = i < lines.length;
      if (closed) i += 1; // the closing fence (or the end of the text)
      if (closed && isHtmlLanguage(lang) && code.length > 0) {
        flush();
        blocks.push({ kind: "html", code: code.join("\n") });
        continue;
      }
      out.push(renderCodeBlock(code.join("\n"), lang));
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      const [html, next] = collectMath(lines, i, /^\s*\$\$/, "$$");
      out.push(html);
      i = next;
      continue;
    }
    if (/^\s*\\\[/.test(line)) {
      const [html, next] = collectMath(lines, i, /^\s*\\\[/, "\\]");
      out.push(html);
      i = next;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderAgentMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(header, rows));
      continue;
    }
    if (ITEM_RE.test(line)) {
      const [html, next] = renderList(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    const [html, next] = renderParagraph(lines, i);
    out.push(html);
    i = next;
  }
  flush();
  return blocks;
}

export function renderAgentMarkdown(src: string): string {
  return splitAgentMarkdown(src)
    .map((block) => (block.kind === "html" ? renderCodeBlock(block.code, "html") : block.html))
    .join("");
}
