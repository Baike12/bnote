import type { KLineData } from "klinecharts";
import type { InvestBar } from "./types";

/**
 * The bars → klinecharts mapping — pure, so the chart stays display-only
 * glue (see the header comment in KlinePane.tsx). Timestamps anchor each
 * bar at its CN session close (15:00+08:00): klinecharts takes a display
 * timestamp only and the chart's x axis is date-only. The per-market close
 * semantics used for staleness live in staleness.ts; this module owns the
 * display axis. Volume converts shares → lots (the CN display convention,
 * 100 shares per lot).
 */
export function toKlineData(bars: InvestBar[]): KLineData[] {
  return bars.map((bar) => ({
    timestamp: new Date(`${bar.ts}T15:00:00+08:00`).getTime(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume / 100,
  }));
}
