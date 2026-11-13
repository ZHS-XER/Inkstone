#!/bin/bash
# Build Inkstone.app for macOS using only the Swift toolchain (no Xcode needed).
#
#   scripts/build-app.sh            → build/Inkstone.app
#   scripts/build-app.sh --install  → also copy it to /Applications
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(cat VERSION 2>/dev/null || echo 0.1.0)"
APP="build/Inkstone.app"

swift build -c release --product Inkstone
BIN="$(swift build -c release --show-bin-path)/Inkstone"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Inkstone"
# the web UI (dev-only files stay behind)
rsync -a --delete --exclude '.DS_Store' web/ "$APP/Contents/Resources/web/"
[ -f assets/AppIcon.icns ] && cp assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Inkstone</string>
    <key>CFBundleDisplayName</key><string>Inkstone</string>
    <key>CFBundleIdentifier</key><string>io.github.zhs-xer.inkstone</string>
    <key>CFBundleExecutable</key><string>Inkstone</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.books</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>NSHumanReadableCopyright</key><string>MIT License</string>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key><string>EPUB</string>
            <key>CFBundleTypeRole</key><string>Viewer</string>
            <key>LSHandlerRank</key><string>Alternate</string>
            <key>LSItemContentTypes</key>
            <array><string>org.idpf.epub-container</string></array>
        </dict>
    </array>
</dict>
</plist>
EOF

codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "warning: ad-hoc signing failed"
echo "Built $APP ($(du -sh "$APP" | cut -f1))"

if [ "${1:-}" = "--install" ]; then
    rm -rf /Applications/Inkstone.app
    cp -R "$APP" /Applications/Inkstone.app
    echo "Installed to /Applications/Inkstone.app"
fi
