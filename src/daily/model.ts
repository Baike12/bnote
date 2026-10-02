import { EditorState, type Text } from "@codemirror/state";
import { fenceStateScan } from "@/editor/context";
import { DONE_STAMP_RE } from "@/editor/ops";

/**
 * 跨文件待办同步的纯文本模型：列表行解析、待办块提取、日记文件头部待办区
 * 的解析与增删改。全部函数只吃行文本 / CM Text,不做任何 IO——engine 负责
 * 编排,这里负责「文档长什么样、改动落在哪」的唯一事实,所有规则都在
 * model.test.ts 里锁死。
 */

// ---------------------------------------------------------------- 行模型

const LIST_LINE_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;
const BOX_RE = /^\[([ xX])\][ \t]?/;

export interface ListLine {
  /** 前导空白原文(tab/空格保真,与 enterContinueListItem 同一约定) */
  indent: string;
  /** "-" / "*" / "+" / "1." / "2)" */
  marker: string;
  /** marker 与内容之间的空白 */
  gap: string;
  /** checkbox 状态;null = 普通列表项(没有 checkbox) */
  box: " " | "x" | "X" | null;
  /** checkbox 之后(无 checkbox 时为 marker 之后)的行内容 */
  text: string;
}

export function parseListLine(text: string): ListLine | null {
  const m = LIST_LINE_RE.exec(text);
  if (!m) return null;
  let box: ListLine["box"] = null;
  let content = m[4];
  const b = BOX_RE.exec(content);
  if (b) {
    box = b[1] as ListLine["box"];
    content = content.slice(b[0].length);
  }
  return { indent: m[1], marker: m[2], gap: m[3], box, text: content };
}

/** 是否为待办行(带 checkbox 的列表项)。 */
export function isTodo(l: ListLine | null): l is ListLine & { box: " " | "x" | "X" } {
  return l !== null && l.box !== null;
}

/** 待办的身份文本:剥掉 ✅ 完成戳、去两端空白。链接锚与条目匹配都用它。 */
export function todoText(l: ListLine): string {
  return l.text.replace(DONE_STAMP_RE, "").trim();
}

/** 文档第 n 行(1-based)的待办身份文本;该行不是待办时返回 null。 */
export function todoTextAt(doc: Text, lineNo: number): string | null {
  const p = parseListLine(doc.line(lineNo).text);
  return isTodo(p) ? todoText(p) : null;
}

// ---------------------------------------------------------------- 块提取

/**
 * 行所在的待办块根:从 `lineNo` 沿「更浅缩进的连续祖先链」向上走。空行或
 * 非列表行断链;同级/更深行是兄弟或子辈,跳过继续。顶层缩进(0)直接是根。
 * 步数上限 500 是防 malformed 文档(超长同级链)的保险,正常块远小于此。
 */
export function blockRootLine(doc: Text, lineNo: number): number {
  const cur = parseListLine(doc.line(lineNo).text);
  if (!cur) return lineNo;
  let depth = cur.indent.length;
  if (depth === 0) return lineNo;
  let root = lineNo;
  for (let n = lineNo - 1; n >= 1 && lineNo - n <= 500; n--) {
    const p = parseListLine(doc.line(n).text);
    if (!p) break;
    if (p.indent.length < depth) {
      root = n;
      depth = p.indent.length;
      if (depth === 0) break;
    }
  }
  return root;
}

/** 待办块的最后一行:根之后连续的更深列表行(空行/非列表/同深即止)。 */
export function blockEnd(doc: Text, rootNo: number): number {
  const root = parseListLine(doc.line(rootNo).text);
  if (!root) return rootNo;
  let end = rootNo;
  for (let n = rootNo + 1; n <= doc.lines; n++) {
    const p = parseListLine(doc.line(n).text);
    if (!p || p.indent.length <= root.indent.length) break;
    end = n;
  }
  return end;
}

/** 块的行文本(根 + 其下更深列表行)。 */
export function blockLines(doc: Text, rootNo: number): string[] {
  const out: string[] = [];
  for (let n = rootNo; n <= blockEnd(doc, rootNo); n++) out.push(doc.line(n).text);
  return out;
}

