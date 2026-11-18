//! The instrument master: list/search, watchlist, snapshots, fund flow,
//! financials.

use rusqlite::Connection;

use crate::invest::model::{Financial, FundFlowDay, Instrument, QuoteSummary, Snapshot};

const SELECT_INSTRUMENT: &str = "SELECT code, market, name, industry, sector_code, sector_sub,
    kind, note, watch FROM instruments";

fn row_instrument(r: &rusqlite::Row) -> rusqlite::Result<Instrument> {
    Ok(Instrument {
        code: r.get(0)?,
        market: r.get(1)?,
        name: r.get(2)?,
        industry: r.get(3)?,
        sector_code: r.get(4)?,
        sector_sub: r.get(5)?,
        kind: r.get(6)?,
        note: r.get(7)?,
        watch: r.get::<_, i64>(8)? != 0,
    })
}

/// The list, optionally filtered: `query` matches code prefix or a name
/// substring; `watch_only` keeps the watchlist only. `limit` caps the page
/// (the A-share market is ~5400 rows; the UI pages through it).
pub fn list(
    conn: &Connection,
    query: &str,
    watch_only: bool,
    limit: usize,
) -> Result<Vec<Instrument>, String> {
    let mut sql = SELECT_INSTRUMENT.to_string();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let q = query.trim();
    if !q.is_empty() {
        // A pure digit query matches the code prefix; anything else matches
        // the name (LIKE with escaping so % in input is literal).
        if q.chars().all(|c| c.is_ascii_digit()) {
            sql.push_str(&format!(" WHERE (code LIKE ?{} || '%')", params.len() + 1));
            params.push(Box::new(q.to_string()));
        } else {
            sql.push_str(&format!(
                " WHERE (name LIKE '%' || ?{} || '%')",
                params.len() + 1
            ));
            params.push(Box::new(q.to_string()));
        }
    }
    if watch_only {
        sql.push_str(if params.is_empty() { " WHERE" } else { " AND" });
        sql.push_str(" watch=1");
    }
    sql.push_str(&format!(" ORDER BY code LIMIT {}", limit.clamp(1, 2000)));
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let refs: Vec<&dyn rusqlite::ToSql> = params
        .iter()
        .map(|p| p.as_ref() as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt
        .query_map(refs.as_slice(), row_instrument)
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

/// One instrument (None = unknown code).
pub fn get(conn: &Connection, market: &str, code: &str) -> Result<Option<Instrument>, String> {
    let sql = format!("{SELECT_INSTRUMENT} WHERE market=?1 AND code=?2");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let mut rows = stmt
        .query_map(rusqlite::params![market, code], row_instrument)
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?)),
        None => Ok(None),
    }
}

/// Upserts one instrument (the import path). Returns whether it is new.
pub fn upsert(conn: &Connection, inst: &Instrument) -> Result<bool, String> {
    let existed = get(conn, &inst.market, &inst.code)?;
    conn.execute(
        "INSERT INTO instruments(code, market, name, industry, sector_code, sector_sub, kind, note, watch, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%s','now'))
         ON CONFLICT(market, code) DO UPDATE SET
           name=excluded.name, industry=excluded.industry,
           sector_code=excluded.sector_code, sector_sub=excluded.sector_sub,
           kind=excluded.kind, updated_at=excluded.updated_at",
        rusqlite::params![
            inst.code,
            inst.market,
            inst.name,
            inst.industry,
            inst.sector_code,
            inst.sector_sub,
            inst.kind,
            inst.note,
            if inst.watch { 1 } else { 0 },
        ],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: instrument {}: {}", inst.code, e))?;
    Ok(existed.is_none())
}

/// Toggles the watchlist flag; returns the new value.
pub fn set_watch(conn: &Connection, market: &str, code: &str, watch: bool) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE instruments SET watch=?3 WHERE market=?1 AND code=?2",
            rusqlite::params![market, code, if watch { 1 } else { 0 }],
        )
        .map_err(|e| format!("DB_WRITE_FAILED: watch {}: {}", code, e))?;
    if n == 0 {
        return Err(format!("NOT_FOUND: instrument {code} is not in the master"));
    }
    Ok(watch)
}

