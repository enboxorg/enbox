# Confidential Computing Standards for Decentralized Web Nodes

## A Provider-Agnostic Specification for Protocol-Governed Confidential Compute

**Status:** Draft Proposal
**Date:** 2026-02-22
**Builds on:** [CONFIDENTIAL_COMPUTE_EXPLORATION.md](./CONFIDENTIAL_COMPUTE_EXPLORATION.md)

---

## 1. Goals and Non-Goals

### Goals

1. **Standardize** how DWN protocols declare confidential computing requirements so that any conforming service provider can fulfill them.
2. **Eliminate vendor lock-in** by abstracting TEE hardware specifics behind a common attestation and execution interface.
3. **Leverage existing standards** (IETF RATS, COSE, EAT, WASI) rather than inventing new primitives.
4. **Preserve the existing security model** — JWE record encryption remains the hard boundary; confidential computing adds defense-in-depth for data *in use*.
5. **Enable market competition** — multiple providers can offer confidential DWN hosting and compute services, competing on price, performance, and geography while conforming to the same protocol-level requirements.

### Non-Goals

- Mandating a specific TEE vendor or hardware platform.
- Replacing the existing DWN encryption model.
- Defining a token economy or payment protocol for compute resources (though standardized metering enables any payment layer — see Section 10).
- Specifying the internal implementation of TEE enclaves (that's the provider's domain).

---

## 2. Threat Model

### What We Protect Against

| Threat | Mitigation |
|---|---|
| **Curious operator** — node operator reads stored data | Already mitigated: JWE encryption with `encryptionRequired: true` |
| **Curious operator** — operator observes data during processing | Confidential compute: processing inside TEE; plaintext never leaves hardware boundary |
| **Curious operator** — operator reads message metadata (descriptors, protocol paths, timestamps) | Metadata protection: encrypted indexes inside TEE (Phase 3+) |
| **Compromised node** — attacker gains root on the host | TEE isolation: enclave memory is hardware-encrypted; attestation detects tampering |
| **Malicious compute code** — WASM module exfiltrates data | WASM sandboxing: capability-based imports; no network access; deterministic execution |
| **Supply chain attack** — modified DWN binary deployed | Reproducible builds: clients verify enclave measurement against published reference values |
| **Stale attestation** — valid attestation replayed after compromise | Attestation freshness: nonce-bound attestation with bounded validity windows |

### What We Do NOT Protect Against

| Threat | Reason |
|---|---|
| **Hardware-level side channels** (speculative execution, power analysis) | Mitigated by TEE vendors; outside this spec's scope |
| **TEE vendor compromise** (e.g., Intel key extraction) | Accepted residual risk; mitigated by multi-vendor support and defense-in-depth |
| **Availability attacks** (operator refuses to run computation) | Addressed by replication/redundancy, not by this spec |
| **Traffic analysis** (message timing, sizes) | Orthogonal concern; can be layered independently |

---

## 3. Standards Foundation

This specification builds on existing IETF and industry standards to maximize interoperability and avoid reinventing solved problems.

### 3.1 IETF RATS Architecture (RFC 9334)

