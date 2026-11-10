#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec hc run --bg --no-parent --name woodshed --cwd "$PWD" bun src/server.ts
