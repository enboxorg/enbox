# DWN Server Admin Dashboard — Design Plan

## Problem Statement

The `dwn-server` currently has **zero administrative capabilities**. An operator running a DWN server — whether a service provider hosting thousands of tenants or a single person running their own node — has no way to:

- See who is using their server or how much storage they consume
- Monitor server health beyond a basic `{ ok: true }` liveness probe
- Manage tenants (suspend, remove, set quotas)
- View real-time activity or audit logs
- Configure the server at runtime (everything requires env vars + restart)
- Protect against abuse (no rate limiting, no per-tenant quotas, no storage caps)

The only tools available today are raw SQL queries against the database and a Prometheus `/metrics` endpoint with two counters.

---

## Design Principles

1. **API-first**: The admin dashboard is a REST API layer first, UI second. The API must be independently useful for scripting and automation.
2. **Secure by default**: The admin API must be authenticated. A single shared secret (bearer token) for v1, with support for more sophisticated auth later.
3. **Non-invasive**: The admin layer is additive — it must not modify the DWN SDK interfaces or break existing behavior. It reads from the same stores the DWN uses.
4. **Incremental**: Ship in phases. Each phase delivers standalone value.
5. **Operator-centric**: Designed for the person running the server, not the DWN tenant. Tenants continue to interact via the DWN protocol.

---

## Architecture Overview

```
                        ┌─────────────────────────────────────────┐
                        │              dwn-server                  │
                        │                                          │
   Tenants ──────────── │  POST /          (JSON-RPC DWN)          │
                        │  WS /            (subscriptions)         │
                        │  GET /health     (liveness)              │
                        │  GET /metrics    (prometheus)             │
                        │  GET /info       (server info)            │
                        │  /registration/* (tenant registration)   │
                        │  /connect/*      (Web5 Connect)          │
                        │                                          │
                        │  ─ ─ ─ ─ NEW ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
                        │                                          │
   Admin ─── Bearer ──▶ │  /admin/api/*    (Admin REST API)        │
             Token       │                                          │
                        │  AdminApi        (route handler class)    │
                        │    ├── AdminAuthMiddleware                │
                        │    ├── TenantService                     │
                        │    ├── MetricsService                    │
                        │    ├── StorageService                    │
                        │    └── ConfigService                     │
                        │                                          │
                        └────────────┬─────────────────────────────┘
                                     │
                        ┌────────────▼─────────────────────────────┐
                        │          Shared Storage Layer             │
                        │  MessageStore │ DataStore │ EventLog      │
                        │  RegistrationStore │ EventLog             │
                        └──────────────────────────────────────────┘
```

### Key Design Decisions

**Why `/admin/api/*` and not a separate process?**
- Same process means direct access to the `Dwn` instance, `RegistrationManager`, and all store references via `dwn.storage`.
- No need for a second database connection pool or IPC.
- Admin traffic is negligible compared to DWN protocol traffic.
- The admin API is gated behind authentication; even if exposed publicly, unauthorized requests are rejected at the middleware layer.

**Why bearer token auth?**
- Simple to implement, simple to use with curl/scripts.
- No dependency on external auth providers.
- The token is set via env var `DWN_ADMIN_TOKEN`. If unset, the admin API is **disabled entirely** (secure by default).
- Future phases can add OIDC, mTLS, or DID-based auth.

**Why REST and not JSON-RPC?**
- The admin API serves a fundamentally different audience (operators) with different access patterns (CRUD on tenants, browsing metrics) than the DWN protocol (cryptographically signed messages).
- REST is more natural for resource-oriented admin operations and easier to integrate with dashboards.

---

## Phase 1: Admin API Foundation + Tenant Management

**Goal**: An authenticated admin REST API with tenant listing, inspection, and management.

### 1.1 Configuration

New environment variables:

