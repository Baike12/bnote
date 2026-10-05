use serde_json::Value;

use super::CmdResult;
use crate::state::AppState;

/// Opaque app config (last vault, editor prefs). Shape is owned by the frontend.
///
/// All functions here are synchronous and blocking: shells decide where to run
/// them. `save_app_config` fires on a debounce while the user is typing or
/// moving the cursor (cursor-memory persists through it), so the shell must
/// keep disk IO off its UI thread — Tauri wraps in `spawn_blocking`, GPUI in
/// `background_executor` (the same reason the original Tauri commands were
/// async: sync commands run on the main thread, and a sync disk write there
/// stalls the next keystroke).

pub fn load_app_config(state: &AppState) -> CmdResult<Value> {
    let path = state.data_dir().join("config.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("CORRUPT_CONFIG: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    }
}

pub fn save_app_config(state: &AppState, config: Value) -> CmdResult<()> {
    let path = state.data_dir().join("config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("WRITE_FAILED: {}", e))
}

/// Called from set_vault so the next launch reopens the same vault.
pub fn persist_last_vault(state: &AppState, vault: &str) -> CmdResult<()> {
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
pub fn load_keybindings(state: &AppState) -> CmdResult<Option<Value>> {
    let path = state.data_dir().join("keybindings.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("CORRUPT_CONFIG: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    }
}

pub fn save_keybindings(state: &AppState, keybindings: Value) -> CmdResult<()> {
    let path = state.data_dir().join("keybindings.json");
    let json = serde_json::to_string_pretty(&keybindings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("WRITE_FAILED: {}", e))
}

/// Global vimrc at `<app_data>/vimrc`; None when absent.
pub fn read_vimrc(state: &AppState) -> CmdResult<Option<String>> {
    let path = state.data_dir().join("vimrc");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("READ_FAILED: {}", e)),
    }
}

pub fn save_vimrc(state: &AppState, contents: String) -> CmdResult<()> {
    let path = state.data_dir().join("vimrc");
    std::fs::write(&path, contents).map_err(|e| format!("WRITE_FAILED: {}", e))
}
