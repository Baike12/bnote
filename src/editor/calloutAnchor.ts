import type { Text } from "@codemirror/state";
import type { CalloutRegion } from "./callout";

/**
 * Callout 锚点:正文里与某个 callout 标题「同一段文字」的文本片段。
 *
 * 选中一段文字按 ⌘⇧B 在文末建一个以它为标题的 callout(选中的原文留在原处),
 * 原文那一段从此是「有解释的入口」:渲染成下划虚线,光标停在其中再按 ⌘⇧B 跳到
 * 关联的 callout。关联不靠文档里的额外标记——标题本身就是身份,任何一次需要
 * 答案时按「标题与正文文本相等」现算:文件关掉重开、手工改标题都自然跟上,
 * 正文一个字节都不为这个功能改动。
 *
 * 匹配是空白弹性的:标题里的空白(建块时选区里的换行/过多空白压成的单空格)
 * 匹配正文里的任意空白序列(含换行)——跨行选中的原文因此仍能命中;非空白
 * 字符必须逐字符相等。不设词边界规则:用户选中的那段原文必须能命中,是这条
 * 匹配的最低要求,加边界规则反而会让「选中词 + 后随汉字」的常见形态失配。
 */

export interface Interval {
  from: number;
  to: number;
}

/** 一处命中:匹配区间 + 它指向的 callout 区域。 */
export interface AnchorHit extends Interval {
  region: CalloutRegion;
}

const isWsCode = (code: number) =>
  code === 32 || code === 9 || code === 10 || code === 13;

/** 标题(trim 过)在 doc[from, to) 内的全部匹配区间,按出现顺序。 */
export function findTitleMatches(
  doc: Text,
  from: number,
  to: number,
  title: string,
): Interval[] {
  const out: Interval[] = [];
  if (to <= from || title === "") return out;
  const parts = title.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return out;
  // 一次取整个窗口文本,indexOf 循环不再逐次切片(窗口是视口量级,复制廉价)。
  const text = doc.sliceString(from, to);
  const first = parts[0];
  let search = 0;
  for (;;) {
    const hit = text.indexOf(first, search);
    if (hit < 0) break;
    let p = hit + first.length;
    let ok = true;
    for (let i = 1; i < parts.length; i++) {
      const ws = p;
      while (p < text.length && isWsCode(text.charCodeAt(p))) p++;
      // 段与段之间必须有空白(标题的空格对应原文的换行/空白串),且下一段
      // 紧接着空白——正文里多出的任何非空白字符都算不同文本。
      if (p === ws || !text.startsWith(parts[i], p)) {
        ok = false;
        break;
      }
      p += parts[i].length;
    }
    if (ok) out.push({ from: from + hit, to: from + p });
    search = hit + 1;
  }
  return out;
}

/** 位置 `pos` 落在哪个锚点里;不在任何锚点内返回 null。 */
export function anchorRegionAt(
  doc: Text,
  callouts: CalloutRegion[],
  pos: number,
): CalloutRegion | null {
  const lineEnd = doc.lineAt(pos).to;
  for (const c of callouts) {
    if (c.title === "") continue;
    // 匹配可能从光标前若干字符开始、也可能延伸到光标后:按标题长度给一个
    // 保守的双向窗口(标题里的空白在原文里可以翻倍膨胀,取 4 倍余量)。
    const window = c.title.length * 4 + 64;
    const from = Math.max(0, pos - window);
    const to = Math.min(doc.length, Math.max(lineEnd, pos + window));
    for (const m of findTitleMatches(doc, from, to, c.title)) {
      if (pos >= m.from && pos < m.to) return c;
    }
  }
  return null;
}

/**
 * 文档 [from, to)(视口)内所有锚点。排除 callout 区域自身(标题行与块内文——
 * 块内的重复文本不是入口)与调用方给的排除区(围栏代码/行内代码:那里的
 * 文字是示例或字面量)。同一区间被多个同标题 callout 命中时只留一处。
 */
export function collectAnchors(
  doc: Text,
  callouts: CalloutRegion[],
  from: number,
  to: number,
  exclude: readonly Interval[],
): AnchorHit[] {
  const titled = callouts.filter((c) => c.title !== "");
  if (titled.length === 0 || to <= from) return [];
  const out: AnchorHit[] = [];
  const seen = new Set<string>();
  const clashes = (m: Interval) =>
    callouts.some((r) => m.from < r.to && m.to > r.from) ||
    exclude.some((r) => m.from < r.to && m.to > r.from);
  for (const c of titled) {
    for (const m of findTitleMatches(doc, from, to, c.title)) {
      const key = `${m.from}:${m.to}`;
      if (seen.has(key) || clashes(m)) continue;
      seen.add(key);
      out.push({ from: m.from, to: m.to, region: c });
    }
  }
  return out;
}
