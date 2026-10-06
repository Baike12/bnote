#!/bin/sh
# Bundle the release binary into a double-clickable bnote-gpui.app (the GPUI
# shell; the Tauri build stays /Applications/bnote.app).
#
#   cargo +1.95.0 build --release -p bnote-gpui
#   sh scripts/make-app.sh [output-dir]
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
bin="$root/target/release/bnote-gpui"
out="${1:-$root/target/release}"
app="$out/bnote-gpui.app"

if [ ! -x "$bin" ]; then
    echo "先构建:cargo +1.95.0 build --release -p bnote-gpui" >&2
    exit 1
fi

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/bnote-gpui"

# The icon is best-effort: a missing or unreadable png must not fail the build.
# `sips` cannot write a multi-size icns directly, so the sizes go through an
# .iconset and `iconutil` (the standard macOS path).
iconset="$(mktemp -d)/bnote.iconset"
icon_line=""
if [ -f "$root/app-icon.png" ] && mkdir -p "$iconset"; then
    for size in 16 32 128 256 512; do
        sips -z "$size" "$size" "$root/app-icon.png" \
            --out "$iconset/icon_${size}x${size}.png" >/dev/null 2>&1 || true
        sips -z "$((size * 2))" "$((size * 2))" "$root/app-icon.png" \
            --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
    done
    if iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns" >/dev/null 2>&1; then
        icon_line="	<key>CFBundleIconFile</key><string>AppIcon</string>"
    fi
fi

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>bnote</string>
	<key>CFBundleDisplayName</key><string>bnote (gpui)</string>
	<key>CFBundleExecutable</key><string>bnote-gpui</string>
	<key>CFBundleIdentifier</key><string>com.bnote.gpui</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1.0</string>
	<key>CFBundleVersion</key><string>0.1.0</string>
$icon_line
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "$app"
