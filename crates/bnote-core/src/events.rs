//! Application-wide event bus.
//!
//! The Tauri shell used to call `AppHandle::emit(...)` from deep inside the
//! backend. Core has no UI runtime now, so emitters send [`AppEvent`]s on a
//! broadcast channel and each shell forwards them however it wants: the Tauri
//! shell re-emits to the webview, the GPUI shell applies them to its state
//! directly.

use serde::Serialize;

/// One backend event, same (name, payload) shape the Tauri shell emitted.
#[derive(Clone, Debug, Serialize)]
pub struct AppEvent {
    pub name: String,
    pub payload: serde_json::Value,
}

impl AppEvent {
    pub fn new(name: &str, payload: serde_json::Value) -> Self {
        Self {
            name: name.to_string(),
            payload,
        }
    }
}

/// Cloneable sender half; receivers are handed out per shell via
/// [`crate::state::AppState::subscribe`].
pub type EventBus = tokio::sync::broadcast::Sender<AppEvent>;

/// Capacity of the per-shell event queue. Events are progress-ish updates
/// (watcher batches, python output chunks, agent deltas); a slow shell drops
/// the oldest rather than backing up the emitter.
pub const EVENT_CAPACITY: usize = 1024;

/// Sends `payload` as `name` on `bus`, dropping it when no receiver remains
/// (a dead shell just drops events). One-liner for emitters that hold a bare
/// [`EventBus`] — detached threads/tasks that outlive the call and cannot
/// reach an [`crate::state::AppState`].
pub fn emit_event(bus: &EventBus, name: &str, payload: impl Serialize) {
    let _ = bus.send(AppEvent::new(
        name,
        serde_json::to_value(payload).unwrap_or_default(),
    ));
}
