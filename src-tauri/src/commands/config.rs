use serde_json::Value;
use tauri::State;

use super::CmdResult;
use crate::state::AppState;

/// Opaque app config (last vault, editor prefs). Shape is owned by the frontend.
///
/// Every command here is `async` + `spawn_blocking`: sync Tauri commands run on
/// the MAIN thread, and `save_app_config` fires on a debounce while the user is
/// typing/moving the cursor (cursor-memory persists through it). A sync disk
/// write there stalls the UI thread right under the next keystroke — the
/// "按一下卡一下" class of jank. The async runtime's worker pool is the same
/// home the vault file IO already uses (see files.rs).
#[tauri::command]
pub async fn load_app_config(state: State<'_, AppState>) -> CmdResult<Value> {
    let path = state.data_dir().join("config.json");
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("CORRUPT_CONFIG: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn save_app_config(state: State<'_, AppState>, config: Value) -> CmdResult<()> {
    let path = state.data_dir().join("config.json");
    tauri::async_runtime::spawn_blocking(move || {
        let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Called from set_vault so the next launch reopens the same vault. Not a
/// command: it runs inside set_vault's own (one-off, user-initiated) context.
pub fn persist_last_vault(state: &State<'_, AppState>, vault: &str) -> CmdResult<()> {
    let path = state.data_dir().join("config.json");
    let mut config: Value = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    if !config.is_object() {
        config = serde_json::json!({});
    }
    config["lastVault"] = Value::String(vault.to_string());
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("WRITE_FAILED: {}", e))
}

/// User keybinding overrides; None means "use built-in defaults".
#[tauri::command]
pub async fn load_keybindings(state: State<'_, AppState>) -> CmdResult<Option<Value>> {
    let path = state.data_dir().join("keybindings.json");
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("CORRUPT_CONFIG: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn save_keybindings(state: State<'_, AppState>, keybindings: Value) -> CmdResult<()> {
    let path = state.data_dir().join("keybindings.json");
    tauri::async_runtime::spawn_blocking(move || {
        let json = serde_json::to_string_pretty(&keybindings).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Global vimrc at `<app_data>/vimrc`; None when absent.
#[tauri::command]
pub async fn read_vimrc(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let path = state.data_dir().join("vimrc");
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

#[tauri::command]
pub async fn save_vimrc(state: State<'_, AppState>, contents: String) -> CmdResult<()> {
    let path = state.data_dir().join("vimrc");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
    })
    .await
    .map_err(|e| format!("JOIN_FAILED: {}", e))?
}
