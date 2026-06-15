# Multi-Region DWN Plan: Fully Independent Stacks

> **Regions:** us-east-1 (Virginia) + us-west-2 (Oregon)
> **Estimated effort:** 2-3 weeks for a single developer

## Goals

1. Eliminate single points of failure — each region operates fully independently
2. Users get two DWN endpoints that are always in sync via a server-side sync daemon
3. If either region goes down, the other continues serving all users with zero failover procedure
4. No shared runtime infrastructure between regions

## Architecture

```
    us-east-1 (Virginia)                    us-west-2 (Oregon)
┌───────────────────────────┐          ┌───────────────────────────┐
│ ALB                       │          │ ALB                       │
│ DWN HTTP (Fargate, 2-20)  │          │ DWN HTTP (Fargate, 2-20)  │
│ DWN WS   (Fargate, 2-10) │          │ DWN WS   (Fargate, 2-10) │
│ Sync Daemon (Fargate, 1-3)│◄────────►│ Sync Daemon (Fargate, 1-3)│
│ Aurora PostgreSQL (own)   │          │ Aurora PostgreSQL (own)   │
│ S3 bucket (own)           │          │ S3 bucket (own)           │
│ NATS cluster (3-node)     │          │ NATS cluster (3-node)     │
│ Secrets Manager           │          │ Secrets Manager           │
└───────────────────────────┘          └───────────────────────────┘
         │                                      │
         └────── Route 53 (latency-based) ──────┘
                         │
                    dwn.enbox.id
              ┌──────────┴──────────┐
    us-east.dwn.enbox.id    us-west.dwn.enbox.id
```

### What Is NOT Shared (runtime)

| Component | Shared? | Notes |
|---|---|---|
| Aurora PostgreSQL | No | Independent cluster per region |
| S3 | No | Independent bucket per region |
| NATS core pub/sub | No | Independent 3-node wake cluster per region |
| ALB | No | One per region |
| Secrets Manager | No | Independent secrets per region |
| VPC | No | Independent VPC per region |

### What IS Shared (non-runtime)

| Component | Notes |
|---|---|
| Route 53 | Global by design, 100% SLA, not a SPOF |
| ECR images | Replicated from us-east-1 to us-west-2 |
| Terraform state bucket | Only matters at deploy time, not runtime |
| IAM roles | IAM is global |

### User DID Document

Each user's DID document lists both endpoints:

```json
{
  "service": [{
    "id": "#dwn",
    "type": "DecentralizedWebNode",
    "serviceEndpoint": [
      "https://us-east.dwn.enbox.id",
      "https://us-west.dwn.enbox.id"
    ]
  }]
}
```

`Web5.connect()` already iterates over all `serviceEndpointNodes` and registers the
DID with each server independently. No client-side code changes required for
registration.

### DNS Routing

Route 53 latency-based routing directs users to their nearest region:
- `dwn.enbox.id` — latency-based alias to us-east-1 or us-west-2 ALB
- `us-east.dwn.enbox.id` — direct alias to us-east-1 ALB
- `us-west.dwn.enbox.id` — direct alias to us-west-2 ALB
- Health checks on each ALB's `/health` endpoint for automatic failover

---

## Server-Side Sync Daemon

### Overview

When a write (RecordsWrite, ProtocolsConfigure, RecordsDelete) succeeds on the
local DWN, the sync daemon forwards it to the tenant's other DWN endpoint(s) in
the other region. This uses standard DWN protocol messages over HTTPS — no
infrastructure coupling between regions.

### Data Flow

```
NATS wake bus                 Sync Daemon                  Remote DWN
    │                              │                           │
    │ dwn.wakes.>                 │                           │
    │ (tenant wake only)           │                           │
    ├─────────────────────────────►│                           │
    │                              │ 1. Read tenant + seq      │
    │                              │    from wake payload      │
    │                              │ 2. Drain local durable    │
    │                              │    log from stored cursor │
    │                              │ 3. Resolve tenant's DWN   │
    │                              │    endpoints (cached)     │
    │                              │ 4. Filter out local       │
    │                              │    endpoint               │
    │                              │ 5. Read message + data    │
    │                              │    from local store/DWN   │
    │                              │ 6. Forward via            │
    │                              │    HttpDwnRpcClient       │
    │                              │────────────────────────────►
    │                              │    RecordsWrite / etc.     │
    │                              │◄────────────────────────────
    │                              │    202 / 409 (idempotent)  │
    │                              │ 7. Persist durable cursor  │
```

### Key Design Decisions

