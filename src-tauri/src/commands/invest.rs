//! The invest mode's command surface. Every command is thin: validate inputs,
//! move the shared connection onto a blocking task through `invest::db` (short
//! lock), and call the `invest::` feature module. Errors are `String` messages
//! the UI can show (the project-wide `CmdResult` convention).

use rusqlite::Connection;
use tauri::State;

use crate::invest;
use crate::invest::backtest::{self, StrategyConfig, StrategyKind};
use crate::invest::db::{self, Db};
use crate::invest::kline::{self, Period};
use crate::invest::model::{
    BacktestRun, Bar, DocInfo, Event, Financial, FundFlowDay, GraphView, IngestRunResult,
    Instrument, QuoteSummary, SearchHit, SkillBundle, Snapshot,
};
use crate::state::AppState;

type CmdResult<T> = Result<T, String>;

/// Runs a synchronous DB closure off the async worker. The connection comes
/// from the shared handle; the lock discipline lives in `invest::db::with_conn`
/// and the guard is taken and dropped inside the blocking task, never across
/// an await.
async fn db_task<T, F>(db: Db, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> CmdResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || db::with_conn(&db, f))
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

// ---------------------------------------------------------------------------
// Instruments / watchlist / details
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invest_list_instruments(
    state: State<'_, AppState>,
    query: Option<String>,
    watch_only: Option<bool>,
    limit: Option<usize>,
) -> CmdResult<Vec<Instrument>> {
    let query = query.unwrap_or_default();
    let watch_only = watch_only.unwrap_or(false);
    let limit = limit.unwrap_or(200);
    db_task(state.invest_db.clone(), move |conn| {
        invest::instruments::list(conn, &query, watch_only, limit)
    })
    .await
}

#[tauri::command]
pub async fn invest_set_watch(
    state: State<'_, AppState>,
    market: String,
    code: String,
    watch: bool,
) -> CmdResult<bool> {
    db_task(state.invest_db.clone(), move |conn| {
        invest::instruments::set_watch(conn, &market, &code, watch)
    })
    .await
}

#[tauri::command]
pub async fn invest_kline_query(
    state: State<'_, AppState>,
    market: String,
    code: String,
    from: Option<String>,
    to: Option<String>,
    limit: Option<usize>,
    period: Option<String>,
) -> CmdResult<Vec<Bar>> {
    let from = from.unwrap_or_default();
    let to = to.unwrap_or_default();
    let limit = limit.unwrap_or(500);
    let period = parse_period(period)?;
    db_task(state.invest_db.clone(), move |conn| {
        let daily = kline::query_bars(conn, &market, &code, &from, &to, limit)?;
        Ok(match period {
            Period::Day => daily,
            other => kline::resample(&daily, other),
        })
    })
    .await
}

fn parse_period(period: Option<String>) -> CmdResult<Period> {
    Ok(match period.as_deref().unwrap_or("1d") {
        "1d" | "day" => Period::Day,
        "1w" | "week" => Period::Week,
        "1M" | "month" => Period::Month,
        other => return Err(format!("INVALID_PERIOD: {other} (expected 1d / 1w / 1M)")),
    })
}

/// The explicit import path (`invest_kline_import`): upserts bars into the
/// local store. The read path never fetches — this is the only way bars get
/// in besides the snapshot/fund-flow fetchers.
#[tauri::command]
pub async fn invest_kline_import(
    state: State<'_, AppState>,
    market: String,
    code: String,
    bars: Vec<Bar>,
) -> CmdResult<usize> {
    db_task(state.invest_db.clone(), move |conn| {
        kline::upsert_bars(conn, &market, &code, &bars)
    })
    .await
}

#[tauri::command]
pub async fn invest_snapshot(
    state: State<'_, AppState>,
    market: String,
    code: String,
) -> CmdResult<Option<Snapshot>> {
    db_task(state.invest_db.clone(), move |conn| {
        invest::instruments::get_snapshot(conn, &market, &code)
    })
    .await
}

