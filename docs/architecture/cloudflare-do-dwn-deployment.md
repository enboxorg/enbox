# E2E DWN Deployment on Cloudflare Durable Objects

## Executive Summary

This document describes an edge-native, globally distributed DWN deployment on
Cloudflare Workers and Durable Objects. It is **Provider 5** in the multi-provider
strategy alongside Fly.io, AWS Simple, OVHcloud EU, and AWS+Nitro. The
architecture addresses three capabilities unique to this provider:

1. **Per-tenant physical isolation** — each tenant DID gets its own Durable Object
   with a private 10 GB SQLite database, eliminating cross-tenant data leakage by
   construction
2. **WebSocket firehose at scale** — 10,000+ concurrent connections, each
   subscribing to hundreds of tenants, with durable log replay in SQLite and
   cross-object wakes routed through NATS core pub/sub to hibernatable
   Connection DOs
3. **IPFS data layer** — unencrypted record data is stored in IPFS-native DAG-PB
   format, served over the IPFS bitswap protocol, and discoverable via the IPFS
   DHT — making the DWN provider a first-class IPFS peer

The design introduces three Durable Object classes (Tenant, Connection, Admin),
Cloudflare R2 for blob storage, NATS core pub/sub for cross-component wake
fan-out, Cloudflare Queues for async operations, and Helia (JS IPFS) running on
Fly.io as an R2-backed IPFS peer.

---

## 1. Architecture

```
                              Internet
                                 │
                    ┌────────────▼────────────────┐
                    │      Gateway Worker          │
                    │   (stateless, edge-deployed) │
                    │                              │
                    │   HTTP ──► Tenant DO (RPC)   │
                    │   WS  ──► Connection DO      │
                    │   /admin ──► Admin DO         │
                    └─────┬──────────┬─────────────┘
                          │          │
              ┌───────────▼──┐  ┌───▼────────────────┐
              │  Tenant DO   │  │  Connection DO      │
              │  (1 per DID) │  │  (sharded, ~10)     │
              │              │  │                     │
              │  SQLite:     │  │  Holds ~1K client   │
              │   messages   │  │  WebSockets each    │
              │   stateIndex │  │  (hibernatable)     │
              │   events     │  │                     │
              │   tasks      │  │  NATS subscriber    │
              │              │  │  (per unique tenant  │
              │  R2: blobs   │  │   + protocol-path)  │
              │              │  │                     │
              │  NATS:       │  │  Subscription       │
              │   publish on │  │  routing table:     │
              │   emit       │  │  tenant+filter →    │
              │              │  │  [socket, subId]    │
              └──────┬───────┘  └──────┬──────────────┘
                     │                 │
          ┌──────────┼─────────────────┼──────────────┐
          │          │                 │              │
          ▼          ▼                 ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
    │    R2    │  │  Queues  │  │   NATS   │  │  Helia   │
    │  (blobs) │  │  (async) │  │ wake bus │  │  (IPFS)  │
    │          │  │          │  │          │  │          │
    │  shared  │  │ delivery │  │ 3-region │  │  R2-back │
    │  bucket  │  │ ipfs-ann │  │ super-   │  │  Fly.io  │
    │          │  │          │  │ cluster  │  │          │
    └──────────┘  └──────────┘  └──────────┘  └──────────┘
```

### Multi-Provider Context

| # | Provider | Region | Architecture | Unique Strength |
|---|---|---|---|---|
| 1 | Fly.io | US East | Docker + Postgres | Simple, cheap |
| 2 | AWS Simple | US East | ECS + RDS | Production-grade infra |
| 3 | OVHcloud EU | EU (France) | K8s + SEV-SNP | EU sovereign, TEE |
| 4 | AWS + Nitro | US | ECS + Aurora + Enclaves | Confidential compute |
| **5** | **Cloudflare** | **Global** | **DOs + R2 + NATS** | **Edge-native, per-tenant isolation, IPFS, firehose** |

A user's DID document lists endpoints from multiple providers. Providers can
share a NATS super-cluster for low-latency wake propagation, but durable replay
and cursor validation stay in each provider's Level/SQL-compatible message
store. SMT reconciliation provides the correctness backstop regardless of
delivery path.

---

## 2. Component Deep-Dives

### 2.1 Tenant Durable Objects — Per-DID Storage Engine

Each tenant DID gets a dedicated Durable Object with its own SQLite database
(up to 10 GB) and R2 access for large blobs.

**DO identification:**
```typescript
const doId = env.TENANT_NS.idFromName(tenantDid);
const stub = env.TENANT_NS.get(doId);
```

**Lifecycle:**
```
First request for did:alice → Cloudflare creates Tenant DO
  → constructor(): initialize DWN engine
  → Dwn.create(config) with DO-native stores
  → open() on all stores (CREATE TABLE IF NOT EXISTS)

Subsequent requests → routed to same DO instance
  → single-threaded execution (no concurrency races)

Idle timeout → DO hibernates (SQLite persists, memory freed)

Next request → DO re-instantiates
  → constructor() re-runs, Dwn.create() re-runs
  → SQLite data is still there (persistent)
```

**Store implementations:**

The DWN engine (`@enbox/dwn-sdk-js`) requires five store interfaces. Each is
implemented using DO SQLite (via `ctx.storage.sql`) with the **identical schema**
as `@enbox/dwn-sql-store`. The `tenant` column is retained on every table for
schema compatibility — it is always set to the DO's own DID, making the schema
identical across DO SQLite and Postgres-backed providers. This enables data
portability: a DO's SQLite can be exported and imported into Postgres (or vice
versa) with no schema translation.

| DWN Interface | DO Implementation | Storage |
|---|---|---|
| `MessageStore` | `MessageStoreDOSql` | DO SQLite (same schema as `MessageStoreSql`) |
| `DataStore` | `DataStoreDOR2` | DO SQLite for refs + R2 for blobs > 30 KB |
| `StateIndex` | `StateIndexDOSql` | DO SQLite (reuses `SMTStoreSql` patterns) |
| `ResumableTaskStore` | `ResumableTaskStoreDOSql` | DO SQLite |
| `EventLog` | `DurableEventLogDOSql` | Store-backed replay/cursors + in-memory `mitt` for live pub/sub |
| `TenantGate` | N/A | Gateway Worker checks registration before routing |

