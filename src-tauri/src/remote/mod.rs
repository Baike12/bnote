//! Remote access: the outbound WebSocket channel from the Mac to the relay, the
//! end-to-end crypto around it, and the RPC surface the iPhone drives.
//!
//! The wire contract is `bnote-mobile/protocol/v2.md`. Nothing here is exposed
//! to the local frontend except through the thin commands in
//! `commands/remote.rs`.

pub mod audit;
pub mod checkpoint;
pub mod client;
pub mod crypto;
pub mod events;
pub mod frame;
pub mod keys;
pub mod manager;
pub mod recorder;
pub mod rpc;
pub mod settings;
pub mod transcript;

/// Who owns the transcript of a conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Local,
    Remote,
}
