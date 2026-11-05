pub mod agent;
pub mod bblog;
pub mod code;
pub mod config;
pub mod files;
pub mod focus;
pub mod home;
pub mod ime;
pub mod materials;
pub mod pen_cursor;
pub mod preview;
pub mod python;
pub mod term;
pub mod translate;
pub mod vault;

use std::path::PathBuf;

pub use crate::paths::{ensure_within, normalize};

/// Error type for all commands: converted to a string on the JS side.
pub type CmdResult<T> = Result<T, String>;

/// Returns the vault root, or an error if no vault is open.
pub fn require_vault(state: &crate::state::AppState) -> Result<PathBuf, String> {
    state
        .vault()
        .ok_or_else(|| "NO_VAULT: no vault is open".to_string())
}

/// Rejects path separators / traversal in user-supplied file or folder names.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(format!("INVALID_NAME: {}", name));
    }
    Ok(())
}
