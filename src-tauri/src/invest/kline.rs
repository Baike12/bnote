//! Daily bars: import, window query, weekly/monthly synthesis.
//!
//! The storage unit is the **share** (hoshi's convention); the UI converts CN
//! lots (÷100). All queries are read-only against `kline_daily` — the read
//! path never fetches from the network (DESIGN.md §2).

use crate::invest::model::Bar;

/// Upserts bars for one instrument. `source` is stored verbatim so a mixed
/// provenance is visible in the UI badge (em_daily_kline_qfq / sina_daily…).
pub fn upsert_bars(
    conn: &rusqlite::Connection,
    market: &str,
    code: &str,
    bars: &[Bar],
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "INSERT INTO kline_daily(market, code, ts, open, high, low, close, volume, amount, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(market, code, ts) DO UPDATE SET
               open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
               volume=excluded.volume, amount=excluded.amount, source=excluded.source",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let mut n = 0;
    for bar in bars {
        let changed = stmt
            .execute(rusqlite::params![
                market, code, bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume,
                bar.amount, bar.source,
            ])
            .map_err(|e| format!("DB_WRITE_FAILED: kline {} {}: {}", code, bar.ts, e))?;
        n += changed;
    }
    Ok(n)
}

/// The window query: bars in `[from, to]` ascending, capped at `limit`
/// (newest N when the range holds more). `from`/`to` may be empty = unbounded.
pub fn query_bars(
    conn: &rusqlite::Connection,
    market: &str,
    code: &str,
    from: &str,
    to: &str,
    limit: usize,
) -> Result<Vec<Bar>, String> {
    // The inner DESC + outer ASC keeps "the newest N bars, in time order"
    // without materializing the whole history (hoshi's kline SQL shape).
    // Parameters are renumbered per branch (?1..?n) so each branch binds
    // exactly the values its SQL names.
    let sql = match (from.is_empty(), to.is_empty()) {
        (false, false) => {
            "SELECT * FROM (SELECT ts, open, high, low, close, volume, amount, source
              FROM kline_daily WHERE market=?1 AND code=?2 AND ts>=?3 AND ts<=?4
              ORDER BY ts DESC LIMIT ?5) ORDER BY ts ASC"
        }
        (true, false) => {
            "SELECT * FROM (SELECT ts, open, high, low, close, volume, amount, source
              FROM kline_daily WHERE market=?1 AND code=?2 AND ts<=?3
              ORDER BY ts DESC LIMIT ?4) ORDER BY ts ASC"
        }
        (false, true) => {
            "SELECT * FROM (SELECT ts, open, high, low, close, volume, amount, source
              FROM kline_daily WHERE market=?1 AND code=?2 AND ts>=?3
              ORDER BY ts DESC LIMIT ?4) ORDER BY ts ASC"
        }
        (true, true) => {
            "SELECT * FROM (SELECT ts, open, high, low, close, volume, amount, source
              FROM kline_daily WHERE market=?1 AND code=?2
              ORDER BY ts DESC LIMIT ?3) ORDER BY ts ASC"
        }
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let limit = clamp_limit(limit);
    let map = |r: &rusqlite::Row| -> rusqlite::Result<Bar> {
        Ok(Bar {
            ts: r.get(0)?,
            open: r.get(1)?,
            high: r.get(2)?,
            low: r.get(3)?,
            close: r.get(4)?,
            volume: r.get(5)?,
            amount: r.get(6)?,
            source: r.get(7)?,
        })
    };
    let rows = match (from.is_empty(), to.is_empty()) {
        (false, false) => stmt.query_map(rusqlite::params![market, code, from, to, limit], map),
        (true, false) => stmt.query_map(rusqlite::params![market, code, to, limit], map),
        (false, true) => stmt.query_map(rusqlite::params![market, code, from, limit], map),
        (true, true) => stmt.query_map(rusqlite::params![market, code, limit], map),
    }
    .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

