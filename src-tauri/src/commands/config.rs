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
/// "stutter on every press" class of jank. The async runtime's worker pool is
/// the same home the vault file IO already uses (see files.rs).
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

/// Main window geometry (logical pixels), written into config.json by the
/// frontend `lib/windowState.ts`.
#[derive(serde::Deserialize)]
struct SavedWindow {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    maximized: bool,
}

/// Restores the main window size and position from the `window` entry of
/// config.json at startup.
///
/// Called from setup: the window already exists and the event loop has not
/// started yet, so the very first frame already has the final size and
/// position -- the user never sees it "drawn once at the default 1280x820 and
/// then jumped".
pub fn restore_window_bounds(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = crate::main_window(app) else {
        return;
    };
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else {
        return; // First launch: no config file, keep the default geometry.
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(value) = config.get("window").cloned() else {
        return;
    };
    let Ok(saved) = serde_json::from_value::<SavedWindow>(value) else {
        return; // Legacy or malformed value: start with the default geometry.
    };
    if !(saved.width.is_finite()
        && saved.height.is_finite()
        && saved.x.is_finite()
        && saved.y.is_finite())
    {
        return;
    }
    let _ = window.set_size(tauri::LogicalSize::new(
        saved.width.max(216.0),
        saved.height.max(480.0),
    ));
    // The display layout may have changed (an external monitor was unplugged),
    // leaving the saved coordinates outside every screen: restore the size only
    // and keep the default position, so the window never opens out of sight.
    if on_screen(&window, saved.x, saved.y) {
        let _ = window.set_position(tauri::LogicalPosition::new(saved.x, saved.y));
    }
    if saved.maximized {
        let _ = window.maximize();
    }
}

/// Whether the top-left corner lands on some screen (an 80pt margin is kept
/// so the window never shows up as just a thin sliver).
fn on_screen(window: &tauri::Window, x: f64, y: f64) -> bool {
    let scale = window.scale_factor().unwrap_or(1.0);
    let (px, py) = (x * scale, y * scale);
    let Ok(monitors) = window.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }
    monitors.iter().any(|m| {
        let origin = m.position();
        let size = m.size();
        let left = origin.x as f64;
        let top = origin.y as f64;
        let right = left + size.width as f64;
        let bottom = top + size.height as f64;
        px >= left - 40.0 * scale
            && py >= top - 40.0 * scale
            && px <= right - 80.0 * scale
            && py <= bottom - 40.0 * scale
    })
}

/// User keybinding overrides; None means "use built-in defaults".
#[tauri::command]
pub async fn load_keybindings(state: State<'_, AppState>) -> CmdResult<Option<Value>> {    let path = state.data_dir().join("keybindings.json");
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
