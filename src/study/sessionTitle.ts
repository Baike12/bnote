/**
 * 会话标题:本地兜底(首条消息截断)与模型生成的标题共用同一套清洗规则。
 *
 * 模型返回的标题经常带引号、书名号、`标题：` 前缀或句末句号;列表和头部
 * 都是单行省略的窄位置,清洗必须在写入前做完,否则那些符号会占掉可见宽度。
 */

/** 会话自有第一条用户消息(跳过分叉复制过来的前缀)。 */
export function firstOwnUserText(
  entries: ReadonlyArray<{ role: string; text: string }>,
  forkAt: number,
): string {
  const start = Math.max(0, Math.min(forkAt, entries.length));
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry?.role !== "user") continue;
    const text = entry.text.trim();
    if (text) return text;
  }
  return "";
}

/** 模型标题外面可能套的一对符号(成对出现才剥)。 */
const WRAPPERS: Array<[string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['《', '》'],
  ["'", "'"],
  ['`', '`'],
  ['*', '*'],
];

/** 模型爱加的前缀:「标题：」「Title:」「会话标题 - 」之类。 */
const PREFIX_RE = /^(?:会话)?标题\s*[:：\-–—]\s*|^title\s*[:：\-–—]\s*/i;

/**
 * 清洗模型给的标题:取第一行、剥引号/前缀、去句末标点、压空白、截断。
 * 清洗后为空返回空串,调用方保留原兜底标题。
 */
export function cleanGeneratedTitle(raw: string, limit = 24): string {
  const firstLine = (raw ?? "").replace(/\r\n?/g, "\n").split("\n").find((l) => l.trim()) ?? "";
  let text = firstLine.replace(/\s+/g, " ").trim();
  text = text.replace(PREFIX_RE, "").trim();
  for (const [open, close] of WRAPPERS) {
    while (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
    }
  }
  text = text.replace(/[。．.、,，;；:：!！?？]+$/u, "").trim();
  return Array.from(text).slice(0, limit).join("").trim();
}

/** 子会话标题前缀:层级在头部按钮与历史列表里都要一眼可见。 */
export const AUX_TITLE_PREFIX = "↳ ";

/** 按会话层级给出最终展示标题(主会话无前缀)。 */
export function displayTitle(title: string, isAux: boolean): string {
  const clean = title.trim();
  if (!isAux) return clean;
  return clean.startsWith(AUX_TITLE_PREFIX) ? clean : `${AUX_TITLE_PREFIX}${clean}`;
}
