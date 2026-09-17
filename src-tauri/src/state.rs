use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use notify::RecommendedWatcher;

use crate::agent::mcp::McpManager;
use crate::agent::session::Session;

/// Handle keeping a vault watcher alive; dropping it unregisters the watch
/// and signals the debounce thread to exit.
pub struct WatcherHandle {
    pub _watcher: RecommendedWatcher,
    pub stop: Arc<AtomicBool>,
}

/// Shared application state managed by Tauri.
pub struct AppState {
    /// Root of the currently opened vault (notebook folder).
    pub vault: RwLock<Option<PathBuf>>,
    /// Filesystem watcher for the vault; replaced when the vault changes.
    pub watcher: Mutex<Option<WatcherHandle>>,
    /// Persistent config directory (Tauri app_data_dir).
    pub data_dir: PathBuf,
    /// Live agent sessions (study mode).
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// MCP connections, (re)connected lazily per config.
    pub mcp_manager: Mutex<Option<Arc<McpManager>>>,
    /// Currently open note path (set by the frontend for agent context).
    pub current_note: Mutex<Option<String>>,
}

impl AppState {
    pub fn vault(&self) -> Option<PathBuf> {
        self.vault.read().ok().and_then(|g| g.clone())
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }
}