/// H1: the market of a code is the instrument master's fact, not the payload
/// default. Resolution order: THIS import's instrument rows, then the DB's
/// listed rows, then the explicit fallback (a data-only import for an
/// already-listed instrument). Extracted from the import command so the
/// routing bug class (hk bars landing under cn) is testable.
pub fn market_for(
    conn: &Connection,
    instruments: Option<&[Instrument]>,
    code: &str,
    fallback: &str,
) -> Result<String, String> {
    if let Some(list) = instruments {
        if let Some(inst) = list.iter().find(|i| i.code == code) {
            return Ok(inst.market.clone());
        }
    }
    let known: Option<String> = conn
        .query_row(
            "SELECT market FROM instruments WHERE code=?1 ORDER BY rowid DESC LIMIT 1",
            rusqlite::params![code],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            _ => Err(format!("DB_QUERY_FAILED: {}", e)),
        })?;
    Ok(known.unwrap_or_else(|| fallback.to_string()))
}

/// The newest snapshot of one instrument (None = never fetched).
/// E23: the per-code quote summary for the list rows (price + prev_close),
/// one query for the whole list instead of N snapshot reads. `market` is
/// None for every market (H1: the pan-market list).
pub fn quote_overview(
    conn: &Connection,
    market: Option<&str>,
) -> Result<Vec<QuoteSummary>, String> {
    let (sql, param): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match market {
        Some(m) => (
            "SELECT code, price, prev_close FROM snapshots WHERE market=?1 AND price IS NOT NULL",
            vec![Box::new(m.to_string())],
        ),
        None => (
            "SELECT code, price, prev_close FROM snapshots WHERE price IS NOT NULL",
            vec![],
        ),
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(param), |r| {
            Ok(QuoteSummary {
                code: r.get(0)?,
                price: r.get(1)?,
                prev_close: r.get(2)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

pub fn get_snapshot(
    conn: &Connection,
    market: &str,
    code: &str,
) -> Result<Option<Snapshot>, String> {
    conn.query_row(
        "SELECT code, market, price, prev_close, open, high, low, volume, amount, turnover,
                pe, pb, market_cap, float_cap, limit_up, limit_down, amplitude, volume_ratio,
                currency, fetched_at
         FROM snapshots WHERE market=?1 AND code=?2",
        rusqlite::params![market, code],
        |r| {
            Ok(Some(Snapshot {
                code: r.get(0)?,
                market: r.get(1)?,
                price: r.get(2)?,
                prev_close: r.get(3)?,
                open: r.get(4)?,
                high: r.get(5)?,
                low: r.get(6)?,
                volume: r.get(7)?,
                amount: r.get(8)?,
                turnover: r.get(9)?,
                pe: r.get(10)?,
                pb: r.get(11)?,
                market_cap: r.get(12)?,
                float_cap: r.get(13)?,
                limit_up: r.get(14)?,
                limit_down: r.get(15)?,
                amplitude: r.get(16)?,
                volume_ratio: r.get(17)?,
                currency: r.get(18)?,
                fetched_at: r.get(19)?,
            }))
        },
    )
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        _ => Err(format!("DB_QUERY_FAILED: {}", e)),
    })
}

pub fn upsert_snapshot(conn: &Connection, snap: &Snapshot) -> Result<(), String> {
    conn.execute(
        "INSERT INTO snapshots(market, code, price, prev_close, open, high, low, volume, amount,
             turnover, pe, pb, market_cap, float_cap, limit_up, limit_down, amplitude,
             volume_ratio, currency, fetched_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
         ON CONFLICT(market, code) DO UPDATE SET
           price=excluded.price, prev_close=excluded.prev_close, open=excluded.open,
           high=excluded.high, low=excluded.low, volume=excluded.volume, amount=excluded.amount,
           turnover=excluded.turnover, pe=excluded.pe, pb=excluded.pb,
           market_cap=excluded.market_cap, float_cap=excluded.float_cap,
           limit_up=excluded.limit_up, limit_down=excluded.limit_down,
           amplitude=excluded.amplitude, volume_ratio=excluded.volume_ratio,
           currency=excluded.currency, fetched_at=excluded.fetched_at",
        rusqlite::params![
            snap.market,
            snap.code,
            snap.price,
            snap.prev_close,
            snap.open,
            snap.high,
            snap.low,
            snap.volume,
            snap.amount,
            snap.turnover,
            snap.pe,
            snap.pb,
            snap.market_cap,
            snap.float_cap,
            snap.limit_up,
            snap.limit_down,
            snap.amplitude,
            snap.volume_ratio,
            snap.currency,
            snap.fetched_at,
        ],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: snapshot {}: {}", snap.code, e))?;
    Ok(())
}

/// The last `limit` fund-flow days, ascending.
pub fn fund_flow(
    conn: &Connection,
    market: &str,
    code: &str,
    limit: usize,
) -> Result<Vec<FundFlowDay>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM (SELECT date, close, change_ratio, turnover, net_amount, net_ratio,
                    main_net, main_ratio
             FROM fund_flow WHERE market=?1 AND code=?2 ORDER BY date DESC LIMIT ?3) ORDER BY date ASC",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![market, code, limit.clamp(1, 120)], |r| {
            Ok(FundFlowDay {
                date: r.get(0)?,
                close: r.get(1)?,
                change_ratio: r.get(2)?,
                turnover: r.get(3)?,
                net_amount: r.get(4)?,
                net_ratio: r.get(5)?,
                main_net: r.get(6)?,
                main_ratio: r.get(7)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

pub fn upsert_fund_flow_day(
    conn: &Connection,
    market: &str,
    code: &str,
    day: &FundFlowDay,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO fund_flow(market, code, date, close, change_ratio, turnover, net_amount, net_ratio, main_net, main_ratio)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(market, code, date) DO UPDATE SET
           close=excluded.close, change_ratio=excluded.change_ratio, turnover=excluded.turnover,
           net_amount=excluded.net_amount, net_ratio=excluded.net_ratio,
           main_net=excluded.main_net, main_ratio=excluded.main_ratio",
        rusqlite::params![
            market,
            code,
            day.date,
            day.close,
            day.change_ratio,
            day.turnover,
            day.net_amount,
            day.net_ratio,
            day.main_net,
            day.main_ratio,
        ],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: fund_flow {}: {}", code, e))?;
    Ok(())
}

/// Financial report periods for one instrument, newest first.
pub fn financials(
    conn: &Connection,
    market: &str,
    code: &str,
    limit: usize,
) -> Result<Vec<Financial>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT fiscal_year, fiscal_period, revenue, revenue_yoy, net_profit, net_profit_yoy,
                    deduct_profit, op_cashflow, eps, gross_margin, net_margin, roe, roa,
                    debt_ratio, current_ratio
             FROM financials WHERE market=?1 AND code=?2
             ORDER BY fiscal_year DESC, fiscal_period DESC LIMIT ?3",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![market, code, limit.clamp(1, 16)], |r| {
            Ok(Financial {
                fiscal_year: r.get(0)?,
                fiscal_period: r.get(1)?,
                revenue: r.get(2)?,
                revenue_yoy: r.get(3)?,
                net_profit: r.get(4)?,
                net_profit_yoy: r.get(5)?,
                deduct_profit: r.get(6)?,
                op_cashflow: r.get(7)?,
                eps: r.get(8)?,
                gross_margin: r.get(9)?,
                net_margin: r.get(10)?,
                roe: r.get(11)?,
                roa: r.get(12)?,
                debt_ratio: r.get(13)?,
                current_ratio: r.get(14)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub fn upsert_financial(
    conn: &Connection,
    market: &str,
    code: &str,
    f: &Financial,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO financials(market, code, fiscal_year, fiscal_period, revenue, revenue_yoy,
             net_profit, net_profit_yoy, deduct_profit, op_cashflow, eps, gross_margin, net_margin,
             roe, roa, debt_ratio, current_ratio, data)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'{}')
         ON CONFLICT(market, code, fiscal_year, fiscal_period) DO UPDATE SET
           revenue=excluded.revenue, revenue_yoy=excluded.revenue_yoy,
           net_profit=excluded.net_profit, net_profit_yoy=excluded.net_profit_yoy,
           deduct_profit=excluded.deduct_profit, op_cashflow=excluded.op_cashflow, eps=excluded.eps,
           gross_margin=excluded.gross_margin, net_margin=excluded.net_margin, roe=excluded.roe,
           roa=excluded.roa, debt_ratio=excluded.debt_ratio, current_ratio=excluded.current_ratio",
        rusqlite::params![
            market,
            code,
            f.fiscal_year,
            f.fiscal_period,
            f.revenue,
            f.revenue_yoy,
            f.net_profit,
            f.net_profit_yoy,
            f.deduct_profit,
            f.op_cashflow,
            f.eps,
            f.gross_margin,
            f.net_margin,
            f.roe,
            f.roa,
            f.debt_ratio,
            f.current_ratio,
        ],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: financial {}: {}", code, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invest::db;

    fn inst(code: &str, name: &str, industry: &str, watch: bool) -> Instrument {
        Instrument {
            code: code.into(),
            market: "cn".into(),
            name: name.into(),
            industry: industry.into(),
            sector_code: Some("801120".into()),
            sector_sub: None,
            kind: "stock".into(),
            note: String::new(),
            watch,
        }
    }

    #[test]
    fn upsert_list_search_and_watch() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        upsert(&conn, &inst("600519", "贵州茅台", "食品饮料", true)).unwrap();
        upsert(&conn, &inst("000858", "五粮液", "食品饮料", false)).unwrap();
        upsert(&conn, &inst("600519", "贵州茅台", "食品饮料", true)).unwrap();

        let all = list(&conn, "", false, 100).unwrap();
        assert_eq!(all.len(), 2, "the second upsert of 600519 is an update");

        let by_code = list(&conn, "6005", false, 100).unwrap();
        assert_eq!(by_code.len(), 1);
        assert_eq!(by_code[0].code, "600519");

        let by_name = list(&conn, "五粮", false, 100).unwrap();
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].name, "五粮液");

        let watched = list(&conn, "", true, 100).unwrap();
        assert_eq!(watched.len(), 1);

        let flipped = set_watch(&conn, "cn", "000858", true).unwrap();
        assert!(flipped);
        assert_eq!(list(&conn, "", true, 100).unwrap().len(), 2);
        assert!(set_watch(&conn, "cn", "999999", true).is_err());
    }

    /// H1: the import routing (which market's tables a batch lands in) comes
    /// from the instrument master — payload rows first, DB rows second, the
    /// explicit fallback last. A wrong order silently writes hk bars to cn.
    #[test]
    fn market_for_follows_the_instrument_master() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();

        let mut hk = inst("00700", "腾讯控股", "", true);
        hk.market = "hk".into();
        let payload = vec![hk];

        // The payload's own instrument row wins over everything.
        assert_eq!(
            market_for(&conn, Some(&payload), "00700", "cn").unwrap(),
            "hk"
        );

        // A code the payload does not carry resolves from the DB's listed rows.
        let mut us = inst("AAPL", "苹果", "", false);
        us.market = "us".into();
        upsert(&conn, &us).unwrap();
        assert_eq!(
            market_for(&conn, Some(&payload), "AAPL", "cn").unwrap(),
            "us"
        );

        // Neither payload nor DB knows the code → the explicit fallback.
        assert_eq!(
            market_for(&conn, Some(&payload), "000001", "cn").unwrap(),
            "cn"
        );
        assert_eq!(market_for(&conn, None, "000001", "cn").unwrap(), "cn");
    }

    /// H1: bars / snapshots are keyed by (market, code) — same code across
    /// markets must not bleed into each other (cn 600519 vs hk 00700 vs us
    /// AAPL live side by side).
    #[test]
    fn markets_are_isolated_by_key() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        upsert(&conn, &inst("600519", "贵州茅台", "白酒", false)).unwrap();
        let mut hk = inst("00700", "腾讯控股", "", true);
        hk.market = "hk".into();
        let mut us = inst("AAPL", "苹果", "", true);
        us.market = "us".into();
        upsert(&conn, &hk).unwrap();
        upsert(&conn, &us).unwrap();
        assert_eq!(list(&conn, "", false, 10).unwrap().len(), 3);

        let snap = |market: &str, price: f64| Snapshot {
            code: if market == "cn" {
                "600519".into()
            } else if market == "hk" {
                "00700".into()
            } else {
                "AAPL".into()
            },
            market: market.into(),
            price: Some(price),
            prev_close: Some(price - 1.0),
            open: Some(price - 0.5),
            high: Some(price + 1.0),
            low: Some(price - 2.0),
            volume: Some(1000.0),
            amount: Some(price * 1000.0),
            turnover: None,
            pe: Some(20.0),
            pb: None,
            market_cap: Some(price * 1e9),
            float_cap: None,
            limit_up: None,
            limit_down: None,
            amplitude: Some(0.02),
            volume_ratio: None,
            currency: Some(
                match market {
                    "hk" => "HKD",
                    "us" => "USD",
                    _ => "CNY",
                }
                .into(),
            ),
            fetched_at: 1731800000,
        };
        upsert_snapshot(&conn, &snap("cn", 1450.0)).unwrap();
        upsert_snapshot(&conn, &snap("hk", 390.0)).unwrap();
        upsert_snapshot(&conn, &snap("us", 352.0)).unwrap();

        let cn = get_snapshot(&conn, "cn", "600519").unwrap().unwrap();
        let hk = get_snapshot(&conn, "hk", "00700").unwrap().unwrap();
        let us = get_snapshot(&conn, "us", "AAPL").unwrap().unwrap();
        assert_eq!(cn.price, Some(1450.0));
        assert_eq!(hk.price, Some(390.0));
        assert_eq!(us.price, Some(352.0));
        assert_eq!(hk.currency.as_deref(), Some("HKD"));
        assert_eq!(us.currency.as_deref(), Some("USD"));
        // Same code, different market: no cross-write.
        assert!(get_snapshot(&conn, "cn", "00700").unwrap().is_none());
        assert!(get_snapshot(&conn, "hk", "600519").unwrap().is_none());

        // quote_overview: None = every market.
        let all = quote_overview(&conn, None).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(quote_overview(&conn, Some("hk")).unwrap().len(), 1);
    }

    #[test]
    fn snapshot_fund_flow_financials_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        upsert(&conn, &inst("600519", "贵州茅台", "食品饮料", false)).unwrap();

        let snap = Snapshot {
            code: "600519".into(),
            market: "cn".into(),
            price: Some(1500.0),
            prev_close: Some(1480.0),
            open: Some(1490.0),
            high: Some(1510.0),
            low: Some(1485.0),
            volume: Some(2_000_000.0),
            amount: Some(2_990_000_000.0),
            turnover: Some(0.16),
            pe: Some(28.5),
            pb: Some(9.1),
            market_cap: Some(1_884_000_000_000.0),
            float_cap: None,
            limit_up: Some(1628.0),
            limit_down: Some(1332.0),
            amplitude: Some(0.017),
            volume_ratio: Some(1.2),
            currency: Some("CNY".to_string()),
            fetched_at: 1731800000,
        };
        upsert_snapshot(&conn, &snap).unwrap();
        let got = get_snapshot(&conn, "cn", "600519").unwrap().unwrap();
        assert_eq!(got.price, Some(1500.0));
        assert_eq!(got.pe, Some(28.5));
        assert_eq!(got.limit_up, Some(1628.0));
        assert_eq!(got.volume_ratio, Some(1.2));
        assert_eq!(got.currency.as_deref(), Some("CNY"));
        assert!(get_snapshot(&conn, "cn", "000001").unwrap().is_none());

        let day = FundFlowDay {
            date: "2026-11-14".into(),
            close: Some(1500.0),
            change_ratio: Some(1.35),
            turnover: Some(0.16),
            net_amount: Some(230_000_000.0),
            net_ratio: Some(7.7),
            main_net: Some(180_000_000.0),
            main_ratio: Some(6.0),
        };
        upsert_fund_flow_day(&conn, "cn", "600519", &day).unwrap();
        let flow = fund_flow(&conn, "cn", "600519", 10).unwrap();
        assert_eq!(flow.len(), 1);
        assert_eq!(flow[0].main_net, Some(180_000_000.0));

        let f = Financial {
            fiscal_year: 2025,
            fiscal_period: "FY".into(),
            revenue: Some(174_100_000_000.0),
            revenue_yoy: Some(15.6),
            net_profit: Some(86_200_000_000.0),
            net_profit_yoy: Some(15.2),
            deduct_profit: Some(85_100_000_000.0),
            op_cashflow: Some(93_000_000_000.0),
            eps: Some(68.6),
            gross_margin: Some(91.9),
            net_margin: Some(49.5),
            roe: Some(34.2),
            roa: Some(24.8),
            debt_ratio: Some(17.6),
            current_ratio: Some(4.2),
        };
        upsert_financial(&conn, "cn", "600519", &f).unwrap();
        let fin = financials(&conn, "cn", "600519", 6).unwrap();
        assert_eq!(fin.len(), 1);
        assert_eq!(fin[0].roe, Some(34.2));
    }
}
