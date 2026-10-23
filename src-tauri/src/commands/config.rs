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

/// 主窗口几何(逻辑像素),由前端 `lib/windowState.ts` 写进 config.json。
#[derive(serde::Deserialize)]
struct SavedWindow {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    maximized: bool,
}

/// 启动时按 config.json 的 `window` 恢复主窗口大小与位置。
///
/// 在 setup 里调用:窗口已创建、事件循环还没开始跑,所以第一帧就是最终
/// 尺寸和位置,用户看不到「先按默认 1280×820 画一次再跳」。
pub fn restore_window_bounds(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else {
        return; // 首次启动:没有配置文件,保持默认几何
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(value) = config.get("window").cloned() else {
        return;
    };
    let Ok(saved) = serde_json::from_value::<SavedWindow>(value) else {
        return; // 旧版/坏值:按默认几何启动
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
    // 显示器布局变了(比如拔掉外接屏)时旧坐标可能落在所有屏幕之外:这时只
    // 恢复尺寸,位置留默认,窗口不会开到看不见的地方。
    if on_screen(&window, saved.x, saved.y) {
        let _ = window.set_position(tauri::LogicalPosition::new(saved.x, saved.y));
    }
    if saved.maximized {
        let _ = window.maximize();
    }
}

/// 左上角是否落在某块屏幕里(留 80pt 余量,避免只剩一条缝)。
fn on_screen(window: &tauri::WebviewWindow, x: f64, y: f64) -> bool {
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
