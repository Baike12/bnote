import { useEffect, useRef } from "react";
import { dispose, init, type Chart } from "klinecharts";
import { toKlineData } from "@/invest/klineData";
import { marketOf, useInvestStore } from "@/invest/store";
import { stalenessLabel } from "@/invest/staleness";

/**
 * The middle column's K-line chart (klinecharts 9.x, the same charting
 * library hoshi uses): candlesticks + MA/VOL/MACD panes, wheel zoom, drag
 * pan, crosshair with the following tooltip.
 *
 * The data mapping lives in invest/klineData.ts (pure: `ts` → the session
 * close timestamp and shares → lots for display); this component is chart
 * lifecycle and interaction glue only.
 */

const UP_COLOR = "#ef5350";
const DOWN_COLOR = "#26a69a";

export function KlinePane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const bars = useInvestStore((s) => s.bars);
  const barsLoading = useInvestStore((s) => s.barsLoading);
  const period = useInvestStore((s) => s.period);
  const title = useInvestStore((s) => s.selectedTitle);
  const selectedScope = useInvestStore((s) => s.selectedScope);
  const setPeriod = useInvestStore((s) => s.setPeriod);
  const barsSource = bars[0]?.source ?? "";
  // H6: the raw source tag ("sample") is a developer term — map the known
  // ones to their user-facing names, keep unknown tags verbatim.
  const sourceLabel =
    { sample: "模拟数据", tencent: "实时行情", akshare: "akshare 导入" }[barsSource] ?? barsSource;
  // Data staleness (blind test Q-P1-17): the toolbar names the as-of date and
  // flags it once the data is more than 7 days old — a stale dataset must be
  // visible as stale, or every metric on top of it is quietly wrong. The
  // age computation lives in invest/staleness.ts (each market closes in its
  // own session timezone; the component only supplies the inputs).
  const staleLabel = stalenessLabel(
    bars[bars.length - 1]?.ts,
    marketOf(selectedScope ?? "", useInvestStore.getState().instruments),
    Date.now(),
  );

  // Create once; the chart instance survives data swaps (klinecharts diffs
  // internally — remounting per selection would drop the viewport state).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || chartRef.current) return;
    const chart = init(host, {
      styles: {
        grid: { horizontal: { color: "rgba(127,127,127,0.12)" }, vertical: { show: false } },
        candle: {
          bar: {
            upColor: UP_COLOR,
            downColor: DOWN_COLOR,
            upBorderColor: UP_COLOR,
            downBorderColor: DOWN_COLOR,
            upWickColor: UP_COLOR,
            downWickColor: DOWN_COLOR,
          },
        },
        indicator: {
          bars: [{ upColor: UP_COLOR, downColor: DOWN_COLOR, noChangeColor: "#888" }],
        },
        crosshair: { show: true },
      },
    });
    chartRef.current = chart;
    if (chart) {
      chart.setLocale("zh-CN");
      chart.createIndicator("MA", false, { id: "candle_pane" });
      chart.createIndicator("VOL", false, { id: "vol_pane" });
      chart.createIndicator("MACD", false, { id: "macd_pane" });
    }
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      dispose(host);
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyNewData(toKlineData(bars));
    if (bars.length > 0) {
      // Land on the newest 120 bars (hoshi's initial window): the scale is
      // the visible fraction, anchored at the last index.
      chart.zoomAtDataIndex(120 / bars.length, bars.length - 1, 0);
    }
  }, [bars]);

  // C17: the chart has no focusable element, so ←/→ and -/= travel through
  // the command layer as window events; the pane owns the chart instance.
  useEffect(() => {
    const onScroll = (e: Event) => {
      const chart = chartRef.current;
      if (!chart) return;
      const direction = (e as CustomEvent<number>).detail === -1 ? -1 : 1;
      const total = bars.length;
      if (total === 0) return;
      // Pan one screen-ish step (20 bars), clamped to the data range.
      const current = chart.getVisibleRange()?.from ?? total - 1;
      const target = Math.min(Math.max(current + direction * 20, 0), total - 1);
      chart.scrollToDataIndex(target);
    };
    const onZoom = (e: Event) => {
      const chart = chartRef.current;
      if (!chart) return;
      const scale = (e as CustomEvent<number>).detail > 1 ? 1.25 : 0.8;
      const anchor = bars.length > 0 ? bars.length - 1 : 0;
      chart.zoomAtDataIndex(scale, anchor, 0);
    };
    window.addEventListener("bnote:invest-kline-scroll", onScroll);
    window.addEventListener("bnote:invest-kline-zoom", onZoom);
    return () => {
      window.removeEventListener("bnote:invest-kline-scroll", onScroll);
      window.removeEventListener("bnote:invest-kline-zoom", onZoom);
    };
  }, [bars.length]);

  const code = selectedScope?.split(":")[1] ?? "";
  return (
    <div className="invest-kline" data-testid="invest-kline">
      <div className="invest-kline-toolbar">
        <span className="invest-kline-title">
          {title || "选择标的"}
          {code ? <span className="invest-kline-code"> {code}</span> : null}
        </span>
        <span className={`invest-kline-source${staleLabel?.startsWith("⚠") ? " stale" : ""}`}>
          {staleLabel ? `${staleLabel} · ` : ""}
          {sourceLabel}
        </span>
        <div className="invest-kline-periods">
          {(["1d", "1w", "1M"] as const).map((p) => (
            <button
              key={p}
              className={`invest-period-btn${period === p ? " active" : ""}`}
              onClick={() => void setPeriod(p)}
              title={p === "1d" ? "日 K" : p === "1w" ? "周 K" : "月 K"}
            >
              {p === "1d" ? "日" : p === "1w" ? "周" : "月"}
            </button>
          ))}
        </div>
      </div>
      <div ref={hostRef} className="invest-kline-host" />
      {barsLoading && <div className="invest-kline-overlay">加载中…</div>}
      {!barsLoading && bars.length === 0 && (
        <div className="invest-kline-overlay">
          本地暂无 K 线数据。
          <button
            className="invest-import-empty-btn"
            onClick={() => useInvestStore.getState().openImport()}
          >
            导入数据
          </button>
        </div>
      )}
    </div>
  );
}
