#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DWN_SERVER_PID=""

cleanup() {
  echo ""
  echo "==> Stopping coverage server..."

  if [ -n "$DWN_SERVER_PID" ] && kill -0 "$DWN_SERVER_PID" 2>/dev/null; then
    kill "$DWN_SERVER_PID" 2>/dev/null || true
    wait "$DWN_SERVER_PID" 2>/dev/null || true
  fi

  echo "    Shared test containers remain available for later runs."
}

wait_for_http() {
  local url="$1"
  local service_name="$2"
  local attempts="$3"

  for attempt in $(seq 1 "$attempts"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "    $service_name is ready"
      return 0
    fi

    if [ -n "$DWN_SERVER_PID" ] && ! kill -0 "$DWN_SERVER_PID" 2>/dev/null; then
      echo "    ERROR: $service_name exited unexpectedly."
      return 1
    fi

    sleep 2
  done

  echo "    ERROR: $service_name failed to become ready in time."
  return 1
}

trap cleanup EXIT

echo "==> Starting shared test infrastructure..."
"$ROOT_DIR/scripts/dev.sh" infra

echo "==> Building packages..."
cd "$ROOT_DIR"
bun run build

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
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DID_DHT_ALLOW_PRIVATE_GATEWAY=1

node_packages=(
  "@enbox/common"
  "@enbox/crypto"
  "@enbox/connect"
  "@enbox/auth"
  "@enbox/cli"
  "@enbox/local-node"
  "@enbox/protocols"
  "@enbox/protocol-codegen"
  "@enbox/dwn-sdk-js"
  "@enbox/dwn-sql-store"
  "@enbox/dwn-server"
)

for pkg in "${node_packages[@]}"; do
  echo "==> Running node coverage for $pkg..."
  cd "$ROOT_DIR"
  bun run --filter "$pkg" test:node:coverage
done

echo "==> Starting dwn-server for agent-facing coverage..."
export DS_PORT=3000
export DWN_BASE_URL=http://localhost:3000
export DWN_TTL_CACHE_URL=postgres://dwn_user:dwn_password@localhost:5433/dwn
export DWN_STORAGE_MESSAGES=postgres://dwn_user:dwn_password@localhost:5433/dwn
export DWN_STORAGE_DATA=postgres://dwn_user:dwn_password@localhost:5433/dwn
export DWN_STORAGE_RESUMABLE_TASKS=postgres://dwn_user:dwn_password@localhost:5433/dwn
export DWN_RATE_LIMIT_REQUESTS_PER_SECOND=0
export DWN_RATE_LIMIT_TENANT_REQUESTS_PER_SECOND=0

cd "$ROOT_DIR"
bun packages/dwn-server/dist/esm/src/main.js &
DWN_SERVER_PID=$!

wait_for_http "http://localhost:3000/info" "dwn-server" 30

server_packages=(
  "@enbox/dids"
  "@enbox/dwn-clients"
  "@enbox/agent"
  "@enbox/api"
  "@enbox/browser"
)

for pkg in "${server_packages[@]}"; do
  echo "==> Running node coverage for $pkg..."
  cd "$ROOT_DIR"
  bun run --filter "$pkg" test:node:coverage
done