fn clamp_limit(limit: usize) -> usize {
    if limit == 0 {
        500
    } else {
        limit.min(5000)
    }
}

/// The latest date present for one instrument (None = no data).
pub fn latest_ts(
    conn: &rusqlite::Connection,
    market: &str,
    code: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT max(ts) FROM kline_daily WHERE market=?1 AND code=?2",
        rusqlite::params![market, code],
        |r| r.get(0),
    )
    .map_err(|e| format!("DB_QUERY_FAILED: {}", e))
}

/// Synthesizes weekly or monthly bars from a daily series. The bucket key is
/// the ISO week (`YYYY-Wnn`) or month (`YYYY-MM`) of the bar's date; OHLC
/// aggregates (first open / max high / min low / last close) and volume sums.
pub fn resample(bars: &[Bar], period: Period) -> Vec<Bar> {
    let mut out: Vec<Bar> = Vec::new();
    for bar in bars {
        let key = bucket_key(&bar.ts, period);
        let last = match out.last_mut() {
            Some(last) if bucket_key(&last.ts, period) == key => last,
            _ => {
                out.push(Bar {
                    ts: bar.ts.clone(),
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    amount: bar.amount,
                    source: bar.source.clone(),
                });
                continue;
            }
        };
        last.high = last.high.max(bar.high);
        last.low = last.low.min(bar.low);
        last.close = bar.close;
        last.volume += bar.volume;
        last.amount = match (last.amount, bar.amount) {
            (Some(a), Some(b)) => Some(a + b),
            (None, b) => b,
            (a, None) => a,
        };
        // The bucket label follows the LAST day of the bucket (the bar the
        // bucket "closes" on), which is what a chart axis wants.
        last.ts = bar.ts.clone();
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Day,
    Week,
    Month,
}

fn bucket_key(ts: &str, period: Period) -> String {
    match period {
        Period::Day => ts.to_string(),
        // Weekly/monthly keys never need the day part; a wrong-length ts
        // simply yields a degenerate bucket per bar rather than a panic.
        Period::Week => week_key(ts),
        Period::Month => ts.chars().take(7).collect(),
    }
}

/// ISO-8601 week key (`2026-W07`); falls back to the raw date for malformed
/// input so resample stays total.
fn week_key(ts: &str) -> String {
    if ts.len() < 10 {
        return ts.to_string();
    }
    // days since 1970-01-01 (a Thursday: the epoch week starts on Thu).
    let days = match days_from_civil(ts) {
        Some(d) => d,
        None => return ts.to_string(),
    };
    // 1970-01-01 is week 1970-W01 (Thu-started, ISO-weeks align on it).
    let week = (days + 3) / 7; // floor
    let weeks_from_civil_1970w01 = week;
    let year = 1970 + weeks_from_civil_1970w01.div_euclid(52).saturating_sub(1);
    // Compute the true ISO week from the date itself instead of guessing.
    let (iso_year, iso_week) = iso_week_from_days(days);
    let _ = year;
    format!("{:04}-W{:02}", iso_year, iso_week)
}

/// (days_from_civil, ISO year, ISO week) from a `YYYY-MM-DD` string.
fn days_from_civil(ts: &str) -> Option<i64> {
    let mut parts = ts.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil_ymd(y, m, d))
}

