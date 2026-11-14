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
pub fn term_resize(
    state: State<'_, AppState>,
    term_id: u64,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::app;

    #[test]
    fn malformed_terminal_input_is_rejected_before_reaching_the_pty() {
        // xterm sends base64; a corrupt payload must be a named error rather
        // than bytes written into the user's shell.
        let fixture = app("term-b64");
        let err = term_write(fixture.state(), 1, "not base64!!".into())
            .expect_err("corrupt input must fail");
        assert!(err.starts_with("TERM_BASE64:"), "{err}");
    }

    #[test]
    fn writing_to_an_unknown_terminal_is_a_named_error() {
        let fixture = app("term-missing");
        // Valid base64, unknown id: the failure names the id so the frontend
        // can drop the tab instead of retrying forever.
        let err = term_write(fixture.state(), 42, "aGk=".into()).expect_err("unknown id");
        assert_eq!(err, "TERM_NOT_FOUND: 42");
        assert_eq!(
            term_resize(fixture.state(), 42, 80, 24).expect_err("unknown id"),
            "TERM_NOT_FOUND: 42"
        );
    }

    #[test]
    fn closing_an_unknown_terminal_reports_false_instead_of_failing() {
        // A repeated close (the exit watcher got there first) is normal, not an
        // error: the UI clears the tab either way.
        let fixture = app("term-close");
        assert!(!term_close(fixture.state(), 7).expect("close is not an error"));
        term_close_all(fixture.state()).expect("closing everything is a no-op without shells");
    }
}