**Key simplification from single-threaded execution:**
- `ResumableTaskStore.grab()` does not need transactions — no concurrent workers
- In-DO live subscription fan-out is race-free — emit and subscribe in same context
- `StateIndex` SMT updates need no locking

**SQLite schema:**

Identical to `dwn-sql-store` migrations (same tables, same columns, same
indexes). The `tenant` column is present but always set to the DO's own DID.

```sql
-- Messages (identical to dwn-sql-store messageStoreMessages)
CREATE TABLE messageStoreMessages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  messageCid TEXT NOT NULL,
  encodedMessageBytes BLOB NOT NULL,
  encodedData TEXT,
  interface TEXT,
  method TEXT,
  schema TEXT,
  dataCid TEXT,
  dataSize INTEGER,
  dateCreated TEXT,
  messageTimestamp TEXT,
  dataFormat TEXT,
  isLatestBaseState INTEGER,
  published INTEGER,
  author TEXT,
  recordId TEXT,
  entryId TEXT,
  datePublished TEXT,
  protocol TEXT,
  protocolPath TEXT,
  recipient TEXT,
  contextId TEXT,
  parentId TEXT,
  permissionGrantId TEXT,
  prune INTEGER,
  squash INTEGER,
  attester TEXT,
  seq INTEGER NOT NULL,
  redeliverSeq INTEGER,
  fingerprintScopes TEXT NOT NULL,
  UNIQUE(tenant, messageCid)
);

-- Same indexes as dwn-sql-store
CREATE INDEX idx_tenant_recordId ON messageStoreMessages(tenant, recordId);
CREATE INDEX idx_tenant_entryId ON messageStoreMessages(tenant, entryId);
CREATE INDEX idx_tenant_parentId ON messageStoreMessages(tenant, parentId);
CREATE INDEX idx_tenant_protocol ON messageStoreMessages(tenant, protocol, published, messageTimestamp);
CREATE INDEX idx_tenant_interface ON messageStoreMessages(tenant, interface);
CREATE INDEX idx_tenant_permGrant ON messageStoreMessages(tenant, permissionGrantId);
CREATE INDEX idx_tenant_dateCreated ON messageStoreMessages(tenant, dateCreated);
CREATE INDEX idx_tenant_datePub ON messageStoreMessages(tenant, datePublished);
CREATE INDEX idx_tenant_contextId ON messageStoreMessages(tenant, contextId, messageTimestamp);
CREATE INDEX idx_tenant_seq ON messageStoreMessages(tenant, seq);
CREATE INDEX idx_tenant_redeliverSeq ON messageStoreMessages(tenant, redeliverSeq);
CREATE INDEX idx_tenant_protocol_seq ON messageStoreMessages(tenant, protocol, seq);

-- Tags (identical to dwn-sql-store messageStoreRecordsTags)
CREATE TABLE messageStoreRecordsTags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL,
  messageInsertId INTEGER NOT NULL REFERENCES messageStoreMessages(id) ON DELETE CASCADE,
  valueString TEXT,
  valueNumber REAL
);
CREATE INDEX idx_tags_msgId ON messageStoreRecordsTags(messageInsertId);
CREATE INDEX idx_tags_str ON messageStoreRecordsTags(tag, valueString);
CREATE INDEX idx_tags_num ON messageStoreRecordsTags(tag, valueNumber);

-- Data references (identical to dwn-sql-store dataRefs)
CREATE TABLE dataRefs (
  tenant TEXT NOT NULL,
  recordId TEXT NOT NULL,
  dataCid TEXT NOT NULL,
  dataSize INTEGER NOT NULL,
  UNIQUE(tenant, recordId, dataCid)
);
CREATE INDEX idx_dataRefs_cid ON dataRefs(dataCid);
CREATE INDEX idx_dataRefs_tenant ON dataRefs(tenant);

-- Data blocks (identical to dwn-sql-store dataBlocks)
CREATE TABLE dataBlocks (
  rootDataCid TEXT NOT NULL,
  blockCid TEXT NOT NULL,
  data BLOB NOT NULL,
  UNIQUE(rootDataCid, blockCid)
);

-- SMT nodes (identical to dwn-sql-store stateIndexNodes)
CREATE TABLE stateIndexNodes (
  tenant TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  nodeHash TEXT NOT NULL,
  nodeType TEXT NOT NULL,
  leftHash TEXT,
  rightHash TEXT,
  leafKeyHash TEXT,
  leafValueCid TEXT
);
CREATE INDEX idx_smt_nodes ON stateIndexNodes(tenant, scope, nodeHash);

-- SMT roots (identical to dwn-sql-store stateIndexRoots)
CREATE TABLE stateIndexRoots (
  tenant TEXT NOT NULL,
  scope TEXT NOT NULL,
  rootHash TEXT NOT NULL
);
CREATE INDEX idx_smt_roots ON stateIndexRoots(tenant, scope);

-- SMT metadata (identical to dwn-sql-store stateIndexMeta)
CREATE TABLE stateIndexMeta (
  tenant TEXT NOT NULL,
  messageCid TEXT NOT NULL,
  protocol TEXT
);
CREATE INDEX idx_smt_meta ON stateIndexMeta(tenant, messageCid);

-- Resumable tasks (identical to dwn-sql-store resumableTasks)
CREATE TABLE resumableTasks (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  timeout INTEGER NOT NULL,
  retryCount INTEGER DEFAULT 0
);
CREATE INDEX idx_tasks_timeout ON resumableTasks(timeout);

-- Durable replication log metadata
CREATE TABLE replicationCounters (
  tenant TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

CREATE TABLE replicationFingerprints (
  tenant TEXT NOT NULL,
  scope TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  UNIQUE(tenant, scope)
);

CREATE TABLE replicationMeta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- IPFS pin status tracking
CREATE TABLE ipfsPinStatus (
  dataCid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  announcedAt TEXT,
  blockCount INTEGER,
  totalSize INTEGER,
  UNIQUE(dataCid)
);
```

**NATS wake publish after commit:**

When a RecordsWrite, ProtocolsConfigure, or RecordsDelete commits, the Tenant
DO:

1. Inserts the message row into SQLite with a monotonic per-tenant `seq`
2. Fires `mitt` for any in-DO live subscribers (local WebSocket, if any)
3. Publishes a best-effort wake to NATS via `wsconnect()`:
   ```
   dwn.wakes.{tenant-token}
   ```

