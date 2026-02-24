# Testing Guide

This document covers the full test infrastructure for the Enbox monorepo.

## Quick Start

```bash
# Start test services
docker compose -f docker-compose.test.yaml up -d --wait
export DID_DHT_GATEWAY_URI=http://localhost:7527

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
| NATS JetStream | `enbox-test-nats` | `localhost:4222` | `dwn-server` (NatsEventLog) |
| MinIO (S3) | `enbox-test-minio` | `localhost:9000` | `dwn-sql-store` (S3 data store) |

### Environment Variables

```bash
# REQUIRED for did:dht tests (~115 agent, ~23 api, ~1 dids tests need this)
export DID_DHT_GATEWAY_URI=http://localhost:7527

# REQUIRED for dwn-server NatsEventLog tests
export NATS_URL=nats://localhost:4222
```

Without `DID_DHT_GATEWAY_URI`, tests will fail with `DidError: internalError: Failed to put Pkarr record`. These are not real failures -- the tests are correct, they just need the gateway.

### DWN Server (localhost:3000)

A local DWN server is required for `agent` and `api` tests. Check if it's running:

```bash
curl -sf http://localhost:3000/info && echo "DWN server is running"
```

If not running, start it:

```bash
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DS_PORT=3000
export DWN_BASE_URL=http://localhost:3000
export DWN_TTL_CACHE_URL="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_MESSAGES="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_DATA="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_STATE_INDEX="postgres://dwn_user:dwn_password@localhost:5433/dwn"
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

Browser test failures block merging. Browser coverage is collected per-browser and reported on pull requests (informational -- no threshold enforced). Node coverage enforces a **98% line threshold**.

## Coverage

Run coverage for any package:

```bash
# Node coverage
bun run --filter @enbox/agent test:node:coverage

# Browser coverage
BROWSER=chromium bun run --filter @enbox/dwn-sdk-js test:browser:coverage
```

CI coverage thresholds:

| Package | CI Coverage |
|---|---|
| `@enbox/agent` | 90.3% |
| `@enbox/api` | 99.8% |
| `@enbox/common` | 95.7% |
| `@enbox/crypto` | 98.6% |
| `@enbox/dids` | 99.2% |
| `@enbox/dwn-sdk-js` | 98.9% |
| `@enbox/dwn-server` | 97.3% |
| `@enbox/dwn-sql-store` | 96.9% |
