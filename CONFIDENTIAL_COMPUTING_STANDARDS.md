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

### Level 3: Attested Multi-Party Compute

Everything in Level 2, plus support for computation over records from multiple tenants with cross-tenant key delivery.

**Requirements:**
- All Level 2 requirements
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

## 7. Compute Receipt Standard

### 7.1 Receipt Format

Every compute execution produces a **Compute Receipt** — a COSE_Sign1 structure that cryptographically binds inputs, code, environment, and outputs.

```cddl
ComputeReceipt = COSE_Sign1<{
  ; What ran
  "module-hash"     : bstr,           ; SHA-256 of the WASM bytecode
  "module-record"   : tstr,           ; DWN record ID of the module

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
  ; WASM instruction counter (deterministic, reproducible)
  "instructions"   : uint,

  ; Peak WASM linear memory in bytes
  "peak-memory"    : uint,

  ; Wall-clock execution time in milliseconds (measured inside TEE)
  "execution-ms"   : uint,

  ; Number of host import calls by type
  "io-calls"       : {
    "read-record"     : uint,
    "query-records"   : uint,
    "write-result"    : uint,
    "read-descriptor" : uint,
  },

  ; Total bytes processed
  "input-bytes"    : uint,            ; sum of decrypted input record data
  "output-bytes"   : uint,            ; sum of output record data (pre-encryption)
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
   * Protocol path of the record type containing the WASM module.
   * The module bytecode is stored as data of records at this path.
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
   * Default: true.
   */
  deterministic?: boolean;

  /**
   * Minimum attestation requirements for the compute environment.
   * Provider-agnostic — specifies WHAT is required, not HOW.
   */
  attestation: ComputeAttestationRequirement;
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

### 8.4 Authorization Flow for Compute

```
Client                        DWN Node                    TEE Compute Worker
  │                              │                              │
  │  1. ComputeInvoke            │                              │
  │  (signed by tenant)          │                              │
  │─────────────────────────────▶│                              │
  │                              │                              │
  │                    2. Authorize:                             │
  │                    - Verify signature                       │
  │                    - Check protocol rules                   │
  │                    - Verify $compute allows                 │
  │                      this module + inputs                   │
  │                    - Verify invoker has                     │
  │                      required role/actor                    │
  │                              │                              │
  │                              │  3. Dispatch to worker       │
  │                              │  (encrypted records +        │
  │                              │   WASM module bytecode)      │
  │                              │─────────────────────────────▶│
  │                              │                              │
  │                              │           4. Inside TEE:     │
  │                              │           - Decrypt records  │
  │                              │           - Load WASM module │
  │                              │           - Execute run()    │
  │                              │           - Encrypt outputs  │
  │                              │           - Generate receipt │
  │                              │                              │
  │                              │  5. Encrypted outputs +      │
  │                              │     compute receipt          │
  │                              │◀─────────────────────────────│
  │                              │                              │
  │                    6. Store outputs as                      │
  │                       DWN records                          │
  │                    7. Store receipt as                      │
  │                       DWN record                           │
  │                              │                              │
  │  8. ComputeResult            │                              │
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
      "conformanceLevel": 2,
      "teePlatforms": ["aws-nitro"],
      "wasiVersions": ["preview1", "preview2"],
      "attestationEndpoint": "https://cc-dwn.provider.example/.well-known/dwn-attestation",
      "referenceValues": "https://cc-dwn.provider.example/.well-known/dwn-reference-values",
      "capabilities": {
        "maxModuleSize": 10485760,
        "maxExecutionTime": 30000,
        "maxMemory": 268435456,
        "maxInputRecords": 10000,
        "supportedComputeFormats": ["application/wasm"]
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

Five natural dimensions of resource consumption are captured in the `UsageReport`:

| Dimension | Field | Unit | How It's Measured |
|---|---|---|---|
| **Compute** | `instructions` | WASM instructions executed | Instruction counter in the WASM runtime (fuel mechanism) |
| **Memory** | `peak-memory` | Bytes | High-water mark of WASM linear memory |
| **Time** | `execution-ms` | Milliseconds | Wall-clock time measured inside the TEE |
| **Record I/O** | `io-calls` | Count per call type | Incremented on each host import call |
| **Data volume** | `input-bytes` / `output-bytes` | Bytes | Sum of record data sizes processed |

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
    "conformanceLevel": 2,
    "pricing": {
      "currency": "USD",
      "compute": {
        "perBillionInstructions": 0.10,
        "perGbMemorySecond": 0.01,
        "perRecordIoCall": 0.001,
        "perGbDataProcessed": 0.05
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

### Phase 2: Protocol-Governed Compute (Level 2)

**Goal:** Protocols can declare compute rules; WASM modules execute over encrypted data inside TEEs.

**Deliverables:**
1. **Compute Module Interface** — `dwn:compute/v1` WIT definition and host implementation.
2. **WASM Runtime in TEE** — integrate `wasmtime` (or `wasm-micro-runtime`) inside the enclave.
3. **`$compute` Directive** — protocol definition parser, validator, and authorization handler in `dwn-sdk-js`.
4. **`Compute` Interface Messages** — `ComputeInvoke`, `ComputeResult`, `ComputeQuery` message types with handlers.
5. **Compute Receipt** — COSE_Sign1 receipt generation and verification.
6. **Protocol Authorization** — compute invocation authorization checks (actor/role model).
7. **Second TEE Platform** — Intel TDX adapter to prove the abstraction layer works across vendors.

### Phase 3: Multi-Party Compute and Metadata Protection (Level 3)

**Goal:** Cross-tenant computation and metadata confidentiality.

**Deliverables:**
1. **Cross-Tenant Key Delivery** — extend `KeyDeliveryProtocol` for compute-context key sharing.
2. **Multi-Tenant Input Aggregation** — compute worker handles records from multiple tenants inside a single TEE invocation.
3. **Consent Protocol** — each tenant's protocol rules must explicitly authorize cross-tenant compute.
4. **Encrypted Indexes** — index structures sealed to enclave measurement.
5. **Oblivious Query Processing** — encrypted query/response protocol between client and TEE.
6. **Third TEE Platform** — AMD SEV-SNP adapter.

### Phase 4: Ecosystem Maturity

**Goal:** Production hardening, tooling, and ecosystem growth.

**Deliverables:**
1. **Compute Module SDK** — developer toolchain for writing, testing, and debugging WASM compute modules (Rust → WASM, AssemblyScript → WASM, etc.).
2. **Module Registry** — a protocol for publishing and discovering audited compute modules (similar to npm for WASM compute tasks).
3. **Multi-Provider Verification** — client SDK support for submitting deterministic computations to multiple providers and cross-checking results.
4. **Formal Specification** — submit the protocol extensions and attestation format as a DIF (Decentralized Identity Foundation) or W3C specification.
5. **Compliance Mapping** — document how each conformance level maps to regulatory requirements (GDPR, HIPAA, SOC 2, etc.).

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

---

## 14. Comparison with Alternatives

| Approach | Vendor Lock-in | Hardware Trust | Metadata Protection | Arbitrary Compute | Standard |
|---|---|---|---|---|---|
| **This specification** | None (multi-TEE abstraction) | TEE vendor (mitigated by multi-provider) | Yes (Level 3) | Yes (WASM) | EAT, COSE, WASI |
| **FHE-only** | None | None needed | Inherent | Limited (very slow) | Emerging |
| **MPC-only** | None | None needed | Partial | Limited (communication overhead) | Emerging |
| **Single-vendor TEE** | High | Single vendor | Possible | Yes | Proprietary |
| **ZK proofs only** | None | None needed | Inherent | Limited (circuit complexity) | Emerging |
| **Hybrid (TEE + ZK)** | Low | Reduced | Yes | Yes + verifiable | Mixed |

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

### Research

- [Oblix — Efficient Oblivious Search Index](https://people.eecs.berkeley.edu/~raluca/oblix.pdf)
- [CryptDB — Protecting Confidentiality with Encrypted Query Processing](https://people.eecs.berkeley.edu/~raluca/CryptDB-sosp11.pdf)
- [Index Obfuscation for Oblivious Document Retrieval in TEE](https://dl.acm.org/doi/10.1145/3340531.3412035)
- [Enc²DB — Hybrid Encrypted Query Processing](https://link.springer.com/chapter/10.1007/978-981-97-5562-2_4)
- [Veracruz — Privacy-Preserving Collaborative Computation](https://github.com/veracruz-project/veracruz)
