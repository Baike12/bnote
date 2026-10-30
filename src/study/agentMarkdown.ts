/**
 * Agent 面板的 markdown 渲染器。
 *
 * 纯函数、先整体转义再按规则放行:模型输出直接进 innerHTML,任何没被规则
 * 认出的字符都必须保持字面量。支持:标题 / 有序无序列表(嵌套)/ 引用 /
 * 分隔线 / 表格 / 围栏代码块 / 行内代码 / 粗斜删除体 / 链接,以及
 * KaTeX 数学($…$、$$…$$、\(…\)、\[…\])。
 *
 * 不引入 markdown 依赖——答案通常是短结构化文本,这份实现的行为全部由
 * agentMarkdown.test.ts 锁定。
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
// 行内规则
// ---------------------------------------------------------------------------

/** 行内渲染:先转义,再依次放行 code / 数学 / 粗斜删 / 链接。 */
export function renderInline(src: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `\x00${stash.push(html) - 1}\x00`;

  let out = escapeHtml(src);
  // 行内代码最先处理:代码内容原样保留,不参与后续规则。
  out = out.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`));
  // 行内数学:占位保护,katex 要吃未经 HTML 转义的原文。两侧必须紧贴非空白,
  // 「价格 $5 和 $6」这类孤立美元符才不会被当成公式。
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
// 块级规则
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s{0,3}```\s*(\S*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^\s{0,3}>/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** 列表嵌套层级:每 2 个空格(或 1 个 tab)一层。 */
const LIST_INDENT = 2;
const MAX_LIST_DEPTH = 6;

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-+:?[ \t]*\|?\s*$/.test(line) && line.includes("-");
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
  /** 标记里的数字(有序列表);`<ol start>` 取列表首项的。 */
  number: number;
  text: string[];
  children: ListItem[];
}

/**
 * 空行之后这个列表是否还在继续:下一个非空行是**同类型**标记(有序↔无序
 * 换了就是另一个列表),或者是属于上一项的缩进续段。
 */
function listContinues(lines: string[], from: number, ordered: boolean): boolean {
  let i = from;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return false;
  const m = ITEM_RE.exec(lines[i]);
  if (m) return /\d/.test(m[2]) === ordered;
  return /^\s{2,}\S/.test(lines[i]);
}

/** 收集从 `start` 开始的列表项(含缩进续行),按缩进建树,渲染成 HTML。 */
function renderList(lines: string[], start: number): [string, number] {
  const items: ListItem[] = [];
  /** 项之间出现过空行 = 松散列表:项与项之间要留出段落级的间距。 */
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // 松散列表:项之间夹空行仍然是同一个列表(CommonMark 的 loose list)。
      // 漏了这条,模型常见的「1. …/空行/1. …」会变成一串各自从 1 起算的
      // <ol>,屏幕上就是 1. 1. 1. 1.
      if (items.length === 0 || !listContinues(lines, i + 1, items[0].ordered)) break;
      loose = true;
      i += 1;
      continue;
    }
    const m = ITEM_RE.exec(line);
    if (m) {
      const ordered = /\d/.test(m[2]);
      // 有序 ↔ 无序换了标记:另一个列表,交给外层重新开始。
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
    // 缩进的续行属于上一个列表项(空行后的非列表行结束列表)。
    if (items.length && /^\s{2,}\S/.test(line)) {
      items[items.length - 1].text.push(line.trim());
      i += 1;
      continue;
    }
    break;
  }
  // 按缩进深度挂树:栈[i] = 第 i 层当前的最后一个节点;更深的缩进挂到
  // 当前最深层之下(迷你实现不追求完美嵌套)。
  const root: ListItem[] = [];
  const stack: ListItem[] = [];
  for (const item of items) {
    const depth = Math.min(item.indent, MAX_LIST_DEPTH);
    stack.length = Math.min(stack.length, depth);
    if (stack.length === 0) {
      root.push(item);
    } else {
      stack[stack.length - 1].children.push(item);
    }
    stack[depth] = item;
    stack.length = depth + 1;
  }

  function renderItems(list: ListItem[]): string {
    const ordered = list[0]?.ordered ?? false;
    const tag = ordered ? "ol" : "ul";
    // 起始编号取首项的标记数字(模型常把每项都写成「1.」:自增正好给出
    // 1/2/3/4;真从「3.」起排的列表也照样对齐)。
    const startAttr =
      ordered && list[0].number > 1 ? ` start="${list[0].number}"` : "";
    // 松散列表的每一项在源码里是独立段落,合并成一个列表后靠间距保住这个
    // 边界(仅根层:嵌套列表的松散程度不值得再多一套记账)。
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

/** 段落:连续非空行合并(聊天里单个换行是有意的,渲染成 <br>)。 */
function renderParagraph(lines: string[], start: number): [string, number] {
  const buf: string[] = [];
  let i = start;
  while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
    buf.push(lines[i].trim());
    i += 1;
  }
  return [`<p>${buf.map(renderInline).join("<br>")}</p>`, i];
}

/** 数学块 $$…$$ 或 \[…\]:收集到闭合定界符(或文末)。 */
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
 * 富文本行组(列表项内容):文本行与块级数学混排。模型常把 $$…$$ 块缩进
 * 在列表项下,只走 renderInline 的话块级公式整段原样漏出——这里先扫块级
 * 数学定界符,数学段进 KaTeX,其余文本行按 inline 渲染 join <br>。
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

export function renderAgentMarkdown(src: string): string {
  if (!src) return "";
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
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
      i += 1; // 闭合围栏(或文末)
      const cls = lang ? ` agent-code language-${escapeHtml(lang)}` : " agent-code";
      out.push(`<pre class="${cls.trim()}"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
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
  return out.join("");
}
