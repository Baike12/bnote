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
    let Some(window) = crate::main_window(app) else {
        return;
    };
    // Same resolver as startup: the E2E data-dir override must not leak the
    // user's real window geometry into an isolated test run.
    let dir = crate::data_dir_for(app);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{app, block_on};

    #[test]
    fn a_missing_config_file_reads_as_null_instead_of_failing() {
        let app = app("config-missing");
        let config = block_on(load_app_config(app.state())).expect("absent config is not an error");
        assert_eq!(config, Value::Null);
        // The same rule for the optional files: absent means "use defaults".
        assert_eq!(
            block_on(load_keybindings(app.state())).expect("absent"),
            None
        );
        assert_eq!(block_on(read_vimrc(app.state())).expect("absent"), None);
    }

    #[test]
    fn config_round_trips_through_disk_as_pretty_json() {
        let app = app("config-roundtrip");
        let value = serde_json::json!({
            "lastVault": "/notes",
            "editor": { "vim": true, "wrap": "soft" },
            "window": { "x": 10.5, "y": -20.0, "width": 1280.0, "height": 820.0 },
        });
        block_on(save_app_config(app.state(), value.clone())).expect("save");
        assert_eq!(block_on(load_app_config(app.state())).expect("load"), value);

        // On-disk shape: the file is the app data dir's `config.json`, pretty
        // printed so a user can read and hand-edit it.
        let raw = std::fs::read_to_string(app.dir.join("config.json")).expect("file");
        assert!(raw.starts_with("{\n  \""), "not pretty printed: {raw}");
    }

    #[test]
    fn corrupt_config_is_reported_with_its_own_error_code() {
        let app = app("config-corrupt");
        std::fs::write(app.dir.join("config.json"), "{ not json").expect("write");
        let err = block_on(load_app_config(app.state())).expect_err("corrupt must fail");
        assert!(
            err.starts_with("CORRUPT_CONFIG:"),
            "the UI branches on this code: {err}"
        );
    }

    #[test]
    fn persisting_the_vault_keeps_every_other_config_key() {
        let app = app("config-persist");
        block_on(save_app_config(
            app.state(),
            serde_json::json!({ "editor": { "vim": true }, "lastVault": "/old" }),
        ))
        .expect("seed");

        persist_last_vault(&app.state(), "/new/vault").expect("persist");
        let config = block_on(load_app_config(app.state())).expect("load");
        assert_eq!(config["lastVault"], "/new/vault");
        assert_eq!(config["editor"]["vim"], true);
    }

    #[test]
    fn persisting_the_vault_replaces_a_non_object_config() {
        // A legacy config that is not an object cannot carry `lastVault`;
        // persisting must still produce a usable object rather than fail.
        let app = app("config-persist-legacy");
        std::fs::write(app.dir.join("config.json"), "[]").expect("write");
        persist_last_vault(&app.state(), "/vault").expect("persist");
        let config = block_on(load_app_config(app.state())).expect("load");
        assert_eq!(config, serde_json::json!({ "lastVault": "/vault" }));
    }

    #[test]
    fn persisting_the_vault_over_corrupt_json_recovers_instead_of_failing() {
        let app = app("config-persist-corrupt");
        std::fs::write(app.dir.join("config.json"), "garbage").expect("write");
        persist_last_vault(&app.state(), "/vault").expect("corrupt legacy config is replaced");
        assert_eq!(
            block_on(load_app_config(app.state())).expect("load")["lastVault"],
            "/vault"
        );
    }

    #[test]
    fn keybindings_and_vimrc_live_beside_the_config() {
        let app = app("config-side-files");
        block_on(save_keybindings(
            app.state(),
            serde_json::json!({ "app.palette": "Mod-p" }),
        ))
        .expect("save keybindings");
        assert_eq!(
            block_on(load_keybindings(app.state())).expect("load"),
            Some(serde_json::json!({ "app.palette": "Mod-p" }))
        );

        // An empty vimrc is a real value, distinct from "no vimrc": the editor
        // must not fall back to the built-in defaults for it.
        block_on(save_vimrc(app.state(), String::new())).expect("save vimrc");
        assert_eq!(
            block_on(read_vimrc(app.state())).expect("load"),
            Some(String::new())
        );
        block_on(save_vimrc(app.state(), "set number\n".into())).expect("save vimrc");
        assert_eq!(
            block_on(read_vimrc(app.state())).expect("load"),
            Some("set number\n".to_string())
        );
        assert!(app.dir.join("keybindings.json").is_file());
        assert!(app.dir.join("vimrc").is_file());
    }

    #[test]
    fn corrupt_keybindings_are_reported_instead_of_silently_defaulted() {
        let app = app("config-keybindings-corrupt");
        std::fs::write(app.dir.join("keybindings.json"), "{").expect("write");
        let err = block_on(load_keybindings(app.state())).expect_err("corrupt must fail");
        assert!(err.starts_with("CORRUPT_CONFIG:"), "{err}");
    }
}
