# E2E DWN Deployment on AWS with Nitro Enclaves

## Executive Summary

This document describes a production-grade, horizontally-scalable DWN deployment
on AWS. The architecture addresses four systemic gaps in the current single-process
DWN server: (1) the in-memory-only `EventLog` cannot fan out events across
processes, (2) the `InMemoryConnectionManager` pins WebSocket state to a single
node, (3) the `DataStoreSql` buffers entire blobs in memory, and (4) there is no
confidential-compute boundary for key material. The design introduces Aurora
PostgreSQL for unified storage, NATS JetStream for distributed pub/sub, an
ALB+ECS topology for horizontally-scaled web heads, and AWS Nitro Enclaves for
cryptographic isolation.

---

## 1. Current Architecture — Gaps and Constraints

| Component | Current State | Scaling Limitation |
|---|---|---|
| **EventLog** | `EventEmitterEventLog` — in-memory `mitt` emitter | Events are process-local; subscribers on node B never see writes on node A |
| **ConnectionManager** | `InMemoryConnectionManager` — `Map<WS, SocketConnection>` | WebSocket state is lost if the process dies; no cross-node awareness |
| **DataStore** | `DataStoreSql` — `DataStream.toBytes()` buffers full blob in RAM | 1 GB `maxRecordDataSize` can OOM a container |
| **Connection Pool** | 4 separate `pg.Pool` instances (one per store), each defaulting to 10 connections | 40 connections per web head; untunable without code changes |
| **Schema Management** | Imperative `CREATE TABLE IF NOT EXISTS` in `open()` | No migrations, no version tracking, no `ALTER TABLE` |
| **Tenant Isolation** | Shared tables with `WHERE tenant = ?` | No RLS, no partitioning; a bug leaks cross-tenant data |
| **StateIndex** | Non-transactional delete-then-insert upsert for SMT nodes | Race conditions under concurrent writes |
| **EventLog Persistence** | Events stored in per-tenant `Map<number, StoredEntry>` | Volatile — all events lost on restart |

The `EventLog` interface (`dwn-sdk-js/src/types/subscriptions.ts:162`) is
explicitly designed for distributed backends — its JSDoc mentions NATS JetStream,
Redis Streams, etc. The `DWN_EVENT_LOG_PLUGIN_PATH` env var + `PluginLoader`
already support loading a custom implementation at runtime. This is the primary
extension point.

---

## 2. Target Architecture

```
                         ┌─────────────────────────────────┐
                         │         Route 53 (DNS)          │
                         └──────────────┬──────────────────┘
                                        │
                         ┌──────────────▼──────────────────┐
                         │   Application Load Balancer      │
                         │   (ALB — dual listener)          │
                         │                                  │
                         │   :443/TCP  → HTTP target group  │
                         │   :443/WS   → WS target group    │
                         │              (sticky sessions)    │
                         └──────┬───────────────┬───────────┘
                                │               │
                    ┌───────────▼───┐   ┌───────▼───────────┐
                    │  ECS Service  │   │  ECS Service       │
                    │  "dwn-http"   │   │  "dwn-ws"          │
                    │  (Fargate)    │   │  (EC2 + Nitro)     │
                    │               │   │                    │
                    │  N replicas   │   │  N replicas        │
                    │  stateless    │   │  sticky per-conn   │
                    └──────┬────────┘   └──────┬─────────────┘
                           │                   │
              ┌────────────▼───────────────────▼────────────┐
              │                                             │
    ┌─────────▼─────────┐                    ┌──────────────▼──────────────┐
    │  Aurora PostgreSQL │                    │  NATS JetStream Cluster     │
    │  (writer + readers)│                    │  (3-node, persistent)       │
    │                    │                    │                             │
    │  All 4 DWN stores  │                    │  Distributed EventLog       │
    │  + tenant registry │                    │  dwn.events.{tenant}        │
    │  + admin store     │                    │  subjects                   │
    └────────────────────┘                    └─────────────────────────────┘
              │
    ┌─────────▼─────────┐
    │  S3 (large blobs)  │
    │  data > 256 KB     │
    │  referenced by     │
    │  dataCid in PG     │
    └────────────────────┘

    ┌─────────────────────────────────────────────────────────┐
    │  Nitro Enclave (on each EC2 dwn-ws instance)            │
    │                                                         │
    │  - KMS key derivation (ECDH-ES+A256KW)                  │
    │  - Agent DID private key operations                     │
    │  - JWE encrypt/decrypt for DwnKeyStore records          │
    │  - Attestation document for KMS policy binding          │
    └─────────────────────────────────────────────────────────┘
```

