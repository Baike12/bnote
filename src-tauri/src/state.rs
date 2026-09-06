use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use notify::RecommendedWatcher;

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
}

impl AppState {
    pub fn vault(&self) -> Option<PathBuf> {
        self.vault.read().ok().and_then(|g| g.clone())
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }
}
