//! The runner: it writes the virtual Python file assembled by the front end
//! into `<data_dir>/py-run/` and executes it, streams stdout/stderr back
//! throttled as `python-run-output` events and ends with a `python-run-exit`
//! event. Only one run per note is allowed at a time; a new run kills the old
//! one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::Emitter;
use tokio::io::AsyncReadExt;

use super::ProjectConfig;

/// The timeout of one run: on timeout the process is killed and the exit event
/// carries the timedOut flag.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvKind {
    /// The interpreter explicitly named in the project configuration.
    Config,
    /// The .venv under the project root.
    Venv,
    /// pyproject.toml + uv → `uv run python`.
    Uv,
    /// The system python3.
    System,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEnv {
    pub kind: EnvKind,
    pub program: String,
    #[serde(skip)]
    pub prefix_args: Vec<String>,
    /// The actual Python interpreter; with uv it may not exist on disk yet (the
    /// environment is created by the first `uv run`).
    pub python: Option<PathBuf>,
    pub venv_dir: Option<PathBuf>,
    pub detail: String,
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Finds an executable in the given PATH string (a separate function so that
/// tests can inject a PATH).
pub fn find_on_path_in(path_var: &str, prog: &str) -> Option<PathBuf> {
    for dir in path_var.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(prog);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub fn find_on_path(prog: &str) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    find_on_path_in(&path_var, prog)
}

/// The interpreter of the .venv under the project root (unix:
/// .venv/bin/python; win: .venv/Scripts/python.exe).
pub fn venv_python(root: &Path) -> Option<PathBuf> {
    let p = venv_bin(&venv_dir(root)).join(venv_bin_name());
    p.exists().then_some(p)
}

fn venv_dir(root: &Path) -> PathBuf {
    root.join(".venv")
}

#[cfg(target_os = "windows")]
fn venv_bin_name() -> &'static str {
    "python.exe"
}
#[cfg(not(target_os = "windows"))]
fn venv_bin_name() -> &'static str {
    "python"
}

/// The bin directory of the venv (where tools like ty are installed).
pub fn venv_bin(venv: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        venv.join("Scripts")
    }
    #[cfg(not(target_os = "windows"))]
    {
        venv.join("bin")
    }
}

/// The interpreter resolution order: project configuration > .venv >
/// pyproject+uv > the system python3.
pub fn resolve_env(root: &Path, cfg: &ProjectConfig) -> ResolvedEnv {
    if let Some(py) = cfg
        .python
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(py);
        if p.exists() {
            return ResolvedEnv {
                kind: EnvKind::Config,
                program: p.to_string_lossy().to_string(),
                prefix_args: vec![],
                python: Some(p.clone()),
                venv_dir: None,
                detail: format!("配置的解释器 {}", p.display()),
            };
        }
    }
    if let Some(py) = venv_python(root) {
        return ResolvedEnv {
            kind: EnvKind::Venv,
            program: py.to_string_lossy().to_string(),
            prefix_args: vec![],
            python: Some(py.clone()),
            venv_dir: Some(venv_dir(root)),
            detail: format!(".venv ({})", py.display()),
        };
    }
    if root.join("pyproject.toml").exists() {
        if let Some(uv) = find_on_path("uv") {
            return ResolvedEnv {
                kind: EnvKind::Uv,
                program: uv.to_string_lossy().to_string(),
                prefix_args: vec!["run".into(), "python".into()],
                python: None,
                venv_dir: None,
                detail: "uv run(项目 pyproject.toml)".into(),
            };
        }
    }
    let sys = find_on_path("python3")
        .or_else(|| find_on_path("python"))
        .unwrap_or_else(|| PathBuf::from("python3"));
    ResolvedEnv {
        kind: EnvKind::System,
        program: sys.to_string_lossy().to_string(),
        prefix_args: vec![],
        python: Some(sys.clone()),
        venv_dir: None,
        detail: format!("系统解释器 ({})", sys.display()),
    }
}

/// One active run. The child is owned by the cleanup task (waiting for the
/// exit has to hold it across an await), and the cancellation travels through a
/// watch channel — putting the child into a Mutex instead deadlocks: the
/// cleanup task holds the lock while waiting and cancel then waits for the
/// same lock to kill (hit this in practice).
pub struct RunHandle {
    pub md_path: String,
    pub kill_tx: tokio::sync::watch::Sender<bool>,
    pub cancelled: Arc<AtomicBool>,
}

/// The global run registry: key = md_path, one run per note at a time. The
/// entries are wrapped in an Arc because the cleanup task removes its own.
pub struct RunRegistry {
    pub next_id: AtomicU64,
    pub runs: Mutex<HashMap<String, Arc<RunHandle>>>,
}

