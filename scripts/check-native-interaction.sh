#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .woodshed/InteractionSmoke.app/Contents/MacOS .woodshed/swift-cache
bun scripts/native-preview-fixture.ts --draft > .woodshed/native-interaction.json
xcrun swiftc -parse-as-library -swift-version 6 -module-cache-path .woodshed/swift-cache -target arm64-apple-macos14.0 macos/Models.swift macos/InboxModel.swift macos/Views.swift macos/SettingsView.swift macos/ApplicationDelegate.swift scripts/smoke-native-interaction.swift -o .woodshed/InteractionSmoke.app/Contents/MacOS/InteractionSmoke
cat > .woodshed/InteractionSmoke.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>InteractionSmoke</string><key>CFBundleIdentifier</key><string>dev.woodshed.interaction-smoke</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
PLIST
codesign --force --sign - .woodshed/InteractionSmoke.app
if SWIFT_BACKTRACE=enable=yes,interactive=no .woodshed/InteractionSmoke.app/Contents/MacOS/InteractionSmoke .woodshed/native-interaction.json; then
  exit 0
else
  status=$?
  sleep 2
  for report in "$HOME"/Library/Logs/DiagnosticReports/InteractionSmoke*.ips; do
    if [ -f "$report" ]; then cat "$report"; fi
  done
  if [ "${CI:-}" = "true" ]; then
    /usr/bin/log show --last 2m --predicate 'process == "InteractionSmoke"' --style compact | tail -80 || true
    xcrun lldb --batch -o run -k 'thread backtrace all' -- .woodshed/InteractionSmoke.app/Contents/MacOS/InteractionSmoke .woodshed/native-interaction.json || true
  fi
  exit "$status"
fi