The [IETF Remote ATtestation procedureS (RATS)](https://datatracker.ietf.org/doc/rfc9334/) architecture defines three roles:

```
┌──────────┐    Evidence    ┌──────────┐   Attestation   ┌──────────┐
│          │───────────────▶│          │    Results      │          │
│ Attester │                │ Verifier │───────────────▶│ Relying  │
│ (TEE)    │                │          │                │ Party    │
│          │                │          │                │ (Client) │
└──────────┘                └──────────┘                └──────────┘
                                 ▲
                                 │ Reference Values
                                 │ Endorsements
                            ┌────┴─────┐
                            │ Supply   │
                            │ Chain    │
                            │ (Vendor) │
                            └──────────┘
```

**Mapping to DWN:**

| RATS Role | DWN Entity | Function |
|---|---|---|
| **Attester** | DWN node running in a TEE | Produces evidence (attestation document) proving its identity and state |
| **Verifier** | Attestation verification service (can be client-side, third-party, or community-run) | Validates evidence against reference values, produces attestation results |
| **Relying Party** | Client / Agent SDK | Consumes attestation results to decide whether to trust the DWN node |
| **Supply Chain** | TEE vendor (Intel, AMD, AWS, ARM) + DWN software publisher | Provides reference values (expected measurements) and endorsements (vendor certificates) |

### 3.2 Entity Attestation Tokens (EAT)

[EAT (draft-ietf-rats-eat)](https://datatracker.ietf.org/doc/draft-ietf-rats-eat/) provides a standard token format for attestation results. Using EAT means any verifier that speaks EAT can validate DWN node attestations, regardless of the underlying TEE hardware.

An EAT token for a DWN node would include:

| EAT Claim | DWN Usage |
|---|---|
| `eat_nonce` | Client-provided nonce for freshness |
| `oemid` | TEE vendor identifier |
| `hwmodel` | Hardware platform (Nitro, TDX, SEV-SNP, etc.) |
| `swname` / `swversion` | DWN server software name and version |
| `manifests` | Software bill of materials / build manifest |
| `measres` (measurement results) | Enclave measurements (PCR values, launch digest, etc.) |
| `submods` | Sub-components (WASM runtime version, key service version) |

### 3.3 COSE (RFC 9052/9053)

All attestation documents and compute receipts use [CBOR Object Signing and Encryption (COSE)](https://www.rfc-editor.org/rfc/rfc9052) for serialization, signing, and optional encryption. COSE is already used by AWS Nitro attestation documents and is the recommended format for EAT.

### 3.4 WASI (WebAssembly System Interface)

Compute modules target [WASI](https://wasi.dev/) for portable, sandboxed execution. WASI provides:
- Capability-based security (no ambient authority)
- Platform-independent bytecode
- Deterministic execution (when using the WASI snapshot without randomness)
- A growing standard library for I/O, clocks, and random number generation

The DWN compute host extends WASI with DWN-specific host imports (record I/O, query, attestation).

---

## 4. Conformance Levels

To enable incremental adoption and market differentiation, this specification defines three conformance levels. A provider can advertise which level(s) it supports, and protocols can require a minimum level.

### Level 1: Attested Storage

The DWN node runs inside a TEE and can prove its integrity via remote attestation. Data is encrypted at rest and the operator cannot access plaintext.

**Requirements:**
- Node runs inside a TEE (any supported platform)
- Remote attestation endpoint available
- Attestation evidence conforms to EAT format
- JWE record encryption enforced for protocols with `encryptionRequired: true`
- Published reference values for enclave measurements
- Reproducible build artifacts available for independent verification

**What this buys:** Clients can verify that their data is stored on a node where the operator cannot read it, even during message processing (authorization checks, index updates, etc.).

### Level 2: Attested Compute

Everything in Level 1, plus the ability to execute WASM compute modules inside the TEE over encrypted records.

**Requirements:**
- All Level 1 requirements
- WASI-compatible WASM runtime inside the TEE
- DWN-specific host imports implemented (see Section 6)
- `ComputeInvoke` / `ComputeResult` message handlers
- Compute receipt generation per Section 7
- Protocol `$compute` directive support

**What this buys:** Protocols can define computations that run over encrypted data without exposing plaintext to the operator, with cryptographic proof of correct execution.

### Level 2N: Attested Native Compute

Everything in Level 1, plus the ability to execute **native compute runtimes** (e.g., LLM inference engines, GPU-accelerated workloads) inside chained TEE environments over encrypted records. This is a variant of Level 2 designed for workloads that cannot run as WASM modules — large model inference, GPU-accelerated computation, and agentic multi-step workflows.

**Requirements:**
- All Level 1 requirements
- Native compute runtime inside a TEE (CPU TEE, GPU TEE, or chained)
- DWN record I/O API exposed to the native runtime (see Section 6A)
- `NativeComputeInvoke` / `NativeComputeResult` message handlers
- Compute receipt generation per Section 7 (with native-compute extensions)
- Protocol `$compute` directive support with `engine: 'native'`
- GPU TEE attestation chaining when GPU TEEs are used (see Section 5.6)
- Session-scoped execution with bounded record access

**What this buys:** Protocols can declare AI inference, GPU-accelerated analysis, and multi-step agentic workflows that run over encrypted data without exposing plaintext to the operator, with cryptographic proof of execution environment and resource consumption.

**Relationship to Level 2:** A provider can support Level 2 (WASM), Level 2N (native), or both. Protocol definitions specify which engine they require. Level 2N trades WASM's deterministic reproducibility for the ability to run workloads that WASM cannot support (GPU compute, large models, non-deterministic inference).

### Level 3: Attested Multi-Party Compute

Everything in Level 2 or 2N, plus support for computation over records from multiple tenants with cross-tenant key delivery.

**Requirements:**
- All Level 2 or Level 2N requirements
- Cross-tenant input aggregation inside TEE
- Multi-party key delivery protocol extensions
- Compute receipts that reference inputs from multiple tenants
- Consent verification (each tenant must have authorized the cross-tenant computation via their protocol rules)

**What this buys:** Privacy-preserving analytics, credential derivation, and collaborative computation across organizational boundaries.

---

## 5. Attestation Protocol

### 5.1 Attestation Discovery

A DWN node advertises its confidential computing capabilities through its DID document service endpoint:

```json
{
  "id": "did:dht:abc123#dwn",
  "type": "DecentralizedWebNode",
  "serviceEndpoint": {
    "nodes": ["https://dwn.example.com"],
    "confidentialCompute": {
      "conformanceLevel": 2,
      "attestation": {
        "format": "eat",
        "endpoint": "/.well-known/dwn-attestation",
        "teePlatforms": ["aws-nitro", "intel-tdx"],
        "refreshInterval": 3600
      },
      "compute": {
        "maxModuleSize": 10485760,
        "supportedWasiVersions": ["preview1", "preview2"],
        "maxExecutionTime": 30000,
        "maxMemory": 268435456
      }
    }
  }
}
```

### 5.2 Attestation Handshake

Before sending sensitive data, a client performs an attestation handshake:

```
Client                           DWN Node (TEE)
  │                                   │
  │  1. GET /.well-known/dwn-attestation
  │      ?nonce=<random>              │
  │──────────────────────────────────▶│
  │                                   │
  │  2. AttestationResponse {         │
  │       evidence: <EAT token>,      │
  │       nonce: <echoed>,            │
  │       certificate_chain: [...],   │
  │     }                             │
  │◀──────────────────────────────────│
  │                                   │
  │  3. Verify:                       │
  │     a. Nonce matches              │
  │     b. Certificate chain valid    │
  │     c. EAT claims match policy   │
  │     d. Measurements match refs   │
  │                                   │
  │  4. Proceed with DWN messages     │
  │──────────────────────────────────▶│
  │                                   │
```

### 5.3 Attestation Evidence Format

Attestation evidence is an EAT token (COSE_Sign1) containing:

```cddl
DwnAttestationEvidence = {
  ; Standard EAT claims
  eat_nonce       : bstr,              ; client-provided nonce
  iat             : int,               ; issued-at timestamp
  oemid           : bstr,              ; TEE vendor OEM ID
  hwmodel         : tstr,              ; e.g., "aws-nitro-enclave", "intel-tdx"

  ; DWN-specific claims
  "dwn-version"   : tstr,             ; DWN server version
  "dwn-build"     : tstr,             ; reproducible build hash
  "conformance"   : uint,             ; conformance level (1, 2, or 3)

  ; Enclave measurements (platform-specific but standardized claim)
  measres         : {                  ; measurement results
    * tstr => bstr                     ; named measurement => hash value
  },

  ; Component attestations (for Level 2+)
  ? submods       : {
    ? "wasm-runtime"  : tstr,          ; WASM runtime version
    ? "key-service"   : tstr,          ; key service version
    ? "loaded-modules": [* bstr],      ; hashes of loaded WASM compute modules
  },
}
```

### 5.4 Verification Reference Values

To verify attestation without depending on a single authority, reference values are published through multiple channels:

1. **DWN Software Repository** — the canonical source publishes expected measurements for each release:
   ```json
   {
     "version": "1.5.0",
     "measurements": {
       "aws-nitro": { "PCR0": "sha384:...", "PCR1": "sha384:...", "PCR2": "sha384:..." },
       "intel-tdx": { "MRTD": "sha384:...", "RTMR0": "sha384:..." },
       "amd-sev-snp": { "launch_digest": "sha384:..." }
     },
     "build_manifest": "https://builds.example.com/dwn-server/1.5.0/manifest.json",
     "signatures": ["did:dht:publisher#sig"]
   }
   ```

2. **Community Verifiers** — independent parties reproduce the build and publish their own measurements, creating a web of trust.

3. **DID-Linked Resources** — reference values can be published as DID-linked resources, enabling DID-based discovery and verification without a centralized registry.

### 5.5 Platform Abstraction Layer

The key to avoiding vendor lock-in is abstracting TEE-specific attestation behind a common interface. Each TEE platform implements an **Attestation Adapter**:

```
┌───────────────────────────────────────────────┐
│  Common Attestation Interface                  │
│                                                │
│  getEvidence(nonce) -> EAT                    │
│  verifyEvidence(eat, refs) -> AttestationResult│
│  getMeasurements() -> MeasurementMap           │
│  sealData(data) -> SealedBlob                 │
│  unsealData(blob) -> data                     │
└───────────┬──────────┬───────────┬────────────┘
            │          │           │
     ┌──────▼───┐ ┌────▼────┐ ┌───▼──────┐
     │ AWS      │ │ Intel   │ │ AMD      │
     │ Nitro    │ │ TDX     │ │ SEV-SNP  │
     │ Adapter  │ │ Adapter │ │ Adapter  │
     └──────────┘ └─────────┘ └──────────┘
```

Each adapter translates between platform-specific attestation primitives and the common EAT-based format:

| Common Operation | AWS Nitro | Intel TDX | AMD SEV-SNP |
|---|---|---|---|
| `getEvidence()` | NSM API → CBOR attestation doc | `TDG.MR.REPORT` → TDX quote | `SNP_GET_REPORT` → SNP attestation report |
| Measurements | PCR0-15 | MRTD, RTMR0-3 | LAUNCH_DIGEST, HOST_DATA |
| Certificate chain | Nitro root CA → enclave cert | Intel SGX provisioning cert → quote signing | AMD ARK → ASK → VCEK |
| Sealed storage | KMS-backed sealing | SGX sealing (MRSIGNER) | VMPL-based sealing |

**A provider** implements the adapter for their TEE platform. **A client** only needs to understand the common EAT format and the reference values for the DWN software version it expects.

### 5.6 GPU TEE Platforms and Enclave Chaining

Level 2N workloads (native compute, LLM inference) often require GPU acceleration. Modern GPU TEEs extend confidential computing to accelerated workloads:

| GPU TEE Platform | Hardware | Attestation Mechanism | Memory Protection |
|---|---|---|---|
| **NVIDIA Confidential Computing** | H100, H200, Blackwell (GB200) | GPU attestation report via NVIDIA RA service; chains to CPU TEE attestation | GPU memory encrypted via on-die AES engine; CPU↔GPU link encrypted in transit |
| **AMD SEV-SNP + MI300X** | MI300X | SEV-SNP attestation extended to GPU memory | Unified HBM encrypted under SEV-SNP |

#### Enclave Chaining

When a native compute workload requires GPU acceleration, the CPU TEE and GPU TEE form a **chain of trust**. The attestation evidence must cover both links:

```
┌─────────────────────────────────────────────────────────────────────┐
│ CPU TEE (AWS Nitro / Intel TDX / AMD SEV-SNP)                      │
│                                                                     │
│  1. Receive encrypted DWN records                                   │
│  2. Decrypt records using tenant's #enc key (via TEE Key Service)   │
│  3. Re-encrypt data for GPU TEE transit                             │
│  4. Transfer to GPU TEE over encrypted channel                      │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ GPU TEE (NVIDIA CC / AMD SEV-SNP GPU)                         │  │
│  │                                                               │  │
│  │  5. Decrypt data in GPU memory                                │  │
│  │  6. Execute native compute (LLM inference, GPU kernels)       │  │
│  │  7. Encrypt results                                           │  │
│  │  8. Return encrypted results to CPU TEE                       │  │
│  │                                                               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  9. Generate chained attestation (CPU evidence + GPU evidence)      │
│ 10. Encrypt results for tenant / recipient                          │
│ 11. Write results back to DWN as records                            │
│ 12. Generate compute receipt with chained attestation                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Chained Attestation Evidence

A chained attestation extends the EAT format (Section 5.3) with GPU sub-module evidence:

```cddl
DwnChainedAttestationEvidence = DwnAttestationEvidence & {
  ; GPU TEE attestation (present when GPU TEE is used)
  ? "gpu-attestation" : {
    "platform"     : tstr,          ; e.g., "nvidia-cc-h100", "amd-sev-gpu-mi300x"
    "evidence"     : bstr,          ; GPU attestation report (platform-specific)
    "driver-version": tstr,         ; GPU driver version
    "model-hash"   : ? bstr,        ; SHA-256 of loaded model weights (if applicable)
  },
}
```

#### GPU TEE Attestation Adapters

The platform abstraction layer (Section 5.5) is extended with GPU-aware adapters:

```
┌──────────────────────────────────────────────────────────────┐
│  Common Attestation Interface                                 │
│                                                               │
│  getEvidence(nonce) -> EAT (with optional gpu-attestation)   │
│  verifyEvidence(eat, refs) -> AttestationResult               │
│  getMeasurements() -> MeasurementMap                          │
│  sealData(data) -> SealedBlob                                │
│  unsealData(blob) -> data                                    │
│                                                               │
│  // Level 2N extensions                                       │
│  getGpuEvidence(nonce) -> GpuAttestationReport               │
│  verifyChainedEvidence(eat, refs) -> ChainedAttestationResult│
│  negotiateGpuChannel() -> EncryptedChannel                   │
└─────┬──────────┬───────────┬────────────┬────────────────────┘
      │          │           │            │
┌─────▼───┐ ┌────▼────┐ ┌───▼──────┐ ┌───▼───────────────┐
│ AWS     │ │ Intel   │ │ AMD      │ │ NVIDIA CC         │
│ Nitro   │ │ TDX     │ │ SEV-SNP  │ │ Adapter           │
│ Adapter │ │ Adapter │ │ Adapter  │ │ (H100/Blackwell)  │
└─────────┘ └─────────┘ └──────────┘ └───────────────────┘
```

| Common Operation | NVIDIA CC (H100/Blackwell) | AMD SEV-SNP GPU (MI300X) |
|---|---|---|
| `getGpuEvidence()` | NVIDIA RA service → GPU attestation report | `SNP_GET_REPORT` extended to GPU HBM |
| GPU measurements | GPU firmware hash, driver version, VBIOS | GPU firmware in `LAUNCH_DIGEST` extension |
| Model integrity | SHA-256 of loaded weights in GPU memory | SHA-256 of loaded weights |
| CPU↔GPU channel | NVIDIA CC encrypted channel (AES-256) | SEV-SNP shared encryption key |
| Certificate chain | NVIDIA GPU Attestation CA → device cert | AMD ARK → ASK → GPU VCEK |

**Chained verification**: A client verifying a Level 2N compute receipt checks both the CPU TEE attestation AND the GPU TEE attestation. Both must be valid, fresh, and match published reference values. The chain proves: "this CPU enclave, running this code, delegated computation to this GPU enclave, running this model."

---

## 6. Compute Module Interface (CMI)

### 6.1 WASI Extension: `dwn:compute/v1`

Compute modules are WASM components that import a standardized set of host functions. These imports define the **Compute Module Interface** — the contract between the WASM module and the TEE compute worker.

```wit
// WIT (WASM Interface Types) definition for DWN compute host
package dwn:compute@1.0.0;

interface record-io {
    // Read a decrypted record's data by record ID.
    // The record must be listed in the compute definition's `inputs`.
    // Returns the record data as bytes, or an error if not found/unauthorized.
    read-record: func(record-id: string) -> result<list<u8>, compute-error>;

    // Query records matching a filter within allowed input paths.
    // Returns a list of record IDs matching the filter.
    query-records: func(filter: record-filter) -> result<list<string>, compute-error>;

    // Buffer an output record to be written after execution completes.
    // The output path must match the compute definition's `outputPath`.
    write-result: func(data: list<u8>, metadata: result-metadata) -> result<string, compute-error>;

    // Read a record's descriptor (metadata) without reading data.
    read-descriptor: func(record-id: string) -> result<record-descriptor, compute-error>;
}

interface attestation {
    // Get the current TEE attestation evidence for inclusion in results.
    get-evidence: func(nonce: list<u8>) -> result<list<u8>, compute-error>;
}

// Error types for compute operations
enum compute-error {
    not-found,
    unauthorized,
    invalid-input,
    output-limit-exceeded,
    execution-timeout,
    internal-error,
}

// Filter for querying records
record record-filter {
    protocol-path: option<string>,
    schema: option<string>,
    data-format: option<string>,
    date-sort: option<sort-direction>,
    tags: option<list<tag-filter>>,
}

enum sort-direction { ascending, descending }

record tag-filter {
    tag: string,
    value: string,
}

// Metadata attached to output records
record result-metadata {
    schema: option<string>,
    data-format: string,
    tags: option<list<tag-entry>>,
}

record tag-entry {
    tag: string,
    value: string,
}

// Descriptor information for a record
record record-descriptor {
    record-id: string,
    date-created: string,
    date-modified: string,
    protocol-path: string,
    schema: option<string>,
    data-format: string,
    data-size: u64,
    author: string,
}

world compute-module {
    import record-io;
    import attestation;

    // The module's entry point. Called by the compute worker.
    // `params` is a JSON-encoded parameter object from the ComputeInvoke message.
    export run: func(params: string) -> result<string, compute-error>;
}
```

### 6.2 Security Constraints on Compute Modules

WASM modules executing inside the compute worker operate under strict constraints:

| Constraint | Rationale |
|---|---|
| **No network access** | Prevents data exfiltration; all I/O is through `record-io` imports |
| **No filesystem access** | Enclave has no persistent state; everything goes through DWN records |
| **No ambient clock** | Deterministic execution; timestamps provided by the host if needed |
| **Bounded execution time** | Prevents denial-of-service; `maxExecutionTime` from provider capabilities |
| **Bounded memory** | Prevents resource exhaustion; `maxMemory` from provider capabilities |
| **Input scoping** | Module can only read records from paths listed in the `$compute.inputs` definition |
| **Output scoping** | Module can only write results to the `$compute.outputPath` |
| **No randomness by default** | Enables deterministic verification; opt-in via `$compute.deterministic: false` |

### 6.3 Module Addressing and Integrity

Compute modules are addressed by their content hash (SHA-256 over the WASM bytecode). This hash is:

1. **Declared in the protocol** — the `$compute.module` field references a record type whose instances contain WASM bytecode.
2. **Pinned in invocations** — a `ComputeInvoke` message specifies the exact `moduleRecordId` (which resolves to a specific WASM binary with a known hash).
3. **Verified by the worker** — the compute worker hashes the loaded module and includes it in the compute receipt.
4. **Auditable by clients** — anyone with read access to the module record can inspect the WASM bytecode.

This creates a chain: protocol definition → module record → module hash → compute receipt → output records. Any link can be independently verified.

---

## 6A. Native Compute Interface (NCI)

### 6A.1 Motivation

The WASM CMI (Section 6) targets lightweight, deterministic, sandboxed computations. However, important workloads cannot run as WASM modules:

- **LLM inference** — models with billions of parameters require GPU acceleration and native runtimes (vLLM, TensorRT-LLM, llama.cpp)
- **GPU-accelerated analytics** — signal processing, matrix operations, and scientific computing with CUDA/ROCm
- **Agentic workflows** — multi-step reasoning loops where an LLM reads records, reasons, reads more records, and writes results iteratively
- **Large model hosting** — model weights measured in gigabytes, far beyond WASM module size limits

The Native Compute Interface (NCI) defines a standardized contract between a DWN protocol engine and a native compute runtime running inside a TEE (CPU, GPU, or chained). It enables providers like [OpenSecret](https://opensecret.cloud) to offer confidential AI inference as a DWN compute service with minimal integration effort.

### 6A.2 Architecture: Enclave-Hosted Record I/O API

Instead of WASM host imports, native compute runtimes interact with DWN records through a **Record I/O API** exposed by the CPU TEE enclave. The API is available only inside the TEE boundary — it is not network-accessible.

```
┌──────────────────────────────────────────────────────────────────────┐
│ CPU TEE Boundary                                                     │
│                                                                      │
│  ┌──────────────────┐       ┌─────────────────────────────────────┐  │
│  │ Record I/O API   │       │ Native Compute Runtime              │  │
│  │ (local socket)   │◀─────▶│                                     │  │
│  │                  │       │  • LLM inference engine              │  │
│  │ • read-record    │       │  • GPU kernel dispatcher             │  │
│  │ • query-records  │       │  • Agentic orchestrator              │  │
│  │ • write-result   │       │                                     │  │
│  │ • read-descriptor│       │    ┌─────────────────────────────┐  │  │
│  │ • get-evidence   │       │    │ GPU TEE (when applicable)   │  │  │
│  │ • emit-token     │       │    │ • Model weights             │  │  │
│  │ • end-session    │       │    │ • Inference execution       │  │  │
│  │                  │       │    └─────────────────────────────┘  │  │
│  └──────────────────┘       └─────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

The Record I/O API provides the same logical operations as the WASM CMI host imports (Section 6.1), plus extensions for streaming and session management. The transport is a local Unix domain socket or vsock channel — never exposed outside the TEE.

### 6A.3 Record I/O API Specification

The NCI Record I/O API is defined as a simple JSON-over-socket protocol. This makes it trivially consumable from any language (Rust, Python, C++, Go) without requiring WASM bindings.

```typescript
// ── Record Operations (same semantics as WASM CMI) ─────────────

interface NativeRecordIO {
  /**
   * Read a decrypted record by ID. Must be listed in the session's
   * allowed inputs (from $compute.inputs).
   */
  readRecord(params: {
    recordId: string;
  }): Promise<{ data: Uint8Array; descriptor: RecordDescriptor }>;

  /**
   * Query records matching a filter within allowed input paths.
   */
  queryRecords(params: {
    filter: RecordFilter;
  }): Promise<{ recordIds: string[] }>;

  /**
   * Write a result record. Must match the session's allowed
   * output path (from $compute.outputPath).
   */
  writeResult(params: {
    data     : Uint8Array;
    metadata : ResultMetadata;
  }): Promise<{ recordId: string }>;

  /**
   * Read a record's descriptor (metadata) without reading data.
   */
  readDescriptor(params: {
    recordId: string;
  }): Promise<{ descriptor: RecordDescriptor }>;

  /**
   * Get TEE attestation evidence for inclusion in results.
   */
  getEvidence(params: {
    nonce: Uint8Array;
  }): Promise<{ evidence: Uint8Array }>;

  // ── NCI Extensions (not in WASM CMI) ──────────────────────────

  /**
   * Emit a streaming token. Used by LLM inference to stream
   * generated text token-by-token back to the client.
   * Tokens are buffered and encrypted in chunks for transit.
   */
  emitToken(params: {
    token    : string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Signal that the compute session is complete.
   * Triggers receipt generation and result finalization.
   */
  endSession(params: {
    status  : 'success' | 'error' | 'budget-exceeded';
    message?: string;
  }): Promise<{ receiptId: string }>;
}
```

### 6A.4 Session Model

Unlike the WASM CMI's single `run()` invocation, the NCI uses a **session model** that supports multi-step agentic workflows:

```
Client                   DWN Node              CPU TEE                Native Runtime
  │                         │                     │                        │
  │  NativeComputeInvoke    │                     │                        │
  │────────────────────────▶│                     │                        │
  │                         │  Create session     │                        │
  │                         │────────────────────▶│                        │
  │                         │                     │  Start runtime         │
  │                         │                     │───────────────────────▶│
  │                         │                     │                        │
  │                         │                     │   readRecord(id1)      │
  │                         │                     │◀───────────────────────│
  │                         │                     │   { data: ... }        │
  │                         │                     │───────────────────────▶│
  │                         │                     │                        │
  │                         │                     │   emitToken("The")     │
  │  ◀─── streaming ────── (encrypted token chunk)│◀───────────────────────│
  │                         │                     │   emitToken("answer")  │
  │  ◀─── streaming ────── (encrypted token chunk)│◀───────────────────────│
  │                         │                     │                        │
  │                         │                     │   queryRecords(filter) │
  │                         │                     │◀───────────────────────│
  │                         │                     │   { recordIds: [...] } │
  │                         │                     │───────────────────────▶│
  │                         │                     │                        │
  │                         │                     │   readRecord(id2)      │
  │                         │                     │◀───────────────────────│
  │                         │                     │   { data: ... }        │
  │                         │                     │───────────────────────▶│
  │                         │                     │                        │
  │                         │                     │   emitToken("is 42")   │
  │  ◀─── streaming ────── (encrypted token chunk)│◀───────────────────────│
  │                         │                     │                        │
  │                         │                     │   writeResult(data)    │
  │                         │                     │◀───────────────────────│
  │                         │                     │   { recordId: out1 }   │
  │                         │                     │───────────────────────▶│
  │                         │                     │                        │
  │                         │                     │   endSession(success)  │
  │                         │                     │◀───────────────────────│
  │                         │                     │   Generate receipt     │
  │                         │                     │───────────────────────▶│
  │                         │                     │                        │
  │  NativeComputeResult    │                     │                        │
  │◀────────────────────────│                     │                        │
```

**Key properties of the session model:**

1. **Multi-step record access**: The runtime can read records, reason, read more records — enabling agentic loops where an LLM decides what to read next based on previous results.

2. **Streaming output**: `emitToken()` enables real-time token streaming for LLM inference. Tokens are encrypted inside the TEE and delivered to the client over an encrypted channel.

3. **Bounded sessions**: Sessions have a maximum duration, maximum record reads, and maximum output tokens — all enforced by the TEE host (Section 6A.5).

4. **Session receipts**: A single receipt covers the entire session, aggregating all record reads, writes, and token emissions.

### 6A.5 Security Constraints on Native Compute

Native compute runtimes operate under constraints analogous to WASM modules but adapted for the native execution model:

| Constraint | WASM CMI | NCI (Native) | Rationale |
|---|---|---|---|
| **Network access** | None | None (TEE-enforced) | Prevents data exfiltration |
| **Filesystem access** | None | TEE-scoped tmpfs only | Model weights loaded at TEE init; no persistent state |
| **Record I/O** | WASM host imports | Local socket API | Same logical operations, different transport |
| **Input scoping** | `$compute.inputs` paths | `$compute.inputs` paths | Same authorization model |
| **Output scoping** | `$compute.outputPath` | `$compute.outputPath` | Same authorization model |
| **Execution time** | `maxExecutionTime` | `maxSessionDuration` | Sessions may run longer than single WASM calls |
| **Memory** | `maxMemory` (WASM linear) | TEE memory allocation | Includes GPU memory for GPU TEE workloads |
| **Determinism** | Opt-in (default: true) | Default: false | LLM inference is inherently non-deterministic |
| **Instruction counting** | WASM fuel | N/A | Not applicable to native code; use token counting instead |
| **Token output** | N/A | `maxOutputTokens` | Bounds generation length for LLM workloads |
| **Record read limit** | `maxInputRecords` | `maxSessionReads` | Bounds agentic record exploration |

### 6A.6 Module Addressing for Native Compute

WASM modules are addressed by content hash of their bytecode. Native compute modules have a more complex identity:

```typescript
type NativeComputeModuleIdentity = {
  /**
   * Hash of the container image or runtime binary.
   * For OpenSecret-style deployments: hash of the NixOS-built
   * enclave image that contains the inference engine.
   */
  runtimeHash: string;

  /**
   * Hash of the model weights (for inference workloads).
   * SHA-256 over the serialized model file(s).
   * Verified inside the GPU TEE after loading.
   */
  modelHash?: string;

  /**
   * Inference engine identifier and version.
   * e.g., "vllm:0.4.1", "trt-llm:0.9.0", "llama-cpp:b2534"
   */
  engine: string;

  /**
   * Model identifier (human-readable).
   * e.g., "meta-llama/Llama-3.3-70B-Instruct"
   */
  modelId?: string;

  /**
   * Quantization format (if applicable).
   * e.g., "fp16", "int8", "int4-awq", "fp8"
   */
  quantization?: string;
};
```

The `runtimeHash` and `modelHash` are both included in the compute receipt and verified against published reference values. This creates the same integrity chain as WASM: protocol definition → module identity → attestation → receipt → outputs.

For providers like OpenSecret that use **reproducible NixOS builds**, the `runtimeHash` maps directly to the PCR0 measurement of the enclave image. A client verifying a receipt can:

1. Check that the `runtimeHash` matches the PCR0 in the CPU TEE attestation
2. Check that the `modelHash` matches the model hash in the GPU TEE attestation
3. Verify both attestation reports against vendor certificate chains
4. Confirm the model is a known, audited model (via `modelId` + `modelHash` cross-reference)

### 6A.7 Provider Integration Pattern (OpenSecret Example)

The NCI is designed so that existing confidential AI platforms can become DWN compute providers with minimal integration work. Here is the integration surface for an OpenSecret-style provider:

```
┌─────────────────────────────────────────────────────────────────┐
│ OpenSecret-style Provider                                       │
│                                                                 │
│  Already has:                      Needs to add:                │
│  ┌─────────────────────────┐      ┌─────────────────────────┐  │
│  │ ✓ AWS Nitro Enclave     │      │ + DWN Record I/O shim   │  │
│  │ ✓ GPU TEE (NVIDIA CC)   │      │   (NCI socket API)      │  │
│  │ ✓ Enclave chaining      │      │                         │  │
│  │ ✓ Model hosting         │      │ + EAT token generation  │  │
│  │ ✓ Reproducible builds   │      │   (wrap Nitro attestation│  │
│  │ ✓ Remote attestation    │      │    in EAT format)       │  │
│  │ ✓ Encrypted storage     │      │                         │  │
│  │ ✓ Key management        │      │ + DWN message handler   │  │
│  └─────────────────────────┘      │   (NativeComputeInvoke  │  │
│                                    │    → session lifecycle)  │  │
│                                    │                         │  │
│                                    │ + Receipt generation    │  │
│                                    │   (COSE_Sign1 wrapper)  │  │
│                                    │                         │  │
│                                    │ + DID document with     │  │
│                                    │   ConfidentialDwnService│  │
│                                    └─────────────────────────┘  │
│                                                                 │
│  Integration effort: ~4 components (shim, EAT wrapper,         │
│  message handler, receipt generator)                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**What the provider already has** (and does not need to change):

- TEE infrastructure (Nitro enclaves, GPU TEE chaining)
- Model hosting and inference engine
- Reproducible builds and attestation
- Key management inside enclaves
- Encrypted data storage and transit

**What the provider adds** (the NCI integration surface):

1. **Record I/O shim** (~200 lines): A thin adapter that implements the NCI socket API (Section 6A.3) by mapping `readRecord`/`writeResult` calls to the provider's internal encrypted storage, with JWE decrypt/encrypt using the tenant's `#enc` key.

2. **EAT wrapper** (~100 lines): Wraps the provider's existing attestation documents (e.g., Nitro CBOR attestation) in the standardized EAT format (Section 5.3), adding DWN-specific claims.

3. **DWN message handler** (~300 lines): Receives `NativeComputeInvoke` messages, creates a compute session, wires up the Record I/O shim, and returns `NativeComputeResult` when done.

4. **Receipt generator** (~150 lines): Generates COSE_Sign1 compute receipts (Section 7) capturing the session's inputs, outputs, attestation, and usage.

5. **DID document publication**: Publish a DID with a `ConfidentialDwnService` endpoint advertising Level 2N capabilities.

The provider's existing inference pipeline, TEE infrastructure, and security model remain unchanged. The NCI is a **thin protocol adapter**, not a rewrite.

---

## 7. Compute Receipt Standard

### 7.1 Receipt Format

Every compute execution produces a **Compute Receipt** — a COSE_Sign1 structure that cryptographically binds inputs, code, environment, and outputs.

```cddl
ComputeReceipt = COSE_Sign1<{
  ; What engine was used
  "engine"          : tstr,           ; "wasm" or "native"

  ; What ran (WASM engine)
  ? "module-hash"   : bstr,           ; SHA-256 of the WASM bytecode
  ? "module-record" : tstr,           ; DWN record ID of the module

  ; What ran (native engine — present when engine == "native")
  ? "runtime-hash"  : bstr,           ; SHA-256 of enclave image / container
  ? "model-hash"    : bstr,           ; SHA-256 of model weights
  ? "model-id"      : tstr,           ; human-readable model identifier
  ? "engine-version": tstr,           ; inference engine version

  ; What it consumed
  "inputs"          : [* InputRef],   ; references to input records

  ; What it produced
  "outputs"         : [* OutputRef],  ; references to output records

  ; Where it ran
  "attestation"     : bstr,           ; EAT token from the TEE
  "worker-did"      : tstr,           ; DID of the compute worker
  "provider-did"    : tstr,           ; DID of the service provider

  ; When it ran
  "invoked-at"      : tstr,           ; ISO 8601 timestamp
  "completed-at"    : tstr,           ; ISO 8601 timestamp

  ; Who authorized it
  "tenant-did"      : tstr,           ; DID of the authorizing tenant
  "invoke-msg-cid"  : tstr,           ; CID of the ComputeInvoke message

  ; Protocol context
  "protocol"        : tstr,           ; protocol URI
  "protocol-path"   : tstr,           ; protocol path of the compute definition

  ; Resource usage (see Section 10)
  "usage"           : UsageReport,    ; TEE-attested resource consumption
}>

InputRef = {
  "record-id" : tstr,                 ; DWN record ID
  "record-cid": tstr,                 ; CID of the record at time of read
  "data-hash" : bstr,                 ; SHA-256 of the decrypted data
}

OutputRef = {
  "record-id" : tstr,                 ; DWN record ID of the written result
  "record-cid": tstr,                 ; CID of the written record
  "data-hash" : bstr,                 ; SHA-256 of the output data (pre-encryption)
}

UsageReport = {
  ; ── Common fields (all engines) ────────────────────────────

  ; Wall-clock execution time in milliseconds (measured inside TEE)
  "execution-ms"   : uint,

  ; Number of host import / API calls by type
  "io-calls"       : {
    "read-record"     : uint,
    "query-records"   : uint,
    "write-result"    : uint,
    "read-descriptor" : uint,
    ? "emit-token"    : uint,         ; NCI only: streaming token emissions
  },

  ; Total bytes processed
  "input-bytes"    : uint,            ; sum of decrypted input record data
  "output-bytes"   : uint,            ; sum of output record data (pre-encryption)

  ; ── WASM engine fields (Level 2) ──────────────────────────

  ; WASM instruction counter (deterministic, reproducible)
  ? "instructions"  : uint,

  ; Peak WASM linear memory in bytes
  ? "peak-memory"   : uint,

  ; ── Native engine fields (Level 2N) ───────────────────────

  ; LLM token counts (present for inference workloads)
  ? "input-tokens"  : uint,           ; tokens in prompt / context
  ? "output-tokens" : uint,           ; tokens generated

  ; Model identity (present for inference workloads)
  ? "model-id"      : tstr,           ; e.g., "meta-llama/Llama-3.3-70B-Instruct"

  ; GPU time in milliseconds (present when GPU TEE is used)
  ? "gpu-ms"        : uint,

  ; Peak GPU memory in bytes
  ? "peak-gpu-memory" : uint,

  ; Number of agentic steps (present for multi-step sessions)
  ? "session-steps"  : uint,          ; number of read→reason→act cycles
}
```

### 7.2 Receipt Verification

A client or verifier can validate a compute receipt by checking:

1. **Signature validity** — the COSE_Sign1 signature verifies against the worker DID's verification method.
2. **Attestation validity** — the embedded EAT token verifies against TEE vendor certificate chain and reference values.
3. **Nonce binding** — the EAT `eat_nonce` matches a hash of the `ComputeInvoke` message CID (binding attestation to this specific invocation).
4. **Module integrity** — the `module-hash` matches the expected hash from the protocol definition or the module record.
5. **Input integrity** — each `InputRef.record-cid` matches the actual record CID in the DWN (proving the correct records were read).
6. **Output integrity** — each `OutputRef.record-cid` matches the actual result record CID.
7. **Temporal validity** — `invoked-at` is within an acceptable window.

### 7.3 Receipt Storage

Compute receipts are stored as DWN records under the same protocol, typically at a `computeReceipt` protocol path. This means:

- Receipts are subject to the same authorization rules as other protocol records.
- Receipts are replicated via DWN sync (the receipt follows the data).
- Receipts can be queried, filtered, and audited using standard `RecordsQuery` messages.
- Receipts form a verifiable audit trail: for any compute output, you can trace back through the receipt to the exact inputs, code, and environment.

---

## 8. Protocol Extensions

### 8.1 `$compute` Directive

The `$compute` directive is added to `ProtocolRuleSet` to declare compute rules:

```typescript
type ProtocolComputeRule = {
  /**
   * Compute engine type.
   * - 'wasm': WASM module executed via CMI (Section 6). Default.
   * - 'native': Native runtime executed via NCI (Section 6A).
   *   Use for GPU-accelerated workloads, LLM inference, and
   *   agentic workflows that cannot run as WASM.
   */
  engine?: 'wasm' | 'native';

  /**
   * Protocol path of the record type containing the compute module.
   *
   * For engine 'wasm': WASM bytecode stored as record data.
   * For engine 'native': A JSON record describing the native module
   *   identity (runtimeHash, modelHash, engine, modelId).
   *   See NativeComputeModuleIdentity in Section 6A.6.
   */
  module: string;

  /**
   * Protocol paths that the compute module can read as input.
   * The module's record-io.read-record and query-records calls
   * are scoped to these paths.
   */
  inputs: string[];

  /**
   * Protocol path where output records are written.
   * Must match the path where this $compute directive is defined
   * (or a child path).
   */
  outputPath: string;

  /**
   * Whether execution must be deterministic (no randomness, no timestamps).
   * When true, the result can be verified by re-execution.
   *
   * Default for 'wasm': true.
   * Default for 'native': false (LLM inference is inherently non-deterministic).
   */
  deterministic?: boolean;

  /**
   * Whether the compute output is streamed token-by-token.
   * Only applicable for engine: 'native'.
   * When true, the provider streams encrypted tokens to the client
   * via emitToken() during execution. Default: false.
   */
  streaming?: boolean;

  /**
   * Minimum attestation requirements for the compute environment.
   * Provider-agnostic — specifies WHAT is required, not HOW.
   */
  attestation: ComputeAttestationRequirement;

  /**
   * Native compute-specific constraints (only when engine: 'native').
   */
  nativeConstraints?: NativeComputeConstraints;
};

type NativeComputeConstraints = {
  /** Maximum session duration in milliseconds. Default: 120000 (2 min). */
  maxSessionDuration?: number;

  /** Maximum number of record reads per session. Default: 1000. */
  maxSessionReads?: number;

  /** Maximum output tokens for inference workloads. Default: 4096. */
  maxOutputTokens?: number;

  /** Required model characteristics. */
  model?: {
    /** Specific model ID required (e.g., "meta-llama/Llama-3.3-70B-Instruct"). */
    modelId?: string;
    /** Minimum model parameter count (e.g., 70_000_000_000 for 70B). */
    minParameters?: number;
    /** Required model hash for pinning a specific model version. */
    modelHash?: string;
  };

  /** Whether GPU TEE is required (vs. CPU-only native compute). Default: false. */
  requireGpuTee?: boolean;
};

type ComputeAttestationRequirement = {
  /**
   * Minimum conformance level required (1, 2, or 3).
   */
  conformanceLevel: 1 | 2 | 3;

  /**
   * Whether the compute environment must have a reproducible build.
   * When true, clients can independently verify the enclave measurement
   * by reproducing the build from source.
   */
  reproducibleBuild?: boolean;

  /**
   * Optional: specific TEE platforms accepted.
   * If omitted, any TEE platform is acceptable (provider-agnostic).
   * Including this reduces portability but may be required for
   * compliance or risk management.
   */
  acceptedPlatforms?: string[];

  /**
   * Optional: minimum DWN server version.
   * Ensures the compute environment includes specific security
   * patches or features.
   */
  minVersion?: string;

  /**
   * Optional: DIDs of trusted reference value publishers.
   * If specified, enclave measurements must match values published
   * by at least one of these DIDs.
   */
  trustedPublishers?: string[];
};
```

### 8.2 `$attestation` Directive

A new directive on `$actions` to require attestation for specific operations — independent of compute:

```typescript
type AttestationRequiredAction = {
  who: string;
  of?: string;
  role?: string;
  can: string[];

  /**
   * When present, the DWN node processing this action must present
   * valid attestation evidence meeting these requirements.
   *
   * This allows protocol authors to require that sensitive records
   * are only stored on attested nodes — even without compute.
   */
  requireAttestation?: {
    conformanceLevel: 1 | 2 | 3;
    reproducibleBuild?: boolean;
    acceptedPlatforms?: string[];
  };
};
```

### 8.3 New DWN Interface: `Compute`

```typescript
// ── ComputeInvoke ──────────────────────────────────────────────
// Requests execution of a WASM compute module over specified inputs.

type ComputeInvokeDescriptor = {
  interface      : 'Compute';
  method         : 'Invoke';
  messageTimestamp: string;
  protocol       : string;
  protocolPath   : string;
  moduleRecordId : string;
  inputFilter    : RecordsFilter;
  params?        : Record<string, unknown>;

  /** Optional resource budget. Execution aborts if any limit is exceeded. */
  budget?: {
    /** Maximum WASM instructions (fuel). Execution traps when exhausted. */
    maxInstructions?  : number;
    /** Maximum WASM linear memory in bytes. */
    maxMemory?        : number;
    /** Maximum wall-clock execution time in milliseconds. */
    maxExecutionMs?   : number;
    /** Maximum number of input records the module may read. */
    maxInputRecords?  : number;
  };
};

type ComputeInvokeMessage = {
  descriptor     : ComputeInvokeDescriptor;
  authorization  : Authorization;
};

// ── ComputeResult ──────────────────────────────────────────────
// Returned after compute execution completes.

type ComputeResultDescriptor = {
  interface       : 'Compute';
  method          : 'Result';
  messageTimestamp: string;
  invokeMessageCid: string;
  outputRecordIds : string[];
  receiptRecordId : string;
};

type ComputeResultMessage = {
  descriptor     : ComputeResultDescriptor;
  authorization  : Authorization;
};

// ── ComputeQuery ───────────────────────────────────────────────
// Query compute receipts for audit and verification.

type ComputeQueryDescriptor = {
  interface : 'Compute';
  method    : 'Query';
  messageTimestamp: string;
  filter    : ComputeReceiptFilter;
};

type ComputeReceiptFilter = {
  protocol?      : string;
  protocolPath?  : string;
  moduleHash?    : string;
  tenantDid?     : string;
  dateRange?     : { from?: string; to?: string };
  workerDid?     : string;
  providerDid?   : string;
};
```

### 8.4 Native Compute Messages (Level 2N)

```typescript
// ── NativeComputeInvoke ────────────────────────────────────────
// Requests execution of a native compute session over specified inputs.

type NativeComputeInvokeDescriptor = {
  interface        : 'Compute';
  method           : 'NativeInvoke';
  messageTimestamp : string;
  protocol         : string;
  protocolPath     : string;

  /**
   * Record ID of the native module identity record.
   * The record data is a NativeComputeModuleIdentity JSON object
   * describing the runtime hash, model hash, and engine version.
   */
  moduleRecordId   : string;
  inputFilter      : RecordsFilter;

  /**
   * Parameters passed to the native runtime.
   * For LLM inference: prompt, system message, temperature, etc.
   * For agentic workflows: task description, tool configuration, etc.
   */
  params?          : Record<string, unknown>;

  /**
   * Whether to stream tokens back to the client during execution.
   * When true, the client receives encrypted token chunks in real-time
   * via the streaming channel before the final result is written.
   */
  streaming?       : boolean;

  /** Resource budget. Session terminates if any limit is exceeded. */
  budget?: {
    /** Maximum session duration in milliseconds. */
    maxSessionDuration? : number;
    /** Maximum number of record reads during the session. */
    maxSessionReads?    : number;
    /** Maximum output tokens (for inference workloads). */
    maxOutputTokens?    : number;
    /** Maximum total GPU time in milliseconds. */
    maxGpuMs?           : number;
    /** Maximum input tokens (context window budget). */
    maxInputTokens?     : number;
  };
};

type NativeComputeInvokeMessage = {
  descriptor    : NativeComputeInvokeDescriptor;
  authorization : Authorization;
};

// ── NativeComputeResult ────────────────────────────────────────
// Returned after a native compute session completes.

type NativeComputeResultDescriptor = {
  interface        : 'Compute';
  method           : 'NativeResult';
  messageTimestamp : string;
  invokeMessageCid : string;
  outputRecordIds  : string[];
  receiptRecordId  : string;

  /**
   * Session status.
   * - 'success': completed normally
   * - 'budget-exceeded': terminated due to budget limit
   * - 'error': terminated due to runtime error
   */
  status           : 'success' | 'budget-exceeded' | 'error';
  statusDetail?    : string;
};

type NativeComputeResultMessage = {
  descriptor    : NativeComputeResultDescriptor;
  authorization : Authorization;
};
```

### 8.5 Authorization Flow for Compute

The authorization flow is identical for both WASM and native compute — the DWN protocol engine enforces the same `$compute` rules regardless of engine type. The only difference is what gets dispatched to the worker.

```
Client                        DWN Node                    TEE Compute Worker
  │                              │                              │
  │  1. ComputeInvoke or         │                              │
  │     NativeComputeInvoke      │                              │
  │  (signed by tenant)          │                              │
  │─────────────────────────────▶│                              │
  │                              │                              │
  │                    2. Authorize:                             │
  │                    - Verify signature                       │
  │                    - Check protocol rules                   │
  │                    - Verify $compute allows                 │
  │                      this module + inputs                   │
  │                    - Verify $compute.engine                 │
  │                      matches invoke type                    │
  │                    - Verify invoker has                     │
  │                      required role/actor                    │
  │                              │                              │
  │                              │  3. Dispatch to worker       │
  │                              │  (encrypted records +        │
  │                              │   module identity)           │
  │                              │─────────────────────────────▶│
  │                              │                              │
  │                              │           4. Inside TEE:     │
  │                              │           - Decrypt records  │
  │                              │           - WASM: load + run │
  │                              │           - Native: session  │
  │                              │             lifecycle        │
  │                              │           - Encrypt outputs  │
  │                              │           - Generate receipt │
  │                              │                              │
  │                              │  5. Encrypted outputs +      │
  │                              │     compute receipt          │
  │  ◀── (streaming tokens if    │◀─────────────────────────────│
  │       native + streaming) ── │                              │
  │                              │                              │
  │                    6. Store outputs as                      │
  │                       DWN records                          │
  │                    7. Store receipt as                      │
  │                       DWN record                           │
  │                              │                              │
  │  8. ComputeResult or         │                              │
  │     NativeComputeResult      │                              │
  │  (output + receipt IDs)      │                              │
  │◀─────────────────────────────│                              │
  │                              │                              │
  │  9. Client verifies receipt  │                              │
  │  (attestation, module hash,  │                              │
  │   input/output integrity)    │                              │
  │                              │                              │
```

---

## 9. Provider Interoperability

### 9.1 Provider Registration

A confidential compute provider registers itself by publishing a DID document with service endpoints describing its capabilities:

```json
{
  "id": "did:dht:provider123",
  "service": [{
    "id": "#confidential-dwn",
    "type": "ConfidentialDwnService",
    "serviceEndpoint": {
      "nodes": ["https://cc-dwn.provider.example"],
      "conformanceLevels": [1, 2, "2N"],
      "teePlatforms": ["aws-nitro"],
      "attestationEndpoint": "https://cc-dwn.provider.example/.well-known/dwn-attestation",
      "referenceValues": "https://cc-dwn.provider.example/.well-known/dwn-reference-values",
      "wasmCompute": {
        "wasiVersions": ["preview1", "preview2"],
        "maxModuleSize": 10485760,
        "maxExecutionTime": 30000,
        "maxMemory": 268435456,
        "maxInputRecords": 10000
      },
      "nativeCompute": {
        "gpuTeePlatforms": ["nvidia-cc-h100"],
        "maxSessionDuration": 120000,
        "maxSessionReads": 1000,
        "maxOutputTokens": 16384,
        "streaming": true,
        "models": [
          {
            "modelId": "meta-llama/Llama-3.3-70B-Instruct",
            "modelHash": "sha256:a1b2c3...",
            "engine": "vllm:0.4.1",
            "quantization": "fp16",
            "maxContextTokens": 131072
          },
          {
            "modelId": "mistralai/Mixtral-8x22B-Instruct-v0.1",
            "modelHash": "sha256:d4e5f6...",
            "engine": "vllm:0.4.1",
            "quantization": "fp8",
            "maxContextTokens": 65536
          }
        ]
      }
    }
  }]
}
```

### 9.2 Provider Switching

Because the specification standardizes:
- The attestation format (EAT)
- The compute interface (WASI + `dwn:compute/v1`)
- The receipt format (COSE_Sign1)
- The protocol extensions (`$compute`, `$attestation`)

...a tenant can switch providers without changing their protocol definitions or compute modules:

```
┌──────────┐     Standard DWN sync      ┌───────────────────┐
│          │◀──────────────────────────▶│  Provider A       │
│  Client  │                            │  (AWS Nitro)      │
│  Agent   │                            │  Conformance: L2  │
│          │                            └───────────────────┘
│          │
│          │     Standard DWN sync      ┌───────────────────┐
│          │◀──────────────────────────▶│  Provider B       │
│          │                            │  (Intel TDX)      │
│          │                            │  Conformance: L2  │
└──────────┘                            └───────────────────┘
```

Both providers:
1. Accept the same `ComputeInvoke` messages
2. Execute the same WASM modules
3. Produce receipts in the same format
4. Are verified using the same attestation flow
5. Store and sync records using standard DWN protocols

The only difference is the TEE platform, which is abstracted behind the platform adapter. The protocol definition doesn't care — it specifies `conformanceLevel: 2` and optionally `reproducibleBuild: true`, not `teePlatform: "aws-nitro"`.

### 9.3 Multi-Provider Redundancy

For high-assurance use cases, a tenant can require computation on multiple providers and cross-check results:

```typescript
const HighAssuranceCompute: ProtocolComputeRule = {
  module     : 'computeModule',
  inputs     : ['sensitiveRecord'],
  outputPath : 'verifiedResult',
  deterministic: true,  // Required for cross-provider verification
  attestation: {
    conformanceLevel  : 2,
    reproducibleBuild : true,
    // No acceptedPlatforms — any TEE is fine
  },
};
```

When `deterministic: true`, the client can:
1. Submit the same `ComputeInvoke` to multiple providers
2. Verify that all receipts contain the same `output.data-hash`
3. Verify that each receipt has a valid attestation from a different TEE platform
4. Trust the result only if N-of-M providers agree

This eliminates single-vendor hardware trust as a concern.

---

## 10. Usage Metering

### 10.1 The Metering Problem

Service providers need to charge for compute resources, and clients need to verify they are charged fairly. Three parties have conflicting incentives:

| Party | Incentive |
|---|---|
| **Provider** | Overcount usage to charge more |
| **Client** | Undercount usage to pay less |
| **Protocol author** | Accurate metering so the system is fair |

Traditional cloud metering is provider-reported — the client trusts the provider's billing system. In a decentralized context where the provider is explicitly untrusted (the "curious operator" threat), this is insufficient. The TEE solves this: metering happens *inside* the enclave, where neither party can tamper with it. The `usage` block in the compute receipt (Section 7.1) is signed inside the TEE alongside the attestation evidence, making it as trustworthy as the computation itself.

### 10.2 Metering Dimensions

Resource consumption is captured in the `UsageReport`. Dimensions are split into common (all engines), WASM-specific, and native-specific:

#### Common Dimensions (all engines)

| Dimension | Field | Unit | How It's Measured |
|---|---|---|---|
| **Time** | `execution-ms` | Milliseconds | Wall-clock time measured inside the TEE |
| **Record I/O** | `io-calls` | Count per call type | Incremented on each host import / API call |
| **Data volume** | `input-bytes` / `output-bytes` | Bytes | Sum of record data sizes processed |

#### WASM Engine Dimensions (Level 2)

| Dimension | Field | Unit | How It's Measured |
|---|---|---|---|
| **Compute** | `instructions` | WASM instructions executed | Instruction counter in the WASM runtime (fuel mechanism) |
| **Memory** | `peak-memory` | Bytes | High-water mark of WASM linear memory |

#### Native Engine Dimensions (Level 2N)

| Dimension | Field | Unit | How It's Measured |
|---|---|---|---|
| **Input tokens** | `input-tokens` | Tokens | Tokenizer count of prompt/context tokens processed |
| **Output tokens** | `output-tokens` | Tokens | Count of tokens generated by the model |
| **GPU time** | `gpu-ms` | Milliseconds | Wall-clock GPU execution time inside GPU TEE |
| **GPU memory** | `peak-gpu-memory` | Bytes | High-water mark of GPU memory allocation |
| **Session steps** | `session-steps` | Count | Number of read→reason→act cycles in agentic workflows |

Storage metering (record count, data size, retention duration) is already a solved problem for DWN hosting and is orthogonal to compute metering.

### 10.3 WASM Instruction Counting

Instruction counting is the most robust compute metering primitive. Most WASM runtimes support it natively:

| Runtime | Mechanism |
|---|---|
| **wasmtime** | `fuel` — a counter decremented per instruction; execution traps at zero |
| **wasm-micro-runtime** | Interpreter hooks for instruction counting |
| **wasmer** | Metering middleware that injects counter increments at compile time |

Instruction counting has three properties that make it the natural "gas" unit for confidential compute:

1. **Deterministic** — same module with the same inputs always yields the same instruction count.
2. **Reproducible** — a client can re-execute the WASM module locally and independently verify the count.
3. **Hardware-independent** — unlike wall-clock time, instruction count does not vary with CPU speed, so providers compete on infrastructure cost rather than on metering variance.

When `deterministic: true` is set in the `$compute` rule, the `instructions` field in the receipt is fully reproducible by any party with access to the module and input records.

### 10.4 Budget Enforcement

The `budget` field on `ComputeInvokeDescriptor` (Section 8.3) allows clients to cap resource consumption before invocation. The compute worker enforces these limits inside the TEE:

```
ComputeInvoke                    TEE Compute Worker
  │                                  │
  │  budget: {                       │
  │    maxInstructions: 1_000_000,   │
  │    maxMemory: 67_108_864,        │
  │    maxExecutionMs: 5_000,        │
  │    maxInputRecords: 100,         │
  │  }                               │
  │─────────────────────────────────▶│
  │                                  │
  │                    Set WASM fuel = 1_000_000
  │                    Set memory limit = 64 MB
  │                    Start timer (5 s)
  │                    Cap input reads at 100
  │                                  │
  │                    ── Execution ──
  │                                  │
  │             If any limit exceeded:
  │               - Halt execution
  │               - Discard partial outputs
  │               - Generate receipt with
  │                 actual usage up to halt
  │               - Return ComputeResult
  │                 with status: "budget-exceeded"
  │◀─────────────────────────────────│
```

When a budget is exceeded, no result records are written, but the receipt still records the actual resource consumption up to the abort point. This ensures the client only pays for resources actually consumed and can inspect *why* the budget was exceeded (e.g., too many input records, unexpectedly expensive computation).

If no budget is specified, the provider's advertised limits from the `capabilities` block in its DID document service endpoint apply as defaults (Section 5.1).

### 10.5 Provider Price Schedules

A provider publishes its pricing as part of its DID document service endpoint, enabling clients to compare costs before selecting a provider:

```json
{
  "id": "#confidential-dwn",
  "type": "ConfidentialDwnService",
  "serviceEndpoint": {
    "nodes": ["https://cc-dwn.provider.example"],
    "conformanceLevels": [1, 2, "2N"],
    "pricing": {
      "currency": "USD",
      "wasmCompute": {
        "perBillionInstructions": 0.10,
        "perGbMemorySecond": 0.01,
        "perRecordIoCall": 0.001,
        "perGbDataProcessed": 0.05
      },
      "nativeCompute": {
        "perMillionInputTokens": 0.60,
        "perMillionOutputTokens": 2.40,
        "perGpuSecond": 0.001,
        "perRecordIoCall": 0.001,
        "perGbDataProcessed": 0.05,
        "perSessionStep": 0.01
      },
      "storage": {
        "perGbMonth": 0.02
      },
      "attestation": {
        "perHandshake": 0
      }
    }
  }
}
```

Note: Native compute pricing is **token-based** for inference workloads, which aligns with industry-standard LLM pricing. Providers publish per-model pricing since different models have different compute costs. The `nativeCompute` pricing block above represents base rates; model-specific overrides can be published in the `nativeCompute.models` array of the capabilities block (Section 9.1).

Because metering is standardized, pricing becomes directly comparable across providers. A client can compute the exact cost of any invocation from the receipt's `usage` block and the provider's published schedule. No surprises.

### 10.6 Pre-Flight Cost Estimation

For deterministic modules (`deterministic: true`), a client can estimate cost *before* invoking:

1. **Input sizing** — the client queries its own DWN to determine input record count and total data size.
2. **Local dry-run** — the client runs the WASM module locally against its own data to measure the instruction count. (The client already has read access to its own records and the module bytecode.)
3. **Cost calculation** — multiply the measured instruction count by the provider's `perBillionInstructions` rate, add I/O and data volume costs.
4. **Budget setting** — set the `budget` field to the estimated usage plus a safety margin (e.g., 10%).

For non-deterministic modules, the provider MAY offer a cost estimation endpoint:

```
GET /compute/estimate
  ?protocol=<uri>
  &protocolPath=<path>
  &moduleRecordId=<id>
  &inputFilter=<filter>

Response:
{
  "estimatedInstructions": 450000000,
  "estimatedInputBytes": 1048576,
  "estimatedOutputBytes": 256,
  "estimatedCost": {
    "currency": "USD",
    "amount": 0.045
  },
  "confidence": "approximate"
}
```

This is a best-effort estimate — the actual usage in the receipt is authoritative.

### 10.7 Metering Trust Properties

The TEE-attested metering model provides the following guarantees:

| Property | Mechanism |
|---|---|
| **Tamper-proof** | The `usage` block is inside the COSE_Sign1 receipt, signed by the TEE. Neither party can modify it after execution. |
| **Non-repudiable** | Both client and provider hold the same cryptographically-signed receipt. Neither can deny the recorded usage. |
| **Reproducible** (deterministic modules) | Any party with the module and inputs can independently verify the `instructions` count by re-execution. |
| **Auditable** | Receipts are stored as DWN records, queryable and filterable. A client can audit their complete usage history via `ComputeQuery`. |
| **Comparable** | Standardized units mean the same module with the same inputs costs the same instruction count on any provider. Only price differs. |

### 10.8 Market Implications

Standardized, TEE-attested metering enables a competitive provider marketplace:

- **Comparison shopping** — same module, same inputs, same instruction count across providers. The only variable is price-per-unit.
- **Efficiency competition** — faster TEE hardware lowers a provider's infrastructure cost, but the instruction count (and the client's bill) stays constant. Providers compete by reducing their own costs, not by inflating metered usage.
- **No billing disputes** — the receipt *is* the invoice. Both parties have identical, cryptographically-signed usage data.
- **No lock-in** — switching providers does not change the metering model. Receipts from Provider A and Provider B use the same format and the same units.
- **Payment-layer agnostic** — this specification defines *what* is metered and *how* it is attested, not *how* payment is settled. Fiat invoicing, cryptocurrency micropayments, pre-paid credit pools, or any other payment mechanism can be layered on top of the standardized usage data.

---

## 11. Metadata Protection (Future — Level 3+)

### 11.1 The Metadata Problem

Even with record data encrypted, DWN message descriptors contain metadata visible to the node operator:

- Protocol URI and path (what type of data this is)
- Schema URI
- Timestamps (when data was created/modified)
- Record relationships (parent/child structure)
- Author DID (who wrote this)
- Recipient DID (who it's for)
- Data size
- Tags

This metadata can reveal significant information without ever decrypting the record data.

### 11.2 Encrypted Indexes

Inside a TEE, the DWN can maintain **encrypted indexes** — the index structure is only readable inside the enclave:

```
Outside TEE (on disk):
┌──────────────────────────────────┐
│  Encrypted index blob            │
│  (AES-256-GCM, key sealed to    │
│   enclave measurement)           │
└──────────────────────────────────┘

Inside TEE (in memory):
┌──────────────────────────────────┐
│  Decrypted index                 │
│  protocol_path → [record_ids]   │
│  schema → [record_ids]          │
│  author → [record_ids]          │
│  tags → [record_ids]            │
└──────────────────────────────────┘
```

The index is sealed to the enclave measurement, so only the same (or measurement-equivalent) enclave can unseal and use it. The operator sees only an opaque encrypted blob.

### 11.3 Oblivious Query Processing

For maximum metadata protection, queries can be processed obliviously inside the TEE:

1. Client sends an encrypted query (encrypted to the enclave's attestation-bound public key)
2. TEE decrypts the query inside the enclave
3. TEE executes the query against encrypted indexes
4. TEE returns encrypted results (encrypted to the client's public key)

The operator observes only: a client sent an opaque blob, and received an opaque blob back. They cannot determine what was queried, how many records matched, or what was returned.

This is the most ambitious level of protection and is designated as future work beyond the initial conformance levels.

---

## 12. Implementation Phases

### Phase 1: Attestation Foundation (Level 1)

**Goal:** Any DWN node can prove its integrity; any client can verify it.

**Deliverables:**
1. **Platform Abstraction Layer** — `AttestationAdapter` interface with an initial AWS Nitro implementation and a simulated adapter for development/testing.
2. **EAT Token Generation** — DWN server generates standards-compliant EAT tokens on demand.
3. **Attestation Endpoint** — `/.well-known/dwn-attestation` endpoint on the DWN server.
4. **Client Verification** — `@enbox/agent` SDK gains `verifyNodeAttestation()` that validates EAT tokens against reference values.
5. **Reference Value Publication** — build pipeline publishes enclave measurements per release, signed by the project DID.
6. **DID Document Extension** — `confidentialCompute` service endpoint schema.
7. **Reproducible Builds** — DWN server + TEE key service produce deterministic build artifacts (Nix or Docker multi-stage).

**No protocol changes.** Existing clients continue to work unchanged. Attestation-aware clients get additional assurance.

### Phase 2: Protocol-Governed Compute (Level 2 + 2N)

**Goal:** Protocols can declare compute rules; WASM modules and native runtimes execute over encrypted data inside TEEs.

**Deliverables (Level 2 — WASM):**
1. **Compute Module Interface** — `dwn:compute/v1` WIT definition and host implementation.
2. **WASM Runtime in TEE** — integrate `wasmtime` (or `wasm-micro-runtime`) inside the enclave.
3. **`$compute` Directive** — protocol definition parser, validator, and authorization handler in `dwn-sdk-js`, including `engine` discriminator.
4. **`Compute` Interface Messages** — `ComputeInvoke`, `ComputeResult`, `ComputeQuery` message types with handlers.
5. **Compute Receipt** — COSE_Sign1 receipt generation and verification (with `engine` field).
6. **Protocol Authorization** — compute invocation authorization checks (actor/role model).
7. **Second TEE Platform** — Intel TDX adapter to prove the abstraction layer works across vendors.

**Deliverables (Level 2N — Native Compute):**
8. **Native Compute Interface** — NCI socket API specification (Section 6A.3) and reference implementation of the Record I/O shim.
9. **NCI Session Manager** — session lifecycle management (create, enforce budgets, generate receipt on end).
10. **`NativeComputeInvoke` / `NativeComputeResult` Messages** — message types with handlers in `dwn-sdk-js`.
11. **Streaming Support** — encrypted token streaming from TEE to client via `emitToken()`.
12. **GPU TEE Attestation** — NVIDIA CC attestation adapter; chained attestation evidence format.
13. **Provider Integration SDK** — lightweight SDK (Rust/TypeScript) that providers embed to implement the NCI shim, EAT wrapper, and receipt generator. Target: an OpenSecret-style provider can integrate in <1 week.
14. **Native Module Identity** — `NativeComputeModuleIdentity` record type, including `runtimeHash` and `modelHash` verification in receipts.

### Phase 3: Multi-Party Compute and Metadata Protection (Level 3)

**Goal:** Cross-tenant computation and metadata confidentiality — for both WASM and native engines.

**Deliverables:**
1. **Cross-Tenant Key Delivery** — extend `KeyDeliveryProtocol` for compute-context key sharing (both WASM and native sessions).
2. **Multi-Tenant Input Aggregation** — compute worker handles records from multiple tenants inside a single TEE invocation or native session.
3. **Consent Protocol** — each tenant's protocol rules must explicitly authorize cross-tenant compute.
4. **Encrypted Indexes** — index structures sealed to enclave measurement.
5. **Oblivious Query Processing** — encrypted query/response protocol between client and TEE.
6. **Third TEE Platform** — AMD SEV-SNP adapter (CPU + GPU for MI300X).
7. **Multi-Tenant Agentic Workflows** — native compute sessions that aggregate data from multiple tenants for LLM-powered analysis (e.g., a financial advisor LLM that processes records from both a bank and a borrower).

### Phase 4: Ecosystem Maturity

**Goal:** Production hardening, tooling, and ecosystem growth.

**Deliverables:**
1. **Compute Module SDK** — developer toolchain for writing, testing, and debugging WASM compute modules (Rust → WASM, AssemblyScript → WASM, etc.).
2. **NCI Provider SDK** — production-ready SDK for native compute providers, including reference implementations for OpenSecret-style (Nitro + NVIDIA CC) and Intel TDX + GPU deployments.
3. **Module Registry** — a protocol for publishing and discovering audited compute modules — both WASM modules and native module identities (model hashes, runtime hashes).
4. **Model Attestation Registry** — a community-maintained registry mapping model IDs to verified model hashes, enabling clients to verify that a provider is running the claimed model.
5. **Multi-Provider Verification** — client SDK support for submitting deterministic WASM computations to multiple providers and cross-checking results. For native (non-deterministic) compute: support for submitting the same prompt to multiple providers and comparing outputs for consistency.
6. **Formal Specification** — submit the protocol extensions and attestation format as a DIF (Decentralized Identity Foundation) or W3C specification.
7. **Compliance Mapping** — document how each conformance level (including Level 2N) maps to regulatory requirements (GDPR, HIPAA, SOC 2, etc.). Special attention to AI-specific regulations (EU AI Act, NIST AI RMF) for Level 2N native compute.

---

## 13. Example: End-to-End Walkthrough

### Scenario: Privacy-Preserving Income Verification

A lender (Verifier) wants to confirm that a borrower's (Data Owner) income exceeds a threshold, without seeing the actual income data.

**Step 1: Protocol Definition**

The protocol author publishes an income verification protocol:

```typescript
const IncomeVerificationProtocol = {
  protocol  : 'https://standards.example/income-verification/v1',
  published : true,
  types     : {
    incomeRecord: {
      schema             : 'https://standards.example/schemas/income',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    computeModule: {
      dataFormats : ['application/wasm'],
    },
    verificationRequest: {
      schema      : 'https://standards.example/schemas/verification-request',
      dataFormats : ['application/json'],
    },
    verificationResult: {
      schema             : 'https://standards.example/schemas/verification-result',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    computeReceipt: {
      schema      : 'https://standards.example/schemas/compute-receipt',
      dataFormats : ['application/cbor'],
    },
  },
  structure: {
    incomeRecord: {
      $actions: [
        { who: 'author', of: 'incomeRecord', can: ['create', 'read', 'update'] },
      ],
    },
    computeModule: {
      $actions: [
        { who: 'author', of: 'incomeRecord', can: ['create', 'read'] },
      ],
    },
    verificationRequest: {
      $actions: [
        { who: 'anyone', can: ['create'] },
        { who: 'author', of: 'incomeRecord', can: ['read'] },
      ],
      verificationResult: {
        $actions: [
          { who: 'author', of: 'incomeRecord', can: ['read'] },
          { who: 'author', of: 'verificationRequest', can: ['read'] },
        ],
        $compute: {
          module        : 'computeModule',
          inputs        : ['incomeRecord'],
          outputPath    : 'verificationRequest/verificationResult',
          deterministic : true,
          attestation   : {
            conformanceLevel  : 2,
            reproducibleBuild : true,
            // No acceptedPlatforms — any TEE works
          },
        },
      },
    },
    computeReceipt: {
      $actions: [
        { who: 'author', of: 'incomeRecord', can: ['read'] },
        { who: 'author', of: 'verificationRequest', can: ['read'] },
      ],
    },
  },
};
```

**Step 2: Data Owner Installs Protocol and Stores Income**

```typescript
// Install the protocol on the data owner's DWN
await agent.dwn.processRequest({
  author        : ownerDid,
  target        : ownerDid,
  messageType   : DwnInterface.ProtocolsConfigure,
  messageParams : { definition: IncomeVerificationProtocol },
});

// Store an encrypted income record
await agent.dwn.processRequest({
  author        : ownerDid,
  target        : ownerDid,
  messageType   : DwnInterface.RecordsWrite,
  messageParams : {
    protocol     : 'https://standards.example/income-verification/v1',
    protocolPath : 'incomeRecord',
    schema       : 'https://standards.example/schemas/income',
    dataFormat   : 'application/json',
  },
  dataStream: new Blob([JSON.stringify({ annualIncome: 95000, currency: 'USD' })]),
});

// Upload an audited compute module (WASM binary)
await agent.dwn.processRequest({
  author        : ownerDid,
  target        : ownerDid,
  messageType   : DwnInterface.RecordsWrite,
  messageParams : {
    protocol     : 'https://standards.example/income-verification/v1',
    protocolPath : 'computeModule',
    dataFormat   : 'application/wasm',
  },
  dataStream: new Blob([incomeThresholdWasmBytes]),
});
```

**Step 3: Verifier Requests Verification**

```typescript
// Verifier first checks the DWN node's attestation
const attestation = await agent.attestation.verify({
  targetDid      : ownerDid,
  requiredLevel  : 2,
  requireReproducibleBuild: true,
});
// attestation.verified === true

// Verifier writes a verification request
const request = await agent.dwn.processRequest({
  author        : verifierDid,
  target        : ownerDid,
  messageType   : DwnInterface.RecordsWrite,
  messageParams : {
    protocol     : 'https://standards.example/income-verification/v1',
    protocolPath : 'verificationRequest',
    schema       : 'https://standards.example/schemas/verification-request',
    dataFormat   : 'application/json',
  },
  dataStream: new Blob([JSON.stringify({ threshold: 75000, currency: 'USD' })]),
});

// Verifier invokes the compute module
const result = await agent.dwn.processRequest({
  author        : verifierDid,
  target        : ownerDid,
  messageType   : DwnInterface.ComputeInvoke,
  messageParams : {
    protocol       : 'https://standards.example/income-verification/v1',
    protocolPath   : 'verificationRequest/verificationResult',
    moduleRecordId : moduleRecordId,
    inputFilter    : { protocolPath: 'incomeRecord' },
    params         : { threshold: 75000, currency: 'USD' },
  },
});
```

**Step 4: Inside the TEE**

The compute worker (inside a TEE) does the following — none of this is visible to the node operator:

1. Decrypts the income records using the tenant's `#enc` key (held in TEE key service)
2. Loads the WASM module (hash verified against the module record)
3. Calls `run('{"threshold":75000,"currency":"USD"}')`
4. The WASM module calls `read-record` for each income record
5. The WASM module computes: `annualIncome >= threshold` → `true`
6. The WASM module calls `write-result` with `{"meetsThreshold": true}`
7. The worker encrypts the result (JWE to both owner and verifier)
8. The worker generates a compute receipt (COSE_Sign1 with EAT attestation)

**Step 5: Verifier Reads and Verifies the Result**

```typescript
// Read the verification result
const resultRecord = await agent.dwn.processRequest({
  author        : verifierDid,
  target        : ownerDid,
  messageType   : DwnInterface.RecordsRead,
  messageParams : { filter: { recordId: result.outputRecordIds[0] } },
});
// resultRecord.data === { meetsThreshold: true }

// Read and verify the compute receipt
const receipt = await agent.dwn.processRequest({
  author        : verifierDid,
  target        : ownerDid,
  messageType   : DwnInterface.RecordsRead,
  messageParams : { filter: { recordId: result.receiptRecordId } },
});

const verification = await agent.attestation.verifyReceipt(receipt.data);
// verification.moduleHashValid === true
// verification.attestationValid === true
// verification.inputIntegrityValid === true
// verification.outputIntegrityValid === true
```

The verifier now knows:
- The borrower's income meets the threshold ✓
- The result was computed inside an attested TEE ✓
- The specific audited WASM module was used ✓
- The correct input records were consumed ✓
- The verifier never saw the actual income amount ✓
- A different provider (Intel TDX instead of AWS Nitro) would produce the same result ✓

### Scenario: LLM Agent Over Private Health Records

A patient wants an AI health assistant to analyze their encrypted medical records and provide personalized recommendations — without the provider, the model operator, or anyone else seeing the raw health data.

**Step 1: Protocol Definition**

The protocol author publishes a health AI assistant protocol:

```typescript
const HealthAiProtocol = {
  protocol  : 'https://standards.example/health-ai/v1',
  published : true,
  types     : {
    medicalRecord: {
      schema             : 'https://standards.example/schemas/medical-record',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    aiModule: {
      schema      : 'https://standards.example/schemas/native-module-identity',
      dataFormats : ['application/json'],
    },
    assistantQuery: {
      schema      : 'https://standards.example/schemas/assistant-query',
      dataFormats : ['application/json'],
    },
    assistantResponse: {
      schema             : 'https://standards.example/schemas/assistant-response',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    computeReceipt: {
      schema      : 'https://standards.example/schemas/compute-receipt',
      dataFormats : ['application/cbor'],
    },
  },
  structure: {
    medicalRecord: {
      $actions: [
        { who: 'author', of: 'medicalRecord', can: ['create', 'read', 'update'] },
      ],
    },
    aiModule: {
      $actions: [
        { who: 'author', of: 'medicalRecord', can: ['create', 'read'] },
      ],
    },
    assistantQuery: {
      $actions: [
        { who: 'author', of: 'medicalRecord', can: ['create'] },
      ],
      assistantResponse: {
        $actions: [
          { who: 'author', of: 'medicalRecord', can: ['read'] },
        ],
        $compute: {
          engine        : 'native',
          module        : 'aiModule',
          inputs        : ['medicalRecord'],
          outputPath    : 'assistantQuery/assistantResponse',
          deterministic : false,
          streaming     : true,
          attestation   : {
            conformanceLevel  : '2N',
            reproducibleBuild : true,
          },
          nativeConstraints: {
            maxSessionDuration : 60000,    // 60 seconds
            maxSessionReads    : 100,      // up to 100 medical records
            maxOutputTokens    : 4096,     // bounded response length
            requireGpuTee      : true,     // require GPU TEE for model isolation
            model: {
              modelId : 'meta-llama/Llama-3.3-70B-Instruct',
              // Pin to a specific audited model version:
              modelHash : 'sha256:a1b2c3d4e5f6...',
            },
          },
        },
      },
    },
    computeReceipt: {
      $actions: [
        { who: 'author', of: 'medicalRecord', can: ['read'] },
      ],
    },
  },
};
```

**Step 2: Patient Stores Medical Records and AI Module Identity**

```typescript
// Install the protocol on the patient's DWN
await agent.dwn.processRequest({
  author        : patientDid,
  target        : patientDid,
  messageType   : DwnInterface.ProtocolsConfigure,
  messageParams : { definition: HealthAiProtocol },
});

// Store encrypted medical records (already present from healthcare providers)
// ... records are encrypted with the patient's #enc key ...

// Store the approved AI module identity
await agent.dwn.processRequest({
  author        : patientDid,
  target        : patientDid,
  messageType   : DwnInterface.RecordsWrite,
  messageParams : {
    protocol     : 'https://standards.example/health-ai/v1',
    protocolPath : 'aiModule',
    schema       : 'https://standards.example/schemas/native-module-identity',
    dataFormat   : 'application/json',
  },
  dataStream: new Blob([JSON.stringify({
    runtimeHash  : 'sha256:abc123...',   // Hash of provider's NixOS enclave image
    modelHash    : 'sha256:a1b2c3d4e5f6...', // Hash of Llama 3.3 70B weights
    engine       : 'vllm:0.4.1',
    modelId      : 'meta-llama/Llama-3.3-70B-Instruct',
    quantization : 'fp16',
  })]),
});
```

**Step 3: Patient Queries the AI Assistant**

```typescript
// Verify the compute provider's attestation first
const attestation = await agent.attestation.verify({
  targetDid     : patientDid,   // the DWN hosting the records
  requiredLevel : '2N',
  requireReproducibleBuild : true,
  requireGpuTee : true,
});
// attestation.verified === true
// attestation.cpuTee === 'aws-nitro'
// attestation.gpuTee === 'nvidia-cc-h100'

// Write a query
const query = await agent.dwn.processRequest({
  author        : patientDid,
  target        : patientDid,
  messageType   : DwnInterface.RecordsWrite,
  messageParams : {
    protocol     : 'https://standards.example/health-ai/v1',
    protocolPath : 'assistantQuery',
    schema       : 'https://standards.example/schemas/assistant-query',
    dataFormat   : 'application/json',
  },
  dataStream: new Blob([JSON.stringify({
    question: 'Based on my recent lab results, are there any concerning trends I should discuss with my doctor?',
  })]),
});

// Invoke the native compute session with streaming
const session = await agent.dwn.processRequest({
  author        : patientDid,
  target        : patientDid,
  messageType   : DwnInterface.NativeComputeInvoke,
  messageParams : {
    protocol       : 'https://standards.example/health-ai/v1',
    protocolPath   : 'assistantQuery/assistantResponse',
    moduleRecordId : aiModuleRecordId,
    inputFilter    : { protocolPath: 'medicalRecord' },
    streaming      : true,
    params         : {
      queryRecordId  : query.recordId,
      systemMessage  : 'You are a health assistant. Analyze the patient\'s medical records and answer their question. Be specific but note you are not a doctor.',
      temperature    : 0.3,
    },
    budget: {
      maxSessionDuration : 60000,
      maxSessionReads    : 100,
      maxOutputTokens    : 4096,
      maxInputTokens     : 65536,
    },
  },
});
```

**Step 4: Inside the Chained TEE**

This is what happens inside the provider's TEE infrastructure — none of it is visible to the operator:

```
┌─ AWS Nitro Enclave (CPU TEE) ─────────────────────────────────────┐
│                                                                    │
│  1. Receive NativeComputeInvoke message                           │
│  2. Create compute session with budget limits                      │
│  3. Start NCI Record I/O API on local socket                      │
│                                                                    │
│  ┌─ NVIDIA H100 GPU TEE ──────────────────────────────────────┐   │
│  │                                                             │   │
│  │  4. vLLM loads Llama 3.3 70B (weights verified: modelHash) │   │
│  │                                                             │   │
│  │  5. Agentic loop begins:                                    │   │
│  │     a. Format system prompt + user question                 │   │
│  │     b. Call readRecord() via NCI → decrypt lab results      │   │
│  │     c. Inject relevant records into context                 │   │
│  │     d. Run inference → model reads records, reasons         │   │
│  │     e. Model decides it needs more context                  │   │
│  │     f. Call queryRecords({tags: {type: "lab-result"}})      │   │
│  │     g. Call readRecord() for additional records             │   │
│  │     h. Continue inference with expanded context             │   │
│  │     i. Stream tokens via emitToken() as they're generated  │   │
│  │                                                             │   │
│  │  6. Final response complete                                 │   │
│  │     → writeResult(responseData)                             │   │
│  │     → endSession('success')                                 │   │
│  │                                                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  7. Encrypt response with patient's #enc key (JWE)                │
│  8. Generate compute receipt:                                      │
│     - engine: "native"                                             │
│     - runtimeHash: sha256:abc123... (matches Nitro PCR0)          │
│     - modelHash: sha256:a1b2c3... (verified in GPU TEE)           │
│     - inputs: [lab-result-1, lab-result-2, ..., lab-result-7]     │
│     - output: [response-record-id]                                 │
│     - usage: { input-tokens: 12847, output-tokens: 523,           │
│               gpu-ms: 4200, session-steps: 3,                      │
│               io-calls: { read-record: 7, query-records: 1,       │
│                           write-result: 1, emit-token: 523 } }    │
│     - attestation: chained EAT (Nitro + NVIDIA CC)                │
│  9. Sign receipt inside TEE (COSE_Sign1)                           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Step 5: Patient Receives Streaming Response and Verifies**

```typescript
// During execution, the patient receives streaming tokens:
session.onToken((token) => {
  // Encrypted token chunks, decrypted client-side
  process.stdout.write(token);
});
// Output streams: "Based on your recent lab results, I notice..."

// After completion, verify the receipt
const receipt = await agent.dwn.processRequest({
  author        : patientDid,
  target        : patientDid,
  messageType   : DwnInterface.RecordsRead,
  messageParams : { filter: { recordId: session.receiptRecordId } },
});

const verification = await agent.attestation.verifyReceipt(receipt.data);
// verification.engineType === 'native'
// verification.cpuAttestationValid === true (Nitro PCR0 matches runtimeHash)
// verification.gpuAttestationValid === true (NVIDIA CC report matches modelHash)
// verification.modelId === 'meta-llama/Llama-3.3-70B-Instruct'
// verification.inputIntegrityValid === true (all 7 records verified)
// verification.outputIntegrityValid === true
// verification.budgetRespected === true (523 tokens < 4096 limit)
```

The patient now knows:
- Their medical records were analyzed inside a hardware-isolated TEE
- The specific audited model (Llama 3.3 70B) processed their data
- The provider operator never saw their records or the AI's response
- The response was generated within the declared resource budget
- A different provider (e.g., Intel TDX + AMD MI300X) could run the same protocol

---

## 14. Comparison with Alternatives

| Approach | Vendor Lock-in | Hardware Trust | Metadata Protection | Compute Types | Standard |
|---|---|---|---|---|---|
| **This spec (L2 — WASM)** | None (multi-TEE) | TEE vendor (mitigated by multi-provider) | Yes (Level 3) | Deterministic WASM | EAT, COSE, WASI |
| **This spec (L2N — Native)** | None (multi-TEE) | TEE vendor (mitigated by multi-provider) | Yes (Level 3) | LLM inference, GPU, agentic | EAT, COSE, NCI |
| **OpenSecret (standalone)** | AWS Nitro + NVIDIA | Nitro + NVIDIA CC | Partial (encrypted vaults) | LLM inference, general | Proprietary |
| **FHE-only** | None | None needed | Inherent | Limited (very slow) | Emerging |
| **MPC-only** | None | None needed | Partial | Limited (communication overhead) | Emerging |
| **Single-vendor TEE** | High | Single vendor | Possible | Any | Proprietary |
| **ZK proofs only** | None | None needed | Inherent | Limited (circuit complexity) | Emerging |
| **Hybrid (TEE + ZK)** | Low | Reduced | Yes | Any + verifiable | Mixed |

Note the critical distinction: **OpenSecret standalone** provides excellent confidential AI inference but locks the data model and attestation format to its platform. **OpenSecret as a Level 2N provider** in this spec inherits multi-provider portability, standardized receipts, and DWN protocol-governed access control — while retaining its proven TEE infrastructure.

The hybrid approach (TEE for performance + ZK for verification) is a promising future direction. This specification is designed to accommodate it: compute receipts could include ZK proofs alongside TEE attestation, providing both hardware-isolated execution and mathematically verifiable results.

---

## 15. Open Standards Engagement

### Target Standards Bodies

| Body | Submission | Content |
|---|---|---|
| **DIF (Decentralized Identity Foundation)** | DWN Specification Extension | `$compute` and `$attestation` protocol directives, `Compute` interface messages |
| **IETF RATS WG** | Informational Draft | DWN-specific EAT claims profile, attestation handshake for DWN nodes |
| **W3C CCG** | Work Item | DID document `confidentialCompute` service endpoint schema |
| **CCC (Confidential Computing Consortium)** | Use Case Paper | DWN as a use case for interoperable confidential computing |
| **WASM CG** | WASI Proposal | `dwn:compute` WIT interface as a WASI world extension |

### Intellectual Property

All protocol extensions, attestation formats, and interface definitions in this specification are intended to be published under royalty-free terms, consistent with DIF and W3C IPR policies.

---

## References

### Standards and RFCs

- [IETF RFC 9334 — Remote ATtestation procedureS (RATS) Architecture](https://datatracker.ietf.org/doc/rfc9334/)
- [IETF draft-ietf-rats-eat — Entity Attestation Token](https://datatracker.ietf.org/doc/draft-ietf-rats-eat/)
- [IETF RFC 9052 — CBOR Object Signing and Encryption (COSE)](https://www.rfc-editor.org/rfc/rfc9052)
- [IETF SEAL WG — Secure Evidence and Attestation Layer](https://datatracker.ietf.org/doc/charter-ietf-seal/)
- [WASI — WebAssembly System Interface](https://wasi.dev/)
- [WIT — WASM Interface Types](https://component-model.bytecodealliance.org/design/wit.html)

### Confidential Computing

- [Confidential Computing Consortium](https://confidentialcomputing.io/)
- [CCC Attestation Specifications](https://github.com/CCC-Attestation)
- [Veraison — Verification of Attestation](https://github.com/veraison)
- [Remote Attestation in Confidential Computing Explained](https://edera.dev/stories/remote-attestation-in-confidential-computing-explained)

### Confidential AI Inference

- [OpenSecret — Confidential Computing Platform](https://opensecret.cloud) — Production example of Nitro + GPU TEE chaining for confidential AI inference ([technicals](https://blog.opensecret.cloud/opensecret-technicals/), [source](https://github.com/OpenSecretCloud/opensecret))
- [NVIDIA Confidential Computing](https://www.nvidia.com/en-us/data-center/solutions/confidential-computing/) — H100/Blackwell GPU TEE with hardware-encrypted GPU memory
- [Edgeless Systems — Contrast](https://www.edgeless.systems/) — GPU TEE infrastructure provider (used by OpenSecret for NVIDIA CC deployment)
- [Red Hat — Confidential AI Inference](https://next.redhat.com/2025/10/23/enhancing-ai-inference-security-with-confidential-computing-a-path-to-private-data-inference-with-proprietary-llms/) — Architecture patterns for confidential LLM inference

### Research

- [Oblix — Efficient Oblivious Search Index](https://people.eecs.berkeley.edu/~raluca/oblix.pdf)
- [CryptDB — Protecting Confidentiality with Encrypted Query Processing](https://people.eecs.berkeley.edu/~raluca/CryptDB-sosp11.pdf)
- [Index Obfuscation for Oblivious Document Retrieval in TEE](https://dl.acm.org/doi/10.1145/3340531.3412035)
- [Enc²DB — Hybrid Encrypted Query Processing](https://link.springer.com/chapter/10.1007/978-981-97-5562-2_4)
- [Veracruz — Privacy-Preserving Collaborative Computation](https://github.com/veracruz-project/veracruz)
