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
    /// Whether the system source moved. false when it was already active, or
    /// when the context hand-off missed and the system select was deferred to
    /// the next context-ready update (the menu bar must not advertise a switch
    /// the WebView did not take).
    pub switched: bool,
    /// The TIS call itself, in milliseconds, as measured inside the helper
    /// process (see docs/PERFORMANCE.md §6). 0 when the select was deferred
    /// because the context did not accept the target.
    pub tis_ms: f64,
    /// Whether the app's own input method context accepted the source before
    /// the system menu bar changed. `Some(false)` is a real failure; `None`
    /// means no input context existed at that instant. In both cases the
    /// system source stays unchanged and the pending intent is retried on the
    /// next window update that exposes a context, not by a timer.
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
/// A missed context is kept as a generation-stamped pending intent. A one-shot
/// AppKit window-update observer retries it as soon as a context exists; a
/// delayed thread must not start a destructive transition while the user is
/// already typing.
///
/// The system select runs only after the context accepted the target. A miss
/// leaves the system source (and the menu bar) on the previous source: the
/// half-switched state — menu bar changed, notes did not — must not be
/// produced in the first place rather than repaired after the fact.
#[cfg(target_os = "macos")]
fn system_select_allowed(applied: Option<bool>) -> bool {
    applied == Some(true)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn set_input_source(app: tauri::AppHandle, id: String) -> CmdResult<SetImeOutcome> {
    let intent = crate::ime_tis::begin_intent(id.clone())?;

    // Context first: the property is still different while the system source
    // has not moved, so AppKit performs one real context transition. The
    // recovery rebuild only runs when an older pass knew there was no context.
    let mut handoff = hand_off_context(app.clone(), id.clone(), intent.rebuild).await?;
    if handoff.applied == Some(false) && !intent.rebuild {
        // The property did not stick. Retry once before exposing the system
        // source; it is a destructive rebuild only when the property already
        // reads the target (the stale-session case).
        handoff = hand_off_context(app.clone(), id.clone(), true).await?;
    }

    // The context is the authority for typing. Without a confirmed context
    // the helper must not move the system source: the menu bar would say one
    // thing while the WebView types another. Keep the intent pending and wait
    // for AppKit's next window update to expose a real input context.
    if !system_select_allowed(handoff.applied) {
        crate::ime_tis::mark_intent_missed(&intent)?;
        arm_context_ready_retry(app);
        eprintln!(
            "[bnote] set_input_source({id}) deferred: context={:?} {} {:.2}ms; system source unchanged",
            handoff.applied,
            handoff.source.as_deref().unwrap_or("<no context>"),
            handoff.ms,
        );
        return Ok(SetImeOutcome {
            switched: false,
            tis_ms: 0.0,
            context_applied: handoff.applied,
            context_ms: handoff.ms,
            context_source: handoff.source,
        });
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

/// Waits for the current AppKit window update cycle to expose the input
/// context, then retries the latest deferred intent. The watch is one-shot and
/// only exists while a miss is pending; it is not a polling timer.
#[cfg(target_os = "macos")]
fn arm_context_ready_retry(app: tauri::AppHandle) {
    let callback_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let notify_app = callback_app.clone();
        let notify = Box::new(move || {
            use tauri::Emitter;
            if let Err(error) = notify_app.emit("bnote:ime-context-ready", ()) {
                eprintln!("[bnote] input source context-ready event failed: {error}");
            }
        });
        if let Err(error) = crate::ime_tis::watch_for_context_ready(notify) {
            eprintln!("[bnote] input source retry watch failed: {error}");
        }
    }) {
        eprintln!("[bnote] input source retry watch dispatch failed: {error}");
    }
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::system_select_allowed;

    /// Gate: the system source follows only a context that took the target.
    /// A miss (`None`/`Some(false)`) must leave the menu bar on the previous
    /// source; moving it anyway is the "menu bar changed, notes did not" state.
    #[test]
    fn the_system_source_follows_only_a_confirmed_context() {
        assert!(system_select_allowed(Some(true)));
        assert!(!system_select_allowed(Some(false)));
        assert!(!system_select_allowed(None));
    }
}
