#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$ROOT_DIR/packages/dwn-sdk-js/dist" ]; then
  echo "==> Building packages (no dist found)..."
  cd "$ROOT_DIR"
  bun run build
fi

browsers=(chromium firefox webkit)
browser_packages=(
  "@enbox/common"
  "@enbox/crypto"
  "@enbox/dids"
  "@enbox/dwn-sdk-js"
  "@enbox/agent"
  "@enbox/api"
  "@enbox/browser"
)

for browser in "${browsers[@]}"; do
  echo "==> Running browser coverage for $browser..."
  export BROWSER="$browser"
  export CI=true

  for pkg in "${browser_packages[@]}"; do
    echo "   -> $pkg"
    cd "$ROOT_DIR"
    bun run --filter "$pkg" test:browser:coverage
  done
done
