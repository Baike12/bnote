use crate::ime_daemon;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use tauri::async_runtime::spawn_blocking;

use super::CmdResult;

/// Whether the app's input context is known to disagree with the last intent.
///
/// The system source (helper process) and the app's context are two different
/// authorities, and only the second one decides what the web view types with.
/// A select that reports "already active" therefore does not prove the context
/// is right: an earlier hand-off can miss (no first responder yet, e.g. while
/// the window is activating), and from then on every key of the whole
/// normal-mode session goes through the old IME — which is felt as lag on j/k,
/// not as visible latin input. This flag makes the next command (and the
/// delayed repair) rebuild the context even when the system source did not
/// change, until a rebuild is confirmed.
static CONTEXT_STALE: AtomicBool = AtomicBool::new(false);

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
    /// source. `Some(false)` is a real failure (the menu bar switched, the
    /// session did not); `None` means no rebuild was attempted — either no
    /// switch happened, or there was no input context to hand the source to
    /// (a delayed repair then owns that case).
    pub context_applied: Option<bool>,
    /// Main-thread cost of the session rebuild, in milliseconds. This is the
    /// leg that must stay off the keystroke budget.
    pub context_ms: f64,
    /// The source the app's input context reports after the attempt. `None`
    /// when no input context exists at that instant. Diagnostic only — the
    /// property mirrors the system change even when the session is stale.
    pub context_source: Option<String>,
}

/// Result of the app-side half of a switch, measured on the main thread.
struct ContextHandoff {
    applied: Option<bool>,
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

/// Selects an input source by id; a no-op when the *system* source is already
/// active, but never a no-op for the app's input context.
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
/// The hand-off is attempted when the system source really changed **or** the
/// context is known stale (`CONTEXT_STALE`). Skipping it on "already active"
/// was a silent hole: after one missed hand-off the context stays on the old
/// IME for the rest of the mode, and every normal-mode key pays the IME round
/// trip (the lag the user feels on j/k while the menu bar already shows ABC).
///
/// If there is no context at this instant (window activating), a bounded
/// delayed repair retries — the JS side cannot see that state, so the native
/// half owns the retry. `contextApplied` is `None` when no rebuild was
/// attempted; `Some(false)` is a real failure.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn set_input_source(app: tauri::AppHandle, id: String) -> CmdResult<SetImeOutcome> {
    let target = id.clone();
    let (switched, tis_ms) = spawn_blocking(move || ime_daemon::with_client(|c| c.select(&target)))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    let repair = switched || CONTEXT_STALE.load(Ordering::Acquire);
    let handoff = if repair {
        match hand_off_context(app.clone(), id.clone()).await {
            Ok(result) => result,
            Err(e) => {
                // The system half already ran; report the miss instead of
                // swallowing it, and let the delayed repair heal it.
                eprintln!("[bnote] ime context hand-off failed: {e}");
                ContextHandoff {
                    applied: None,
                    source: None,
                    ms: 0.0,
                }
            }
        }
    } else {
        ContextHandoff {
            applied: None,
            source: None,
            ms: 0.0,
        }
    };
    if repair {
        match handoff.applied {
            Some(true) => CONTEXT_STALE.store(false, Ordering::Release),
            _ => CONTEXT_STALE.store(true, Ordering::Release),
        }
        if handoff.applied != Some(true) {
            schedule_context_repair(app, id.clone());
        }
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

/// Dispatches the context rebuild to the app's main thread and waits for it.
#[cfg(target_os = "macos")]
async fn hand_off_context(app: tauri::AppHandle, id: String) -> CmdResult<ContextHandoff> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let started = std::time::Instant::now();
        let applied = crate::ime_tis::apply_context_source(&id);
        // Read it back for the trace: "no context" and "context disagrees" are
        // different failures with different owners (repair vs the switch).
        let source = crate::ime_tis::context_source_id();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        if let Err(e) = tx.send(ContextHandoff {
            applied,
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

/// Repairs the context once one exists, with a small bounded number of tries.
///
/// The miss this heals is a timing one: on window activation the switch can run
/// before the web view becomes the first responder, so `apply_context_source`
/// has no context to hand the source to. Nothing on the JS side can observe
/// "no context yet", so the retry lives here, on a side thread that only
/// dispatches to the main thread.
///
/// The system source is the arbiter of the current intent: if it no longer
/// equals the target, the user or a newer mode change has moved on and this
/// stale intent must not be forced back.
#[cfg(target_os = "macos")]
fn schedule_context_repair(app: tauri::AppHandle, target: String) {
    std::thread::spawn(move || {
        for delay_ms in [50u64, 120, 240, 480] {
            std::thread::sleep(Duration::from_millis(delay_ms));
            let current = ime_daemon::with_client(|c| c.current()).ok().flatten();
            if current.as_deref() != Some(target.as_str()) {
                return;
            }
            let (tx, rx) = mpsc::channel();
            let handed = target.clone();
            if app
                .run_on_main_thread(move || {
                    let _ = tx.send(crate::ime_tis::apply_context_source(&handed));
                })
                .is_err()
            {
                return; // the app is shutting down
            }
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(Some(true)) => {
                    CONTEXT_STALE.store(false, Ordering::Release);
                    eprintln!("[bnote] ime context repaired after a delayed retry: {target}");
                    return;
                }
                Ok(other) => {
                    CONTEXT_STALE.store(true, Ordering::Release);
                    eprintln!("[bnote] ime context retry missed ({other:?}): {target}");
                }
                Err(e) => eprintln!("[bnote] ime context retry reply failed: {e}"),
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn set_input_source(_id: String) -> CmdResult<SetImeOutcome> {
    Err("IME switching is only supported on macOS".into())
}
