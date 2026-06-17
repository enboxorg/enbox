#!/usr/bin/env bash
# Idempotent environment setup for the eager-send-drain mission.
# Safe to run multiple times per session — each step is a no-op when
# already done.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[init] repo root: $ROOT"

# 1. Install dependencies (idempotent — bun install is fast when up-to-date).
if [ ! -d "node_modules" ] || [ ! -f "bun.lock" ]; then
  echo "[init] bun install"
  bun install
else
  echo "[init] bun install (skipping — node_modules present)"
fi

# 2. Start docker test services (idempotent — compose up -d is a no-op if already up).
echo "[init] starting docker test services"
docker compose -f docker-compose.test.yaml up -d --wait

# 3. Export env vars (these only persist for the current shell, but we set
# them so any command invoked after sourcing init.sh has them).
export DID_DHT_GATEWAY_URI=http://localhost:7527
export NATS_URL=nats://localhost:4222

# 4. Ensure @enbox/dwn-sdk-js is built (needed by @enbox/agent build + tests).
if [ ! -d "packages/dwn-sdk-js/dist/esm" ]; then
  echo "[init] building @enbox/dwn-sdk-js (first time)"
  bun run --filter @enbox/dwn-sdk-js build
else
  echo "[init] @enbox/dwn-sdk-js build artifacts present — skipping build"
fi

# 5. Ensure DWN server is running on :3000.
if curl -sf http://localhost:3000/info > /dev/null 2>&1; then
  echo "[init] DWN server already running on :3000"
else
  echo "[init] starting DWN server on :3000"
  # Build dwn-server if needed.
  if [ ! -f "packages/dwn-server/dist/esm/src/main.js" ]; then
    echo "[init] building @enbox/dwn-server"
    bun run --filter @enbox/dwn-server build
  fi

  export DS_PORT=3000
  export DWN_BASE_URL=http://localhost:3000
  export DWN_TTL_CACHE_URL="postgres://dwn_user:dwn_password@localhost:5433/dwn"
  export DWN_STORAGE_MESSAGES="postgres://dwn_user:dwn_password@localhost:5433/dwn"
  export DWN_STORAGE_DATA="postgres://dwn_user:dwn_password@localhost:5433/dwn"
  export DWN_STORAGE_RESUMABLE_TASKS="postgres://dwn_user:dwn_password@localhost:5433/dwn"

  nohup bun packages/dwn-server/dist/esm/src/main.js > /tmp/dwn-server.log 2>&1 &
  DWN_PID=$!
  echo "[init] DWN server spawned (pid=$DWN_PID, log=/tmp/dwn-server.log)"

  # Wait up to 30s for /info to be reachable.
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3000/info > /dev/null 2>&1; then
      echo "[init] DWN server healthy after ${i}s"
      break
    fi
    sleep 1
  done

  if ! curl -sf http://localhost:3000/info > /dev/null 2>&1; then
    echo "[init] ERROR: DWN server did not become healthy within 30s — see /tmp/dwn-server.log"
    tail -20 /tmp/dwn-server.log || true
    exit 1
  fi
fi

echo "[init] environment ready"