/// E23: the whole list's quote summary (price/prev_close per code) in one
/// query — the left column's price and change columns read from it. H1:
/// `market` is optional — absent means every market (the list is pan-market).
#[tauri::command]
pub async fn invest_quote_overview(
    state: State<'_, AppState>,
    market: Option<String>,
) -> CmdResult<Vec<QuoteSummary>> {
    db_task(state.invest_db.clone(), move |conn| {
        invest::instruments::quote_overview(conn, market.as_deref())
    })
    .await
}

/// A live snapshot refresh: fetch the Tencent quote endpoint (best effort),
/// store it, return the stored snapshot. Falls back to the stored one when
/// the network is unavailable — the UI stays usable offline. H1: the market
/// selects the quote endpoint (cn / hk / us); an unknown market is an error,
/// not a silent cn fallback.
#[tauri::command]
pub async fn invest_snapshot_refresh(
    state: State<'_, AppState>,
    market: String,
    code: String,
) -> CmdResult<Option<Snapshot>> {
    if !matches!(market.as_str(), "cn" | "hk" | "us") {
        return Err(format!("INVALID_MARKET: {market} (expected cn / hk / us)"));
    }
    // H7: the provider is configuration (quotes.yaml); a missing or broken
    // file falls back to the built-in Tencent set — a refresh never fails on
    // config alone.
    let vault = state.vault();
    let config = invest::quotes::read_config(vault.as_deref());
    // Fetch without the lock (lock discipline).
    let fetched = invest::ingest::fetch_quote_snapshot(&config, &market, &code).await;
    db_task(state.invest_db.clone(), move |conn| {
        if let Some(snap) = &fetched {
            invest::instruments::upsert_snapshot(conn, snap)?;
        }
        invest::instruments::get_snapshot(conn, &market, &code)
    })
    .await
}

#[tauri::command]
pub async fn invest_fund_flow(
    state: State<'_, AppState>,
    market: String,
    code: String,
    limit: Option<usize>,
) -> CmdResult<Vec<FundFlowDay>> {
    let limit = limit.unwrap_or(10);
    db_task(state.invest_db.clone(), move |conn| {
        invest::instruments::fund_flow(conn, &market, &code, limit)
    })
    .await
}

#[tauri::command]
pub async fn invest_financials(
    state: State<'_, AppState>,
    market: String,
    code: String,
    limit: Option<usize>,
) -> CmdResult<Vec<Financial>> {
    let limit = limit.unwrap_or(8);
    db_task(state.invest_db.clone(), move |conn| {
        invest::instruments::financials(conn, &market, &code, limit)
    })
    .await
}

