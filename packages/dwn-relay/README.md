# @enbox/dwn-relay

A storage-constrained DWN server that extends `@enbox/dwn-server` with relay/cache capabilities. It accepts writes, forwards them to peer endpoints, serves reads from cache or via proxy, and manages limited storage by evicting record data while retaining message envelopes and sync state.

## Overview

`dwn-relay` is a fully spec-compliant DWN. It processes messages through the exact same pipeline as `dwn-server`. The difference is operational: it treats **record data as ephemeral** while treating **message envelopes as durable**.

This works because the DWN sync protocol (SMT-based set reconciliation) operates exclusively on `messageCid` sets derived from message envelopes — record data does not affect sync correctness. A relay node that retains all message envelopes produces identical SMT root hashes to a full node, regardless of what record data it holds.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    dwn-relay                          │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │              @enbox/dwn-server                  │  │
│  │  HTTP/WS, Registration, Rate Limiting, Admin   │  │
│  └──────────────────────┬─────────────────────────┘  │
│                         │                            │
│  ┌──────────────────────▼─────────────────────────┐  │
│  │              Relay Layer                        │  │
│  │                                                │  │
│  │  ┌────────────────────────────────────────────┐ │  │
│  │  │ RelayDataStore (wraps DataStore)           │ │  │
│  │  │  • Eviction metadata tracking              │ │  │
│  │  │  • Transparent read-proxy on cache miss:   │ │  │
│  │  │    1. Local cache  2. IPFS  3. Peer DWN    │ │  │
│  │  └────────────────────────────────────────────┘ │  │
│  │                                                │  │
│  │  ┌─────────────┐  ┌──────────────────────────┐ │  │
│  │  │ Eviction    │  │ ServerSyncEngine         │ │  │
│  │  │ Manager     │  │                          │ │  │
│  │  │             │  │  Priority queue           │ │  │
│  │  │ Monitors    │  │  Connection pool          │ │  │
│  │  │ storage,    │  │  Concurrent workers       │ │  │
│  │  │ evicts data │  │  Peer sync state          │ │  │
│  │  └─────────────┘  └──────────────────────────┘ │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │              Storage                           │  │
│  │  MessageStore  — permanent (envelopes)         │  │
│  │  DataStore     — ephemeral (evictable data)    │  │
│  │  StateIndex    — permanent (SMT)               │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## How It Works

### Write Path (Rendezvous)

When an external author sends a `RecordsWrite` to the relay:

1. **Standard processing**: The message is validated, authenticated, authorized, and stored — message envelope to MessageStore, record data to DataStore.
2. **Standard response**: The author receives a normal success response. The relay is transparent.
3. **Async forwarding**: The DeliveryService (from `@enbox/dwn-server`) resolves the tenant's other DWN endpoints from their DID document and forwards the original signed message + data. `409` (duplicate) from a peer is treated as success.
4. **Async sync**: The ServerSyncEngine queues the tenant for the next sync cycle as a backstop.

### Read Path (Cache)

When a client sends a `RecordsRead`:

1. **Local hit**: Message and data both present locally — return normally.
2. **Cache miss (published data, IPFS configured)**: Fetch `dataCid` from IPFS. Verify by recomputing the CID. Return transparently. Optionally re-cache locally.
3. **Cache miss (peer proxy)**: Forward the read to a full peer endpoint from the tenant's DID document. Return the response transparently.
4. **No source available**: Return the message without data or an appropriate error.

### Eviction

The Eviction Manager runs as a background process:

1. Monitors storage usage against configured thresholds.
2. When over threshold, selects eviction candidates by policy (synced-first, age-based, size-based, or per-protocol).
3. Deletes record data from DataStore. Message envelopes in MessageStore and SMT entries in StateIndex are untouched.
4. Subsequent reads for evicted data go through the cache-miss proxy path.

### ServerSyncEngine

Purpose-built for multi-tenant relay nodes. Unlike the agent-side `SyncEngineLevel` (designed for a single user), the ServerSyncEngine handles thousands of tenants efficiently:

- **Priority Queue**: `(tenant, peerEndpoint)` work items ordered by urgency. Recent writes = high priority. Stale tenants advance over time. Unreachable peers deprioritized with backoff.
- **Connection Pool**: Keyed by host, not tenant. 100K tenants across 500 providers = ~500 connections.
- **Sync Workers**: Configurable concurrency. Each worker pulls a work item, compares SMT roots, walks the tree on divergence, pushes/pulls messages. Workers serialize within a tenant, run concurrently across tenants.
- **Peer Sync State**: Tracks `(tenant, peer) → lastConfirmedRoot`. Used by the Eviction Manager to determine what is safe to evict.

## Package Structure

```
packages/dwn-relay/
  src/
    index.ts                      Entry point / exports
    relay-server.ts               Extends DwnServer with relay behavior
    config.ts                     Relay-specific configuration (env vars)
    eviction/
      eviction-manager.ts         Background eviction process
      storage-policies.ts         Per-protocol retention policy types
    proxy/
      ipfs-resolver.ts            Optional IPFS data fetching + CID verification
    sync/
      server-sync-engine.ts       Multi-tenant sync orchestrator
      priority-queue.ts           Urgency-ordered work queue
      connection-pool.ts          Per-host connection reuse
    stores/
      relay-data-store.ts         DataStore wrapper with eviction awareness
```

