//! Process-scoped owner of the relay connection.
//!
//! Like `daily_sync::client::SyncManager`, this lives outside `AppState`: it is
//! one connection per process, created when the user enables remote access and
//! dropped when they turn it off. Commands talk to it through a `State<'_>`
//! handle; the connection task owns the sockets.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::Manager;

use super::client::{ClientHandle, Connection, Control, RemoteEvents};
use super::settings::{self, Identity};
use super::{audit, Origin};

#[derive(Default)]
pub struct RemoteManager {
    inner: Mutex<Inner>,
    checkpoints: Mutex<std::collections::HashMap<String, super::checkpoint::Checkpoint>>,
    enabled: Arc<AtomicBool>,
    status: Arc<Mutex<Status>>,
}

#[derive(Default)]
struct Inner {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    control: Option<tokio::sync::mpsc::UnboundedSender<Control>>,
    handle: Option<ClientHandle>,
}

#[derive(Clone, Default)]
struct Status {
    state: String,
    last_error: Option<String>,
}

impl RemoteManager {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> Value {
        let status = self.status.lock().map(|g| g.clone()).unwrap_or_default();
        json!({
            "enabled": self.is_enabled(),
            "status": if self.is_enabled() { status.state } else { "disabled".into() },
            "lastError": status.last_error,
        })
    }

    pub fn connections(&self) -> Vec<Connection> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.handle.as_ref().map(|handle| handle.connections()))
            .unwrap_or_default()
    }

    pub async fn enable(&self, app: tauri::AppHandle) -> Result<(), String> {
        if self.is_enabled() {
            return Ok(());
        }
        let data_dir = app.state::<crate::state::AppState>().data_dir();
        let identity =
            tauri::async_runtime::spawn_blocking(move || settings::ensure_identity(&data_dir))
                .await
                .map_err(|e| format!("JOIN_FAILED: {e}"))??;
        let data_dir = app.state::<crate::state::AppState>().data_dir();
        let settings = settings::load_settings(&data_dir);
        let base_url = if settings.base_url.trim().is_empty() {
            settings::DEFAULT_BASE_URL.to_string()
        } else {
            settings.base_url.clone()
        };

        let (handle, mut outgoing, mut control) = ClientHandle::new(app.clone());
        let task_handle = handle.clone();
        let status = self.status.clone();
        let enabled = self.enabled.clone();
        let control_tx = handle.control.clone();
        let task_dir = data_dir.clone();

        self.enabled.store(true, Ordering::SeqCst);
        if let Ok(mut s) = self.status.lock() {
            *s = Status {
                state: "connecting".into(),
                last_error: None,
            };
        }

        let task = tauri::async_runtime::spawn(async move {
            let mut backoff = 500u64;
            while enabled.load(Ordering::SeqCst) {
                let started = Instant::now();
                let result = super::client::connect_loop(
                    &base_url,
                    &identity,
                    &task_dir,
                    &task_handle,
                    &mut control,
                    &mut outgoing,
                )
                .await;
                if let Err(e) = &result {
                    if let Ok(mut s) = status.lock() {
                        s.state = "offline".into();
                        s.last_error = Some(e.clone());
                    }
                    task_handle.app.emit_remote_event(json!({
                        "type": "status",
                        "status": "offline",
                        "error": e,
                    }));
                } else if let Ok(mut s) = status.lock() {
                    s.state = "offline".into();
                }
                if !enabled.load(Ordering::SeqCst) {
                    break;
                }
                // A connection that lived for a while resets the backoff; a
                // failing handshake doubles it up to 8 s.
                if started.elapsed().as_secs() >= 10 {
                    backoff = 500;
                } else {
                    backoff = (backoff * 2).min(8000);
                }
                let stop = tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(backoff)) => false,
                    Some(Control::Stop) = control.recv() => true,
                    else => false,
                };
                if stop {
                    break;
                }
            }
            if let Ok(mut s) = status.lock() {
                s.state = if enabled.load(Ordering::SeqCst) {
                    "offline".into()
                } else {
                    "disabled".into()
                };
            }
        });

        if let Ok(mut inner) = self.inner.lock() {
            inner.task = Some(task);
            inner.control = Some(control_tx);
            inner.handle = Some(handle);
        }
        audit::append(&data_dir, "system", "key", "remote access enabled");
        Ok(())
    }

    pub fn disable(&self, app: &tauri::AppHandle) {
        self.enabled.store(false, Ordering::SeqCst);
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(control) = &inner.control {
                let _ = control.send(Control::Stop);
            }
            inner.task = None;
            inner.control = None;
            inner.handle = None;
        }
        if let Ok(mut status) = self.status.lock() {
            status.state = "disabled".into();
            status.last_error = None;
        }
        let data_dir = app.state::<crate::state::AppState>().data_dir();
        audit::append(&data_dir, "system", "key", "remote access disabled");
    }

    /// Stops the task, then starts a new one with the current settings. Used
    /// after the base URL changes or the key is rotated.
    pub async fn restart(&self, app: tauri::AppHandle) -> Result<(), String> {
        let was_enabled = self.is_enabled();
        if was_enabled {
            self.disable(&app);
        }
        if was_enabled {
            self.enable(app).await?;
        }
        Ok(())
    }

    pub fn send_to_device(&self, device_id: &str, text: String) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|_| "LOCK_FAILED")?;
        inner
            .control
            .as_ref()
            .ok_or("REMOTE_DISABLED: 连接未启动")?
            .send(Control::Send {
                device_id: device_id.to_string(),
                text,
            })
            .map_err(|_| "REMOTE_DISABLED: 连接已停止".to_string())
    }

    pub fn identity(&self, data_dir: &std::path::Path) -> Result<Identity, String> {
        settings::ensure_identity(data_dir)
    }

    /// The checkpoint that opened the latest remote turn of this live session.
    pub fn remember_checkpoint(&self, checkpoint: super::checkpoint::Checkpoint) {
        if let Ok(mut map) = self.checkpoints.lock() {
            map.insert(checkpoint.live_id.clone(), checkpoint);
        }
    }

    pub fn checkpoint_for(&self, live_id: &str) -> Option<super::checkpoint::Checkpoint> {
        self.checkpoints
            .lock()
            .ok()
            .and_then(|map| map.get(live_id).cloned())
    }
}

/// Origin of one live session, for `agent_live_sessions`.
pub fn origin_of(session: &crate::agent::session::Session) -> &'static str {
    match session.origin() {
        Origin::Local => "local",
        Origin::Remote => "remote",
    }
}