The wake payload contains only `{ tenant, seq }`. The NATS connection is opened
lazily on first publish and reused. If the DO hibernates, the connection is
lost; on wake, it reconnects. SQLite provides the durable replication log;
NATS is a wake mechanism, not the replay source or cursor authority.

**R2 integration for large data:**

```
Write (RecordsWrite, data > 30 KB, unencrypted):
  → Stream data through UnixFS importer (fixedSize 262144)
  → Store DAG-PB blocks in R2: key = {dataCid}/{blockCid}
  → Store dataRef in SQLite: (tenant, recordId, dataCid, dataSize)
  → Enqueue IPFS announce: { dataCid, blockCids }

Write (RecordsWrite, data > 30 KB, encrypted):
  → Store ciphertext in R2: key = {dataCid} (single object, not DAG-PB)
  → Store dataRef in SQLite
  → No IPFS announce (ciphertext is useless without decryption keys)

Read:
  → Check SQLite dataRef for dataCid
  → If data <= 30 KB: return encodedData from messageStoreMessages
  → If data in R2: fetch blocks, reassemble via UnixFS exporter, stream
  → If data NOT in R2 (relay/cache mode): fetch from IPFS network (see 2.6)
```

**Alarm-based scheduling:**

Each Tenant DO uses a single alarm (multiplexed via the multi-event pattern)
for:
- Resumable task processing (check for timed-out tasks, resume)
- Event log trimming (delete events older than retention window)
- Periodic stats reporting to Admin DO

---

### 2.2 Connection Durable Objects — WebSocket Firehose

Connection DOs are the fan-out layer between NATS and client WebSockets.
They solve the problem that a single client WebSocket targets multiple tenant
DIDs — the DWN protocol routes by per-message `target`, not per-connection.

**Multi-tenant WebSocket protocol:**

The current DWN server already supports multi-tenant connections. Each JSON-RPC
message carries its own `target` DID in `params`. A single WebSocket connection
can interleave messages for `did:alice`, `did:bob`, `did:carol` — all multiplexed
via unique `JsonRpcId` values. Rate limiting and quota enforcement are per-message
`target`, not per-connection. This is unchanged.

**Sharding:**

Connections are distributed across ~10 Connection DOs by hashing a connection
identifier (IP + random salt). Each DO holds ~1,000 WebSocket connections.
With 10 DOs, the system supports ~10,000 concurrent connections.

```typescript
const shardId = hash(requestIP + connectionSalt) % NUM_SHARDS;
const doId = env.CONNECTION_NS.idFromName(`shard-${shardId}`);
```

**WebSocket lifecycle with hibernation:**

```
Client WS upgrade → Gateway Worker → Connection DO
  → ctx.acceptWebSocket(ws)
  → ws.serializeAttachment({ subscriptions: [] })

Client sends JSON-RPC subscribe { target: did:alice, filter: {...} }:
  → Parse filter and record durable-log cursor
  → If no existing NATS wake sub for this tenant:
      Open NATS core subscription to dwn.wakes.{tenant-token}
  → Add (socketId, subscriptionId, clientFilter) to routing table
  → Store subscription state in ws.serializeAttachment()

NATS delivers wake:
  → Connection DO receives { tenant, seq }
  → Drain the Tenant DO durable log from each subscription cursor
  → For each durable event: evaluate client-side filters
    (recipient, author, contextId, published, tags, date ranges)
  → Send matching events to matching sockets

All clients idle → Connection DO hibernates:
  → Client WebSockets stay connected at Cloudflare edge
  → Outbound NATS connection drops (outbound WS does not hibernate)
  → Last durable-log cursor stored in socket attachment / DO state

Client sends message → Connection DO wakes:
  → constructor() re-runs
  → Rebuild subscription state from ws.serializeAttachment()
     on each connected socket (ctx.getWebSockets())
  → Reconnect to NATS wake subjects
  → Drain missed events from Tenant DO durable log cursors
  → Resume normal operation
```

**Subscription deduplication:**

If 500 clients on the same Connection DO all subscribe to
`did:alice / protocol:social / protocolPath:post`, the Connection DO creates
**one** NATS wake subscription for:
```
dwn.wakes.did~alice
```

When a wake arrives, it drains the Tenant DO durable log once and evaluates 500
client-side filters (cheap in-memory property matching using the same
`FilterUtility.matchAnyFilter` from `dwn-sdk-js`) against the durable entries.

This is the key efficiency: NATS handles **inter-DO wake routing**, the Tenant
DO remains the source of truth for replay, and the Connection DO handles
**intra-DO** fan-out to sockets.

**Non-subscribe messages (RecordsWrite, RecordsQuery, etc.):**

For write/query operations received over WebSocket, the Connection DO extracts
the `target` DID and forwards to the appropriate Tenant DO via RPC:

```typescript
const tenantDo = env.TENANT_NS.get(env.TENANT_NS.idFromName(target));
const response = await tenantDo.processMessage(message, dataStream);
// Send JSON-RPC response back over the client WebSocket
```

`RecordsWrite` remains HTTP-only (requires data stream in request body), as
in the current server. The Connection DO enforces this transport restriction.

---

### 2.3 NATS Wake Subjects and Delivery Integration

NATS carries wake notifications only. Durable event replay, filtering, and
cursor validation stay in the Tenant DO's SQLite-backed message store.
Multi-party record delivery still uses Queues and provider-to-provider DWN
messages; NATS wakes are only the low-latency signal that a tenant has new
durable rows.

**Subject format:**
```
dwn.wakes.{tenant-token}
```

**Encoding:**
- `tenant-token`: DID encoded for NATS subjects using the same safe token rules
  as the server `NatsEventBus`
- Wake payload: `{ tenant, seq }`, where `seq` is the committed durable-log
  position for the tenant

**Examples:**
```
dwn.wakes.did~dht~alice
dwn.wakes.did~dht~bob
dwn.wakes.did~dht~carol
```

**Subscription mapping (RecordsSubscribe filters → durable log reads):**

| Client subscription filter | NATS wake subject | Filtering source |
|---|---|
| `{protocol: "social/v1", protocolPath: "thread/reply"}` on `did:alice` | `dwn.wakes.did~dht~alice` | Tenant DO durable log, filtered by indexes |
| `{protocol: "social/v1"}` on `did:alice` (all paths) | `dwn.wakes.did~dht~alice` | Tenant DO durable log, filtered by indexes |
| All records for `did:bob` | `dwn.wakes.did~dht~bob` | Tenant DO durable log, filtered by indexes |
| All events for `did:carol` (MessagesSubscribe) | `dwn.wakes.did~dht~carol` | Tenant DO durable log |