## Configuration

All configuration via environment variables, following `dwn-server` conventions:

```bash
# --- Inherited from @enbox/dwn-server ---
DWN_BASE_URL=https://relay.example.com
DWN_STORAGE_MESSAGES=postgres://...
DWN_STORAGE_STATE_INDEX=postgres://...
DS_PORT=3000

# --- Relay-specific ---

# Data retention window. Data older than this is eligible for eviction.
# Accepts duration strings: "72h", "7d", "30m", etc.
DWN_RELAY_DATA_RETENTION=72h

# Maximum bytes for record data storage. Eviction triggers at this threshold.
# 0 = unlimited (not recommended for relay nodes).
DWN_RELAY_STORAGE_MAX_BYTES=50000000000

# IPFS HTTP gateway URL for resolving published record data on cache miss.
# Omit to disable IPFS resolution.
DWN_RELAY_IPFS_GATEWAY=http://localhost:8080

# Number of concurrent sync workers.
DWN_RELAY_SYNC_WORKERS=8

# Interval between sync priority queue scans (seconds).
DWN_RELAY_SYNC_INTERVAL=30

# Per-protocol storage policy overrides. JSON object mapping protocol URI
# to retention duration. Protocols not listed use DWN_RELAY_DATA_RETENTION.
# Example: {"https://example.com/chat":"7d","https://example.com/media":"24h"}
DWN_RELAY_PROTOCOL_POLICIES={}

# Path for the persistent eviction metadata SQLite database.
# Omit to use in-memory only (not recommended for production — metadata
# is lost on restart). Uses bun:sqlite.
DWN_RELAY_METADATA_PATH=./data/relay-metadata.sqlite
```

## Comparison with `dwn-server`

| Behavior | `dwn-server` | `dwn-relay` |
|----------|-------------|-------------|
| Accepts writes | Yes | Yes (identical) |
| Stores messages | Permanently | Permanently (identical) |
| Stores record data | Permanently | Temporarily (evicts) |
| SMT sync | Agent-initiated | Agent-initiated + ServerSyncEngine |
| Read for local data | Returns it | Returns it (identical) |
| Read for missing data | Not found | Proxies to IPFS or peer |
| Write forwarding | No | Yes, via DeliveryService |
| Storage growth | Unbounded | Bounded by eviction policy |

## Example Topologies

### Full + Cache (Typical)

```json
"serviceEndpoint": [
  "https://home-nas.example.com",
  { "url": "https://relay.example.com", "dataRetention": "cache" }
]
```

External authors can write to either. The relay forwards to the home NAS, evicts after sync. Reads served locally or proxied.

### Cache-Only with Unlisted Home NAS (Privacy-Preserving)

```json
"serviceEndpoint": [
  { "url": "https://relay-a.example.com", "dataRetention": "cache" },
  { "url": "https://relay-b.example.com", "dataRetention": "cache" }
]
```

The user's agent syncs with relays over the network and with an unlisted home NAS over LAN. Relays evict on their own schedule. The user syncs before the retention window expires.

### Public Relay (Large Scale)

A single relay instance serving 100K tenants:
- ~210 GB storage for messages + SMT (no data retained long-term)
- Per-tenant quotas and rate limiting
- 24–72 hour data retention window
- Tenants' full nodes sync before the window expires

## Docker

Build and run from the monorepo root:

```bash
# Build
docker build -f Dockerfile.relay -t enbox-dwn-relay .

# Run with defaults (LevelDB storage, port 3000)
docker run -p 3000:3000 enbox-dwn-relay

# Run with persistent storage
docker run -p 3000:3000 \
  -v dwn-relay-data:/app/data \
  -e DWN_RELAY_DATA_RETENTION=72h \
  -e DWN_RELAY_STORAGE_MAX_BYTES=50000000000 \
  enbox-dwn-relay

# Run with PostgreSQL message store and IPFS gateway
docker run -p 3000:3000 \
  -v dwn-relay-data:/app/data \
  -e DWN_STORAGE_MESSAGES=postgres://user:pass@host:5432/dwn \
  -e DWN_STORAGE_STATE_INDEX=postgres://user:pass@host:5432/dwn \
  -e DWN_RELAY_IPFS_GATEWAY=http://ipfs-gateway:8080 \
  enbox-dwn-relay
```

The image uses `tini` for proper signal handling, runs as a non-root `dwn` user, and includes a health check on `/health`.

Data is stored in `/app/data` (LevelDB stores + SQLite metadata). Mount a volume for persistence.

## Related

- [Proposal: Storage-Constrained DWN Nodes](../../proposals/constrained-dwn-relay-cache.md)
- [Proposal: DWN-to-DWN Sync and Multi-Party Record Delivery](../../proposals/dwn-delivery-and-sync.md)
- [DWN Specification](https://github.com/enboxorg/dwn-spec)
- [DWN Transport Specification](https://github.com/enboxorg/dwn-transport-spec)