#[tauri::command]
pub async fn invest_import_data(
    state: State<'_, AppState>,
    market: Option<String>,
    instruments: Option<Vec<Instrument>>,
    sectors: Option<Vec<crate::invest::model::Sector>>,
    bars: Option<Vec<Bar>>,
    code: Option<String>,
    bar_kind: Option<String>,
    financials: Option<Vec<Financial>>,
    fund_flow: Option<Vec<FundFlowDay>>,
    snapshot: Option<Snapshot>,
) -> CmdResult<serde_json::Value> {
    let market = market.unwrap_or_else(|| "cn".to_string());
    // B11: sector index bars land in their own table (the sector chart reads
    // from it); anything else defaults to the stock K-line table.
    let bar_kind = bar_kind.unwrap_or_else(|| "stock".to_string());
    db_task(state.invest_db.clone(), move |conn| {
        let mut counts = serde_json::Map::new();
        if let Some(list) = &instruments {
            let mut n = 0usize;
            for inst in list {
                if invest::instruments::upsert(conn, inst)? {
                    n += 1;
                }
            }
            counts.insert("instruments".into(), serde_json::json!(n));
        }
        // B11: the sector skeleton rides the same import path — without it
        // the sector view is an empty table forever.
        if let Some(list) = &sectors {
            let mut n = 0usize;
            for sector in list {
                invest::sectors::upsert(conn, sector)?;
                n += 1;
            }
            counts.insert("sectors".into(), serde_json::json!(n));
        }
        // H1: the market of a code is the instrument master's fact, not the
        // payload's default — an hk instrument's bars/financials must land
        // under (hk, code) even though the `market` argument defaults to cn.
        // The master rows of THIS payload win; the fall-back stays the
        // explicit `market` argument (a data-only import for an already
        // listed instrument).
        let market_of = |conn: &Connection, code: &str| -> Result<String, String> {
            invest::instruments::market_for(conn, instruments.as_deref(), code, &market)
        };
        if let (Some(code_of), Some(list)) = (&code, &bars) {
            // The quality gate (blind test Q-P0-2/3): an OHLC-inconsistent bar
            // is a data pipeline bug, not a display quirk — reject the import
            // with the offending row named instead of storing it silently.
            for (i, bar) in list.iter().enumerate() {
                let bad = bar.close <= 0.0
                    || bar.open <= 0.0
                    || bar.high < bar.open.max(bar.close)
                    || bar.low > bar.open.min(bar.close)
                    || bar.low <= 0.0;
                if bad {
                    return Err(format!(
                        "INVALID_BAR: row {} of {}: OHLC inconsistent (o={} h={} l={} c={})",
                        i + 1,
                        code_of,
                        bar.open,
                        bar.high,
                        bar.low,
                        bar.close
                    ));
                }
            }
            let stored = match bar_kind.as_str() {
                "sector" => invest::sectors::upsert_bars(conn, code_of, list)?,
                "stock" => {
                    let m = market_of(conn, code_of)?;
                    invest::kline::upsert_bars(conn, &m, code_of, list)?
                }
                other => {
                    return Err(format!(
                        "INVALID_BAR_KIND: {other} (expected stock / sector)"
                    ))
                }
            };
            counts.insert("bars".into(), serde_json::json!(stored));
        }
        if let (Some(code_of), Some(list)) = (&code, &financials) {
            let m = market_of(conn, code_of)?;
            for f in list {
                invest::instruments::upsert_financial(conn, &m, code_of, f)?;
            }
            counts.insert("financials".into(), serde_json::json!(list.len()));
        }
        if let (Some(code_of), Some(list)) = (&code, &fund_flow) {
            let m = market_of(conn, code_of)?;
            for day in list {
                invest::instruments::upsert_fund_flow_day(conn, &m, code_of, day)?;
            }
            counts.insert("fund_flow".into(), serde_json::json!(list.len()));
        }
        if let Some(snap) = &snapshot {
            invest::instruments::upsert_snapshot(conn, snap)?;
            counts.insert("snapshot".into(), serde_json::json!(1));
        }
        Ok(serde_json::Value::Object(counts))
    })
    .await
}

// ---------------------------------------------------------------------------
// Sectors
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invest_list_sectors(
    state: State<'_, AppState>,
) -> CmdResult<Vec<crate::invest::model::Sector>> {
    db_task(state.invest_db.clone(), invest::sectors::list).await
}

#[tauri::command]
pub async fn invest_sector_bars(
    state: State<'_, AppState>,
    code: String,
    from: Option<String>,
    to: Option<String>,
    limit: Option<usize>,
    period: Option<String>,
) -> CmdResult<Vec<Bar>> {
    let from = from.unwrap_or_default();
    let to = to.unwrap_or_default();
    let limit = limit.unwrap_or(500);
    let period = parse_period(period)?;
    db_task(state.invest_db.clone(), move |conn| {
        invest::sectors::query_bars(conn, &code, &from, &to, limit, period)
    })
    .await
}

#[tauri::command]
pub async fn invest_sector_members(
    state: State<'_, AppState>,
    code: String,
) -> CmdResult<Vec<Instrument>> {
    db_task(state.invest_db.clone(), move |conn| {
        invest::sectors::members(conn, &code)
    })
    .await
}

