# Testing Guide

This document covers the full test infrastructure for the Enbox monorepo.

## Local dev environment (recommended)

One command brings up everything the local test suites need — the did:dht gateway, a live-reload DWN server on `:3000`, and the test env vars — so you don't start services by hand or forget `DID_DHT_*` exports:

```bash
bun run dev          # gateway + live-reload :3000 DWN server, then tail server logs (Ctrl-C detaches)
bun run dev:ensure   # same, but idempotent and returns immediately — use this in agents/CI
bun run dev:status   # show gateway / DWN server / container state
bun run dev:down     # stop the dev DWN server (containers keep running)
```

What `scripts/dev.sh` does, idempotently:

- **did:dht gateway (Pkarr relay)** — ensures it is reachable at `http://localhost:7527`. It is treated as external infrastructure: started from `docker-compose.test.yaml` if down, but never rebuilt.
- **DWN server on `:3000`** — runs straight from TypeScript source under `bun --watch`, so edits to `packages/dwn-server` reload live with **no build step**. Storage is ephemeral LevelDB plus an in-memory SQLite TTL cache, so **no database container is required** (registration is disabled — it is an open dev node). Its workspace dependencies (`dwn-sdk-js`, `dwn-clients`, …) are imported from `dist/`, so they are built once via Turbo on first run; rebuild a dependency yourself after editing it.
- **`.env.test`** — writes a git-ignored `.env.test` into each test package (`dids`, `agent`, `api`, `dwn-clients`, `dwn-server`) and the repo root. `bun test` auto-loads it, so `DID_DHT_GATEWAY_URI`, `DID_DHT_ALLOW_PRIVATE_GATEWAY`, `TEST_DWN_URL`, and `NATS_URL` are set with **zero manual exports**.

```bash
bun run dev:ensure                        # one-time: gateway + :3000 server + .env.test
cd packages/agent && bun run test:node    # just works — no exports needed

# DB-backed suites (dwn-sql-store, dwn-server) also need Postgres/MySQL/NATS/MinIO:
scripts/dev.sh infra                      # bring the full container stack up
scripts/dev.sh infra down                 # stop the container stack
```

End-to-end specs that genuinely require the `:3000` server call a shared `requireDwnServer()` preflight, so if you forget to start the dev environment they fail fast with `DWN server not reachable … run bun run dev:ensure` instead of an opaque timeout.

`eval "$(scripts/dev.sh env)"` prints the same vars as `export` lines if you prefer them in your shell instead of via `.env.test`.

## Quick Start (manual)

```bash
# Start test services
docker compose -f docker-compose.test.yaml up -d --wait
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DID_DHT_ALLOW_PRIVATE_GATEWAY=1

# Run all Node tests
bun run test:node

# Run browser tests (single package, single browser)
BROWSER=chromium bun run --filter @enbox/dwn-sdk-js test:browser
```

## Node Tests

