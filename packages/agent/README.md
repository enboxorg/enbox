# Enbox Agent

> **Research Preview** — Enbox is under active development. APIs may change without notice.

[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/agent.json)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)

The agent framework for decentralized identity management — handles identities, keys, DWN storage, sync, and wallet connect.

## Overview

The agent is the core runtime that ties everything together. It manages:

- **Identity vault** — BIP-39 seed phrase + password-encrypted agent DID (`HdIdentityVault`)
- **Key management** — In-process key generation, import/export, HD derivation, ECIES decryption (`LocalKeyManager`)
- **DWN operations** — Read/write/query records, protocol installation, encryption callbacks (`AgentDwnApi`)
- **Identity lifecycle** — Create, list, import/export identities and DIDs (`AgentIdentityApi`, `AgentDidApi`)
- **Sync** — Bidirectional sync between local and remote DWNs (`SyncEngineLevel`)
- **Permissions** — DWN permission grants, requests, and revocations (`AgentPermissionsApi`)
- **Wallet connect** — OIDC/SIOPv2-based connection flow for external wallets (`WalletConnect`, `Oidc`)

## Installation

```bash
bun add @enbox/agent
```

## Usage

```typescript
import { Web5UserAgent } from '@enbox/agent';

// Create and initialize a new agent
const agent = await Web5UserAgent.create();
await agent.initialize({ password: 'user-password' });
await agent.start({ password: 'user-password' });

// Create an identity
const identity = await agent.identity.create({
  didMethod : 'dht',
  metadata  : { name: 'Alice' },
});

// Store a record in the agent's local DWN
const response = await agent.dwn.processRequest({
  author      : identity.did.uri,
  target      : identity.did.uri,
  messageType : DwnInterface.RecordsWrite,
  messageParams : {
    dataFormat : 'application/json',
  },
  dataStream : new Blob([JSON.stringify({ hello: 'world' })]),
});

// Sync with remote DWN(s)
await agent.sync.sync();
```

## Key Classes

| Class | Purpose |
|---|---|
| `Web5UserAgent` | Main agent — composes all sub-APIs into a single runtime |
| `HdIdentityVault` | Seed phrase vault, password-encrypts agent DID as CompactJWE |
| `LocalKeyManager` | In-process key management with HD derivation and ECIES |
| `AgentDwnApi` | DWN message processing, encryption/decryption callbacks |
| `AgentDidApi` | DID creation (`did:dht`, `did:jwk`), resolution, import/export |
| `AgentIdentityApi` | Identity CRUD (DID + metadata) |
| `AgentPermissionsApi` | Permission grant/request/revocation management |
| `SyncEngineLevel` | LevelDB-backed bidirectional sync engine |
| `DwnKeyStore` | Encrypted private key storage in DWN |
| `DwnDidStore` | DID storage in DWN |
| `DwnIdentityStore` | Identity metadata storage in DWN |
| `PlatformAgentTestHarness` | Test infrastructure (exported for downstream consumers) |

## Development

```bash
# Build
bun run build

# Test (Mocha + Chai, NOT bun test)
bun run test:node

# Single test file
bun run build:tests:node && bunx mocha --spec 'tests/compiled/tests/store-key.spec.js' --timeout 30000 --exit

# Lint
bun run lint
```

## License

Apache-2.0
