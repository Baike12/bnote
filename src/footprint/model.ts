/**
 * 今日足迹的纯文本模型:块切分、块身份、今日增量 diff。全部函数只吃字符串,
 * 不做任何 IO——store 负责读盘与轮转编排,这里负责「今天记了什么」的唯一事实,
 * 所有规则都在 model.test.ts 里锁死。
 *
 * 语义:一个文件今天的足迹 = 「当前文本里有、今日基线里没有」的块。块是空行
 * 分隔的连续行;身份是块文本(每行去尾随空白、整块 trim)——行尾空格抖动与
 * 整体缩进调整不产生假新增,内容变了就是新块(显示新版本),删掉的块不显示
 * (引用式聚合只显示现存内容)。
 *
 * 待办块不进足迹:待办已有自己的日记通道(跨文件同步,镜像到日记头部)。
 * 同一份内容走两条通道会在日记里出现两份(同步一份 + 足迹一份),所以含
 * 待办行的块整块归同步管,-footprint 判定在 diff 的出口统一过滤。
 */

import { isTodo, parseListLine } from "@/daily/model";

/** 一个块:空行分隔的连续行。start/end 为 1-based 行号,指向它所在的文本。 */
export interface FootprintBlock {
  /** 块的行文本(不含结尾换行)。 */
  text: string;
  start: number;
  end: number;
}

const BLANK_RE = /^\s*$/;

/** 块内是否含待办行(判定与待办同步引擎同源:parseListLine + isTodo)。 */
export function blockHasTodo(text: string): boolean {
  return text.split("\n").some((l) => isTodo(parseListLine(l)));
}

/** 把文档切成空行分隔的块(1-based 行区间)。首尾空行、连续空行都不成块。 */
export function blocksOf(text: string): FootprintBlock[] {
  const lines = text.split("\n");
  const out: FootprintBlock[] = [];
  let start = -1; // 当前块 0-based 起始;-1 = 不在块中
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || BLANK_RE.test(lines[i]);
    if (!blank && start < 0) start = i;
    if (blank && start >= 0) {
      out.push({ text: lines.slice(start, i).join("\n"), start: start + 1, end: i });
      start = -1;
    }
  }
  return out;
}

/**
 * 块的身份文本:每行去尾随空白、剥首尾空行、剥所有非空行的公共前导空白。
 * 「把列表整体再缩进一格」「删行尾空格」不产生假的新块;部分缩进变化
 * (公共前缀之外)仍算内容变化。
 */
export function blockKey(text: string): string {
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let prefix: string | null = null;
  for (const l of lines) {
    if (l === "") continue;
    const ind = /^[ \t]*/.exec(l)![0];
    prefix = prefix === null ? ind : commonWhitespace(prefix, ind);
    if (prefix === "") break;
  }
  if (prefix) {
    return lines.map((l) => (l === "" ? l : l.slice(prefix!.length))).join("\n");
  }
  return lines.join("\n");
}

/** 两个前导空白串的公共前缀(逐字符:tab 与空格各自算)。 */
function commonWhitespace(a: string, b: string): string {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}

/**
 * 今日增量:当前文本里身份不在基线中的块(带当前文本中的行号,供跳转)。
 * `baseline` 为 null(基线缺失 = 今日新建的文件)时全部块都算今日记录。
 * 含待办的块在出口统一排除(见模块注释)。
 */
export function diffBlocks(baseline: string | null, current: string): FootprintBlock[] {
  const blocks = blocksOf(current).filter((b) => !blockHasTodo(b.text));
  if (baseline === null) return blocks;
  const known = new Set<string>();
  for (const b of blocksOf(baseline)) known.add(blockKey(b.text));
  if (known.size === 0) return blocks;
  return blocks.filter((b) => !known.has(blockKey(b.text)));
}

// ---------------------------------------------------------------- 路径与归属

const NOTE_FILE_RE = /\.(md|markdown|txt)$/i;

/** 可聚合的笔记文件:`.md`/`.markdown`/`.txt`,且不在仓库的 Daily/ 目录下
 *  (日记互不聚合,避免自我嵌套)。 */
export function isAggregatePath(path: string, vaultRoot: string): boolean {
  if (!NOTE_FILE_RE.test(path)) return false;
  const root = vaultRoot.replace(/\/+$/, "");
  if (!path.startsWith(root + "/")) return false;
  return !path.startsWith(`${root}/Daily/`);
}

// ---------------------------------------------------------------- 持久化形状

/** v1(旧):只有一份「今日基线」,跨天轮转即作废——历史日记无从聚合。 */
export interface StoredFootprintsV1 {
  version: 1;
  day: string;
  baselines: Record<string, string>;
}

/**
 * v2:基线之外保留历史足迹档。`history[日期][路径]` = 那一天新增块的固化
 * 快照——轮转时由旧基线 diff 出来写死,之后只读不重算,打开历史日记据此
 * 聚合当天的足迹。日记文件零污染的语义不变:映射关系只存在这一个元数据
 * 文件里,不写进任何日记。
 */
export interface StoredFootprints {
  version: 2;
  /** 基线归属日(YYYY-MM-DD);与今天不同 = 需要轮转。 */
  day: string;
  /** 今日基线:绝对路径 → 天切换时刻的全文。 */
  baselines: Record<string, string>;
  /** 历史足迹档:日期 → 绝对路径 → 当日足迹块(带当时行号,供跳转)。 */
  history: Record<string, Record<string, FootprintBlock[]>>;
}

/** 基线元数据文件路径(vault 内,随仓库走)。 */
export function footprintsFilePath(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/.bnote/daily-footprints.json`;
}
