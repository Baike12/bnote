//! Daily-note subsystem ported from `bnote/src/daily/` — model, sync engine,
//! link store. Pure Rust + std::fs IO, no editor dependency.

pub mod engine;
pub mod links;
pub mod model;