**MessageStore as the event source.** The sync daemon subscribes to local NATS
wakes (`dwn.wakes.>`), but treats them only as hints. The durable replication
log in the local MessageStore is the source of truth for replay, cursor
validation, and retry. If a wake is dropped or duplicated, the daemon resumes
from its stored durable cursor and drains the tenant log until caught up.

**DID resolution for endpoint discovery.** For each tenant DID, the daemon
resolves the DWN service endpoints from the DID document (via `DidDht.resolve()`).
Results are cached with a 1-hour TTL. The local region's endpoint is filtered
out — the daemon only forwards to other endpoints.

**HttpDwnRpcClient for forwarding.** The `@enbox/dwn-clients` package already
provides `HttpDwnRpcClient` with retry logic, exponential backoff, and rate
limit handling. The daemon reuses this directly.

**Loop prevention via DWN idempotency.** When the remote DWN receives a
forwarded write, its local NATS emits an event, and its sync daemon will attempt
to forward it back to the origin. The origin DWN returns `409` (message already
exists, same `messageCid`). The daemon treats 409 as success and ACKs the NATS
message. No infinite loop — just one extra round-trip that returns immediately.
No custom headers or code changes to the DWN server needed.

**Data payload handling.** The NATS wake payload contains no DWN message body.
For each durable log row, the daemon reads the message envelope and, for
RecordsWrite messages with `dataSize > 0`, reads the data from the local DWN via
MessagesRead before forwarding.

**Cursor persistence.** The daemon persists DWN progress tokens from the local
durable replication log. NATS sequence numbers are never stored as replication
cursors.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `DWN_SYNC_ENABLED` | `false` | Enable the sync daemon |
| `DWN_SYNC_LOCAL_ENDPOINT` | (required) | This region's DWN URL (excluded from forwarding targets) |
| `DWN_SYNC_CONCURRENCY` | `10` | Max parallel forwards |
| `DWN_SYNC_CONSUMER_NAME` | `sync-daemon` | Local daemon identity for durable cursor storage |
| `DWN_SYNC_BATCH_SIZE` | `50` | Durable log read batch size |
| `DWN_SYNC_DID_CACHE_TTL` | `3600` | DID resolution cache TTL (seconds) |

### Deployment

The sync daemon runs as a **separate ECS Fargate service** (not embedded in the
HTTP or WS services):
- Own autoscaling profile (1-3 tasks, CPU target tracking)
- Can be independently restarted without affecting user-facing services
- Sized at 512 CPU / 1024 MB per task
- Single NATS consumer for ordered processing; scale out for throughput

### Observability

- Prometheus metrics: `sync_events_forwarded_total`, `sync_events_failed_total`,
  `sync_events_skipped_total`, `sync_lag_seconds`
- Health check endpoint at `/health` (reports NATS connection state + durable cursor lag)
- CloudWatch alarms on durable cursor lag exceeding threshold

---

## Terraform Changes

### New Modules

#### `infra/modules/route53-latency/`

Latency-based DNS routing with health checks.

Creates:
- Latency-based alias records pointing each region's ALB
- Route 53 health checks per region (ALB `/health` endpoint)
- Per-region subdomain records (`us-east.dwn.enbox.id`, `us-west.dwn.enbox.id`)
- Main record (`dwn.enbox.id`) with latency-based routing

Inputs:
- `domain_name` — base domain (e.g., `dwn.enbox.id`)
- `zone_id` — Route 53 hosted zone ID
- `regions` — map of region name to `{ alb_dns_name, alb_zone_id, subdomain }`

### New Environments

#### `infra/environments/prod-us-west-2/`

Near-copy of `infra/environments/prod/` with:
- `var.aws_region = "us-west-2"`
- AZs: `us-west-2a`, `us-west-2b`, `us-west-2c`
- S3 bucket: `dwn-prod-data-us-west-2`
- Backend key: `env/prod-us-west-2/terraform.tfstate`
- Own ACM certificate ARN (us-west-2)
- Own ECR image URI (via replication)
- Own Secrets Manager secrets
- Sync daemon ECS service with `DWN_SYNC_ENABLED = true`

### Modified Environments

#### `infra/environments/prod/` (us-east-1)

Add:
- Sync daemon ECS service module invocation
- Sync daemon environment variables (`DWN_SYNC_ENABLED`, `DWN_SYNC_LOCAL_ENDPOINT`)
- Sync daemon IAM permissions (same as DWN HTTP — S3 access, Secrets Manager)
- Route 53 latency-based routing module invocation (if managing DNS from here)

### Modified Bootstrap

#### `infra/bootstrap/`

Add ECR replication configuration:
- `aws_ecr_replication_configuration` to replicate `dwn-server` images to us-west-2
- IAM permissions for cross-region ECR replication

