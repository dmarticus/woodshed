#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist/Woodshed.app/Contents/MacOS dist/Woodshed.app/Contents/Resources .woodshed/swift-cache
xcrun swiftc -parse-as-library -swift-version 6 -module-cache-path .woodshed/swift-cache -target arm64-apple-macos14.0 macos/Models.swift macos/InboxModel.swift macos/Views.swift macos/SettingsView.swift macos/ApplicationDelegate.swift macos/Woodshed.swift -o dist/Woodshed.app/Contents/MacOS/Woodshed
xcrun swift -module-cache-path .woodshed/swift-cache scripts/generate-app-icon.swift .woodshed/Woodshed.iconset macos/Resources/Woodshed.png
iconutil -c icns .woodshed/Woodshed.iconset -o dist/Woodshed.app/Contents/Resources/Woodshed.icns
cp macos/Info.plist dist/Woodshed.app/Contents/Info.plist
codesign --force --sign - dist/Woodshed.app
printf 'Built %s/dist/Woodshed.app\n' "$PWD"
