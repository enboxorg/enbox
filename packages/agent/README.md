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
- **Wallet connect** — Enbox Connect approval ceremony granting delegated access to external apps (`executeConnectApproval`)

Durable `grantKey` records hydrate delegate decryption keys for encrypted read grants.
They are usable only while the referenced permission grant is active. Revocation is
observed from the grantee's local DWN state, so enforcement follows delivery or sync
of the revocation record.

## Installation

```bash
bun add @enbox/agent
```

## Usage

```typescript
import { EnboxUserAgent } from '@enbox/agent';

// Create and initialize a new agent
const agent = await EnboxUserAgent.create();
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
| `EnboxUserAgent` | Main agent — composes all sub-APIs into a single runtime |
| `HdIdentityVault` | Seed phrase vault, password-encrypts agent DID as CompactJWE |
| `LocalKeyManager` | In-process key management with HD derivation and ECIES |
| `AgentDwnApi` | DWN message processing, encryption/decryption callbacks |
| `AgentDidApi` | DID creation (`did:dht`, `did:jwk`), resolution, import/export |
| `AgentIdentityApi` | Identity CRUD (DID + metadata) |
| `AgentPermissionsApi` | Permission grant/request/revocation management |
| `SyncEngineLevel` | LevelDB-backed bidirectional sync engine from `@enbox/agent/level` |
| `DwnKeyStore` | Encrypted private key storage in DWN |
| `DwnDidStore` | DID storage in DWN |
| `DwnIdentityStore` | Identity metadata storage in DWN |
| `PlatformAgentTestHarness` | Test infrastructure from `@enbox/agent/test` |

## Browser Runtime

`@enbox/agent` is isomorphic. Its root export declares a browser condition that
points browser-aware bundlers at `dist/browser.mjs`, so apps and service workers
do not need Node global shims for the package entrypoint.

The default persistent stores are still Level-backed. In Node, `level` uses
`classic-level` on the filesystem. In browsers, it resolves to `browser-level`
over IndexedDB. That IndexedDB-backed Level stack is intentional: multiple app
tabs, workers, and service workers can open and write the same origin database
concurrently, with the browser coordinating transactions.

Use injected agent components only when you are deliberately replacing part of
the runtime. Avoid in-memory stores for production browser apps, because they
lose persistence and cross-context write coordination.

Direct access to Level-backed implementation classes lives under
`@enbox/agent/level`; test utilities live under `@enbox/agent/test`. Keeping
those modules off the root export prevents bare browser imports from resolving
the Level stack before an agent is actually created.

## Development

```bash
# Build (rebuild dwn-sdk-js first if it changed)
bun run --filter @enbox/dwn-sdk-js build
bun run --filter @enbox/agent build

# Start test infrastructure (Pkarr relay, Postgres, MySQL, NATS) from repo root
docker compose -f docker-compose.test.yaml up -d --wait
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DID_DHT_ALLOW_PRIVATE_GATEWAY=1

# Full agent test suite (bun:test)
bun run test:node

# Single test file
bun test tests/store-key.spec.ts

# Filter by test name
bun test tests/dwn-api.spec.ts -t 'AgentDwnApi.drainPendingEagerSends'

# Lint (from repo root)
bun run lint
```

Tests use the native `bun test` runner (see `bun:test` + `sinon` in each spec file).
`PlatformAgentTestHarness.clearStorage()` and `closeStorage()` drain any in-flight
eager-send coroutines before releasing storage, so downstream consumers can safely
tear down between tests without `LEVEL_DATABASE_NOT_OPEN` noise.

## License

Apache-2.0
