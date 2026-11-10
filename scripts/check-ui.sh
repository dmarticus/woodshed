#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .woodshed
bun scripts/native-preview-fixture.ts --draft --ui --quiet > .woodshed/native-draft-ui.json
bun scripts/native-preview-fixture.ts --question > .woodshed/native-question.json
bun scripts/native-preview-fixture.ts --quiet > .woodshed/native-quiet.json
preview=dist/WoodshedPreview.app/Contents/MacOS/WoodshedPreview
"$preview" .woodshed/native-draft-ui.json main /private/tmp/woodshed-window-draft-dark.png 950 dark
"$preview" .woodshed/native-draft-ui.json bulk /private/tmp/woodshed-window-bulk-light.png 760 light
"$preview" .woodshed/native-draft-ui.json busy /private/tmp/woodshed-window-pending-dark.png 760 dark
"$preview" .woodshed/native-question.json main /private/tmp/woodshed-window-question-wide.png 1200 dark
"$preview" .woodshed/native-quiet.json activity /private/tmp/woodshed-window-runs-light.png 950 light
"$preview" .woodshed/native-question.json settings /private/tmp/woodshed-window-settings-light.png 540 light

bun scripts/native-preview-fixture.ts --waiting > .woodshed/native-waiting.json
bun -e 'const state=await Bun.file(".woodshed/native-waiting.json").json();state.prs=state.prs.filter(p=>[201,204,206,207].includes(p.snapshot.number));await Bun.write(".woodshed/native-waiting-compact.json",JSON.stringify(state));'
"$preview" .woodshed/native-waiting.json main /private/tmp/woodshed-window-waiting-light.png 760 light
"$preview" .woodshed/native-waiting-compact.json sidebar /private/tmp/woodshed-sidebar-status-dark.png 280 dark

bun scripts/native-preview-fixture.ts --approval --quiet > .woodshed/native-approval.json
bun scripts/native-preview-fixture.ts --approval-requested --quiet > .woodshed/native-approval-requested.json
bun scripts/native-preview-fixture.ts --approval-approved --quiet > .woodshed/native-approval-approved.json
"$preview" .woodshed/native-approval.json main /private/tmp/woodshed-approval-available-dark.png 760 dark
"$preview" .woodshed/native-approval-requested.json main /private/tmp/woodshed-approval-requested-light.png 950 light
"$preview" .woodshed/native-approval-approved.json main /private/tmp/woodshed-approval-approved-dark.png 950 dark