---

## 3. Component Deep-Dives

### 3.1 Aurora PostgreSQL — Unified Data Plane

**Why Aurora over RDS PostgreSQL:**
Aurora's storage layer (distributed, replicated, auto-growing up to 128 TB) decouples
storage from compute. Reader endpoints scale read-heavy RecordsQuery/RecordsRead
workloads independently of write throughput.

**Instance topology:**

| Role | Instance Class | Count | Purpose |
|---|---|---|---|
| Writer | `db.r6g.xlarge` (start) | 1 | All DWN writes (RecordsWrite, ProtocolsConfigure, etc.) |
| Reader | `db.r6g.large` (start) | 2+ (auto-scaling) | RecordsQuery, RecordsRead, ProtocolsQuery, admin stats |

**Schema refinements over current `dwn-sql-store`:**

1. **Shared connection pool**: Instead of 4 separate `pg.Pool` instances (one per
   store class), introduce a `SharedPoolProvider` that all store instances share.
   Configure via:
   ```
   DWN_PG_POOL_MIN=10
   DWN_PG_POOL_MAX=50
   DWN_PG_POOL_IDLE_TIMEOUT=30000
   ```

2. **Read/write splitting**: A `ReadReplicaAwareDialect` that directs
   `SELECT` queries to the Aurora reader endpoint and mutations to the writer.
   Kysely's `PostgresDialect` accepts a `pool` factory — swap in a pool that
   routes based on query type, or use two separate Kysely instances
   (one per endpoint) wrapped behind the store interface.

3. **Table partitioning** (optional, for >100K tenants):
   ```sql
   -- Partition messageStoreMessages by hash of tenant
   CREATE TABLE "messageStoreMessages" ( ... )
   PARTITION BY HASH (tenant);

   -- Create N partitions (e.g., 64)
   CREATE TABLE "messageStoreMessages_p0"
     PARTITION OF "messageStoreMessages"
     FOR VALUES WITH (MODULUS 64, REMAINDER 0);
   -- ... repeat for p1..p63
   ```
   Hash partitioning distributes tenants evenly and keeps tenant-scoped queries
   fast (partition pruning on `WHERE tenant = ?`). This is a PostgreSQL-native
   feature that requires zero application code changes — the query planner
   automatically routes to the correct partition.

4. **Row-Level Security** (defense-in-depth):
   ```sql
   ALTER TABLE "messageStoreMessages" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "messageStoreMessages"
     USING (tenant = current_setting('app.current_tenant'));
   ```
   Each DWN request sets `SET LOCAL app.current_tenant = '<did>'` at the start
   of the transaction. This provides a database-level safety net independent of
   application logic.

5. **Migration framework**: Introduce `kysely-migration-provider` or a simple
   migration table (`dwn_migrations(id, name, applied_at)`) with sequential
   SQL migration files. Run migrations on deployment, not in `open()`.

**Connection string configuration (single unified URL):**
```
DWN_STORAGE=postgres://dwn_app:****@writer.cluster-xxx.us-east-1.rds.amazonaws.com:5432/dwn
DWN_STORAGE_READ=postgres://dwn_app:****@reader.cluster-xxx.us-east-1.rds.amazonaws.com:5432/dwn
```

### 3.2 NATS JetStream — Distributed EventLog

**Why NATS JetStream over alternatives:**

| Option | Pros | Cons |
|---|---|---|
| **PostgreSQL LISTEN/NOTIFY** | Zero additional infrastructure | No persistence, no replay, 8 KB payload limit, no consumer groups, no backpressure |
| **Redis Streams** | Fast, supports consumer groups | Another stateful system to manage; no built-in clustering without Redis Cluster |
| **Amazon SNS/SQS** | Managed | High latency (~50-100ms), not designed for per-tenant fan-out at this granularity |
| **NATS JetStream** | Persistent streams, consumer groups, subject-based routing, cursor (sequence) native, <1ms latency, Helm chart for EKS/ECS | Additional infrastructure (3 nodes) |

NATS JetStream is the best fit because:
- The `EventLog` interface's cursor model maps directly to NATS stream sequences.
- Subject-based routing (`dwn.events.<tenant-hash>`) provides natural tenant isolation.
- JetStream consumers provide durable replay (catch-up from cursor) natively.
- The EOSE pattern is implementable via consumer `DeliverPolicy.ByStartSequence`.

