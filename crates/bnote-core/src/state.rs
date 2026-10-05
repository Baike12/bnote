use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use notify::RecommendedWatcher;

use crate::agent::mcp::McpManager;
use crate::agent::session::Session;
use crate::events::EventBus;
use crate::python::lsp::LspServer;
use crate::python::runner::RunRegistry;

/// Handle keeping a vault watcher alive; dropping it unregisters the watch
/// and signals the debounce thread to exit.
pub struct WatcherHandle {
    pub _watcher: RecommendedWatcher,
    pub stop: Arc<AtomicBool>,
}

/// Shared application state, owned by whichever shell is running (Tauri or
/// GPUI). Pure data — no UI runtime types.
pub struct AppState {
    /// Root of the currently opened vault (notebook folder).
    pub vault: RwLock<Option<PathBuf>>,
    /// Filesystem watcher for the vault; replaced when the vault changes.
    pub watcher: Mutex<Option<WatcherHandle>>,
    /// Persistent config directory (per-shell: Tauri app_data_dir / GPUI dir).
    pub data_dir: PathBuf,
    /// Live agent sessions (study mode).
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// MCP connections, (re)connected lazily per config.
    pub mcp_manager: Mutex<Option<Arc<McpManager>>>,
    /// Currently open note path (set by the frontend for agent context).
    pub current_note: Mutex<Option<String>>,
    /// Python 运行注册表(key = md_path);Arc 化,收尾任务要摘除自己。
    pub python_runs: Arc<RunRegistry>,
    /// 活跃的 python LSP 服务器(key = 项目根绝对路径)。
    pub python_lsp: Mutex<HashMap<String, Arc<LspServer>>>,
    /// Backend → shell event bus (vault-changed, python-run-output, …).
    pub events: EventBus,
}

impl AppState {
    /// Builds the state and hands back the shell's event receiver.
    pub fn new(
        data_dir: PathBuf,
    ) -> (
        Arc<Self>,
        tokio::sync::broadcast::Receiver<crate::events::AppEvent>,
    ) {
        let (events, rx) = tokio::sync::broadcast::channel(crate::events::EVENT_CAPACITY);
        let state = Arc::new(Self {
            vault: RwLock::new(None),
            watcher: Mutex::new(None),
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            mcp_manager: Mutex::new(None),
            current_note: Mutex::new(None),
            python_runs: Arc::new(RunRegistry::new()),
            python_lsp: Mutex::new(HashMap::new()),
            events,
        });
        (state, rx)
    }

    pub fn vault(&self) -> Option<PathBuf> {
        self.vault.read().ok().and_then(|g| g.clone())
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }

    /// Emits an event to the shell (broadcast; a dead shell just drops it).
    pub fn emit(&self, name: &str, payload: serde_json::Value) {
        let _ = self
            .events
            .send(crate::events::AppEvent::new(name, payload));
    }
}
