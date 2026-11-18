//! The event-driven backtest engine (backtrader's model, sized for a local app).
//!
//! `feed → strategy(on_bar) → broker(match) → equity → analyzers`, all pure
//! functions over a daily bar slice:
//! - A signal produced on bar T fills at bar T+1's open (A-share T+1 rule);
//!   the first bar never fills a signal (nothing to fill with).
//! - Commission: 0.025% each side + 0.05% stamp duty on sells; shares trade
//!   in 100-share lots.
//! - Sharpe uses daily returns against a 2% risk-free rate, annualized √252.
//!
//! Two built-in strategies: `ma_cross` (fast/slow MA crossover, the industry
//! baseline) and `skill_signal` (replays the direction column of the settled
//! forecasts as positions — the bridge from Skill to measurable performance).

use crate::invest::model::{BacktestMetrics, Bar, EquityPoint, Trade};

/// A strategy's decision for one bar.
#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    Buy,
    Sell,
}

#[derive(Debug, Clone)]
pub struct StrategyConfig {
    pub kind: StrategyKind,
    /// Fraction of equity a Buy commits (1.0 = all-in, the single-instrument
    /// default; the engine buys whole lots within the budget).
    pub size_ratio: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StrategyKind {
    MaCross {
        fast: usize,
        slow: usize,
    },
    /// The settled forecasts of one scope, keyed by target_date → direction.
    /// A "up" forecast buys on the target date, a "down" one sells.
    SkillSignal {
        directions: Vec<(String, String)>,
    },
}

/// The broker state after the run.
#[derive(Debug, Clone, Default)]
struct Broker {
    cash: f64,
    shares: f64,
    avg_cost: f64,
    /// Per-market execution costs, fixed at run start (the run's market
    /// selects them — the fee schedule is a market fact, not a strategy one).
    fees: FeeModel,
}

/// Per-market execution costs (H6 blind test: hk pays stamp duty on BOTH
/// sides; us pays none; cn pays it on the sell side only).
#[derive(Debug, Clone, Default)]
struct FeeModel {
    commission: f64,
    buy_stamp: f64,
    sell_stamp: f64,
}

impl FeeModel {
    fn for_market(market: &str) -> Self {
        match market {
            // HK: stamp duty 0.1% bilateral (the 2023-11-17 cut kept both sides).
            "hk" => Self {
                commission: COMMISSION_RATE,
                buy_stamp: 0.001,
                sell_stamp: 0.001,
            },
            // US: no stamp duty (SEC/TAF fees are negligible at this scale).
            "us" => Self {
                commission: COMMISSION_RATE,
                buy_stamp: 0.0,
                sell_stamp: 0.0,
            },
            // CN (and anything unrecognized): sell-side stamp duty 0.05%.
            _ => Self {
                commission: COMMISSION_RATE,
                buy_stamp: 0.0,
                sell_stamp: STAMP_DUTY,
            },
        }
    }
}

/// The full run output: equity curve, analyzers and the per-fill ledger (the
/// UI shows both — blind test: metrics without the trade ledger could not be
/// audited).
#[derive(Debug, Clone)]
pub struct BacktestResult {
    pub equity: Vec<EquityPoint>,
    pub metrics: BacktestMetrics,
    pub fills: Vec<Trade>,
}

/// Runs the backtest over `bars` (ascending). An empty feed yields a flat,
/// zeroed run rather than an error.
pub fn run(
    bars: &[Bar],
    config: &StrategyConfig,
    initial_cash: f64,
    market: &str,
) -> BacktestResult {
    let mut broker = Broker {
        cash: initial_cash,
        shares: 0.0,
        avg_cost: 0.0,
        fees: FeeModel::for_market(market),
    };
    let mut equity: Vec<EquityPoint> = Vec::with_capacity(bars.len());
    let mut pending: Option<Signal> = None;
    let mut round_trips: Vec<f64> = Vec::new(); // per-round-trip pnl for the analyzers
    let mut fills: Vec<Trade> = Vec::new();
    let mut entry_value = 0.0;

    let mut prev_closes: Vec<f64> = Vec::new();

    for bar in bars {
        // 1) Fill yesterday's signal at today's open.
        if let Some(signal) = pending.take() {
            match signal {
                Signal::Buy => buy(
                    &mut broker,
                    &bar.ts,
                    bar.open,
                    config.size_ratio,
                    &mut entry_value,
                    &mut fills,
                ),
                Signal::Sell => sell(
                    &mut broker,
                    &bar.ts,
                    bar.open,
                    &mut round_trips,
                    &mut entry_value,
                    &mut fills,
                ),
            }
        }
        // 2) Mark to market at the close.
        equity.push(EquityPoint {
            date: bar.ts.clone(),
            equity: broker.cash + broker.shares * bar.close,
        });
        // 3) Decide on this bar's close; it fills at the NEXT bar's open.
        prev_closes.push(bar.close);
        if let Some(signal) = decide(config, &prev_closes, bar) {
            let wanted = match signal {
                Signal::Buy => broker.shares == 0.0,
                Signal::Sell => broker.shares > 0.0,
            };
            if wanted {
                pending = Some(signal);
            }
        }
    }
    // Unfilled tail signal: ignore (no next bar to fill at — honest about it).

    let metrics = analyzers(&equity, &round_trips, initial_cash);
    BacktestResult {
        equity,
        metrics,
        fills,
    }
}

fn buy(
    broker: &mut Broker,
    date: &str,
    open: f64,
    size_ratio: f64,
    entry_value: &mut f64,
    fills: &mut Vec<Trade>,
) {
    if open <= 0.0 {
        return;
    }
    let stamp_in = broker.fees.commission + broker.fees.buy_stamp;
    let budget = (broker.cash * size_ratio.clamp(0.1, 1.0)) / (1.0 + stamp_in);
    // Whole lots (100 shares), at least one lot when the cash allows.
    let lots = (budget / (open * 100.0)).floor().max(0.0);
    if lots < 1.0 {
        return;
    }
    let shares = lots * 100.0;
    let cost = shares * open;
    let fee = cost * stamp_in;
    if cost + fee > broker.cash {
        return;
    }
    let total_cost = broker.avg_cost * broker.shares + cost + fee;
    broker.shares += shares;
    broker.avg_cost = total_cost / broker.shares;
    broker.cash -= cost + fee;
    *entry_value = broker.shares * open;
    fills.push(Trade {
        date: date.to_string(),
        action: "buy".to_string(),
        shares: shares as i64,
        price: open,
        fees: fee,
        pnl: None,
    });
}

fn sell(
    broker: &mut Broker,
    date: &str,
    open: f64,
    round_trips: &mut Vec<f64>,
    entry_value: &mut f64,
    fills: &mut Vec<Trade>,
) {
    if broker.shares <= 0.0 || open <= 0.0 {
        return;
    }
    let proceeds = broker.shares * open;
    let fee = proceeds * (broker.fees.commission + broker.fees.sell_stamp);
    let pnl = proceeds - fee - broker.avg_cost * broker.shares;
    round_trips.push(pnl);
    fills.push(Trade {
        date: date.to_string(),
        action: "sell".to_string(),
        shares: broker.shares as i64,
        price: open,
        fees: fee,
        pnl: Some(pnl),
    });
    broker.cash += proceeds - fee;
    broker.shares = 0.0;
    broker.avg_cost = 0.0;
    *entry_value = 0.0;
}

const COMMISSION_RATE: f64 = 0.000_25;
const STAMP_DUTY: f64 = 0.000_5;

/// The strategy decision for bar close `closes.last()`.
fn decide(config: &StrategyConfig, closes: &[f64], _bar: &Bar) -> Option<Signal> {
    match &config.kind {
        StrategyKind::MaCross { fast, slow } => {
            if closes.len() < *slow + 1 {
                return None;
            }
            let fast_now = sma(closes, *fast, 0);
            let slow_now = sma(closes, *slow, 0);
            let fast_prev = sma(closes, *fast, 1);
            let slow_prev = sma(closes, *slow, 1);
            // Golden cross (fast crossed above slow) → buy; death cross → sell.
            if fast_prev <= slow_prev && fast_now > slow_now {
                Some(Signal::Buy)
            } else if fast_prev >= slow_prev && fast_now < slow_now {
                Some(Signal::Sell)
            } else {
                None
            }
        }
        StrategyKind::SkillSignal { directions } => {
            let today = &_bar.ts;
            match directions
                .iter()
                .find(|(d, _)| d == today)
                .map(|(_, dir)| dir.as_str())
            {
                Some("up") => Some(Signal::Buy),
                Some("down") => Some(Signal::Sell),
                _ => None,
            }
        }
    }
}

/// SMA over the last `n` closes ending `offset` bars from the end (0 = now).
fn sma(closes: &[f64], n: usize, offset: usize) -> f64 {
    let end = closes.len() - offset;
    if end < n {
        return 0.0;
    }
    let sum: f64 = closes[end - n..end].iter().sum();
    sum / n as f64
}

/// The analyzers pass (total/annual return, Sharpe, max drawdown, win rate,
/// profit factor, trade count).
fn analyzers(equity: &[EquityPoint], trades: &[f64], initial_cash: f64) -> BacktestMetrics {
    let mut metrics = BacktestMetrics {
        total_return: 0.0,
        annual_return: 0.0,
        sharpe: 0.0,
        max_drawdown: 0.0,
        win_rate: 0.0,
        profit_factor: 0.0,
        trade_count: trades.len() as i64,
    };
    if equity.is_empty() || initial_cash <= 0.0 {
        return metrics;
    }
    let final_value = equity.last().map(|e| e.equity).unwrap_or(initial_cash);
    metrics.total_return = (final_value - initial_cash) / initial_cash;

    let days = equity.len().max(1) as f64;
    metrics.annual_return = (1.0 + metrics.total_return).powf(252.0 / days) - 1.0;

    // Daily returns → Sharpe (rf 2%/252 per day).
    let mut returns: Vec<f64> = Vec::with_capacity(equity.len());
    let mut prev = initial_cash;
    for point in equity {
        if prev > 0.0 {
            returns.push(point.equity / prev - 1.0);
        }
        prev = point.equity;
    }
    if returns.len() > 2 {
        let mean = returns.iter().sum::<f64>() / returns.len() as f64;
        let var =
            returns.iter().map(|r| (r - mean) * (r - mean)).sum::<f64>() / returns.len() as f64;
        let daily_risk_free = 0.02 / 252.0;
        let std = var.sqrt();
        if std > 0.0 {
            metrics.sharpe = ((mean - daily_risk_free) / std) * 252.0f64.sqrt();
        }
    }

    // Max drawdown (peak-to-trough on the equity curve).
    let mut peak = equity[0].equity;
    for point in equity {
        peak = peak.max(point.equity);
        if peak > 0.0 {
            metrics.max_drawdown = metrics.max_drawdown.max((peak - point.equity) / peak);
        }
    }

    if !trades.is_empty() {
        let wins = trades.iter().filter(|t| **t > 0.0).count() as f64;
        metrics.win_rate = wins / trades.len() as f64;
        let gross_profit: f64 = trades.iter().filter(|t| **t > 0.0).sum();
        let gross_loss: f64 = -trades.iter().filter(|t| **t < 0.0).sum::<f64>();
        metrics.profit_factor = if gross_loss > 0.0 {
            gross_profit / gross_loss
        } else {
            f64::INFINITY
        };
        if metrics.profit_factor.is_infinite() {
            // serde cannot serialize inf; keep the convention of a large finite marker.
            metrics.profit_factor = f64::MAX;
        }
    }
    metrics
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trend_bars(n: usize, start: f64, step: f64) -> Vec<Bar> {
        (0..n)
            .map(|i| {
                let close = start + step * i as f64;
                Bar {
                    ts: format!("2026-{:02}-{:02}", 1 + i / 28, 1 + i % 28),
                    open: close,
                    high: close * 1.01,
                    low: close * 0.99,
                    close,
                    volume: 1000.0,
                    amount: None,
                    source: "t".into(),
                }
            })
            .collect()
    }

    #[test]
    fn ma_cross_catches_a_trend_and_exits_on_the_reversal() {
        // 30 flat days (warm-up: the two MAs start equal), 30 rising days
        // (the golden cross buys), 30 falling days (the death cross sells) —
        // one complete round trip.
        let mut bars = trend_bars(30, 100.0, 0.0);
        bars.extend(trend_bars(30, 100.0, 1.0));
        bars.extend(trend_bars(30, 129.0, -1.0));
        let cfg = StrategyConfig {
            kind: StrategyKind::MaCross { fast: 5, slow: 20 },
            size_ratio: 1.0,
        };
        let result = run(&bars, &cfg, 1_000_000.0, "cn");
        let (equity, metrics) = (result.equity, result.metrics);
        assert_eq!(equity.len(), 90);
        assert!(
            metrics.trade_count >= 1,
            "the death cross closes the round trip"
        );
        assert!(metrics.win_rate > 0.5, "the trend trade wins");
        assert!(metrics.max_drawdown >= 0.0 && metrics.max_drawdown < 0.5);
    }

    #[test]
    fn empty_feed_is_a_flat_zeroed_run() {
        let cfg = StrategyConfig {
            kind: StrategyKind::MaCross { fast: 5, slow: 20 },
            size_ratio: 1.0,
        };
        let result = run(&[], &cfg, 100_000.0, "cn");
        let (equity, metrics) = (result.equity, result.metrics);
        assert!(equity.is_empty());
        assert_eq!(metrics.total_return, 0.0);
        assert_eq!(metrics.trade_count, 0);
    }

    #[test]
    fn skill_signal_fills_on_the_next_open() {
        // Bars 0..10 flat, then rising: a forecast dated bar 3 buys at bar 4's open.
        let mut bars: Vec<Bar> = (0..10)
            .map(|i| Bar {
                ts: format!("2026-01-{:02}", i + 1),
                open: 100.0,
                high: 101.0,
                low: 99.0,
                close: 100.0,
                volume: 1000.0,
                amount: None,
                source: "t".into(),
            })
            .collect();
        for i in 10..16 {
            bars.push(Bar {
                ts: format!("2026-01-{:02}", i + 1),
                open: 100.0 + (i as f64 - 9.0) * 5.0,
                high: 106.0 + (i as f64 - 9.0) * 5.0,
                low: 99.0 + (i as f64 - 9.0) * 5.0,
                close: 100.0 + (i as f64 - 9.0) * 5.0,
                volume: 1000.0,
                amount: None,
                source: "t".into(),
            });
        }
        let directions = vec![("2026-01-04".to_string(), "up".to_string())];
        let cfg = StrategyConfig {
            kind: StrategyKind::SkillSignal { directions },
            size_ratio: 1.0,
        };
        let result = run(&bars, &cfg, 100_000.0, "cn");
        let (equity, metrics) = (result.equity, result.metrics);
        assert_eq!(metrics.trade_count, 0, "no sell → not a closed round trip");
        // The buy fills at the NEXT bar's open: the 01-04 close equity is
        // still all cash; by the 01-16 close the position rode the whole
        // rising leg (close 135) and is worth well above the cash start.
        let at_signal = equity
            .iter()
            .find(|e| e.date == "2026-01-04")
            .unwrap()
            .equity;
        let final_value = equity.last().unwrap().equity;
        assert!(
            (at_signal - 100_000.0).abs() < 1e-6,
            "the signal day closes flat"
        );
        assert!(
            final_value > 100_000.0,
            "the position gained over the rising leg"
        );
    }

    #[test]
    fn metrics_are_finite_and_consistent() {
        let bars = trend_bars(60, 100.0, 0.5);
        let cfg = StrategyConfig {
            kind: StrategyKind::MaCross { fast: 3, slow: 10 },
            size_ratio: 0.9,
        };
        let metrics = run(&bars, &cfg, 50_000.0, "cn").metrics;
        assert!(metrics.total_return.is_finite());
        assert!(metrics.sharpe.is_finite() || metrics.sharpe == 0.0);
        assert!(metrics.win_rate >= 0.0 && metrics.win_rate <= 1.0);
        assert!(metrics.profit_factor.is_finite());
    }

    #[test]
    fn fills_record_the_ledger() {
        // One complete round trip → one buy fill + one sell fill with pnl,
        // priced at the NEXT bar's open (T+1), whole lots.
        let mut bars = trend_bars(30, 100.0, 0.0);
        bars.extend(trend_bars(30, 100.0, 1.0));
        bars.extend(trend_bars(30, 129.0, -1.0));
        let cfg = StrategyConfig {
            kind: StrategyKind::MaCross { fast: 5, slow: 20 },
            size_ratio: 1.0,
        };
        let result = run(&bars, &cfg, 1_000_000.0, "cn");
        let buys: Vec<&Trade> = result.fills.iter().filter(|t| t.action == "buy").collect();
        let sells: Vec<&Trade> = result.fills.iter().filter(|t| t.action == "sell").collect();
        assert_eq!(buys.len(), 1);
        assert_eq!(sells.len(), 1);
        assert_eq!(buys[0].shares % 100, 0, "whole lots only");
        assert_eq!(sells[0].shares, buys[0].shares, "full position exit");
        assert!(sells[0].fees > 0.0, "sell pays commission + stamp duty");
        let pnl = sells[0].pnl.expect("a closed round trip records pnl");
        assert!(pnl > 0.0, "the trend trade wins after fees");
    }

    /// H6 blind test: the fee schedule is a market fact — hk pays bilateral
    /// stamp duty, us none, cn sell-side only. An unknown market stays on the
    /// cn schedule rather than silently running fee-free.
    #[test]
    fn fees_follow_the_market() {
        let cn = FeeModel::for_market("cn");
        let hk = FeeModel::for_market("hk");
        let us = FeeModel::for_market("us");
        let jp = FeeModel::for_market("jp");
        assert_eq!(cn.commission, hk.commission);
        assert!(
            hk.buy_stamp > 0.0 && hk.sell_stamp > 0.0,
            "hk stamp is bilateral"
        );
        assert_eq!(cn.buy_stamp, 0.0);
        assert!(cn.sell_stamp > 0.0, "cn stamp is sell-side");
        assert_eq!(us.buy_stamp, 0.0);
        assert_eq!(us.sell_stamp, 0.0, "us has no stamp duty");
        assert_eq!(jp.commission, cn.commission);
        assert_eq!(jp.sell_stamp, cn.sell_stamp);
    }
}
