#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist/WoodshedPreview.app/Contents/MacOS .woodshed/swift-cache
xcrun swiftc -parse-as-library -swift-version 6 -module-cache-path .woodshed/swift-cache -target arm64-apple-macos14.0 macos/Models.swift macos/NotificationStability.swift macos/InboxModel.swift macos/Views.swift macos/SettingsView.swift macos/PreviewMain.swift -o dist/WoodshedPreview.app/Contents/MacOS/WoodshedPreview
/usr/libexec/PlistBuddy -c 'Clear dict' dist/WoodshedPreview.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Add CFBundleExecutable string WoodshedPreview' dist/WoodshedPreview.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Add CFBundleIdentifier string dev.woodshed.preview' dist/WoodshedPreview.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Add CFBundlePackageType string APPL' dist/WoodshedPreview.app/Contents/Info.plist
codesign --force --sign - dist/WoodshedPreview.app
