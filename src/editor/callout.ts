import { EditorState, type Text } from "@codemirror/state";
import { fenceStateScan, mathRegionsForDoc } from "./context";
import type { MathRegion } from "./mathScan";

/**
 * Callout 块(`:::` 容器):笔记里承接「与正文不那么一体的外部内容」的块——
 * 独立底色 + 左侧竖线,内容照常按 markdown 渲染(标题/公式/代码块全部走既有
 * 装饰路径),块内标题编号独立于外部(numbering.ts 按这里的区域重置计数器)。
 *
 * 语法(只认栏 0,3 个及以上冒号):
 *   ::: 可选标题   → 开。有非空文字 = 标题,渲染成块顶的小标签;无文字 = 无
 *                    标题的裸块(不需要 Obsidian 的 [!note] 类型名)。
 *   :::           → 栈式语义:在块外 = 开一个无标题块,在块内 = 关最内层。
 *                    与代码围栏「同一标记开关」的手感一致;带文字的标记必开,
 *                    嵌套内层因此用 `::: 标题` 开。
 * 选择 `:::` 容器而不是 Obsidian 的 `> [!note]`:blockquote 方案的内容行全部
 * 带 `>` 前缀——bnote 不隐藏 `>` 标记(截图里那种干净块面做不出来),且
 * mathScan 按纯文本配对 `$$`,不认 `>` 前缀,块内公式渲染会坏。`:::` 容器的
 * 内容行是干净 markdown,lezer/mathScan/既有装饰原样生效,一行接入成本为零。
 *
 * 扫描与 fenceStateScan 同一条模型:纯行扫描(不依赖语法树,文件刚载入树未
 * 解析时答案也完整确定),按行推进配对;围栏代码行与公式块内的 `:::` 一律
 * 忽略(代码围栏里它是字面量,`$$` 块里它属于公式源码);未闭合延伸到文末,
 * 与未闭合围栏同款。
 */

export interface CalloutRegion {
  /** 开标记行行首。整块范围 [from, to] 含两行边界标记。 */
  from: number;
  /** 关标记行行尾;未闭合时为文末行行尾。 */
  to: number;
  /** 开标记行号(1-based)。 */
  openLine: number;
  /** 关标记行号(1-based);未闭合 = 最后一行。 */
  closeLine: number;
  /** 开标记 `:::` 之后的文字(trim 过;空串 = 无标题)。 */
  title: string;
  /** 嵌套深度,0 = 最外层。 */
  depth: number;
  /** false = 未闭合(延伸到文末)。 */
  closed: boolean;
}

const MARKER_RE = /^(:{3,})(.*)$/;

/**
 * 纯函数版扫描:调用方已持有围栏状态/公式区域时直接传入(numbering 的重编号
 * 本来就算了一遍围栏扫描,不重复付)。返回按 from 升序——外层区域必在嵌套
 * 内层之前,依赖顺序的消费者(逐行深度标注)可安全覆盖。
 */
export function computeCalloutRegions(
  doc: Text,
  fences: boolean[],
  maths: MathRegion[],
): CalloutRegion[] {
  const out: CalloutRegion[] = [];
  const stack: { openLine: number; from: number; title: string; depth: number }[] = [];
  // 只有可能跨行的 display 公式区域容得下一个栏 0 的 `:::`(行内区域起点是
  // `$`,起点在栏 0 的行首不可能是 `:::` 行);按 from 有序,随行推进一次扫过。
  const display = maths.filter((r) => r.display);
  let mi = 0;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    while (mi < display.length && display[mi].to < line.from) mi++;
    const inMath =
      mi < display.length && display[mi].from <= line.from && line.from <= display[mi].to;
    if (fences[n - 1] || inMath) continue;
    const m = MARKER_RE.exec(line.text);
    if (!m) continue;
    const rest = m[2].trim();
    if (stack.length > 0 && rest === "") {
      const open = stack.pop()!;
      out.push({
        from: open.from,
        to: line.to,
        openLine: open.openLine,
        closeLine: n,
        title: open.title,
        depth: open.depth,
        closed: true,
      });
    } else {
      stack.push({ openLine: n, from: line.from, title: rest, depth: stack.length });
    }
  }
  const lastLine = doc.line(doc.lines);
  while (stack.length > 0) {
    const open = stack.pop()!;
    out.push({
      from: open.from,
      to: lastLine.to,
      openLine: open.openLine,
      closeLine: doc.lines,
      title: open.title,
      depth: open.depth,
      closed: false,
    });
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}

const cache = new WeakMap<Text, CalloutRegion[]>();

/** Callout regions of the document, memoized per Text generation(装饰热路径)。 */
export function calloutRegions(state: EditorState): CalloutRegion[] {
  let regions = cache.get(state.doc);
  if (!regions) {
    const doc = state.doc;
    regions = computeCalloutRegions(doc, fenceStateScan(doc), mathRegionsForDoc(doc));
    cache.set(doc, regions);
  }
  return regions;
}
