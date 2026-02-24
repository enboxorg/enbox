# Proposal: Storage-Constrained DWN Nodes (Relay/Cache Mode)

## Status

Draft — design proposal for storage-constrained DWN nodes that act as rendezvous points, relays, and caches for more capable DWN endpoints.

## Problem Statement

Today, all DWN endpoints listed in a DID document's `#dwn` service entry are treated as **equivalent replicas** that sync to the same state. This implies each endpoint stores the complete dataset — every message and every byte of record data.

This assumption breaks down in several real-world scenarios:

1. **Cheap always-online VPS + home NAS**: A user wants a low-cost VPS to accept messages 24/7, but stores the full dataset on a high-capacity home server that may go offline occasionally.

2. **Mobile device + cloud DWN**: A mobile device with limited storage acts as a local DWN but cannot hold the full dataset.

3. **Public relay infrastructure**: An organization runs a public DWN relay service for tens of thousands of users. Storing the complete dataset for every tenant is economically infeasible — but accepting, forwarding, and temporarily caching messages is not.

4. **Edge caching**: Multiple lightweight nodes in different geographic regions cache and relay for a central authoritative DWN, reducing latency for nearby clients.

In all these cases, the constrained node needs to:
- Accept incoming writes (rendezvous function)
- Forward/sync messages to the tenant's authoritative endpoint(s)
- Serve reads from local cache when possible, proxy on cache miss
- Manage its limited storage by evicting data it has already forwarded

The DWN architecture already supports this pattern — the spec needs only small additions to make it work correctly across implementations.

---

## Key Insight: Message Envelope / Record Data Separation

The DWN architecture cleanly separates two concerns:

- **Message envelopes** (~1–4 KB): The descriptor, authorization, signatures, encryption metadata, `recordId`, `contextId`. This is the unit of identity, authenticity, and sync state.
- **Record data** (0 bytes to unbounded): The actual payload content referenced by `dataCid` in the descriptor.

**The SMT sync protocol operates entirely on message envelopes:**

- The `messageCid` (the content identifier used as an SMT leaf) is computed from the message envelope **without** any inline data. The computation explicitly strips `encodedData` before hashing.
- The StateIndex stores only `messageCid` hashes.
- SMT root comparison, subtree queries, and leaf enumeration all operate on `messageCid` sets.

This means a node can manage record data independently of sync correctness. Two nodes that hold the same set of message envelopes will have identical SMT root hashes, regardless of whether they hold the corresponding record data. How an implementation manages its internal storage is entirely opaque — the spec makes no assumptions about storage layout.

### Storage Profile

For a workload of 1,000 records per tenant (average 100 KB of data each):

| Component | Per Tenant | 10K Tenants | 100K Tenants |
|-----------|-----------|-------------|--------------|
| Message envelopes | ~2 MB | ~20 GB | ~200 GB |
| SMT entries + internal nodes | ~100 KB | ~1 GB | ~10 GB |
| Record data | ~100 MB | ~1 TB | ~10 TB |
| **Total (messages + SMT only)** | **~2.1 MB** | **~21 GB** | **~210 GB** |

A constrained node retaining only message envelopes and the SMT achieves a **~50x storage reduction**. At 100K tenants, that is the difference between a commodity server (~210 GB) and a storage cluster (~10 TB).

---

## Spec Changes

The following changes span the DWN spec, transport spec, and delivery spec. Total normative text is approximately 20 lines.

### 1. Service Endpoint Annotations (DWN Spec + Transport Spec)