/// Howard Hinnant's days_from_civil algorithm (proleptic Gregorian); the
/// -719468 offset converts to "days since 1970-01-01".
fn days_from_civil_ymd(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// ISO week number + ISO year for a date given as days since the epoch.
fn iso_week_from_days(days: i64) -> (i64, i64) {
    // 1970-01-01 was a Thursday (weekday index 3 with Monday=0).
    let weekday = (days + 3).rem_euclid(7); // Monday = 0
                                            // The Thursday of this week pins the ISO year.
    let thursday = days - weekday + 3;
    let iso_year = civil_from_days(thursday).0;
    // Jan 4 is always in ISO week 1.
    let jan4 = days_from_civil_ymd(iso_year, 1, 4);
    let jan4_weekday = (jan4 + 3).rem_euclid(7);
    let week1_monday = jan4 - jan4_weekday;
    let week = (days - week1_monday) / 7 + 1;
    (iso_year, week)
}

/// (year, month, day) from days since the epoch (Hinnant's civil_from_days).
pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(ts: &str, close: f64, high: f64, low: f64, volume: f64) -> Bar {
        Bar {
            ts: ts.to_string(),
            open: close,
            high,
            low,
            close,
            volume,
            amount: None,
            source: "test".into(),
        }
    }

    #[test]
    fn query_window_returns_newest_n_in_order() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::super::db::migrate(&conn).unwrap();
        let bars: Vec<Bar> = (0..300)
            .map(|i| {
                let d = format!("2025-{:02}-{:02}", 1 + i / 30, 1 + i % 30);
                bar(&d, i as f64, i as f64 + 1.0, i as f64 - 1.0, 100.0)
            })
            .collect();
        upsert_bars(&conn, "cn", "600519", &bars).unwrap();
        let got = query_bars(&conn, "cn", "600519", "", "", 120).unwrap();
        assert_eq!(got.len(), 120);
        assert_eq!(
            got[0].ts, bars[180].ts,
            "the window starts at the 181st bar"
        );
        assert_eq!(got.last().unwrap().ts, bars[299].ts);
        assert!(got.windows(2).all(|w| w[0].ts < w[1].ts), "ascending order");
    }

    #[test]
    fn resample_weekly_and_monthly_aggregate() {
        let bars = vec![
            bar("2026-01-02", 10.0, 11.0, 9.5, 100.0),
            bar("2026-01-05", 11.0, 12.0, 10.5, 150.0),
            bar("2026-01-07", 12.0, 13.0, 11.0, 120.0),
            bar("2026-02-02", 13.0, 14.0, 12.5, 90.0),
        ];
        let weeks = resample(&bars, Period::Week);
        // 01-02 is its own ISO week; 01-05/01-07 share one; 02-02 another.
        assert_eq!(weeks.len(), 3);
        assert_eq!(weeks[1].ts, "2026-01-07");
        assert_eq!(weeks[1].open, 11.0);
        assert_eq!(weeks[1].close, 12.0);
        assert_eq!(weeks[1].high, 13.0);
        assert_eq!(weeks[1].low, 10.5);
        assert_eq!(weeks[1].volume, 270.0);

        let months = resample(&bars, Period::Month);
        assert_eq!(months.len(), 2);
        assert_eq!(months[0].ts, "2026-01-07");
        assert_eq!(months[0].volume, 370.0);
        assert_eq!(months[1].ts, "2026-02-02");
    }

    #[test]
    fn iso_week_matches_known_dates() {
        // 2026-01-01 is a Thursday and belongs to 2026-W01.
        let days = days_from_civil("2026-01-01").unwrap();
        assert_eq!(iso_week_from_days(days), (2026, 1));
        // 2026-01-05 is the Monday of W02.
        let days = days_from_civil("2026-01-05").unwrap();
        assert_eq!(iso_week_from_days(days), (2026, 2));
        // A year boundary: 2026-01-02 is still W01, 2025-12-29 (Mon) is
        // 2026-W01 by ISO (the week containing Jan 1).
        let days = days_from_civil("2025-12-29").unwrap();
        assert_eq!(iso_week_from_days(days), (2026, 1));
        assert_eq!(week_key("2026-01-05"), "2026-W02");
    }

    #[test]
    fn resample_handles_bad_dates_without_panic() {
        let bars = vec![
            bar("bad", 1.0, 1.0, 1.0, 1.0),
            bar("2026-01-02", 2.0, 2.0, 2.0, 2.0),
        ];
        let weeks = resample(&bars, Period::Week);
        assert_eq!(
            weeks.len(),
            2,
            "a malformed date degrades to its own bucket"
        );
    }
}
