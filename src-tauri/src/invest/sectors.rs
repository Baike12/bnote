//! Sectors: the SW industry skeleton (seeded in db.rs) plus sector index bars.

use rusqlite::Connection;

use crate::invest::kline::{self, Period};
use crate::invest::model::{Bar, Sector};

pub fn list(conn: &Connection) -> Result<Vec<Sector>, String> {
    let mut stmt = conn
        .prepare("SELECT code, name, level, parent, summary FROM sectors ORDER BY code")
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Sector {
                code: r.get(0)?,
                name: r.get(1)?,
                level: r.get(2)?,
                parent: r.get(3)?,
                summary: r.get(4)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

/// Adds/updates a sector row (the import path for custom concept sectors).
pub fn upsert(conn: &Connection, sector: &Sector) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sectors(code, name, level, parent, summary) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(code) DO UPDATE SET
           name=excluded.name, level=excluded.level, parent=excluded.parent, summary=excluded.summary",
        rusqlite::params![sector.code, sector.name, sector.level, sector.parent, sector.summary],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: sector {}: {}", sector.code, e))?;
    Ok(())
}

pub fn upsert_bars(conn: &Connection, code: &str, bars: &[Bar]) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "INSERT INTO sector_kline_daily(code, ts, open, high, low, close, volume, amount)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(code, ts) DO UPDATE SET
               open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
               volume=excluded.volume, amount=excluded.amount",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let mut n = 0;
    for bar in bars {
        n += stmt
            .execute(rusqlite::params![
                code, bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount,
            ])
            .map_err(|e| format!("DB_WRITE_FAILED: sector kline {}: {}", code, e))?;
    }
    Ok(n)
}

/// Sector index bars, same window semantics as `kline::query_bars`.
pub fn query_bars(
    conn: &Connection,
    code: &str,
    from: &str,
    to: &str,
    limit: usize,
    period: Period,
) -> Result<Vec<Bar>, String> {
    let sql = match (from.is_empty(), to.is_empty()) {
        (false, false) => {
            "SELECT * FROM (SELECT ts, open, high, low, close, volume, amount
             FROM sector_kline_daily WHERE code=?1 AND ts>=?2 AND ts<=?3 ORDER BY ts DESC LIMIT ?4)
             ORDER BY ts ASC"
        }
        (true, false) => {
            "SELECT * FROM (SELECT ts, open, high, low, close, volume, amount
             FROM sector_kline_daily WHERE code=?1 AND ts<=?2 ORDER BY ts DESC LIMIT ?3)
             ORDER BY ts ASC"
        }
        (false, true) => {
            "SELECT * FROM (SELECT ts, open, high, low, close, volume, amount
             FROM sector_kline_daily WHERE code=?1 AND ts>=?2 ORDER BY ts DESC LIMIT ?3)
             ORDER BY ts ASC"
        }
        (true, true) => {
            "SELECT * FROM (SELECT ts, open, high, low, close, volume, amount
             FROM sector_kline_daily WHERE code=?1 ORDER BY ts DESC LIMIT ?2) ORDER BY ts ASC"
        }
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let limit = if limit == 0 { 500 } else { limit.min(5000) };
    let map = |r: &rusqlite::Row| -> rusqlite::Result<Bar> {
        Ok(Bar {
            ts: r.get(0)?,
            open: r.get(1)?,
            high: r.get(2)?,
            low: r.get(3)?,
            close: r.get(4)?,
            volume: r.get(5)?,
            amount: r.get(6)?,
            source: "sector_index".into(),
        })
    };
    let rows = match (from.is_empty(), to.is_empty()) {
        (false, false) => stmt.query_map(rusqlite::params![code, from, to, limit], map),
        (true, false) => stmt.query_map(rusqlite::params![code, to, limit], map),
        (false, true) => stmt.query_map(rusqlite::params![code, from, limit], map),
        (true, true) => stmt.query_map(rusqlite::params![code, limit], map),
    }
    .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut daily = Vec::new();
    for row in rows {
        daily.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(match period {
        Period::Day => daily,
        Period::Week => kline::resample(&daily, period),
        Period::Month => kline::resample(&daily, period),
    })
}

/// The instruments belonging to one sector (via the master's sector_code).
pub fn members(
    conn: &Connection,
    sector_code: &str,
) -> Result<Vec<crate::invest::model::Instrument>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT code, market, name, industry, sector_code, sector_sub, kind, note, watch
             FROM instruments WHERE sector_code=?1 ORDER BY code",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![sector_code], |r| {
            Ok(crate::invest::model::Instrument {
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
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invest::db;
    use crate::invest::model::Instrument;

    fn bar(ts: &str, close: f64, volume: f64) -> Bar {
        Bar {
            ts: ts.into(),
            open: close,
            high: close + 1.0,
            low: close - 1.0,
            close,
            volume,
            amount: Some(close * volume),
            source: String::new(),
        }
    }

    #[test]
    fn seed_list_members_and_bars() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        let sectors = list(&conn).unwrap();
        assert_eq!(sectors.len(), 31, "the SW level-1 skeleton is seeded");

        // A member joins via sector_code.
        conn.execute(
            "INSERT INTO instruments(code, market, name, industry, sector_code, sector_sub, kind, note, watch)
             VALUES ('600519','cn','贵州茅台','食品饮料','801120',NULL,'stock','',1)",
            [],
        )
        .unwrap();
        let members = members(&conn, "801120").unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].code, "600519");

        upsert_bars(
            &conn,
            "801120",
            &[
                bar("2026-01-05", 100.0, 1000.0),
                bar("2026-01-06", 101.0, 1100.0),
            ],
        )
        .unwrap();
        let daily = query_bars(&conn, "801120", "", "", 10, Period::Day).unwrap();
        assert_eq!(daily.len(), 2);
        let months = query_bars(&conn, "801120", "", "", 10, Period::Month).unwrap();
        assert_eq!(months.len(), 1);
        assert_eq!(months[0].close, 101.0);
        assert_eq!(months[0].volume, 2100.0);
    }
}