| Env Var | Config Key | Default | Description |
|---|---|---|---|
| `DWN_ADMIN_TOKEN` | `adminToken` | `undefined` | Bearer token for admin API. If unset, admin API is disabled. |
| `DWN_ADMIN_TOKEN_FILE` | `adminTokenFile` | `undefined` | Alternative: read token from file (for Docker secrets). |

Add to `config.ts`:
```typescript
adminToken: process.env.DWN_ADMIN_TOKEN || (
  process.env.DWN_ADMIN_TOKEN_FILE
    ? readFileSync(process.env.DWN_ADMIN_TOKEN_FILE).toString().trim()
    : undefined
),
```

### 1.2 Admin API Class (`src/admin/admin-api.ts`)

New class `AdminApi` following the same pattern as `HttpApi`:
- Mounted into the existing `Bun.serve()` router as a route prefix match on `/admin/api/`.
- Has access to `Dwn`, `RegistrationManager`, and `DwnServerConfig`.
- All routes require valid bearer token via `AdminAuthMiddleware`.

### 1.3 Authentication Middleware (`src/admin/admin-auth.ts`)

```typescript
export function validateAdminAuth(req: Request, config: DwnServerConfig): Response | null {
  const expected = config.adminToken;
  if (!expected) {
    return new Response('Admin API is disabled', { status: 404 });
  }
  const header = req.headers.get('authorization');
  if (!header || header !== `Bearer ${expected}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  return null; // auth passed
}
```

Uses constant-time comparison via `crypto.timingSafeEqual` to prevent timing attacks.

### 1.4 Tenant Endpoints

#### `GET /admin/api/tenants`

List all registered tenants with pagination.

**Implementation**: Query `registeredTenants` table directly via `RegistrationStore` (needs new method `listTenants()`).

If registration is disabled (open DWN), fall back to `SELECT DISTINCT tenant FROM messageStoreMessages` via a new `AdminStore` that wraps raw Kysely queries.

```json
{
  "tenants": [
    {
      "did": "did:dht:abc123...",
      "termsOfServiceHash": "a1b2c3...",
      "messageCount": 1542,
      "dataStorageBytes": 52428800,
      "lastActivity": "2026-02-20T15:30:00Z"
    }
  ],
  "cursor": "did:dht:xyz...",
  "totalCount": 347
}
```

#### `GET /admin/api/tenants/:did`

Get detailed info for a single tenant.

```json
{
  "did": "did:dht:abc123...",
  "isActive": true,
  "registration": {
    "termsOfServiceHash": "a1b2c3...",
    "registeredAt": null
  },
  "storage": {
    "messageCount": 1542,
    "dataStorageBytes": 52428800,
    "recordCount": 890,
    "protocolCount": 3
  },
  "protocols": [
    "https://protocol.example.com/social",
    "https://protocol.example.com/messaging"
  ]
}
```

**Implementation**: Combines `registrationStore.getTenantRegistration()` with SQL aggregate queries:
```sql
SELECT COUNT(*) as messageCount FROM messageStoreMessages WHERE tenant = ?;
SELECT SUM(LENGTH(data)) as dataStorageBytes FROM dataStore WHERE tenant = ?;
SELECT DISTINCT protocol FROM messageStoreMessages WHERE tenant = ? AND protocol IS NOT NULL;
```

#### `DELETE /admin/api/tenants/:did`

Remove a tenant and optionally purge their data.

Query params:
- `?purge=true` — Also delete all DWN messages and data for this tenant.

**Implementation**:
1. Remove from `registeredTenants`.
2. If purge: delete from tenant-scoped message, data, and replication fingerprint tables while preserving replication counters.

#### `POST /admin/api/tenants/:did/suspend`

Suspend a tenant (they get 401 on all DWN operations). Implementation: a new `suspended` boolean column on `registeredTenants`, checked in `isActiveTenant()`.

#### `POST /admin/api/tenants/:did/unsuspend`

Re-activate a suspended tenant.

### 1.5 Admin Store (`src/admin/admin-store.ts`)

A Kysely-backed store class for admin-specific queries that need cross-tenant access. Reuses the same SQL dialect/pool as the DWN stores.

```typescript
export class AdminStore {
  constructor(private db: Kysely<AdminDatabase>) {}