**Server-side vs. client-side filtering:**

NATS routes only by tenant. The Connection DO evaluates subscription filters
against durable log entries after it drains the Tenant DO from the stored
cursor:

| Dimension | Filtering Layer | Why |
|---|---|---|
| `tenant` | NATS wake subject + durable log | Wakes are tenant-scoped; replay validates against the tenant log |
| `interface` | Connection DO / durable indexes | Read from the store entry, not from NATS |
| `method` | Connection DO / durable indexes | Read from the store entry, not from NATS |
| `protocol` | Connection DO / durable indexes | Medium cardinality, store-indexed |
| `protocolPath` | Connection DO / durable indexes | Medium cardinality, store-indexed |
| `recipient` | Connection DO | High cardinality (DID strings) |
| `author` | Connection DO | High cardinality |
| `contextId` | Connection DO | Prefix matching, high cardinality |
| `published` | Connection DO | Boolean, low cardinality but often combined |
| `schema` | Connection DO | Overlaps with protocolPath |
| `tags.*` | Connection DO | Unbounded key-value space |
| `dateCreated/datePublished` | Connection DO | Range filters, continuous |
| `dataFormat/dataSize` | Connection DO | Low value for routing |

**`$delivery` integration:**

The three delivery strategies from `proposals/dwn-delivery-and-sync.md` map
naturally to this infrastructure:

| Strategy | Implementation |
|---|---|
| **Direct** (`$delivery: "direct"`) | Tenant DO enqueues delivery task to `dwn-delivery` Queue. Consumer Worker resolves participant DIDs → provider endpoints, groups by provider, sends message once per provider via `processMessage()`. |
| **Relay** (`$delivery: "relay"`) | Same as Direct, but Consumer Worker computes rendezvous hash to determine relay coordinator assignment. Sends to k coordinators who forward to their assigned providers. |
| **Subscribe** (`$delivery: "subscribe"`) | Remote providers' Connection DOs subscribe to the origin tenant's NATS wake subject, then read from the origin provider's durable log/API as needed. This is the firehose wake path — no Queue needed, but payload and cursor authority stay out of NATS. Provider-grouped: one wake subscription per remote provider (not per user). |

**SMT reconciliation backstop:** All three strategies are latency optimizations.
The `StateIndex` (SMT) in each Tenant DO provides the correctness guarantee.
Periodic SMT root comparison between providers (via the sync daemon or delegated
sync grants) detects and repairs any divergence.

---

### 2.4 NATS Topology — Multi-Cloud Wake Super-Cluster

NATS core pub/sub runs as a 3-region super-cluster colocated with existing
infrastructure. Connection DOs and Tenant DOs connect via WebSocket
(`@nats-io/nats-core` `wsconnect()`). NATS owns no durable replay state.

```
┌───────────────────────┐  gateways  ┌───────────────────────┐
│  AWS us-east-1        │◄──────────►│  GCP europe-west1     │
│  cluster: aws-east    │            │  cluster: gcp-eu      │
│  3 NATS nodes         │            │  3 NATS nodes         │
│  core pub/sub         │            │  core pub/sub         │
│  unique_tag: az       │            │  unique_tag: az       │
│                       │            │                       │
│  subjects:            │  gateways  │  subjects:            │
│   dwn.wakes.>         │◄──────────►│   dwn.wakes.>         │
│                       │            │                       │
└──────────┬────────────┘            └──────────┬────────────┘
           │ leaf connections                   │
      ┌────┴──────────┐                   ┌────┴──────────┐
      │ Fly.io (iad)  │                   │ Fly.io (ams)  │
      │ leaf nodes    │                   │ leaf nodes    │
      │ + Helia IPFS  │                   │ + Helia IPFS  │
      └───────────────┘                   └───────────────┘
              ▲                                   ▲
              │ wsconnect()                       │
      ┌───────┴───────────────────────────────────┴───────┐
      │            Cloudflare Durable Objects              │
      │  Tenant DOs (publish)   Connection DOs (subscribe) │
      └───────────────────────────────────────────────────┘
```

**Key design:**

- **Tenant-scoped wake subjects** (`dwn.wakes.{tenant-token}`) carry only wake
  metadata. Writes always commit to the local durable store before publishing a
  wake.
- **Interest-only gateways**: inter-region traffic flows only for subjects with
  active subscribers in the remote cluster. If no one in EU subscribes to a US
  tenant, zero cross-region traffic.
- **Leaf nodes** for Fly.io: initiate outbound connections (no public gateway
  ports needed).
- **WebSocket listeners** enabled on all NATS nodes (port 443 with TLS) for
  Cloudflare DO connectivity.

**Wake contract:**
- NATS wake delivery is best-effort and may be duplicated or dropped.
- Subscribers resume from durable log cursors held by the Tenant DO/store.
- NATS sequence numbers are never exposed as DWN replication cursors.
- Idle re-drain from the durable log is the missed-wake backstop.

**Failure modes:**

| Failure | Impact | Recovery |
|---|---|---|
| 1 NATS node in cluster | Wake fan-out continues through remaining nodes | Auto-heal through NATS clustering |
| Entire region cluster | Local durable writes continue; cross-process wakes in that region are degraded | Region recovery → NATS reconnects; subscribers drain durable logs |
| Network partition (inter-region) | Regions operate independently. Cross-region wakes pause. | Partition heals → gateways reconnect → interest propagates |
| Cloudflare → NATS disconnect | DO misses wakes while disconnected | Reconnect or idle re-drain → catch up from durable log cursor |

**NATS client library:**

DOs use `@nats-io/nats-core` with `wsconnect()` (W3C WebSocket transport). This
is the same NATS client used in browsers and Deno — no Node.js `net` module
required.

---

### 2.5 Gateway Worker — Stateless Edge Router

A Cloudflare Worker with a `fetch()` handler that routes requests to the
appropriate Durable Object. No `Bun.serve()`, no `process.env`, no filesystem.
Configuration comes from `wrangler.toml` environment bindings.

**Route table:**

