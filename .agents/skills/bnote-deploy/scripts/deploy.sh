#!/usr/bin/env bash
# bnote-deploy: typecheck → tauri build → stop every running instance (verified) →
# replace /Applications/bnote.app → relaunch → verify.
set -euo pipefail

APP_ID="com.bnote.app"
APP_DST="/Applications/bnote.app"
APP_BIN="$APP_DST/Contents/MacOS/bnote"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
BUNDLE_SRC="$ROOT/src-tauri/target/release/bundle/macos/bnote.app"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"

# 本机可能同时在跑的 bnote 实例：/Applications 的包、本地构建的包、pnpm tauri dev
# 的 debug 二进制、直接跑的 release 二进制。只按"可执行文件路径"识别（ps 的 comm），
# 不能按命令行匹配——仓库路径里就带 bnote，pgrep -f 会连编辑器的语言服务器一起杀。
# 用 awk 而不是 shell 的 while 循环：pipefail 下后者会把"最后一轮没匹配上"的失败
# 状态带出来，命令替换失败 → set -e 静默中止脚本。
instance_pids() {
  ps -Ao pid=,comm= | awk -v root="$ROOT" '
    { pid = $1; sub(/^[^[:space:]]+[[:space:]]+/, "", $0)
      if ($0 ~ /\/bnote\.app\/Contents\/MacOS\/bnote$/) print pid
      else if ($0 == root "/src-tauri/target/debug/bnote" ||
               $0 == root "/src-tauri/target/release/bnote") print pid }'
}

# 只有替换后的那个包自己的进程（用于启动验证）。
app_bin_pids() {
  ps -Ao pid=,comm= | awk -v app="$APP_BIN" '
    { pid = $1; sub(/^[^[:space:]]+[[:space:]]+/, "", $0); if ($0 == app) print pid }'
}

SKIP_TYPECHECK=0
BUILD_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-typecheck) SKIP_TYPECHECK=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "用法: deploy.sh [--skip-typecheck] [--build-only] [--dry-run]"; exit 1 ;;
  esac
done

cd "$ROOT"

if [ "$DRY_RUN" = 1 ]; then
  echo "== dry run =="
  echo "1. [typecheck]   pnpm exec tsc --noEmit"
  echo "2. [build]       pnpm tauri build"
  echo "3. [stop]        关闭所有实例（/Applications 包 + 本地 dev/release 二进制）:"
  echo "                 osascript quit → SIGTERM → SIGKILL，并验证进程真的消失"
  echo "4. [replace]     rm -rf $APP_DST && ditto $BUNDLE_SRC $APP_DST"
  echo "5. [launch]      open ${APP_DST}，等新包进程出现并用 ps 校验"
  echo "root=$ROOT"
  echo
  echo "当前检测到的实例: $(instance_pids | tr '\n' ' ')"
  exit 0
fi

echo "==> 1/5 类型检查"
if [ "$SKIP_TYPECHECK" = 0 ]; then
  pnpm exec tsc --noEmit
else
  echo "    (跳过)"
fi

echo "==> 2/5 构建 (tauri build)"
# .app 才是部署产物；DMG 那步由 create-dmg 走 Finder AppleScript 排版，会偶发失败
# （还会留下挂载卷），不值得因此拦住部署——只要 .app 是这一轮重新产出的就继续。
marker="$(mktemp -t bnote-build)"
if pnpm tauri build >/tmp/bnote-build.log 2>&1; then
  tail -4 /tmp/bnote-build.log
elif [ -d "$BUNDLE_SRC" ] && [ -n "$(find "$BUNDLE_SRC" -newer "$marker" -print -quit)" ]; then
  echo "    ⚠ 构建未正常结束，但 .app 已重新产出（多半是 DMG 打包那步挂了），继续部署"
  tail -15 /tmp/bnote-build.log | sed 's/^/    | /'
else
  echo "错误: 构建失败且 .app 未重新产出，中止"
  tail -30 /tmp/bnote-build.log
  rm -f "$marker"
  exit 1
fi
rm -f "$marker"
[ -d "$BUNDLE_SRC" ] || { echo "错误: 未找到构建产物 $BUNDLE_SRC"; exit 1; }

if [ "$BUILD_ONLY" = 1 ]; then
  echo "==> 完成（仅构建）。产物:"
  echo "    app: $BUNDLE_SRC"
  echo "    dmg: $(ls -t "$DMG_DIR"/*.dmg 2>/dev/null | head -1 || echo '无')"
  exit 0
fi

echo "==> 3/5 关闭正在运行的实例"
# 先礼后兵：AppleScript 优雅退出让自动保存落盘，再用 SIGTERM / SIGKILL 兜底，每一步
# 都确认进程真的消失。本地实例（dev 二进制、本地构建的包）不注册 bundle id，
# AppleScript 找不到它们，只能靠信号——它们能和 /Applications 的副本同时开着，
# 不关掉就会出现"新包已就位、屏幕上还是旧窗口"。
# 最多等 10s（20 × 0.5s）
wait_gone() {
  for _ in $(seq 1 20); do
    [ -z "$(instance_pids)" ] && return 0
    sleep 0.5
  done
  return 1
}

stop_instances() {
  local pids
  pids="$(instance_pids | tr '\n' ' ')"
  [ -z "${pids// /}" ] && return 0
  echo "    发现实例: $pids"
  osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
  wait_gone && return 0
  echo "    优雅退出超时，发送 SIGTERM"
  # shellcheck disable=SC2086 — pids 需要按空白拆分成多个参数
  kill $pids 2>/dev/null || true
  wait_gone && return 0
  echo "    SIGTERM 无效，强制 SIGKILL"
  kill -9 $pids 2>/dev/null || true
  wait_gone
}

if ! stop_instances; then
  echo "错误: 仍有实例在运行，已中止（避免替换后跑的还是旧进程）:"
  ps -Ao pid=,comm= | grep -i "bnote" | grep -v grep || true
  exit 1
fi
echo "    已无运行中的实例"

echo "==> 4/5 替换 $APP_DST"
rm -rf "$APP_DST"
[ -e "$APP_DST" ] && { echo "错误: 旧包未能删除（${APP_DST}）"; exit 1; }
ditto "$BUNDLE_SRC" "$APP_DST"
[ -x "$APP_BIN" ] || { echo "错误: 替换后未找到可执行文件 $APP_BIN"; exit 1; }

echo "==> 5/5 启动并验证"
open "$APP_DST"
# 等到新包自己的进程出现：新包首次启动要走一遍系统校验，可能慢于 open 返回。
pids=""
for _ in $(seq 1 40); do
  pids="$(app_bin_pids | tr '\n' ' ')"
  if [ -n "${pids// /}" ]; then break; fi
  sleep 0.5
done
if [ -n "${pids// /}" ]; then
  echo "✓ 新版已在运行: $pids"
  echo "  dmg: $(ls -t "$DMG_DIR"/*.dmg 2>/dev/null | head -1 || echo '无')"
else
  echo "警告: 未检测到 $APP_BIN 的进程，请手动检查"
  ps -Ao pid=,comm= | grep -i "bnote" | grep -v grep || true
  exit 1
fi
