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

/// `cursorPositions[path]` — the byte offset and scroll-top (whole pixels)
/// the user last left in `path`. The same shape the Tauri shell's
/// `cursorMemory.ts` writes.
pub fn cursor_position(config: &Value, path: &str) -> Option<(usize, f32)> {
    let entry = config.get("cursorPositions")?.get(path)?;
    let pos = entry.get("pos")?.as_u64()? as usize;
    let scroll = entry.get("scroll")?.as_f64()? as f32;
    Some((pos, scroll))
}

/// Record the cursor offset and scroll-top of `path` in `config`, in place.
/// Replaces whatever shape the key held — cursor memory owns it.
pub fn set_cursor_position(config: &mut Value, path: &str, pos: usize, scroll: f32) {
    if path.is_empty() {
        return;
    }
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let root = config.as_object_mut().expect("just made it an object");
    let entry = root
        .entry("cursorPositions")
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    entry
        .as_object_mut()
        .expect("just made it an object")
        .insert(
            path.to_string(),
            serde_json::json!({ "pos": pos, "scroll": scroll.round() as i64 }),
        );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_positions_round_trip_under_their_path() {
        let mut config = serde_json::json!({ "lastVault": "/vault" });
        set_cursor_position(&mut config, "Daily/2026-10-05.md", 42, 1234.6);
        set_cursor_position(&mut config, "notes/a.md", 7, 0.0);

        assert_eq!(
            cursor_position(&config, "Daily/2026-10-05.md"),
            Some((42, 1235.0)),
            "scroll rounds to whole pixels"
        );
        assert_eq!(cursor_position(&config, "notes/a.md"), Some((7, 0.0)));
        assert_eq!(cursor_position(&config, "missing.md"), None);
        // The rest of the config is untouched.
        assert_eq!(config["lastVault"], serde_json::json!("/vault"));
    }

    #[test]
    fn cursor_positions_survive_a_wrong_shaped_config() {
        // A null config (no file yet) becomes an object holding the map.
        let mut config = Value::Null;
        set_cursor_position(&mut config, "a.md", 1, 2.0);
        assert_eq!(cursor_position(&config, "a.md"), Some((1, 2.0)));

        // A string where the map should be is replaced, not merged into.
        let mut broken = serde_json::json!({ "cursorPositions": "oops" });
        set_cursor_position(&mut broken, "b.md", 3, 4.0);
        assert_eq!(cursor_position(&broken, "b.md"), Some((3, 4.0)));

        // Garbage entries read as None instead of panicking.
        let garbage = serde_json::json!({ "cursorPositions": { "c.md": { "pos": "x" } } });
        assert_eq!(cursor_position(&garbage, "c.md"), None);

        // An empty path never lands in the map.
        let mut config = serde_json::json!({});
        set_cursor_position(&mut config, "", 1, 1.0);
        assert!(config.get("cursorPositions").is_none());
    }
}
