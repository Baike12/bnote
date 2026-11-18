//! The serde structures that cross the IPC boundary.
//!
//! Field names are snake_case; the frontend mirrors them in
//! `src/invest/types.ts`. A `scope` is the single address of "what a document,
//! event, skill or forecast belongs to": `stock:600519`, `sector:801010`,
//! `portfolio:<id>` or `market`.

use serde::{Deserialize, Serialize};

/// `stock:<code>` / `sector:<code>` / `portfolio:<id>` / `market`.
pub type Scope = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instrument {
    pub code: String,
    pub market: String,
    pub name: String,
    pub industry: String,
    pub sector_code: Option<String>,
    pub sector_sub: Option<String>,
    pub kind: String,
    pub note: String,
    pub watch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bar {
    /// `YYYY-MM-DD` (daily bars only).
    pub ts: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    /// Shares, not lots (hoshi's convention: CN UI divides by 100).
    pub volume: f64,
    pub amount: Option<f64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sector {
    pub code: String,
    pub name: String,
    pub level: i64,
    pub parent: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub code: String,
    pub market: String,
    pub price: Option<f64>,
    pub prev_close: Option<f64>,
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub volume: Option<f64>,
    pub amount: Option<f64>,
    pub turnover: Option<f64>,
    pub pe: Option<f64>,
    pub pb: Option<f64>,
    pub market_cap: Option<f64>,
    pub float_cap: Option<f64>,
    /// E24: limit-up / limit-down prices (Tencent fields 47/48, yuan).
    pub limit_up: Option<f64>,
    pub limit_down: Option<f64>,
    /// E24: intraday amplitude (Tencent field 43, % → 0–1 fraction).
    pub amplitude: Option<f64>,
    /// E24: volume ratio vs the 5-day average (Tencent field 49, unitless).
    pub volume_ratio: Option<f64>,
    /// H1: the pricing currency (CNY / HKD / USD). Every monetary field is
    /// denominated in this — the UI labels amounts with it, nothing converts.
    pub currency: Option<String>,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FundFlowDay {
    pub date: String,
    pub close: Option<f64>,
    pub change_ratio: Option<f64>,
    pub turnover: Option<f64>,
    pub net_amount: Option<f64>,
    pub net_ratio: Option<f64>,
    pub main_net: Option<f64>,
    pub main_ratio: Option<f64>,
}

/// One report period of the 15 selected financial indicators (hoshi's set).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Financial {
    pub fiscal_year: i64,
    pub fiscal_period: String,
    pub revenue: Option<f64>,
    pub revenue_yoy: Option<f64>,
    pub net_profit: Option<f64>,
    pub net_profit_yoy: Option<f64>,
    pub deduct_profit: Option<f64>,
    pub op_cashflow: Option<f64>,
    pub eps: Option<f64>,
    pub gross_margin: Option<f64>,
    pub net_margin: Option<f64>,
    pub roe: Option<f64>,
    pub roa: Option<f64>,
    pub debt_ratio: Option<f64>,
    pub current_ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub scope: Scope,
    pub date: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub source: String,
    pub url: String,
    pub sentiment: Option<String>,
}

/// A document registered in the index (the Markdown file itself lives under
/// `.bnote/invest/`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocInfo {
    pub rel_path: String,
    pub scope: Scope,
    pub kind: String,
    pub title: String,
    pub mtime: i64,
}

/// One search result: the doc metadata flattened into the JSON object plus
/// the matching excerpt (the docs_fts table is contentless, so FTS5's own
/// snippet() is unavailable — the excerpt is cut in `docs::snippet_around`).
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    #[serde(flatten)]
    pub doc: DocInfo,
    pub snippet: String,
}

/// E23: the per-code quote summary the instrument list rows show (one query
/// for the whole list instead of N snapshot reads).
#[derive(Debug, Clone, Serialize)]
pub struct QuoteSummary {
    pub code: String,
    pub price: Option<f64>,
    pub prev_close: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub scope: Option<Scope>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relation {
    pub id: i64,
    pub src_id: i64,
    pub dst_id: i64,
    pub kind: String,
    pub weight: f64,
    pub description: String,
}

/// One hop of the graph query: the entity plus its neighbours.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphView {
    pub center: Entity,
    pub entities: Vec<Entity>,
    pub relations: Vec<Relation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Forecast {
    pub id: i64,
    pub scope: Scope,
    pub skill_version: String,
    pub as_of: String,
    pub target_date: String,
    pub direction: String,
    pub expected_move: Option<f64>,
    pub confidence: f64,
    pub rationale: String,
    pub actual_direction: Option<String>,
    pub actual_move: Option<f64>,
    pub score: Option<f64>,
    pub mode: String,
}

/// A skill document bundle: the strategy (SKILL.md) plus the memory (MEMORY.md).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillBundle {
    pub scope: Scope,
    pub version: i64,
    pub skill: String,
    pub memory: String,
    /// `versions/` snapshots, newest first.
    pub versions: Vec<SkillVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillVersion {
    pub file: String,
    pub version: i64,
    pub gate_score: Option<f64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BacktestMetrics {
    pub total_return: f64,
    pub annual_return: f64,
    pub sharpe: f64,
    pub max_drawdown: f64,
    pub win_rate: f64,
    pub profit_factor: f64,
    pub trade_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EquityPoint {
    pub date: String,
    pub equity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestRun {
    pub id: i64,
    pub scope: Scope,
    pub skill_version: Option<String>,
    pub strategy: String,
    /// H6: the strategy parameters ({"fast":5,"slow":20} for ma_cross) — the
    /// list must distinguish repeated runs (blind test: 4 identical rows).
    pub params: Option<serde_json::Value>,
    pub start_date: String,
    pub end_date: String,
    pub metrics: BacktestMetrics,
    pub equity: Vec<EquityPoint>,
    /// Unix seconds the run was recorded (the history list shows it — blind
    /// test: identical rows with no timestamp were indistinguishable).
    pub run_at: Option<i64>,
    /// Per-trade fills (date / direction / shares / price / fees / pnl).
    pub trades: Vec<Trade>,
}

/// One fill of a backtest (broker level, T+1 open execution).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub date: String,
    pub action: String,
    pub shares: i64,
    pub price: f64,
    pub fees: f64,
    pub pnl: Option<f64>,
}

/// The ingest run summary (one `invest_ingest_run` call).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestRunResult {
    pub run_id: String,
    pub started_at: i64,
    pub sources: Vec<IngestSourceResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestSourceResult {
    pub source_id: String,
    pub fetched: i64,
    pub stored: i64,
    pub skipped: i64,
    pub error: Option<String>,
}

/// Parses `stock:600519` → Some(("stock", "600519")). Returns `None` for
/// scopes the code does not own (defence in depth: scope strings are user
/// visible, callers must not treat them as paths).
pub fn parse_scope(scope: &str) -> Option<(&str, &str)> {
    scope.split_once(':')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scope_splits_once() {
        assert_eq!(parse_scope("stock:600519"), Some(("stock", "600519")));
        assert_eq!(parse_scope("sector:801010"), Some(("sector", "801010")));
        assert_eq!(parse_scope("market"), None);
        assert_eq!(parse_scope("stock:"), Some(("stock", "")));
        // No path traversal through the scope string.
        assert_eq!(parse_scope("../etc/passwd"), None);
    }
}