/**
 * 重缩进块:每行剥掉最多 `stripLen` 个前导空白(只剥空白字符,不会啃进
 * marker),再统一加上目标根缩进——子行的相对缩进保真。源块根缩进为
 * `stripLen`,目标根缩进为 `toIndent`。
 */
export function reindentBlock(lines: string[], stripLen: number, toIndent: string): string[] {
  if (stripLen <= 0 && toIndent === "") return lines;
  const strip = new RegExp(`^[ \\t]{0,${stripLen}}`);
  return lines.map((l) => toIndent + l.replace(strip, ""));
}

// ---------------------------------------------------------------- 日记待办区

const BLANK_RE = /^\s*$/;
const HEADER_RE = /^#\s/;

/** 日记文件头部待办区里的一条一级条目(1-based 行区间)。 */
export interface DailyEntry {
  start: number;
  end: number;
}

export interface DailyRegion {
  /** 头部 H1 行号(1-based);无头部为 0。 */
  headerEnd: number;
  /** 一级条目(按文档顺序)。 */
  entries: DailyEntry[];
  /** 区域内最后一个列表行;无条目时等于 headerEnd。 */
  lastListLine: number;
}

/**
 * 日记文件的结构:可选的 `# 标题` 行,其后(跳过空行)是待办区——连续的
 * 列表行,一级条目从缩进 0 的列表行开始、更深层行归入当前条目;条目间的
 * 单个空行是分隔符(其后仍是列表行才属于区域)。首个非空非列表行结束
 * 待办区,之后是用户正文。
 */
export function parseDailyRegion(doc: Text): DailyRegion {
  const headerEnd = doc.lines >= 1 && HEADER_RE.test(doc.line(1).text) ? 1 : 0;
  let i = headerEnd + 1;
  while (i <= doc.lines && BLANK_RE.test(doc.line(i).text)) i++;
  const entries: DailyEntry[] = [];
  let cur: DailyEntry | null = null;
  let lastListLine = headerEnd;
  for (; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (BLANK_RE.test(text)) {
      if (i + 1 <= doc.lines && parseListLine(doc.line(i + 1).text)) continue;
      break;
    }
    const p = parseListLine(text);
    if (!p) break;
    if (p.indent.length === 0) {
      cur = { start: i, end: i };
      entries.push(cur);
    } else if (cur) {
      cur.end = i;
    } else {
      break; // 顶层条目出现之前的深层行:不当成待办区
    }
    lastListLine = i;
  }
  return { headerEnd, entries, lastListLine };
}