// ---------------------------------------------------------------------------
// Documents (the scope's Markdown corpus)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invest_ensure_scope_docs(
    state: State<'_, AppState>,
    scope: String,
    title: String,
) -> CmdResult<Vec<DocInfo>> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    db_task(state.invest_db.clone(), move |conn| {
        invest::docs::ensure_scope_docs(conn, &vault, &scope, &title)?;
        invest::docs::list_scope_files(conn, &vault, &scope)
    })
    .await
}

#[tauri::command]
pub async fn invest_list_docs(
    state: State<'_, AppState>,
    scope: String,
) -> CmdResult<Vec<DocInfo>> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    db_task(state.invest_db.clone(), move |conn| {
        invest::docs::list_scope_files(conn, &vault, &scope)
    })
    .await
}

#[tauri::command]
pub async fn invest_read_doc(state: State<'_, AppState>, rel_path: String) -> CmdResult<String> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    invest::docs::read_doc(&vault, &rel_path)
}

#[tauri::command]
pub async fn invest_write_doc(
    state: State<'_, AppState>,
    rel_path: String,
    content: String,
    scope: String,
    kind: Option<String>,
) -> CmdResult<()> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    let kind = kind.unwrap_or_else(|| "note".to_string());
    db_task(state.invest_db.clone(), move |conn| {
        invest::docs::write_doc(conn, &vault, &rel_path, &content, &scope, &kind)
    })
    .await
}

#[tauri::command]
pub async fn invest_search_knowledge(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<SearchHit>> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    let limit = limit.unwrap_or(20);
    db_task(state.invest_db.clone(), move |conn| {
        let hits = invest::docs::search(conn, &query, limit)?;
        // The excerpt is cut from the file body (the contentless FTS mirror
        // cannot produce snippet() output). A file deleted after indexing
        // just degrades to an empty excerpt, not an error.
        Ok(hits
            .into_iter()
            .map(|doc| {
                let body = invest::docs::read_doc(&vault, &doc.rel_path).unwrap_or_default();
                SearchHit {
                    snippet: invest::docs::snippet_around(&body, &query, 48),
                    doc,
                }
            })
            .collect())
    })
    .await
}

// ---------------------------------------------------------------------------
// Ontology (the knowledge graph)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invest_graph_view(
    state: State<'_, AppState>,
    name: String,
    kind: String,
) -> CmdResult<Option<GraphView>> {
    db_task(state.invest_db.clone(), move |conn| {
        invest::ontology::graph_view(conn, &name, &kind)
    })
    .await
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invest_events(
    state: State<'_, AppState>,
    scope: String,
    limit: Option<usize>,
) -> CmdResult<Vec<Event>> {
    let limit = limit.unwrap_or(50);
    db_task(state.invest_db.clone(), move |conn| {
        invest::ingest::list_events(conn, &scope, limit)
    })
    .await
}

#[tauri::command]
pub async fn invest_recent_events(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> CmdResult<Vec<Event>> {
    let limit = limit.unwrap_or(50);
    db_task(state.invest_db.clone(), move |conn| {
        invest::ingest::recent_events(conn, limit)
    })
    .await
}

/// F26: a manually recorded event (source = "manual", no url; the dedup hash
/// still applies so a double submit is ignored, not duplicated).
#[tauri::command]
pub async fn invest_event_add(
    state: State<'_, AppState>,
    scope: String,
    date: String,
    kind: String,
    title: String,
    body: Option<String>,
    sentiment: Option<String>,
) -> CmdResult<bool> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("INVALID_EVENT: title is required".to_string());
    }
    if date.len() != 10 || date.matches('-').count() != 2 {
        return Err(format!(
            "INVALID_EVENT: date must be YYYY-MM-DD (got {date})"
        ));
    }
    db_task(state.invest_db.clone(), move |conn| {
        invest::ingest::insert_event(
            conn,
            &scope,
            &date,
            kind.trim()
                .is_empty()
                .then_some("公告")
                .unwrap_or(kind.trim()),
            &title,
            body.as_deref().unwrap_or(""),
            "manual",
            "",
            sentiment.as_deref(),
        )
    })
    .await
}

