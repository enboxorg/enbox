<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/enbox-mark-dark.svg">
  <img alt="Enbox" src="./assets/enbox-mark-light.svg" width="40">
</picture>

# en**b**ox

### The decentralised backend for web apps.

[![CI](https://img.shields.io/github/actions/workflow/status/enboxorg/enbox/ci.yml?branch=main&label=ci&style=flat-square&color=2ea043)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-545d69?style=flat-square)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?style=flat-square&logo=bun&logoColor=f9f1e1)](https://bun.sh)
[![npm](https://img.shields.io/npm/v/@enbox/api?style=flat-square&label=%40enbox%2Fapi&color=357ec7)](https://www.npmjs.com/package/@enbox/api)

---

> [!CAUTION]
> **Research Preview -- Not Production Ready**
>
> Enbox is under heavy, active development. You should expect:
>
> - **Breaking API changes** without prior deprecation
> - **Data loss** -- preview DWN servers may be wiped at any time
> - **Security gaps** -- the codebase has not been audited; do not store sensitive data
> - **Missing documentation** -- some features are undocumented or partially documented
>
> We are not yet accepting external contributions. If you build on Enbox today, pin your
> dependencies and be prepared to adapt. This notice will be removed when Enbox reaches
> a stable release.

---

## What is Enbox?

An open-source TypeScript SDK for building apps on [Decentralized Web Nodes](https://identity.foundation/decentralized-web-node/spec/) (DWNs). You get typed schemas, real-time subscriptions, queries, and end-to-end encryption -- but instead of a centralised database, every user gets their own encrypted personal datastore that syncs across devices and apps.

DWN is an [open standard](https://identity.foundation/decentralized-web-node/spec/) maintained by the Decentralized Identity Foundation. Anyone can run a DWN server, and any app that speaks the same protocol can interoperate. Enbox provides the tooling to build on that standard: an SDK, an agent framework, a server implementation, and the cryptographic primitives underneath.

| | Centralised backend | DWN-based (Enbox) |
|---|---|---|
| Data ownership | Provider holds all user data | Each user controls their own node |
| Auth | Email/password, OAuth providers | Decentralized Identifiers (DIDs) + seed phrase recovery |
| Schema | SQL tables, document collections | Protocol definitions (declarative, portable across apps) |
| Real-time | Server-pushed change feeds | DWN subscriptions (LiveQuery) |
| Encryption | At-rest, server-side | End-to-end (two-layer: vault + record-level JWE) |
| Hosting | Managed cloud, single vendor | Run your own server, use a community node, or both |
| Lock-in | Data lives in the provider's infra | Data follows the user -- switch apps without losing anything |

---

## Quick Start

```bash
bun add @enbox/api @enbox/auth
```

### 1. Connect

Create an auth session and an Enbox instance. Data syncs to whatever DWN endpoint(s) you configure -- a [community node](#dwn-servers), [your own](#run-your-own-node), or both.

```ts
import { AuthManager } from '@enbox/auth';
import { Enbox, defineProtocol } from '@enbox/api';

const auth = await AuthManager.create({
  dwnEndpoints : ['https://enbox-dwn.fly.dev'],   // ← any DWN server
});

const session = await auth.connectLocal({ createIdentity: true });
const enbox   = Enbox.connect({ session });
```

### 2. Define a protocol

Protocols are declarative schemas -- they describe record types, nesting, access rules, and encryption. Any app that installs the same protocol can read and write the same record shapes.

```ts
const BookmarkProtocol = defineProtocol({
  protocol  : 'https://example.com/bookmarks',
  published : false,
  types     : {
    folder: {
      schema      : 'https://example.com/schemas/folder',
      dataFormats : ['application/json'],
    },
    bookmark: {
      schema              : 'https://example.com/schemas/bookmark',
      dataFormats         : ['application/json'],
      encryptionRequired  : true,    // ← end-to-end encrypted at the DWN layer
    },
  },
  structure: {
    folder: {
      $tags    : { name: { type: 'string' } },   // queryable server-side
      bookmark : {},                               // bookmarks nest under folders
    },
  },
} as const, {} as {
  folder:   { name: string };
  bookmark: { url: string; title: string; note?: string };
});
```

### 3. Write and query data

```ts
const bookmarks = enbox.using(BookmarkProtocol);
await bookmarks.configure();   // install the protocol on the user's DWN

// Create a folder
const { record: folder } = await bookmarks.records.create('folder', {
  data : { name: 'Reading List' },
  tags : { name: 'Reading List' },
});

// Add a bookmark (nested under the folder, encrypted automatically)
await bookmarks.records.create('bookmark', {
  parentContextId : folder.contextId,
  data            : { url: 'https://example.com', title: 'Example', note: 'Check later' },
});

// Query all folders
const { records: folders } = await bookmarks.records.query('folder');
for (const f of folders) {
  const data = await f.data.json();   // { name: string }
  console.log(data.name);
}
```

### 4. Subscribe to changes

```ts
const { subscription } = await bookmarks.subscribe();
subscription.on('change', () => {
  // Re-query or refresh your UI -- changes sync across devices in real time
});
```

For browser apps, `@enbox/browser` re-exports everything from `@enbox/api` and `@enbox/auth` in a single import plus browser-specific helpers (`BrowserConnectHandler`, wallet-connect, DRL polyfills).

See the [`@enbox/api` README](./packages/api/README.md) for the full API: `repository()` helper, singletons, pagination, permissions, and more.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Your Application                                            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  @enbox/api                                            │  │
│  │  Web5.connect() · defineProtocol() · typed queries     │  │
│  └────────────────────────┬───────────────────────────────┘  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │  @enbox/agent                                          │  │
│  │  Identity vault · key management · DWN sync engine     │  │
│  └────────────────────────┬───────────────────────────────┘  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │  @enbox/dwn-sdk-js                                     │  │
│  │  Protocol engine · message handlers · storage layer    │  │
│  └────────────────────────┬───────────────────────────────┘  │
└───────────────────────────┼──────────────────────────────────┘
                            │  sync (HTTP + WebSocket)
              ┌─────────────▼──────────────┐
              │  @enbox/dwn-server         │
              │  Multi-tenant remote DWN   │
              │  PostgreSQL · SQLite · S3  │
              └────────────────────────────┘
```

**Agent** -- manages DIDs, cryptographic keys, and an encrypted identity vault derived from a 12-word BIP-39 seed phrase. Syncs data between a local DWN (in-browser or on-device) and any remote DWN server the user has configured.

**DWN** -- an [open-standard](https://identity.foundation/decentralized-web-node/spec/) personal datastore governed by protocols: declarative schemas that define record types, access control, and encryption rules. Each user controls their own node. The server is interchangeable -- run by you, the user, a community operator, or all three.

**Two-layer encryption** -- (1) a user password encrypts the agent's identity as AES-256-GCM JWE via PBKDF2. (2) Protocol types with `encryptionRequired: true` are encrypted with ECDH-ES+A256KW key agreement using the tenant's X25519 key. Recovery requires only the seed phrase.

---

## DWN Servers

A DWN server is a multi-tenant node that stores and relays messages on behalf of users. **Anyone can run one** -- it's just an HTTP/WebSocket server backed by a database. There is no central authority; users can point their DID at any server (or several).

We run two preview nodes for development and testing. They are free to use but come with **no uptime, data persistence, or security guarantees**:

| Node | URL | Notes |
|---|---|---|
| Fly.io | `https://enbox-dwn.fly.dev` | SQLite-backed, single region |
| AWS | `https://dev.aws.dwn.enbox.id` | Aurora PostgreSQL, us-east-1 |

Set DWN endpoints when creating the auth manager, or override per-identity:

```ts
import { AuthManager } from '@enbox/auth';

// Default for all identities created through this manager
const auth = await AuthManager.create({
  dwnEndpoints: [
    'https://enbox-dwn.fly.dev',
    'https://dev.aws.dwn.enbox.id',
  ],
});

// Or override for a specific identity
const session = await auth.connectLocal({
  dwnEndpoints  : ['https://eu.dwn.example.com'],
  createIdentity: true,
});
```

Check server health:

```bash
curl https://enbox-dwn.fly.dev/health
curl https://dev.aws.dwn.enbox.id/health
```

### Run Your Own Node

The `@enbox/dwn-server` package is a production-ready DWN server that runs anywhere Docker does. It supports PostgreSQL, SQLite, and MySQL for storage, with optional S3 for large blobs.

```bash
# Quick start with Docker Compose
git clone https://github.com/enboxorg/enbox.git
cd enbox
docker compose up dwn-server
```

Then point your app at it:

```ts
const auth = await AuthManager.create({
  dwnEndpoints: ['https://dwn.your-domain.com'],
});
```

See [docs/HOSTING.md](./docs/HOSTING.md) for the full deployment guide: Docker Compose configuration, environment variables, production checklist, Fly.io one-click deploy, and AWS ECS setup.

---

## Packages

### Application Layer

| Package | npm | What it does |
|---|---|---|
| [`@enbox/api`](./packages/api) | [![npm](https://img.shields.io/npm/v/@enbox/api?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/api) | **Start here.** `Web5.connect()`, typed protocols, queries, subscriptions |
| [`@enbox/auth`](./packages/auth) | [![npm](https://img.shields.io/npm/v/@enbox/auth?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/auth) | Auth manager: local connect, wallet-connect, session restore |
| [`@enbox/browser`](./packages/browser) | [![npm](https://img.shields.io/npm/v/@enbox/browser?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/browser) | Browser SDK: `Enbox.connect()`, polyfills, `repository()` helper |
| [`@enbox/protocols`](./packages/protocols) | [![npm](https://img.shields.io/npm/v/@enbox/protocols?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/protocols) | Pre-built protocol definitions with JSON Schemas |
| [`@enbox/protocol-codegen`](./packages/protocol-codegen) | [![npm](https://img.shields.io/npm/v/@enbox/protocol-codegen?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/protocol-codegen) | CLI to generate TypeScript types from protocol definitions |

### Agent & Identity

| Package | npm | What it does |
|---|---|---|
| [`@enbox/agent`](./packages/agent) | [![npm](https://img.shields.io/npm/v/@enbox/agent?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/agent) | Identity vault, key management, DWN sync engine |
| [`@enbox/dids`](./packages/dids) | [![npm](https://img.shields.io/npm/v/@enbox/dids?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/dids) | DID methods (`did:dht`, `did:jwk`, `did:web`), resolution |
| [`@enbox/crypto`](./packages/crypto) | [![npm](https://img.shields.io/npm/v/@enbox/crypto?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/crypto) | Ed25519, X25519, secp256k1, AES, PBKDF2, JWE |
| [`@enbox/common`](./packages/common) | [![npm](https://img.shields.io/npm/v/@enbox/common?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/common) | Shared utilities: `TtlCache`, `LevelStore`, data conversion |

### DWN Infrastructure

| Package | npm | What it does |
|---|---|---|
| [`@enbox/dwn-sdk-js`](./packages/dwn-sdk-js) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-sdk-js?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/dwn-sdk-js) | DWN protocol engine, message handlers, storage interfaces |
| [`@enbox/dwn-clients`](./packages/dwn-clients) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-clients?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/dwn-clients) | DWN client libraries, JSON-RPC transport |
| [`@enbox/dwn-server`](./packages/dwn-server) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-server?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/dwn-server) | Multi-tenant DWN server (HTTP/WS via Bun.serve) |
| [`@enbox/dwn-sql-store`](./packages/dwn-sql-store) | [![npm](https://img.shields.io/npm/v/@enbox/dwn-sql-store?color=357ec7&label=)](https://www.npmjs.com/package/@enbox/dwn-sql-store) | SQL-backed storage (PostgreSQL, SQLite, MySQL) |
| [`@enbox/dwn-relay`](https://github.com/enboxorg/dwn-relay) | -- | DWN relay/cache node ([standalone repo](https://github.com/enboxorg/dwn-relay)) |

---

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

### Commands

```bash
bun run build                              # Build all packages
bun run test:node                          # Run all tests
bun run lint                               # Lint all packages
bun run --filter @enbox/agent build        # Build a single package
```

### Test Infrastructure

Several packages require Docker services (Pkarr relay, PostgreSQL, NATS) and a local DWN server for their full test suites.

```bash
docker compose -f docker-compose.test.yaml up -d --wait
export DID_DHT_GATEWAY_URI=http://localhost:7527
bun run test:node
```

See [docs/TESTING.md](./docs/TESTING.md) for the complete testing guide. See [GETTING_STARTED.md](./GETTING_STARTED.md) for a detailed development walkthrough.

### Test Coverage

| Package | Coverage |
|---|---|
| `@enbox/api` | [![api](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/api.json&color=2ea043)](packages/api) |
| `@enbox/agent` | [![agent](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/agent.json&color=2ea043)](packages/agent) |
| `@enbox/common` | [![common](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/common.json&color=2ea043)](packages/common) |
| `@enbox/crypto` | [![crypto](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/crypto.json&color=2ea043)](packages/crypto) |
| `@enbox/dids` | [![dids](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dids.json&color=2ea043)](packages/dids) |
| `@enbox/dwn-sdk-js` | [![dwn-sdk-js](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-sdk-js.json&color=2ea043)](packages/dwn-sdk-js) |
| `@enbox/dwn-server` | [![dwn-server](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-server.json&color=2ea043)](packages/dwn-server) |
| `@enbox/dwn-sql-store` | [![dwn-sql-store](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-sql-store.json&color=2ea043)](packages/dwn-sql-store) |

### Browser Support

Chromium, Firefox, and WebKit are tested via Playwright. Build targets: Chrome 101+, Firefox 108+, Safari 16+.

### Releasing

Packages are published to npm via [Changesets](https://github.com/changesets/changesets). Never bump versions manually -- run `bun changeset`, then CI handles the rest.

---

## Security

If you discover a security vulnerability, please report it responsibly. **Do not open a public issue.** Email [security@enbox.org](mailto:security@enbox.org) with details. We will acknowledge receipt within 48 hours.

## Status & Contributing

Enbox is a **research preview under heavy development**. APIs will change without notice. We are not yet accepting external contributions -- watch the repo for updates.

## License

[Apache-2.0](./LICENSE)

## Resources

- [Decentralized Web Node Specification](https://identity.foundation/decentralized-web-node/spec/)
- [DID Core Specification](https://www.w3.org/TR/did-core/)
- [Enbox Documentation](https://enbox-docs.pages.dev) *(work in progress)*
- [Hosting Guide](./docs/HOSTING.md)

---

<sub>This monorepo consolidates packages from the [decentralized-identity](https://github.com/decentralized-identity) organisation, including [dwn-sdk-js](https://github.com/decentralized-identity/dwn-sdk-js), [dwn-server](https://github.com/decentralized-identity/dwn-server), [dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store), and the web5-js monorepo.</sub>
