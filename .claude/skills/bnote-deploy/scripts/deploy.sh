#!/usr/bin/env bash
# bnote-deploy: typecheck → tauri build → stop every running instance (verified) →
# replace /Applications/bnote.app → sign (stable identity) → relaunch → verify.
set -euo pipefail

APP_ID="com.bnote.app"
APP_DST="/Applications/bnote.app"
APP_BIN="$APP_DST/Contents/MacOS/bnote"
# Local code signing identity (created by scripts/setup-dev-signing.sh). Signing is
# mandatory: without it the app's designated requirement is the cdhash, so every
# rebuild invalidates the macOS accessibility grant - that is where the
# "granted, then asked again" loop comes from.
SIGN_KC="$HOME/Library/Keychains/bnote-dev.keychain-db"
SIGN_ID="bnote-dev"
SIGN_PASS="${BNOTE_SIGN_PASSWORD:-bnote-dev-sign}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
BUNDLE_SRC="$ROOT/src-tauri/target/release/bundle/macos/bnote.app"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"

# bnote instances that may be running at the same time: the /Applications bundle,
# a locally built bundle, the pnpm tauri dev debug binary, a release binary run
# directly. Identify them only by executable path (ps comm), never by command
# line: the repo path itself contains "bnote", so pgrep -f would also kill the
# editor's language server.
# awk instead of a shell while loop: under pipefail the loop would carry the
# "no match on the last round" failure status out, and the failed command
# substitution would abort the script silently under set -e.
instance_pids() {
  ps -Ao pid=,comm= | awk -v root="$ROOT" '
    { pid = $1; sub(/^[^[:space:]]+[[:space:]]+/, "", $0)
      if ($0 ~ /\/bnote\.app\/Contents\/MacOS\/bnote$/) print pid
      else if ($0 == root "/src-tauri/target/debug/bnote" ||
               $0 == root "/src-tauri/target/release/bnote") print pid }'
}

# Only the processes of the freshly replaced bundle (used for launch verification).
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
  echo "2. [build]       pnpm tauri build [--bundles app；--build-only 时打全量含 DMG]"
  echo "3. [stop]        关闭所有实例（/Applications 包 + 本地 dev/release 二进制）:"
  echo "                 osascript quit → SIGTERM → SIGKILL，并验证进程真的消失"
  echo "4. [replace]     rm -rf $APP_DST && ditto $BUNDLE_SRC $APP_DST"
  echo "5. [sign]        codesign -s ${SIGN_ID}（稳定身份；不签则辅助功能授权每次重建都作废）"
  echo "6. [launch]      open ${APP_DST}，等新包进程出现并用 ps 校验"
  echo "root=$ROOT"
  echo
  echo "当前检测到的实例: $(instance_pids | tr '\n' ' ')"
  exit 0
fi

echo "==> 1/6 类型检查"
if [ "$SKIP_TYPECHECK" = 0 ]; then
  pnpm exec tsc --noEmit
else
  echo "    (跳过)"
fi

echo "==> 2/6 构建 (tauri build)"
# Deployment only needs the .app: the DMG is laid out by create-dmg through a
# Finder AppleScript, takes about half a minute and fails occasionally (leaving
# a mounted volume) - replacing the running instance does not need it, only
# --build-only builds it.
# The cargo release rebuild (asset embedding, also triggered by front-end
# changes) is the real time sink and cannot be skipped.
if [ "$BUILD_ONLY" = 1 ]; then
  BUILD_ARGS=()
else
  BUILD_ARGS=(--bundles app)
fi
# The .app is the deployment artifact; if the build did not finish cleanly but the
# .app is newer than the marker (a fallback for a previous DMG failure, almost
# never reached with --bundles app), continue as long as it was produced by this
# round.
marker="$(mktemp -t bnote-build)"
# Under bash 3.2 + set -u expanding an empty array ("${[@]}") raises
# unbound variable; guard it with ${[@]+...}
if pnpm tauri build ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} >/tmp/bnote-build.log 2>&1; then
  tail -4 /tmp/bnote-build.log
elif [ -d "$BUNDLE_SRC" ] && [ -n "$(find "$BUNDLE_SRC" -newer "$marker" -print -quit)" ]; then
  echo "    ⚠ 构建未正常结束，但 .app 已重新产出，继续部署"
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

echo "==> 3/6 关闭正在运行的实例"
# Ask nicely first: an AppleScript quit lets autosave flush to disk, then SIGTERM
# / SIGKILL as the fallback, and every step confirms the process is really gone.
# Local instances (the dev binary, a locally built bundle) register no bundle id,
# so AppleScript cannot find them and only signals reach them - they can run at
# the same time as the /Applications copy, and leaving them open means "the new
# bundle is in place, the screen still shows the old window".
# At most 10s (20 x 0.5s)
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
  # shellcheck disable=SC2086 - pids must be split on whitespace into several arguments
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

echo "==> 4/6 替换 $APP_DST"
rm -rf "$APP_DST"
[ -e "$APP_DST" ] && { echo "错误: 旧包未能删除（${APP_DST}）"; exit 1; }
ditto "$BUNDLE_SRC" "$APP_DST"
[ -x "$APP_BIN" ] || { echo "错误: 替换后未找到可执行文件 $APP_BIN"; exit 1; }

echo "==> 5/6 签名（稳定代码身份）"
# Without a stable identity the TCC grant is invalidated on every rebuild. Fail
# here rather than silently deploying a bundle that "has no permissions again"
# on the next launch.
if [ ! -f "$SIGN_KC" ]; then
  echo "错误: 找不到签名身份 $SIGN_KC"
  echo "      先跑: scripts/setup-dev-signing.sh（只需一次）"
  exit 1
fi
security unlock-keychain -p "$SIGN_PASS" "$SIGN_KC"
codesign --force --sign "$SIGN_ID" --identifier "$APP_ID" --timestamp=none "$APP_DST"
codesign --verify --strict "$APP_DST"
DR="$(codesign -d -r- "$APP_DST" 2>&1 | grep 'designated =>' | sed 's/^[[:space:]]*//')"
case "$DR" in
  *"certificate root"*) echo "    $DR" ;;
  *) echo "错误: 签名没有形成稳定身份（DR 不是证书锚定）: $DR"; exit 1 ;;
esac
echo "    辅助功能授权从此跨重建有效"

echo "==> 6/6 启动并验证"
open "$APP_DST"
# Wait for the new bundle's own process to appear: the first launch of a new
# bundle runs through system verification and can be slower than open returns.
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
