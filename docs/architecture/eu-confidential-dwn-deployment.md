# E2E DWN Deployment on EU Bare Metal with Edgeless Contrast

## Executive Summary

This document describes the third DWN service provider deployment: a
confidential-compute-capable DWN hosted on EU bare metal using Edgeless
Systems' **Contrast** runtime for hardware-backed workload isolation. It
complements the existing Fly.io deployment (no confidential compute) and the
planned AWS deployment (Nitro Enclaves).

The three-provider strategy:

| Provider | Region | Confidential Compute | TEE Model |
|---|---|---|---|
| Fly.io | US East (`iad`) | None | N/A |
| AWS | US / multi-region | Nitro Enclaves | Split process: untrusted DWN + trusted enclave |
| **EU Bare Metal** | **EU (France)** | **Contrast (SEV-SNP)** | **Whole-container confidential VM** |

The EU deployment uses AMD SEV-SNP hardware at **OVHcloud** (Gravelines or
Strasbourg datacenters) with Contrast providing confidential Kubernetes pods,
attestation, and certificate-based service mesh. The entire DWN container runs
inside a hardware-isolated confidential micro-VM — no vsock RPC or split
architecture needed.

**Estimated timeline**: 3-4 weeks (see accelerated roadmap, Section 7)  
**Estimated monthly cost**: ~€1,225-1,275/mo at starter scale (~10K tenants)

---

## 0. Multi-Provider Launch Plan (3-4 Weeks)

This section covers launching **all 3-4 DWN service providers** within the
next few weeks. The key insight is that the DWN server already has everything
it needs for production Postgres-backed deployments — no new application code
is required for any of the initial launches.

### Current Readiness Assessment

| Component | Status | Notes |
|---|---|---|
| DWN server with Postgres | **Production-ready** | CI-validated, runs all 748 agent tests |
| Shared PG connection pool | **Implemented** | `storage.ts` caches dialects by URL |
| NATS EventLog plugin | **Implemented + tested** | `plugins/event-log-nats.ts` (454 lines, 20+ tests) |
| S3 DataStore (blob offload) | **Implemented + tested** | `dwn-sql-store/src/data-store-s3.ts` (CI runs against MinIO) |
| Provider auth (JWT) | **Implemented** | Built-in open-auth + JWT validation |
| Admin API | **Implemented** | Bearer token auth, metrics, activity log, audit |
| Prometheus metrics | **Implemented** | `prom-client` at `/metrics` |
| Root Dockerfile | **Production-grade** | 3-stage alpine, tini, non-root, healthcheck |
| Helm chart | **Skeleton** | Needs env vars, secrets, probes, HPA |
| Read-replica routing | **Not implemented** | Not needed for launch; single Postgres is fine |

### The 3-4 Providers

| # | Provider | Region | TEE | Complexity | Target |
|---|---|---|---|---|---|
| 1 | **Fly.io** | US East (`iad`) | None | Already running | Week 0 (done) |
| 2 | **AWS (simple)** | US East | None (initially) | Low | Week 1-2 |
| 3 | **OVHcloud + Contrast** | EU (France) | SEV-SNP | Medium-high | Week 2-4 |
| 4 | **AWS + Nitro** | US | Nitro Enclaves | High | Future (8-10 weeks, per existing plan) |

Provider 2 (AWS simple) is a near-copy of the Fly.io setup: ECS Fargate or
EC2 running the same Docker image with an RDS PostgreSQL backend. No Nitro
Enclaves — just a standard cloud deployment that gives US users a non-Fly
option with better infrastructure (RDS, ALB, CloudWatch). The full Nitro
enclave work (Provider 4) can follow later as described in the existing
`aws-dwn-deployment.md` plan.

This gives users **three distinct trust/region profiles** at launch:

1. **Fly.io**: Cheapest, simplest, US-based, no TEE
2. **AWS**: US-based, production-grade infra (RDS, ALB), no TEE initially
3. **OVHcloud EU**: EU sovereign, confidential compute (SEV-SNP), full TEE

### Accelerated Week-by-Week Plan

**Week 1: Foundation (all providers in parallel)**

| Task | Provider | Owner | Description |
|---|---|---|---|
| Harden Helm chart | All K8s | Dev | Add all DWN env vars, Secrets refs, health probes, HPA to `packages/dwn-server/charts/` |
| Use root Dockerfile | All | Dev | Switch CI/CD to use the hardened root `Dockerfile` (tini, non-root, alpine) |
| AWS account + VPC | AWS | Infra | VPC, subnets, security groups, RDS PostgreSQL (single-AZ `db.t4g.medium` to start) |
| AWS ECS/Fargate | AWS | Infra | Task definition using the DWN Docker image, ALB, health checks |
| OVHcloud account + servers | EU | Infra | Order 3x Scale-range bare metal (AMD EPYC Genoa). Set up vRack. |
| OVHcloud Managed PG | EU | Infra | Provision PostgreSQL. Create database + user. |
| BIOS/firmware/kernel | EU | Infra | SEV-SNP BIOS config, Linux 6.11+, firmware flash (takes 1-2 days per node) |

