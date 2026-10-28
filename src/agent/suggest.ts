/**
 * 创作模式输入框的两种补全触发:
 * - `/skill-name`:选择技能(仅当 / 出现在文本开头或空白之后,避免吃掉路径与代码);
 * - `@path/to/file`:引用仓库文件(任意位置触发)。
 *
 * 触发词会原样发给模型;语义(/ 调 skill 工具、@ 读文件)由创作模式的
 * system prompt 解释,前端只负责把词补全得省力。
 */

export interface SuggestTrigger {
  kind: "skill" | "file";
  /** 触发词起点(含 / 或 @)在文本中的下标。 */
  start: number;
  /** / 或 @ 之后的查询串(触发点到光标之间,不含空白)。 */
  query: string;
}

/** 光标前最近的空白/词边界。 */
function lastWordStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === " " || ch === "\n" || ch === "\t") break;
    i -= 1;
  }
  return i;
}

/**
 * 解析光标处的补全触发。返回 null 表示没有触发。
 *
 * skill(`/`)只在词首触发(文本开头或前面是空白),`/数据/2026` 这类路径、
 * 行中间的斜杠都不会误触发;file(`@`)在任意位置触发(引用文件常紧跟正文)。
 */
export function parseSuggestTrigger(text: string, caret: number): SuggestTrigger | null {
  if (caret < 0 || caret > text.length) return null;
  const wordStart = lastWordStart(text, caret);
  const word = text.slice(wordStart, caret);
  if (word.startsWith("/")) {
    // 只在行首触发(文本开头或换行之后):`/数据/2026`、行中路径里的斜杠
    // 都不误触发;@ 不受此限,引用文件常紧跟正文。
    if (wordStart !== 0 && text[wordStart - 1] !== "\n") return null;
    return { kind: "skill", start: wordStart, query: word.slice(1) };
  }
  if (word.startsWith("@")) {
    return { kind: "file", start: wordStart, query: word.slice(1) };
  }
  return null;
}

/** 把触发词替换为完整引用;返回新文本与新光标位置。 */
export function applySuggestion(
  text: string,
  trigger: SuggestTrigger,
  replacement: string,
): { text: string; caret: number } {
  const insert = `${replacement} `;
  const next = text.slice(0, trigger.start) + insert + text.slice(trigger.start + 1 + trigger.query.length);
  const caret = trigger.start + insert.length;
  return { text: next, caret };
}