| Method | Path | Handler |
|---|---|---|
| `POST` | `/` | JSON-RPC → extract `target` DID → Tenant DO via RPC |
| `GET` | `/:did/read/records/:id` | REST read → Tenant DO |
| `GET` | `/:did/query/*` | REST query → Tenant DO |
| `GET` | `/:did/read/protocols/:protocol/*` | REST protocol read → Tenant DO |
| `GET` | `/:did/query/protocols` | REST protocol query → Tenant DO |
| WebSocket upgrade | `/` | → Connection DO (sharded) |
| `GET/POST` | `/admin/api/*` | → Admin DO |
| `GET` | `/admin/*` | Admin UI from Workers Sites |
| `GET` | `/info` | Server info JSON (version, registration, provider auth URLs) |
| `GET` | `/health` | Health check |
| `GET` | `/metrics` | Prometheus-compatible metrics (admin-auth gated) |
| `POST` | `/registration` | Tenant registration → Admin DO |
| `GET` | `/registration/proof-of-work` | PoW challenge → Admin DO |
| `GET` | `/registration/terms-of-service` | Terms of service text |
| `POST` | `/connect/par` | Pushed Authorization Request → KV/D1 |
| `GET` | `/connect/authorize/:id.jwt` | Retrieve connect request JWT |
| `POST` | `/connect/callback` | Store connect response |
| `GET` | `/connect/token/:state.jwt` | Retrieve connect response JWT |
| `POST` | `/provider-auth/authorize` | Open-auth authorization |
| `POST` | `/provider-auth/token` | Open-auth token exchange |
| `POST` | `/provider-auth/refresh` | Open-auth token refresh |
| `OPTIONS` | `*` | CORS preflight (204) |

**Rate limiting:** Cloudflare's built-in rate limiting rules (configured in
`wrangler.toml` or dashboard) for per-IP throttling, plus per-tenant rate
limiting enforced within the Tenant DO's `processMessage` handler.

**CORS:** Wildcard `Access-Control-Allow-Origin: *` on non-admin routes, with
24-hour preflight caching (`Access-Control-Max-Age: 86400`).

---

### 2.6 IPFS Data Layer

For unencrypted record data, the DWN provider acts as a first-class IPFS peer.
Data stored via normal DWN operations is discoverable and retrievable through
the IPFS protocol — transparent to DWN users.

**CID format alignment:**

| Parameter | Value | Notes |
|---|---|---|
| CID version | CIDv1 | Modern IPFS standard |
| Data codec | `dag-pb` (0x70) | UnixFS standard |
| Hash function | SHA-256 | Universal |
| Chunker | `fixedSize(262144)` | 256 KiB — IPFS default, avoids rabin-wasm in Workers |
| Layout | `balanced` | Default UnixFS tree layout |
| Max links | 174 | Default UnixFS |

With these parameters, a file chunked by the DWN produces the **exact same CID**
as the same file added to any standard IPFS node with default settings. Files
added via DWN are fetchable from any IPFS gateway (e.g.,
`https://ipfs.io/ipfs/{cid}`), and IPFS-native clients (like Brave browser)
can resolve DWN data natively.

**Architecture:**

```
Tenant DO (write path)                         IPFS Network
  │                                                │
  ├── R2: store DAG-PB blocks                      │
  │   key: {dataCid}/{blockCid}                    │
  │                                                │
  ├── Queue: ipfs-announce                         │
  │   { dataCid, blockCids, totalSize }            │
  │                                                │
  └──────────────► Pin Worker ──────► Helia ────────┤
                   (consumer)        (Fly.io)       │
                                       │            │
                                       ├── dht.provide(dataCid)
                                       │   "I have this CID"
                                       │            │
                                       └── bitswap server
                                           serves blocks from R2
                                                    │
                                     External IPFS node
                                       ├── DHT lookup → finds Helia
                                       ├── bitswap WANT {blockCid}
                                       ├── Helia fetches from R2
                                       └── receives block
```

**Helia (JS IPFS) on Fly.io:**

Helia runs on the same Fly.io machines as the NATS leaf nodes. It uses a
custom R2-backed blockstore that is **read-only** — Tenant DOs are the sole
writers to R2, and Helia serves as a read-only gateway from the IPFS network
into R2:

```typescript
class R2Blockstore implements Blockstore {
  async get(cid: CID): Promise<Uint8Array> {
    const key = `${rootCidFromIndex(cid)}/${cid.toString()}`;
    const obj = await this.r2.get(key);
    if (!obj) throw new Error(`Block not found: ${cid}`);
    return new Uint8Array(await obj.arrayBuffer());
  }

  async has(cid: CID): Promise<boolean> {
    const head = await this.r2.head(cidToKey(cid));
    return head !== null;
  }

  async put(cid: CID, block: Uint8Array): Promise<CID> {
    // No-op: Tenant DOs are the only writers to R2.
    return cid;
  }
}
```

**Write path (Tenant DO):**

1. `RecordsWrite` arrives with unencrypted data
2. Tenant DO chunks data via UnixFS importer (`fixedSize(262144)`)
3. DAG-PB blocks stored in R2: key = `{dataCid}/{blockCid}`
4. `dataRef` recorded in SQLite: `(tenant, recordId, dataCid, dataSize)`
5. Enqueue IPFS announce: `env.IPFS_QUEUE.send({ dataCid, blockCids, totalSize })`

**IPFS announce path (async, via Queue):**

1. Pin Worker (Queue consumer) receives `{ dataCid, blockCids }`
2. Calls `helia.routing.provide(dataCid)` — announces to the IPFS DHT
3. Updates `ipfsPinStatus` in Tenant DO via RPC: `status = 'announced'`

**IPFS read path (external IPFS nodes):**

1. External IPFS node looks up CID in the DHT → finds our Helia peer
2. External node sends bitswap WANT for the root CID or specific block CIDs
3. Helia fetches the block from R2: `GET {dataCid}/{blockCid}`
4. Returns block via bitswap
5. External node reassembles the UnixFS DAG

**DWN read path (unchanged for normal operation):**

DWN clients read via the standard DWN API (HTTP or WS). No IPFS involved.
The Tenant DO reads from R2 directly.

**IPFS as read fallback (relay/cache mode):**

When a Tenant DO operates in cache mode (per `proposals/constrained-dwn-relay-cache.md`),
it stores only message envelopes and SMT data — record data may not be in R2.
On `RecordsRead`:

```
RecordsRead → check R2 for dataCid → miss
  → check ipfsPinStatus: was this CID announced to IPFS?
  → if announced: fetch from Helia peer (HTTP gateway)
    → stream to client
    → optionally re-cache in R2 for future reads
  → if not announced: return 404 with initialWrite
    (client can try another endpoint from the DID document)
```

