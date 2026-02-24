# Enbox

A toolkit for decentralized identity and encrypted personal data storage.

[![CI](https://img.shields.io/github/actions/workflow/status/enboxorg/enbox/ci.yml?branch=main&label=ci)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@enbox/api.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun_%E2%89%A5%201.0-f9f1e1?logo=bun)](https://bun.sh)

> **Research Preview** -- This project is under heavy development. Expect frequent breaking changes. APIs, protocols, and storage formats are not yet stable. We do not yet offer community support channels or guaranteed backwards compatibility.

---

- [Why Enbox?](#why-enbox)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Packages](#packages)
- [Testing](#testing)
- [Development](#development)
- [Security](#security)
- [License](#license)

---

## Why Enbox?

- **User-owned data** -- Data lives in personal datastores (DWNs) controlled by the user, not locked in application silos. Users can grant and revoke access at any time.
- **End-to-end encryption** -- Two-layer encryption protects data at rest: a seed-phrase-derived vault secures the agent identity, and per-record JWE encryption (ECDH-ES + AES-256-GCM) protects DWN records with `encryptionRequired` protocols.
- **Protocol-driven** -- Declarative protocol definitions govern what data exists, who can access it, and how it flows between participants. Protocols are enforced by the DWN engine, not application code.
- **Decentralized identity** -- Built on the [DID](https://www.w3.org/TR/did-core/) and [DWN](https://identity.foundation/decentralized-web-node/spec/) specifications. No vendor lock-in, no central authority.
- **Cross-platform** -- Core libraries ship ESM browser bundles tested across Chromium, Firefox, and WebKit. Same code runs in Node (Bun) and browsers.

---

## Quick Start

Most applications only need the `@enbox/api` package:

```bash
bun add @enbox/api
```

```ts
import { defineProtocol, Web5 } from '@enbox/api';

// Connect -- creates a local agent, identity vault, and DID
const { web5, did: myDid } = await Web5.connect({
  password: 'user-chosen-password',
});

// Define a protocol with typed data shapes
const NotesProtocol = defineProtocol({
  protocol  : 'https://example.com/notes',
  published : true,
  types     : {
    note: {
      schema      : 'https://example.com/schemas/note',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    note: {},
  },
} as const, {} as {
  note: { title: string; body: string };
});

// Scope all operations to the protocol
const notes = web5.using(NotesProtocol);
await notes.configure();

// Create a record (path, data, and schema are type-checked)
const { record } = await notes.records.create('note', {
  data: { title: 'Hello', body: 'World' },
});

// Query records back -- data is typed automatically
const { records } = await notes.records.query('note');
for (const r of records) {
  const note = await r.data.json(); // { title: string; body: string }
  console.log(r.id, note.title);
}
```

See the full [`@enbox/api` README](./packages/api/README.md) for the repository pattern, pre-built protocols, live queries, and the complete API reference.

---

## How It Works

Enbox gives each user an **agent** -- a local software component that manages their decentralized identity (DID), cryptographic keys, and personal data. Data is stored in **Decentralized Web Nodes (DWNs)**: protocol-driven datastores that the user controls.

```
┌──────────────────────────────────────────────────────────────┐
│  Your Application                                            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  @enbox/api  (Web5.connect() -> web5.using().records)  │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────▼────────────────────────────────┐  │
│  │  @enbox/agent                                          │  │
│  │  Identity vault · Key management · Sync engine         │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────▼────────────────────────────────┐  │
│  │  @enbox/dwn-sdk-js  (protocol engine, handlers,        │  │
│  │                       storage, encryption)              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                          │ sync
                          ▼
            ┌───────────────────────────┐
            │  @enbox/dwn-server        │
            │  Remote DWN (Bun.serve)   │
            │  + @enbox/dwn-sql-store   │
            └───────────────────────────┘
```

**Agent** -- Manages identities (DIDs), keys, and DWN interactions. Holds a seed-phrase-based identity vault for key recovery.

**DWN** -- A personal datastore defined by protocol rules. Each user has a local DWN and one or more remote DWNs. The agent syncs data between them automatically.

**Protocols** -- Declarative schemas that define what record types exist, who can read/write them, and whether they require encryption. Enforced by the DWN engine, configured with `defineProtocol()` at the API level.

**Two-Layer Encryption** -- (1) A 12-word BIP-39 seed phrase derives the agent DID; a user password encrypts it as compact JWE. (2) Protocol types with `encryptionRequired: true` use per-record JWE with the tenant's X25519 key. Given only the seed phrase, the agent DID is regenerated and all DWN records can be decrypted.

---

## Packages

### Build Order

```
@enbox/common
  @enbox/crypto
    @enbox/dids
      @enbox/dwn-sdk-js
        @enbox/dwn-clients
          @enbox/agent
            @enbox/api
              @enbox/protocols
          @enbox/dwn-server
        @enbox/dwn-sql-store
          @enbox/dwn-server
      @enbox/protocol-codegen
      @enbox/browser
```

### Application Layer

| Package | npm | Description |
|---|---|---|
| [`@enbox/api`](./packages/api) | [![npm](https://img.shields.io/npm/v/@enbox/api?label=)](https://www.npmjs.com/package/@enbox/api) | High-level SDK -- `Web5.connect()`, typed protocols, repository pattern, records, subscriptions |
| [`@enbox/protocols`](./packages/protocols) | [![npm](https://img.shields.io/npm/v/@enbox/protocols?label=)](https://www.npmjs.com/package/@enbox/protocols) | Pre-built protocol definitions (social graph, profile, preferences, status, lists, connect) |
| [`@enbox/protocol-codegen`](./packages/protocol-codegen) | [![npm](https://img.shields.io/npm/v/@enbox/protocol-codegen?label=)](https://www.npmjs.com/package/@enbox/protocol-codegen) | CLI to generate TypeScript types from protocol definitions and JSON Schemas |
| [`@enbox/browser`](./packages/browser) | [![npm](https://img.shields.io/npm/v/@enbox/browser?label=)](https://www.npmjs.com/package/@enbox/browser) | Browser helpers: DRL polyfills, service worker, Cache API |

### Agent & Identity

| Package | npm | Description |
|---|---|---|
| [`@enbox/agent`](./packages/agent) | [![npm](https://img.shields.io/npm/v/@enbox/agent?label=)](https://www.npmjs.com/package/@enbox/agent) | Agent framework: identity vault, key management, DWN stores, sync engine |
| [`@enbox/dids`](./packages/dids) | [![npm](https://img.shields.io/npm/v/@enbox/dids?label=)](https://www.npmjs.com/package/@enbox/dids) | DID methods (`did:dht`, `did:jwk`), resolution |
| [`@enbox/crypto`](./packages/crypto) | [![npm](https://img.shields.io/npm/v/@enbox/crypto?label=)](https://www.npmjs.com/package/@enbox/crypto) | Ed25519, X25519, secp256k1, AES, PBKDF2, JWE |
| [`@enbox/common`](./packages/common) | [![npm](https://img.shields.io/npm/v/@enbox/common?label=)](https://www.npmjs.com/package/@enbox/common) | Shared utilities: `TtlCache`, `LevelStore`, data conversion |

### DWN Infrastructure

| Package | npm | Description |
|---|---|---|
| [`@enbox/dwn-sdk-js`](./packages/dwn-sdk-js) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-sdk-js?label=)](https://www.npmjs.com/package/@enbox/dwn-sdk-js) | DWN protocol engine, message handlers, storage interfaces |
| [`@enbox/dwn-clients`](./packages/dwn-clients) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-clients?label=)](https://www.npmjs.com/package/@enbox/dwn-clients) | DWN client libraries: JSON-RPC, HTTP/WS transport, tenant registration |
| [`@enbox/dwn-server`](./packages/dwn-server) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-server?label=)](https://www.npmjs.com/package/@enbox/dwn-server) | Multi-tenant remote DWN server (HTTP/WS via Bun.serve) |
| [`@enbox/dwn-sql-store`](./packages/dwn-sql-store) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-sql-store?label=)](https://www.npmjs.com/package/@enbox/dwn-sql-store) | SQL-backed DWN storage (PostgreSQL, SQLite, MySQL, S3) |
| [`@enbox/dwn-relay`](./packages/dwn-relay) | -- | Storage-constrained DWN relay/cache server with eviction and peer sync |

---

## Testing

### Coverage

| Package | Coverage |
|---|---|
| `@enbox/api` | [![api](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/api.json)](packages/api) |
| `@enbox/agent` | [![agent](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/agent.json)](packages/agent) |
| `@enbox/common` | [![common](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/common.json)](packages/common) |
| `@enbox/crypto` | [![crypto](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/crypto.json)](packages/crypto) |
| `@enbox/dids` | [![dids](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dids.json)](packages/dids) |
| `@enbox/dwn-clients` | [![dwn-clients](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-clients.json)](packages/dwn-clients) |
| `@enbox/dwn-sdk-js` | [![dwn-sdk-js](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-sdk-js.json)](packages/dwn-sdk-js) |
| `@enbox/dwn-server` | [![dwn-server](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-server.json)](packages/dwn-server) |
| `@enbox/dwn-sql-store` | [![dwn-sql-store](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-sql-store.json)](packages/dwn-sql-store) |

Node coverage enforces a **98% line threshold** in CI.

### Browser Testing

Seven packages run browser tests across three engines via **Vitest + Playwright**. Browser test failures block merging.

| Package | Chromium | Firefox | WebKit |
|---|:---:|:---:|:---:|
| `@enbox/common` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/crypto` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/dids` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/browser` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/dwn-sdk-js` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/agent` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/api` | :white_check_mark: | :white_check_mark: | :white_check_mark: |

Production browser bundles target **Chrome 101+**, **Firefox 108+**, and **Safari 16+**.

For the full testing guide -- infrastructure setup, Docker services, CI matrix, and coverage details -- see [docs/TESTING.md](./docs/TESTING.md).

---

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Docker](https://docker.com) (for test infrastructure)

### Setup

```bash
git clone https://github.com/enboxorg/enbox.git
cd enbox
bun install
bun run build
```

See [GETTING_STARTED.md](./GETTING_STARTED.md) for detailed step-by-step instructions.

### Common Commands

```bash
bun run build                                    # Build all packages
bun run --filter @enbox/agent build              # Build a specific package
bun run test:node                                # Run all Node tests
BROWSER=chromium bun run --filter @enbox/api test:browser  # Browser tests
bun run lint                                     # Lint all packages
bun run clean                                    # Clean build artifacts
```

### Hosting a DWN Server

See [docs/HOSTING.md](./docs/HOSTING.md) for Docker Compose setup, configuration, production guidance, and Fly.io deployment.

### Releasing

Packages are published to npm via [Changesets](https://github.com/changesets/changesets). Never bump versions manually -- create a changeset instead:

```bash
bun changeset
```

CI creates a "Version Packages" PR that bumps versions and updates changelogs. Merging it triggers publication.

---

## Security

If you believe you have found a security vulnerability, please **do not open a public issue**. Instead, report it responsibly by emailing the maintainers directly. See the repository's security policy for details.

## Status & Contributing

This project is in **research preview** and under heavy active development. We are not yet accepting external contributions, but this will change as the project matures. For internal contribution guides, see [dwn-server](./packages/dwn-server/CONTRIBUTING.md) and [dwn-sdk-js](./packages/dwn-sdk-js/CONTRIBUTING.md).

## AI / LLM Agent Context

For architecture notes, coding style, test patterns, and build instructions see [`CLAUDE.md`](./CLAUDE.md).

## License

Apache-2.0

## Related Resources

- [Decentralized Web Node Specification](https://identity.foundation/decentralized-web-node/spec/)
- [DID Core Specification](https://www.w3.org/TR/did-core/)

---

*This monorepo consolidates packages from the [decentralized-identity](https://github.com/decentralized-identity) organization, including [dwn-sdk-js](https://github.com/decentralized-identity/dwn-sdk-js), [dwn-server](https://github.com/decentralized-identity/dwn-server), [dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store), and the web5-js monorepo.*
