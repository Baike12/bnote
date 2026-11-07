/**
 * Model and context information in the study assistant footer. The usage comes
 * from the backend's streaming response (Anthropic message_start /
 * message_delta, the trailing usage of OpenAI stream_options); context
 * occupancy = input + output of the most recent request (for a plain Q&A turn
 * that is the whole history). `cacheRead` is the share of the input the
 * provider served from its prompt cache — reported so the UI can show a cache
 * hit rate; some gateways (MiniMax) only send the input side in the final
 * message_delta, which the backend folds in.
 */

export interface AgentUsage {
  input: number;
  output: number;
  /** Input tokens served from the provider's prompt cache (subset of input). */
  cacheRead: number;
}

/** Human-readable token count, zh style: 999 -> "999", 195_000 -> "19.5万", 420_000 -> "42万". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 10_000) return String(Math.round(n));
  if (n < 100_000_000) {
    const v = n / 10_000;
    return `${v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "")}万`;
  }
  return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
}

/** Used / limit, e.g. "19.5万/42万"; without usage the used part shows "—". */
export function contextLabel(usage: AgentUsage | null, limit: number): string {
  const used = usage ? usage.input + usage.output : null;
  return `${used === null ? "—" : formatTokenCount(used)}/${limit > 0 ? formatTokenCount(limit) : "—"}`;
}

/** Occupancy percentage (0..999); null when there is no usage or the limit is invalid. */
export function occupancyPercent(usage: AgentUsage | null, limit: number): number | null {
  if (!usage || !(limit > 0)) return null;
  return Math.min(999, ((usage.input + usage.output) / limit) * 100);
}

export function formatPercent(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

/**
 * Share of the input the provider served from its prompt cache (0..1); null
 * when the provider does not report cache reads or the input is empty.
 */
export function cacheHitRate(usage: AgentUsage | null): number | null {
  if (!usage || usage.cacheRead <= 0 || usage.input <= 0) return null;
  return Math.min(1, usage.cacheRead / usage.input);
}

export function usageTitle(usage: AgentUsage | null, limit: number, model: string): string {
  const head = model || "未配置模型";
  if (!usage) return `${head} · 本轮回复后显示上下文占用(上限 ${formatTokenCount(limit)})`;
  const pct = occupancyPercent(usage, limit);
  const rate = cacheHitRate(usage);
  return (
    `${head} · 上下文 ${formatTokenCount(usage.input + usage.output)} / ${formatTokenCount(limit)}${
      pct === null ? "" : ` (${formatPercent(pct)})`
    }` +
    ` · 输入 ${formatTokenCount(usage.input)} · 输出 ${formatTokenCount(usage.output)}` +
    (rate === null ? "" : ` · 缓存命中 ${formatPercent(rate * 100)}`)
  );
}
