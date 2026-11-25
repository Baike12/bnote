//! Thin Tauri commands for the remote-access settings page and the desktop's
//! attach flow. All state lives in `remote::manager`; these functions only
//! parse arguments and report errors the UI can act on.

use serde_json::{json, Value};
use tauri::State;

use crate::remote::manager::RemoteManager;
use crate::remote::{audit, pairing, settings};
use crate::state::AppState;

#[tauri::command]
pub fn remote_status(
    manager: State<'_, RemoteManager>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let data_dir = state.data_dir();
    let mut value = manager.status();
    let saved = settings::load_settings(&data_dir);
    value["relayUrl"] = json!(saved.relay_url);
    value["room"] = json!(saved.room);
    value["deviceId"] = json!(saved.device_id);
    value["devices"] = json!(pairing::load_devices(&data_dir));
    value["allowedProjects"] = json!(saved.allowed_projects);
    Ok(value)
}

#[tauri::command]
pub async fn remote_set_enabled(
    app: tauri::AppHandle,
    manager: State<'_, RemoteManager>,
    state: State<'_, AppState>,
    enabled: bool,
    relay_url: Option<String>,
) -> Result<Value, String> {
    if let Some(url) = relay_url {
        let url = url.trim().to_string();
        if !url.is_empty() && !url.starts_with("wss://") {
            return Err("BAD_PARAMS: relay 地址必须是 wss://".into());
        }
        let mut saved = settings::load_settings(&state.data_dir());
        saved.relay_url = url;
        settings::save_settings(&state.data_dir(), &saved)?;
    }
    if enabled {
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
    let mut value = manager.status();
    value["relayUrl"] = json!(saved.relay_url);
    value["room"] = json!(saved.room);
    value["deviceId"] = json!(saved.device_id);
    value["devices"] = json!(pairing::load_devices(&data_dir));
    value["allowedProjects"] = json!(saved.allowed_projects);
    Ok(value)
}

#[tauri::command]
pub fn remote_pairing_begin(
    app: tauri::AppHandle,
    manager: State<'_, RemoteManager>,
) -> Result<Value, String> {
    let (payload, expires_at, room) = manager.begin_pairing(&app)?;
    Ok(json!({
        "payload": payload,
        "expiresAt": expires_at,
        "room": room,
    }))
}

#[tauri::command]
pub fn remote_pairing_cancel(manager: State<'_, RemoteManager>) -> Result<(), String> {
    manager.cancel_pairing();
    Ok(())
}

#[tauri::command]
pub fn remote_pair_approve(
    manager: State<'_, RemoteManager>,
    device_id: String,
    allow: bool,
) -> Result<(), String> {
    manager.approve(&device_id, allow)
}

#[tauri::command]
pub fn remote_devices(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(json!({
        "devices": pairing::load_devices(&state.data_dir()),
    }))
}

#[tauri::command]
pub fn remote_revoke_device(
    manager: State<'_, RemoteManager>,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    let data_dir = state.data_dir();
    pairing::revoke_device(&data_dir, &device_id)?;
    manager.revoke(&device_id);
    audit::append(&data_dir, "system", "revoke", &device_id);
    Ok(())
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

/// Delivers the b-todo server URL and key over E2E after pairing. The key is
/// never written to the desktop audit log.
#[tauri::command]
pub fn remote_todo_config(
    manager: State<'_, RemoteManager>,
    state: State<'_, AppState>,
    device_id: String,
    server: String,
    key: String,
) -> Result<(), String> {
    let body = json!({
        "t": "rpc",
        "id": crate::remote::crypto::hex_encode(&crate::remote::crypto::random::<16>()),
        "method": "todo.config",
        "params": { "server": server, "key": key },
    });
    manager.send_to_device(&device_id, body.to_string())?;
    audit::append(
        &state.data_dir(),
        &device_id,
        "send",
        "sent the todo configuration",
    );
    Ok(())
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