All packages use **bun test** (Bun's native test runner).

| Package | Command (from package dir) |
|---|---|
| `@enbox/common` | `bun run test:node` |
| `@enbox/crypto` | `bun run test:node` |
| `@enbox/dids` | `bun run test:node` |
| `@enbox/dwn-sdk-js` | `bun run test:node` |
| `@enbox/dwn-clients` | `bun run test:node` |
| `@enbox/agent` | `bun run test:node` |
| `@enbox/api` | `bun run test:node` |
| `@enbox/dwn-server` | `bun run test:node` |
| `@enbox/dwn-sql-store` | `bun run test` |

Run all tests from the repo root:

```bash
bun run test:node
```

Run a single test file:

```bash
bun test tests/store-key.spec.ts    # from a package directory
```

Filter by test name (dwn-sdk-js):

```bash
GREP="ProtocolsConfigure" bun run test:node-grep
```

## Test Infrastructure

Several packages require external services for their full test suites. Start everything with Docker Compose:

```bash
docker compose -f docker-compose.test.yaml up -d --wait
```

### Services

| Service | Container | Port | Used by |
|---|---|---|---|
| Pkarr relay | `enbox-test-pkarr` | `localhost:7527` | `dids`, `agent`, `api` (did:dht publishing) |
| PostgreSQL 15 | `enbox-test-postgres` | `localhost:5433` | `dwn-server`, `dwn-sql-store` |
| PostgreSQL 13 | `enbox-test-postgres-sdk` | `localhost:5432` | `dwn-sql-store` (SDK tests) |
| MySQL 8 | `enbox-test-mysql` | `localhost:3306` | `dwn-sql-store` |
| NATS | `enbox-test-nats` | `localhost:4222` | `dwn-server` (NatsEventBus) |
| MinIO (S3) | `enbox-test-minio` | `localhost:9000` | `dwn-sql-store` (S3 data store) |

### Environment Variables

```bash
# REQUIRED for did:dht tests (~115 agent, ~23 api, ~1 dids tests need this)
export DID_DHT_GATEWAY_URI=http://localhost:7527

# REQUIRED when the gateway URI points at the local Docker relay
export DID_DHT_ALLOW_PRIVATE_GATEWAY=1

# REQUIRED for dwn-server NatsEventBus tests
export NATS_URL=nats://localhost:4222
```

Without `DID_DHT_GATEWAY_URI`, tests will fail with `DidError: internalError: Failed to put Pkarr record`. Without `DID_DHT_ALLOW_PRIVATE_GATEWAY=1`, local runs fail because the DID:DHT URL validator correctly rejects loopback/private gateway hosts by default. These are not real failures -- the tests are correct, they just need the local gateway opt-in.

### DWN Server (localhost:3000)

A local DWN server is required for the `agent` and `api` `e2e-*` specs. The simplest way to run one is `bun run dev:ensure` (see [Local dev environment](#local-dev-environment-recommended)) — it runs the server from source with live-reload and ephemeral LevelDB storage. Check if it's running:

```bash
curl -sf http://localhost:3000/info && echo "DWN server is running"
```

To start one by hand against the Postgres container instead (production-parity storage):

```bash
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DID_DHT_ALLOW_PRIVATE_GATEWAY=1
export DS_PORT=3000
export DWN_BASE_URL=http://localhost:3000
export DWN_TTL_CACHE_URL="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_MESSAGES="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_DATA="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_RESUMABLE_TASKS="postgres://dwn_user:dwn_password@localhost:5433/dwn"
bun packages/dwn-server/dist/esm/src/main.js &
```

Alternatively, `./scripts/test-with-server.sh` automates the full cycle (start containers, build, run tests, tear down).

## Browser Tests

Seven packages run browser tests using **Vitest + Playwright** across three engines. The same test files run under both `bun test` and Vitest browser mode via a shared [bun:test shim](../testing/bun-test-shim.ts).

### Running Browser Tests

```bash
# Single package, single browser
BROWSER=chromium bun run --filter @enbox/dwn-sdk-js test:browser

# With coverage
BROWSER=chromium bun run --filter @enbox/dwn-sdk-js test:browser:coverage
```

Playwright must be installed first:

```bash
bunx playwright install --with-deps chromium
```

### Browser Support Matrix

| Package | Chromium | Firefox | WebKit |
|---|:---:|:---:|:---:|
| `@enbox/common` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/crypto` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/dids` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/browser` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/dwn-sdk-js` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/agent` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/api` | :white_check_mark: | :white_check_mark: | :white_check_mark: |

### Browser Build Targets

Production bundles (`dist/browser.mjs`) target:

| Chrome | Firefox | Safari |
|:---:|:---:|:---:|
| 101+ | 108+ | 16+ |

Packages with browser bundles: `api`, `agent`, `common`, `crypto`, `dids`, `dwn-sdk-js`.

### CI Browser Matrix

CI runs a **3x3 matrix** (3 package shards x 3 browsers = 9 parallel jobs):

| Shard | Packages |
|---|---|
| `crypto` | `@enbox/common`, `@enbox/crypto` |
| `dwn-sdk-js` | `@enbox/dwn-sdk-js` |
| `dids-agent-api` | `@enbox/dids`, `@enbox/browser`, `@enbox/agent`, `@enbox/api` |

Browser test failures block merging. Browser coverage is collected per-browser
so the LCOV output can be merged with Node coverage for SonarCloud; CI does not
post a separate browser-coverage PR comment.

## Coverage

Run coverage for any package:

```bash
# Node coverage
bun run --filter @enbox/agent test:node:coverage

# Browser coverage
BROWSER=chromium bun run --filter @enbox/dwn-sdk-js test:browser:coverage
```

The CI pipeline uploads package LCOV artifacts from Node and browser jobs,
merges them with `bun run coverage:merge:reports`, and sends the merged report
to SonarCloud. SonarCloud owns the PR quality gate when repository variables
and `SONAR_TOKEN` are configured. Main-branch pushes also update the README
coverage badges from the latest package LCOV artifacts.

Use SonarCloud for current branch, line, and new-code coverage. The badge
percentages are informational snapshots from `main`, not PR gates.
