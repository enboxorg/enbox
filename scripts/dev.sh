#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# dev.sh — one command to bring up the local Enbox dev environment.
#
# What it does, idempotently:
#   1. Ensures the did:dht gateway (Pkarr relay) is reachable. The
#      gateway is treated as EXTERNAL infrastructure — it is started
#      from docker-compose.test.yaml if down, but never rebuilt.
#   2. Runs the DWN server on :3000 straight from TypeScript source
#      under `bun --watch`, so edits to packages/dwn-server reload
#      live with no build step. Storage is ephemeral LevelDB + an
#      in-memory SQLite TTL cache, so no database container is needed.
#   3. Writes a git-ignored .env.test so `bun test` picks up the
#      did:dht gateway + TEST_DWN_URL defaults with zero exports.
#
# Subcommands:
#   up        (default)  ensure everything is up, then tail server logs
#   ensure               idempotent start, return immediately (for agents/CI)
#   down [--all]         stop the dev DWN server (--all also stops containers)
#   restart              down + ensure
#   status               show gateway / server / container state
#   infra [down]         bring up (or stop) the FULL docker-compose stack
#                        (Postgres x2, MySQL, NATS, MinIO) for DB-backed suites
#   env                  print `export` lines for `eval "$(scripts/dev.sh env)"`
#   logs                 tail the dev DWN server log
#
# Flags (for up/ensure):
#   --no-infra           do not touch docker; assume the gateway is already up
#   --port N             run the DWN server on port N (default 3000)
# ------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.test.yaml"
SERVER_DIR="$ROOT_DIR/packages/dwn-server"

DEV_DIR="$ROOT_DIR/.dev"
PIDFILE="$DEV_DIR/dwn-server.pid"
LOGFILE="$DEV_DIR/dwn-server.log"
DATA_DIR="$DEV_DIR/dwn-data"
ENV_FILE="$ROOT_DIR/.env.test"

DWN_PORT="${DS_PORT:-3000}"
GATEWAY_URI="${DID_DHT_GATEWAY_URI:-http://localhost:7527}"
MANAGE_INFRA=1