**NATS topology:**

| Component | Count | Instance | Purpose |
|---|---|---|---|
| NATS server | 3 | `c6g.large` or ECS tasks | JetStream cluster with R=3 replication |

**Stream configuration:**
```
Stream: DWN_EVENTS
  Subjects: dwn.events.>
  Storage: File
  Retention: Limits (MaxAge: 7d, MaxBytes: 50GB)
  Replicas: 3
  MaxMsgsPerSubject: 100,000   (per-tenant cap)
  Discard: Old
```

**Subject design:**
```
dwn.events.{tenant-hash-prefix}.{tenant-did-base64url}
```
The `tenant-hash-prefix` (first 2 hex chars of SHA-256 of tenant DID) enables
efficient wildcard subscriptions for admin monitoring (`dwn.events.a3.>`) and
even subject-based partitioning if needed later.

**`NatsEventLog` implementation** (new — implements `EventLog` interface):

```typescript
// packages/dwn-server/src/event-log-nats.ts

import type { EventLog, EventLogReadOptions, EventLogReadResult,
  EventLogSubscribeOptions, EventSubscription, MessageEvent,
  SubscriptionListener } from '@enbox/dwn-sdk-js';

export class NatsEventLog implements EventLog {
  // NATS JetStream connection + stream handle
  private js: JetStream;
  private jsm: JetStreamManager;

  async emit(tenant: string, event: MessageEvent, indexes: KeyValues): Promise<string> {
    const subject = this.tenantSubject(tenant);
    const payload = encode({ event, indexes });  // CBOR or JSON
    const ack = await this.js.publish(subject, payload);
    return String(ack.seq);  // NATS sequence = cursor
  }

  async subscribe(
    tenant: string, id: string, listener: SubscriptionListener,
    options?: EventLogSubscribeOptions
  ): Promise<EventSubscription> {
    const subject = this.tenantSubject(tenant);
    const consumerConfig = {
      filterSubject : subject,
      deliverPolicy : options?.cursor
        ? DeliverPolicy.ByStartSequence
        : DeliverPolicy.New,
      optStartSeq   : options?.cursor ? Number(options.cursor) + 1 : undefined,
      ackPolicy     : AckPolicy.Explicit,
    };
    const consumer = await this.jsm.consumers.add('DWN_EVENTS', consumerConfig);
    const sub = await consumer.consume();

    // Catch-up + EOSE + live delivery loop
    (async () => {
      let lastSeq: string | undefined;
      let sentEose = false;
      for await (const msg of sub) {
        const { event, indexes } = decode(msg.data);
        const cursor = String(msg.seq);

        if (options?.filters && !matchAnyFilter(indexes, options.filters)) {
          msg.ack();
          continue;
        }

        // Detect transition from catch-up to live
        if (!sentEose && msg.info.pending === 0) {
          listener({ type: 'eose', cursor });
          sentEose = true;
        }

        listener({ type: 'event', cursor, event });
        lastSeq = cursor;
        msg.ack();
      }
    })();

    return {
      id,
      close: async () => {
        await sub.drain();
        await this.jsm.consumers.delete('DWN_EVENTS', consumer.name);
      },
    };
  }

  async read(tenant: string, options?: EventLogReadOptions): Promise<EventLogReadResult> {
    // Use ordered consumer for one-shot read
    // ... fetch messages from cursor, apply filters, return batch
  }

  async trim(tenant: string, olderThan: number | string): Promise<void> {
    // Use stream purge with subject filter
    await this.jsm.streams.purge('DWN_EVENTS', {
      filter: this.tenantSubject(tenant),
      seq: /* convert olderThan to sequence */,
    });
  }
}
```

**Key design notes:**
- Each WebSocket subscription creates an **ephemeral NATS consumer** scoped to
  the tenant's subject. This means node A can emit, and node B's consumer
  receives the event — solving the cross-process fan-out problem.
- The NATS sequence number is the cursor. This is monotonic, ordered, and
  persistent — a direct fit for the `EventLog` cursor model.
