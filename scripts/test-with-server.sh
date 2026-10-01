#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# test-with-server.sh
#
# Spins up the shared test services via docker compose,
# starts a local dwn-server, runs the full test suite, then stops the
# server. Shared test containers remain available for later runs.
#
# Usage:
#   ./scripts/test-with-server.sh              # run all tests
#   ./scripts/test-with-server.sh --agent      # run only @enbox/agent tests
#   ./scripts/test-with-server.sh --api        # run only @enbox/api tests
#   ./scripts/test-with-server.sh --filter PKG # run tests for a specific package
# ------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DWN_SERVER_PID=""
PACKAGE_FILTER=""

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  if [ -n "$DWN_SERVER_PID" ] && kill -0 "$DWN_SERVER_PID" 2>/dev/null; then
    echo "    Stopping dwn-server (PID $DWN_SERVER_PID)..."
    kill "$DWN_SERVER_PID" 2>/dev/null || true
    wait "$DWN_SERVER_PID" 2>/dev/null || true
  fi
  echo "    Shared test containers remain available for later runs."
  echo "==> Done."
}

trap cleanup EXIT

# ---- Parse arguments ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)  PACKAGE_FILTER="@enbox/agent"; shift ;;
    --api)    PACKAGE_FILTER="@enbox/api"; shift ;;
    --filter) PACKAGE_FILTER="$2"; shift 2 ;;
    *)        echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---- Step 1: Start databases ----
echo "==> Starting database containers..."
"$ROOT_DIR/scripts/dev.sh" infra

echo "==> Databases and Pkarr relay are ready."

# ---- Step 2: Build ----
echo "==> Building packages..."
cd "$ROOT_DIR"
bun run build

# ---- Step 3: Start dwn-server ----
echo "==> Starting dwn-server..."

# Configure DID DHT to use the local Pkarr relay
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DID_DHT_ALLOW_PRIVATE_GATEWAY=1

export DS_PORT=3000
export DWN_BASE_URL=http://localhost:3000
export DWN_TTL_CACHE_URL="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_MESSAGES="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_DATA="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_RESUMABLE_TASKS="postgres://dwn_user:dwn_password@localhost:5433/dwn"

cd "$ROOT_DIR/packages/dwn-server"
bun dist/esm/src/main.js &
DWN_SERVER_PID=$!
cd "$ROOT_DIR"

echo "    dwn-server PID: $DWN_SERVER_PID"
echo "    Waiting for dwn-server to be ready..."

for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/info >/dev/null 2>&1; then
    echo "    dwn-server is ready!"
    break
  fi
  if ! kill -0 "$DWN_SERVER_PID" 2>/dev/null; then
    echo "    ERROR: dwn-server exited unexpectedly."
    exit 1
  fi
  if [ "$i" -eq 30 ]; then
    echo "    ERROR: dwn-server failed to start within 60 seconds."
    exit 1
  fi
  sleep 2
done

# ---- Step 4: Run tests ----
echo ""
echo "==> Running tests..."

export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=root
export DB_PASSWORD=dwn
export DB_NAME=dwn
export MYSQL_HOST=localhost
export MYSQL_PORT=3306
export MYSQL_USER=root
export MYSQL_PASSWORD=dwn
export MYSQL_DATABASE=dwn
export NATS_URL=nats://localhost:4222
export S3_ENDPOINT=http://localhost:9000

cd "$ROOT_DIR"
# The root test task omits dwn-sql-store because that package exposes `test`
# rather than `test:node`, so include it explicitly for a full run.
if [ -z "$PACKAGE_FILTER" ]; then
  bun run test:node
  bun run --filter @enbox/dwn-sql-store test
  bun run --filter @enbox/agent test:e2e
elif [ "$PACKAGE_FILTER" = "@enbox/dwn-sql-store" ]; then
  bun run --filter "$PACKAGE_FILTER" test
elif [ "$PACKAGE_FILTER" = "@enbox/agent" ]; then
  bun run --filter "$PACKAGE_FILTER" test:node
  bun run --filter "$PACKAGE_FILTER" test:e2e
else
  bun run --filter "$PACKAGE_FILTER" test:node
fi