### Existing Modules (No Changes Required)

| Module | Reason |
|---|---|
| `modules/vpc/` | Region derived from AZ names via regex; works for any region |
| `modules/aurora/` | Independent cluster per region; no cross-region config needed |
| `modules/ecs-cluster/` | Generic; works anywhere |
| `modules/ecs-service/` | Sync daemon uses same module with different parameters |
| `modules/alb/` | Each region gets its own ALB + ACM cert |
| `modules/s3-data/` | Each region gets its own bucket; no CRR needed |
| `modules/nats/` | Independent cluster per region |
| `modules/monitoring/` | Instantiated per region |

### CI/CD Changes

#### `.github/workflows/deploy.yml`

- After pushing image to ECR us-east-1, wait for replication to us-west-2
  (or push to both regions directly)
- Add deploy step for us-west-2 ECS services (HTTP, WS, Sync Daemon)
- Prod deployment deploys to both regions sequentially

#### `.github/workflows/terraform.yml`

- Detect `infra/environments/prod-us-west-2/` as an additional environment
- Plan/apply both prod regions on merge to main
- Manual approval gate applies to both regions (or independently)

---

## Implementation Phases

### Phase 1: Infrastructure Foundation

No new application code. Deploys two independent DWN stacks with DNS routing.

1. Add ECR replication rule to `infra/bootstrap/`
2. Create `infra/modules/route53-latency/`
3. Create `infra/environments/prod-us-west-2/` (copy of prod with region overrides)
4. Provision ACM certificate in us-west-2
5. Update `.github/workflows/deploy.yml` for dual-region image push + deploy
6. Update `.github/workflows/terraform.yml` for dual-region plan/apply
7. Apply Terraform — both stacks are live, Route 53 routes users to nearest

**Result:** Two fully independent DWN servers. Users pointed at both endpoints
can use either one, but data written to one does not appear on the other yet.

### Phase 2: Sync Daemon

New application code in the DWN server package.

8. Implement `packages/dwn-server/src/sync/sync-daemon.ts` (~500-800 lines):
   - NATS wake subscriber listening on `dwn.wakes.>`
   - Durable replication log reader with persisted DWN progress tokens
   - DID resolution + caching for endpoint discovery
   - Message reading from local DWN (for data payloads)
   - Forwarding via `HttpDwnRpcClient`
   - Health check + Prometheus metrics
9. Add sync daemon configuration to `packages/dwn-server/src/config.ts`
10. Add sync daemon startup to `packages/dwn-server/src/dwn-server.ts`
    (conditional on `DWN_SYNC_ENABLED`)
11. Write tests:
    - Unit tests with mocked NATS + HTTP client
    - Integration test with two local DWN instances
12. Add sync daemon ECS service to both prod environments
13. Deploy

**Result:** Both regions actively sync all writes to each other. Data written
to us-east appears in us-west within seconds (typically <500ms for the forward,
dominated by cross-region HTTPS latency).

### Phase 3: Client Integration

14. Update default `dwnEndpoints` in `Web5.connect()` to include both regions:
    ```typescript
    ['https://us-east.dwn.enbox.id', 'https://us-west.dwn.enbox.id']
    ```
15. Existing users: migration path via `agent.identity.setDwnEndpoints()` to
    update their DID documents with both endpoints, followed by
    `DwnRegistrar.registerTenant()` against the new endpoint
16. Update documentation and examples

**Result:** New users automatically get dual-region DWN endpoints. Existing
users can opt in.

---

## Cost Analysis

### 20,000 Users (1,000 paying at 5%)

| Component | us-east-1 | us-west-2 | Total |
|---|---|---|---|
| Fixed infra (NAT x3, VPC-E x5, ALB, Secrets, CW, ECR) | $769 | $769 | $1,538 |
| Fargate: HTTP (4 avg) + WS (3 avg) + NATS (3) | $1,311 | $1,049 | $2,360 |
| Fargate: Sync Daemon (1 task, 0.5 vCPU / 1 GB) | $48 | $48 | $96 |
| Aurora (r6g.xlarge + 500 GB storage + I/O) | $440 | $440 | $880 |
| S3 (~31 TB blended w/ Intelligent Tiering) + requests | $544 | $544 | $1,088 |
| Data transfer (users, ~1 TB/region) | $92 | $92 | $184 |
| Sync transfer (~2 TB/mo incremental cross-region) | $40 | $40 | $80 |
| Route 53 | — | — | $5 |
| **Total** | | | **$6,231/mo** |

#### Per Paid User (1,000 paying)