- EOSE detection uses `msg.info.pending === 0` (NATS tells you how many
  messages remain in the consumer's replay queue).
- Consumer lifecycle is tied to subscription lifecycle: created on subscribe,
  deleted on close/disconnect.

### 3.3 WebSocket Scaling — ALB Sticky Sessions + Split Services

**The problem:** WebSocket connections are long-lived and stateful. The
`SocketConnection` holds subscription state, flow controllers, and heartbeat
timers. If a connection is routed to a different node after a reconnect, the
server-side subscription state is lost.

**Solution: Split the DWN server into two ECS services:**

| Service | Transport | Scaling Model | Instance Type |
|---|---|---|---|
| `dwn-http` | HTTP POST (JSON-RPC) | Stateless, horizontal, Fargate | Fargate (CPU/memory auto-scale) |
| `dwn-ws` | WebSocket (JSON-RPC) | Sticky sessions, EC2 (for Nitro) | `c5.xlarge` (Nitro-capable) |

**Why split?**
- HTTP requests are stateless and short-lived — they benefit from pure
  horizontal scaling with no affinity. Fargate is ideal.
- WebSocket connections are stateful and long-lived — they need sticky sessions
  and benefit from EC2 instances (required for Nitro Enclaves). Separating them
  allows independent scaling policies.
- RecordsWrite (which carries data payloads) is HTTP-only in the current
  codebase (`process-message.ts:30-63`). Subscribe is WebSocket-only. This
  natural transport split already exists.

**ALB configuration:**

```
Listener :443 (HTTPS)
  Rule 1: Header "Upgrade: websocket"
           → Target Group: dwn-ws (sticky, 1-hour duration)
  Rule 2: Default
           → Target Group: dwn-http (round-robin)

Target Group: dwn-ws
  Protocol: HTTP
  Stickiness: ALB cookie, 3600s
  Health check: GET /health
  Deregistration delay: 300s (drain WebSocket connections)

Target Group: dwn-http
  Protocol: HTTP
  Stickiness: None
  Health check: GET /health
  Deregistration delay: 30s
```

**Sticky session behavior:**
- On initial WebSocket upgrade, ALB sets `AWSALB` cookie.
- Subsequent reconnects from the same client hit the same target (if alive).
- If the target is gone (scale-in, crash), ALB routes to a new target. The
  client's `JsonRpcSocket` auto-reconnect fires, `WebSocketDwnRpcClient`
  calls `resubscribeAll()` with `lastCursor`, and the new node creates fresh
  NATS consumers that replay from the cursor. No events are lost.

**Graceful drain on scale-in:**
- ECS sends `SIGTERM` to the DWN process.
- `process-handlers.ts` catches `SIGTERM` and calls `dwnServer.stop()`.
- `stop()` closes all WebSocket connections (which triggers client reconnect).
- ALB deregistration delay (300s) allows in-flight HTTP requests to complete.

### 3.4 Horizontal Web Heads — ECS Task Definition

**dwn-http (Fargate):**

```jsonc
{
  "family": "dwn-http",
  "cpu": "1024",      // 1 vCPU
  "memory": "2048",   // 2 GB
  "containerDefinitions": [{
    "name": "dwn",
    "image": "ECR_URI/dwn-server:latest",
    "portMappings": [{ "containerPort": 3000 }],
    "environment": [
      { "name": "DS_PORT", "value": "3000" },
      { "name": "DS_WEBSOCKET_SERVER", "value": "false" },
      { "name": "DWN_STORAGE", "value": "postgres://..." },     // Aurora writer
      { "name": "DWN_STORAGE_READ", "value": "postgres://..." }, // Aurora reader
      { "name": "DWN_EVENT_LOG_PLUGIN_PATH", "value": "/app/plugins/event-log-nats.js" },
      { "name": "NATS_URL", "value": "nats://nats-1:4222,nats://nats-2:4222,nats://nats-3:4222" },
      { "name": "DWN_PG_POOL_MAX", "value": "20" },
      { "name": "MAX_RECORD_DATA_SIZE", "value": "1gb" }
    ],
    "secrets": [
      { "name": "DWN_ADMIN_TOKEN", "valueFrom": "arn:aws:secretsmanager:..." }
    ],
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -sf http://localhost:3000/health || exit 1"],
      "interval": 15, "timeout": 5, "retries": 3
    }
  }]
}
```

**dwn-ws (EC2 with Nitro Enclaves):**

```jsonc
{
  "family": "dwn-ws",
  "requiresCompatibilities": ["EC2"],
  "containerDefinitions": [{
    "name": "dwn",
    "image": "ECR_URI/dwn-server:latest",
    "portMappings": [{ "containerPort": 3000 }],
    "environment": [
      { "name": "DS_PORT", "value": "3000" },
      { "name": "DS_WEBSOCKET_SERVER", "value": "true" },
      { "name": "DWN_MAX_IN_FLIGHT", "value": "64" },
      // ... same store config as dwn-http
    ],
    "linuxParameters": {
      "devices": [{ "hostPath": "/dev/nitro_enclaves" }]
    }
  }, {
    "name": "nitro-enclave-proxy",
    "image": "ECR_URI/dwn-enclave-proxy:latest",
    "essential": true
    // vsock proxy for enclave communication
  }]
}
```

**Auto-scaling policies:**

| Service | Metric | Target | Min | Max |
|---|---|---|---|---|
| `dwn-http` | CPU utilization | 60% | 2 | 20 |
| `dwn-http` | Request count per target | 1000 req/min | 2 | 20 |
| `dwn-ws` | WebSocket connections per target | 5000 | 2 | 10 |

### 3.5 AWS Nitro Enclaves — Confidential Compute

**What runs inside the enclave:**

The enclave isolates all private key operations. No key material ever exists in
the main DWN process memory. The enclave provides:

1. **KMS-backed key derivation**: The enclave holds an attestation document that
   binds it to a specific KMS key policy. Only attested enclaves can call
   `kms:Decrypt` and `kms:GenerateDataKey`.

2. **ECDH-ES+A256KW key agreement**: When `DwnKeyStore` encrypts a private key
   record (Layer 2 encryption), the ECDH key agreement and AES key wrapping
   happen inside the enclave. The main process sends the public key and
   ciphertext in/out via vsock; it never sees the shared secret or unwrapped key.

3. **JWE encrypt/decrypt**: The `AgentDwnApi` encryption callbacks
   (`dwn-api.ts:458`) currently run in-process. With Nitro, these are proxied
   to the enclave via vsock RPC.

4. **Agent DID signing**: `Ed25519` signature operations for the agent's `#sig`
   key happen inside the enclave. The private key is derived from the HD seed
   (which itself is decrypted from KMS-encrypted ciphertext).

**Enclave architecture:**

```
┌─────────────────── EC2 Instance ───────────────────┐
│                                                     │
│  ┌─── Main VM ───────────────────────────────────┐  │
│  │                                               │  │
│  │  DWN Server Process (Bun)                     │  │
│  │    │                                          │  │
│  │    ├── RecordsWrite handler                   │  │
│  │    │     needs encrypt → vsock:5000 → enclave │  │
│  │    │                                          │  │
│  │    ├── DwnKeyStore.get()                      │  │
│  │    │     needs decrypt → vsock:5000 → enclave │  │
│  │    │                                          │  │
│  │    └── vsock proxy (CID:5000)                 │  │
│  │                                               │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌─── Nitro Enclave ────────────────────────────┐   │
│  │                                              │   │
│  │  Enclave Application (Rust or Bun)           │   │
│  │    │                                         │   │
│  │    ├── KMS client (via vsock → KMS proxy)    │   │
│  │    │     kms:Decrypt(seed ciphertext)        │   │
│  │    │     kms:GenerateDataKey(for new keys)   │   │
│  │    │                                         │   │
│  │    ├── HD key derivation (BIP-32)            │   │
│  │    │     seed → agent DID keys               │   │
│  │    │                                         │   │
│  │    ├── ECDH-ES+A256KW (X25519)              │   │
│  │    │     key agreement for JWE               │   │
│  │    │                                         │   │
│  │    ├── AES-256-GCM encrypt/decrypt           │   │
│  │    │     content encryption for JWE          │   │
│  │    │                                         │   │
│  │    └── Ed25519 signing                       │   │
│  │          agent DID message signatures        │   │
│  │                                              │   │
│  │  Memory: isolated, not accessible from VM    │   │
│  │  Network: vsock only (no TCP/IP)             │   │
│  │  Storage: none (stateless)                   │   │
│  │                                              │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**KMS key policy (attestation-bound):**

```json
{
  "Sid": "AllowEnclaveOnly",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::ACCOUNT:role/dwn-enclave-role" },
  "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
  "Condition": {
    "StringEqualsIgnoreCase": {
      "kms:RecipientAttestation:PCR0": "<enclave-image-hash>",
      "kms:RecipientAttestation:PCR1": "<kernel-hash>",
      "kms:RecipientAttestation:PCR2": "<application-hash>"
    }
  }
}
```

Only the exact enclave image (identified by PCR measurements) can decrypt the
master seed. Even a root user on the EC2 host cannot access key material.

**vsock RPC protocol:**

```typescript
// Request (main VM → enclave)
interface EnclaveRequest {
  op: 'sign' | 'encrypt' | 'decrypt' | 'derive-key' | 'key-agreement';
  // For sign:
  payload?: Uint8Array;       // data to sign
  keyId?: string;             // HD derivation path
  // For encrypt/decrypt:
  jwe?: GeneralJwe;           // JWE to decrypt, or plaintext + recipients to encrypt
  tenantDid?: string;         // for key lookup
}

// Response (enclave → main VM)
interface EnclaveResponse {
  signature?: Uint8Array;
  jwe?: GeneralJwe;
  plaintext?: Uint8Array;
  publicKey?: Jwk;            // only public key leaves the enclave
  error?: string;
}
```

**Integration with existing code:**

The `HdIdentityVault` (`agent/src/hd-identity-vault.ts`) currently holds the
decrypted seed in process memory after `unlock()`. With Nitro:

- `HdIdentityVault` is replaced by `NitroIdentityVault` that never holds the
  seed — it forwards `sign()`, `getKeyDeriver()`, and `getDerivedKey()` calls
  to the enclave via vsock.
- The `LocalKeyManager` delegates to the enclave for all private key operations.
- The `AgentDwnApi` encryption/decryption callbacks proxy through the enclave.

### 3.6 Large Blob Offloading — S3 Tiered Storage

**Problem:** `DataStoreSql` buffers the entire blob in RAM for both reads and
writes. A single 500 MB RecordsWrite would consume 500 MB of container memory.

**Solution:** Introduce a `TieredDataStore` that wraps `DataStoreSql`:

```
Write path:
  dataSize <= 256 KB → store inline in PostgreSQL `bytea` column (fast, no extra hop)
  dataSize >  256 KB → stream to S3, store S3 key in PG `dataReference` column

Read path:
  if dataReference is null → read from PG bytea
  if dataReference is set  → generate S3 presigned URL or stream from S3
```

**S3 bucket layout:**
```
s3://dwn-data-{account}-{region}/
  {tenant-did-hash}/
    {recordId}/
      {dataCid}
```

**S3 configuration:**
- Bucket policy: deny public access, require SSE-S3 or SSE-KMS.
- Lifecycle: transition to S3 Intelligent-Tiering after 30 days.
- The DWN server uses IAM task role (ECS) for S3 access — no static credentials.

This eliminates the memory-pressure risk for large blobs while keeping small
records fast (inline PG read is ~1ms vs ~10ms for S3).

---

## 4. Network Architecture

```
┌─────────────────────── VPC (10.0.0.0/16) ───────────────────────────┐
│                                                                      │
│  ┌──── Public Subnets (10.0.0.0/20, 10.0.16.0/20) ───────────────┐  │
│  │  ALB (internet-facing)                                          │  │
│  │  NAT Gateways                                                   │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──── Private Subnets — Compute (10.0.128.0/20, 10.0.144.0/20) ──┐ │
│  │  ECS: dwn-http (Fargate)                                        │ │
│  │  ECS: dwn-ws (EC2 + Nitro)                                      │ │
│  │  ECS: nats-jetstream (3 tasks)                                   │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌──── Private Subnets — Data (10.0.192.0/20, 10.0.208.0/20) ─────┐ │
│  │  Aurora PostgreSQL (writer + readers)                             │ │
│  │  ElastiCache (optional — for TTL cache / Web5 Connect state)     │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  Security Groups:                                                    │
│    sg-alb:       inbound 443 from 0.0.0.0/0                         │
│    sg-dwn:       inbound 3000 from sg-alb                            │
│    sg-nats:      inbound 4222,6222 from sg-dwn                       │
│    sg-aurora:    inbound 5432 from sg-dwn                            │
│    sg-s3:        VPC endpoint (gateway)                              │
│                                                                      │
│  VPC Endpoints:                                                      │
│    com.amazonaws.{region}.s3          (Gateway)                      │
│    com.amazonaws.{region}.kms         (Interface — for Nitro)        │
│    com.amazonaws.{region}.secretsmanager (Interface)                 │
│    com.amazonaws.{region}.ecr.api     (Interface)                    │
│    com.amazonaws.{region}.ecr.dkr     (Interface)                    │
│    com.amazonaws.{region}.logs        (Interface)                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Observability

### 5.1 Metrics (Prometheus + CloudWatch)

The DWN server already exposes Prometheus metrics at `GET /metrics`
(`packages/dwn-server/src/metrics.ts`). Deploy a Prometheus sidecar or use
AWS Managed Prometheus (AMP).

**Key metrics to alert on:**

| Metric | Alert Threshold | Meaning |
|---|---|---|
| `dwn_websocket_connections` | > 80% of target capacity | Scale out dwn-ws |
| `dwn_requests_total{status="error"}` rate | > 5% of total | DWN processing errors |
| `http_response_bucket{le="1"}` | < 95% | P95 latency above 1s |
| Aurora `CPUUtilization` | > 70% sustained | Scale up or add readers |
| Aurora `DatabaseConnections` | > 80% of max | Pool exhaustion risk |
| NATS `jetstream_consumer_num_pending` | > 10,000 per consumer | Slow consumer backlog |
| ECS `MemoryUtilization` | > 80% | Right-size or scale |

### 5.2 Logging

- Structured JSON logs via `loglevel` → CloudWatch Logs.
- Log group per service: `/ecs/dwn-http`, `/ecs/dwn-ws`, `/ecs/nats`.
- Correlation ID: propagate `JsonRpcRequest.id` through logs.

### 5.3 Tracing

- AWS X-Ray SDK or OpenTelemetry → X-Ray.
- Trace spans: `ALB → DWN processMessage → PG query → NATS publish`.
- Measure per-handler latency, per-store latency, enclave round-trip.

---

## 6. Deployment Pipeline

```
GitHub Push (feat/nitro-dwn-deployment)
    │
    ▼
GitHub Actions CI
    ├── bun run lint
    ├── bun run --filter @enbox/dwn-sdk-js build
    ├── bun run --filter @enbox/agent build
    ├── docker compose -f docker-compose.test.yaml up -d --wait
    ├── DID_DHT_GATEWAY_URI=http://localhost:7527 bun run test:node
    ├── docker build -t dwn-server .
    ├── docker build -t dwn-enclave --target enclave .
    └── nitro-cli build-enclave --docker-uri dwn-enclave --output-file dwn-enclave.eif
    │
    ▼
ECR Push (tagged with git SHA)
    │
    ▼
CDK / Terraform Deploy
    ├── Aurora schema migration (if needed)
    ├── ECS service update (rolling, 1 at a time for dwn-ws)
    ├── NATS stream/config update (idempotent)
    └── ALB health check gates (healthy before proceeding)
```

---

## 7. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-3)

| Task | Package | Description |
|---|---|---|
| Shared PG pool | `dwn-sql-store` | `SharedPoolProvider` class; all store instances share one `pg.Pool` |
| Read/write split | `dwn-sql-store` | `ReadReplicaAwareDialect` routing SELECTs to reader endpoint |
| Migration framework | `dwn-sql-store` | `dwn_migrations` table + sequential SQL files |
| Dockerize dwn-server | `dwn-server` | Multi-stage Bun Dockerfile |
| IaC scaffolding | `infra/` | CDK or Terraform for VPC, ALB, ECS, Aurora |

### Phase 2: Distributed EventLog (Weeks 3-5)

| Task | Package | Description |
|---|---|---|
| `NatsEventLog` | `dwn-server` (plugin) | Implements `EventLog` interface over NATS JetStream |
| NATS cluster | `infra/` | 3-node JetStream cluster in private subnets |
| Integration tests | `dwn-server` | Test subscribe flow across two DWN instances sharing NATS |
| Split HTTP/WS services | `dwn-server` | `DS_WEBSOCKET_SERVER=false` for HTTP fleet, `true` for WS fleet |

### Phase 3: Nitro Enclaves (Weeks 5-8)

| Task | Package | Description |
|---|---|---|
| Enclave application | `packages/dwn-enclave/` | Rust or Bun app: KMS decrypt, HD derivation, ECDH, signing |
| vsock RPC protocol | `packages/dwn-enclave/` | Request/response codec over vsock |
| `NitroIdentityVault` | `agent` | Replaces `HdIdentityVault`; delegates to enclave |
| `NitroKeyManager` | `agent` | Replaces `LocalKeyManager`; delegates signing/derivation |
| KMS key + policy | `infra/` | CMK with PCR-based attestation policy |
| Enclave EIF build | CI | `nitro-cli build-enclave` in CI pipeline |

### Phase 4: Production Hardening (Weeks 8-10)

| Task | Package | Description |
|---|---|---|
| `TieredDataStore` | `dwn-sql-store` or `dwn-server` | S3 offload for blobs > 256 KB |
| Table partitioning | `dwn-sql-store` | Hash partitioning on `tenant` for messageStoreMessages |
| Row-Level Security | `infra/` (migration) | RLS policies on all tenant-scoped tables |
| Observability | `infra/` | AMP, X-Ray, CloudWatch dashboards, PagerDuty alerts |
| Load testing | `tests/` | k6 or artillery scripts simulating multi-tenant workload |
| Chaos testing | `tests/` | Kill NATS node, kill dwn-ws instance, verify client catch-up |

---

## 8. Cost Estimate (Starter Scale — ~10K tenants, ~100 req/s)

| Component | Spec | Monthly Cost (est.) |
|---|---|---|
| Aurora PostgreSQL | 1 writer `db.r6g.xlarge` + 2 readers `db.r6g.large` | ~$900 |
| ECS Fargate (dwn-http) | 4 tasks, 1 vCPU / 2 GB each | ~$240 |
| ECS EC2 (dwn-ws) | 2x `c5.xlarge` (Nitro-capable) | ~$250 |
| NATS JetStream | 3x `c6g.large` (ECS or EC2) | ~$280 |
| ALB | 1 ALB + data transfer | ~$50 |
| S3 | ~500 GB stored, moderate GET/PUT | ~$15 |
| KMS | ~1M API calls/month | ~$10 |
| CloudWatch / AMP | Logs + metrics | ~$100 |
| NAT Gateway | 2 AZs | ~$70 |
| **Total** | | **~$1,915/mo** |

---

## 9. Tenant Sharding Strategy (Future — >100K tenants)

For extreme scale, the unified Aurora cluster can be sharded:

**Approach: Application-level shard routing by tenant DID hash.**

```
Shard key: SHA-256(tenant-did)[0:2]  (first byte = 256 shards)

Shard map (stored in a lightweight config service or DynamoDB):
  shard 0x00..0x3F → Aurora cluster A  (25% of tenants)
  shard 0x40..0x7F → Aurora cluster B
  shard 0x80..0xBF → Aurora cluster C
  shard 0xC0..0xFF → Aurora cluster D
```

The `ShardedDialect` would resolve the correct Aurora endpoint based on the
tenant DID before executing the query. Since every store method already takes
`tenant` as the first parameter, the routing is straightforward.

NATS subject design already includes the tenant hash prefix, so it naturally
partitions across shards.

---

## 10. Security Considerations

| Concern | Mitigation |
|---|---|
| Key material in process memory | Nitro Enclave: keys never leave enclave; vsock only |
| Cross-tenant data leak | RLS + application-level `WHERE tenant = ?` + audit logging |
| DWN admin API exposure | Bearer token (Secrets Manager), admin-only SG, no public ALB rule |
| Data at rest | Aurora: AES-256 (KMS-managed); S3: SSE-KMS; NATS: encrypted volumes |
| Data in transit | TLS 1.3 everywhere: ALB→ECS, ECS→Aurora (RDS CA), ECS→NATS (mTLS) |
| Enclave integrity | PCR-based KMS policy; enclave image hash verified at deploy time |
| DDoS | ALB + AWS Shield Standard; optional WAF rate limiting |
| Supply chain | ECR image scanning; Bun lockfile integrity; SBOM generation |

---

## 11. Open Questions

1. **NATS vs. self-managed**: Should NATS run as ECS tasks, or use a managed
   alternative like Amazon MSK (Kafka) with a Kafka-backed EventLog? NATS is
   simpler and lower-latency, but MSK is fully managed.

2. **Enclave language**: Rust for minimal attack surface and deterministic
   memory, or Bun for code sharing with the main DWN server? Rust is preferred
   for security-critical enclave code but increases maintenance burden.

3. **Multi-region**: Should the architecture support active-active multi-region
   from day one? Aurora Global Database + NATS super-clusters could enable this,
   but it adds significant complexity.

4. **Tenant migration**: If sharding is introduced later, what is the migration
   path for moving a tenant's data from one shard to another?

5. **WebSocket connection limits**: Bun's native WebSocket handles ~50K
   concurrent connections per process. Is that sufficient per `dwn-ws` instance,
   or do we need to split further?