The `serviceEndpoint` property currently accepts strings or arrays of strings. This proposal extends it to also accept **map values** alongside string values. The [W3C DID Core spec (Section 5.4)](https://www.w3.org/TR/did-core/#services) explicitly allows `serviceEndpoint` to be "a string, a map, or a set composed of one or more strings and/or maps" — this change is fully DID-spec compliant. [DIDComm v2](https://identity.foundation/didcomm-messaging/spec/) already uses this pattern.

#### Proposed Format

```json
{
  "id": "#dwn",
  "type": "DecentralizedWebNode",
  "serviceEndpoint": [
    "https://home-nas.example.com",
    { "url": "https://relay.example.com", "dataRetention": "cache" }
  ]
}
```

#### Endpoint Entry Properties

When a `serviceEndpoint` entry is a map, the following properties are defined:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `url` | `string` | Yes | The network URL of the DWN endpoint. |
| `dataRetention` | `string` | No | `"cache"` when the node operates as a best-effort relay/cache. |

When `dataRetention` is absent, or when the entry is a bare string, the endpoint is implicitly a **full node** — it retains all messages and their associated record data.

A `"cache"` endpoint is a best-effort relay. It SHOULD accept incoming writes, SHOULD attempt to forward them to the tenant's full endpoints, and MAY manage its record data retention at its own discretion. It makes no guarantee of data durability.

#### Backward Compatibility

Bare string entries and map entries coexist in the same `serviceEndpoint` array. A bare string `"https://dwn.example.com"` is equivalent to `{ "url": "https://dwn.example.com" }`. Existing DID documents with string-only endpoints remain valid with unchanged semantics.

### 2. Read Proxy Semantics (Delivery Spec)

A DWN that holds a message envelope but does not have the corresponding record data locally available MAY transparently proxy the read request to a peer endpoint.

When a DWN receives a `RecordsRead` for a record whose message exists locally but whose data is not available:

1. The node identifies peer endpoints for the tenant from the DID document's `#dwn` service entry, preferring full endpoints.
2. The node issues a `RecordsRead` to the peer endpoint, forwarding the original authorization or using its own delegated authorization.
3. If the peer returns the data, the node returns it to the requester as if it were a local read.
4. The node MAY cache the returned data locally for future requests.
5. If no peer endpoint is reachable, the node returns the message without data or an appropriate error status.

Read proxying is transparent to the requesting party.

### 3. Sync Correctness Clarification (DWN Spec — Sync Section)

> The SMT operates exclusively on `messageCid` sets derived from message envelopes. Record data availability does not affect the SMT root hash or the correctness of the sync protocol. A node that holds all message envelopes for a tenant will produce the same SMT root hash as any other node holding the same message set, regardless of record data retention policy.

### 4. Content-Addressed Data Availability (DWN Spec — Non-Normative Note)

> Since record data is content-addressed using IPFS-compatible CIDs (DAG-PB/UnixFS), nodes MAY resolve record data from any source that can provide content matching the `dataCid`, including IPFS, BitTorrent, or other content-addressed networks. The authenticity of the data is verified by recomputing the CID from the received content and comparing it to the `dataCid` in the signed message descriptor.

---

## Design: Operational Model

This section describes how a constrained relay/cache node operates. While not normative, it provides the intended semantics.

### Write Path (Rendezvous)

When a constrained node receives a `RecordsWrite` from an external author:

1. **Process normally**: Validate, authenticate, authorize, store. The author receives a standard success response.
2. **Forward to peers**: Forward the original signed message to the tenant's other DWN endpoints (per the delivery spec forwarding behavior). Full endpoints are preferred targets.
3. **Data becomes eligible for eviction**: Once accepted and forwarded, the record data is a candidate for eventual eviction. The message envelope is retained.

The constrained node is transparent to the author — they see a normal DWN.

### Sync Path

The constrained node participates in SMT sync normally. Its SMT contains every `messageCid` it has processed (messages are retained). After sync convergence (root hashes match), the constrained node knows the full peer has every message and its corresponding data.

### Read Path (Cache)

1. **Local hit**: Message and data both available — return normally.
2. **Cache miss, IPFS available**: For `published: true` records, attempt to fetch `dataCid` from IPFS. Verify the fetched content by recomputing the CID. Return transparently.
3. **Cache miss, peer proxy**: Forward the read to a full peer endpoint. Return the response transparently.
4. **No source available**: Return the message without data, or an appropriate error.

### Eviction

Eviction policy is entirely at the node operator's discretion. The spec defines no requirements beyond the sync correctness invariant (retain message envelopes and StateIndex). Example strategies:

- **Synced-first**: Prioritize evicting data confirmed synced to a full peer.
- **Age-based**: Evict data older than a configurable retention window.
- **Size-based**: Evict the largest records first.
- **Per-protocol**: Different retention policies per protocol.

A constrained node MAY evict data that has not been confirmed synced to a full peer. This is a best-effort tradeoff: the data may be lost if the tenant's full endpoints were unreachable. The tenant accepts this risk by listing a `"cache"` endpoint. This is essential for preventing resource exhaustion on public relay infrastructure.

---

## Topologies

### Full + Cache (Typical)

```json
"serviceEndpoint": [
  "https://home-nas.example.com",
  { "url": "https://relay.example.com", "dataRetention": "cache" }
]
```

The relay accepts writes, forwards to the home NAS, evicts data after sync confirmation. Reads are served locally or proxied to the home NAS.

### Cache-Only with Unlisted Home NAS (Privacy-Preserving)

```json
"serviceEndpoint": [
  { "url": "https://relay-a.example.com", "dataRetention": "cache" },
  { "url": "https://relay-b.example.com", "dataRetention": "cache" }
]
```

The user's home NAS is not listed — they don't want to expose their home IP. The user's agent syncs with the relays over the network and with the NAS over LAN. The agent is the bridge. Relays evict on their own schedule. The user is responsible for syncing before the retention window expires.

### All-Cache (Ephemeral/Signaling)

A DID with only cache endpoints and no agent-initiated sync to a full node. Data is eventually lost. Suitable for ephemeral/disposable data (real-time signaling, temporary shares).

---

## Public Relay Infrastructure

A public relay is a DWN server that hosts tenants it does not control, operating with `dataRetention: "cache"` semantics.

### Scale Characteristics

For a relay serving 100K tenants:

| Concern | Assessment |
|---------|------------|
| Storage (messages + SMT only) | ~210 GB — single commodity server |
| Storage (with temporary data buffer) | ~210 GB + configurable retention window |
| Sync overhead | Per-tenant SMT root comparison is O(1); tree walk only for divergent tenants |
| Connection management | Per-client, not per-tenant; scales with active users |

### Resource Protection

A public relay protects itself through:

1. **Storage quotas**: Per-tenant limits on message count and data volume (existing mechanisms).
2. **Time-bounded data retention**: Data retained only for a bounded window (e.g., 24–72 hours). Tenants whose full nodes don't sync within that window lose data.
3. **Rate limiting**: Existing per-IP and per-tenant rate limits.
4. **Registration gating**: Proof-of-work or provider auth.

The relay has no obligation to retain data indefinitely. Its contract is best-effort: "I will accept your messages, attempt to deliver them, and retain them temporarily. Durability is your full node's responsibility."

---

## Content-Addressed Data Availability (IPFS)

DWN record data uses IPFS-compatible content identifiers. The `dataCid` in a `RecordsWrite` descriptor is a DAG-PB/UnixFS CID — the same format used by IPFS. This creates a natural integration point for public data:

1. A full node provider optionally **pins** record data for `published: true` records to IPFS.
2. A cache node that holds the message but not the data can **fetch by `dataCid`** from any IPFS peer.
3. The fetched data is **self-certifying**: the cache node recomputes the CID from the fetched bytes and verifies it matches the `dataCid` in the author-signed descriptor. No trust in the IPFS source is required.
4. Popular content benefits from IPFS's natural replication — the more nodes that fetch it, the more available it becomes.

This works because:
- The CID compatibility is inherent — DWN already uses `ipfs-unixfs-importer` for data chunking.
- Public records (`published: true`) are unencrypted, making IPFS distribution straightforward.
- The relay bears zero data storage cost — it fetches on demand and optionally caches.

This is an implementation optimization, not a protocol requirement. A relay works without IPFS; IPFS is an additional data source for cache misses on public content.

---

## ServerSyncEngine (High-Level Architecture)

A relay serving many tenants cannot use the agent-side sync engine, which is designed for a single user's identities. A purpose-built `ServerSyncEngine` is needed.

### Components

**Priority Queue**: Work items represent a `(tenant, peerEndpoint)` pair needing sync. Priority is determined by:
- Recency of local writes (fresh data is most at risk)
- Time since last sync (stale tenants get higher priority over time)
- Peer reachability (unreachable peers deprioritized with exponential backoff)

Event-driven triggers add work items: new `RecordsWrite` → queue that tenant (debounced); periodic scan → advance priority for stale tenants; peer comes online → queue all tenants for that peer.

**Connection Pool**: Keyed by peer host, not by tenant. 100K tenants at 500 distinct providers = ~500 connections. Eliminates the O(tenants) connection problem.

**Sync Workers**: Configurable number of concurrent workers pull from the priority queue and execute the SMT sync algorithm. Workers serialize within a single tenant but run concurrently across tenants.

**Peer Sync State**: Tracks `(tenant, peerEndpoint) → lastConfirmedRoot` for eviction decisions. When roots match, all messages are confirmed synced. Used by the eviction manager to determine what is safe to evict.

---

## Implementation: `@enbox/dwn-relay`

The relay/cache behavior is implemented as a new package in the enbox monorepo that extends `@enbox/dwn-server`. See the [package README](../packages/dwn-relay/README.md) for architecture and implementation details.

---

## Edge Cases and Failure Modes

| Scenario | Behavior |
|----------|----------|
| Both nodes offline | Same as single-node-offline — client gets no response |
| Full node permanently gone | Cache node evicts data on schedule; message envelopes persist; sync resumes if a new full endpoint appears |
| Cache node full, unsynced data | Evict synced data first; if still full, evict unsynced data (best-effort); if still full, reject new writes |
| Data evicted during read | Cache-miss path activates, proxies to peer — deterministic, not an error |
| Tenant has no full endpoints | Cache nodes evict on their own schedule; the tenant's agent is responsible for pulling data in time |
| Tenant lists only bare string endpoints | All endpoints are implicitly full — standard DWN behavior, unchanged |

---

## Summary of Spec Surface Area

| Change | Spec | Type |
|--------|------|------|
| `serviceEndpoint` map format with `url` and `dataRetention` | DWN spec + Transport spec | ~10 lines normative |
| Read proxy semantics | Delivery spec | ~5 lines normative |
| Sync correctness clarification (SMT operates on envelopes, not data) | DWN spec (Sync section) | ~3 lines normative |
| Content-addressed data availability | DWN spec | ~3 lines non-normative note |
| **Total** | | **~21 lines** |

Everything else — eviction policies, ServerSyncEngine, storage management, IPFS integration, resource protection — is implementation-level and does not require spec changes.
