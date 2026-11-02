//! IPC surface of the integrated terminal (the PTY logic lives in `crate::term`).

use base64::Engine as _;
use tauri::{AppHandle, State};

use crate::commands::CmdResult;
use crate::state::AppState;
use crate::term::OpenReply;

/// Spawn a shell in the project root and return its session id.
#[tauri::command]
pub fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    cols: u16,
    rows: u16,
) -> CmdResult<OpenReply> {
    state.terminals.open(&app, &root, cols, rows)
}

/// Keystrokes / pasted text from xterm (base64, arbitrary bytes).
#[tauri::command]
pub fn term_write(state: State<'_, AppState>, term_id: u64, data: String) -> CmdResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("TERM_BASE64: {e}"))?;
    state.terminals.write(term_id, &bytes)
}

/// The frontend's grid changed: propagate the new size to the kernel.
#[tauri::command]
pub fn term_resize(state: State<'_, AppState>, term_id: u64, cols: u16, rows: u16) -> CmdResult<()> {
    state.terminals.resize(term_id, cols, rows)
}

/// Kill one shell (closing a tab).
#[tauri::command]
pub fn term_close(state: State<'_, AppState>, term_id: u64) -> CmdResult<bool> {
    Ok(state.terminals.close(term_id))
}

/// Kill every shell (closing the project, or the app exiting).
#[tauri::command]
pub fn term_close_all(state: State<'_, AppState>) -> CmdResult<()> {
    state.terminals.close_all();
    Ok(())
}
