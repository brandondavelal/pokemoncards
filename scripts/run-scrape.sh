#!/bin/bash
# Wrapper so launchd (which doesn't source your shell profile / nvm) can find node.
# If you upgrade node via nvm later, update NODE_BIN below to match.
set -euo pipefail

NODE_BIN="/Users/brandon/.nvm/versions/node/v24.20.0/bin/node"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP_FILE="$SCRIPT_DIR/logs/.last-success"
MIN_INTERVAL=21600 # 6h, matches StartInterval in the plist — skip RunAtLoad firings sooner than this

cd "$SCRIPT_DIR"

if [[ -f "$STAMP_FILE" ]]; then
  last=$(stat -f %m "$STAMP_FILE")
  now=$(date +%s)
  elapsed=$((now - last))
  if (( elapsed < MIN_INTERVAL )); then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] skip: last successful run ${elapsed}s ago (< ${MIN_INTERVAL}s)"
    exit 0
  fi
fi

"$NODE_BIN" scrape-collectr.js
touch "$STAMP_FILE"