**Week 2: Services Up (AWS launches, EU K8s bootstraps)**

| Task | Provider | Owner | Description |
|---|---|---|---|
| AWS deploy | AWS | Infra | DWN on ECS + RDS. Configure provider auth, admin token. Deploy. Verify `/info` + RecordsWrite. |
| AWS CI/CD | AWS | DevOps | GitHub Actions: build → ECR push → ECS rolling update |
| K3s cluster | EU | Infra | K3s v1.34+ on 3 nodes. Longhorn for storage. Verify cluster. |
| Contrast runtime | EU | Infra | Install Contrast node-installer + runtime. Verify `contrast-cc` RuntimeClass. |
| OVHcloud registry | EU | Infra | Push DWN image to Managed Private Registry. |
| NATS StatefulSet | EU | Infra | Deploy 3-node NATS JetStream in Contrast CVMs. Verify stream creation. |

**Week 3: EU DWN Launch**

| Task | Provider | Owner | Description |
|---|---|---|---|
| Contrast Coordinator | EU | Infra | Deploy Coordinator. Generate manifest from K8s YAML. |
| Vault deploy | EU | Infra | Deploy Vault in Contrast CVM. Seed secrets (PG pass, JWT secret, admin token). |
| Vault attestation auth | EU | Infra | Configure Contrast-based auth method. Test secret retrieval from attested pod. |
| entrypoint-contrast.sh | EU | Dev | Startup script: Vault auth → fetch secrets → env export → exec DWN. (~50 lines) |
| DWN deployment | EU | Infra | Deploy DWN pods (2 replicas) with Contrast runtime + NATS EventLog plugin. |
| Ingress + TLS | EU | Infra | nginx Ingress with Let's Encrypt. HTTP/WS routing. |
| E2E validation | EU | QA | Full flow: attestation → Vault → DWN → RecordsWrite/Read → WebSocket. |

**Week 4: Hardening + Documentation**

| Task | Provider | Owner | Description |
|---|---|---|---|
| Monitoring (all) | All | Infra | Prometheus/Grafana (EU), CloudWatch (AWS). Alerting on failures. |
| Attestation alerts | EU | Infra | Alert on failed attestation (tampering detection). |
| Provider selection docs | All | Dev | User-facing documentation on choosing a provider (trust model, region, features). |
| Fly.io parity check | Fly.io | Dev | Ensure existing Fly deployment has same provider auth, admin API config. |
| Load testing | All | QA | k6 scripts for all 3 providers. Baseline performance. |
| Runbook | All | Infra | Ops procedures: deployment, upgrades, rollback, incident response per provider. |

### What's Intentionally Deferred

These are Phase 2+ items that are not needed for launch:

| Item | Why Deferred | Target |
|---|---|---|
| AWS Nitro Enclaves | Requires significant new code (`NitroIdentityVault`, `NitroKeyManager`, vsock RPC, Rust enclave app) | Weeks 5-12 (per `aws-dwn-deployment.md`) |
| Read-replica routing | Single Postgres handles ~100 req/s fine | When needed |
| S3/Object Storage blob offload | Postgres handles initial data volumes. `DataStoreS3` is ready when needed. | When average record size or volume requires it |
| Multi-region EU | Single datacenter is sufficient for launch | Phase 5+ |
| Tenant sharding | Not needed at <100K tenants | Phase 5+ |
| Row-Level Security | Application-level tenant isolation is sufficient initially | Phase 3+ |

---

## 1. Provider Selection: OVHcloud

### Why OVHcloud over Scaleway

| Criterion | OVHcloud | Scaleway |
|---|---|---|
| AMD EPYC Genoa (SEV-SNP) bare metal | Yes — Scale (T4) and High Grade (T5) ranges | Elastic Metal has EPYC but model availability is less documented |
| EU datacenters | France (GRA, SBG, RBX), Germany (DE1), Poland (WAW) | France (PAR), Netherlands (AMS) |
| Managed PostgreSQL | Yes — Public Cloud Databases (PostgreSQL) | Yes |
| Managed NATS | No (self-hosted) | Yes (native product) |
| Managed Kubernetes | Yes — Public Cloud Kubernetes | Yes — Kapsule/Kosmos |
| Terraform provider | Yes (official, mature) | Yes (official) |
| SecNumCloud qualification | Yes (ANSSI-qualified offerings) | No |
| Bare metal BIOS/firmware access | Yes — full IPMI/iKVM access on dedicated servers | Elastic Metal has limited firmware config |
| vRack private networking | Yes — L2 private network across products | VPC available but less flexible for bare metal |

**Key factor**: SEV-SNP requires BIOS-level configuration (SMEE, IOMMU, RMP
coverage, SEV-ES ASID). OVHcloud dedicated servers provide full BIOS access
via IPMI/iKVM, which is essential. Scaleway's Elastic Metal abstracts the BIOS
and may not expose the SEV-SNP toggles.

### Selected OVHcloud Products

