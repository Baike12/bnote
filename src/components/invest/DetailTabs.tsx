import { useEffect, useRef, useState } from "react";
import { pct, num, signedPct, yi, sharesToLots } from "@/invest/format";
import { marketOf, refreshDetail, useInvestStore } from "@/invest/store";
import { investApi } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";

/**
 * The lower half of the middle column: the instrument detail tabs. The tab
 * set mirrors hoshi's (`行情 / 资金流 / 简况 / 财务`) plus the invest-mode
 * additions (`事件 / 知识 / 预测 / 回测`), all rendered from the store's
 * per-scope detail data. Sector scopes only show the tabs that have data.
 *
 * **Unit contract** (DESIGN.md §4): the DB stores amounts in yuan and ratios
 * as 0–1 fractions — `yi()`/`pct()` are the only two converters; nothing
 * formats a raw number with a `%`/`亿` suffix inline (blind test: the fund
 * flow's `change_ratio` was rendered raw and showed -0.0327% for -3.27%).
 */

/** H6: the market of the selected scope (rows and labels differ by market). */
function useCurrentMarket(): string {
  return useInvestStore((s) => (s.selectedScope ? marketOf(s.selectedScope, s.instruments) : "cn"));
}

const MARKET_LABEL: Record<string, string> = { cn: "A 股", hk: "港股", us: "美股" };
const MARKET_TAG: Record<string, string> = { hk: "港", us: "美" };

type DetailTab =
  "snapshot" | "flow" | "financials" | "members" | "events" | "knowledge" | "forecast" | "backtest";

const TAB_LABELS: Record<DetailTab, string> = {
  snapshot: "行情",
  flow: "资金流",
  financials: "财务",
  members: "成分股",
  events: "事件",
  knowledge: "知识",
  forecast: "预测",
  backtest: "回测",
};

/** C18: the tab sets per scope kind — shared with ⌘⌥1..7 in InvestLayout. */
export const STOCK_TABS: DetailTab[] = [
  "snapshot",
  "flow",
  "financials",
  "events",
  "knowledge",
  "forecast",
  "backtest",
];
export const SECTOR_TABS: DetailTab[] = ["members", "events", "knowledge", "forecast"];

function Row({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  title?: string;
}) {
  return (
    <div className="invest-detail-row" title={title}>
      <span className="invest-detail-label">{label}</span>
      <span className={`invest-detail-value${tone ? ` ${tone}` : ""}`}>{value}</span>
    </div>
  );
}

