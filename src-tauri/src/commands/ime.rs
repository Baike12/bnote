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
    /// Whether the app's own input method session was rebuilt on the new
    /// source. `None` when no switch happened, so there was nothing to rebuild.
    pub context_applied: Option<bool>,
    /// Main-thread cost of the session rebuild, in milliseconds. This is the
    /// leg that must stay off the keystroke budget.
    pub context_ms: f64,
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
/// Both halves of the switch live in this one command, because each can only
/// run in one place: the TIS select runs in the long-lived helper process
/// (`ime_daemon`) — on the app's main thread it froze typing, scrolling and
/// AppKit key delivery for 25–100 ms (real-trace range) — and the input method
/// session rebuild runs on the app's main thread (`ime_tis`), because the
/// context is a process-local object. Keeping them in one round trip removes
/// the window in which the system source has already switched while the
/// hand-off is still an extra IPC hop away.
///
/// `contextApplied` is `None` when no switch happened (nothing to hand off).
/// A `false` there is a real failure — the menu bar switched while typing
/// stays on the old source — and must not be swallowed.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn set_input_source(app: tauri::AppHandle, id: String) -> CmdResult<SetImeOutcome> {
    let target = id.clone();
    let (switched, tis_ms) = spawn_blocking(move || ime_daemon::with_client(|c| c.select(&target)))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    let (context_applied, context_ms) = if switched {
        let (tx, rx) = std::sync::mpsc::channel();
        let handed = id.clone();
        app.run_on_main_thread(move || {
            let started = std::time::Instant::now();
            let applied = crate::ime_tis::apply_context_source(&handed);
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            if let Err(e) = tx.send((applied, elapsed)) {
                eprintln!("[bnote] ime hand-off reply dropped: {e}");
            }
        })
        .map_err(|e| format!("main thread dispatch failed: {e}"))?;
        let (applied, elapsed) = spawn_blocking(move || rx.recv())
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("context apply failed: {e}"))?;
        (Some(applied), elapsed)
    } else {
        (None, 0.0)
    };
    eprintln!(
        "[bnote] set_input_source({id}) -> switched={switched} tis={tis_ms:.1}ms ctx={context_applied:?} {context_ms:.2}ms"
    );
    Ok(SetImeOutcome {
        switched,
        tis_ms,
        context_applied,
        context_ms,
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn set_input_source(_id: String) -> CmdResult<SetImeOutcome> {
    Err("IME switching is only supported on macOS".into())
}
