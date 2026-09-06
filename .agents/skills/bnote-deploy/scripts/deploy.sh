#!/usr/bin/env bash
# bnote-deploy: typecheck → tauri build → quit running instances →
# replace /Applications/bnote.app → relaunch → verify.
set -euo pipefail

APP_ID="com.bnote.app"
APP_DST="/Applications/bnote.app"
PROC_PATTERN="bnote\.app/Contents/MacOS/bnote"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
BUNDLE_SRC="$ROOT/src-tauri/target/release/bundle/macos/bnote.app"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"

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
  echo "3. [quit]        osascript quit by $APP_ID + pkill '$PROC_PATTERN'"
  echo "4. [replace]     rm -rf $APP_DST && ditto $BUNDLE_SRC $APP_DST"
  echo "5. [launch]      open $APP_DST && pgrep 验证"
  echo "root=$ROOT"
  exit 0
fi

echo "==> 1/5 类型检查"
if [ "$SKIP_TYPECHECK" = 0 ]; then
  pnpm exec tsc --noEmit
else
  echo "    (跳过)"
fi

echo "==> 2/5 构建 (tauri build)"
pnpm tauri build >/tmp/bnote-build.log 2>&1 || { tail -30 /tmp/bnote-build.log; exit 1; }
tail -4 /tmp/bnote-build.log
[ -d "$BUNDLE_SRC" ] || { echo "错误: 未找到构建产物 $BUNDLE_SRC"; exit 1; }

if [ "$BUILD_ONLY" = 1 ]; then
  echo "==> 完成（仅构建）。产物:"
  echo "    app: $BUNDLE_SRC"
  echo "    dmg: $(ls -t "$DMG_DIR"/*.dmg 2>/dev/null | head -1 || echo '无')"
  exit 0
fi

echo "==> 3/5 退出正在运行的实例"
osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
sleep 2
pkill -f "$PROC_PATTERN" 2>/dev/null || true
sleep 1

echo "==> 4/5 替换 $APP_DST"
rm -rf "$APP_DST"
ditto "$BUNDLE_SRC" "$APP_DST"

echo "==> 5/5 启动并验证"
open "$APP_DST"
sleep 3
if pgrep -f "$APP_DST/Contents/MacOS" >/dev/null; then
  echo "✓ 新版已在运行: $(pgrep -f "$APP_DST/Contents/MacOS" | tr '\n' ' ')"
  echo "  dmg: $(ls -t "$DMG_DIR"/*.dmg 2>/dev/null | head -1 || echo '无')"
else
  echo "警告: 进程未检测到，请手动检查 $APP_DST"
  exit 1
fi