| Price | Revenue | Margin |
|---|---|---|
| $5.99/mo | $5,990 | -4% (slight loss) |
| $6.99/mo | $6,990 | 12% |
| $7.99/mo | $7,990 | 28% |
| $8.99/mo | $8,990 | 44% |

### 100,000 Users (5,000 paying at 5%)

| Component | us-east-1 | us-west-2 | Total |
|---|---|---|---|
| Fixed infra | $769 | $769 | $1,538 |
| Fargate: HTTP (15) + WS (8) + NATS (3) | $3,411 | $2,624 | $6,035 |
| Fargate: Sync Daemon (2 tasks) | $96 | $96 | $192 |
| Aurora (r6g.2xlarge + 1 TB + I/O) | $810 | $810 | $1,620 |
| S3 (~158 TB) + requests | $2,410 | $2,410 | $4,820 |
| Data transfer (users) | $461 | $368 | $829 |
| Sync transfer (~8 TB/mo) | $160 | $160 | $320 |
| Route 53 | — | — | $5 |
| **Total** | | | **$15,359/mo** |

#### Per Paid User (5,000 paying)

| Price | Revenue | Margin |
|---|---|---|
| $3.99/mo | $19,950 | 30% |
| $4.99/mo | $24,950 | 62% |
| $5.99/mo | $29,950 | 95% |
| $6.99/mo | $34,950 | 127% |

### Single-Region vs Multi-Region Comparison

| Metric | Single Region | Multi-Region |
|---|---|---|
| Total cost (20K users) | $2,814/mo | $6,231/mo |
| Total cost (100K users) | $8,037/mo | $15,359/mo |
| Cost per paid user (20K) | $2.81 | $6.23 |
| Cost per paid user (100K) | $1.61 | $3.07 |
| Availability | Single-AZ failure tolerant | Full region failure tolerant |
| Write latency | ~5ms | ~5ms (local) |
| Sync latency | N/A | <500ms cross-region |

### Recommended Pricing

| Scale | Recommended Price | Margin |
|---|---|---|
| Launch (20K) | **$7.99/mo** | 28% — survivable, builds buffer |
| Growth (50K) | **$5.99/mo** | ~60% — can reduce price to drive adoption |
| Scale (100K) | **$4.99/mo** | 62% — healthy SaaS margin |

---

## Assumptions

- **Storage utilization:** 60% of allocation (free users avg 90 MB of 150 MB;
  paid users avg 30 GB of 50 GB)
- **Traffic split:** ~60/40 between us-east-1 and us-west-2 (east-coast bias)
- **Fargate pricing:** us-east-1 on-demand rates ($0.04048/vCPU/hr,
  $0.004445/GB/hr); us-west-2 is identical
- **S3 pricing:** Standard at $0.023/GB, Intelligent Tiering infrequent at
  $0.0125/GB; ~80% of data older than 30 days
- **Cross-region transfer:** $0.02/GB (AWS inter-region within US)
- **Sync volume:** estimated at ~2 TB/mo incremental at 20K users, ~8 TB/mo at
  100K users (new data written per month that must be replicated)
- **Aurora I/O:** estimated at $0.20/million I/Os; moderate query load

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Sync daemon falls behind under load | Data divergence between regions | Autoscale to 3 tasks; NATS consumer lag alarm; increase batch size/concurrency |
| DID resolution failures | Daemon can't discover remote endpoints | Aggressive caching (1hr TTL); fallback to configured static endpoint map |
| Cross-region latency spikes | Sync forwarding slows | HttpDwnRpcClient has built-in retry with backoff; NATS buffers unACKed events |
| One region accumulates data the other lacks | Split-brain on extended outage | On recovery, NATS consumer replays unACKed events; agent sync engine provides additional reconciliation layer |
| Duplicate processing on daemon restart | Wasted work, not data corruption | DWN's 409 idempotency ensures no duplicate records |

## Open Questions

1. **Sync daemon placement:** Should the sync daemon be a separate entrypoint in
   the `dwn-server` image (e.g., `bun dist/esm/src/sync-main.js`), or a
   background process within the existing server started conditionally via
   `DWN_SYNC_ENABLED`?
2. **Monitoring consolidation:** Should CloudWatch dashboards aggregate metrics
   from both regions into a single cross-region dashboard?
3. **Cost optimization:** Should us-west-2 start with a smaller Aurora instance
   (`db.r6g.large`) if traffic is initially lower, and scale up later?
4. **Existing user migration:** What is the rollout strategy for adding the
   second endpoint to existing users' DID documents?
5. **Sync filtering:** Should free-tier users get server-side sync, or only
   paid users? Restricting to paid users would reduce sync daemon load and
   cross-region transfer costs.