This makes relay/cache nodes truly viable: they don't need the full dataset
because the IPFS network (backed by R2 at the source providers) serves as the
persistence layer for public unencrypted data.

**Selective announcement — unencrypted only:**

Only unencrypted data is announced to IPFS. Encrypted record ciphertext is
stored in R2 but never published to the DHT — the ciphertext is useless without
decryption keys, and announcing it would leak metadata about encrypted record
existence.

```typescript
// In Tenant DO, after successful RecordsWrite:
if (message.encryption === undefined) {
  await env.IPFS_QUEUE.send({ dataCid, blockCids, totalSize });
}
```

---

### 2.7 Admin and Registration

**Admin DO (single instance):**

A dedicated DO class for cross-tenant operations. Receives stats from Tenant
DOs via RPC and stores aggregated data in its own SQLite.

| Function | Implementation |
|---|---|
| Tenant registration | SQLite `registeredTenants` table (same schema as `dwn-server`) |
| Tenant listing/search | Aggregated `tenantStats` table, updated by Tenant DOs |
| Quota management | SQLite `tenantQuotas` table |
| Audit log | SQLite `adminAuditLog` table with retention policy |
| Proof-of-work | Challenge generation/verification (single-threaded, no race conditions) |
| Provider auth (JWT) | `jose` library validates tokens (pure JS, Workers-compatible) |
| Passkey auth (WebAuthn) | `@simplewebauthn/server` for admin passkey login |

**Stats aggregation:**

Each Tenant DO periodically (via alarm, every 60s when active) reports stats
to the Admin DO:

```typescript
// In Tenant DO alarm handler:
const stats = {
  tenantDid    : this.tenantDid,
  messageCount : await this.sql.exec('SELECT COUNT(*) FROM messageStoreMessages').one(),
  dataSize     : await this.sql.exec('SELECT COALESCE(SUM(dataSize),0) FROM dataRefs').one(),
  lastActivity : new Date().toISOString(),
};
const adminDo = env.ADMIN_NS.get(env.ADMIN_NS.idFromName('admin'));
await adminDo.reportStats(stats);
```

The Admin DO stores these in a `tenantStats` table for admin API queries. This
is eventually consistent (up to 60s lag) but sufficient for admin operations.

---

## 3. Crypto and Dependency Compatibility

All cryptographic operations used by the DWN SDK work in the Cloudflare Workers
runtime:

| Operation | Library | Workers Compatible |
|---|---|---|
| Ed25519 sign/verify | `@noble/ed25519` | Yes (pure JS) |
| X25519 key agreement | `@noble/curves/ed25519` | Yes (pure JS) |
| secp256k1 sign/verify | `@noble/secp256k1` | Yes (pure JS) |
| P-256 sign/verify | `@noble/curves/p256` | Yes (pure JS) |
| AES-256-GCM | Web Crypto (`crypto.subtle`) | Yes (native) |
| AES-256-KW (key wrap) | Web Crypto | Yes (native) |
| XChaCha20-Poly1305 | `@noble/ciphers` | Yes (pure JS) |
| ECDH-ES+A256KW | Web Crypto | Yes (native) |
| SHA-256 | Web Crypto / `@noble/hashes` | Yes |
| HKDF, PBKDF2 | Web Crypto | Yes |
| ConcatKDF | `@noble/hashes/sha256` | Yes (pure JS) |
| CBOR encoding | `@ipld/dag-cbor`, `cborg` | Yes (pure JS) |
| CID computation | `multiformats` | Yes (pure JS) |
| JSON Schema validation | `ajv` | Yes (pure JS) |
| IPFS UnixFS chunking | `ipfs-unixfs-importer` | Yes (with `fixedSize` chunker) |
| DID resolution | `@enbox/dids` (fetch-based) | Yes |

**Blockers resolved:**

| Blocker | Resolution |
|---|---|
| `level` / `classic-level` (native C++) | Replaced by DO SQLite |
| `process.env` in `did-dht.ts` | Pass gateway URI via wrangler env bindings |
| `rabin-wasm` WASM loading | Use `fixedSize(262144)` chunker (also aligns CID format with IPFS) |
| `Bun.serve()`, `fs`, `process.on` | Not used — Gateway Worker uses `fetch()` handler |
| NATS `@nats-io/transport-node` | Use `@nats-io/nats-core` `wsconnect()` (W3C WebSocket) |

---

## 4. Cross-Provider Integration

### 4.1 DID Document Service Endpoints

A user with endpoints at Cloudflare and AWS:

```json
{
  "service": [{
    "id": "#dwn",
    "type": "DecentralizedWebNode",
    "serviceEndpoint": [
      "https://dwn.cf.enbox.id",
      "https://us-east.dwn.enbox.id"
    ]
  }]
}
```

Both providers register the tenant. Writes to either endpoint propagate to the
other through store-backed sync, with NATS used only as a low-latency wake when
both providers are connected to the same super-cluster.

### 4.2 Sync Between Providers

**Real-time wake path (NATS-connected providers):**

When a write lands at the CF Tenant DO, it commits to the durable log and then
publishes a NATS wake. The AWS provider's DWN instances (subscribed to the same
NATS super-cluster) receive the wake and pull from the durable source of truth.
This is the `$delivery: "subscribe"` path applied to same-tenant
cross-provider sync.

**Fallback (non-NATS providers or network partitions):**

The sync daemon (from `infra/multi-region-plan.md`) runs as a separate service,
subscribes to local NATS wakes, resolves tenant DID endpoints, reads new rows
from the local durable log, and pushes messages to peer providers via standard
replicated DWN APIs over HTTPS. Loop prevention relies on DWN idempotency.

**Correctness backstop:**

Periodic SMT root comparison between providers detects any divergence regardless
of delivery mechanism. The `StateIndex` in each provider's store independently
maintains the same Sparse Merkle Tree. Identical message sets produce identical
root hashes regardless of storage backend.

---

## 5. Cloudflare Platform Limits and Mitigations

