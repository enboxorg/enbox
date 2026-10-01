#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building packages..."
cd "$ROOT_DIR"
bun run build

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
  script="test:browser"
  if [ "$browser" = "chromium" ]; then
    script="test:browser:coverage"
  fi

  echo "==> Running browser tests for $browser ($script)..."
  export BROWSER="$browser"
  export CI=true
  max_attempts=1
  if [ "$browser" = "firefox" ]; then
    max_attempts=2
  fi

  for pkg in "${browser_packages[@]}"; do
    echo "   -> $pkg"
    cd "$ROOT_DIR"
    attempt=1
    while ! bun run --filter "$pkg" "$script"; do
      if [ "$attempt" -ge "$max_attempts" ]; then
        exit 1
      fi
      echo "      Firefox test invocation failed; retrying $pkg once..."
      attempt=$((attempt + 1))
    done
  done
done