| Component | OVHcloud Product | Purpose |
|---|---|---|
| K8s worker nodes | **Dedicated Server — Scale range** (AMD EPYC 9004 Genoa) | Confidential VM hosts (Contrast runtime) |
| Kubernetes control plane | **OVHcloud Managed Kubernetes** or self-hosted K3s | Cluster orchestration |
| PostgreSQL | **OVHcloud Public Cloud Databases — PostgreSQL** | All DWN storage (messages, data, state, resumable tasks, TTL cache, registration) |
| Container registry | **OVHcloud Managed Private Registry** (Harbor-based) | DWN server images |
| Object storage | **OVHcloud Object Storage** (S3-compatible) | Large blob offloading (>256 KB) |
| Load balancer | **OVHcloud Load Balancer** or Kubernetes Ingress (nginx) | TLS termination, HTTP/WS routing |
| Private network | **vRack** | L2 isolation between bare metal, K8s, and databases |
| DNS | **OVHcloud DNS** or external (Cloudflare) | Public-facing DNS |
| Secret management | **HashiCorp Vault** (self-hosted in Contrast) | Attestation-gated secret delivery |

---

## 2. Target Architecture

```
                        Internet
                           │
                    ┌──────┴──────┐
                    │   OVHcloud   │
                    │  Load Balancer│
                    │  (TLS 1.3)  │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │  rule: Upgrade:websocket │
              │    → dwn-ws (sticky)    │
              │  default                │
              │    → dwn-http (round-robin)│
              └────────────┬────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    │                Kubernetes Cluster            │
    │         (K3s on OVHcloud Bare Metal)         │
    │                                              │
    │  ┌──────────── Contrast Runtime ──────────┐  │
    │  │                                        │  │
    │  │  ┌─────────────────────────────────┐   │  │
    │  │  │  DWN Server Pod (Confidential)  │   │  │
    │  │  │  ┌───────────────────────────┐  │   │  │
    │  │  │  │  Contrast Init Container  │  │   │  │
    │  │  │  │  (attestation + mTLS cert)│  │   │  │
    │  │  │  └───────────────────────────┘  │   │  │
    │  │  │  ┌───────────────────────────┐  │   │  │
    │  │  │  │  DWN Server (Bun)         │  │   │  │
    │  │  │  │                           │  │   │  │
    │  │  │  │  ├── HdIdentityVault      │  │   │  │
    │  │  │  │  │   (seed in-memory,     │  │   │  │
    │  │  │  │  │    HW-isolated)        │  │   │  │
    │  │  │  │  │                        │  │   │  │
    │  │  │  │  ├── DwnKeyStore          │  │   │  │
    │  │  │  │  │   (encrypted at rest)  │  │   │  │
    │  │  │  │  │                        │  │   │  │
    │  │  │  │  └── AgentDwnApi          │  │   │  │
    │  │  │  │      (JWE encrypt/decrypt │  │   │  │
    │  │  │  │       all in-enclave)     │  │   │  │
    │  │  │  └───────────────────────────┘  │   │  │
    │  │  │                                 │   │  │
    │  │  │  Memory: encrypted (SEV-SNP)    │   │  │
    │  │  │  Network: mTLS via Contrast CA  │   │  │
    │  │  │  Storage: encrypted volumes     │   │  │
    │  │  └─────────────────────────────────┘   │  │
    │  │                                        │  │
    │  │  ┌─────────────────────────────────┐   │  │
    │  │  │  Contrast Coordinator Pod       │   │  │
    │  │  │  (attestation authority + CA)   │   │  │
    │  │  └─────────────────────────────────┘   │  │
    │  │                                        │  │
    │  │  ┌─────────────────────────────────┐   │  │
    │  │  │  HashiCorp Vault Pod            │   │  │
    │  │  │  (attestation-gated secrets)    │   │  │
    │  │  └─────────────────────────────────┘   │  │
    │  │                                        │  │
    │  │  ┌─────────────────────────────────┐   │  │
    │  │  │  NATS JetStream (3-node)        │   │  │
    │  │  │  (distributed EventLog)         │   │  │
    │  │  └─────────────────────────────────┘   │  │
    │  │                                        │  │
    │  └────────────────────────────────────────┘  │
    │                                              │
    └──────────────────┬───────────────────────────┘
                       │ vRack private network
              ┌────────┴────────┐
              │  OVHcloud Managed│
              │  PostgreSQL     │
              │  (primary +     │
              │   read replica) │
              └─────────────────┘
```

### Key Architectural Difference from AWS

With AWS Nitro Enclaves, the DWN process is **split** into an untrusted main
VM and a trusted enclave connected via vsock. Key material never exists in the
main process; all crypto operations are proxied to the enclave.

With Contrast, the **entire DWN container** runs inside a confidential
micro-VM (CVM). The hardware (AMD SEV-SNP) encrypts all memory belonging to
the CVM. The host OS, hypervisor, and cluster administrators cannot read the
DWN process memory. This means:

