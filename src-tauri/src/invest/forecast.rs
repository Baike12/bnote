//! The walk-forward replay of a skill against history.
//!
//! A forecast is one prediction of "the direction and size of the move over
//! the next `horizon` trading days". The replay discipline (the part SkillOpt
//! lacks and finance requires): the skill may only see data **up to** `as_of`;
//! the target date's actual bars settle the score.
//!
//! Scoring:
//! - `hard`  = 1.0 when the direction matches (flat counts when |move| < 1%)
//! - `soft`  = max(0, 1 - |predicted_move - actual_move| / 0.10)
//! - `score` = 0.7 * hard + 0.3 * soft   (SkillOpt's "mixed" gate metric)
//!
//! The rule-based predictor (`rule_forecast`) is the no-LLM fallback so the
//! whole loop runs without a model configured; the agent path feeds the same
//! output contract.

use rusqlite::Connection;

use crate::invest::kline;
use crate::invest::model::{Bar, Forecast};

/// One forecast output (the skill's contract).
#[derive(Debug, Clone, PartialEq)]
pub struct Prediction {
    pub direction: &'static str,
    pub expected_move: f64,
    pub confidence: f64,
    pub rationale: String,
}

/// The realized move over `horizon` trading days after `as_of`.
pub fn actual_move(bars: &[Bar], as_of: &str, horizon: usize) -> Option<(String, f64)> {
    let idx = bars.iter().position(|b| b.ts == as_of)?;
    let target = bars.get(idx + horizon)?;
    let base = bars[idx].close;
    if base == 0.0 {
        return None;
    }
    let move_ = (target.close - base) / base;
    Some((target.ts.clone(), move_))
}

/// hard: direction hit (1.0 / 0.0). `flat` only scores when the actual move
/// stays inside the ±1% band.
pub fn hard_score(direction: &str, actual: f64) -> f64 {
    const FLAT_BAND: f64 = 0.01;
    let actual_dir = if actual > FLAT_BAND {
        "up"
    } else if actual < -FLAT_BAND {
        "down"
    } else {
        "flat"
    };
    if direction == actual_dir {
        1.0
    } else {
        0.0
    }
}

/// soft: 1 - |predicted - actual| / 0.10, floored at 0 (10% full-scale).
pub fn soft_score(expected_move: f64, actual: f64) -> f64 {
    (1.0 - (expected_move - actual).abs() / 0.10).max(0.0)
}

/// The combined gate score (0.7 direction + 0.3 magnitude).
pub fn score(direction: &str, expected_move: f64, actual: f64) -> f64 {
    0.7 * hard_score(direction, actual) + 0.3 * soft_score(expected_move, actual)
}

/// The no-LLM rule predictor: a simple momentum/volume rule that reads only
/// bars up to `as_of`. Deliberately naive — its value is making the replay
/// loop runnable end to end without a model, and giving the agent a baseline
/// to beat.
pub fn rule_forecast(bars: &[Bar], as_of: &str, horizon: usize) -> Result<Prediction, String> {
    let idx = bars
        .iter()
        .position(|b| b.ts == as_of)
        .ok_or_else(|| format!("NOT_FOUND: as_of {as_of} is not a trading day in the data"))?;
    if idx < 5 {
        return Err(
            "NOT_ENOUGH_DATA: momentum rule needs at least 6 bars before as_of".to_string(),
        );
    }
    let closes: Vec<f64> = bars[..=idx].iter().map(|b| b.close).collect();
    let last = closes[idx];
    let prev5 = closes[idx - 5];
    if prev5 == 0.0 {
        return Err("NOT_ENOUGH_DATA: zero close in the momentum window".to_string());
    }
    let momentum = (last - prev5) / prev5;
    let vol_recent: f64 = bars[idx.saturating_sub(2)..=idx]
        .iter()
        .map(|b| b.volume)
        .sum();
    let vol_prior: f64 = bars[idx.saturating_sub(5)..idx.saturating_sub(2)]
        .iter()
        .map(|b| b.volume)
        .sum();
    let volume_expansion = if vol_prior > 0.0 {
        vol_recent / vol_prior
    } else {
        1.0
    };

    // Rule: 5-day momentum carries the direction; volume expansion shifts the
    // confidence and the expected size (bounded to ±10% — the soft scale).
    let (direction, expected, conf) = if momentum > 0.005 {
        (
            "up",
            (momentum * horizon as f64 * 0.4).min(0.10),
            (0.5 + 0.1 * (volume_expansion - 1.0)).clamp(0.3, 0.75),
        )
    } else if momentum < -0.005 {
        (
            "down",
            (momentum * horizon as f64 * 0.4).max(-0.10),
            (0.5 + 0.1 * (volume_expansion - 1.0)).clamp(0.3, 0.75),
        )
    } else {
        ("flat", 0.0, 0.5)
    };
    Ok(Prediction {
        direction,
        expected_move: expected,
        confidence: conf,
        rationale: format!(
            "规则回放:5日动量 {:+.2}%,近3日量比 {:.2},预测方向 {}。",
            momentum * 100.0,
            volume_expansion,
            direction
        ),
    })
}