/** 在区域里找身份文本为 `normalized` 的条目;同文多条时取离 `nearLine` 最近者。 */
export function findEntryByText(
  doc: Text,
  region: DailyRegion,
  normalized: string,
  nearLine: number,
): DailyEntry | null {
  let best: DailyEntry | null = null;
  let bestDist = Infinity;
  for (const e of region.entries) {
    const p = parseListLine(doc.line(e.start).text);
    if (!isTodo(p) || todoText(p) !== normalized) continue;
    const d = Math.abs(e.start - nearLine);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 改动 spec

export interface DocChange {
  from: number;
  to?: number;
  insert?: string;
}

/**
 * 追加一条一级条目(时间顺序:紧跟最后一个条目;区域为空时在头部之后,
 * 无头部且非空文档时顶到文件头)。返回的行号是新区条目在新文档中的区间。
 */
export function appendEntrySpec(
  doc: Text,
  region: DailyRegion,
  block: string[],
): { change: DocChange; entry: DailyEntry } {
  const text = block.join("\n");
  let at: number;
  let start: number;
  if (region.entries.length > 0) {
    at = doc.line(region.lastListLine).to;
    start = region.lastListLine + 1;
  } else if (region.headerEnd >= 1) {
    at = doc.line(region.headerEnd).to;
    start = region.headerEnd + 2; // 头部 + 一个空行
  } else if (doc.length === 0) {
    at = 0;
    start = 1;
  } else {
    at = 0;
    start = 1;
  }
  const lines = text === "" ? 0 : text.split("\n").length;
  const insert =
    region.entries.length > 0 ? "\n" + text : region.headerEnd >= 1 ? "\n\n" + text : doc.length === 0 ? text : text + "\n\n";
  return { change: { from: at, insert }, entry: { start, end: start + Math.max(0, lines - 1) } };
}

/** 用新块整段替换一个条目。 */
export function replaceEntrySpec(doc: Text, entry: DailyEntry, block: string[]): DocChange {
  return { from: doc.line(entry.start).from, to: doc.line(entry.end).to, insert: block.join("\n") };
}

/** 删除一个条目(整行语义,连换行一起删);其后紧跟的一个空行一并删掉,
 * 避免反复增删攒出成串空行;删到文件尾(区域清空)时,头部后的分隔空行
 * 也一并收掉,不留真空尾巴。 */
export function removeEntrySpec(doc: Text, entry: DailyEntry): DocChange {
  const afterEnd = entry.end + 1;
  let from = doc.line(entry.start).from;
  let to: number;
  if (afterEnd <= doc.lines && BLANK_RE.test(doc.line(afterEnd).text)) {
    to = afterEnd + 1 <= doc.lines ? doc.line(afterEnd + 1).from : doc.length;
  } else {
    to = afterEnd <= doc.lines ? doc.line(afterEnd).from : doc.length;
  }
  if (to >= doc.length && entry.start > 1 && BLANK_RE.test(doc.line(entry.start - 1).text)) {
    from = doc.line(entry.start - 1).from;
  }
  return { from, to };
}

/** 把改动 spec 应用到文档文本(纯字符串运算,用于盘外文件的读写)。 */
export function textAfterChanges(docText: string, specs: DocChange[]): string {
  const state = EditorStateOf(docText);
  return state.update({ changes: specs }).state.doc.toString();
}

// ---------------------------------------------------------------- 路径与定位

const DAILY_FILE_RE = /\/Daily\/\d{4}-\d{2}-\d{2}\.md$/;

/** 是否为日记文件(`<vault>/Daily/YYYY-MM-DD.md`,任意一天)。 */
export function isDailyPath(path: string): boolean {
  return DAILY_FILE_RE.test(path);
}

/** 某天的日记文件绝对路径。 */
export function dailyPathFor(vaultRoot: string, day: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/Daily/${day}.md`;
}

/** 新建日记的初始内容。发送/记录路径与「打开今日日记」共用同一份形状
 *  (H1 + 其后的待办区),两个入口建出来的文件因此逐字节一致。 */
export function dailyScaffold(day: string): string {
  return `# ${day}\n`;
}

/** 链接元数据文件路径(vault 内,随仓库走)。 */
export function linksFilePath(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/.bnote/daily-links.json`;
}

/**
 * 在文档里找身份文本为 `texts` 之一的待办块根行:先试 hint 行,再在
 * hint ±30 行窗口内按距离找,最后全文找(防抖后的低频路径,可接受)。
 * 找不到返回 null。
 */
export function resolveRootLine(doc: Text, texts: string[], hint: number | null): number | null {
  const want = new Set(texts);
  const matchAt = (n: number) => {
    const t = todoTextAt(doc, n);
    return t !== null && want.has(t);
  };
  if (hint !== null && hint >= 1 && hint <= doc.lines && matchAt(hint)) return hint;
  if (hint !== null) {
    const from = Math.max(1, hint - 30);
    const to = Math.min(doc.lines, hint + 30);
    for (let n = from; n <= to; n++) if (matchAt(n)) return n;
  }
  for (let n = 1; n <= doc.lines; n++) if (matchAt(n)) return n;
  return null;
}

function EditorStateOf(docText: string): EditorState {
  return EditorState.create({ doc: docText });
}

// ---------------------------------------------------------------- 待办跟随(rollover)

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** 块内保留行:未完成行 + 未完成后代的祖先锚链;全无未完成返回 null。 */
function carriedLines(doc: Text, rootNo: number, endNo: number): string[] | null {
  const indent: number[] = [];
  const kept: boolean[] = [];
  for (let n = rootNo; n <= endNo; n++) {
    const p = parseListLine(doc.line(n).text);
    if (!p) break; // blockEnd 保证到 endNo 都是列表行
    indent.push(p.indent.length);
    kept.push(p.box === " ");
  }
  // 自底向上补锚:更深的连续子树窗口里有被保留的后代,本行就得留下,否则
  // 层级断链。窗口在第一个 ≤ 本行缩进的行处封闭,不会越过兄弟子树。
  for (let i = kept.length - 2; i >= 0; i--) {
    if (kept[i]) continue;
    for (let j = i + 1; j < kept.length && indent[j] > indent[i]; j++) {
      if (kept[j]) {
        kept[i] = true;
        break;
      }
    }
  }
  if (!kept.some(Boolean)) return null;
  const lines: string[] = [];
  for (let i = 0; i < kept.length; i++) if (kept[i]) lines.push(doc.line(rootNo + i).text);
  return lines;
}

/** 一级列表块(围栏代码内不算):根行号、块尾行号。根为缩进 0 的列表行
 *  (待办或普通 bullet——过滤留给调用方按语义决定)。 */
function topBlocks(doc: Text, fenced: boolean[]): { rootNo: number; endNo: number }[] {
  const out: { rootNo: number; endNo: number }[] = [];
  let n = 1;
  while (n <= doc.lines) {
    if (fenced[n - 1]) {
      n++;
      continue;
    }
    const p = parseListLine(doc.line(n).text);
    if (!p || p.indent.length > 0) {
      n++;
      continue;
    }
    const end = blockEnd(doc, n);
    out.push({ rootNo: n, endNo: end });
    n = end + 1;
  }
  return out;
}

/**
 * 待办跟随(rollover)的块提取:日记文件里所有含未完成的块(含纯 bullet
 * 根与空文本待办——日记里的手写形状不做特判),跟随规则见 carriedLines。
 */
export function rolloverBlocks(prevText: string): string[][] {
  const doc = EditorState.create({ doc: prevText }).doc;
  const fenced = fenceStateScan(doc);
  const out: string[][] = [];
  for (const b of topBlocks(doc, fenced)) {
    const carried = carriedLines(doc, b.rootNo, b.endNo);
    if (carried) out.push(carried);
  }
  return out;
}

/** 源文件里要自动聚合进当日日记的一个待办块。 */
export interface AutoSyncBlock {
  /** 源文件里的根行号(1-based),链接的就近提示。 */
  rootLine: number;
  /** 根的待办身份文本(非空,链接锚)。 */
  text: string;
  /** 要复制的行(根 + 子树里未完成行与锚链)。 */
  lines: string[];
}

/**
 * 源文件的自动聚合提取:与 rolloverBlocks 同一条 carriedLines 规则,但根必须
 * 是待办且身份文本非空——链接锚靠根文本互认,普通 bullet 根与空文本起不了锚
 * (这类块不自动同步;日记 rollover 不受限,因为那边是快照复制)。
 */
export function autoSyncBlocks(fileText: string): AutoSyncBlock[] {
  const doc = EditorState.create({ doc: fileText }).doc;
  const fenced = fenceStateScan(doc);
  const out: AutoSyncBlock[] = [];
  for (const b of topBlocks(doc, fenced)) {
    const root = parseListLine(doc.line(b.rootNo).text);
    if (!root || root.box === null) continue;
    const text = todoText(root);
    if (text === "") continue;
    const carried = carriedLines(doc, b.rootNo, b.endNo);
    if (carried) out.push({ rootLine: b.rootNo, text, lines: carried });
  }
  return out;
}

/** Daily/ 目录的文件名里,早于 `today` 的最近一篇日记日期;没有返回 null。
 *  隔了几天没写日记就跟最近那篇,不是严格意义上的「昨天」。 */
export function previousDailyFile(names: string[], today: string): string | null {
  let best: string | null = null;
  for (const name of names) {
    const m = DATE_FILE_RE.exec(name);
    if (!m || m[1] >= today) continue;
    if (best === null || m[1] > best) best = m[1];
  }
  return best;
}

/** 新一天日记的初始内容:裸 scaffold + 逐块 appendEntrySpec,与引擎写盘
 *  同一形状(H1 + 空行 + 条目单换行相邻,文件尾单换行)。 */
export function composeDailyScaffold(day: string, blocks: string[][]): string {
  let text = dailyScaffold(day);
  for (const block of blocks) {
    const doc = EditorState.create({ doc: text }).doc;
    const { change } = appendEntrySpec(doc, parseDailyRegion(doc), block);
    text = textAfterChanges(text, [change]);
  }
  return text;
}
