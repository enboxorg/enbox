# Enbox

[![CI](https://img.shields.io/github/actions/workflow/status/enboxorg/enbox/ci.yml?branch=main&label=ci&color=2ea043)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-357ec7)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23e8d5b7?logo=bun&logoColor=f9f1e1)](https://bun.sh)

> **Research Preview** -- Enbox is under heavy development. Expect breaking changes. Not yet accepting external contributions. See [Status & Contributing](#status--contributing).

A toolkit for decentralized identity and encrypted personal data storage.

## Table of Contents

- [Why Enbox?](#why-enbox)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Packages](#packages)
- [Testing](#testing)
- [Development](#development)
- [Security](#security)
- [Status & Contributing](#status--contributing)

## Why Enbox?

- **User-owned data** -- Data lives in Decentralized Web Nodes (DWNs) that users control, not in application databases.
- **End-to-end encryption** -- Two-layer encryption (seed-phrase vault + DWN record-level JWE) with no plaintext fallback.
- **Protocol-driven** -- Declarative schemas define record types, access rules, and encryption requirements. Interoperable across applications.
- **Decentralized identity** -- Built on DIDs (`did:dht`, `did:jwk`) with deterministic key derivation and recovery from a 12-word seed phrase.
- **Cross-platform** -- Runs in Node.js (Bun) and modern browsers (Chrome 101+, Firefox 108+, Safari 16+).

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

See the [`@enbox/api` README](./packages/api/README.md) for the repository pattern, pre-built protocols, subscriptions, and full API reference.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  Your Application                                        │
│  ┌────────────────────────────────────────────────────┐  │
│  │  @enbox/api   (Web5.connect, typed protocols)      │  │
│  └────────────────────────┬───────────────────────────┘  │
│  ┌────────────────────────▼───────────────────────────┐  │
│  │  @enbox/agent  (identity vault, keys, sync)        │  │
│  └────────────────────────┬───────────────────────────┘  │
│  ┌────────────────────────▼───────────────────────────┐  │
│  │  @enbox/dwn-sdk-js  (protocol engine, handlers)    │  │
│  └────────────────────────┬───────────────────────────┘  │
└───────────────────────────┼──────────────────────────────┘
                            │ sync
              ┌─────────────▼─────────────┐
              │  @enbox/dwn-server        │
              │  Remote DWN (HTTP/WS)     │
              │  + SQL storage            │
              └───────────────────────────┘
```

**Agent**: Manages DIDs, cryptographic keys, and an encrypted identity vault (BIP-39 seed phrase). Syncs data between local and remote DWNs.

**DWN**: A personal datastore governed by [protocols](https://identity.foundation/decentralized-web-node/spec/) -- declarative schemas that define record types, access control, and encryption rules. Each user controls their own node.

**Two-Layer Encryption**: (1) A user password encrypts the agent's portable DID as AES-256-GCM JWE via PBKDF2. (2) Protocol types with `encryptionRequired: true` are encrypted using ECDH-ES+A256KW key agreement with the tenant's X25519 key. Recovery requires only the 12-word seed phrase.

## Packages

### Application Layer

| Package | Version | Description |
|---|---|---|
| [`@enbox/api`](./packages/api) | [![npm](https://img.shields.io/npm/v/@enbox/api?color=357ec7)](https://www.npmjs.com/package/@enbox/api) | High-level SDK -- `Web5.connect()`, typed protocols, repository pattern |
| [`@enbox/protocols`](./packages/protocols) | [![npm](https://img.shields.io/npm/v/@enbox/protocols?color=357ec7)](https://www.npmjs.com/package/@enbox/protocols) | Pre-built protocol definitions with JSON Schemas |
| [`@enbox/protocol-codegen`](./packages/protocol-codegen) | [![npm](https://img.shields.io/npm/v/@enbox/protocol-codegen?color=357ec7)](https://www.npmjs.com/package/@enbox/protocol-codegen) | CLI: generate TypeScript types from protocol definitions |

### Agent & Identity

| Package | Version | Description |
|---|---|---|
| [`@enbox/agent`](./packages/agent) | [![npm](https://img.shields.io/npm/v/@enbox/agent?color=357ec7)](https://www.npmjs.com/package/@enbox/agent) | Agent framework: identity vault, key management, sync engine |
| [`@enbox/dids`](./packages/dids) | [![npm](https://img.shields.io/npm/v/@enbox/dids?color=357ec7)](https://www.npmjs.com/package/@enbox/dids) | DID methods (`did:dht`, `did:jwk`), resolution |
| [`@enbox/crypto`](./packages/crypto) | [![npm](https://img.shields.io/npm/v/@enbox/crypto?color=357ec7)](https://www.npmjs.com/package/@enbox/crypto) | Ed25519, X25519, secp256k1, AES, PBKDF2, JWE |
| [`@enbox/common`](./packages/common) | [![npm](https://img.shields.io/npm/v/@enbox/common?color=357ec7)](https://www.npmjs.com/package/@enbox/common) | Shared utilities: `TtlCache`, `LevelStore`, data conversion |
| [`@enbox/browser`](./packages/browser) | [![npm](https://img.shields.io/npm/v/@enbox/browser?color=357ec7)](https://www.npmjs.com/package/@enbox/browser) | Browser polyfills and DRL resolution |

### DWN Infrastructure

| Package | Version | Description |
|---|---|---|
| [`@enbox/dwn-sdk-js`](./packages/dwn-sdk-js) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-sdk-js?color=357ec7)](https://www.npmjs.com/package/@enbox/dwn-sdk-js) | DWN protocol engine, message handlers, storage interfaces |
| [`@enbox/dwn-clients`](./packages/dwn-clients) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-clients?color=357ec7)](https://www.npmjs.com/package/@enbox/dwn-clients) | DWN client libraries, JSON-RPC transport |
| [`@enbox/dwn-server`](./packages/dwn-server) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-server?color=357ec7)](https://www.npmjs.com/package/@enbox/dwn-server) | Multi-tenant remote DWN server (HTTP/WS via Bun.serve) |
| [`@enbox/dwn-relay`](https://github.com/enboxorg/dwn-relay) | -- | DWN relay/cache node (standalone repo) |
| [`@enbox/dwn-sql-store`](./packages/dwn-sql-store) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-sql-store?color=357ec7)](https://www.npmjs.com/package/@enbox/dwn-sql-store) | SQL-backed DWN storage (PostgreSQL, SQLite, MySQL) |
| [`@enbox/dwn-server-admin-ui`](./packages/dwn-server-admin-ui) | -- | Admin dashboard for DWN server |

### Build Order

```
@enbox/common → @enbox/crypto → @enbox/dids → @enbox/dwn-sdk-js → @enbox/dwn-clients → @enbox/agent → @enbox/api → @enbox/protocols
```

## Testing

### Coverage

| Package | Coverage |
|---|---|
| `@enbox/api` | [![api](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/api.json&color=2ea043)](packages/api) |
| `@enbox/agent` | [![agent](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/agent.json&color=2ea043)](packages/agent) |
| `@enbox/common` | [![common](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/common.json&color=2ea043)](packages/common) |
| `@enbox/crypto` | [![crypto](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/crypto.json&color=2ea043)](packages/crypto) |
| `@enbox/dids` | [![dids](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dids.json&color=2ea043)](packages/dids) |
| `@enbox/dwn-clients` | [![dwn-clients](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-clients.json&color=2ea043)](packages/dwn-clients) |
| `@enbox/dwn-sdk-js` | [![dwn-sdk-js](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-sdk-js.json&color=2ea043)](packages/dwn-sdk-js) |
| `@enbox/dwn-server` | [![dwn-server](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-server.json&color=2ea043)](packages/dwn-server) |
| `@enbox/dwn-sql-store` | [![dwn-sql-store](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-sql-store.json&color=2ea043)](packages/dwn-sql-store) |

### Browser Support

Seven packages run browser tests via Vitest + Playwright across Chromium, Firefox, and WebKit:

| Package | Chromium | Firefox | WebKit |
|---|:---:|:---:|:---:|
| `@enbox/common` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/crypto` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/dids` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/browser` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/dwn-sdk-js` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/agent` | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `@enbox/api` | :white_check_mark: | :white_check_mark: | :white_check_mark: |

Browser build targets: Chrome 101+, Firefox 108+, Safari 16+.

For the full testing guide (Docker services, DWN server setup, CI matrix, coverage commands), see [docs/TESTING.md](./docs/TESTING.md).

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.0

### Setup

```bash
git clone https://github.com/enboxorg/enbox.git
cd enbox
bun install
bun run build
```

See [GETTING_STARTED.md](./GETTING_STARTED.md) for a more detailed walkthrough.

### Common Commands

```bash
bun run test:node                          # Run all Node tests
bun run lint                               # Lint all packages
bun run lint:fix                           # Auto-fix lint issues
bun run --filter @enbox/agent build        # Build a specific package
bun run clean                              # Clean build artifacts
BROWSER=chromium bun run --filter @enbox/dwn-sdk-js test:browser  # Browser tests
```

### Hosting a DWN Server

See [docs/HOSTING.md](./docs/HOSTING.md) for Docker Compose setup, configuration, production checklist, and Fly.io deployment.

### Releasing

Packages are published to npm via [Changesets](https://github.com/changesets/changesets). Never bump versions manually -- run `bun changeset` to create a changeset, then CI handles version bumps and publishing.

## Security

If you discover a security vulnerability, please report it responsibly. **Do not open a public issue.** Instead, email [security@enbox.org](mailto:security@enbox.org) with details. We will acknowledge receipt within 48 hours.

## Status & Contributing

Enbox is a **research preview under heavy development**. APIs will change without notice. We are not yet accepting external contributions -- if you're interested in contributing, watch the repo for updates.

See contribution guides in individual packages for context: [dwn-server](./packages/dwn-server/CONTRIBUTING.md), [dwn-sdk-js](./packages/dwn-sdk-js/CONTRIBUTING.md).

## AI / LLM Agent Context

For architecture notes, coding style, test patterns, and build instructions, see [`CLAUDE.md`](./CLAUDE.md).

## License

Apache-2.0

## Related Resources

- [Decentralized Web Node Specification](https://identity.foundation/decentralized-web-node/spec/)
- [DID Specification](https://www.w3.org/TR/did-core/)

---

*This monorepo consolidates packages from the [decentralized-identity](https://github.com/decentralized-identity) organization, including [dwn-sdk-js](https://github.com/decentralized-identity/dwn-sdk-js), [dwn-server](https://github.com/decentralized-identity/dwn-server), [dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store), and the web5-js monorepo.*