- `HdIdentityVault` works **as-is** — the seed is in-memory but
  hardware-encrypted. No `NitroIdentityVault` equivalent needed.
- `LocalKeyManager` works **as-is** — private key operations happen inside
  the CVM. No `NitroKeyManager` equivalent needed.
- `AgentDwnApi` encryption/decryption callbacks run **in-process** — no vsock
  proxy needed.
- No `packages/dwn-enclave/` needed. No Rust enclave application.
- The only new code is the **secret bootstrapping** (retrieving the encrypted
  seed from Vault on startup, gated by attestation).

| Concern | AWS Nitro Approach | Contrast Approach |
|---|---|---|
| Key isolation | Enclave process (vsock RPC) | Entire CVM (hardware memory encryption) |
| New packages needed | `dwn-enclave`, `NitroIdentityVault`, `NitroKeyManager` | None — existing code runs unmodified |
| Attestation | PCR-based KMS policy (AWS proprietary) | SEV-SNP report → Contrast Coordinator → Vault |
| Key release | KMS `kms:Decrypt` with attestation condition | Vault with Contrast attestation plugin |
| Network isolation | vsock (no TCP/IP in enclave) | mTLS service mesh (Contrast CA issues certs) |
| Code changes to `agent` | Significant (new vault + key manager) | Minimal (startup script for Vault secret fetch) |
| Code changes to `dwn-server` | Moderate (vsock proxy integration) | None for core; Helm chart + config only |

---

## 3. Component Deep-Dives

### 3.1 Contrast Runtime — Confidential Kubernetes Pods

**What it provides:**
- Custom Kubernetes `RuntimeClass` (`contrast-cc`) backed by Kata Containers
  with AMD SEV-SNP CVMs
- Runtime policies that strictly control host-to-CVM communication
- Attestation init container that verifies CVM integrity before workload starts

**How it works with our DWN pod:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dwn-server
spec:
  replicas: 2
  template:
    spec:
      runtimeClassName: contrast-cc    # <-- confidential VM
      initContainers:
        - name: contrast-initializer   # <-- attestation + mTLS cert
          image: ghcr.io/edgelesssys/contrast/initializer:v1.16
          volumeMounts:
            - name: contrast-tls-certs
              mountPath: /tls-config
      containers:
        - name: dwn-server
          image: registry.ovh.enbox.org/dwn-server:main
          ports:
            - containerPort: 3000
          env:
            - name: DS_PORT
              value: "3000"
            # ... DWN config (see Section 3.3)
          volumeMounts:
            - name: contrast-tls-certs
              mountPath: /tls-config
              readOnly: true
      volumes:
        - name: contrast-tls-certs
          emptyDir: {}
```

The `contrast-initializer` contacts the Coordinator, presents the CVM's
SEV-SNP attestation report, and receives a TLS certificate if the report
matches the manifest. The DWN server then uses this cert for mTLS.

**Contrast manifest** (`manifest.json`):

Generated by `contrast generate` from the Kubernetes YAML. Contains SHA-256
hashes of all approved container images (DWN server, Vault, NATS, Coordinator).
Any tampering with images causes attestation failure.

### 3.2 OVHcloud Managed PostgreSQL — Unified Data Plane

Same architecture as the AWS plan: a single PostgreSQL instance backing all
DWN stores with a shared connection pool.

**Configuration:**

| Parameter | Value |
|---|---|
| Plan | `db2-15` (4 vCPU, 15 GB RAM, 160 GB storage) |
| Engine | PostgreSQL 16 |
| Nodes | 1 primary + 1 read replica |
| Network | vRack private network (no public endpoint) |
| Encryption | TLS in transit, AES-256 at rest (OVHcloud-managed keys) |
| Backup | Daily automated, 30-day retention |

**DWN server env vars** (all pointing to the same Postgres):

```bash
DWN_STORAGE_MESSAGES=postgres://dwn:${PG_PASS}@pg-primary.vrak:5432/dwn
DWN_STORAGE_DATA=postgres://dwn:${PG_PASS}@pg-primary.vrak:5432/dwn
DWN_STORAGE_STATE_INDEX=postgres://dwn:${PG_PASS}@pg-primary.vrak:5432/dwn
DWN_STORAGE_RESUMABLE_TASKS=postgres://dwn:${PG_PASS}@pg-primary.vrak:5432/dwn
DWN_TTL_CACHE_URL=postgres://dwn:${PG_PASS}@pg-primary.vrak:5432/dwn
DWN_REGISTRATION_STORE_URL=postgres://dwn:${PG_PASS}@pg-primary.vrak:5432/dwn
```

### 3.3 NATS JetStream — Distributed EventLog

Self-hosted NATS JetStream cluster running inside Contrast confidential pods.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nats
spec:
  replicas: 3
  template:
    spec:
      runtimeClassName: contrast-cc
      containers:
        - name: nats
          image: nats:2.10-alpine
          args:
            - "--jetstream"
            - "--cluster_name=dwn-nats"
            - "--store_dir=/data/jetstream"
          ports:
            - containerPort: 4222    # client
            - containerPort: 6222    # cluster
          volumeMounts:
            - name: nats-data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: nats-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 50Gi
```

