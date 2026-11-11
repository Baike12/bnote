use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use notify::RecommendedWatcher;

use crate::agent::session::Session;
use crate::code::lsp::LspManager;
use crate::code::project::CodeTree;
use crate::python::lsp::LspServer;
use crate::python::runner::RunRegistry;
use crate::term::TermManager;

/// Handle keeping a filesystem watcher alive (the vault's, the open code
/// project's); dropping it unregisters the watch and signals the debounce
/// thread to exit.
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
    /// Currently open note path (set by the frontend for agent context).
    pub current_note: Mutex<Option<String>>,
    /// Registry of running Python jobs (key = md_path); the `Arc` handle identity
    /// is what lets a finished job remove itself without evicting a newer run.
    pub python_runs: Arc<RunRegistry>,
    /// Live python LSP servers (key = absolute project root path).
    pub python_lsp: Mutex<HashMap<String, Arc<LspServer>>>,
    /// Live code-project language servers (key = absolute project root path).
    pub code_lsp: Mutex<HashMap<String, Arc<LspManager>>>,
    /// Scanned code-project file trees (key = absolute project root path).
    ///
    /// Opening a project and `code_rescan` write it, search reads it — search
    /// must not walk the repository again on its own.
    pub code_trees: Mutex<HashMap<String, CodeTree>>,
    /// Filesystem watcher of the open code project; replaced when another
    /// project opens. It keeps `code_trees` in step with edits made outside the
    /// app (the agent, a shell, `git checkout`) and pushes the difference to
    /// the UI as `code-tree-changed`.
    pub code_watcher: Mutex<Option<WatcherHandle>>,
    /// Live integrated-terminal shells (the code pane's bottom drawer).
    pub terminals: TermManager,
}

impl AppState {
    pub fn vault(&self) -> Option<PathBuf> {
        self.vault.read().ok().and_then(|g| g.clone())
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }
}
