#!/usr/bin/env bash
set -euo pipefail

if bun install --frozen-lockfile; then
  exit 0
fi

echo "::warning::Bun install failed; clearing the package cache and retrying once"
bun pm cache rm || true
bun install --frozen-lockfile