# ---- pretty output -------------------------------------------------
c_reset=$'\033[0m'; c_blue=$'\033[34m'; c_green=$'\033[32m'
c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'
say()  { printf '%s==>%s %s\n' "$c_blue"  "$c_reset" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$c_green" "$c_reset" "$*"; }
warn() { printf '%s  ‼%s %s\n' "$c_yellow" "$c_reset" "$*"; }
err()  { printf '%s  ✗%s %s\n' "$c_red"   "$c_reset" "$*" >&2; }
hint() { printf '%s    %s%s\n' "$c_dim" "$*" "$c_reset"; }

dwn_url() { echo "http://localhost:$DWN_PORT"; }

# ---- reachability checks ------------------------------------------
server_up() { curl -fsS -m 2 "$(dwn_url)/info" >/dev/null 2>&1; }

gateway_up() {
  # The relay answers (often with a non-2xx) on its root path; any HTTP
  # response means it is reachable. curl without -f exits 0 on a 404.
  curl -s -m 2 -o /dev/null "$GATEWAY_URI" 2>/dev/null
}

have() { command -v "$1" >/dev/null 2>&1; }

# The compose services use fixed `container_name:` values, so the stack behaves
# like a host-wide singleton regardless of which directory (or worktree) first
# ran `up`. We therefore drive docker by container NAME, not by compose project,
# and only fall back to `compose up` to create containers that don't exist yet.
# A stable project name keeps any containers WE create self-consistent.
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-enbox-dev}"
dc() { docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"; }

container_running() { docker ps    --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
container_exists()  { docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }

# Bring a single service up by name: start an existing (stopped) container, or
# create it via compose if it has never existed. Avoids name-conflict errors
# when the stack was first created from a different directory/project.
start_service() {
  local cname="$1" svc="$2"
  if container_running "$cname"; then return 0; fi
  if container_exists "$cname"; then
    docker start "$cname" >/dev/null 2>&1 && return 0
  fi
  dc up -d "$svc" >/dev/null 2>&1 || true
}

# ---- gateway (did:dht) — external; ensure reachable only ----------
ensure_gateway() {
  if gateway_up; then
    ok "did:dht gateway reachable at $GATEWAY_URI"
    return 0
  fi
  if [ "$MANAGE_INFRA" -eq 0 ]; then
    warn "did:dht gateway not reachable at $GATEWAY_URI (--no-infra: not starting it)"
    return 0
  fi
  if ! have docker; then
    warn "did:dht gateway not reachable and docker is not installed."
    hint "Start a Pkarr relay on $GATEWAY_URI yourself, or install docker."
    return 0
  fi
  say "Starting did:dht gateway (Pkarr relay) container…"
  start_service enbox-test-pkarr pkarr-relay
  for _ in $(seq 1 15); do gateway_up && break; sleep 1; done
  if gateway_up; then
    ok "did:dht gateway reachable at $GATEWAY_URI"
  else
    warn "did:dht gateway still not reachable at $GATEWAY_URI — agent/api/dids tests will fail."
    hint "Inspect with: docker logs enbox-test-pkarr"
  fi
}

# ---- .env.test (auto-loaded by `bun test`) ------------------------
# Bun reads .env.test from the CWD only — it does NOT walk up to the repo root —
# and `turbo run test:node` runs each suite in its own package directory. So the
# file is written into every package whose tests need these vars (plus the repo
# root for ad-hoc `bun test` runs from there). All are git-ignored.
ENV_TARGET_DIRS=". packages/dids packages/agent packages/api packages/dwn-clients packages/dwn-server"
write_env_file() {
  local body
  body="# Generated by scripts/dev.sh — git-ignored, do NOT commit.
# Auto-loaded by \`bun test\`, so the local suite needs no manual exports.
DID_DHT_GATEWAY_URI=$GATEWAY_URI
DID_DHT_ALLOW_PRIVATE_GATEWAY=1
TEST_DWN_URL=$(dwn_url)
NATS_URL=nats://localhost:4222"
  local count=0
  for d in $ENV_TARGET_DIRS; do
    if [ -d "$ROOT_DIR/$d" ]; then
      printf '%s\n' "$body" >"$ROOT_DIR/$d/.env.test"
      count=$((count + 1))
    fi
  done
  ok "Wrote .env.test to $count locations (auto-loaded by bun test; no manual exports needed)"
}

# ---- DWN server (from source, live-reload) ------------------------
# Live-reload covers dwn-server's OWN source. Its workspace dependencies
# (@enbox/dwn-sdk-js, dwn-clients, dwn-sql-store, …) are imported from their
# built dist/, so they must be compiled once. Turbo caches this, so it is a
# no-op after the first build (and whenever you edit a dependency: rebuild it).
ensure_deps_built() {
  if [ -d "$ROOT_DIR/packages/dwn-sdk-js/dist" ] \
    && [ -d "$ROOT_DIR/packages/dwn-clients/dist" ] \
    && [ -d "$ROOT_DIR/packages/dwn-sql-store/dist" ]; then
    return 0
  fi
  say "Building dwn-server workspace dependencies (one-time; cached by Turbo)…"
  ( cd "$ROOT_DIR" && bunx turbo run build --filter=@enbox/dwn-server ) \
    || { err "Failed to build workspace dependencies."; exit 1; }
  ok "Workspace dependencies built."
}

start_server() {
  if server_up; then
    ok "DWN server already running at $(dwn_url)"
    return 0
  fi
  if ! have bun; then
    err "bun is not installed — cannot start the DWN server."
    exit 1
  fi
  ensure_deps_built
  mkdir -p "$DEV_DIR" "$DATA_DIR"

  say "Starting DWN server from source on $(dwn_url) (bun --watch, LevelDB, no build)…"
  (
    cd "$SERVER_DIR"
    DS_PORT="$DWN_PORT" \
    DS_HOST=127.0.0.1 \
    DWN_BASE_URL="$(dwn_url)" \
    DWN_STORAGE_MESSAGES="level://$DATA_DIR" \
    DWN_STORAGE_DATA="level://$DATA_DIR" \
    DWN_STORAGE_RESUMABLE_TASKS="level://$DATA_DIR" \
    DWN_TTL_CACHE_URL="sqlite://" \
    DWN_ALLOW_OPEN_TENANTS=true \
    DWN_ALLOW_UNBOUNDED_TENANT_USAGE=true \
    DWN_SERVER_PACKAGE_JSON="$SERVER_DIR/package.json" \
    DID_DHT_GATEWAY_URI="$GATEWAY_URI" \
    DID_DHT_ALLOW_PRIVATE_GATEWAY=1 \
    DWN_SERVER_LOG_LEVEL="${DWN_SERVER_LOG_LEVEL:-INFO}" \
      nohup bun --watch src/main.ts >"$LOGFILE" 2>&1 &
    echo $! >"$PIDFILE"
  )

  for i in $(seq 1 30); do
    if server_up; then
      ok "DWN server ready at $(dwn_url) (pid $(cat "$PIDFILE" 2>/dev/null), live-reload on)"
      hint "Logs: $LOGFILE   (or: scripts/dev.sh logs)"
      return 0
    fi
    if [ -f "$PIDFILE" ] && ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      err "DWN server exited during startup. Last lines:"
      tail -n 20 "$LOGFILE" >&2 || true
      exit 1
    fi
    sleep 1
  done
  err "DWN server did not become ready within 30s. Last lines:"
  tail -n 20 "$LOGFILE" >&2 || true
  exit 1
}

stop_server() {
  local stopped=0
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      say "Stopping DWN server (pid $pid)…"
      pkill -P "$pid" 2>/dev/null || true   # the bun --watch child
      kill "$pid" 2>/dev/null || true       # SIGTERM -> graceful shutdown
      for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
      kill -9 "$pid" 2>/dev/null || true
      stopped=1
    fi
    rm -f "$PIDFILE"
  fi
  # Fallback: reclaim the port if something we own is still bound to it.
  if server_up && have lsof; then
    local port_pids; port_pids="$(lsof -ti "tcp:$DWN_PORT" 2>/dev/null || true)"
    if [ -n "$port_pids" ]; then
      warn "Reclaiming port $DWN_PORT from pid(s): $port_pids"
      # shellcheck disable=SC2086
      kill $port_pids 2>/dev/null || true
      stopped=1
    fi
  fi
  if [ "$stopped" -eq 1 ]; then ok "DWN server stopped"; else hint "No dev DWN server was running."; fi
}

# ---- full infra (DB-backed suites) --------------------------------
INFRA_CONTAINERS="enbox-test-postgres enbox-test-postgres-sdk enbox-test-mysql enbox-test-nats enbox-test-minio enbox-test-pkarr"
infra() {
  if ! have docker; then err "docker is not installed."; exit 1; fi
  if [ "${1:-up}" = "down" ]; then
    say "Stopping the docker-compose stack (by container name)…"
    for c in $INFRA_CONTAINERS; do container_running "$c" && docker stop "$c" >/dev/null 2>&1 && hint "stopped $c"; done
    ok "Containers stopped."
  else
    say "Starting the full docker-compose stack (Postgres x2, MySQL, NATS, MinIO, Pkarr)…"
    # Reuse already-created containers (any project); compose-create the rest.
    if container_exists enbox-test-postgres; then
      start_service enbox-test-postgres    postgres
      start_service enbox-test-postgres-sdk postgres-sdk
      start_service enbox-test-mysql        mysql
      start_service enbox-test-nats         nats
      start_service enbox-test-minio        minio
      start_service enbox-test-pkarr        pkarr-relay
    else
      dc up -d --wait
    fi
    ok "Containers up."
    hint "Needed for @enbox/dwn-sql-store and @enbox/dwn-server DB tests."
  fi
}

# ---- status / env / logs ------------------------------------------
status() {
  say "Dev environment status"
  if gateway_up; then ok "did:dht gateway: up   ($GATEWAY_URI)"; else err "did:dht gateway: DOWN ($GATEWAY_URI)"; fi
  if server_up; then
    ok "DWN server:     up   ($(dwn_url))   $(curl -fsS -m 2 "$(dwn_url)/info" 2>/dev/null)"
  else
    err "DWN server:     DOWN ($(dwn_url))"
    hint "Start it with: bun run dev   (or scripts/dev.sh ensure)"
  fi
  [ -f "$ENV_FILE" ] && ok ".env.test:      present ($ENV_FILE)" || warn ".env.test:      missing — run scripts/dev.sh ensure"
  if have docker; then
    printf '%s    containers:%s\n' "$c_dim" "$c_reset"
    # Driven by container name so it works from any worktree/compose project.
    docker ps --filter "name=enbox-test-" --format '      {{.Names}}\t{{.Status}}' 2>/dev/null || true
  fi
}

print_env() {
  echo "export DID_DHT_GATEWAY_URI=$GATEWAY_URI"
  echo "export DID_DHT_ALLOW_PRIVATE_GATEWAY=1"
  echo "export TEST_DWN_URL=$(dwn_url)"
  echo "export NATS_URL=nats://localhost:4222"
}

logs() {
  [ -f "$LOGFILE" ] || { err "No log file at $LOGFILE — is the dev server running?"; exit 1; }
  tail -n 50 -f "$LOGFILE"
}

# ---- argument parsing ---------------------------------------------
CMD="up"
case "${1:-}" in
  up|ensure|down|restart|status|infra|env|logs) CMD="$1"; shift ;;
  -*|"") : ;;                       # no subcommand -> default `up`, keep flags
  *) err "Unknown subcommand: $1"; exit 1 ;;