// ---------------------------------------------------------------------------
// The ingest pipeline
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invest_ingest_run(state: State<'_, AppState>) -> CmdResult<IngestRunResult> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    let db = state.invest_db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // block_on inside a blocking thread: the fetches are async, the writes
        // take the mutex briefly inside ingest_one.
        tauri::async_runtime::block_on(invest::ingest::run(&db, &vault))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn invest_read_sources(state: State<'_, AppState>) -> CmdResult<String> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    let cfg = invest::ingest::read_sources(&vault)?;
    Ok(invest::ingest::sources_to_yaml(&cfg))
}

#[tauri::command]
pub async fn invest_save_sources(state: State<'_, AppState>, yaml: String) -> CmdResult<()> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    // Validate before writing: a broken file never lands on disk.
    let cfg = invest::ingest::parse_sources(&yaml)?;
    let path = invest::root_dir(&vault).join("sources.yaml");
    std::fs::write(&path, &yaml)
        .map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))?;
    let _ = cfg;
    Ok(())
}

/// H7: the raw quotes.yaml (the commented template on first read).
#[tauri::command]
pub async fn invest_read_quotes(state: State<'_, AppState>) -> CmdResult<String> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    Ok(invest::quotes::read_yaml(&vault))
}

/// H7: validates before writing — a broken file never lands on disk.
#[tauri::command]
pub async fn invest_save_quotes(state: State<'_, AppState>, yaml: String) -> CmdResult<()> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    invest::quotes::save_yaml(&vault, &yaml)
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invest_read_skill(
    state: State<'_, AppState>,
    scope: String,
) -> CmdResult<SkillBundle> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    db_task(state.invest_db.clone(), move |conn| {
        invest::skill::read(conn, &vault, &scope)
    })
    .await
}

#[tauri::command]
pub async fn invest_write_skill(
    state: State<'_, AppState>,
    scope: String,
    skill: String,
    memory: String,
    snapshot: bool,
) -> CmdResult<i64> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    db_task(state.invest_db.clone(), move |conn| {
        invest::skill::write(conn, &vault, &scope, &skill, &memory, snapshot)
    })
    .await
}

#[tauri::command]
pub async fn invest_skill_learned_edit(
    state: State<'_, AppState>,
    scope: String,
    anchor: String,
    content: String,
    replace: bool,
) -> CmdResult<()> {
    let vault = state.vault().ok_or("NO_VAULT: open a notebook first")?;
    invest::skill::apply_learned_edit(&vault, &scope, &anchor, &content, replace)
}

// ---------------------------------------------------------------------------
// Forecasts (the walk-forward replay)
// ---------------------------------------------------------------------------

/// Runs the rule predictor for one `as_of`, records it, and settles it when
/// the actual bars exist. The agent path produces the same records through
/// its own tool (the prediction contract is identical).
#[tauri::command]
pub async fn invest_forecast_replay(
    state: State<'_, AppState>,
    scope: String,
    market: String,
    code: String,
    as_of: Option<String>,
    horizon: Option<usize>,
) -> CmdResult<crate::invest::model::Forecast> {
    let horizon = horizon.unwrap_or(5);
    db_task(state.invest_db.clone(), move |conn| {
        let bars = kline::query_bars(conn, &market, &code, "", "", 5000)?;
        if bars.is_empty() {
            return Err("NO_DATA: no bars for this scope — import K-line data first".to_string());
        }
        // The default as-of anchors to the **data**, not the wall clock: a
        // replay of a stale dataset must predict the last settleable point in
        // it, and the wall-clock date lands outside the data entirely (blind
        // test: `NOT_FOUND: as_of … is not a trading day` on every replay).
        // Explicit date = "10 trading bars back from today" is requested by
        // the caller passing a concrete ISO date; an empty string anchors to
        // the last bar with data after it.
        let resolved_as_of = match as_of.as_deref() {
            Some(date) if !date.is_empty() => {
                if !bars.iter().any(|b| b.ts == date) {
                    let last = bars.last().map(|b| b.ts.as_str()).unwrap_or("");
                    return Err(format!(
                        "NO_DATA: as_of {date} is not a trading day in the data (data ends {last})"
                    ));
                }
                date.to_string()
            }
            // Default: horizon bars before the end — the last point that can
            // actually settle against known data.
            _ => {
                let idx = bars.len().saturating_sub(horizon + 1);
                bars[idx].ts.clone()
            }
        };
        let p = invest::forecast::rule_forecast(&bars, &resolved_as_of, horizon)?;
        let (target, _) = invest::forecast::actual_move(&bars, &resolved_as_of, horizon)
            .unwrap_or((String::new(), 0.0));
        let id =
            invest::forecast::record(conn, &scope, "rule", &resolved_as_of, &target, &p, "replay")?;
        let settled = invest::forecast::settle(conn, &market, &code, id, horizon)?;
        let list = invest::forecast::list(conn, &scope, 1)?;
        list.into_iter()
            .next()
            .filter(|f| f.id == id)
            .map(|f| {
                let _ = settled;
                f
            })
            .ok_or_else(|| "NOT_FOUND: forecast vanished after record".to_string())
    })
    .await
}