function SnapshotTab() {
  const snapshot = useInvestStore((s) => s.snapshot);
  const bars = useInvestStore((s) => s.bars);
  const insertSnapshotToNote = useInvestStore((s) => s.insertSnapshotToNote);
  if (!snapshot)
    return (
      <div className="invest-detail-empty">
        还没有快照数据。点右上角「刷新快照」从实时行情拉取当前价（与本地 K 线无关）。
      </div>
    );
  const change =
    snapshot.price != null && snapshot.prev_close
      ? (snapshot.price - snapshot.prev_close) / snapshot.prev_close
      : null;
  const fetchedAt = new Date(snapshot.fetched_at * 1000);
  // Cross-source sanity (blind test Q-P0-4): a snapshot disagreeing with the
  // local K-line tail by >3% means the two are from different as-ofs — show
  // it instead of letting the user mix them silently.
  const lastClose = bars[bars.length - 1]?.close;
  const mismatch =
    snapshot.price != null &&
    lastClose != null &&
    lastClose > 0 &&
    Math.abs(snapshot.price / lastClose - 1) > 0.03;
  // E24: the 52-week band aggregates the last ~250 daily bars. A plain pass
  // (not useMemo): the hook would sit behind the early return, and 500
  // iterations on an opened tab cost nothing.
  let high52: number | null = null;
  let low52: number | null = null;
  for (const bar of bars.slice(-250)) {
    if (high52 == null || bar.high > high52) high52 = bar.high;
    if (low52 == null || bar.low < low52) low52 = bar.low;
  }
  return (
    <div className="invest-detail-grid">
      {mismatch ? (
        <div className="invest-detail-empty" style={{ gridColumn: "1 / -1" }}>
          ⚠ 快照与本地 K 线不一致：快照 {num(snapshot.price)} / K 线末收 {num(lastClose)}
          （两个来源的 as-of 不同，引用前先核对）
        </div>
      ) : null}
      <Row label="现价" value={num(snapshot.price)} />
      <Row
        label="涨跌"
        value={signedPct(change)}
        tone={change == null ? undefined : change >= 0 ? "up" : "down"}
      />
      <Row label="今开" value={num(snapshot.open)} />
      <Row label="昨收" value={num(snapshot.prev_close)} />
      <Row label="最高" value={num(snapshot.high)} />
      <Row label="最低" value={num(snapshot.low)} />
      <Row label="涨停" value={num(snapshot.limit_up)} />
      <Row label="跌停" value={num(snapshot.limit_down)} />
      <Row label="振幅" value={pct(snapshot.amplitude)} />
      <Row label="量比" value={num(snapshot.volume_ratio)} />
      <Row
        label="52 周最高"
        value={num(high52)}
        title="基于本地 K 线末 250 根聚合（随导入数据的区间，非实时）"
      />
      <Row
        label="52 周最低"
        value={num(low52)}
        title="基于本地 K 线末 250 根聚合（随导入数据的区间，非实时）"
      />
      <Row
        label="成交量"
        value={
          snapshot.volume != null
            ? snapshot.market === "cn"
              ? `${sharesToLots(snapshot.volume)} 手`
              : `${snapshot.volume.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 股`
            : "—"
        }
      />
      <Row label="成交额" value={yi(snapshot.amount, snapshot.currency)} />
      <Row label="换手率" value={pct(snapshot.turnover)} />
      <Row label="PE(TTM)" value={num(snapshot.pe)} />
      <Row label="PB" value={num(snapshot.pb)} />
      <Row label="总市值" value={yi(snapshot.market_cap, snapshot.currency)} />
      <Row label="流通市值" value={yi(snapshot.float_cap, snapshot.currency)} />
      <Row
        label="快照时间"
        value={Number.isNaN(fetchedAt.getTime()) ? "—" : fetchedAt.toLocaleString("zh-CN")}
      />
      {/* H3: amounts are denominated in the listing currency — the label
         makes the scale honest (hk/us quotes are NOT CNY). */}
      {snapshot.currency ? <Row label="计价货币" value={snapshot.currency} /> : null}
      <div style={{ gridColumn: "1 / -1" }}>
        <button className="invest-detail-refresh" onClick={() => insertSnapshotToNote()}>
          插入到笔记
        </button>
      </div>
    </div>
  );
}

