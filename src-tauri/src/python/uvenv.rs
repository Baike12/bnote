//! Creating a uv environment: when the project has no pyproject.toml it first
//! runs `uv init --bare` (which only creates pyproject.toml, without any
//! sample files), then `uv sync` (which produces uv.lock + .venv). The full
//! log is returned to the front end and shown in the run panel.

use std::path::Path;
use std::time::Duration;

use super::runner::find_on_path;

const INIT_TIMEOUT: Duration = Duration::from_secs(60);
const SYNC_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UvOutcome {
    pub log: String,
    pub ran_init: bool,
}

pub async fn create_uv_env(project_root: &Path) -> Result<UvOutcome, String> {
    let uv = find_on_path("uv")
        .ok_or("uv 未安装:请先安装 uv(https://docs.astral.sh/uv/),再创建环境")?
        .to_string_lossy()
        .to_string();

    let mut log = String::new();
    let mut ran_init = false;
    if !project_root.join("pyproject.toml").exists() {
        ran_init = true;
        let out = run_capture(&uv, &["init", "--bare"], project_root, INIT_TIMEOUT).await?;
        log.push_str(&out);
        if !out.ends_with("OK\n") {
            return Err(log);
        }
    }
    let out = run_capture(&uv, &["sync"], project_root, SYNC_TIMEOUT).await?;
    log.push_str(&out);
    if !out.ends_with("OK\n") {
        return Err(log);
    }
    Ok(UvOutcome { log, ran_init })
}

/// Runs one uv command and assembles "command line + stdout + stderr + exit
/// code" into a log; the tail says OK (exit code 0) or FAIL, and the caller
/// judges success by it.
async fn run_capture(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<String, String> {
    let display = format!("$ uv {}", args.join(" "));
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| format!("SPAWN_FAILED: {} — {}", program, e))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("TIMEOUT: {} 超时({}s)", display, timeout.as_secs()))?
        .map_err(|e| format!("WAIT_FAILED: {}", e))?;

    let mut log = String::new();
    log.push_str(&display);
    log.push('\n');
    if !output.stdout.is_empty() {
        log.push_str(&String::from_utf8_lossy(&output.stdout));
    }
    if !output.stderr.is_empty() {
        log.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if output.status.success() {
        log.push_str("OK\n");
    } else {
        log.push_str(&format!("FAIL(退出码 {})\n", output.status.code().unwrap_or(-1)));
    }
    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_uv_is_a_clear_error() {
        // On a real machine uv is on the PATH; to stay independent of it, the
        // error path of "uv not found" cannot be covered with a fake binary
        // — here it is verified directly: the behaviour with an empty
        // directory and uv present is covered by the integration test, and
        // this test only locks the error message of "no uv" and that
        // find_on_path does not panic.
        let dir = std::env::temp_dir().join(format!("bnote-uv-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if find_on_path("uv").is_none() {
            let err = create_uv_env(&dir).await.unwrap_err();
            assert!(err.contains("uv 未安装"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
