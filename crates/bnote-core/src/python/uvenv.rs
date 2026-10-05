//! uv 环境创建:项目没有 pyproject.toml 就先 `uv init --bare`(只生成
//! pyproject.toml,不塞示例文件),然后 `uv sync`(生成 uv.lock + .venv)。
//! 完整日志返回给前端,显示在运行面板里。

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

/// 跑一条 uv 命令,把「命令行 + stdout + stderr + 退出码」拼成日志,
/// 尾部标 OK(退出码 0)或 FAIL,调用方据此判断成败。
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
        // 真机上 uv 在 PATH;为了不依赖它,用一个不存在的 PATH 找不到时的
        // 报错路径覆盖不了 —— 这里直接验证:目录为空 + uv 存在时的行为由
        // 集成验证覆盖,这里只锁「没 uv 时的报错文案」通过 find_on_path
        // 的行为不炸。
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
