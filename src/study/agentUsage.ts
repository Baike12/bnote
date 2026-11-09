/**
 * Model and context information in the study assistant footer. The usage comes
 * from the backend's streaming response (Anthropic message_start /
 * message_delta, the trailing usage of OpenAI stream_options); context
 * occupancy = input + output of the most recent request (for a plain Q&A turn
 * that is the whole history). `cacheRead` is the share of the input the
 * provider served from its prompt cache; some gateways (MiniMax) only send the
 * input side in the final message_delta, which the backend folds in.
 *
 * The cache rate shown is the session's, token-weighted over every main-turn
 * request (`sessionCacheRead / sessionInput`) — the definition ZCode fixes in
 * `docs/context-cache-hit-rate.md`. A single request says nothing: the first
 * one of a conversation can only miss, and a changed byte in the prompt prefix
 * resets the window (see `src-tauri/tests/prompt_cache.rs`).
 */

export interface AgentUsage {
  input: number;
  output: number;
  /** Input tokens served from the provider's prompt cache (subset of input). */
  cacheRead: number;
  /** The same numbers accumulated over every request of the session. */
  sessionInput: number;
  sessionCacheRead: number;
  sessionRequests: number;
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

/**
 * What the context card reports.
 *
 * The provider's number (input + output of the last request) is the truth, but
 * it only exists after a request: a session restored from disk has messages
 * and no usage. The card then printed "—/42万" over an empty bar, although the
 * breakdown it had just fetched names every part of the context. In that state
 * it falls back to the backend's estimate (the sum of the parts), marked as an
 * estimate.
 */
export interface ContextOccupancy {
  used: number;
  /** `used` is the backend's estimate, not a provider-reported usage. */
  estimated: boolean;
  percent: number | null;
}

export function contextOccupancy(
  usage: AgentUsage | null,
  limit: number,
  estimated: number | null,
): ContextOccupancy | null {
  const reported = usage ? usage.input + usage.output : null;
  const used = reported ?? (estimated !== null && estimated > 0 ? estimated : null);
  if (used === null) return null;
  return {
    used,
    estimated: reported === null,
    percent: limit > 0 ? Math.min(999, (used / limit) * 100) : null,
  };
}

export function formatPercent(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

/** The latest request's hit rate (0..1); null when it reports no cache reads. */
export function cacheHitRate(usage: AgentUsage | null): number | null {
  if (!usage || usage.cacheRead <= 0 || usage.input <= 0) return null;
  return Math.min(1, usage.cacheRead / usage.input);
}

/**
 * The session's token-weighted hit rate (0..1): `sum(cacheRead) / sum(input)`.
 * `input` already carries the cached part, so it is the only denominator;
 * null until the session has made a request.
 */
export function sessionHitRate(usage: AgentUsage | null): number | null {
  if (!usage || usage.sessionInput <= 0) return null;
  return Math.min(1, usage.sessionCacheRead / usage.sessionInput);
}

export function usageTitle(usage: AgentUsage | null, limit: number, model: string): string {
  const head = model || "未配置模型";
  if (!usage) return `${head} · 本轮回复后显示上下文占用(上限 ${formatTokenCount(limit)})`;
  const pct = occupancyPercent(usage, limit);
  const rate = sessionHitRate(usage);
  const latest = cacheHitRate(usage);
  return (
    `${head} · 上下文 ${formatTokenCount(usage.input + usage.output)} / ${formatTokenCount(limit)}${
      pct === null ? "" : ` (${formatPercent(pct)})`
    }` +
    ` · 输入 ${formatTokenCount(usage.input)} · 输出 ${formatTokenCount(usage.output)}` +
    (rate === null
      ? ""
      : ` · 缓存命中 ${formatPercent(rate * 100)}(${usage.sessionRequests} 次请求)`) +
    (latest === null ? "" : ` · 本轮 ${formatPercent(latest * 100)}`)
  );
}
