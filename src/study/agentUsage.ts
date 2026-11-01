/**
 * Model and context information in the study assistant footer. The usage comes
 * from the backend's streaming response (Anthropic message_start /
 * message_delta, the trailing usage of OpenAI stream_options); context
 * occupancy = input + output of the most recent request (for a plain Q&A turn
 * that is the whole history).
 */

export interface AgentUsage {
  input: number;
  output: number;
}

/** Human-readable token count: 999 -> "999", 66_600 -> "66.6k", 420_000 -> "420k". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  const scaled = (divisor: number, suffix: string) => {
    const v = n / divisor;
    const text = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
    return `${text}${suffix}`;
  };
  return n < 1_000_000 ? scaled(1000, "k") : scaled(1_000_000, "m");
}

/** Used / limit, e.g. "66.6k/420k"; without usage the used part shows "—". */
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

export function usageTitle(usage: AgentUsage | null, limit: number, model: string): string {
  const head = model || "未配置模型";
  if (!usage) return `${head} · 本轮回复后显示上下文占用(上限 ${formatTokenCount(limit)})`;
  const pct = occupancyPercent(usage, limit);
  return `${head} · 上下文 ${formatTokenCount(usage.input + usage.output)} / ${formatTokenCount(limit)}${
    pct === null ? "" : ` (${formatPercent(pct)})`
  } · 输入 ${formatTokenCount(usage.input)} · 输出 ${formatTokenCount(usage.output)}`;
}
