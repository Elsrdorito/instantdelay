#!/usr/bin/env sh
# InstantDelay launcher for macOS / Linux. Needs Node.js 18+ (https://nodejs.org or `brew install node`).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from https://nodejs.org (or: brew install node) and run start.sh again."
  exit 1
fi
[ -f config.json ] || node src/setup.js
exec node src/server.js
