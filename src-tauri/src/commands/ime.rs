use crate::ime_daemon;
use serde::{Deserialize, Serialize};
use std::sync::mpsc;
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
    /// Whether the app's own input method context accepted the source before
    /// the system menu bar changed. `Some(false)` is a real failure; `None`
    /// means no input context existed at that instant (the pending intent is
    /// retried on focus, not by a timer).
    pub context_applied: Option<bool>,
    /// Main-thread cost of the context hand-off, in milliseconds. The normal
    /// path only writes the selected-source property; the destructive rebuild
    /// is a rare recovery path.
    pub context_ms: f64,
    /// The source the app's input context reports after the attempt. `None`
    /// when no input context exists at that instant. Diagnostic only — the
    /// property mirrors the system change even when the session is stale.
    pub context_source: Option<String>,
}

/// Result of the app-side half of a switch, measured on the main thread.
struct ContextHandoff {
    applied: Option<bool>,
    previous: Option<String>,
    source: Option<String>,
    ms: f64,
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

/// Selects an input source by id.
///
/// The order is the contract:
///
/// 1. hand the source to the app's `NSTextInputContext` first;
/// 2. select the same source for the system in the helper process.
///
/// Step 1 is the one that decides what the WebView types with, so it must be
/// ready before the menu bar advertises success. Doing it after the helper was
/// the source of both bugs bnote saw: AppKit had already mirrored the system
/// value, making the context write a no-op ("menu bar changed, notes did
/// not"), and forcing a session rebuild on every switch tore down the active
/// text session on the path of the next keystroke ("notes area janks").
///
/// A missed context is kept as a generation-stamped pending intent. The next
/// focus or mode event retries it; a delayed thread must not start a
/// destructive AppKit transition while the user is already typing.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn set_input_source(app: tauri::AppHandle, id: String) -> CmdResult<SetImeOutcome> {
    let intent = crate::ime_tis::begin_intent(id.clone())?;

    // Context first: the property is still different while the system source
    // has not moved, so AppKit performs one real context transition. The
    // recovery rebuild only runs when an older pass knew there was no context.
    let mut handoff = hand_off_context(app.clone(), id.clone(), intent.rebuild).await?;
    if handoff.applied == Some(false) && !intent.rebuild {
        // The property did not stick. Rebuild once before exposing the system
        // source; a second failure is reported and retried on the next focus.
        handoff = hand_off_context(app.clone(), id.clone(), true).await?;
    }

    let target = intent.target.clone();
    let selected = match spawn_blocking(move || {
        ime_daemon::with_client(|client| client.select(&target))
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("join error: {error}")),
    };
    let (switched, tis_ms) = match selected {
        Ok(outcome) => outcome,
        Err(error) => {
            // The system select never completed. Put the WebView back on its
            // previous source so it cannot be left ahead of the menu bar.
            if let Some(previous) = handoff.previous.clone() {
                if let Err(rollback) = hand_off_context(app.clone(), previous, false).await {
                    eprintln!("[bnote] ime context rollback failed: {rollback}");
                }
            }
            if let Err(coordinator) = crate::ime_tis::abandon_intent(&intent) {
                return Err(format!("{error}; {coordinator}"));
            }
            return Err(error);
        }
    };

    if handoff.applied == Some(true) {
        crate::ime_tis::settle_intent(&intent)?;
    } else {
        crate::ime_tis::mark_intent_missed(&intent)?;
    }

    eprintln!(
        "[bnote] set_input_source({id}) -> switched={switched} tis={tis_ms:.1}ms ctx={:?} {} {:.2}ms",
        handoff.applied,
        handoff.source.as_deref().unwrap_or("<no context>"),
        handoff.ms,
    );
    Ok(SetImeOutcome {
        switched,
        tis_ms,
        context_applied: handoff.applied,
        context_ms: handoff.ms,
        context_source: handoff.source,
    })
}

/// Dispatches the context hand-off to the app's main thread and waits for it.
#[cfg(target_os = "macos")]
async fn hand_off_context(
    app: tauri::AppHandle,
    id: String,
    rebuild: bool,
) -> CmdResult<ContextHandoff> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let started = std::time::Instant::now();
        let previous = crate::ime_tis::context_source_id();
        let applied = crate::ime_tis::apply_context_source(&id, rebuild);
        // Read it back for the trace: "no context" and "context disagrees" are
        // different failures with different owners (retry vs the switch).
        let source = crate::ime_tis::context_source_id();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        if let Err(e) = tx.send(ContextHandoff {
            applied,
            previous,
            source,
            ms,
        }) {
            eprintln!("[bnote] ime hand-off reply dropped: {e}");
        }
    })
    .map_err(|e| format!("main thread dispatch failed: {e}"))?;
    spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("context apply failed: {e}"))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn set_input_source(_id: String) -> CmdResult<SetImeOutcome> {
    Err("IME switching is only supported on macOS".into())
}
