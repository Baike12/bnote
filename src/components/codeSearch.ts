/**
 * 设置里代码框的搜索:字面量、忽略大小写,返回文档偏移。
 *
 * 用正则的 `i` 标志而不是把两边先 toLowerCase —— 某些 Unicode 大小写折叠
 * 会改变长度(`İ` → `i̇`),先折叠再找位置会让偏移整体错位。
 */
export interface TextMatch {
  from: number;
  to: number;
}

/** 一个字符的查询能命中上万处:计数与装饰都没必要跟到底。 */
export const MAX_MATCHES = 2000;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findMatches(text: string, query: string): TextMatch[] {
  if (!query) return [];
  const re = new RegExp(escapeRegExp(query), "gi");
  const out: TextMatch[] = [];
  for (const m of text.matchAll(re)) {
    const from = m.index ?? 0;
    out.push({ from, to: from + m[0].length });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}