esac

INFRA_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-infra) MANAGE_INFRA=0; shift ;;
    --port) DWN_PORT="$2"; shift 2 ;;
    --all) INFRA_ARG="all"; shift ;;
    down) INFRA_ARG="down"; shift ;;       # `infra down`
    *) err "Unknown flag: $1"; exit 1 ;;
  esac
done

case "$CMD" in
  up)
    ensure_gateway
    write_env_file
    start_server
    echo
    if [ -f "$LOGFILE" ]; then
      say "Dev environment is up. Streaming DWN server logs (Ctrl-C detaches; server keeps running)."
      hint "Stop the server with: scripts/dev.sh down"
      echo
      tail -n 20 -f "$LOGFILE"
    else
      say "Dev environment is up (DWN server was started outside this script; no log file to tail)."
      hint "Stop it with: scripts/dev.sh down"
    fi
    ;;
  ensure)
    ensure_gateway
    write_env_file
    start_server
    say "Ready. Run tests with: bun run test:node"
    ;;
  down)
    stop_server
    [ "$INFRA_ARG" = "all" ] && infra down || true
    ;;
  restart)
    stop_server
    ensure_gateway
    write_env_file
    start_server
    ;;
  status) status ;;
  infra)  infra "${INFRA_ARG:-up}" ;;
  env)    print_env ;;
  logs)   logs ;;
esac