| Constraint | Limit | Impact | Mitigation |
|---|---|---|---|
| SQLite per DO | 10 GB | Heavy tenants with millions of records | R2 for all data blobs; 10 GB of indexes supports millions of records |
| Row/value size | 2 MB | Individual records > 2 MB can't be inline | Already handled: data > 30 KB goes to R2 |
| Memory per isolate | 128 MB | Can't buffer large responses | Streaming via ReadableStream (already how DWN works) |
| Outbound connections | 6 simultaneous | Limits parallel fan-out from single DO | NATS uses single connection; delivery via Queue consumers |
| LIKE/GLOB pattern | 50 bytes | Prefix filter patterns limited | Use range queries (`>=` / `<`) instead of LIKE |
| CPU per request | 30s default, 5 min max | Complex operations | DWN message processing uses ~2-50ms typically |
| Code deploy | Disconnects all WebSockets | Subscription interruption | Client reconnection with cursor (standard DWN behavior) |
| WebSockets per DO | ~thousands | Connection DO capacity | Shard across ~10 Connection DOs |
| DO requests/sec | ~1,000 soft limit | Hot tenants | Acceptable; individual tenants rarely exceed this |
| Columns per table | 100 | DWN schema fitness | Well within limit (~25 columns on largest table) |
| Max SQL statement | 100 KB | Large batch inserts | Batch in smaller groups |
| Max bound parameters | 100 | Complex filter queries | DWN queries typically use < 20 parameters |

---

## 6. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-3)

| Task | Description |
|---|---|
| `wrangler.toml` + project scaffold | Worker + 3 DO classes (Tenant, Connection, Admin), R2 bucket, Queue bindings |
| DO SQLite Dialect | Adapter for `ctx.storage.sql` compatible with `dwn-sql-store` query patterns |
| `MessageStoreDOSql` | Port `MessageStoreSql` to use DO SQLite. Same schema, same query logic. |
| `DataStoreDOR2` | SQLite for refs, R2 for blobs. UnixFS importer with `fixedSize(262144)`. |
| `StateIndexDOSql` | Port `StateIndexSql` + `SMTStoreSql` to DO SQLite. |
| `ResumableTaskStoreDOSql` | Port `ResumableTaskStoreSql`. Simplified `grab()` (no transactions needed). |
| `DurableEventLogDOSql` | Store-backed replay/cursors over DO SQLite plus `mitt` for in-DO pub/sub. NATS wake publish deferred to Phase 2. |
| Tenant DO class | Instantiates `Dwn.create(config)` with DO stores. `fetch()` handler for JSON-RPC. |
| Gateway Worker | HTTP routing, JSON-RPC parsing, tenant DID extraction, DO stub routing. |
| DID resolution | `UniversalResolver` with `DidDht`, `DidJwk`, `DidKey` (all use `fetch()`). |
| Integration tests | RecordsWrite, RecordsRead, RecordsQuery, ProtocolsConfigure against Miniflare. |

### Phase 2: Firehose + NATS (Weeks 3-5)

| Task | Description |
|---|---|
| Connection DO class | WebSocket accept, hibernation, `serializeAttachment` for subscription state. |
| NATS integration (Tenant DO) | `wsconnect()` to NATS, publish on emit with subject hierarchy. |
| NATS integration (Connection DO) | Subscribe to tenant subjects, route events to client sockets. |
| Subject hierarchy | Implement encoding: tenant token, protocol token, protocolPath tokens. |
| Subscription deduplication | One NATS sub per unique tenant+filter pattern per Connection DO. |
| Client-side filter evaluation | `FilterUtility.matchAnyFilter` for post-NATS filtering in Connection DO. |
| Hibernation lifecycle | Cursor persistence, NATS reconnect-on-wake, subscription rebuild from attachments. |
| NATS deployment | 3-node cluster (AWS or Fly.io) with WebSocket listener enabled. |
| WebSocket integration tests | Subscribe, receive events, reconnect with cursor, verify catch-up + EOSE. |

### Phase 3: IPFS + Delivery (Weeks 5-7)

| Task | Description |
|---|---|
| CID format standardization | Ensure `fixedSize(262144)` + CIDv1 + dag-pb across all code paths. |
| R2 block key scheme | `{dataCid}/{blockCid}` for DAG-PB blocks. |
| Helia deployment (Fly.io) | Helia process with R2-backed blockstore, libp2p peer identity, DHT participation. |
| IPFS announce Queue | Consumer Worker: receives `{ dataCid, blockCids }`, calls `helia.routing.provide()`. |
| `ipfsPinStatus` table | Track announcement status in Tenant DO SQLite. |
| IPFS read fallback | Tenant DO fetches from Helia HTTP gateway on R2 cache miss. |
| `dwn-delivery` Queue | Consumer Worker for Direct and Relay delivery strategies. |
| Delivery manifest format | Envelope for multi-tenant delivery to peer providers. |
| Rendezvous hashing | Relay coordinator assignment for `$delivery: "relay"`. |

### Phase 4: Admin + Registration (Weeks 7-8)

| Task | Description |
|---|---|
| Admin DO | Registration store, tenant CRUD, quota management, audit log. |
| Stats aggregation | Tenant DO alarm-based reporting to Admin DO. |
| Admin API endpoints | Port from `dwn-server`'s `AdminApi` routes. |
| Provider auth | JWT validation via `jose` in Gateway Worker. |
| Proof-of-work | Challenge generation and verification in Admin DO. |
| Admin UI | Serve from Workers Sites (same `@enbox/dwn-server-admin-ui` package). |

### Phase 5: Relay/Cache Mode (Week 9)

| Task | Description |
|---|---|
| Constrained Tenant DO | Envelope-only storage mode. Skip R2 writes, retain messages + SMT only. |
| IPFS fallback reads | `RecordsRead` fetches from IPFS when R2 data unavailable. |
| `dataRetention: "cache"` | Service endpoint annotation support per `proposals/constrained-dwn-relay-cache.md`. |
| Eviction policy | Alarm-based data eviction (oldest first) when approaching 10 GB SQLite limit. |

---

## 7. Cost Estimate

### Medium Scale (50K tenants, 10K connections, 5M writes/day)

