# Self-Hosting a DWN Server

Run your own Decentralized Web Node (DWN) so your identities store and sync data
on infrastructure you control instead of relying on the bootstrap nodes. This
guide is provider-agnostic: the server is a single container (or a Bun process)
that you can run anywhere — a VPS, a cloud provider, Kubernetes, or a home server
fronted by a tunnel.

> For the exhaustive configuration reference (every environment variable, every
> storage option, the plugin system, and the JSON-RPC API) see the
> [`@enbox/dwn-server` README](./packages/dwn-server/README.md). This guide
> focuses on the end-to-end deployment workflow and the one step that is easy to
> miss: [advertising your DWN in your DID document](#5-advertise-your-dwn-in-your-did-document).

## What you are deploying

`@enbox/dwn-server` is a multi-tenant DWN exposed over HTTP and WebSocket. To run
it in production you need three things:

1. A **publicly reachable HTTPS URL** that serves both HTTP and WebSocket.
2. A **storage backend** — LevelDB is fine for a single node; PostgreSQL or MySQL
   is recommended for production.
3. A **`DecentralizedWebNode` service entry in your DID document** so clients and
   peers can discover the node. Hosting the server is not enough on its own — see
   [step 5](#5-advertise-your-dwn-in-your-did-document).

## Prerequisites

- A host that can run **Docker** or **Bun >= 1.0**.
- A **domain name** and **TLS** — terminated directly, via a reverse proxy, or via
  a tunnel.
- (Production) A managed **SQL database**. PostgreSQL is recommended.

## 1. Run the server

### Option A — Docker (recommended)

Pre-built images are published to GitHub Container Registry. Mount a persistent
volume so data survives restarts.

```bash
docker run -d \
  --name dwn-server \
  -p 3000:3000 \
  -v dwn-data:/dwn-server/data \
  -e DWN_BASE_URL=https://dwn.example.com \
  -e DS_WEBSOCKET_SERVER=on \
  ghcr.io/enboxorg/dwn-server:main
```

To pin a specific version instead of `:main`, see the
[published images](https://github.com/enboxorg/enbox/pkgs/container/dwn-server/versions)
and pull by digest:

```bash
docker pull ghcr.io/enboxorg/dwn-server@sha256:<hash>
```

### Option B — Docker Compose

For a self-contained stack (DWN server + PostgreSQL) use the compose file shipped
with the package. See [`docs/HOSTING.md`](./docs/HOSTING.md) and
[`packages/dwn-server/docker-compose.yaml`](./packages/dwn-server/docker-compose.yaml).

```bash
cd packages/dwn-server
docker compose up -d
```

### Option C — From source (Bun)

```bash
git clone https://github.com/enboxorg/enbox.git
cd enbox
bun install
bun run --filter @enbox/dwn-server build
bun run --filter @enbox/dwn-server server
```

The server reads all configuration from environment variables, so you can export
them in your shell or supply a process manager (systemd, pm2, etc.).

## 2. Configure

All configuration is via environment variables. The most common ones:

| Variable               | Default                  | Description                                                                 |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `DS_PORT`              | `3000`                   | Port the server listens on (must match your published/`internal` port).     |
| `DWN_BASE_URL`         | `http://localhost:3000`  | Public URL of this DWN. Used in connect flows and OAuth URL construction.   |
| `DS_WEBSOCKET_SERVER`  | `on`                     | Enable the WebSocket listener. Set to `off` to disable.                     |
| `MAX_RECORD_DATA_SIZE` | `100mb`                  | Maximum `RecordsWrite` data size (`b`, `kb`, `mb`, `gb`).                    |
| `DWN_SERVER_LOG_LEVEL` | `info`                   | Log level: `trace`, `debug`, `info`, `warn`, `error`.                       |
| `DWN_STORAGE`          | `level://data`           | Default storage URL for all stores (see [Storage backends](#storage-backends)). |
| `DWN_TTL_CACHE_URL`    | `sqlite://`              | TTL/session cache. SQL backends only (not LevelDB).                         |

See the [`@enbox/dwn-server` README](./packages/dwn-server/README.md#configuration)
for the full list (registration, provider-auth, admin, rate limiting, quotas,
delivery/forwarding, connection pooling, and more).

### Storage backends

The server reads/writes through four logical stores (messages, data, state index,
resumable tasks). By default they all share `DWN_STORAGE`; override any of them
individually with `DWN_STORAGE_MESSAGES`, `DWN_STORAGE_DATA`,
`DWN_STORAGE_STATE_INDEX`, and `DWN_STORAGE_RESUMABLE_TASKS`.

| Backend    | Connection URL example              | Notes                                                                            |
| ---------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| LevelDB    | `level://data`                      | Single-node only. Two slashes for relative paths, three for absolute.            |
| SQLite     | `sqlite://dwn.db`                   | `sqlite://` alone is in-memory. A file path persists to disk.                    |
| MySQL      | `mysql://user:pass@host:3306/db`    | [Connection options](https://github.com/mysqljs/mysql#connection-options) as query params. |
| PostgreSQL | `postgres://user:pass@host:5432/db` | Recommended for production. Also honors standard `PG*` env vars.                  |

For production, point every store at a shared SQL database:

```bash
docker run -d \
  --name dwn-server \
  -p 3000:3000 \
  -e DWN_BASE_URL=https://dwn.example.com \
  -e DWN_STORAGE=postgres://user:pass@db.internal:5432/dwn \
  -e DWN_TTL_CACHE_URL=postgres://user:pass@db.internal:5432/dwn \
  ghcr.io/enboxorg/dwn-server:main
```

> **Note:** `DWN_TTL_CACHE_URL` must be a SQL backend, and if you also set
> `DWN_REGISTRATION_STORE_URL` (see below) both must point at the **same** SQL
> database — they share server-side tables. LevelDB is never accepted for either.

## 3. Expose it publicly (TLS)

`DWN_BASE_URL` must be the externally reachable HTTPS URL clients will use, and the
host must serve **both HTTP and WebSocket**. Pick whichever fits your host:

- **Managed TLS** — most PaaS hosts terminate TLS for you. Just set `DWN_BASE_URL`
  to the assigned domain.
- **Reverse proxy** — front the container with nginx, Caddy, or Traefik for TLS
  termination, forwarding HTTP and WebSocket upgrades to `DS_PORT`.
- **Tunnel** (great for home servers / quick tests):

  ```bash
  # ngrok
  ngrok http 3000

  # or Cloudflare Tunnel
  cloudflared tunnel --url http://localhost:3000
  ```

  Then set `DWN_BASE_URL` to the tunnel's public URL.

## 4. Verify

```bash
# Liveness
curl https://dwn.example.com/health        # -> { "ok": true }

# Server info + active registration requirements
curl https://dwn.example.com/info

# Prometheus metrics (protected if DWN_ADMIN_TOKEN is set)
curl https://dwn.example.com/metrics
```

## 5. Advertise your DWN in your DID document

Running the server is only half the job. Other agents — and your own clients on
other devices — discover where your data lives by resolving your DID and reading
its **`DecentralizedWebNode` service entry**. If your DID document does not list
your endpoint, nothing will route to your node, no matter how healthy it is.

The service entry looks like this in the resolved DID document:

```json
{
  "id": "did:dht:abc123…#dwn",
  "type": "DecentralizedWebNode",
  "serviceEndpoint": ["https://dwn.example.com"]
}
```

`serviceEndpoint` is a list, so you can advertise several endpoints for redundancy.
There are two ways to set it.

### Add it when creating an identity

Pass a `services` array to the identity/DID create options:

```typescript
const identity = await agent.identity.create({
  didMethod  : 'dht',
  didOptions : {
    services : [{
      id              : 'dwn',
      type            : 'DecentralizedWebNode',
      serviceEndpoint : ['https://dwn.example.com'],
    }],
  },
  metadata   : { name: 'My Identity' },
});
```

### Add or update it on an existing identity

```typescript
await agent.identity.setDwnEndpoints({
  didUri    : identity.did.uri,
  endpoints : ['https://dwn.example.com'],
});
```

`setDwnEndpoints` updates the `DecentralizedWebNode` service (creating it if
absent) and republishes the DID. For `did:dht`, the updated document is published
back to the DHT/Pkarr network so resolvers everywhere pick up the new endpoint —
allow a few moments for propagation.

Confirm the endpoint is live in the published document:

```typescript
const endpoints = await agent.identity.getDwnEndpoints({ didUri: identity.did.uri });
// -> ['https://dwn.example.com']
```

## Registration & tenant gating

By default the server is **open** — any DID can use it. To restrict who may
register as a tenant, set `DWN_REGISTRATION_STORE_URL` (a SQL database) and enable
one or more gates:

- **Proof of Work** — `DWN_REGISTRATION_PROOF_OF_WORK_ENABLED=true`.
- **Terms of Service** — `DWN_TERMS_OF_SERVICE_FILE_PATH=/path/to/tos.txt`.
- **Provider Auth (OAuth2)** — `DWN_PROVIDER_AUTH_ENABLED=true` plus a JWT secret,
  JWKS URL, or custom plugin.

Active requirements are advertised at `/info`. If you set
`DWN_REGISTRATION_STORE_URL` but enable **no** gate, new tenants cannot register —
the server logs a warning at startup. Leave `DWN_REGISTRATION_STORE_URL` unset for
an open node. See the
[Registration Requirements](./packages/dwn-server/README.md#registration-requirements)
section of the README for the full client flow.

## Admin API (optional)

The admin API and UI are **disabled** unless you provide a token via
`DWN_ADMIN_TOKEN` (or `DWN_ADMIN_TOKEN_FILE`). When set, admin endpoints under
`/admin/api/*` require an `Authorization: Bearer <token>` header, and the
`/metrics` endpoint becomes protected by the same token.

## Production considerations

1. **Use external SQL** (PostgreSQL/MySQL) rather than LevelDB so you can scale and
   take managed backups.
2. **Run multiple instances** behind a load balancer — the app is stateless when
   all instances share the same SQL database. Tune the Postgres pool with
   `DWN_PG_POOL_MIN` / `DWN_PG_POOL_MAX` when many instances share one database.
3. **Persist the data volume** if you do use LevelDB/SQLite-on-disk
   (`-v dwn-data:/dwn-server/data`).
4. **Manage secrets** (database URLs, admin token, JWT secrets) via your platform's
   secret manager — never bake them into images.
5. **Back up the database** and test restores.
6. **Monitor** `/health` for liveness and scrape `/metrics` into Prometheus/Grafana.

## Troubleshooting

**WebSocket connections fail behind a proxy.** Ensure your reverse proxy forwards
the `Upgrade`/`Connection` headers for WebSocket, and that `DS_WEBSOCKET_SERVER` is
`on`.

**Port mismatch.** `DS_PORT` must match the port your platform routes to (the
published Docker port, the proxy upstream, or the platform's `internal_port`).

**Database connection errors.** Verify the database is reachable from the
container, the connection URL/credentials are correct, and (if gating registration)
that `DWN_TTL_CACHE_URL` and `DWN_REGISTRATION_STORE_URL` point at the **same** SQL
database.

**Clients can't find the node.** Almost always a missing or stale
`DecentralizedWebNode` entry — re-check
[step 5](#5-advertise-your-dwn-in-your-did-document) and confirm the published DID
document resolves with your endpoint.

## Additional resources

- [`@enbox/dwn-server` README](./packages/dwn-server/README.md) — full configuration, storage, and JSON-RPC reference
- [`docs/HOSTING.md`](./docs/HOSTING.md) — Docker Compose quick start
- [`packages/dwn-server/charts`](./packages/dwn-server/charts) — Helm chart for Kubernetes
