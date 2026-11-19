//! Daily todo sync client for the b-todo server: end-to-end encryption plus
//! one long-lived SSE subscription, with REST push/pull helpers in the
//! commands layer. See `crypto.rs` for the key derivation contract and
//! `client.rs` for the connection lifecycle.

pub mod client;
pub mod crypto;
