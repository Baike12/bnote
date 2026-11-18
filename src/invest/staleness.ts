/**
 * Data staleness for the invest toolbar — the single converter from a bar's
 * as-of date to "how old is this dataset". The blind test flagged staleness
 * as invisible; the first version aged every market at the CN close
 * (15:00+08:00), which made a fresh US bar read one day old — each market
 * closes in its own session timezone here.
 */

/** Bar close per market, in the market's own zone. The US offset is winter
 * ET: the DST drift (±1h) is three orders of magnitude below the 7-day
 * stale threshold, and "16:00 America/New_York" without a date library
 * cannot know the DST state of a past bar anyway. */
const CLOSE_RULES: Record<string, { time: string; offset: string }> = {
  cn: { time: "15:00:00", offset: "+08:00" },
  hk: { time: "16:00:00", offset: "+08:00" },
  us: { time: "16:00:00", offset: "-05:00" },
};

/** Whole days since the bar's session close; null when the timestamp is
 * invalid or in the future (a clock skew must not read as "negative age"). */
export function staleDays(lastBarTs: string, market: string, nowMs: number): number | null {
  const rule = CLOSE_RULES[market] ?? CLOSE_RULES.cn;
  const closeMs = new Date(`${lastBarTs}T${rule.time}${rule.offset}`).getTime();
  if (!Number.isFinite(closeMs)) return null;
  const days = Math.floor((nowMs - closeMs) / 86_400_000);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

/** The toolbar label: the as-of date, flagged once the data is > 7 days old
 * (a stale dataset must be visible as stale, or every metric on top of it
 * is quietly wrong). */
export function stalenessLabel(
  lastBarTs: string | undefined,
  market: string,
  nowMs: number,
): string | null {
  if (!lastBarTs) return null;
  const days = staleDays(lastBarTs, market, nowMs);
  if (days == null) return null;
  const label = `数据截至 ${lastBarTs}`;
  return days > 7 ? `⚠ ${label}(已 ${days} 天未更新)` : label;
}
