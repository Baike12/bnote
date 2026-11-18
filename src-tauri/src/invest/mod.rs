//! Invest mode: a local-first A-share research workspace.
//!
//! Layout of this module (one file per logical component, `commands/invest.rs`
//! is the IPC surface on top):
//! - [`db`]     — SQLite connection + schema
//! - [`model`]  — the serde structures that cross the IPC boundary
//! - [`kline`]  — daily bars: import, window query, weekly/monthly synthesis
//! - [`instruments`] — instrument master, watchlist, snapshots, fund flow,
//!   financials
//! - [`sectors`] — SW industry skeleton + sector index bars
//! - [`docs`]   — the Markdown document index + FTS5 retrieval plane
//! - [`ontology`] — entities / relations / mentions (the knowledge graph)
//! - [`ingest`] — sources.yaml parsing + the fetch→process→store pipeline
//! - [`quotes`] — quotes.yaml: pluggable quote providers (H7)
//! - [`skill`]  — per-scope SKILL.md / MEMORY.md with versioning
//! - [`forecast`] — the walk-forward replay of a skill against history
//! - [`backtest`] — the event-driven backtest engine (feed→strategy→broker)

pub mod backtest;
pub mod db;
pub mod docs;
pub mod forecast;
pub mod ingest;
pub mod instruments;
pub mod kline;
pub mod model;
pub mod ontology;
pub mod quotes;
pub mod sectors;
pub mod skill;

/// The SQLite file inside the vault (`.bnote/invest/invest.db`).
pub fn db_path(vault_root: &std::path::Path) -> std::path::PathBuf {
    vault_root.join(".bnote").join("invest").join("invest.db")
}

/// The invest document root inside the vault (`.bnote/invest/`).
pub fn root_dir(vault_root: &std::path::Path) -> std::path::PathBuf {
    vault_root.join(".bnote").join("invest")
}
