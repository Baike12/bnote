/**
 * 辅助会话(从某条消息分叉)的前端纯逻辑。
 *
 * 分叉点携带的 `items`(后端历史前缀条数)来自 turn_end / error 事件携带的
 * 后端权威计数,所以这里只负责:消息 → 截断点(取自己或最近前一条的计数)、
 * 会话标签(消息首行摘要)。
 */

export interface ConversationEntryLike {
  role: "user" | "assistant";
  /** 本条消息对应的会话历史前缀条数(含本条);null = 后端还没给出。 */
  items: number | null;
}

/**
 * 第 `index` 条消息的分叉截断点:优先用它自己的计数;出错的消息后端没有
 * 给出计数时,退到最近一条有计数的消息(丢弃这段不确定的尾部)。
 */
export function forkCutoff(entries: ConversationEntryLike[], index: number): number {
  for (let i = Math.min(index, entries.length - 1); i >= 0; i -= 1) {
    const count = entries[i].items;
    if (count !== null) return count;
  }
  return 0;
}

/** 会话标签:首行截断。空文本回退到占位符。 */
export function forkLabel(text: string, max = 18): string {
  const line = (text.trim().split("\n")[0] ?? "").trim();
  if (!line) return "空消息";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
