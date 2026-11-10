#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
app="${WOODSHED_APP_OUTPUT:-dist/Woodshed.app}"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" .woodshed/swift-cache
xcrun swiftc -parse-as-library -swift-version 6 -module-cache-path .woodshed/swift-cache -target arm64-apple-macos14.0 macos/Models.swift macos/NotificationStability.swift macos/InboxModel.swift macos/Views.swift macos/SettingsView.swift macos/ApplicationDelegate.swift macos/Woodshed.swift -o "$app/Contents/MacOS/Woodshed"
xcrun swift -module-cache-path .woodshed/swift-cache scripts/generate-app-icon.swift .woodshed/Woodshed.iconset macos/Resources/Woodshed.png
iconutil -c icns .woodshed/Woodshed.iconset -o "$app/Contents/Resources/Woodshed.icns"
cp macos/Info.plist "$app/Contents/Info.plist"
if [ -n "${WOODSHED_VERSION:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $WOODSHED_VERSION" "$app/Contents/Info.plist"
fi
if [ -n "${WOODSHED_BUILD:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $WOODSHED_BUILD" "$app/Contents/Info.plist"
fi
codesign --force --sign - "$app"
codesign --verify --strict "$app"
printf 'Built %s\n' "$app"