function FlowTab() {
  const fundFlow = useInvestStore((s) => s.fundFlow);
  const market = useCurrentMarket();
  if (fundFlow.length === 0)
    return (
      <div className="invest-detail-empty">
        {market === "cn"
          ? "暂无资金流数据（可用「导入数据」写入）。"
          : `${MARKET_LABEL[market] ?? market}标的没有内置资金流数据源（可在「导入数据」中写入自有数据）。`}
      </div>
    );
  return (
    <table className="invest-detail-table">
      <thead>
        <tr>
          <th>日期</th>
          <th>收盘</th>
          <th>涨跌幅</th>
          <th>换手</th>
          <th>净流入</th>
          <th>主力净流入</th>
        </tr>
      </thead>
      <tbody>
        {fundFlow.map((d) => (
          <tr key={d.date}>
            <td>{d.date}</td>
            <td>{num(d.close)}</td>
            {/* change_ratio/turnover are 0–1 fractions by the unit contract. */}
            <td>{pct(d.change_ratio)}</td>
            <td>{pct(d.turnover)}</td>
            <td>{yi(d.net_amount)}</td>
            <td>{yi(d.main_net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FinancialsTab() {
  const financials = useInvestStore((s) => s.financials);
  const market = useCurrentMarket();
  if (financials.length === 0)
    return (
      <div className="invest-detail-empty">
        {market === "cn"
          ? "暂无财务数据（可用「导入数据」写入）。"
          : `${MARKET_LABEL[market] ?? market}标的没有内置财务数据源（可在「导入数据」中写入自有数据）。`}
      </div>
    );
  const periods = financials.map((f) => `${f.fiscal_year}${f.fiscal_period}`).join("、");
  return (
    <div>
      <div className="invest-detail-empty">
        共 {financials.length} 期（{periods}）。金额单位：元（表内换算为亿元）；比率按 0–1
        小数存储。
      </div>
      <table className="invest-detail-table">
        <thead>
          <tr>
            <th>报告期</th>
            <th>营收</th>
            <th>YoY</th>
            <th>净利</th>
            <th>YoY</th>
            <th>扣非</th>
            <th>经营现金流</th>
            <th>EPS</th>
          </tr>
        </thead>
        <tbody>
          {financials.map((f) => (
            <tr key={`${f.fiscal_year}-${f.fiscal_period}`}>
              <td>
                {f.fiscal_year} {f.fiscal_period}
              </td>
              <td>{yi(f.revenue)}</td>
              <td>{pct(f.revenue_yoy)}</td>
              <td>{yi(f.net_profit)}</td>
              <td>{pct(f.net_profit_yoy)}</td>
              <td>{yi(f.deduct_profit)}</td>
              <td>{yi(f.op_cashflow)}</td>
              <td>{num(f.eps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="invest-detail-table">
        <thead>
          <tr>
            <th>报告期</th>
            <th>毛利率</th>
            <th>净利率</th>
            <th>ROE</th>
            <th>ROA</th>
            <th>负债率</th>
            <th>流动比率</th>
          </tr>
        </thead>
        <tbody>
          {financials.map((f) => (
            <tr key={`${f.fiscal_year}-${f.fiscal_period}`}>
              <td>
                {f.fiscal_year} {f.fiscal_period}
              </td>
              <td>{pct(f.gross_margin)}</td>
              <td>{pct(f.net_margin)}</td>
              <td>{pct(f.roe)}</td>
              <td>{pct(f.roa)}</td>
              <td>{pct(f.debt_ratio)}</td>
              <td>{num(f.current_ratio)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** B11: the sector's member stocks; a click drills down into that stock. */
function MembersTab() {
  const scope = useInvestStore((s) => s.selectedScope);
  const selectScope = useInvestStore((s) => s.selectScope);
  const [members, setMembers] = useState<import("@/invest/types").InvestInstrument[] | null>(null);
  const code = scope?.startsWith("sector:") ? scope.slice(7) : null;
  useEffect(() => {
    if (!code) return;
    let stale = false;
    void investApi
      .sectorMembers(code)
      .then((list) => {
        if (!stale) setMembers(list);
      })
      .catch(() => {
        if (!stale) setMembers([]);
      });
    return () => {
      stale = true;
    };
  }, [code]);

  if (!code || members === null) return null;
  if (members.length === 0)
    return (
      <div className="invest-detail-empty">
        无成分股数据。导入 instruments（含板块归属）后显示。
      </div>
    );
  return (
    <div className="invest-member-list">
      {members.map((m) => (
        <button
          key={m.code}
          className="invest-member-row"
          title={`切换到 ${m.name} 的行情与文档`}
          onClick={() => void selectScope(`stock:${m.code}`, m.name)}
        >
          <span className="invest-row-name">{m.name}</span>
          <span className="invest-row-code">{m.code}</span>
          {m.industry ? <span className="invest-row-industry">{m.industry}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** F26: the manual event form — the ingest pipeline covers the wire, but a
 * user-observed event (公告、调研、传闻核实) has to be recordable by hand. */
function EventForm({ onDone }: { onDone: () => void }) {
  const scope = useInvestStore((s) => s.selectedScope);
  const today = new Date().toLocaleDateString("sv-SE");
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState("公告");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sentiment, setSentiment] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!scope) return null;
  return (
    <div className="invest-event-form">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input
        value={kind}
        placeholder="类型（公告/调研/传闻…）"
        onChange={(e) => setKind(e.target.value)}
      />
      <input value={title} placeholder="标题（必填）" onChange={(e) => setTitle(e.target.value)} />
      <textarea
        value={body}
        placeholder="详情（可选）"
        rows={2}
        onChange={(e) => setBody(e.target.value)}
      />
      <select value={sentiment} onChange={(e) => setSentiment(e.target.value)}>
        <option value="">情绪：中性</option>
        <option value="positive">利好</option>
        <option value="negative">利空</option>
      </select>
      {error ? <div className="invest-import-error">{error}</div> : null}
      <div className="invest-event-form-actions">
        <button onClick={onDone}>取消</button>
        <button
          className="invest-detail-refresh"
          onClick={() => {
            if (!title.trim()) {
              setError("标题不能为空");
              return;
            }
            void investApi
              .eventAdd({
                scope,
                date,
                kind: kind.trim() || "公告",
                title: title.trim(),
                body: body.trim() || undefined,
                sentiment: sentiment || undefined,
              })
              .then(onDone)
              .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
          }}
        >
          保存事件
        </button>
      </div>
    </div>
  );
}

function EventsTab() {
  const events = useInvestStore((s) => s.events);
  const scope = useInvestStore((s) => s.selectedScope);
  const [adding, setAdding] = useState(false);
  if (events.length === 0 && !adding)
    return (
      <div className="invest-detail-empty">
        暂无事件。点上方「摄取热点」从已配置的信息源抓取，或手工补录：
        <div style={{ marginTop: 8 }}>
          <button className="invest-detail-refresh" onClick={() => setAdding(true)}>
            新增事件
          </button>
        </div>
      </div>
    );
  return (
    <div className="invest-event-list">
      {adding ? (
        <EventForm onDone={() => void refreshDetail().then(() => setAdding(false))} />
      ) : null}
      {events.length === 0 ? (
        <div className="invest-detail-empty">还没有事件记录。</div>
      ) : (
        events.map((ev) => (
          <div key={ev.id} className={`invest-event-item sentiment-${ev.sentiment ?? "neutral"}`}>
            <span className="invest-event-date">{ev.date}</span>
            <span className="invest-event-kind">{ev.kind}</span>
            <span className="invest-event-title">{ev.title}</span>
            {ev.body ? <span className="invest-event-body">{ev.body}</span> : null}
            {ev.source ? <span className="invest-event-source">{ev.source}</span> : null}
            <span className="invest-event-scope-hint">{scope}</span>
          </div>
        ))
      )}
      {!adding ? (
        <button className="invest-event-add" onClick={() => setAdding(true)}>
          + 新增事件
        </button>
      ) : null}
    </div>
  );
}

function KnowledgeTab() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<import("@/invest/types").InvestSearchHit[] | null>(null);
  const openSearchHit = useInvestStore((s) => s.openSearchHit);
  const knowledgeFocusTick = useInvestStore((s) => s.knowledgeFocusTick);
  const inputRef = useRef<HTMLInputElement>(null);
  // ⌘⌥P lands on this tab (the store flipped detailTabByScope); focusing the
  // box on the tick is the last leg of that journey.
  useEffect(() => {
    if (knowledgeFocusTick > 0) inputRef.current?.focus();
  }, [knowledgeFocusTick]);

  const runSearch = () => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    void investApi
      .searchKnowledge(q, 20)
      .then(setResults)
      .catch((e) => {
        setResults([]);
        useAppStore.getState().showToast(`检索失败: ${String(e)}`);
      });
  };

  const scopeLabel = (hit: import("@/invest/types").InvestSearchHit): string => {
    if (hit.kind === "skill_version") return "Skill";
    if (hit.scope.startsWith("stock:")) {
      const code = hit.scope.slice(6);
      const market = marketOf(hit.scope, useInvestStore.getState().instruments);
      const tag = market === "cn" ? "" : ` ${MARKET_TAG[market] ?? ""}`;
      return `标的 ${code}${tag}`;
    }
    if (hit.scope.startsWith("sector:")) return `板块 ${hit.scope.slice(7)}`;
    return hit.scope;
  };

  return (
    <div className="invest-knowledge">
      <div className="invest-knowledge-search">
        <input
          ref={inputRef}
          value={query}
          placeholder="检索本地知识库（跨全部标的 / 板块的文档、事件与 Skill）"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch();
          }}
        />
      </div>
      {results === null ? (
        <div className="invest-detail-empty">输入关键词回车检索；结果按相关度排序。</div>
      ) : results.length === 0 ? (
        <div className="invest-detail-empty">没有匹配的文档。</div>
      ) : (
        <div className="invest-knowledge-results">
          {results.map((r) => (
            <button
              key={r.rel_path}
              className="invest-knowledge-hit"
              title={r.rel_path}
              onClick={() => void openSearchHit(r)}
            >
              <span className="invest-knowledge-hit-head">
                <span className="invest-knowledge-hit-scope">{scopeLabel(r)}</span>
                <span className="invest-knowledge-hit-title">{r.title}</span>
              </span>
              {r.snippet ? <span className="invest-knowledge-hit-snippet">{r.snippet}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ForecastTab() {
  const scope = useInvestStore((s) => s.selectedScope);
  const runForecastReplay = useInvestStore((s) => s.runForecastReplay);
  const [rows, setRows] = useState<import("@/invest/types").InvestForecast[]>([]);
  const [accuracy, setAccuracy] = useState<string>("");
  // Load on mount and after each replay (the store bumps busy; a stale reply
  // of a switched scope is dropped by the generation guard on write).
  const load = async (scopeValue: string) => {
    const list = await investApi.forecasts(scopeValue, 20);
    if (useInvestStore.getState().selectedScope !== scopeValue) return;
    setRows(list);
    const acc = await investApi.forecastAccuracy(scopeValue);
    if (useInvestStore.getState().selectedScope !== scopeValue) return;
    setAccuracy(
      acc
        ? `已结算 ${acc[0]} 条 · 均分 ${acc[1].toFixed(2)} · 方向命中率 ${(acc[2] * 100).toFixed(0)}%（随机基线 50%）`
        : "还没有已结算的预测",
    );
  };
  useEffect(() => {
    if (!scope) return;
    void load(scope).catch(() => setAccuracy("预测记录加载失败"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  return (
    <div className="invest-forecast">
      <div className="invest-forecast-bar">{accuracy}</div>
      {rows.length === 0 ? (
        <div className="invest-detail-empty">
          用「回放预测」把当前 Skill 应用到历史数据：截至 T 的数据预测 T+h 的走势，与实际对比打分。
          <div style={{ marginTop: 8 }}>
            <button className="invest-detail-refresh" onClick={() => void runForecastReplay()}>
              回放预测
            </button>
          </div>
        </div>
      ) : (
        <table className="invest-detail-table">
          <thead>
            <tr>
              <th>目标日</th>
              <th>方向</th>
              <th>预期</th>
              <th>实际</th>
              <th>得分</th>
              <th>理由</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id}>
                <td>{f.target_date}</td>
                <td>{f.direction}</td>
                <td>{pct(f.expected_move)}</td>
                <td>{pct(f.actual_move)}</td>
                <td>{f.score != null ? f.score.toFixed(2) : "—"}</td>
                <td className="invest-forecast-reason">{f.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** D19: the equity curve as an O(points) SVG polyline (no chart library);
 * the dashed baseline marks the initial cash (equity = 1). */
function EquityCurve({ points }: { points: { date: string; equity: number }[] }) {
  if (points.length < 2) return null;
  const w = 560;
  const h = 120;
  const pad = 4;
  let min = 1;
  let max = 1;
  for (const p of points) {
    if (p.equity < min) min = p.equity;
    if (p.equity > max) max = p.equity;
  }
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="invest-equity-curve" preserveAspectRatio="none">
      <line x1={pad} x2={w - pad} y1={y(1)} y2={y(1)} className="invest-equity-baseline" />
      <path d={path} className="invest-equity-path" />
    </svg>
  );
}

function TradesTable({ trades }: { trades: import("@/invest/types").InvestTrade[] }) {
  if (trades.length === 0) return null;
  return (
    <table className="invest-detail-table">
      <thead>
        <tr>
          <th>成交日</th>
          <th>方向</th>
          <th>股数</th>
          <th>价格</th>
          <th>费用</th>
          <th>盈亏</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t, i) => (
          <tr key={`${t.date}-${t.action}-${i}`}>
            <td>{t.date}</td>
            <td>{t.action === "buy" ? "买入" : "卖出"}</td>
            <td>{t.shares}</td>
            <td>{num(t.price)}</td>
            <td>{num(t.fees)}</td>
            <td>{t.pnl == null ? "—" : num(t.pnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BacktestTab() {
  const scope = useInvestStore((s) => s.selectedScope);
  const runBacktest = useInvestStore((s) => s.runBacktest);
  // H6: the store bumps this after every completed run — the list reloads
  // in place instead of waiting for a scope switch.
  const backtestTick = useInvestStore((s) => s.backtestTick);
  const busy = useInvestStore((s) => s.busy);
  const [runs, setRuns] = useState<import("@/invest/types").InvestBacktestRun[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const load = async (scopeValue: string) => {
    const list = await investApi.backtestList(scopeValue, 10);
    if (useInvestStore.getState().selectedScope !== scopeValue) return;
    setRuns(list);
    setSelectedId((current) =>
      current != null && list.some((r) => r.id === current) ? current : null,
    );
  };
  useEffect(() => {
    if (!scope) return;
    void load(scope).catch(() => setRuns([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, backtestTick]);

  const removeRun = async (id: number) => {
    try {
      await investApi.backtestDelete(id);
      if (scope) await load(scope);
    } catch (e) {
      useAppStore.getState().showToast(`删除失败: ${String(e)}`);
    }
  };

  const market = useCurrentMarket();
  const feeNote =
    market === "hk"
      ? "成本按佣金万 2.5 + 买卖双边印花税各 0.1%"
      : market === "us"
        ? "成本按佣金万 2.5（无印花税）"
        : "成本按佣金万 2.5 + 卖出印花税 0.05%";
  if (runs.length === 0)
    return (
      <div className="invest-detail-empty">
        还没有回测记录。回测按 T+1 开盘撮合，{feeNote}。
        <div style={{ marginTop: 8 }}>
          <button
            className="invest-detail-refresh"
            onClick={() => void runBacktest()}
            disabled={busy === "backtest"}
          >
            {busy === "backtest" ? "回测中…" : "跑 ma_cross 基准回测"}
          </button>
        </div>
      </div>
    );
  const selected = runs.find((r) => r.id === selectedId) ?? null;
  return (
    <div>
      {/* H6: the run entry used to exist only in the empty state — with any
       * history recorded the user could never run the backtest again. */}
      <div className="invest-backtest-toolbar">
        <button
          className="invest-detail-refresh"
          onClick={() => void runBacktest()}
          disabled={busy === "backtest"}
        >
          {busy === "backtest" ? "回测中…" : "跑 ma_cross 基准回测"}
        </button>
      </div>
      <table className="invest-detail-table">
        <thead>
          <tr>
            <th>运行时间</th>
            <th>策略</th>
            <th>区间</th>
            <th title="期末净值相对期初（复合，未年化）">总收益</th>
            <th title="复合年化 = (期末/期初)^(252/交易日数) − 1">年化</th>
            <th title="Sharpe = (日均超额收益 × √252) / 日收益标准差（无风险利率 2% 按日均扣减）">
              Sharpe
            </th>
            <th title="相对历史净值峰值的最大跌幅">最大回撤</th>
            <th>胜率</th>
            <th>交易数</th>
            <th aria-label="删除" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.id}
              className={`invest-backtest-row${selectedId === r.id ? " active" : ""}`}
              onClick={() => setSelectedId(selectedId === r.id ? null : r.id)}
            >
              <td>{r.run_at ? new Date(r.run_at * 1000).toLocaleString("zh-CN") : "—"}</td>
              <td>
                {r.strategy}
                {typeof r.params?.fast === "number" && typeof r.params?.slow === "number"
                  ? ` (${r.params.fast}/${r.params.slow})`
                  : ""}
              </td>
              <td>
                {r.start_date} ~ {r.end_date}
              </td>
              <td>{pct(r.metrics.total_return)}</td>
              <td>{pct(r.metrics.annual_return)}</td>
              <td>{num(r.metrics.sharpe)}</td>
              <td>{pct(r.metrics.max_drawdown)}</td>
              <td>{pct(r.metrics.win_rate, 0)}</td>
              <td>{r.metrics.trade_count}</td>
              <td>
                <button
                  className="invest-backtest-delete"
                  title="删除这条回测记录"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeRun(r.id);
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.some((r) => r.metrics.trade_count < 30) ? (
        <div className="invest-detail-empty">
          样本不足（交易数 &lt; 30），指标无统计意义。
          {selected
            ? ` 本区间 ${selected.start_date} ~ ${selected.end_date}，共 ${selected.equity.length} 个交易日。`
            : ""}
        </div>
      ) : null}
      {selected ? (
        <div className="invest-backtest-detail">
          <div className="invest-backtest-caption">
            净值曲线（期初 = 1，虚线为成本线）· 交易明细 · 口径：年化复合、Sharpe 用
            日均超额×√252（rf=2%）、回撤相对历史峰值；{feeNote}。
          </div>
          <EquityCurve points={selected.equity} />
          <TradesTable trades={selected.trades} />
        </div>
      ) : (
        <div className="invest-detail-empty">点击一行查看净值曲线与交易明细。</div>
      )}
    </div>
  );
}

export function DetailTabs() {
  // B12: the active detail tab is remembered per scope — switching scopes and
  // back restores it instead of snapping to the first tab. A remembered tab
  // that the current scope kind does not carry (e.g. 财务 on a sector) falls
  // back to that kind's default.
  const scope = useInvestStore((s) => s.selectedScope);
  const setDetailTab = useInvestStore((s) => s.setDetailTab);
  const isStock = scope?.startsWith("stock:") ?? false;
  const tabs = isStock ? STOCK_TABS : SECTOR_TABS;
  const tab = useInvestStore((s) => {
    const stored = scope ? (s.detailTabByScope[scope] as DetailTab | undefined) : undefined;
    if (stored && tabs.includes(stored)) return stored;
    return isStock ? "snapshot" : "members";
  });

  return (
    <div className="invest-detail">
      <div className="invest-detail-tabs" data-key-region="invest">
        {tabs.map((t) => (
          <button
            key={t}
            className={`invest-detail-tab${tab === t ? " active" : ""}`}
            onClick={() => scope && setDetailTab(scope, t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="invest-detail-body">
        {tab === "snapshot" && <SnapshotTab />}
        {tab === "flow" && <FlowTab />}
        {tab === "financials" && <FinancialsTab />}
        {tab === "members" && <MembersTab />}
        {tab === "events" && <EventsTab />}
        {tab === "knowledge" && <KnowledgeTab />}
        {tab === "forecast" && <ForecastTab />}
        {tab === "backtest" && <BacktestTab />}
      </div>
    </div>
  );
}
