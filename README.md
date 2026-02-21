# Enbox

> **Research Preview** -- Enbox is under active development. APIs may change without notice.

[![CI](https://img.shields.io/github/actions/workflow/status/enboxorg/enbox/ci.yml?branch=main&label=ci)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)

| Package | Coverage |
|---------|----------|
| `@enbox/api` | [![api](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/api.json)](packages/api) |
| `@enbox/agent` | [![agent](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/agent.json)](packages/agent) |
| `@enbox/common` | [![common](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/common.json)](packages/common) |
| `@enbox/crypto` | [![crypto](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/crypto.json)](packages/crypto) |
| `@enbox/dids` | [![dids](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dids.json)](packages/dids) |
| `@enbox/dwn-clients` | [![dwn-clients](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-clients.json)](packages/dwn-clients) |
| `@enbox/dwn-sdk-js` | [![dwn-sdk-js](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-sdk-js.json)](packages/dwn-sdk-js) |
| `@enbox/dwn-server` | [![dwn-server](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-server.json)](packages/dwn-server) |
| `@enbox/dwn-sql-store` | [![dwn-sql-store](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-sql-store.json)](packages/dwn-sql-store) |

A toolkit for decentralized identity and encrypted personal data storage.

## Quick Start (for app developers)

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

See the full [`@enbox/api` README](./packages/api/README.md) for detailed documentation, examples, and API reference.

### Developer Experience: Repository Pattern

For an even more ergonomic API, use the `repository()` factory to get a structure-aware CRUD interface:

```ts
import { defineProtocol, repository, Web5 } from '@enbox/api';

const { web5 } = await Web5.connect({ password: 'secret' });

const ProfileProtocol = defineProtocol({
  protocol  : 'https://example.com/profile',
  published : true,
  types: {
    profile : { schema: 'https://example.com/schemas/profile', dataFormats: ['application/json'] },
    link    : { schema: 'https://example.com/schemas/link',    dataFormats: ['application/json'] },
  },
  structure: {
    profile: {
      $recordLimit: { max: 1, strategy: 'reject' },  // singleton
      link: {},                                        // collection nested under profile
    },
  },
} as const, {} as {
  profile : { displayName: string; bio?: string };
  link    : { url: string; title: string };
});

const repo = repository(web5.using(ProfileProtocol));
await repo.configure();

// Singletons get set() / get() instead of create() / query()
await repo.profile.set({ data: { displayName: 'Alice', bio: 'Builder' } });
const { record: profile } = await repo.profile.get();
console.log(await profile.data.json()); // { displayName: 'Alice', bio: 'Builder' }

// Nested collections use (parentContextId, options)
await repo.profile.link.create(profile.contextId, {
  data: { url: 'https://github.com/alice', title: 'GitHub' },
});

const { records: links } = await repo.profile.link.query(profile.contextId);
```

### Pre-built Protocols

The `@enbox/protocols` package provides production-ready protocol definitions with typed schemas, singleton annotations, and JSON Schema files:

```ts
import { repository, Web5 } from '@enbox/api';
import { ProfileProtocol, SocialGraphProtocol } from '@enbox/protocols';

const { web5 } = await Web5.connect({ password: 'secret' });

// Use pre-built protocols directly -- fully typed, zero boilerplate
const social = repository(web5.using(SocialGraphProtocol));
await social.configure();

const { record } = await social.friend.create({
  data: { did: 'did:dht:alice...', alias: 'Alice' },
});
```

See [`@enbox/protocols`](./packages/protocols) for the full catalog of available protocols.

## How It Works

Enbox gives each user an **agent** -- a local software component that manages their decentralized identity (DID), cryptographic keys, and personal data. Data is stored in **Decentralized Web Nodes (DWNs)**: protocol-driven datastores that the user controls.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your Application                                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  @enbox/api  (Web5.connect() → web5.using().records)  │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │  @enbox/agent                                         │  │
│  │  ┌──────────┐ ┌───────────┐ ┌──────────────────────┐  │  │
│  │  │ Identity │ │ Key Mgmt  │ │ Sync Engine          │  │  │
│  │  │ Vault    │ │ (DWN-     │ │ (local ↔ remote DWN) │  │  │
│  │  │ (seed    │ │  backed,  │ │                      │  │  │
│  │  │  phrase) │ │  encrypt- │ └──────────────────────┘  │  │
│  │  │          │ │  ed)      │                           │  │
│  │  └──────────┘ └───────────┘                           │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │  @enbox/dwn-clients  (shared types + transport)       │  │
│  │  JSON-RPC · HTTP/WS clients · Registration · ServerInfo│  │
│  ├──────────────────────┬────────────────────────────────┤  │
│  │  @enbox/dwn-sdk-js  (local DWN instance)              │  │
│  │  Protocol engine · Message handlers · Storage          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          │ sync
                          ▼
            ┌──────────────────────────┐
            │  @enbox/dwn-server       │
            │  Remote DWN (Bun.serve)  │
            │  + SQL storage           │
            │  (@enbox/dwn-sql-store)  │
            └──────────────────────────┘
```

**Agent**: Manages identities (DIDs), keys, and DWN interactions. Holds a seed-phrase-based identity vault for key recovery.

**DWN (Decentralized Web Node)**: A personal datastore defined by [protocol rules](#protocols). Each user has a local DWN and one or more remote DWNs. The agent syncs data between them.

**DWN Server**: A multi-tenant remote DWN accessible over HTTP and WebSocket (JSON-RPC). Backed by SQL (PostgreSQL, SQLite, MySQL) or LevelDB.

**Sync**: The agent's sync engine keeps the local DWN and remote DWN(s) in lockstep. Runs automatically (default: every 2 minutes) or can be configured.

### Protocols

DWN records are organized by **protocols** -- declarative schemas that define what record types exist, who can read/write them, and whether they require encryption. For example:

```typescript
{
  protocol: 'https://example.org/social',
  types: {
    post:    { schema: 'https://example.org/post',    dataFormats: ['application/json'] },
    comment: { schema: 'https://example.org/comment', dataFormats: ['application/json'] },
  },
  structure: {
    post: {
      comment: {
        $actions: [{ who: 'anyone', can: ['create'] }],
      },
    },
  },
}
```

Protocols are installed on a DWN via `ProtocolsConfigure` messages and enforced by the DWN engine. At the API level, use `defineProtocol()` to create typed definitions and `web5.using(protocol).configure()` to install them.

### Two-Layer Encryption

All sensitive data is encrypted at rest through two independent layers:

1. **Vault encryption** (Layer 1): A 12-word BIP-39 seed phrase deterministically derives the agent's DID and keys. A user-chosen password encrypts the agent's portable DID as a compact JWE (AES-256-GCM via PBKDF2).

2. **DWN record-level encryption** (Layer 2): Protocol types with `encryptionRequired: true` are encrypted using JWE with the tenant's X25519 `#enc` key (ECDH-ES+A256KW key agreement, AES-256-GCM or XChaCha20-Poly1305 content encryption). Encryption keys are derived and injected into the protocol definition at install time.

**Recovery**: Given only the seed phrase, the agent DID is deterministically regenerated, yielding the X25519 `#enc` key needed to decrypt all DWN key records.

## Packages

### Build Order (dependency graph)

```
@enbox/common
  └─ @enbox/crypto
       └─ @enbox/dids
            ├─ @enbox/dwn-sdk-js
            │    ├─ @enbox/dwn-clients
            │    │    ├─ @enbox/agent
            │    │    │    └─ @enbox/api
            │    │    │         └─ @enbox/protocols
            │    │    └─ @enbox/dwn-server
            │    └─ @enbox/dwn-sql-store
            │         └─ @enbox/dwn-server
            ├─ @enbox/protocol-codegen (standalone CLI)
            └─ @enbox/browser
```

| Package | Description |
|---|---|
| [`@enbox/api`](./packages/api) | **High-level SDK for applications** -- `Web5.connect()`, typed protocols, repository pattern, records, subscriptions |
| [`@enbox/protocols`](./packages/protocols) | Pre-built protocol definitions (social graph, profile, preferences, status, lists, connect) with JSON Schemas |
| [`@enbox/protocol-codegen`](./packages/protocol-codegen) | CLI tool to generate TypeScript types from protocol definitions and JSON Schemas |
| [`@enbox/agent`](./packages/agent) | Agent framework: identity vault, key management, DWN stores, sync engine |
| [`@enbox/dwn-sdk-js`](./packages/dwn-sdk-js) | DWN protocol engine, message handlers, storage interfaces |
| [`@enbox/dwn-clients`](./packages/dwn-clients) | DWN client libraries, shared types, JSON-RPC transport |
| [`@enbox/dwn-server`](./packages/dwn-server) | Multi-tenant remote DWN server (HTTP/WS via Bun.serve) |
| [`@enbox/dwn-sql-store`](./packages/dwn-sql-store) | SQL-backed DWN storage (PostgreSQL, SQLite, MySQL) |
| [`@enbox/dids`](./packages/dids) | DID methods (`did:dht`, `did:jwk`), resolution |
| [`@enbox/crypto`](./packages/crypto) | Ed25519, X25519, secp256k1, AES, PBKDF2, JWE |
| [`@enbox/common`](./packages/common) | Shared utilities: `TtlCache`, `LevelStore`, data conversion |
| [`@enbox/browser`](./packages/browser) | Browser-specific helpers and DRL polyfills |

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

### Common Commands

```bash
# Run all tests
bun run test:node

# Lint
bun run lint
bun run lint:fix

# Build a specific package
bun run --filter @enbox/agent build

# Clean build artifacts
bun run clean
```

### Test Infrastructure

Several packages require external services (Pkarr relay, PostgreSQL, MySQL) for their full test suites. Start them with Docker Compose:

```bash
# Start test services
docker compose -f docker-compose.test.yaml up -d --wait

# Required env var for did:dht tests
export DID_DHT_GATEWAY_URI=http://localhost:7527
```

A local DWN server on `localhost:3000` is also required for `agent` and `api` tests. See [`CLAUDE.md`](./CLAUDE.md) for full instructions.

## Hosting a DWN Server

### Docker Compose

The easiest way to run a remote DWN server is with Docker Compose, which sets up both the DWN server and PostgreSQL.

```bash
# Start
docker-compose up -d

# View logs
docker-compose logs -f dwn-server

# Stop
docker-compose down
```

The DWN server will be available at `http://localhost:3000`.

### Configuration

Copy `docker.env.example` to `.env` and customize:

```bash
cp docker.env.example .env
```

**Ports**: DWN server on `3000`, PostgreSQL on `5433` (avoids conflicts with package-level testing).

**Volumes**: `postgres_data` (database files), `dwn_data` (DWN server data).

### Production Considerations

1. Change default passwords in `.env`
2. Use external PostgreSQL for better scalability
3. Set up SSL/TLS termination (reverse proxy)
4. Configure backup strategies
5. Set resource limits for containers

### Fly.io Deployment

Deploy the DWN server to Fly.io with managed PostgreSQL. See the complete [Fly.io Deployment Guide](./FLY.md).

## AI / LLM Agent Context

For detailed architecture notes, coding style, test patterns, and build instructions see [`CLAUDE.md`](./CLAUDE.md). It covers the package dependency graph, two-layer encryption internals, store inheritance, naming conventions, and how to run tests.

## Contributing

See the contribution guides in individual packages (e.g., [dwn-server](./packages/dwn-server/CONTRIBUTING.md), [dwn-sdk-js](./packages/dwn-sdk-js/CONTRIBUTING.md)).

## License

Apache-2.0

## Related Resources

- [Decentralized Web Node Specification](https://identity.foundation/decentralized-web-node/spec/)
- [DID Specification](https://www.w3.org/TR/did-core/)

---

*This monorepo consolidates packages from the [decentralized-identity](https://github.com/decentralized-identity) organization, including [dwn-sdk-js](https://github.com/decentralized-identity/dwn-sdk-js), [dwn-server](https://github.com/decentralized-identity/dwn-server), [dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store), and the web5-js monorepo.*