Stream config matches the AWS plan:

| Parameter | Value |
|---|---|
| Stream name | `DWN_EVENTS` |
| Subjects | `dwn.events.{tenant-hash-prefix}.{tenant-did-base64url}` |
| Replication | R=3 |
| Retention | 7 days / 50 GB |
| Storage | File-backed (persistent volumes) |

### 3.4 HashiCorp Vault — Attestation-Gated Secret Delivery

This is the **key innovation** that replaces AWS KMS + PCR-based attestation
policy. Contrast has native Vault integration.

**How it works:**

1. Vault runs as a Contrast confidential pod (same attestation guarantees).
2. Vault is configured with a Contrast-aware auth method that validates
   SEV-SNP attestation from requesting pods.
3. The DWN server's startup script authenticates to Vault via Contrast
   attestation, then retrieves the encrypted seed and other secrets.
4. If the DWN container image has been tampered with (hash doesn't match
   the Contrast manifest), attestation fails and Vault refuses to release
   secrets.

**Security equivalence to Nitro KMS:**

| AWS Nitro + KMS | Contrast + Vault |
|---|---|
| PCR0 (enclave image hash) | Contrast manifest (container image SHA-256) |
| PCR1 (kernel hash) | SEV-SNP launch measurement (firmware + kernel) |
| PCR2 (application hash) | Runtime policy hash (Contrast-generated) |
| `kms:Decrypt` condition | Vault policy with Contrast attestation auth |
| KMS CMK | Vault transit secrets engine (or unsealed master key) |

**Vault policy example:**

```hcl
# Only attested DWN pods can read the seed
path "secret/data/dwn/seed" {
  capabilities = ["read"]
}

path "secret/data/dwn/provider-auth-secret" {
  capabilities = ["read"]
}

path "secret/data/dwn/admin-token" {
  capabilities = ["read"]
}
```

### 3.5 Secret Bootstrap Flow

```
┌─────────────────────────────────────────────┐
│  DWN Pod Startup (inside confidential CVM)  │
│                                             │
│  1. contrast-initializer runs               │
│     → presents SEV-SNP report to Coordinator│
│     → receives mTLS cert if manifest matches│
│                                             │
│  2. entrypoint.sh runs                      │
│     → uses Contrast attestation token       │
│       to authenticate to Vault              │
│     → fetches secrets:                      │
│       - HD seed (encrypted blob)            │
│       - Postgres password                   │
│       - Provider auth JWT secret            │
│       - Admin token                         │
│     → exports as env vars                   │
│     → exec bun dwn-server/dist/esm/main.js │
│                                             │
│  3. DWN server starts                       │
│     → HdIdentityVault.initialize(password)  │
│       decrypts seed in-memory (HW-encrypted)│
│     → connects to Postgres via vRack        │
│     → connects to NATS cluster              │
│     → begins serving on :3000               │
└─────────────────────────────────────────────┘
```

### 3.6 Large Blob Offloading — OVHcloud Object Storage

Same strategy as the AWS S3 tier: blobs larger than 256 KB are offloaded to
S3-compatible object storage.

| Parameter | Value |
|---|---|
| Backend | OVHcloud Object Storage (S3 API) |
| Bucket layout | `{tenant-did-hash}/{recordId}/{dataCid}` |
| Encryption | SSE with OVHcloud-managed keys |
| Lifecycle | Transition to cold storage after 30 days |

---

## 4. Network Architecture

```
┌──────────────── OVHcloud vRack ────────────────────┐
│                                                     │
│  ┌─── Public Subnet ───────────────────────────┐   │
│  │  OVHcloud Load Balancer (public IP)          │   │
│  │  HTTPS :443 → K8s Ingress                   │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌─── Private Compute Subnet (10.0.1.0/24) ────┐   │
│  │  Bare Metal Node 1 (K3s + Contrast runtime)  │   │
│  │  Bare Metal Node 2 (K3s + Contrast runtime)  │   │
│  │  Bare Metal Node 3 (K3s + Contrast runtime)  │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌─── Private Data Subnet (10.0.2.0/24) ───────┐   │
│  │  OVHcloud Managed PostgreSQL                  │   │
│  │  (primary + read replica)                     │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌─── Private Storage Subnet (10.0.3.0/24) ────┐   │
│  │  OVHcloud Object Storage (S3 endpoint)        │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Security groups / firewall rules:**

| Source | Destination | Port | Protocol | Purpose |
|---|---|---|---|---|
| Internet | Load Balancer | 443 | HTTPS | Client traffic |
| Load Balancer | K8s nodes | 3000 | HTTP/WS | DWN server |
| K8s pods | PostgreSQL | 5432 | TCP (TLS) | Database |
| K8s pods (NATS) | K8s pods (NATS) | 4222, 6222 | TCP (mTLS) | NATS client + cluster |
| K8s pods (DWN) | K8s pods (Vault) | 8200 | TCP (mTLS) | Secret retrieval |
| K8s pods (DWN) | Object Storage | 443 | HTTPS | Blob offload |

All pod-to-pod traffic within the Contrast service mesh uses mTLS with
certificates issued by the Contrast Coordinator CA.

---

## 5. Observability

### 5.1 Metrics (Prometheus)

The DWN server already exposes Prometheus metrics (via `prom-client`). Deploy
Prometheus + Grafana inside the cluster (or use OVHcloud's Logs Data Platform).

Key metrics to monitor:
- `dwn_http_requests_total` (by method, status)
- `dwn_ws_connections_active`
- `dwn_storage_bytes_total` (per tenant)
- `dwn_messages_total` (per tenant)
- `nats_jetstream_consumer_pending`
- Node-level: CPU, memory, disk I/O, SEV-SNP status

### 5.2 Logging

Structured JSON logs (DWN server default). Ship to OVHcloud Logs Data Platform
or self-hosted Loki.

```bash
DWN_SERVER_LOG_LEVEL=INFO
```

### 5.3 Attestation Monitoring

The Contrast Coordinator exposes attestation events. Monitor for:
- Failed attestation attempts (image tampering, measurement mismatch)
- Certificate issuance/renewal events
- Vault secret access audit log

---

## 6. Deployment Pipeline

```
GitHub Push (main or release branch)
    │
    ▼
