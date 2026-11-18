/**
 * The invest mode's types, mirrored from the Rust `invest::model` structs
 * (snake_case field names travel through IPC verbatim).
 */

/** `stock:<code>` / `sector:<code>` / `portfolio:<id>` / `market`. */
export type InvestScope = string;

export interface InvestInstrument {
  code: string;
  market: string;
  name: string;
  industry: string;
  sector_code: string | null;
  sector_sub: string | null;
  kind: string;
  note: string;
  watch: boolean;
}

export interface InvestBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Shares (the CN UI divides by 100 for lots, hoshi's convention). */
  volume: number;
  amount: number | null;
  source: string;
}

export type InvestPeriod = "1d" | "1w" | "1M";

export interface InvestSector {
  code: string;
  name: string;
  level: number;
  parent: string | null;
  summary: string;
}

export interface InvestSnapshot {
  code: string;
  market: string;
  price: number | null;
  prev_close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  amount: number | null;
  turnover: number | null;
  pe: number | null;
  pb: number | null;
  market_cap: number | null;
  float_cap: number | null;
  /** E24: limit prices in yuan, amplitude as a 0–1 fraction, ratio unitless. */
  limit_up: number | null;
  limit_down: number | null;
  amplitude: number | null;
  volume_ratio: number | null;
  /** H1: the pricing currency (CNY / HKD / USD) — every amount is in it. */
  currency: string | null;
  fetched_at: number;
}

/** E23: the per-code quote summary the instrument list rows show. */
export interface InvestQuoteSummary {
  code: string;
  price: number | null;
  prev_close: number | null;
}

export interface InvestFundFlowDay {
  date: string;
  close: number | null;
  change_ratio: number | null;
  turnover: number | null;
  net_amount: number | null;
  net_ratio: number | null;
  main_net: number | null;
  main_ratio: number | null;
}

/** One report period of the 15 selected financial indicators. */
export interface InvestFinancial {
  fiscal_year: number;
  fiscal_period: string;
  revenue: number | null;
  revenue_yoy: number | null;
  net_profit: number | null;
  net_profit_yoy: number | null;
  deduct_profit: number | null;
  op_cashflow: number | null;
  eps: number | null;
  gross_margin: number | null;
  net_margin: number | null;
  roe: number | null;
  roa: number | null;
  debt_ratio: number | null;
  current_ratio: number | null;
}

export interface InvestEvent {
  id: number;
  scope: InvestScope;
  date: string;
  kind: string;
  title: string;
  body: string;
  source: string;
  url: string;
  sentiment: string | null;
}

export interface InvestDocInfo {
  rel_path: string;
  scope: InvestScope;
  kind: string;
  title: string;
  mtime: number;
}

/** A search hit: doc metadata plus the matching excerpt (B10). */
export interface InvestSearchHit extends InvestDocInfo {
  snippet: string;
}

export interface InvestEntity {
  id: number;
  name: string;
  kind: string;
  scope: InvestScope | null;
  description: string;
}

export interface InvestRelation {
  id: number;
  src_id: number;
  dst_id: number;
  kind: string;
  weight: number;
  description: string;
}

export interface InvestGraphView {
  center: InvestEntity;
  entities: InvestEntity[];
  relations: InvestRelation[];
}

export interface InvestSkillVersion {
  file: string;
  version: number;
  gate_score: number | null;
  created_at: number;
}

export interface InvestSkillBundle {
  scope: InvestScope;
  version: number;
  skill: string;
  memory: string;
  versions: InvestSkillVersion[];
}

export interface InvestForecast {
  id: number;
  scope: InvestScope;
  skill_version: string;
  as_of: string;
  target_date: string;
  direction: "up" | "down" | "flat" | string;
  expected_move: number | null;
  confidence: number;
  rationale: string;
  actual_direction: string | null;
  actual_move: number | null;
  score: number | null;
  mode: string;
}

export interface InvestBacktestMetrics {
  total_return: number;
  annual_return: number;
  sharpe: number;
  max_drawdown: number;
  win_rate: number;
  profit_factor: number;
  trade_count: number;
}

export interface InvestEquityPoint {
  date: string;
  equity: number;
}

export interface InvestTrade {
  date: string;
  action: string;
  shares: number;
  price: number;
  fees: number;
  pnl: number | null;
}

export interface InvestBacktestRun {
  id: number;
  scope: InvestScope;
  skill_version: string | null;
  strategy: string;
  params: Record<string, unknown> | null;
  start_date: string;
  end_date: string;
  metrics: InvestBacktestMetrics;
  equity: InvestEquityPoint[];
  /** Unix seconds the run was recorded. */
  run_at: number | null;
  trades: InvestTrade[];
}

export interface InvestIngestSourceResult {
  source_id: string;
  fetched: number;
  stored: number;
  skipped: number;
  error: string | null;
}

export interface InvestIngestRunResult {
  run_id: string;
  started_at: number;
  sources: InvestIngestSourceResult[];
}

export type InvestViewKind = "stocks" | "sectors";