/// Records one prediction (the `as_of` snapshot of the skill). A replay of
/// the same window upserts in place (D21: the unique index makes a second
/// run overwrite its own earlier row instead of double counting).
pub fn record(
    conn: &Connection,
    scope: &str,
    skill_version: &str,
    as_of: &str,
    target_date: &str,
    p: &Prediction,
    mode: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO forecasts(scope, skill_version, as_of, target_date, direction, expected_move,
             confidence, rationale, mode, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(scope, skill_version, as_of, target_date, mode) DO UPDATE SET
             direction=excluded.direction, expected_move=excluded.expected_move,
             confidence=excluded.confidence, rationale=excluded.rationale,
             created_at=excluded.created_at,
             actual_direction=NULL, actual_move=NULL, score=NULL",
        rusqlite::params![
            scope,
            skill_version,
            as_of,
            target_date,
            p.direction,
            p.expected_move,
            p.confidence,
            p.rationale,
            mode,
            now_secs(),
        ],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: forecast {as_of}: {}", e))?;
    Ok(conn.last_insert_rowid())
}

/// Settles one forecast against the actual bars (fills actual_direction /
/// actual_move / score). Returns the score when the data was there.
pub fn settle(
    conn: &Connection,
    market: &str,
    code: &str,
    forecast_id: i64,
    horizon: usize,
) -> Result<Option<f64>, String> {
    let (scope, as_of, target_date, direction, expected): (String, String, String, String, f64) =
        conn.query_row(
            "SELECT scope, as_of, target_date, direction, COALESCE(expected_move, 0)
             FROM forecasts WHERE id=?1",
            rusqlite::params![forecast_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                Err(format!("NOT_FOUND: forecast {forecast_id}"))
            }
            _ => Err(format!("DB_QUERY_FAILED: {}", e)),
        })
        .map_err(|e: String| e)?;
    let (kind, code_of_scope) = crate::invest::model::parse_scope(&scope)
        .map(|(k, c)| (k.to_string(), c.to_string()))
        .ok_or_else(|| format!("INVALID_SCOPE: {scope}"))?;
    // The actual bars come from whichever instrument/sector the scope points to.
    let bars = match kind.as_str() {
        "sector" => crate::invest::sectors::query_bars(
            conn,
            &code_of_scope,
            "",
            "",
            5000,
            kline::Period::Day,
        )?,
        _ => kline::query_bars(conn, market, code, "", "", 5000)?,
    };
    // The stored target_date wins (a live forecast named its day); the replay
    // recomputes from as_of when the target is absent from the data.
    let realized = actual_move(&bars, &as_of, horizon);
    let Some((actual_target, actual)) = realized else {
        return Ok(None);
    };
    let _ = target_date; // informational: the replay records both
    let s = score(&direction, expected, actual);
    conn.execute(
        "UPDATE forecasts SET actual_direction=?1, actual_move=?2, score=?3, target_date=?4 WHERE id=?5",
        rusqlite::params![actual_direction_of(actual), actual, s, actual_target, forecast_id],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: settle {}: {}", forecast_id, e))?;
    Ok(Some(s))
}

fn actual_direction_of(actual: f64) -> String {
    const FLAT_BAND: f64 = 0.01;
    if actual > FLAT_BAND {
        "up"
    } else if actual < -FLAT_BAND {
        "down"
    } else {
        "flat"
    }
    .to_string()
}

/// The forecast history of one scope, newest target first.
pub fn list(conn: &Connection, scope: &str, limit: usize) -> Result<Vec<Forecast>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, skill_version, as_of, target_date, direction, expected_move,
                    confidence, rationale, actual_direction, actual_move, score, mode
             FROM forecasts WHERE scope=?1 ORDER BY target_date DESC, id DESC LIMIT ?2",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![scope, limit.clamp(1, 500)], |r| {
            Ok(Forecast {
                id: r.get(0)?,
                scope: r.get(1)?,
                skill_version: r.get(2)?,
                as_of: r.get(3)?,
                target_date: r.get(4)?,
                direction: r.get(5)?,
                expected_move: r.get(6)?,
                confidence: r.get(7)?,
                rationale: r.get(8)?,
                actual_direction: r.get(9)?,
                actual_move: r.get(10)?,
                score: r.get(11)?,
                mode: r.get(12)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

/// Aggregate accuracy over settled forecasts (the gate's baseline number).
pub fn accuracy(conn: &Connection, scope: &str) -> Result<Option<(i64, f64, f64)>, String> {
    let row = conn
        .query_row(
            "SELECT count(*), avg(score), avg(CASE WHEN score >= 0.7 THEN 1.0 ELSE 0.0 END)
             FROM forecasts WHERE scope=?1 AND score IS NOT NULL",
            rusqlite::params![scope],
            |r| {
                let n: i64 = r.get(0)?;
                let avg: Option<f64> = r.get(1)?;
                let hit: Option<f64> = r.get(2)?;
                Ok(if n == 0 {
                    None
                } else {
                    Some((n, avg.unwrap_or(0.0), hit.unwrap_or(0.0)))
                })
            },
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            _ => Err(format!("DB_QUERY_FAILED: {}", e)),
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    Ok(row)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(ts: &str, close: f64, volume: f64) -> Bar {
        Bar {
            ts: ts.into(),
            open: close,
            high: close,
            low: close,
            close,
            volume,
            amount: None,
            source: "t".into(),
        }
    }

    #[test]
    fn scoring_matches_the_gate_contract() {
        assert_eq!(hard_score("up", 0.05), 1.0);
        assert_eq!(hard_score("up", -0.02), 0.0);
        assert_eq!(hard_score("down", -0.02), 1.0);
        assert_eq!(hard_score("flat", 0.005), 1.0);
        assert_eq!(hard_score("flat", 0.05), 0.0);
        // soft is linear to zero at a 10pt miss.
        assert_eq!(soft_score(0.03, 0.03), 1.0);
        assert_eq!(soft_score(0.08, 0.03), 0.5);
        assert_eq!(soft_score(0.20, 0.03), 0.0);
        // combined: perfect direction + perfect size = 1.0
        assert!((score("up", 0.03, 0.03) - 1.0).abs() < 1e-9);
        // direction right (actual 6% is a clear "up"), size off by 1pt:
        // 0.7*1 + 0.3*0.9 = 0.97
        assert!((score("up", 0.05, 0.06) - 0.97).abs() < 1e-9);
        // direction right but "flat" actual (0.0 stays in the ±1% band) scores
        // no hard points: 0.3 * 0.5 = 0.15
        assert!((score("up", 0.05, 0.0) - 0.15).abs() < 1e-9);
    }

    #[test]
    fn actual_move_uses_as_of_plus_horizon() {
        let bars: Vec<Bar> = (1..=10)
            .map(|i| bar(&format!("2026-03-{:02}", i), 100.0 + i as f64, 1000.0))
            .collect();
        let (target, mv) = actual_move(&bars, "2026-03-03", 5).unwrap();
        assert_eq!(target, "2026-03-08");
        assert!((mv - (108.0 - 103.0) / 103.0).abs() < 1e-9);
        assert!(
            actual_move(&bars, "2026-03-08", 5).is_none(),
            "horizon past the end"
        );
        assert!(
            actual_move(&bars, "2026-12-01", 1).is_none(),
            "unknown as_of"
        );
    }

    #[test]
    fn rule_forecast_reads_only_bars_up_to_as_of() {
        let bars: Vec<Bar> = (1..=10)
            .map(|i| bar(&format!("2026-03-{:02}", i), 100.0 + i as f64, 1000.0))
            .collect();
        let p = rule_forecast(&bars, "2026-03-09", 5).unwrap();
        assert_eq!(p.direction, "up", "rising closes → up");
        assert!(p.expected_move > 0.0);
        assert!(
            rule_forecast(&bars, "2026-03-02", 5).is_err(),
            "not enough history"
        );
        assert!(
            rule_forecast(&bars, "2026-12-01", 5).is_err(),
            "unknown as_of"
        );
    }

    #[test]
    fn record_settle_list_accuracy_roundtrip() {
        use crate::invest::db;
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        // 13 bars: as_of is the 8th (idx 7 ≥ 5 for the momentum window), the
        // 5-day horizon lands on the 13th bar (idx 12).
        let bars: Vec<Bar> = (1..=13)
            .map(|i| bar(&format!("2026-03-{:02}", i), 100.0 + i as f64, 1000.0))
            .collect();
        kline::upsert_bars(&conn, "cn", "600519", &bars).unwrap();

        let p = rule_forecast(&bars, "2026-03-08", 5).unwrap();
        let id = record(
            &conn,
            "stock:600519",
            "v1",
            "2026-03-08",
            "2026-03-13",
            &p,
            "replay",
        )
        .unwrap();
        let s = settle(&conn, "cn", "600519", id, 5).unwrap();
        assert!(s.is_some());
        assert!(
            s.unwrap() > 0.7,
            "the momentum rule should nail a linear uptrend"
        );

        let list = list(&conn, "stock:600519", 10).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].actual_direction.as_deref(), Some("up"));
        let (n, avg, hit) = accuracy(&conn, "stock:600519").unwrap().unwrap();
        assert_eq!(n, 1);
        assert!(avg > 0.7);
        assert!(hit > 0.5);
        assert!(accuracy(&conn, "stock:000858").unwrap().is_none());
    }

    /// D21 (blind test Q-P1-10): replaying the same window must not double
    /// count — the second record() overwrites the first row in place, and
    /// the settled score is reset (it belongs to the previous prediction).
    #[test]
    fn record_is_an_upsert_per_window() {
        use crate::invest::db;
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        let p = rule_forecast(
            &(1..=13)
                .map(|i| bar(&format!("2026-03-{:02}", i), 100.0 + i as f64, 1000.0))
                .collect::<Vec<_>>(),
            "2026-03-08",
            5,
        )
        .unwrap();

        let first = record(
            &conn,
            "stock:600519",
            "v1",
            "2026-03-08",
            "2026-03-13",
            &p,
            "replay",
        )
        .unwrap();
        let again = record(
            &conn,
            "stock:600519",
            "v1",
            "2026-03-08",
            "2026-03-13",
            &p,
            "replay",
        )
        .unwrap();
        assert_eq!(first, again, "the same window reuses its row");

        // A different skill version is a different prediction, not a dupe.
        record(
            &conn,
            "stock:600519",
            "v2",
            "2026-03-08",
            "2026-03-13",
            &p,
            "replay",
        )
        .unwrap();
        let list = list(&conn, "stock:600519", 10).unwrap();
        assert_eq!(list.len(), 2);
    }
}
