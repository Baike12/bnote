//! Thin Tauri commands for the remote-access settings page and the desktop's
//! attach flow. All state lives in `remote::manager`; these functions only
//! parse arguments and report errors the UI can act on.

use serde_json::{json, Value};
use tauri::State;

use crate::remote::manager::RemoteManager;
use crate::remote::{audit, crypto, settings};
use crate::state::AppState;

fn status_json(state: &AppState, manager: &RemoteManager) -> Value {
    let data_dir = state.data_dir();
    let saved = settings::load_settings(&data_dir);
    let identity = manager.identity(&data_dir).ok();
    let mut value = manager.status();
    value["baseUrl"] = json!(saved.base_url);
    value["relayUrl"] = json!(settings::relay_url(&saved.base_url).ok());
    value["room"] = json!(identity
        .as_ref()
        .map(|i| i.room.clone())
        .unwrap_or_default());
    value["deviceId"] = json!(saved.device_id);
    value["hasKey"] = json!(settings::has_key());
    value["keySuffix"] = json!(settings::key_suffix());
    value["connections"] = json!(manager.connections());
    value["allowedProjects"] = json!(saved.allowed_projects);
    value
}

#[tauri::command]
pub fn remote_status(
    manager: State<'_, RemoteManager>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    Ok(status_json(&state, &manager))
}

/// Enabling without a key generates one and returns it exactly once. The key
/// itself is never part of the status payload.
#[tauri::command]
pub async fn remote_set_enabled(
    app: tauri::AppHandle,
    manager: State<'_, RemoteManager>,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<Value, String> {
    let mut new_key = None;
    if enabled {
        if !settings::has_key() {
            let key = settings::generate_key()?;
            new_key = Some(crypto::hex_encode(&key));
        }
        manager.enable(app.clone()).await?;
    } else {
        manager.disable(&app);
    }
    let data_dir = state.data_dir();
    // Persist the switch only after the manager accepted it; a failed connect
    // is still "enabled" (it keeps retrying) and must survive a restart.
    let mut saved = settings::load_settings(&data_dir);
    saved.enabled = enabled;
    settings::save_settings(&data_dir, &saved)?;
    let mut value = status_json(&state, &manager);
    value["newKey"] = json!(new_key);
    Ok(value)
}

#[tauri::command]
pub async fn remote_set_base_url(
    app: tauri::AppHandle,
    manager: State<'_, RemoteManager>,
    state: State<'_, AppState>,
    base_url: String,
) -> Result<Value, String> {
    let normalized = settings::normalize_base_url(&base_url)?;
    let data_dir = state.data_dir();
    let mut saved = settings::load_settings(&data_dir);
    saved.base_url = normalized;
    settings::save_settings(&data_dir, &saved)?;
    manager.restart(app.clone()).await?;
    Ok(status_json(&state, &manager))
}

#[tauri::command]
pub fn remote_key_generate(state: State<'_, AppState>) -> Result<Value, String> {
    let key = settings::generate_key()?;
    audit::append(&state.data_dir(), "system", "key", "remote key generated");
    Ok(json!({
        "key": crypto::hex_encode(&key),
        "keySuffix": settings::key_suffix(),
    }))
}

#[tauri::command]
pub fn remote_key_reveal() -> Result<Value, String> {
    let key = settings::reveal_key()?;
    Ok(json!({
        "key": crypto::hex_encode(&key),
        "keySuffix": settings::key_suffix(),
    }))
}

/// Rotating changes the room, which disconnects every phone at once. The
/// b-todo key and the diary ciphertext are untouched.
#[tauri::command]
pub async fn remote_key_rotate(
    app: tauri::AppHandle,
    manager: State<'_, RemoteManager>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let key = settings::rotate_key()?;
    audit::append(
        &state.data_dir(),
        "system",
        "key",
        "remote key rotated; every phone must be given the new key",
    );
    manager.restart(app).await?;
    Ok(json!({
        "key": crypto::hex_encode(&key),
        "keySuffix": settings::key_suffix(),
    }))
}

#[tauri::command]
pub fn remote_audit_tail(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Value, String> {
    Ok(json!({
        "entries": audit::tail(&state.data_dir(), limit.unwrap_or(50)),
        "nextCursor": Value::Null,
    }))
}

#[tauri::command]
pub fn remote_set_allowed_projects(
    state: State<'_, AppState>,
    projects: Vec<String>,
) -> Result<Value, String> {
    let saved = settings::save_allowed_projects(&state.data_dir(), projects)?;
    Ok(json!({ "allowedProjects": saved.allowed_projects }))
}

/// The desktop sidebar overlays running/origin by transcript id. The registry
/// key is the live id, hence both.
#[tauri::command]
pub fn agent_live_sessions(state: State<'_, AppState>) -> Result<Value, String> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    let sessions = registry
        .values()
        .map(|session| {
            json!({
                "liveId": session.id,
                "transcriptId": session.transcript_id(),
                "projectId": session.ctx.workdir.as_deref().map(settings::project_id_for),
                "running": session.running.load(std::sync::atomic::Ordering::SeqCst),
                "origin": crate::remote::manager::origin_of(session),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "sessions": sessions }))
}

/// The desktop attach path. A live session is returned as-is; for a session
/// that is not live the frontend falls back to its existing restore flow.
#[tauri::command]
pub fn agent_attach_session(
    state: State<'_, AppState>,
    transcript_id: String,
) -> Result<Value, String> {
    let registry = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = registry
        .values()
        .find(|s| s.transcript_id() == transcript_id);
    match session {
        Some(session) => Ok(json!({
            "live": true,
            "liveId": session.id,
            "transcriptId": session.transcript_id(),
            "title": "",
            "running": session.running.load(std::sync::atomic::Ordering::SeqCst),
            "origin": crate::remote::manager::origin_of(session),
            "history": session.history(),
            "eventSeq": session.events.event_seq(),
        })),
        None => Ok(json!({ "live": false })),
    }
}