/// Settles every replay forecast of the scope that now has actual data.
#[tauri::command]
pub async fn invest_forecast_settle(
    state: State<'_, AppState>,
    scope: String,
    market: String,
    code: String,
    horizon: Option<usize>,
) -> CmdResult<usize> {
    let horizon = horizon.unwrap_or(5);
    db_task(state.invest_db.clone(), move |conn| {
        let pending = invest::forecast::list(conn, &scope, 500)?;
        let mut settled = 0;
        for f in &pending {
            if f.score.is_none() {
                if invest::forecast::settle(conn, &market, &code, f.id, horizon)?.is_some() {
                    settled += 1;
                }
            }
        }
        Ok(settled)
    })
    .await
}

#[tauri::command]
pub async fn invest_forecasts(
    state: State<'_, AppState>,
    scope: String,
    limit: Option<usize>,
) -> CmdResult<Vec<crate::invest::model::Forecast>> {
    let limit = limit.unwrap_or(100);
    db_task(state.invest_db.clone(), move |conn| {
        invest::forecast::list(conn, &scope, limit)
    })
    .await
}

#[tauri::command]
pub async fn invest_forecast_accuracy(
    state: State<'_, AppState>,
    scope: String,
) -> CmdResult<Option<(i64, f64, f64)>> {
    db_task(state.invest_db.clone(), move |conn| {
        invest::forecast::accuracy(conn, &scope)
    })
    .await
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invest_backtest_run(
    state: State<'_, AppState>,
    scope: String,
    market: String,
    code: String,
    strategy: String,
    fast: Option<usize>,
    slow: Option<usize>,
    start: Option<String>,
    end: Option<String>,
    initial_cash: Option<f64>,
) -> CmdResult<BacktestRun> {
    let fast = fast.unwrap_or(5);
    let slow = slow.unwrap_or(20);
    let start = start.unwrap_or_default();
    let end = end.unwrap_or_default();
    let initial_cash = initial_cash.unwrap_or(1_000_000.0);
    db_task(state.invest_db.clone(), move |conn| {
        let bars = kline::query_bars(conn, &market, &code, &start, &end, 5000)?;
        if bars.len() < 2 {
            return Err(format!(
                "NOT_ENOUGH_DATA: {} has {} bars in the window; a backtest needs at least 2",
                code,
                bars.len()
            ));
        }
        let cfg = match strategy.as_str() {
            "ma_cross" => StrategyConfig {
                kind: StrategyKind::MaCross { fast, slow },
                size_ratio: 1.0,
            },
            "skill_signal" => {
                // The settled forecasts become the position schedule.
                let forecasts = invest::forecast::list(conn, &scope, 500)?;
                let directions = forecasts
                    .iter()
                    .filter(|f| f.score.is_some())
                    .map(|f| (f.target_date.clone(), f.direction.clone()))
                    .collect();
                StrategyConfig { kind: StrategyKind::SkillSignal { directions }, size_ratio: 1.0 }
            }
            other => return Err(format!("INVALID_STRATEGY: {other} (ma_cross | skill_signal)")),
        };
        let result = backtest::run(&bars, &cfg, initial_cash, &market);
        let start_date = bars[0].ts.clone();
        let end_date = bars.last().map(|b| b.ts.clone()).unwrap_or_default();
        let trades_json = serde_json::to_string(&result.fills).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO backtests(scope, skill_version, strategy, params, start_date, end_date, metrics, equity, created_at, trades)
             VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s','now'), ?8)",
            rusqlite::params![
                scope,
                strategy,
                format!("{{\"fast\":{fast},\"slow\":{slow}}}"),
                start_date,
                end_date,
                serde_json::to_string(&result.metrics).unwrap_or_default(),
                serde_json::to_string(&result.equity).unwrap_or_default(),
                trades_json,
            ],
        )
        .map_err(|e| format!("DB_WRITE_FAILED: backtest: {}", e))?;
        let id = conn.last_insert_rowid();
        let run_at: Option<i64> = match conn
            .query_row("SELECT created_at FROM backtests WHERE id=?1", [id], |r| r.get(0))
        {
            Ok(ts) => Some(ts),
            Err(_) => None,
        };
        Ok(BacktestRun {
            id,
            scope,
            skill_version: None,
            params: if strategy == "ma_cross" {
                Some(serde_json::json!({ "fast": fast, "slow": slow }))
            } else {
                None
            },
            strategy,
            start_date,
            end_date,
            metrics: result.metrics,
            equity: result.equity,
            run_at,
            trades: result.fills,
        })
    })
    .await
}