GitHub Actions CI
    ├── bun run lint
    ├── bun run --filter @enbox/dwn-sdk-js build
    ├── bun run --filter @enbox/agent build
    ├── docker compose -f docker-compose.test.yaml up -d --wait
    ├── DID_DHT_GATEWAY_URI=http://localhost:7527 bun run test:node
    └── docker build -t dwn-server .
    │
    ▼
Push to OVHcloud Managed Private Registry
    (tagged with git SHA + :latest)
    │
    ▼
contrast generate                    # regenerate manifest from K8s YAML
    │                                 # (updates image hashes)
    ▼
contrast set (update Coordinator manifest)
    │
    ▼
kubectl apply -f k8s/               # rolling update
    ├── DWN pods restart with new image
    ├── contrast-initializer re-attests against new manifest
    ├── Vault auth succeeds (image hash matches)
    └── Health check gates (/health) before routing traffic
```

**Key difference from Fly.io deploy**: After pushing the image, we must also
update the Contrast manifest (which contains the image digests). This is an
extra step but ensures that only the exact approved image can run.

**Key difference from AWS deploy**: No `nitro-cli build-enclave` step. No EIF
file. The standard Docker image is used directly — Contrast wraps it in a
confidential micro-VM at runtime.

---

## 7. Implementation Roadmap

See **Section 0** for the accelerated 3-4 week cross-provider launch plan.

The following phases describe the EU Contrast deployment specifically, mapped
to the accelerated timeline:

### Week 1: Infrastructure Foundation

| Task | Owner | Description |
|---|---|---|
| Provision OVHcloud bare metal | Infra | 3x Scale-range AMD EPYC Genoa servers (GRA or SBG datacenter) |
| BIOS/firmware config | Infra | Enable SMEE, IOMMU, RMP coverage, SEV-SNP via IPMI/iKVM. Flash latest AMD firmware to `/lib/firmware/amd`. |
| Kernel setup | Infra | Install Linux 6.11+ on all nodes. Verify SEV-SNP: `dmesg \| grep -i sev` |
| vRack + Managed PG | Infra | Private network. Provision PostgreSQL (`db2-15`). Create `dwn` database + user. |
| OVHcloud registry | Infra | Create Managed Private Registry project. Push DWN server image. |
| Harden Helm chart | Dev | Add all DWN env vars, K8s Secrets, health probes, HPA to `packages/dwn-server/charts/`. (Shared: benefits all K8s deploys.) |

### Week 2: K8s + Contrast + NATS

| Task | Owner | Description |
|---|---|---|
| K3s cluster | Infra | Deploy K3s v1.34+ across 3 nodes. Install Longhorn for block storage. |
| Contrast runtime install | Infra | Install Contrast node-installer ConfigMap + runtime. Verify `contrast-cc` RuntimeClass. |
| NATS JetStream | Infra | Deploy 3-node NATS StatefulSet with Contrast runtime. Configure `DWN_EVENTS` stream. |
| Contrast Coordinator | Infra | Deploy Coordinator pod. Generate initial manifest. |

### Week 3: Vault + DWN Launch

| Task | Owner | Description |
|---|---|---|
| HashiCorp Vault | Infra | Deploy Vault as a Contrast confidential pod. Seed secrets. Configure attestation-based auth. |
| entrypoint-contrast.sh | Dev | Startup script: Vault auth → fetch secrets → env export → exec DWN. (~50 lines) |
| DWN deployment | Infra | Deploy DWN pods (2 replicas) with Contrast runtime + NATS EventLog plugin. |
| Ingress + TLS | Infra | nginx Ingress with Let's Encrypt. HTTP/WS routing. |
| E2E validation | QA | Full flow: attestation → Vault → DWN → RecordsWrite/Read → WebSocket. |
| CI/CD pipeline | DevOps | GitHub Actions: build → OVHcloud registry → `contrast generate/set` → `kubectl apply`. |

### Week 4: Hardening

| Task | Owner | Description |
|---|---|---|
| Monitoring | Infra | Prometheus + Grafana. DWN metrics, NATS, Postgres, SEV-SNP status dashboards. |
| Attestation alerting | Infra | Alert on failed attestation attempts (potential tampering). |
| Load testing | QA | k6 scripts targeting the EU deployment. Baseline performance. |
| Documentation | All | Operator runbook: deployment, upgrades, incident response, seed recovery. |

### Future Phases (Post-Launch)

| Item | Timeline | Description |
|---|---|---|
| AWS Nitro Enclaves (Provider 4) | Weeks 5-12 | Full Nitro integration per `aws-dwn-deployment.md` Phase 3 |
| S3/Object Storage blob offload | When needed | Wire `DataStoreS3` into dwn-server config (already implemented) |
| Read-replica routing | When needed | `ReadReplicaAwareDialect` for Postgres read scaling |
| Coordinator HA | Week 5+ | Contrast HA mode for Coordinator |
| Multi-region EU | Phase 5+ | Cross-DC NATS replication + multi-node Postgres |
| Tenant sharding | >100K tenants | Application-level shard routing per `aws-dwn-deployment.md` Section 9 |

---

## 8. Cost Estimate (Starter Scale — ~10K tenants, ~100 req/s)

| Component | OVHcloud Product | Spec | Monthly Cost (est.) |
|---|---|---|---|
| Bare metal (3 nodes) | Scale (AMD EPYC 9124) | 3x: 16c/128GB/2x960GB NVMe | ~€900 (€300/node) |
| Managed PostgreSQL | Public Cloud DB | `db2-15` (4 vCPU, 15 GB, HA) | ~€280 |
| Object Storage | Object Storage | ~500 GB, moderate ops | ~€15 |
| Load Balancer | OVHcloud LB | 1 instance | ~€15 |
| Private Registry | Managed Registry | S plan | ~€15 |
| vRack | vRack | Included with dedicated servers | €0 |
| DNS | OVHcloud DNS | Included | €0 |
| Bandwidth | Included quota | 500 Mbps guaranteed | ~€0-50 |
| Vault license | Open source (BSL) | Self-hosted | €0 |
| Contrast license | Open source (AGPL) | Self-hosted | €0 |
| NATS | Open source | Self-hosted in cluster | €0 |
| **Total** | | | **~€1,225-1,275/mo** |

**Comparison with AWS plan**: €1,275 vs $1,915 (~€1,770). The EU deployment
is ~30% cheaper, primarily because bare metal is more cost-effective than
ECS + managed NATS + KMS API calls. The trade-off is more operational
overhead (self-managed K8s nodes, NATS, Vault).

---

## 9. Code Changes Required

### Changes to existing packages: Minimal

| Package | Change | Effort |
|---|---|---|
| `dwn-server` | Add `entrypoint-contrast.sh` — startup script that fetches secrets from Vault before exec'ing the DWN server | Small (new file, ~50 lines of shell) |
| `dwn-server` | Extend Helm chart `values.yaml` with Contrast-specific fields (`runtimeClassName`, init container, Vault config) | Small (values + template additions) |
| `dwn-server` | Ensure NATS EventLog plugin is loadable via `DWN_EVENT_LOG_PLUGIN_PATH` | Already supported — just config |
| None | `HdIdentityVault`, `LocalKeyManager`, `AgentDwnApi` — **no changes** | Zero |
| None | `DwnKeyStore` encryption — **no changes** (Layer 2 encryption works as-is inside the CVM) | Zero |

### New infrastructure code

| File | Description |
|---|---|
| `infra/eu-contrast/terraform/` | Terraform modules for OVHcloud resources |
| `infra/eu-contrast/k8s/` | Kubernetes manifests (DWN, NATS, Vault, Coordinator, Ingress) |
| `infra/eu-contrast/scripts/` | Node setup scripts (BIOS, kernel, K3s, Contrast install) |
| `.github/workflows/deploy-eu.yml` | CI/CD workflow for EU deployment |

### Already-implemented components (no work needed)

These are already built, tested, and CI-validated:

| Component | Location | Status |
|---|---|---|
| `NatsEventLog` plugin | `packages/dwn-server/src/plugins/event-log-nats.ts` | 454 lines, 20+ tests, production-ready |
| `DataStoreS3` (blob offload) | `packages/dwn-sql-store/src/data-store-s3.ts` | 338 lines, tested against MinIO in CI |
| Shared PG pool | `packages/dwn-server/src/storage.ts` (lines 57-97) | Caches `PostgresDialect` per URL |
| Provider auth (JWT) | `packages/dwn-server/src/registration/jwt-provider-auth-plugin.ts` | HMAC + JWKS support |
| Admin API | `packages/dwn-server/src/admin/` | Bearer token, metrics, activity log, audit |
| Prometheus metrics | `packages/dwn-server/` | `prom-client` integration |

### Future shared work with AWS plan

| Task | Package | When Needed |
|---|---|---|
| Read/write split (`ReadReplicaAwareDialect`) | `dwn-sql-store` | When read load exceeds single PG |
| Wire `DataStoreS3` into `storage.ts` config | `dwn-server` | When blob volume warrants offload |
| Table partitioning / RLS | `dwn-sql-store` | >100K tenants |

---

## 10. Security Considerations

| Concern | Mitigation |
|---|---|
| Key material in process memory | SEV-SNP hardware memory encryption; entire CVM isolated from host |
| Host OS / hypervisor compromise | Contrast runtime + SEV-SNP: host cannot read CVM memory even with root |
| Container image tampering | Contrast manifest enforces exact image SHA-256; attestation fails on mismatch |
| Cross-tenant data leak | Application-level `WHERE tenant = ?` + audit logging. (RLS as future enhancement.) |
| Secret exposure at rest | Vault stores secrets encrypted. Vault pod itself runs in a CVM. |
| Secret exposure in transit | mTLS between all pods (Contrast CA). TLS to PostgreSQL. |
| Data at rest (Postgres) | OVHcloud-managed AES-256 encryption |
| Data at rest (Object Storage) | SSE with OVHcloud-managed keys |
| DDoS | OVHcloud anti-DDoS (included on all products) + rate limiting in DWN server |
| Supply chain | OVHcloud Private Registry image scanning; `bun.lockb` integrity; SBOM generation |
| BIOS/firmware tampering | IPMI access restricted to provisioning team; firmware hash verified at setup |
| Attestation bypass | SEV-SNP attestation is hardware-rooted; cannot be spoofed without physical attack on the CPU |

### Threat Model Comparison

| Attack Vector | Fly.io (no TEE) | AWS Nitro | EU Contrast |
|---|---|---|---|
| Rogue cloud admin reads memory | Vulnerable | Protected (enclave only) | Protected (entire CVM) |
| Compromised host OS | Vulnerable | Protected (enclave only) | Protected (entire CVM) |
| Malicious co-tenant (VM escape) | Partially protected (Fly isolation) | Protected | Protected (SEV-SNP) |
| Container image supply chain | Manual review | EIF measurement (PCR) | Contrast manifest (image SHA) |
| Key material in process memory | Unprotected | Protected (enclave-only keys) | Protected (HW memory encryption) |
| Database compromise (Postgres) | Unprotected at rest | KMS-encrypted (Aurora) | OVHcloud-managed encryption |

---

## 11. Open Questions

1. **OVHcloud bare metal availability**: Confirm that Scale-range servers with
   AMD EPYC Genoa (9004 series) are available in the target datacenter (GRA
   or SBG). EPYC Milan (7003) is also supported by Contrast but Genoa is
   preferred for latest SEV-SNP features.

2. **Contrast licensing**: Contrast is AGPL-licensed. Verify that self-hosting
   for a commercial DWN service provider is acceptable under AGPL terms.
   Edgeless Systems also offers commercial licenses.

3. **Vault auto-unseal in CVM**: Vault needs to unseal on restart. With AWS
   you'd use KMS auto-unseal. In the Contrast model, Vault recovery keys can
   be managed via the Contrast Coordinator's secret recovery mechanism.
   Validate this flow works for unattended restarts.

4. **NATS inside Contrast CVMs**: NATS performance inside confidential
   micro-VMs should be benchmarked. SEV-SNP adds a small overhead to memory
   operations. For NATS JetStream with R=3 replication, this may be
   negligible but should be verified.

5. **Postgres connection from CVM**: Verify that the OVHcloud Managed
   PostgreSQL private endpoint is reachable from within Contrast CVMs via
   vRack. The Kata Containers networking model may need specific CNI
   configuration.

6. **S3 DataStore wiring**: `DataStoreS3` is implemented and tested but not
   wired into `storage.ts` config parsing (it only recognizes `level://`,
   `sqlite://`, `mysql://`, `postgres://` URL schemes). Adding an `s3://`
   scheme to `storage.ts` or using the plugin-path mechanism is a small task
   but not needed for initial launch.

7. **EAT token integration**: The existing `Eat` implementation in
   `@enbox/crypto` (`packages/crypto/src/cose/eat.ts`) handles COSE/CWT-based
   attestation tokens. SEV-SNP attestation reports are binary (not EAT
   format). Should we build an adapter that wraps SEV-SNP reports in EAT
   format for a unified attestation API, or rely entirely on Contrast's
   built-in verification? The Coordinator already handles this, so wrapping
   may be unnecessary complexity.

8. **Multi-region EU**: Initial deployment targets a single OVHcloud
   datacenter. For multi-region (e.g., GRA + SBG), the NATS cluster would
   need cross-DC replication and Postgres would need OVHcloud's multi-node
   configuration. Defer to Phase 5+.