impl RunRegistry {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            runs: Mutex::new(HashMap::new()),
        }
    }

    /// Asks for the current run of that note to be killed (the cleanup task
    /// kills the process once it receives the signal). The actual exit is the
    /// cleanup task's job; this only sends the signal.
    pub fn cancel(&self, md_path: &str) -> bool {
        let handle = self.runs.lock().ok().and_then(|m| m.get(md_path).cloned());
        match handle {
            Some(h) => {
                h.cancelled.store(true, Ordering::Relaxed);
                let _ = h.kill_tx.send(true);
                true
            }
            None => false,
        }
    }

    /// Removes itself after the run is over, but only when the registry still
    /// holds this handle (a new run may have replaced it).
    pub fn remove_if_current(&self, md_path: &str, handle: &Arc<RunHandle>) {
        if let Ok(mut runs) = self.runs.lock() {
            if let Some(cur) = runs.get(md_path) {
                if Arc::ptr_eq(cur, handle) {
                    runs.remove(md_path);
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub run_id: u64,
    pub command: String,
    pub env_kind: EnvKind,
    pub program: String,
    pub cwd: String,
}

/// The temporary script: `<data_dir>/py-run/<hash of md_path>.py`. It lives in
/// the data_dir and not in the vault, so that every run does not disturb the
/// watcher.
fn temp_script(data_dir: &Path, md_path: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    md_path.hash(&mut h);
    data_dir
        .join("py-run")
        .join(format!("{:016x}.py", h.finish()))
}

fn prune_old_scripts(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        let cutoff = std::time::SystemTime::now() - Duration::from_secs(24 * 3600);
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.modified().map(|t| t < cutoff).unwrap_or(false) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Runs the virtual Python text of a note. The front end guarantees that the
/// text is already the final one after the line alignment and the main guard
/// handling; this function only owns the process, the environment variables and
/// the events.
pub async fn run_note(
    app: tauri::AppHandle,
    state: &crate::state::AppState,
    md_path: String,
    code: String,
) -> Result<RunStarted, String> {
    let vault = crate::commands::require_vault(state)?;
    let project = super::resolve_project(&vault, Path::new(&md_path))?;
    let config = super::load_config(&vault).project(&project.name);
    let env = resolve_env(&project.root, &config);

    let run_id = state.python_runs.next_id.fetch_add(1, Ordering::Relaxed);
    // A new run replaces the old one (the kill signal comes first, so the two
    // outputs never interleave).
    state.python_runs.cancel(&md_path);

    let script = temp_script(&state.data_dir(), &md_path);
    {
        let script = script.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            if let Some(parent) = script.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
                prune_old_scripts(parent);
            }
            std::fs::write(&script, code.as_bytes()).map_err(|e| format!("WRITE_FAILED: {}", e))
        })
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))??;
    }

    let mut cmd = tokio::process::Command::new(&env.program);
    cmd.args(&env.prefix_args)
        .arg(&script)
        .current_dir(&project.root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // The environment makes a local import behave like in a real project — the
    // project root goes into PYTHONPATH; with a venv, VIRTUAL_ENV and the venv
    // bin are passed on (so the tools in the child process, pip/uv and the
    // like, see them too).
    let mut path_var = std::env::var("PATH").unwrap_or_default();
    if let Some(venv) = &env.venv_dir {
        cmd.env("VIRTUAL_ENV", venv);
        let bin = venv_bin(venv);
        if bin.is_dir() {
            path_var = format!("{}:{}", bin.display(), path_var);
            cmd.env("PATH", &path_var);
        }
    }
    {
        let existing = std::env::var("PYTHONPATH").unwrap_or_default();
        let pp = if existing.is_empty() {
            project.root.to_string_lossy().to_string()
        } else {
            format!("{}:{}", project.root.display(), existing)
        };
        cmd.env("PYTHONPATH", pp);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("SPAWN_FAILED: {} — {}", env.program, e))?;
    let stdout = child.stdout.take().ok_or("PIPE_FAILED: stdout")?;
    let stderr = child.stderr.take().ok_or("PIPE_FAILED: stderr")?;

    let script_name = script
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let prefix = if env.prefix_args.is_empty() {
        String::new()
    } else {
        format!("{} ", env.prefix_args.join(" "))
    };
    let command = format!(
        "{} {}{}   (cwd: {})",
        env.program,
        prefix,
        script_name,
        project.root.display()
    );
    let started_info = RunStarted {
        run_id,
        command: command.clone(),
        env_kind: env.kind,
        program: env.program.clone(),
        cwd: project.root.to_string_lossy().to_string(),
    };

    let (kill_tx, mut kill_rx) = tokio::sync::watch::channel(false);
    let handle = Arc::new(RunHandle {
        md_path: md_path.clone(),
        kill_tx,
        cancelled: Arc::new(AtomicBool::new(false)),
    });
    if let Ok(mut runs) = state.python_runs.runs.lock() {
        runs.insert(md_path.clone(), handle.clone());
    }

    spawn_reader(app.clone(), run_id, md_path.clone(), "stdout", stdout);
    spawn_reader(app.clone(), run_id, md_path.clone(), "stderr", stderr);

    let app_exit = app.clone();
    let wait_handle = handle.clone();
    let registry = state.python_runs.clone();
    tauri::async_runtime::spawn(async move {
        let started_at = Instant::now();
        // The child is moved into this task and owned by it; kill_on_drop is
        // the backstop (it kills the process when the runtime shuts down).
        let exit = tokio::select! {
            status = child.wait() => {
                let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
                json!({
                    "runId": run_id,
                    "mdPath": wait_handle.md_path,
                    "exitCode": code,
                    "durationMs": started_at.elapsed().as_millis() as u64,
                    "cancelled": wait_handle.cancelled.load(Ordering::Relaxed),
                    "timedOut": false,
                })
            }
            _ = kill_rx.changed() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                json!({
                    "runId": run_id,
                    "mdPath": wait_handle.md_path,
                    "exitCode": serde_json::Value::Null,
                    "durationMs": started_at.elapsed().as_millis() as u64,
                    "cancelled": true,
                    "timedOut": false,
                })
            }
            _ = tokio::time::sleep(RUN_TIMEOUT) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                json!({
                    "runId": run_id,
                    "mdPath": wait_handle.md_path,
                    "exitCode": serde_json::Value::Null,
                    "durationMs": started_at.elapsed().as_millis() as u64,
                    "cancelled": false,
                    "timedOut": true,
                })
            }
        };
        let _ = app_exit.emit("python-run-exit", exit);
        registry.remove_if_current(&wait_handle.md_path, &wait_handle);
    });
    Ok(started_info)
}

