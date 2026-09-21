//! 运行器:把前端拼好的虚拟 python 文件写进 `<data_dir>/py-run/` 并执行,
//! stdout/stderr 经节流后以 `python-run-output` 事件流回,退出以
//! `python-run-exit` 事件收尾。同一笔记同时只允许一个运行,新运行杀掉旧的。

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

/// 单次运行的超时:超时杀进程,exit 事件带 timedOut 标记。
pub const RUN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvKind {
    /// 项目配置里显式指定的解释器。
    Config,
    /// 项目根下的 .venv。
    Venv,
    /// pyproject.toml + uv → `uv run python`。
    Uv,
    /// 系统 python3。
    System,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEnv {
    pub kind: EnvKind,
    pub program: String,
    #[serde(skip)]
    pub prefix_args: Vec<String>,
    /// 实际的 python 解释器;uv 时可能尚未落盘(首次 `uv run` 才建环境)。
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

/// 在给定 PATH 串里找可执行文件(独立成函数以便测试注入 PATH)。
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

/// 项目根下的 .venv 解释器(unix: .venv/bin/python;win: .venv/Scripts/python.exe)。
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

/// venv 的 bin 目录(装 ty 这类工具的地方)。
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

/// 解释器解析顺序:项目配置 > .venv > pyproject+uv > 系统 python3。
pub fn resolve_env(root: &Path, cfg: &ProjectConfig) -> ResolvedEnv {
    if let Some(py) = cfg.python.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
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

/// 一次活跃的运行。child 由收尾任务独占(等待退出需要跨 await 持有),取消
/// 通过 watch channel 传信号 —— 若把 child 放进 Mutex,收尾任务持锁 wait 时
/// cancel 再去拿锁 kill 就互相等死锁(实测踩过)。
pub struct RunHandle {
    pub md_path: String,
    pub kill_tx: tokio::sync::watch::Sender<bool>,
    pub cancelled: Arc<AtomicBool>,
}

/// 全局运行注册表:key = md_path,同一笔记串行。包在 Arc 里,收尾任务也要
/// 摘除自己。
pub struct RunRegistry {
    pub next_id: AtomicU64,
    pub runs: Mutex<HashMap<String, Arc<RunHandle>>>,
}

impl RunRegistry {
    pub fn new() -> Self {
        Self { next_id: AtomicU64::new(1), runs: Mutex::new(HashMap::new()) }
    }

    /// 请求杀掉该笔记当前的运行(收尾任务收到信号后 kill)。进程真退出由
    /// 收尾任务负责;这里只发信号。
    pub fn cancel(&self, md_path: &str) -> bool {
        let handle = self
            .runs
            .lock()
            .ok()
            .and_then(|m| m.get(md_path).cloned());
        match handle {
            Some(h) => {
                h.cancelled.store(true, Ordering::Relaxed);
                let _ = h.kill_tx.send(true);
                true
            }
            None => false,
        }
    }

    /// 运行收尾后摘除自己;仅当注册表里还是这个句柄(新运行可能已顶掉它)。
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

/// 临时脚本:<data_dir>/py-run/<md_path 哈希>.py。用 data_dir 而不是 vault,
/// 避免每次运行惊动 watcher。
fn temp_script(data_dir: &Path, md_path: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    md_path.hash(&mut h);
    data_dir.join("py-run").join(format!("{:016x}.py", h.finish()))
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

/// 运行一篇笔记的虚拟 python 文本。前端保证 text 已经是行对齐 + main 守卫
/// 处理后的最终文本;这里只负责进程、环境变量与事件。
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
    // 新运行顶掉旧运行(先发 kill 信号,避免两份输出交错)。
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
    // 环境:本地 import 与真实项目一致 —— 项目根进 PYTHONPATH;venv 时把
    // VIRTUAL_ENV 与 venv bin 给上(子进程里的 pip/uv 等工具都能看到)。
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
        // child 被这个任务 move 进来独占;kill_on_drop 兜底(运行时关闭时杀掉)。
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

/// stdout/stderr 读取:≤16KB 或 40ms 节流 flush 一次,UTF-8 断行残片留在
/// 缓冲里等下一个 chunk,不会把多字节字符拆成乱码。
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
                    if pending.len() >= 16 * 1024 || last_flush.elapsed() >= Duration::from_millis(40) {
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
        // 系统兜底:没有 pyproject → System(与机器上有没有 uv 无关)。
        let env = resolve_env(&root, &ProjectConfig::default());
        assert_eq!(env.kind, EnvKind::System);

        // .venv 优先于 uv/pyproject。
        let py = venv_python_for_test(&root);
        let env = resolve_env(&root, &ProjectConfig::default());
        assert_eq!(env.kind, EnvKind::Venv);
        assert_eq!(env.program, py.to_string_lossy().to_string());

        // 配置解释器最高优先。
        let custom = root.join("custom-python");
        std::fs::write(&custom, "").unwrap();
        let env = resolve_env(
            &root,
            &ProjectConfig { python: Some(custom.to_string_lossy().to_string()), ..Default::default() },
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
