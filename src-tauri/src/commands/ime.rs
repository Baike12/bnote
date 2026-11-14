use crate::ime_daemon;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::spawn_blocking;

use super::CmdResult;

/// The helper protocol serializes this type as JSON (macOS); the derive is
/// unconditional so every target compiles the same command surface.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InputSourceInfo {
    pub id: String,
    pub name: String,
    pub is_cjk: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetImeOutcome {
    /// false when the requested source was already active.
    pub switched: bool,
    /// The TIS call itself, in milliseconds, as measured inside the helper
    /// process (see docs/PERFORMANCE.md §6). The app's main thread never runs
    /// TIS any more, so this number is no longer a UI freeze — it only names
    /// how long the input method took to engage.
    pub tis_ms: f64,
}

#[cfg(target_os = "macos")]
async fn list_impl() -> CmdResult<Vec<InputSourceInfo>> {
    spawn_blocking(|| ime_daemon::with_client(|c| c.list()))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(not(target_os = "macos"))]
async fn list_impl() -> CmdResult<Vec<InputSourceInfo>> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
async fn current_impl() -> CmdResult<String> {
    spawn_blocking(|| ime_daemon::with_client(|c| c.current()))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map(|opt| opt.unwrap_or_default())
}

#[cfg(not(target_os = "macos"))]
async fn current_impl() -> CmdResult<String> {
    Err("IME switching is only supported on macOS".into())
}

/// Lists enabled, selectable input sources for the settings picker. The first
/// call (the startup warm-up, see imeWarmUp) also pre-pays the cold TIS select
/// initialization — inside the helper process, off the app's main thread.
#[tauri::command]
pub async fn list_input_sources() -> CmdResult<Vec<InputSourceInfo>> {
    list_impl().await
}

/// Returns the id of the current input source.
#[tauri::command]
pub async fn get_current_input_source() -> CmdResult<String> {
    current_impl().await
}

/// Selects an input source by id; a no-op when it is already active.
///
/// The TIS select runs in the long-lived helper process (`ime_daemon`): the
/// app's main thread only writes one protocol line and reads the answer, so a
/// 25–100 ms switch (real-trace range) can no longer freeze typing, scrolling
/// or AppKit key delivery. The helper keeps its own TIS reference cache warm,
/// so a switch costs one round trip.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn set_input_source(id: String) -> CmdResult<SetImeOutcome> {
    let target = id.clone();
    let outcome = spawn_blocking(move || ime_daemon::with_client(|c| c.select(&target)))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    let (switched, tis_ms) = outcome;
    eprintln!("[bnote] set_input_source({id}) -> switched={switched} tis={tis_ms:.1}ms");
    Ok(SetImeOutcome { switched, tis_ms })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn set_input_source(_id: String) -> CmdResult<SetImeOutcome> {
    Err("IME switching is only supported on macOS".into())
}