| Component | Spec | Monthly Cost |
|---|---|---|
| **Cloudflare** | | |
| DO requests | ~450M/mo (writes + reads + queries + WS messages) | ~$67 |
| DO duration | ~500K GB-s (active processing only) | ~$1 |
| DO SQLite reads | ~3B/mo | ~$0 (within 25B included) |
| DO SQLite writes | ~200M/mo | ~$150 |
| DO SQLite storage | ~50 GB | ~$9 |
| R2 storage | ~250 GB | ~$4 |
| R2 Class A (writes) | ~15M/mo | ~$63 |
| R2 Class B (reads) | ~30M/mo | ~$7 |
| R2 egress | all | $0 |
| Workers (Gateway) | ~450M/mo | ~$132 |
| Queues (delivery + IPFS announce) | ~5M ops/mo | ~$2 |
| **NATS (3-region, 9 nodes)** | | |
| AWS us-east-1 (3 nodes) | c6g.large (2 vCPU, 4 GB) | ~$150 |
| GCP europe-west1 (3 nodes) | e2-standard-2 | ~$150 |
| Fly.io iad + ams (3 nodes + Helia) | performance-2x (2 vCPU, 4 GB) | ~$180 |
| Persistent disk (9 x 100 GB SSD) | | ~$90 |
| Cross-cloud egress | ~600 GB/mo | ~$52 |
| **Total** | | **~$1,057/mo** |

### Scale Comparison

| Scale | Tenants | Connections | Writes/day | CF + NATS/mo | AWS-only/mo |
|---|---|---|---|---|---|
| Small | 5K | 1K | 500K | ~$200 | ~$500 |
| Medium | 50K | 10K | 5M | ~$1,057 | ~$1,900 |
| Large | 500K | 100K | 50M | ~$8,000 | ~$15,000+ |
| Very Large | 5M | 1M | 500M | ~$60,000 | ~$120,000+ |

**Key cost advantages over AWS-only:**
- **Zero egress** on Cloudflare (R2 + Workers) — saves $0.09/GB on all client traffic
- **WebSocket hibernation** — idle connections cost ~$0 (vs. ECS memory reservation)
- **Per-tenant DO** — idle tenants consume only storage, no compute reservation
- **No database provisioning** — no Aurora instance class to right-size
- **No load balancer** — Cloudflare edge routing is free

---

## 8. Security Considerations

| Concern | Mitigation |
|---|---|
| Cross-tenant data isolation | Physical isolation: each tenant has its own DO + SQLite database. No shared tables. |
| Admin API exposure | Bearer token auth (stored in Workers Secrets), Admin DO validates with timing-safe comparison. |
| Data at rest | DO SQLite: encrypted at rest by Cloudflare. R2: encrypted at rest (AES-256). |
| Data in transit | TLS everywhere: client to CF (automatic), CF to NATS (WSS), CF to R2 (internal). |
| IPFS data exposure | Only unencrypted data is announced to IPFS DHT. Encrypted record ciphertext is never published. |
| DDoS | Cloudflare's built-in DDoS protection + rate limiting rules. |
| Key material | No confidential compute on this provider. Keys are handled by `HdIdentityVault` in-isolate. For TEE guarantees, users should use the AWS+Nitro or OVHcloud+Contrast providers. |
| Supply chain | Workers bundle is built from lockfile; `wrangler deploy` verifies bundle integrity. |
| Prototype pollution | Gateway Worker validates all user-supplied query parameter keys against dangerous key set (`__proto__`, `constructor`, `prototype`). |

---

## 9. Relationship to Other Documents

| Document | Relationship |
|---|---|
| `docs/architecture/aws-dwn-deployment.md` | Coexists as Provider 2/4. Shares NATS super-cluster. Users choose based on trust, region, or performance preferences. |
| `docs/architecture/eu-confidential-dwn-deployment.md` | Coexists as Provider 3. CF provider does not offer TEE; users requiring confidential compute use OVHcloud. |
| `infra/multi-region-plan.md` | NATS super-cluster replaces per-region independent NATS clusters. Sync daemon works unchanged — receives wakes, reads the durable log, pushes to peer endpoints. |
| `proposals/dwn-delivery-and-sync.md` | Implements all three `$delivery` strategies: Direct and Relay via Queues, Subscribe via NATS + Connection DOs. |
| `proposals/constrained-dwn-relay-cache.md` | Phase 5 implements relay/cache mode. IPFS fallback enables cache-mode DOs to serve reads without holding full dataset. |
| `proposals/push-notifications.md` | Push notifications can hook into NATS wakes via a consumer worker — subscribe to `dwn.wakes.>`, read durable entries, match notification rules, fire APNs/FCM. |

---

## 10. Open Questions

1. **DO SQLite Dialect**: Should we write a Kysely dialect adapter for
   `ctx.storage.sql` (enabling direct reuse of `dwn-sql-store` query builders),
   or write raw SQL with the same schema (simpler, fewer deps, but duplicates
   query construction logic)? Recommendation: start with raw SQL for Phase 1,
   extract a Kysely dialect if the duplication becomes burdensome.

2. **Connection DO sharding strategy**: Simple modulo hash, or rendezvous
   hashing (more stable when shard count changes)? Rendezvous is more complex
   but avoids reshuffling all connections on scale-up. Recommendation: start
   with modulo, switch to rendezvous when dynamic scaling is needed.

3. **Helia vs. Kubo**: Helia (JS) is lighter and shares language with the DWN
   codebase. Kubo (Go) has better DHT performance and is more battle-tested.
   Recommendation: Helia for Phase 3, with option to switch to Kubo if DHT
   performance matters at scale.

4. **IPFS block key scheme in R2**: `{dataCid}/{blockCid}` enables the Helia
   blockstore to look up blocks directly. But a large DAG with many blocks
   means many R2 GET operations per IPFS read. Alternative: store whole files
   as single R2 objects and have Helia re-chunk on the fly. Tradeoff is storage
   simplicity vs. read efficiency.

5. **Encrypted data in relay/cache mode**: If a relay/cache DO doesn't have
   the encrypted data and it's not on IPFS (because encrypted data is never
   announced), how should it handle `RecordsRead`? Options: proxy to an
   authoritative endpoint listed in the tenant's DID document, or return
   the `RecordsDelete`/`RecordsWrite` message with a 404/410 status and let
   the client try another endpoint.

6. **NATS WebSocket TLS termination**: Should NATS nodes terminate TLS
   directly (requires cert management on each node), or should a reverse proxy
   (Caddy, nginx) sit in front? Recommendation: Caddy with automatic ACME
   certificates for simplicity.

7. **Admin DO scalability**: A single Admin DO handles all admin operations.
   At very large scale (millions of tenants), stats aggregation could overwhelm
   it. Mitigation: batch stats reports via Queue instead of direct RPC, and
   shard the Admin DO by function (registration vs. stats vs. audit) if needed.
