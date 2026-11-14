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

/// Test-only scaffolding that lets a unit test build an `AppState` and hand the
/// real command bodies a `tauri::State`, without a window or an event loop.
///
/// Commands are the app's real boundary: they validate, confine paths and write
/// disk. Before this module existed the only way to touch that logic was a full
/// app, so the file/config/tree surface had no behavioral coverage at all.
#[cfg(test)]
pub(crate) mod test_support {
    use crate::state::AppState;
    use tauri::Manager;

    /// One mock app plus its temporary data directory.
    ///
    /// The `App` must stay alive for as long as the state is used: it owns the
    /// state storage. Keep it in a named binding, not behind `_`.
    pub(crate) struct TestApp {
        pub app: tauri::App<tauri::test::MockRuntime>,
        pub dir: std::path::PathBuf,
    }

    impl TestApp {
        pub(crate) fn state(&self) -> tauri::State<'_, AppState> {
            self.app.state::<AppState>()
        }
    }

    impl Drop for TestApp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A unique temp directory per test: the lib tests run in parallel, so a
    /// shared path would have one test deleting another's fixture.
    pub(crate) fn temp_dir(tag: &str) -> std::path::PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "bnote-cmd-{tag}-{}-{stamp}-{seq}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// A mock app whose data directory is fresh, with no vault open.
    pub(crate) fn app(tag: &str) -> TestApp {
        let dir = temp_dir(tag);
        let app = tauri::test::mock_app();
        app.manage(AppState {
            vault: std::sync::RwLock::new(None),
            watcher: std::sync::Mutex::new(None),
            data_dir: dir.clone(),
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            current_note: std::sync::Mutex::new(None),
            python_runs: std::sync::Arc::new(crate::python::runner::RunRegistry::new()),
            python_lsp: std::sync::Mutex::new(std::collections::HashMap::new()),
            code_lsp: std::sync::Mutex::new(std::collections::HashMap::new()),
            code_trees: std::sync::Mutex::new(std::collections::HashMap::new()),
            code_watcher: std::sync::Mutex::new(None),
            terminals: crate::term::TermManager::new(),
        });
        TestApp { app, dir }
    }

    /// The same app with `dir/vault` opened as the vault, so vault-scoped
    /// commands run against a real directory through the same `require_vault`
    /// check.
    ///
    /// The field is written directly instead of calling `set_vault`: that path
    /// installs a live FSEvents watcher, migrates the agent home and grants the
    /// asset scope — real side effects a unit test must not start.
    pub(crate) fn app_with_vault(tag: &str) -> TestApp {
        let app = app(tag);
        let vault = app.dir.join("vault");
        std::fs::create_dir_all(&vault).expect("vault dir");
        let canonical = vault.canonicalize().expect("canonical vault");
        *app.app
            .state::<AppState>()
            .vault
            .write()
            .expect("vault lock") = Some(canonical);
        app
    }

    /// The canonical vault root of [`app_with_vault`].
    pub(crate) fn vault_root(app: &TestApp) -> std::path::PathBuf {
        app.state().vault().expect("vault is open")
    }

    /// Runs an async command body on the test runtime.
    pub(crate) fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }
}

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