#[tauri::command]
pub async fn invest_backtest_list(
    state: State<'_, AppState>,
    scope: String,
    limit: Option<usize>,
) -> CmdResult<Vec<BacktestRun>> {
    let limit = limit.unwrap_or(20);
    db_task(
        state.invest_db.clone(),
        move |conn| -> CmdResult<Vec<BacktestRun>> {
            let mut stmt = conn
            .prepare(
                "SELECT id, scope, skill_version, strategy, params, start_date, end_date, metrics, equity, created_at, trades
                 FROM backtests WHERE scope=?1 ORDER BY id DESC LIMIT ?2",
            )
            .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
            let rows = stmt
                .query_map(rusqlite::params![scope, limit.clamp(1, 100)], |r| {
                    let metrics_json: String = r.get(7)?;
                    let equity_json: String = r.get(8)?;
                    let trades_json: Option<String> = r.get(10).ok();
                    Ok(BacktestRun {
                        id: r.get(0)?,
                        scope: r.get(1)?,
                        skill_version: r.get(2)?,
                        strategy: r.get(3)?,
                        params: r.get::<_, Option<String>>(4)
                            .ok()
                            .flatten()
                            .and_then(|json| serde_json::from_str(&json).ok()),
                        start_date: r.get(5)?,
                        end_date: r.get(6)?,
                        metrics: serde_json::from_str(&metrics_json).unwrap_or_default(),
                        equity: serde_json::from_str(&equity_json).unwrap_or_default(),
                        run_at: r.get(9).ok(),
                        // Rows written before the trades column existed carry
                        // an empty ledger.
                        trades: trades_json
                            .and_then(|json| serde_json::from_str(&json).ok())
                            .unwrap_or_default(),
                    })
                })
                .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
            }
            Ok(out)
        },
    )
    .await
}

