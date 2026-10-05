//! Private tokio runtime for the async flows core owns (python runner, agent
//! sessions, LSP processes).
//!
//! Shells run different executors — Tauri drives tokio, GPUI drives smol — so
//! core never assumes the ambient runtime: it runs its own and exposes
//! synchronous spawn entry points both shells can call.

use std::sync::OnceLock;

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("bnote-core-async")
            .build()
            .expect("failed to build bnote-core tokio runtime")
    })
}

/// Runs `fut` to completion on core's runtime, blocking the caller.
pub fn block_on<T: Send + 'static>(fut: impl std::future::Future<Output = T> + Send + 'static) -> T {
    runtime().block_on(fut)
}

/// Spawns `fut` on core's runtime; results must reach the caller through
/// channels (e.g. the event bus), the handle is not awaited by shells.
pub fn spawn<T: Send + 'static>(fut: impl std::future::Future<Output = T> + Send + 'static) {
    runtime().spawn(fut);
}
