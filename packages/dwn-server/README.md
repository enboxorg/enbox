# DWN Server

> **Research Preview** — Enbox is under active development. APIs may change without notice.

[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-server.json)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)

A multi-tenant Decentralized Web Node (DWN) exposed via JSON-RPC over HTTP and WebSocket, powered by `Bun.serve()`. It wraps the `@enbox/dwn-sdk-js` engine with:

- **Pluggable storage** — LevelDB, SQLite, MySQL, or PostgreSQL (or a custom plugin).
- **Streaming JSON-RPC** over HTTP and WebSocket, with subscriptions and flow control.
- **Optional tenant registration gates** — proof-of-work, terms-of-service, and provider-auth (OAuth2).
- **An admin API + UI** for tenant management, quotas, audit logs, webhooks, and passkey login.
- **Prometheus metrics**, health/info endpoints, and per-IP / per-tenant rate limiting.
- **Sync helpers** — record delivery and endpoint forwarding to a tenant's other nodes.

## Contents

- [Supported databases](#supported-databases)
- [Installation](#installation)
- [Running the server](#running-the-server)
- [Library usage](#library-usage)
- [Configuration](#configuration)
  - [Core server](#core-server)
  - [Storage](#storage)
  - [Registration & provider-auth](#registration--provider-auth)
  - [Admin API](#admin-api-configuration)
  - [Rate limiting & quotas](#rate-limiting--quotas)
  - [Sync: delivery & forwarding](#sync-delivery--forwarding)
  - [PostgreSQL connection pool](#postgresql-connection-pool)
  - [Event bus](#event-bus)
- [JSON-RPC API](#json-rpc-api)
- [HTTP endpoints](#http-endpoints)
- [Server info](#server-info)
- [Registration requirements](#registration-requirements)
- [Admin API](#admin-api)
- [Hosting your own DWN](#hosting-your-own-dwn)
- [Development](#development)
- [License](#license)

## Supported databases

- LevelDB
- SQLite
- MySQL 8.0+
- PostgreSQL

See [Storage](#storage) for connection-string formats and per-store overrides.

## Installation

```bash
bun add @enbox/dwn-server
```

The package is ESM-only and ships a `dwn-server` binary (the CLI entry point in [`src/main.ts`](./src/main.ts)).

## Running the server

### From source

```bash
git clone https://github.com/enboxorg/enbox.git
cd enbox
bun install
bun run --filter @enbox/dwn-server build
bun run --filter @enbox/dwn-server server
```

`bun run server` builds and then runs `dist/esm/src/main.js`, which starts a `DwnServer` with defaults. Configure it with the environment variables in [Configuration](#configuration). With no configuration, it listens on port `3000` and stores everything in a local LevelDB directory (`level://data`).

### Via Docker

There is no official public image yet, so build one locally. The Dockerfile lives at [`packages/dwn-server/Dockerfile`](./Dockerfile) but copies workspace-root files (`bun.lock`, `packages/`, …), so it **must be built from the repository root** with an explicit `-f`:

```bash
# From the repository root
docker build -f packages/dwn-server/Dockerfile -t dwn-server .

# Run it, persisting data to a named volume
docker run -p 3000:3000 \
  -v dwn-data:/app/packages/dwn-server/data \
  -e DWN_BASE_URL=https://dwn.example.com \
  dwn-server
```

The image exposes `DS_PORT` (default `3000`) and runs the compiled server via `entrypoint.sh`. The build accepts a `DS_PORT` build arg if you need to bake in a different port.

The default `level://data` store is **relative to the server's working directory** (`/app/packages/dwn-server`), so the volume above mounts `/app/packages/dwn-server/data` to persist it. Don't relocate it via `DWN_STORAGE` — that variable also feeds the registration store, which must be SQL, so a LevelDB value there is invalid (see [Storage](#storage) and [Registration requirements](#registration-requirements)). To store data elsewhere, mount the path above, set the per-store overrides (`DWN_STORAGE_MESSAGES` / `DWN_STORAGE_DATA` / `DWN_STORAGE_RESUMABLE_TASKS`), or use a SQL backend.

> No official image is published to a public registry yet (CI builds and pushes only to a private registry). For a remote deploy, build the image as above and push it to a registry your platform can pull from.

For an end-to-end self-hosting walkthrough (TLS, storage, and advertising the node in your DID document), see the [Self-Hosting Guide](../../SELF-HOSTING.md).

## Library usage

`DwnServer` can be embedded directly. The constructor takes an optional [`DwnServerOptions`](./src/dwn-server.ts); `new DwnServer()` with no arguments uses [`defaultDwnServerConfig`](./src/config.ts) (driven by environment variables). Both `start()` and `stop()` are async and should be awaited.

```typescript
import { DwnServer } from '@enbox/dwn-server';

const server = new DwnServer();
await server.start();

// ... later, for a clean shutdown:
await server.stop();
```

You can override configuration and inject collaborators (a custom config, a prebuilt `Dwn`, a `DidResolver`, post-processing hooks, or a `RegistrationManager` / `OpenAuthHandler`):

```typescript
import { DwnServer, defaultDwnServerConfig } from '@enbox/dwn-server';

const server = new DwnServer({
  config: { ...defaultDwnServerConfig, port: 8080 },
});
await server.start();
```

## Configuration

All configuration is read from environment variables at startup (see [`src/config.ts`](./src/config.ts)). Booleans use a strict `=== 'true'` check unless noted; `DS_WEBSOCKET_SERVER` is the exception (`on` / `off`).

### Core server

| Env var                | Description                                                             | Default                 |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------- |
| `DS_PORT`              | Port the server listens on                                              | `3000`                  |
| `DWN_BASE_URL`         | External base URL of this DWN (used for connect flows and provider-auth URLs) | `http://localhost:3000` |
| `DS_WEBSOCKET_SERVER`  | Enable the WebSocket listener: `on` / `off`                             | `on`                    |
| `MAX_RECORD_DATA_SIZE` | Startup-only maximum `RecordsWrite` data size (`b`, `kb`, `mb`, `gb`)   | `100mb`                 |
| `DWN_MAX_IN_FLIGHT`    | Max unacknowledged subscription events per subscription before backpressure | `32`                |
| `DWN_WEBSOCKET_MAX_CONNECTIONS` | Startup-only process-wide WebSocket connection limit            | `1000`                  |
| `DWN_WEBSOCKET_MAX_CONNECTIONS_PER_IP` | Startup-only WebSocket connection limit per peer IP       | `100`                   |
| `DWN_WEBSOCKET_MAX_SUBSCRIPTIONS_PER_CONNECTION` | Startup-only outstanding subscription-slot limit per connection | `64` |
| `DWN_SERVER_LOG_LEVEL` | Log level: `trace`, `debug`, `info`, `warn`, `error`                    | `INFO`                  |
| `DWN_SERVER_PACKAGE_NAME` | Server name reported by `/info`                                      | `@enbox/dwn-server`     |

### Storage

The server uses three logical stores: a **message store**, a **data store**, and a **resumable-task store**. Each can be configured individually, and all fall back to `DWN_STORAGE` (which itself defaults to `level://data`).

| Env var                       | Description                                                  | Default                  |
| ----------------------------- | ------------------------------------------------------------ | ------------------------ |
| `DWN_STORAGE`                 | Default storage URL for every store                          | `level://data`           |
| `DWN_STORAGE_MESSAGES`        | Message store URL (overrides `DWN_STORAGE`)                  | value of `DWN_STORAGE`   |
| `DWN_STORAGE_DATA`            | Data store URL (overrides `DWN_STORAGE`)                     | value of `DWN_STORAGE`   |
| `DWN_STORAGE_RESUMABLE_TASKS` | Resumable-task store URL (overrides `DWN_STORAGE`)           | value of `DWN_STORAGE`   |
| `DWN_TTL_CACHE_URL`           | TTL/session cache URL — **SQL backends only** (not LevelDB) | `sqlite://`              |

#### Connection-string formats

| Database   | Example                                                | Notes                                                                             |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| LevelDB    | `level://data`                                         | Single-node only. Two slashes for relative paths, three for absolute.             |
| SQLite     | `sqlite://dwn.db`                                      | `sqlite://` alone is in-memory (shared across stores within the process).         |
| MySQL 8.0+ | `mysql://user:pass@host:3306/db?debug=true&timezone=-0700` | [Connection options](https://github.com/mysqljs/mysql#connection-options) as query params. |
| PostgreSQL | `postgres://user:pass@host:5432/db`                    | Also honors [standard `PG*` env vars](https://node-postgres.com/features/connecting). |

#### Optional backend packages

`@enbox/dwn-server` keeps non-default backend drivers optional. Install the
driver for the backend you configure:

| Feature | Install command |
| ------- | --------------- |
| LevelDB / SQLite | No extra package |
| PostgreSQL storage | `bun add pg pg-cursor` |
| MySQL storage | `bun add mysql2` |
| NATS event-bus plugin | `bun add @nats-io/transport-node` |

> **TTL cache constraint:** if a registration store is configured (via `DWN_REGISTRATION_STORE_URL`, or its fallback to `DWN_STORAGE`) and `DWN_TTL_CACHE_URL` points at a *different* SQL database, the server throws at startup — the `cacheEntries` table is managed by the server migration system and must live in the same database. Point both at the same SQL URL.

#### Plugins

Custom store implementations can be loaded by pointing a storage variable at a **file path** (starting with `/`, `./`, or `../`) to a `.js` file that default-exports a class with a no-arg constructor:

- `DWN_STORAGE_MESSAGES`, `DWN_STORAGE_DATA`, `DWN_STORAGE_RESUMABLE_TASKS` → a `MessageStore`, `DataStore`, or `ResumableTaskStore`.
- `DWN_EVENT_BUS_PLUGIN_PATH` → a custom `EventBus` (for cross-process durable-log wakes). See [Event bus](#event-bus).

### Registration & provider-auth

Registration is **open by default**. The tenant gate activates whenever a **SQL** registration store is configured — via `DWN_REGISTRATION_STORE_URL`, or its fallback to `DWN_STORAGE` (the per-store `DWN_STORAGE_*` overrides do **not** count). So pointing `DWN_STORAGE` at Postgres/MySQL/SQLite activates the gate **even when `DWN_REGISTRATION_STORE_URL` is unset**; you must then enable a method below (or pre-register tenants via the admin API), or new tenants are rejected. See [Registration requirements](#registration-requirements) for the full flow.

| Env var                                           | Description                                                                 | Default                |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------- |
| `DWN_REGISTRATION_STORE_URL`                      | SQL store for registered tenants; falls back to `DWN_STORAGE`. A SQL value activates the tenant gate (LevelDB not supported). | value of `DWN_STORAGE` |
| `DWN_REGISTRATION_PROOF_OF_WORK_ENABLED`          | Require proof-of-work to register                                            | `false`                |
| `DWN_REGISTRATION_PROOF_OF_WORK_SEED`             | Seed for challenge nonces (keeps difficulty consistent across a cluster)     | unset                  |
| `DWN_REGISTRATION_PROOF_OF_WORK_INITIAL_MAX_HASH` | Initial difficulty (64-char hex; more leading zeros = harder)               | unset                  |
| `DWN_TERMS_OF_SERVICE_FILE_PATH`                  | Path to a terms-of-service file. Unset = no ToS requirement                 | unset                  |
| `DWN_PROVIDER_AUTH_ENABLED`                       | Enable provider-auth (OAuth2) registration                                  | `false`                |
| `DWN_PROVIDER_AUTH_JWT_SECRET`                    | HMAC secret for the built-in JWT verifier (symmetric)                       | unset                  |
| `DWN_PROVIDER_AUTH_JWT_JWKS_URL`                  | JWKS URL for the built-in JWT verifier (asymmetric)                         | unset                  |
| `DWN_PROVIDER_AUTH_PLUGIN_PATH`                   | Path to a custom provider-auth plugin (overrides the built-in JWT handler)  | unset                  |
| `DWN_PROVIDER_AUTH_AUTHORIZE_URL`                 | OAuth2 authorize endpoint (see note)                                         | derived (see note)     |
| `DWN_PROVIDER_AUTH_TOKEN_URL`                     | OAuth2 token endpoint (see note)                                             | derived (see note)     |
| `DWN_PROVIDER_AUTH_REFRESH_URL`                   | OAuth2 refresh endpoint (see note)                                           | derived (see note)     |
| `DWN_PROVIDER_AUTH_MANAGEMENT_URL`                | Account-management URL surfaced in `/info`                                   | unset                  |

> The built-in JWT verifier fixes the expected `iss` and `aud` claims to `DWN_BASE_URL` — they are not separately configurable on the server. The `*_URL` values default to `${DWN_BASE_URL}/provider-auth/{authorize,token,refresh}` **only when the built-in OpenAuth handler is active** (provider-auth enabled with `DWN_PROVIDER_AUTH_JWT_SECRET` and no custom plugin). With a JWKS-only or custom-plugin setup, set these URLs explicitly or they remain unset.

### Admin API configuration

The admin API and UI are **disabled** unless an admin token is provided. See [Admin API](#admin-api) for capabilities.

| Env var                             | Description                                                            | Default     |
| ----------------------------------- | --------------------------------------------------------------------- | ----------- |
| `DWN_ADMIN_TOKEN`                   | Bearer token for the admin API. Unset = admin API disabled            | unset       |
| `DWN_ADMIN_TOKEN_FILE`              | Path to a file containing the admin token (e.g. a Docker secret)      | unset       |
| `DWN_ADMIN_ACTIVITY_LOG_CAPACITY`   | In-memory ring-buffer size for recent activity events                 | `10000`     |
| `DWN_ADMIN_METRICS_UPDATE_INTERVAL` | Interval (seconds) for refreshing Prometheus gauges from the store    | `30`        |
| `DWN_ADMIN_WEBAUTHN_RP_ID`          | WebAuthn Relying Party ID for passkey login                           | hostname of `DWN_BASE_URL` |
| `DWN_ADMIN_WEBAUTHN_RP_NAME`        | Human-readable RP name shown during passkey registration             | `DWN Admin` |
| `DWN_ADMIN_SESSION_TTL`             | Passkey session TTL (seconds)                                         | `86400`     |

### Rate limiting & quotas

| Env var                                      | Description                                              | Default        |
| -------------------------------------------- | ------------------------------------------------------- | -------------- |
| `DWN_RATE_LIMIT_REQUESTS_PER_SECOND`         | Per-IP HTTP, WebSocket-upgrade, and WS request rate (0 = disabled) | `30`       |
| `DWN_RATE_LIMIT_BURST`                        | Per-IP burst allowance                                  | `50`           |
| `DWN_RATE_LIMIT_TENANT_REQUESTS_PER_SECOND`  | Per-tenant DWN request rate, HTTP + WS (0 = disabled)   | `20`           |
| `DWN_RATE_LIMIT_TENANT_BURST`                | Per-tenant burst allowance                              | `50`           |
| `DWN_QUOTA_MAX_MESSAGES`                     | Default max messages per tenant (0 = unlimited)         | `0`            |
| `DWN_QUOTA_MAX_STORAGE_BYTES`               | Default max stored bytes per tenant (0 = unlimited)     | `0`            |
| `DWN_AUDIT_LOG_MAX_AGE_DAYS`                | Audit-log retention by age (0 = no age limit)           | `90`           |
| `DWN_AUDIT_LOG_MAX_ROWS`                    | Audit-log retention by row count (0 = no row limit)     | `100000`       |

Per-tenant quotas and rate limits can be overridden at runtime via the admin API.
WebSocket acknowledgements that advance a subscription event window are exempt from
the ordinary request bucket so flow-control progress cannot be rate-limited away.
Peer-IP limits use the direct TCP peer and never trust forwarded headers. When a
reverse proxy terminates connections, enforce client-IP limits there and size
the Enbox per-peer connection limit for the proxy's aggregate traffic.

### Sync: delivery & forwarding

When a `RecordsWrite` / `RecordsDelete` is processed, the server can proactively push it to a tenant's other DWN endpoints (forwarding) or to protocol participants' endpoints (delivery). Both are off by default.

| Env var                            | Description                                                     | Default |
| ---------------------------------- | -------------------------------------------------------------- | ------- |
| `DWN_FORWARDING_ENABLED`           | Forward messages to the tenant's other DWN endpoints           | `false` |
| `DWN_DELIVERY_ENABLED`             | Deliver records to protocol participants' endpoints            | `false` |
| `DWN_DELIVERY_MAX_CONCURRENCY`     | Max concurrent outbound delivery/forwarding requests           | `10`    |
| `DWN_DELIVERY_ENDPOINT_CACHE_TTL`  | TTL (seconds) for cached DID → endpoint resolutions            | `300`   |
| `DWN_FORWARDING_DEDUP_TTL`         | TTL (seconds) for the forwarded-message dedup cache            | `60`    |

### PostgreSQL connection pool

When multiple stores point at the same Postgres URL, they share a single pool.

| Env var                    | Description                          | Default |
| -------------------------- | ------------------------------------ | ------- |
| `DWN_PG_POOL_MIN`          | Minimum pool connections             | `5`     |
| `DWN_PG_POOL_MAX`          | Maximum pool connections             | `30`    |
| `DWN_PG_POOL_IDLE_TIMEOUT` | Idle connection timeout (ms)         | `30000` |

### Event bus

The default event bus is in-process. To coordinate durable-log wakes across processes, set `DWN_EVENT_BUS_PLUGIN_PATH` to a plugin. The bundled NATS event bus reads its own configuration:

| Env var                    | Description                                  | Default                 |
| -------------------------- | -------------------------------------------- | ----------------------- |
| `NATS_URL`                 | NATS server URL(s), comma-separated          | `nats://localhost:4222` |
| `NATS_WAKE_SUBJECT_PREFIX` | Subject prefix for wake notifications        | `dwn.wakes`             |

## JSON-RPC API

[JSON-RPC](https://www.jsonrpc.org/specification) is a lightweight, transport-agnostic RPC protocol. The server registers the following methods (see [`src/json-rpc-api.ts`](./src/json-rpc-api.ts)):

| Method                              | Transport      | Purpose                                                          |
| ----------------------------------- | -------------- | --------------------------------------------------------------- |
| `dwn.processMessage`                | HTTP & WS      | Process a single DWN message.                                   |
| `dwn.applyReplicatedMessage`        | HTTP & WS      | Apply a replicated message for sync/replication.                |
| `rpc.subscribe.dwn.processMessage`  | WebSocket only | Open a subscription and stream matching events.                 |
| `rpc.ack`                           | WebSocket only | Acknowledge subscription events to advance the flow-control window. |
| `rpc.subscribe.close`               | WebSocket only | Close an open subscription.                                     |
| `rpc.ping`                          | HTTP & WS      | Lightweight heartbeat; replies `{ ok: true }`.                  |

### `dwn.processMessage`

Send a DWeb message to a target tenant.

#### Params

| Property      | Required | Description                                                               |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `target`      | Y        | The DID the message is intended for                                       |
| `message`     | Y        | The DWeb message                                                          |
| `encodedData` | N        | Inline data for the message (small `RecordsWrite` payloads — see below)   |

#### Example request

```json
{
  "jsonrpc": "2.0",
  "id": "b23f9e31-4966-4972-8048-af3eed43cb41",
  "method": "dwn.processMessage",
  "params": {
    "message": {
      "recordId": "bafyreidtix6ghjmsbg7eitexsmwzvjxc7aelagsqasybmql7zrms34ju6i",
      "descriptor": {
        "interface": "Records",
        "method": "Write",
        "dataCid": "bafkreidnfo6aux5qbg3wwzy5hvwexnoyhk3q3v47znka2afa6mf2rffkbi",
        "dataSize": 32,
        "dateCreated": "2023-04-30T22:49:37.713976Z",
        "dateModified": "2023-04-30T22:49:37.713976Z",
        "dataFormat": "application/json"
      },
      "authorization": { "..." : "..." }
    },
    "target": "did:key:z6Mku1h4LdkhXW3HnnBKANxgUaQ162cvWmRuzcbd2Ye8VstZ",
    "encodedData": "ub3-FwUsSs4GgZWqt5eXSH41RKlwCx41y3dgio9Di74"
  }
}
```

#### Example success response

```json
{
  "jsonrpc": "2.0",
  "id": "18eb421f-4750-4e31-a062-412b71139546",
  "result": {
    "reply": {
      "status": { "code": 202, "detail": "Accepted" }
    }
  }
}
```

#### Example error response

```json
{
  "jsonrpc": "2.0",
  "id": "1c7f6ed8-eaaf-447c-aaf3-b9e61f3f59af",
  "error": {
    "code": -50400,
    "message": "Unexpected token ';', \";;;;@!#@!$$#!@%\" is not valid JSON"
  }
}
```

### Transporting large data

Inline `encodedData` is only suitable for payloads up to ~30 KB (`30,000` bytes). Larger `RecordsWrite` data is streamed over HTTP:

- Check `GET /info` for `httpRpcFraming: ["body-v1"]`.
- Set `content-type` to `application/vnd.enbox.dwn-rpc; version=1`.
- Send a one-byte flags field, a four-byte big-endian JSON envelope length, the UTF-8 JSON-RPC envelope, and then the raw binary data in one streaming request body.

Servers continue to accept the legacy `dwn-request` header with an `application/octet-stream` data body for older clients. Enbox clients negotiate the body framing automatically.

### Receiving large data

A `RecordsWrite` returned from a query includes `encodedData` only when the data is under the ~30 KB threshold. Larger data is fetched via `RecordsRead` over HTTP, which returns:

- The JSON-RPC response in a `dwn-response` response header.
- The raw binary data in the response body (`content-type: application/octet-stream`).

### Subscriptions & backpressure (WebSocket)

Open a subscription with `rpc.subscribe.dwn.processMessage` over a WebSocket connection. The server streams matching events as JSON-RPC frames and applies per-subscription flow control: it sends at most `DWN_MAX_IN_FLIGHT` (default `32`) unacknowledged events before pausing. The client advances the window by sending `rpc.ack` with the latest cursor, and closes the subscription with `rpc.subscribe.close`. Use `rpc.ping` to detect dead connections.

## HTTP endpoints

Public endpoints (no auth unless noted). Permissive CORS is applied to the JSON-RPC and read routes; admin routes are not CORS-exposed.

| Method | Path                                   | Description                                                                 |
| ------ | -------------------------------------- | --------------------------------------------------------------------------- |
| `GET`  | `/`                                    | Plain-text pointer to use an Enbox client. Upgrades to WebSocket when requested. |
| `GET`  | `/health`                              | Liveness check — returns `{ "ok": true }`.                                  |
| `GET`  | `/info`                                | Server capabilities and registration requirements — see [Server info](#server-info). |
| `GET`  | `/metrics`                             | Prometheus metrics. Token-protected when `DWN_ADMIN_TOKEN` is set.          |
| `POST` | `/`                                    | Main JSON-RPC endpoint (HTTP transport).                                    |
| `GET`  | `/registration/proof-of-work`         | Proof-of-work challenge (only if PoW is enabled).                           |
| `GET`  | `/registration/terms-of-service`      | Terms-of-service text (only if a ToS file is configured).                   |
| `POST` | `/registration`                        | Register a tenant DID (only if registration is gated).                      |
| `GET`  | `/provider-auth/authorize`            | OAuth2 authorize — built-in OpenAuth handler only (see note below).         |
| `POST` | `/provider-auth/token`                | OAuth2 token exchange — built-in OpenAuth handler only.                      |
| `POST` | `/provider-auth/refresh`              | OAuth2 token refresh — built-in OpenAuth handler only.                       |
| `POST` | `/connect/par`                         | Pushed Authorization Request store (Enbox Connect).                         |
| `GET`  | `/connect/authorize/:requestId.jwt`   | Retrieve a stored PAR request object.                                       |
| `POST` | `/connect/callback`                    | Submit an identity-provider response.                                       |
| `GET`  | `/connect/token/:state.jwt`           | Retrieve a stored ID token.                                                  |
| `GET`  | `/:did/read/records/:recordId`        | Convenience read of a record's data over HTTP.                             |
| `GET`  | `/:did/read/protocols/:protocol/*`    | Convenience read of a protocol record over HTTP.                           |
| `GET`  | `/:did/query` · `/:did/query/protocols` | Convenience record / protocol queries over HTTP.                         |
| `*`    | `/admin/api/*`, `/admin/*`            | Admin API and UI (disabled unless an admin token is set) — see [Admin API](#admin-api). |

> **Provider-auth note:** the built-in `/provider-auth/*` routes are served **only** when the built-in OpenAuth handler is active — that is, provider-auth is enabled with `DWN_PROVIDER_AUTH_JWT_SECRET` and no custom plugin. JWKS-only or custom-plugin deployments do not expose these routes; clients use the provider-auth URLs advertised at `/info` (or your provider's own endpoints) instead.

## Server info

`GET /info` returns the server's capabilities and current registration requirements:

```json
{
  "server": "@enbox/dwn-server",
  "version": "0.1.10",
  "sdkVersion": "0.2.6",
  "url": "https://dwn.example.com",
  "maxFileSize": 104857600,
  "maxInFlight": 32,
  "webSocketSupport": true,
  "registrationRequirements": ["proof-of-work-sha256-v0", "terms-of-service"]
}
```

`version` and `sdkVersion` are read from the package metadata and will vary by build. When provider-auth is enabled, an additional `providerAuth` object is included with `authorizeUrl`, `tokenUrl`, `refreshUrl`, and (if set) `managementUrl`.

## Registration requirements

Registration gates are optional and **all disabled by default**. The gate becomes active when a SQL registration store is configured — via `DWN_REGISTRATION_STORE_URL` or its fallback to `DWN_STORAGE` (LevelDB is not supported). Tenants that have not satisfied the active requirements receive a `401`. The current requirements are advertised at `/info`.

Every registration request must carry **either** proof-of-work **or** provider-auth credentials; a request with neither is rejected. Terms-of-service is not a standalone gate — it is layered onto those two, and (as noted below) enforced for proof-of-work but only conditionally for provider-auth.

- **Proof of work** (`DWN_REGISTRATION_PROOF_OF_WORK_ENABLED=true`) — advertised as `proof-of-work-sha256-v0`. Clients `GET /registration/proof-of-work` for a challenge, compute a nonce so that `sha256(challenge + nonce)` has the required number of leading zeros, and POST it back. Challenges expire after 5 minutes; difficulty auto-adjusts.
- **Provider auth** (`DWN_PROVIDER_AUTH_ENABLED=true` with a JWT secret, JWKS URL, or custom plugin) — advertised as `provider-auth-v0`. Clients obtain a token via the OAuth2 flow (the built-in `/provider-auth/*` endpoints, or your configured provider) and register with it.
- **Terms of service** (`DWN_TERMS_OF_SERVICE_FILE_PATH=/path/to/tos.txt`) — advertised as `terms-of-service`. A **layered** requirement, not a gate of its own, and it is enforced **asymmetrically**: a **proof-of-work** registration must include a matching `termsOfServiceHash` (from `GET /registration/terms-of-service`), but a **provider-auth** registration validates the hash only if the client supplies one — omitting it still succeeds. If you need ToS to be mandatory for provider-auth tenants, enforce acceptance in your provider/OAuth flow. Editing the file invalidates prior acceptances.

If a registration store is configured but neither proof-of-work nor provider-auth is enabled, the server logs a startup warning — new tenants would be unable to register. The registration store URL resolves from `DWN_REGISTRATION_STORE_URL` **or** `DWN_STORAGE` only (not the per-store `DWN_STORAGE_*` overrides), so to run an **open** node leave both of those unset — you can still use SQL stores by setting `DWN_STORAGE_MESSAGES` / `DWN_STORAGE_DATA` / `DWN_STORAGE_RESUMABLE_TASKS` individually. When the gate is active, enable a method above or pre-register tenants via the admin API.

## Admin API

The admin API (and the bundled admin UI from `@enbox/dwn-server-admin-ui`) are **disabled** unless `DWN_ADMIN_TOKEN` (or `DWN_ADMIN_TOKEN_FILE`) is set; without it, every `/admin/*` route returns `404`. When enabled:

- Requests authenticate with `Authorization: Bearer <token>`, or with a passkey-issued session for routes that allow it.
- The JSON API is served under `/admin/api/*`; the static UI is served under `/admin/*`.
- `/metrics` becomes token-protected by the same credential.

Capabilities include tenant management (list, inspect, pre-register, suspend/unsuspend, delete/purge), per-tenant quotas, the audit log, recent activity events, active WebSocket connections, webhook registration, runtime config changes (log level, quotas, rate limits), tenant data browsing/export, and passkey (WebAuthn) registration and login. The admin store requires a SQL backend — it is unavailable with LevelDB.

## Hosting your own DWN

By default, `Enbox.connect()` uses bootstrap DWN nodes. You can run your own for yourself or your community — anywhere you can run Bun or Docker, as long as HTTP and WebSocket are reachable.

The [Self-Hosting Guide](../../SELF-HOSTING.md) covers the full workflow, including TLS, choosing a storage backend, and — critically — [advertising the node in your DID document](../../SELF-HOSTING.md#5-advertise-your-dwn-in-your-did-document) so clients can discover it. A few quick options:

- **ngrok** — `ngrok http 3000`, then set `DWN_BASE_URL` to the tunnel URL.
- **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:3000`.
- **PaaS (Render, etc.)** — deploy the container and, if you use the default LevelDB backend, mount a persistent disk at `/app/packages/dwn-server/data`.

## Development

```bash
bun run build         # clean + compile TypeScript (tsc)
bun run server        # build then start the server (dist/esm/src/main.js)
bun run test:node     # run the test suite (bun test)
bun run lint          # lint (eslint, zero warnings)
bun run lint:fix      # auto-fix lint issues
```

## License

Apache-2.0