/// Reading stdout/stderr: a flush is throttled to ≤16KB or 40ms, and a UTF-8
/// fragment split across chunks stays in the buffer until the next chunk, so a
/// multi-byte character is never torn into garbage.
fn spawn_reader(
    app: tauri::AppHandle,
    run_id: u64,
    md_path: String,
    stream: &'static str,
    mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static,
) {
    tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let mut last_flush = Instant::now();
        loop {
            match tokio::time::timeout(Duration::from_millis(40), pipe.read(&mut buf)).await {
                Err(_elapsed) => {
                    if !pending.is_empty() {
                        flush_chunk(&app, run_id, &md_path, stream, &mut pending);
                        last_flush = Instant::now();
                    }
                }
                Ok(Err(_)) | Ok(Ok(0)) => {
                    if !pending.is_empty() {
                        flush_chunk(&app, run_id, &md_path, stream, &mut pending);
                    }
                    break;
                }
                Ok(Ok(n)) => {
                    pending.extend_from_slice(&buf[..n]);
                    if pending.len() >= 16 * 1024
                        || last_flush.elapsed() >= Duration::from_millis(40)
                    {
                        flush_chunk(&app, run_id, &md_path, stream, &mut pending);
                        last_flush = Instant::now();
                    }
                }
            }
        }
    });
}

fn flush_chunk(
    app: &tauri::AppHandle,
    run_id: u64,
    md_path: &str,
    stream: &str,
    pending: &mut Vec<u8>,
) {
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) => e.valid_up_to(),
    };
    if valid == 0 {
        return;
    }
    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
    pending.drain(..valid);
    if text.is_empty() {
        return;
    }
    let _ = app.emit(
        "python-run-output",
        json!({ "runId": run_id, "mdPath": md_path, "stream": stream, "text": text }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bnote-py-run-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn make_exec(p: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(p, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn find_on_path_scans_in_order() {
        let a = tmpdir("a");
        let b = tmpdir("b");
        make_exec(&a.join("mytool"));
        make_exec(&b.join("mytool"));
        let found = find_on_path_in(&format!("{}:{}", b.display(), a.display()), "mytool").unwrap();
        assert_eq!(found, b.join("mytool"));
        assert!(find_on_path_in(&format!("{}", a.display()), "notool").is_none());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_env_prefers_config_then_venv() {
        let root = tmpdir("env");
        // The system fallback: without a pyproject → System (independent of
        // whether the machine has uv).
        let env = resolve_env(&root, &ProjectConfig::default());
        assert_eq!(env.kind, EnvKind::System);

        // The .venv wins over uv/pyproject.
        let py = venv_python_for_test(&root);
        let env = resolve_env(&root, &ProjectConfig::default());
        assert_eq!(env.kind, EnvKind::Venv);
        assert_eq!(env.program, py.to_string_lossy().to_string());

        // The interpreter from the configuration has the highest priority.
        let custom = root.join("custom-python");
        std::fs::write(&custom, "").unwrap();
        let env = resolve_env(
            &root,
            &ProjectConfig {
                python: Some(custom.to_string_lossy().to_string()),
                ..Default::default()
            },
        );
        assert_eq!(env.kind, EnvKind::Config);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    fn venv_python_for_test(root: &Path) -> PathBuf {
        let bin = venv_bin(&venv_dir(root));
        std::fs::create_dir_all(&bin).unwrap();
        let py = bin.join("python");
        make_exec(&py);
        py
    }

    #[test]
    fn temp_script_is_deterministic_per_note() {
        let dir = tmpdir("script");
        let a = temp_script(&dir, "/vault/n.md");
        let b = temp_script(&dir, "/vault/n.md");
        let c = temp_script(&dir, "/vault/m.md");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.to_string_lossy().ends_with(".py"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
