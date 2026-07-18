#!/bin/bash
# Wrapper so launchd (which doesn't source your shell profile / nvm) can find node.
# If you upgrade node via nvm later, update NODE_BIN below to match.
set -euo pipefail

NODE_BIN="/Users/brandon/.nvm/versions/node/v24.15.0/bin/node"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"
exec "$NODE_BIN" scrape-collectr.js
