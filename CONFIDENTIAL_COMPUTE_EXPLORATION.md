# Confidential Compute for Enbox DWN Platform

## Exploration Document

**Date:** 2026-02-22
**Status:** Exploration / RFC Draft

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Current Enbox Architecture](#2-current-enbox-architecture)
3. [Landscape Survey](#3-landscape-survey)
   - [OpenSecret](#31-opensecret)
   - [ArkadeOS](#32-arkadeos)
   - [Other Projects](#33-other-projects)
4. [Design Space](#4-design-space)
5. [Proposed Model: Protocol-Governed Confidential Compute](#5-proposed-model-protocol-governed-confidential-compute)
6. [Architecture](#6-architecture)
7. [Protocol Extensions](#7-protocol-extensions)
8. [Trust Model and Attestation](#8-trust-model-and-attestation)
9. [Implementation Phases](#9-implementation-phases)
10. [Open Questions](#10-open-questions)

---

## 1. Motivation

Decentralized Web Nodes (DWNs) store data and provide a multi-party authorization platform built on cryptographic primitives (DIDs, JWE encryption, protocol-based access control). However, the current model assumes that data is either:

1. **Stored encrypted** and decrypted by the data owner's client, or
2. **Processed in the clear** by the node operator.

There is a class of applications that needs a third option: **compute over private data without exposing it to the node operator or any unauthorized party**. Examples include:

- **AI inference on private records** -- health data analysis, financial modeling, personal assistant processing
- **Multi-party aggregation** -- analytics across records from multiple tenants without revealing individual data
- **Derived credential issuance** -- computing attestations (e.g., "income > threshold") from private records
- **Cross-tenant joins** -- matching records across parties (supply chain, marketplace) without exposing raw data
- **Automated protocol actions** -- triggering writes, role grants, or key delivery based on computation over encrypted records

The DWN protocol system already defines rules for who can read, write, and update records. A natural extension is to allow protocols to define rules for **computation** -- what code can run, over which records, with what attestation guarantees, and where results are written.

---

## 2. Current Enbox Architecture

### 2.1 Two-Layer Encryption

The enbox agent implements a two-layer encryption model:

**Layer 1 -- Vault (`HdIdentityVault`):**
- BIP-39 seed phrase derives HD keys deterministically
- Password encrypts the agent's `PortableDid` as CompactJWE (AES-256-GCM via PBKDF2)
- Stored in `VAULT_STORE` LevelDB
- Recovery: seed phrase -> agent DID (deterministic) -> `#enc` key -> decrypt records

**Layer 2 -- DWN Record-Level (`DwnKeyStore`):**
- Protocol types with `encryptionRequired: true` are encrypted using JWE
- Key agreement: ECDH-ES+A256KW with the tenant's X25519 `#enc` verification method
- Content encryption: AES-256-GCM or XChaCha20-Poly1305
- The `$encryption` block is derived and injected into the protocol definition at install time
- If the tenant DID lacks an X25519 keyAgreement key, installation fails -- no plaintext fallback

### 2.2 Protocol Authorization Model

Protocols define a hierarchical rule system (`ProtocolRuleSet`) governing access:

- **Actors:** `anyone`, `author`, `recipient`
- **Roles:** Protocol-defined roles (`$role: true`) that grant scoped capabilities
- **Actions:** `create`, `read`, `update`, `delete`, `co-update`, `co-delete`, `prune`, `co-prune`
- **Protocol paths:** Hierarchical record structure (e.g., `thread/message/reaction`)
- **Tags:** Constrained metadata on records (`$tags` with JSON Schema validation)
- **Size limits:** `$size` constraints on record data
- **Record limits:** `$recordLimit` with strategies (`reject`, `purgeOldest`)
- **Cross-protocol composition:** `uses` + `$ref` for referencing types across protocols

### 2.3 Multi-Party Key Delivery

When encrypted records involve multiple participants (e.g., author writes to recipient's DWN), the `KeyDeliveryProtocol` distributes context encryption keys:

- Participant detection via `detectNewParticipants()`
- Context keys wrapped per-recipient using their X25519 public key
- Delivered via `RecordsWrite` to the `KeyDeliveryProtocol`
- Recipients use `getKeyDecrypter()` to unwrap and decrypt records

### 2.4 Agent/Tenant Architecture

- **Agent DID** (`agent.agentDid`): The agent's own identity (typically `did:dht` with `#sig` Ed25519 + `#enc` X25519)
- **Tenant DID**: The context for store operations; multi-tenancy via `getDataStoreTenant()`
- **Store keys**: Use `TENANT_SEPARATOR` (`^`) for per-tenant isolation
- **DWN Data Stores**: Protocol-backed storage (`DwnDataStore<T>`) with encryption support inherited by `DwnKeyStore`, `DwnDidStore`, `DwnIdentityStore`

### 2.5 What Is Missing

The current architecture has no concept of:

1. **Compute authorization** -- protocols cannot declare what computation is allowed
2. **Attestation** -- no mechanism for a remote party to verify a node is enforcing protocol rules
3. **Sealed execution** -- no way to process encrypted data without exposing it to the operator
4. **Compute result provenance** -- no way to cryptographically prove a result was derived from specific inputs via specific code

---

## 3. Landscape Survey

### 3.1 OpenSecret

**What it is:** An open-source confidential computing developer platform (Rust, AGPL-3.0) that provides a backend-as-a-service where encryption is on by default. Built on AWS Nitro Enclaves (CPU TEE) chained with NVIDIA GPU TEEs for AI inference.

**Key architectural ideas relevant to enbox:**

| Concept | OpenSecret Approach | Enbox Relevance |
|---|---|---|
| **Two-layer TEE** | Nitro Enclave (CPU) chains to NVIDIA GPU TEE via re-encryption handoff | DWN node could run protocol engine in CPU TEE, delegate compute to GPU TEE |
| **vsock isolation** | Enclave has no network, only vsock to parent host | DWN server already separates HTTP/WS transport from protocol engine -- natural split point |
| **Encrypted blob storage** | DB stores only ciphertext; decryption only in TEE | Maps to `encryptionRequired: true` with TEE-enforced decryption |
| **Per-user key derivation** | BIP-85/BIP-32 inside enclave; key never leaves TEE | Parallel to `HdIdentityVault` seed -> per-tenant keys, but hardware-isolated |
| **Reproducible builds** | NixOS flakes produce deterministic enclave images; PCR0 hash verifiable | Could verify DWN node binary via attestation document |
| **Remote attestation** | PCR values (CBOR/COSE, P-384) verified by client SDK | Missing piece for DWN: clients could verify node integrity before sending records |
| **Chained compute** | CPU TEE decrypts, re-encrypts for GPU TEE, results flow back | Pattern for confidential compute over DWN records |

**Key takeaway:** OpenSecret demonstrates a production-grade pattern for moving key management into hardware isolation while keeping the programming model simple (React hooks, key-value API). The chained TEE approach is directly applicable to running computation over encrypted DWN records.

**Trust model tension:** OpenSecret assumes a centralized operator model (the operator runs the enclaves, users trust the operator + hardware). DWN is decentralized and multi-tenant. A confidential DWN layer would need to make attestation a per-connection protocol requirement.

### 3.2 ArkadeOS

**What it is:** A Bitcoin-native Layer 2 execution platform (Go server, TypeScript/Rust SDKs) built on the Ark protocol. Uses TEEs specifically for its **Signer** module -- the cosigning component that holds the operator's private key.

**Key architectural ideas relevant to enbox:**

| Concept | ArkadeOS Approach | Enbox Relevance |
|---|---|---|
| **Narrow TEE scope** | TEE protects only the Signer (one key, one operation) | Could apply TEE narrowly: just `DwnKeyStore` decryption and `HdIdentityVault` |
| **Separate service** | Signer deployed as separate service via `ARKD_SIGNER_ADDR` | DWN could delegate key operations to a TEE signer service |
| **E2E to enclave** | User-to-Signer encryption; operator cannot intercept | Protect `RecordsWrite` payloads from node operator in transit |
| **FROST roadmap** | k-of-n threshold Schnorr signing via distributed key generation | Distribute agent DID `#sig` and `#enc` keys across threshold signers |
| **TEE as optimization** | JWE record encryption is the hard security boundary; TEE adds defense-in-depth | Correct posture: DWN encryption remains primary, TEE provides processing confidentiality |

**Key takeaway:** ArkadeOS validates the "narrow trust anchor" pattern -- use TEE for the minimal critical path (key operations), not the entire system. The separate-service deployment pattern (`SIGNER_ADDR`) maps directly to a DWN key management service. The FROST threshold key approach could eliminate single-point-of-failure for agent DID keys.

**Limitation:** ArkadeOS solves a simpler problem (key isolation for signing) than DWN needs (full data lifecycle confidentiality across a multi-tenant, protocol-governed store).

### 3.3 Other Projects

#### TEE Frameworks

| Project | Approach | Relevance to DWN |
|---|---|---|
| **Gramine** | LibOS that runs unmodified Linux apps in Intel SGX/TDX enclaves | Could run the DWN server (Node.js/Bun) inside SGX without code changes |
| **Enarx** (Profian) | WASM runtime inside TEEs (SGX, SEV-SNP, TrustZone); hardware-agnostic | Run compute tasks as WASM modules inside TEEs; natural fit for portable compute definitions |
| **EGo** | Go framework for Intel SGX with familiar Go tooling | Relevant if DWN components were in Go; less relevant for the Bun/TS stack |

#### WASM-in-TEE (Most Relevant Pattern)

The combination of **WASM + TEE** is the most promising pattern for DWN confidential compute:

- **WASM provides:** Sandboxed execution, deterministic computation, portable bytecode, capability-based security
- **TEE provides:** Hardware-isolated memory, attestation, sealed storage
- **Together:** A compute task defined as a WASM module can run inside a TEE, producing attested results over encrypted inputs

**Veracruz** (ARM Research) implements exactly this pattern: a framework for privacy-preserving collaborative computation where multiple parties contribute encrypted data, a WASM program runs inside a TEE, and only the designated result recipient can decrypt the output. Veracruz uses a **policy file** that declares:
- Which parties can contribute data
- What WASM program will execute
- Who receives the result
- What TEE platform is required

This policy-file approach maps remarkably well onto DWN protocol definitions.

#### Decentralized Confidential Compute Networks

| Project | Approach | Relevance |
|---|---|---|
| **Secret Network** | Privacy-preserving smart contracts using Intel SGX; encrypted inputs/outputs/state | Demonstrates protocol-level encryption enforcement in a decentralized setting |
| **Oasis Network** | Confidential smart contracts in TEE-backed "ParaTimes"; separates consensus from compute | Layered architecture parallels DWN separating storage/auth from computation |
| **Phala Network** | Off-chain TEE workers; fat contracts with persistent encrypted state | Worker pool model for scaling confidential compute separate from storage |
| **Lit Protocol** | Decentralized key management + programmable signing; threshold cryptography | "Lit Actions" (JS in TEE) model: programmable conditions for key release and signing |
| **Nillion** | Blind compute via MPC; data never decrypted, computation on secret shares | Alternative to TEE: multi-party computation without hardware trust assumptions |
| **iExec** | Decentralized marketplace for confidential computing; TEE-based task execution | Task marketplace model: define compute tasks, match with TEE workers, verify results |

#### Cryptographic Compute (No Hardware Trust)

| Approach | Projects | Trade-offs |
|---|---|---|
| **Fully Homomorphic Encryption (FHE)** | TFHE-rs, OpenFHE, Concrete (Zama) | Compute on ciphertext without decryption; very slow for complex operations; improving rapidly |
| **Multi-Party Computation (MPC)** | MP-SPDZ, Sharemind, Nillion | Split data into shares across parties; no single party sees plaintext; communication overhead |
| **Zero-Knowledge Proofs** | circom/snarkjs, Halo2, RISC Zero | Prove computation correctness without revealing inputs; useful for result verification |

---

## 4. Design Space

Based on the survey, there are four distinct approaches to confidential compute for DWN, each with different trust assumptions and trade-offs:

### Approach A: TEE-Wrapped DWN Node

Run the entire DWN server inside a TEE (like Gramine + SGX or Nitro Enclave). The node operator never sees plaintext.

```
Client -> [HTTPS] -> Host Proxy -> [vsock] -> TEE { DWN Server + DB }
```

**Pros:** Simplest model; existing code runs unmodified; operator provably cannot access data.
**Cons:** Large TCB (trusted computing base); performance overhead; vendor lock-in to specific TEE; single TEE instance limits scalability.

### Approach B: TEE Key Service (Narrow Enclave)

Run only the key management operations (`HdIdentityVault`, `DwnKeyStore` decryption, ECDH-ES+A256KW unwrapping) inside a TEE, similar to ArkadeOS's Signer pattern.

```
Client -> DWN Server -> TEE Key Service (decrypt, sign, derive)
                     -> Encrypted Storage
```

**Pros:** Small TCB; easy to deploy; compatible with existing architecture.
**Cons:** Does not protect data during query processing or compute; operator can observe plaintext after decryption in main process.

### Approach C: WASM-in-TEE Compute Tasks

Define compute tasks as WASM modules. Protocol definitions declare which compute tasks can run over which record types. Tasks execute inside a TEE with attested results.

```
Client -> DWN Server -> Encrypted Storage
                     -> TEE Compute Worker { WASM Runtime }
                        - Receives encrypted records
                        - Decrypts inside TEE
                        - Executes WASM compute task
                        - Encrypts result
                        - Writes result back as DWN record
```

**Pros:** Flexible; portable; attestable; compute tasks are versioned and auditable; maps naturally onto protocol definitions.
**Cons:** More complex; requires WASM compilation toolchain; new protocol primitives needed.

### Approach D: Cryptographic Compute (FHE/MPC/ZK)

Use purely cryptographic approaches -- no hardware trust required.

**Pros:** No hardware trust assumptions; mathematically provable; decentralized.
**Cons:** Performance limitations (FHE is orders of magnitude slower); limited expressiveness; complex key management; not production-ready for general compute.

### Recommended: Layered Approach (B + C)

Combine a **narrow TEE key service** (Approach B) as the foundation with **WASM-in-TEE compute tasks** (Approach C) for application-specific computation, governed by **protocol extensions** that define compute rules.

This layered approach:
- Protects keys at rest (TEE key service)
- Enables compute over encrypted data (WASM tasks in TEE)
- Uses protocol definitions to govern what compute is allowed
- Keeps JWE record encryption as the hard security boundary (defense-in-depth)
- Allows incremental adoption (start with B, add C as needed)

---

## 5. Proposed Model: Protocol-Governed Confidential Compute

### Core Concept

Extend DWN protocol definitions with a `$compute` directive that declares:
1. **What WASM modules** are authorized to process records at this protocol path
2. **What inputs** the module can access (which record types, from which actors)
3. **What outputs** the module produces (where results are written)
4. **What attestation** is required for the compute environment
5. **Who can trigger** the computation (actors/roles)

The compute task itself is stored as a DWN record (WASM bytecode), making it versioned, auditable, and subject to the same protocol authorization rules as any other record.

### Design Principles

1. **Protocol-first:** Compute rules are part of the protocol definition, not bolted on. Authorization for compute follows the same actor/role model as read/write.
2. **Records in, records out:** Compute tasks consume DWN records as input and produce DWN records as output. The DWN remains the single source of truth.
3. **Attestation-gated:** Clients and protocols can require TEE attestation before authorizing compute. The attestation document proves which WASM module ran in which environment.
4. **Defense-in-depth:** JWE record encryption remains the primary security boundary. TEE provides confidentiality during processing. Compromising the TEE still leaves records encrypted.
5. **Portable compute definitions:** WASM modules are hardware-agnostic. The TEE platform is an implementation detail, not a protocol requirement. Protocols declare attestation requirements, not specific hardware.

---

## 6. Architecture

### 6.1 Component Overview

```
                                    DWN Protocol Engine
                                   ┌────────────────────┐
                                   │                    │
 Client ──── HTTPS/WS ────────────▶│  Authorization     │
                                   │  Message Handling   │
                                   │  Record Storage     │
                                   │                    │
                                   └────────┬───────────┘
                                            │
                              ┌─────────────┼─────────────┐
                              ▼             ▼             ▼
                    ┌──────────────┐ ┌───────────┐ ┌─────────────────┐
                    │ Encrypted    │ │ TEE Key   │ │ TEE Compute     │
                    │ Storage      │ │ Service   │ │ Workers         │
                    │ (Postgres/   │ │           │ │                 │
                    │  LevelDB)    │ │ - Vault   │ │ - WASM Runtime  │
                    │              │ │ - KDF     │ │ - Record I/O    │
                    │              │ │ - ECDH    │ │ - Attestation   │
                    └──────────────┘ └───────────┘ └─────────────────┘
```

### 6.2 TEE Key Service

The TEE Key Service wraps the existing `HdIdentityVault` and key derivation operations:

| Current Component | TEE-Protected Equivalent |
|---|---|
| `HdIdentityVault` (seed phrase, PBKDF2) | Seed held in TEE memory; never leaves enclave |
| `DwnKeyStore` (JWE decrypt of private keys) | ECDH-ES+A256KW unwrap happens inside TEE |
| `getEncryptionKeyDeriver()` | Key derivation inside TEE; derived keys never leave |
| `getKeyDecrypter()` | Decryption inside TEE; plaintext returned only to authorized callers inside TEE |

**Interface** (deployed as separate service, similar to ArkadeOS `SIGNER_ADDR`):

```typescript
interface TeeKeyService {
  /** Decrypt a JWE-encrypted record using the tenant's #enc key. Returns plaintext inside TEE only. */
  decrypt(params: { tenantDid: string; jwe: GeneralJwe }): Promise<Uint8Array>;

  /** Derive a context encryption key for a protocol path. */
  deriveContextKey(params: { tenantDid: string; protocolPath: string }): Promise<DerivedPrivateJwk>;

  /** Sign a message using the tenant's #sig key. */
  sign(params: { tenantDid: string; payload: Uint8Array }): Promise<Uint8Array>;

  /** Get the attestation document for this TEE instance. */
  getAttestation(): Promise<AttestationDocument>;
}
```

### 6.3 TEE Compute Workers

Compute workers execute WASM modules inside a TEE:

```
┌─────────────────────────────────────────────────┐
│  TEE Boundary                                   │
│                                                 │
│  ┌──────────────┐    ┌─────────────────────┐    │
│  │ Record       │    │ WASM Runtime        │    │
│  │ Decryptor    │───▶│                     │    │
│  │              │    │ - Sandboxed module   │    │
│  │ (uses TEE    │    │ - Capability imports │    │
│  │  Key Service)│    │ - Deterministic exec │    │
│  └──────────────┘    └──────────┬──────────┘    │
│                                 │               │
│                      ┌──────────▼──────────┐    │
│                      │ Result Encryptor    │    │
│                      │                     │    │
│                      │ - Encrypt output    │    │
│                      │ - Generate receipt  │    │
│                      │ - Sign attestation  │    │
│                      └─────────────────────┘    │
│                                                 │
└─────────────────────────────────────────────────┘
```

**Execution flow:**

1. DWN protocol engine authorizes a `ComputeInvoke` message
2. Engine fetches the WASM module record and input records
3. Encrypted records + WASM bytecode sent to a Compute Worker
4. Worker decrypts records inside TEE (via TEE Key Service)
5. Worker instantiates WASM module with imported capabilities:
   - `read_record(protocol_path, record_id)` -- read decrypted record data
   - `query_records(protocol_path, filter)` -- query matching records
   - `write_result(protocol_path, data)` -- buffer an output record
6. WASM module executes, producing output records
7. Worker encrypts outputs, generates an attestation receipt
8. Encrypted results + receipt written back to the DWN as records

### 6.4 Compute Receipt

Every compute execution produces a **Compute Receipt** -- a signed attestation that binds:

```typescript
type ComputeReceipt = {
  /** Hash of the WASM module that executed. */
  moduleHash: string;

  /** CIDs of input records consumed. */
  inputRecordCids: string[];

  /** CIDs of output records produced. */
  outputRecordCids: string[];

  /** TEE attestation document (CBOR/COSE). */
  attestation: Uint8Array;

  /** Timestamp of execution. */
  executedAt: string;

  /** DID of the tenant that authorized the compute. */
  tenantDid: string;

  /** DID of the compute worker. */
  workerDid: string;
};
```

The receipt is itself stored as a DWN record, creating an auditable chain: input records -> compute module -> attestation -> output records.

---

## 7. Protocol Extensions

### 7.1 `$compute` Directive

A new directive in `ProtocolRuleSet` that declares compute rules for a protocol path:

```typescript
type ProtocolComputeDefinition = {
  /** URI identifying the WASM compute module (stored as a DWN record). */
  module: string;

  /** Protocol paths of records this module can read as input. */
  inputs: string[];

  /** Protocol path where results are written. */
  outputPath: string;

  /** Attestation requirements for the compute environment. */
  attestation?: {
    /** Required TEE type(s). */
    teeTypes?: ('nitro' | 'sgx' | 'sev-snp' | 'tdx' | 'trustzone')[];

    /** Minimum acceptable PCR/measurement values. */
    measurements?: Record<string, string>;

    /** Whether reproducible build verification is required. */
    reproducibleBuild?: boolean;
  };
};
```

### 7.2 Example: Private Health Data Analysis

```typescript
const HealthProtocol: ProtocolDefinition = {
  protocol  : 'https://example.com/health',
  published : false,
  types     : {
    record: {
      schema             : 'https://example.com/schemas/health-record',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    analysis: {
      schema             : 'https://example.com/schemas/health-analysis',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    computeModule: {
      dataFormats : ['application/wasm'],
    },
    computeReceipt: {
      schema      : 'https://example.com/schemas/compute-receipt',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    record: {
      $actions: [
        { who: 'author', of: 'record', can: ['create', 'read', 'update'] },
      ],
    },
    computeModule: {
      $actions: [
        { who: 'author', of: 'computeModule', can: ['create', 'read'] },
      ],
    },
    analysis: {
      $actions: [
        { who: 'author', of: 'record', can: ['read'] },
      ],
      $compute: {
        module     : 'computeModule',
        inputs     : ['record'],
        outputPath : 'analysis',
        attestation: {
          teeTypes          : ['nitro', 'sgx'],
          reproducibleBuild : true,
        },
      },
    },
    computeReceipt: {
      $actions: [
        { who: 'author', of: 'record', can: ['read'] },
      ],
    },
  },
};
```

### 7.3 Example: Multi-Party Credential Derivation

```typescript
const IncomeVerificationProtocol: ProtocolDefinition = {
  protocol  : 'https://example.com/income-verification',
  published : true,
  types     : {
    incomeRecord: {
      schema             : 'https://example.com/schemas/income',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    verificationRequest: {
      schema      : 'https://example.com/schemas/verification-request',
      dataFormats : ['application/json'],
    },
    verificationResult: {
      schema             : 'https://example.com/schemas/verification-result',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    verifier: {
      dataFormats : ['application/json'],
    },
  },
  structure: {
    incomeRecord: {
      $actions: [
        { who: 'author', of: 'incomeRecord', can: ['create', 'read'] },
      ],
    },
    verifier: {
      $role    : true,
      $actions : [
        { who: 'author', of: 'incomeRecord', can: ['create'] },
      ],
    },
    verificationRequest: {
      $actions: [
        { role: 'verifier', can: ['create'] },
      ],
      verificationResult: {
        $actions: [
          { who: 'author', of: 'incomeRecord', can: ['read'] },
          { role: 'verifier', can: ['read'] },
        ],
        $compute: {
          module     : 'income-threshold-check',
          inputs     : ['incomeRecord'],
          outputPath : 'verificationRequest/verificationResult',
          attestation: {
            teeTypes          : ['nitro'],
            reproducibleBuild : true,
          },
        },
      },
    },
  },
};
```

In this example, a verifier (e.g., a lender) requests income verification. The compute module reads encrypted income records, checks if income exceeds a threshold, and produces a boolean result -- all without the verifier ever seeing the actual income data. The `computeReceipt` proves the result was computed correctly inside an attested TEE.

### 7.4 New DWN Message Types

```typescript
/** Request to execute a compute task. */
type ComputeInvoke = {
  interface    : 'Compute';
  method       : 'Invoke';
  protocol     : string;
  protocolPath : string;
  moduleRecordId : string;
  inputFilter  : RecordsFilter;
  /** Optional parameters passed to the WASM module. */
  params?      : Record<string, unknown>;
};

/** Result of a compute invocation. */
type ComputeResult = {
  interface       : 'Compute';
  method          : 'Result';
  invokeMessageId : string;
  outputRecordIds : string[];
  receiptRecordId : string;
  status          : { code: number; detail: string };
};

/** Query compute receipts. */
type ComputeQuery = {
  interface : 'Compute';
  method    : 'Query';
  filter    : {
    moduleHash?    : string;
    tenantDid?     : string;
    dateRange?     : { from: string; to: string };
  };
};
```

---

## 8. Trust Model and Attestation

### 8.1 Trust Layers

```
┌─────────────────────────────────────────────────────────┐
│ Layer 4: Application Trust                              │
│   Protocol definitions, WASM module audits,             │
│   compute receipts, result verification                 │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Attestation Trust                              │
│   TEE attestation documents, PCR verification,          │
│   reproducible builds, measurement chains               │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Cryptographic Trust                            │
│   DID resolution, JWE encryption, ECDH-ES key          │
│   agreement, Ed25519 signatures                         │
├─────────────────────────────────────────────────────────┤
│ Layer 1: Hardware Trust                                 │
│   TEE hardware (Nitro, SGX, SEV-SNP, TDX),             │
│   vendor attestation PKI                                │
└─────────────────────────────────────────────────────────┘
```

### 8.2 Attestation in the DWN Protocol

A DWN node running inside a TEE can advertise its attestation capabilities via its DID document's service endpoints:

```json
{
  "id": "did:dht:abc123#dwn",
  "type": "DecentralizedWebNode",
  "serviceEndpoint": {
    "nodes": ["https://dwn.example.com"],
    "attestation": {
      "teeType": "nitro",
      "attestationEndpoint": "https://dwn.example.com/attestation",
      "pcr0": "sha384:abc123..."
    }
  }
}
```

Clients verify attestation before sending encrypted records:

1. Resolve the target DID's service endpoints
2. Fetch attestation document from the attestation endpoint
3. Verify the attestation chain (vendor PKI -> attestation document -> PCR values)
4. Compare PCR0 against known-good values (published by the DWN software project)
5. Establish encrypted session with the attested enclave
6. Send `RecordsWrite` / `ComputeInvoke` messages

### 8.3 Attestation-Gated Protocol Actions

Protocols could require attestation for specific actions:

```typescript
{
  $actions: [
    {
      who  : 'anyone',
      can  : ['create'],
      // New: require the receiving node to present valid attestation
      requireAttestation: {
        teeTypes          : ['nitro', 'sgx'],
        reproducibleBuild : true,
      },
    },
  ],
}
```

This allows a protocol author to enforce that sensitive records can only be written to nodes that prove they are running audited, TEE-protected DWN software.

---

## 9. Implementation Phases

### Phase 1: TEE Key Service

**Goal:** Protect the agent's key material in hardware isolation.

- Wrap `HdIdentityVault` seed phrase operations in a TEE
- Implement TEE Key Service interface (decrypt, derive, sign, attest)
- Deploy as a separate service (like ArkadeOS `SIGNER_ADDR`)
- Add attestation endpoint to DWN server
- No protocol changes required; transparent to existing clients

**TEE Target:** AWS Nitro Enclaves (production), simulated enclave (development/testing)

### Phase 2: Attestation Protocol

**Goal:** Allow clients and protocols to verify DWN node integrity.

- Define attestation document format for DWN nodes
- Add attestation verification to agent SDK (`@enbox/agent`)
- Extend DID document service endpoints with attestation metadata
- Add `requireAttestation` to `ProtocolActionRule`
- Implement PCR verification against published known-good values
- Support reproducible builds for DWN server and TEE Key Service

### Phase 3: WASM Compute Tasks

**Goal:** Enable protocol-governed computation over encrypted records.

- Implement WASM runtime inside TEE (using `wasm-micro-runtime` or `wasmtime`)
- Define WASM host imports (record read, query, write)
- Add `$compute` directive to protocol types
- Implement `ComputeInvoke`, `ComputeResult`, `ComputeQuery` message types
- Implement compute receipt generation and verification
- Add protocol authorization for compute invocations

### Phase 4: Multi-Party Confidential Compute

**Goal:** Enable computation across records from multiple tenants.

- Extend key delivery protocol for compute-context key sharing
- Implement multi-tenant input aggregation in compute workers
- Add cross-tenant compute authorization rules
- Explore FROST threshold keys for distributed agent DIDs
- Investigate MPC/FHE for specific use cases where hardware trust is unacceptable

---

## 10. Open Questions

### Architecture

1. **TEE Platform Selection:** AWS Nitro is the most production-ready, but creates vendor lock-in. Should we target multiple TEE platforms from the start, or focus on one and abstract later?

2. **WASM Runtime:** Which WASM runtime for the TEE? Options: `wasmtime` (mature, Rust), `wasm-micro-runtime` (lightweight, C), `wasmer` (polyglot). The runtime must support WASI for basic I/O and be compilable for the TEE environment.

3. **Compute Worker Deployment:** Should compute workers be co-located with DWN nodes, or run as a separate pool? A pool model (like Phala Network's workers) enables resource sharing but adds latency.

4. **State Between Invocations:** Should compute tasks have persistent state (like Secret Network's encrypted contract state), or be purely functional (stateless, records in -> records out)?

### Protocol Design

5. **Compute Module Versioning:** How are WASM modules updated? Should the protocol definition pin a specific module hash, or allow any module matching a schema?

6. **Compute Authorization Granularity:** Can a single compute invocation read records from multiple protocol paths? Multiple protocols?

7. **Result Determinism:** Should compute results be deterministic (same inputs always produce same outputs)? This enables verification by re-execution but limits what compute tasks can do (no randomness, no external calls).

8. **Compute Costs:** How are compute resources metered and paid for? The DWN protocol currently has no concept of resource accounting.

### Trust Model

9. **Attestation Freshness:** How often should attestation be re-verified? Every message? Per session? Per connection?

10. **Hardware Trust Dependency:** TEE security depends on hardware vendor trust. Should we pursue hybrid models (TEE + ZK proofs) to reduce this dependency?

11. **Threshold Keys vs. Single Enclave:** Is FROST-based distributed key management preferable to single-enclave key storage? FROST removes the single point of hardware trust but adds protocol complexity.

12. **Operator Incentives:** In a decentralized network, why would a node operator invest in TEE hardware? What incentive structures encourage confidential compute adoption?

### Practical Concerns

13. **Development Experience:** How do developers write and test WASM compute modules? What toolchain, what testing framework, what debugging story?

14. **Performance:** What is the overhead of TEE decryption + WASM execution + re-encryption for typical DWN workloads? Are there workloads where the overhead is prohibitive?

15. **Existing Ecosystem Compatibility:** Can existing DWN clients and protocols continue to work unchanged alongside confidential compute extensions?

---

## References

### Primary Research

- [OpenSecret](https://github.com/OpenSecretCloud) -- Open-source confidential computing platform (Rust, AWS Nitro + NVIDIA GPU TEE)
- [ArkadeOS](https://github.com/arkade-os/) -- Bitcoin L2 with TEE-isolated signer (Go, TEE key service pattern)

### TEE Frameworks

- [Gramine](https://gramineproject.io/) -- LibOS for running unmodified Linux apps in SGX
- [Enarx](https://enarx.dev/) -- Hardware-agnostic WASM-in-TEE runtime
- [Veracruz](https://github.com/veracruz-project/veracruz) -- Privacy-preserving collaborative computation (ARM Research)

### Decentralized Confidential Compute

- [Secret Network](https://scrt.network/) -- Privacy-preserving smart contracts (SGX)
- [Oasis Network](https://oasisprotocol.org/) -- Confidential ParaTimes
- [Phala Network](https://phala.network/) -- Off-chain TEE compute workers
- [Lit Protocol](https://litprotocol.com/) -- Decentralized key management and programmable signing
- [Nillion](https://nillion.com/) -- Blind compute via MPC
- [iExec](https://iex.ec/) -- Decentralized confidential computing marketplace

### Cryptographic Compute

- [TFHE-rs](https://github.com/zama-ai/tfhe-rs) -- Fully homomorphic encryption (Rust)
- [RISC Zero](https://risczero.com/) -- Zero-knowledge virtual machine for verifiable compute
- [MP-SPDZ](https://github.com/data61/MP-SPDZ) -- Multi-party computation framework

### Standards

- [AWS Nitro Enclaves Attestation](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html)
- [COSE (RFC 9052)](https://www.rfc-editor.org/rfc/rfc9052) -- CBOR Object Signing and Encryption
- [WASI](https://wasi.dev/) -- WebAssembly System Interface
