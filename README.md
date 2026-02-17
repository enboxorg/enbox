# Enbox

> **Research Preview** — Enbox is under active development. APIs may change without notice.

A toolkit for decentralized identity and encrypted personal data storage.

## How It Works

Enbox gives each user an **agent** — a local software component that manages their decentralized identity (DID), cryptographic keys, and personal data. Data is stored in **Decentralized Web Nodes (DWNs)**: protocol-driven datastores that the user controls.

### The Key Components

```
┌─────────────────────────────────────────────────────────────┐
│  Your Application                                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  @enbox/api  (Enbox.connect() → enbox.dwn.records.*)  │  │
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

DWN records are organized by **protocols** — declarative schemas that define what record types exist, who can read/write them, and whether they require encryption. For example:

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

Protocols are installed on a DWN via `ProtocolsConfigure` messages and enforced by the DWN engine.

### Two-Layer Encryption

All sensitive data is encrypted at rest through two independent layers:

1. **Vault encryption** (Layer 1): A 12-word BIP-39 seed phrase deterministically derives the agent's DID and keys. A user-chosen password encrypts the agent's portable DID as a compact JWE (AES-256-GCM via PBKDF2).

2. **DWN record-level encryption** (Layer 2): Protocol types with `encryptionRequired: true` are encrypted using ECIES with the tenant's secp256k1 `#enc` key. Encryption keys are derived and injected into the protocol definition at install time.

**Recovery**: Given only the seed phrase, the agent DID is deterministically regenerated, yielding the secp256k1 `#enc` key needed to decrypt all DWN key records.

## Packages

### Build Order (dependency graph)

```
@enbox/common
  └─ @enbox/crypto
       └─ @enbox/dids
            ├─ @enbox/dwn-sdk-js
            │    ├─ @enbox/agent
            │    │    └─ @enbox/api
            │    └─ @enbox/dwn-sql-store
            │         └─ @enbox/dwn-server
            └─ @enbox/browser
```

| Package | Description |
|---|---|
| `@enbox/common` | Shared utilities, `TtlCache`, `LevelStore` |
| `@enbox/crypto` | Ed25519, secp256k1, AES, PBKDF2, JWE |
| `@enbox/dids` | DID methods (`did:dht`, `did:jwk`), resolution |
| `@enbox/dwn-sdk-js` | DWN protocol engine, message handlers, stores |
| `@enbox/agent` | Agent framework: identity vault, key management, DWN stores, sync |
| `@enbox/api` | High-level SDK for applications (`Enbox.connect()`) |
| `@enbox/dwn-sql-store` | SQL-backed DWN storage (PostgreSQL, SQLite, MySQL) |
| `@enbox/dwn-server` | Multi-tenant remote DWN server (HTTP/WS via Bun.serve) |
| `@enbox/browser` | Browser-specific DID tools |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.0

### Installation

```bash
git clone https://github.com/enboxorg/enbox.git
cd enbox
bun install
bun run build
```

### Development

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

## Docker Setup

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

## Fly.io Deployment

Deploy the DWN server to Fly.io with managed PostgreSQL. See the complete [Fly.io Deployment Guide](./FLY.md).

**Quick summary**: Fork repo, create Fly app + Postgres cluster, attach Postgres, configure secrets, `fly deploy`.

## AI / LLM Agent Context

For detailed architecture notes, coding style, test patterns, and build instructions see [`CLAUDE.md`](./CLAUDE.md). It covers the package dependency graph, two-layer encryption internals, store inheritance, naming conventions, and how to run tests.

## Contributing

See the [contribution guide](https://github.com/enboxorg/enbox/blob/main/CONTRIBUTING.md).

## License

Apache-2.0

## Related Resources

- [Decentralized Web Node Specification](https://identity.foundation/decentralized-web-node/spec/)
- [DID Specification](https://www.w3.org/TR/did-core/)

---

*This monorepo consolidates packages from the [decentralized-identity](https://github.com/decentralized-identity) organization, including [dwn-sdk-js](https://github.com/decentralized-identity/dwn-sdk-js), [dwn-server](https://github.com/decentralized-identity/dwn-server), [dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store), and the web5-js monorepo.*
