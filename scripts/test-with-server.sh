#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# test-with-server.sh
#
# Spins up Postgres, MySQL, and Pkarr relay via docker compose,
# starts a local dwn-server, runs the full test suite, then tears
# everything down.
#
# Usage:
#   ./scripts/test-with-server.sh              # run all tests
#   ./scripts/test-with-server.sh --agent      # run only @enbox/agent tests
#   ./scripts/test-with-server.sh --api        # run only @enbox/api tests
#   ./scripts/test-with-server.sh --filter PKG # run tests for a specific package
# ------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.test.yaml"
DWN_SERVER_PID=""
FILTER=""

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  if [ -n "$DWN_SERVER_PID" ] && kill -0 "$DWN_SERVER_PID" 2>/dev/null; then
    echo "    Stopping dwn-server (PID $DWN_SERVER_PID)..."
    kill "$DWN_SERVER_PID" 2>/dev/null || true
    wait "$DWN_SERVER_PID" 2>/dev/null || true
  fi
  echo "    Stopping docker containers..."
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
  echo "==> Done."
}

trap cleanup EXIT

# ---- Parse arguments ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)  FILTER="--filter @enbox/agent"; shift ;;
    --api)    FILTER="--filter @enbox/api"; shift ;;
    --filter) FILTER="--filter $2"; shift 2 ;;
    *)        echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---- Step 1: Start databases ----
echo "==> Starting database containers..."
docker compose -f "$COMPOSE_FILE" up -d --wait

echo "==> Databases and Pkarr relay are ready."

# ---- Step 2: Build (if needed) ----
if [ ! -d "$ROOT_DIR/packages/dwn-server/dist" ]; then
  echo "==> Building packages (no dist found)..."
  cd "$ROOT_DIR"
  bun run --filter '*' build
fi

# ---- Step 3: Start dwn-server ----
echo "==> Starting dwn-server..."

# Configure DID DHT to use the local Pkarr relay
export DID_DHT_GATEWAY_URI=http://localhost:7527

export DS_PORT=3000
export DWN_BASE_URL=http://localhost:3000
export DWN_TTL_CACHE_URL="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_MESSAGES="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_DATA="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_RESUMABLE_TASKS="postgres://dwn_user:dwn_password@localhost:5433/dwn"

cd "$ROOT_DIR/packages/dwn-server"
node dist/esm/src/main.js &
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

cd "$ROOT_DIR"
# When no --filter is specified, run all packages
if [ -z "$FILTER" ]; then
  FILTER="--filter '*'"
fi
# shellcheck disable=SC2086
bun run $FILTER test:node
TEST_EXIT=$?

exit $TEST_EXIT