/// D20: removes one backtest run from the history (the list refreshes).
#[tauri::command]
pub async fn invest_backtest_delete(state: State<'_, AppState>, id: i64) -> CmdResult<bool> {
    db_task(state.invest_db.clone(), move |conn| {
        let n = conn
            .execute("DELETE FROM backtests WHERE id=?1", rusqlite::params![id])
            .map_err(|e| format!("DB_WRITE_FAILED: backtest delete: {}", e))?;
        Ok(n > 0)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support;

    #[test]
    fn invest_commands_require_a_vault() {
        let app = test_support::app("invest-no-vault");
        let state = app.state();
        let result = db::with_conn(&state.invest_db, |conn| {
            invest::instruments::list(conn, "", false, 10)
        });
        assert!(result.is_err(), "no vault → NO_VAULT error");
    }

    #[test]
    fn invest_commands_run_against_a_vault_db() {
        let app = test_support::app_with_vault("invest-vault");
        let vault = app.dir.join("vault");
        let state = app.state();
        state.open_invest_db(&vault).unwrap();

        let conn_guard = state.invest_db.lock().unwrap();
        let conn = conn_guard.as_ref().unwrap();
        let inst = Instrument {
            code: "600519".into(),
            market: "cn".into(),
            name: "贵州茅台".into(),
            industry: "食品饮料".into(),
            sector_code: Some("801120".into()),
            sector_sub: None,
            kind: "stock".into(),
            note: String::new(),
            watch: true,
        };
        invest::instruments::upsert(conn, &inst).unwrap();
        drop(conn_guard);

        let list = db::with_conn(&state.invest_db, |conn| {
            invest::instruments::list(conn, "", true, 10)
        })
        .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "贵州茅台");
    }

    /// H2: an unknown market is a command-boundary error (INVALID_MARKET),
    /// not a silent cn fallback and not a network attempt.
    /// Registry row "ingested-data shape drift": an OHLC-inconsistent bar is
    /// a pipeline bug, not a display quirk — the command boundary rejects it
    /// naming the row instead of storing it silently.
    #[test]
    fn import_rejects_ohlc_inconsistent_bars() {
        let app = test_support::app_with_vault("invest-invalid-bar");
        let vault = app.dir.join("vault");
        let state = app.state();
        state.open_invest_db(&vault).unwrap();

        let inst = Instrument {
            code: "600519".into(),
            market: "cn".into(),
            name: "贵州茅台".into(),
            industry: "白酒".into(),
            sector_code: None,
            sector_sub: None,
            kind: "stock".into(),
            note: String::new(),
            watch: false,
        };
        let bad_bar = Bar {
            ts: "2025-01-02".into(),
            open: 100.0,
            high: 105.0,
            low: 101.0, // above the close — physically impossible
            close: 95.0,
            volume: 1000.0,
            amount: None,
            source: "t".into(),
        };
        let result = test_support::block_on(invest_import_data(
            state,
            Some("cn".into()),
            Some(vec![inst]),
            None,
            Some(vec![bad_bar]),
            Some("600519".into()),
            None,
            None,
            None,
            None,
        ));
        let err = result.unwrap_err();
        assert!(err.starts_with("INVALID_BAR: row 1"), "{err}");
    }

    #[test]
    fn import_rejects_an_unknown_bar_kind() {
        let app = test_support::app_with_vault("invest-invalid-kind");
        let vault = app.dir.join("vault");
        let state = app.state();
        state.open_invest_db(&vault).unwrap();
        let bar = Bar {
            ts: "2025-01-02".into(),
            open: 100.0,
            high: 105.0,
            low: 99.0,
            close: 101.0,
            volume: 1000.0,
            amount: None,
            source: "t".into(),
        };
        let result = test_support::block_on(invest_import_data(
            state,
            Some("cn".into()),
            None,
            None,
            Some(vec![bar]),
            Some("600519".into()),
            Some("weird".into()),
            None,
            None,
            None,
        ));
        let err = result.unwrap_err();
        assert!(err.starts_with("INVALID_BAR_KIND"), "{err}");
    }

    #[test]
    fn snapshot_refresh_rejects_unknown_markets() {
        let app = test_support::app("invest-invalid-market");
        let state = app.state();
        let result =
            test_support::block_on(invest_snapshot_refresh(state, "jp".into(), "7203".into()));
        assert!(result.unwrap_err().starts_with("INVALID_MARKET"));
    }

    #[test]
    fn period_parsing_rejects_unknowns() {
        assert!(parse_period(Some("1w".into())).is_ok());
        assert!(parse_period(Some("3m".into())).is_err());
    }
}