  static async create(dialectUrl: string): Promise<AdminStore>;

  // Tenant discovery (when registration is disabled)
  async getDistinctTenants(cursor?: string, limit?: number): Promise<{ tenants: string[], cursor?: string }>;

  // Per-tenant aggregates
  async getTenantStats(did: string): Promise<TenantStats>;
  async getTenantStorageSize(did: string): Promise<number>;
  async getTenantMessageCount(did: string): Promise<number>;
  async getTenantProtocols(did: string): Promise<string[]>;

  // Global aggregates
  async getGlobalStats(): Promise<GlobalStats>;
}
```

### 1.6 Files to Create/Modify

**New files:**
- `src/admin/admin-api.ts` — Route handler class
- `src/admin/admin-auth.ts` — Auth middleware
- `src/admin/admin-store.ts` — Cross-tenant SQL queries
- `src/admin/types.ts` — Request/response types
- `tests/admin/admin-api.test.ts` — API integration tests
- `tests/admin/admin-auth.test.ts` — Auth tests
- `tests/admin/admin-store.test.ts` — Store tests

**Modified files:**
- `src/config.ts` — Add `adminToken` config
- `src/dwn-server.ts` — Wire `AdminApi` into server setup
- `src/http-api.ts` — Route `/admin/api/*` to `AdminApi`
- `src/registration/registration-store.ts` — Add `listTenants()`, `deleteTenant()`, `suspendTenant()` methods; add `suspended` column
- `src/registration/registration-manager.ts` — Check `suspended` flag in `isActiveTenant()`
- `src/dwn-error.ts` — Add admin-related error codes
- `src/index.ts` — Export new admin types

---

## Phase 2: Server Observability + Enhanced Health

**Goal**: Give operators real visibility into what their server is doing.

### 2.1 Enhanced Health Check

`GET /admin/api/health` (authenticated) — Deep health check:

```json
{
  "status": "healthy",
  "uptime": 86400,
  "version": "1.2.0",
  "sdkVersion": "workspace:*",
  "checks": {
    "messageStore": { "status": "healthy", "latencyMs": 2 },
    "dataStore": { "status": "healthy", "latencyMs": 1 },
    "database": { "status": "healthy", "latencyMs": 5 },
    "webSocket": { "status": "healthy", "activeConnections": 12 }
  }
}
```

Implementation: Perform a lightweight read operation against each store and measure latency.

### 2.2 Server Statistics

`GET /admin/api/stats` — Aggregated server statistics:

```json
{
  "tenants": {
    "total": 347,
    "active": 340,
    "suspended": 7
  },
  "storage": {
    "totalMessages": 125000,
    "totalDataBytes": 5368709120,
    "totalRecords": 98000,
    "totalProtocols": 45
  },
  "connections": {
    "websocket": {
      "active": 12,
      "subscriptions": 34
    }
  },
  "registration": {
    "proofOfWork": {
      "enabled": true,
      "currentDifficulty": "000000FF...",
      "solvesPerMinute": 8
    }
  },
  "uptime": 86400
}
```

### 2.3 Activity Log / Recent Events

`GET /admin/api/events?limit=50&since=<cursor>` — Recent DWN events across all tenants:

```json
{
  "events": [
    {
      "timestamp": "2026-02-21T10:15:00Z",
      "tenant": "did:dht:abc...",
      "interface": "Records",
      "method": "Write",
      "protocol": "https://...",
      "dataSizeBytes": 4096,
      "status": 202
    }
  ],
  "cursor": "..."
}
```

Implementation: Use the existing Prometheus counter labels combined with a new in-memory ring buffer that captures recent request details (capped at e.g. 10,000 entries). Not a persistent audit log — that's Phase 4.

### 2.4 Enhanced Prometheus Metrics

Add new metrics to `metrics.ts`:
- `dwn_active_tenants` (Gauge) — Number of active tenants
- `dwn_total_messages` (Gauge) — Total messages stored
- `dwn_total_data_bytes` (Gauge) — Total data storage bytes
- `dwn_websocket_connections` (Gauge) — Active WebSocket connections
- `dwn_websocket_subscriptions` (Gauge) — Active subscriptions
- `dwn_registration_difficulty` (Gauge) — Current PoW difficulty
- `dwn_request_data_bytes_total` (Counter) — Total bytes written
- `dwn_tenant_requests_total` (Counter, labeled by tenant) — Per-tenant request count

### 2.5 WebSocket Connection Inspector

`GET /admin/api/connections` — List active WebSocket connections:

```json
{
  "connections": [
    {
      "id": "conn-uuid",
      "remoteAddress": "192.168.1.100",
      "connectedAt": "2026-02-21T10:00:00Z",
      "subscriptions": [
        {
          "id": "sub-1",
          "tenant": "did:dht:abc...",
          "filters": { "interface": "Records", "method": "Write" },
          "inflight": 5,
          "buffered": 0,
          "acknowledged": 142
        }
      ]
    }
  ]
}
```

---

## Phase 3: Tenant Quotas + Rate Limiting

**Goal**: Give operators tools to prevent abuse and manage resource allocation.

### 3.1 Tenant Quotas

New configuration and per-tenant overrides:

**Global defaults** (env vars):
- `DWN_QUOTA_MAX_MESSAGES` — Default max messages per tenant (0 = unlimited)
- `DWN_QUOTA_MAX_STORAGE_BYTES` — Default max data storage per tenant (0 = unlimited)
- `DWN_QUOTA_MAX_RECORDS_PER_PROTOCOL` — Default max records per protocol per tenant

**Per-tenant overrides** via admin API:

`PUT /admin/api/tenants/:did/quotas`
```json
{
  "maxMessages": 10000,
  "maxStorageBytes": 104857600,
  "maxRecordsPerProtocol": 5000
}
```

**Schema change**: New `tenantQuotas` table:
```sql
CREATE TABLE tenantQuotas (
  did TEXT PRIMARY KEY,
  maxMessages INTEGER,
  maxStorageBytes BIGINT,
  maxRecordsPerProtocol INTEGER
);
```

**Enforcement**: Extend `RegistrationManager.isActiveTenant()` or add a new `TenantGate` wrapper that checks quota before allowing writes. The DWN SDK calls `tenantGate.isActiveTenant()` on every `processMessage()`, so this is the natural hook. For more granular control (reject only writes, not reads), we may need a `preProcessMessage` hook in the DWN — this requires an SDK-level change (new optional `DwnConfig.messageInterceptor` interface).

### 3.2 Rate Limiting

New middleware that sits before the JSON-RPC handler:

- Per-IP rate limiting (token bucket, configurable via env vars)
- Per-tenant rate limiting (based on DID in the DWN message)
- Configurable burst and sustained rates
- Exempt list for known-good IPs/tenants

```typescript
export class RateLimiter {
  constructor(config: RateLimitConfig);
  checkIpLimit(ip: string): boolean;
  checkTenantLimit(did: string): boolean;
}
```

**Env vars:**
- `DWN_RATE_LIMIT_REQUESTS_PER_SECOND` — Per-IP sustained rate (default: 100)
- `DWN_RATE_LIMIT_BURST` — Per-IP burst allowance (default: 200)
- `DWN_RATE_LIMIT_TENANT_REQUESTS_PER_SECOND` — Per-tenant sustained rate (default: 50)

### 3.3 Admin Quota Management Endpoints

- `GET /admin/api/quotas/defaults` — View default quotas
- `PUT /admin/api/quotas/defaults` — Update default quotas (runtime, persisted to DB)
- `GET /admin/api/tenants/:did/quotas` — View tenant-specific quotas
- `PUT /admin/api/tenants/:did/quotas` — Set tenant-specific quotas
- `DELETE /admin/api/tenants/:did/quotas` — Reset to defaults

---

## Phase 4: Audit Log + Operational Tools

**Goal**: Persistent operational history and management tools.

### 4.1 Audit Log

A persistent, append-only log of significant admin and system events:

```sql
CREATE TABLE adminAuditLog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,          -- 'system' or admin identifier
  action TEXT NOT NULL,         -- 'tenant.suspend', 'tenant.delete', 'quota.update', etc.
  target TEXT,                  -- DID or resource identifier
  detail TEXT,                  -- JSON detail blob
  INDEX index_timestamp (timestamp),
  INDEX index_target (target)
);
```

Events logged:
- Tenant registered / suspended / unsuspended / deleted
- Quota updated
- Terms of service changed
- Server started / stopped
- Rate limit triggered (sampled, not every occurrence)
- Storage threshold warnings

`GET /admin/api/audit?since=<timestamp>&action=<filter>&target=<did>&limit=50`

### 4.2 Backup / Export

- `POST /admin/api/tenants/:did/export` — Export all data for a tenant as a downloadable archive
- `GET /admin/api/backup/status` — Status of last backup (if configured)

### 4.3 Runtime Configuration

Limited runtime configuration changes without restart:

`GET /admin/api/config` — View current (non-secret) configuration
`PATCH /admin/api/config` — Update select runtime-changeable settings:
  - `logLevel`
  - `maxRecordDataSize`
  - `maxInFlight`
  - Quota defaults
  - Rate limit settings
  - Terms of service (hot-reload)

### 4.4 Tenant Data Browser

`GET /admin/api/tenants/:did/messages?interface=Records&method=Write&limit=20`

Browse DWN messages for a tenant (metadata only, no decrypted content — encrypted data stays encrypted). Uses the existing `MessageStore.query()` interface.

`GET /admin/api/tenants/:did/protocols`

List installed protocols for a tenant with record counts per protocol path.

---

## Phase 5: Admin Web UI (Future)

**Goal**: A web-based dashboard served by the DWN server.

### 5.1 Approach

- Single-page application served from `/admin/` (static files bundled at build time)
- Communicates exclusively with the `/admin/api/*` REST endpoints
- Built with a lightweight framework (Preact or vanilla) to minimize bundle size
- Separate package in the monorepo: `packages/dwn-server-admin-ui/`

### 5.2 Dashboard Views

1. **Overview** — Server health, tenant count, storage usage, request rate charts
2. **Tenants** — Searchable list, per-tenant drill-down with storage, protocols, activity
3. **Connections** — Live WebSocket connections and subscriptions
4. **Events** — Recent activity stream with filtering
5. **Configuration** — View and edit runtime configuration
6. **Audit Log** — Searchable admin event history

### 5.3 Considerations

- The UI is optional — operators who prefer CLI/API are fully served by the REST API
- The UI build is separate from the server build; static assets are copied into `dist/`
- Authentication: the UI uses the same bearer token, stored in a session cookie with `httpOnly` + `secure` flags, obtained via a login form

---

## Implementation Plan — Phase 1 Breakdown

### Step 1: Config + Auth Foundation
1. Add `adminToken` / `adminTokenFile` to `config.ts`
2. Create `src/admin/admin-auth.ts` with constant-time token comparison
3. Write `tests/admin/admin-auth.test.ts`

### Step 2: Admin API Routing
1. Create `src/admin/admin-api.ts` with route dispatcher
2. Wire into `http-api.ts` — add `/admin/api/*` branch in `#route()`
3. Create `src/admin/types.ts` for request/response shapes
4. Write test that verifies 404 when admin is disabled, 401 with wrong token, 200 with correct token

### Step 3: Admin Store
1. Create `src/admin/admin-store.ts` with Kysely queries for cross-tenant stats
2. Wire into `DwnServer` setup — create `AdminStore` from same SQL dialect
3. Handle the LevelDB case (admin features require SQL backend — return appropriate errors)
4. Write `tests/admin/admin-store.test.ts`

### Step 4: Tenant List + Details
1. Extend `RegistrationStore` with `listTenants()` (paginated)
2. Implement `GET /admin/api/tenants` and `GET /admin/api/tenants/:did`
3. Implement aggregate queries in `AdminStore`
4. Write integration tests

### Step 5: Tenant Suspend / Delete
1. Add `suspended` column to `registeredTenants` (migration in `RegistrationStore.initialize()`)
2. Update `isActiveTenant()` to check `suspended`
3. Implement `POST /admin/api/tenants/:did/suspend` and `/unsuspend`
4. Implement `DELETE /admin/api/tenants/:did`
5. Write integration tests

### Step 6: Server Info Endpoints
1. Implement `GET /admin/api/health` (deep health check)
2. Implement `GET /admin/api/stats` (aggregated server statistics)
3. Write tests

### Testing Strategy
- All admin API tests use the existing test infrastructure (`getTestDwn()` pattern)
- Tests create a DWN with SQLite in-memory stores
- Auth tests verify token validation, timing-safe comparison, disabled state
- Integration tests verify end-to-end flows: register tenant -> list -> suspend -> verify 401 -> unsuspend -> verify 200

---

## File Tree (Phase 1)

```
packages/dwn-server/
  src/
    admin/
      admin-api.ts            # Route handler class
      admin-auth.ts           # Bearer token authentication
      admin-store.ts          # Cross-tenant SQL queries
      types.ts                # Admin API types
      index.ts                # Barrel exports
    config.ts                 # + adminToken config
    dwn-server.ts             # + AdminApi wiring
    http-api.ts               # + /admin/api/* routing
    dwn-error.ts              # + admin error codes
    registration/
      registration-store.ts   # + listTenants(), suspended column
      registration-manager.ts # + suspended check
  tests/
    admin/
      admin-api.test.ts       # API integration tests
      admin-auth.test.ts      # Auth middleware tests
      admin-store.test.ts     # Store query tests
```

---

## Open Questions

1. **LevelDB support**: The admin store needs cross-tenant queries which LevelDB cannot efficiently support. Options:
   - (a) Admin features require SQL backend — return 501 for LevelDB operators
   - (b) Add a separate small SQLite database just for admin metadata even when DWN uses LevelDB
   - **Recommendation**: Option (a) for v1, with a clear error message suggesting SQL backend

2. **Admin API on same port or separate port?**: Same port is simpler and preferred. A separate port would provide network-level isolation but adds operational complexity. 
   - **Recommendation**: Same port for v1. Operators can use firewall rules or reverse proxy to restrict `/admin/api/*` access.

3. **Tenant suspension vs. deletion semantics**: Should suspension be immediate (in-flight requests fail) or graceful (existing connections drain)?
   - **Recommendation**: Immediate. The DWN SDK checks `isActiveTenant()` on every message, so the next request will fail.

4. **Cross-tenant aggregate query performance**: Queries like `SELECT tenant, COUNT(*) FROM messageStoreMessages GROUP BY tenant` could be slow on large databases.
   - **Recommendation**: Cache results in the `AdminStore` with a configurable TTL (default 60 seconds). Add an `?refresh=true` query param to force recalculation.

5. **Multi-node / clustered deployments**: The in-memory components (ring buffer for events, rate limiter state) won't share state across nodes.
   - **Recommendation**: Document the single-node limitation. Phase 4+ can add Redis-backed implementations.
