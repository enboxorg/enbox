# Project Instructions

## Monorepo Overview

Bun workspace monorepo for decentralized web infrastructure. Runtime is **Bun** (>=1.0.0).

### Package Dependency Graph (build order)

```
@enbox/common          (shared utilities, TtlCache, LevelStore)
  @enbox/crypto        (Ed25519, secp256k1, AES, JWE)
    @enbox/dids        (did:dht, did:jwk, resolution)
      @enbox/dwn-sdk-js  (DWN protocol engine, message handlers, stores)
        @enbox/agent     (agent framework: identity, key management, DWN stores, sync)
          @enbox/api     (high-level SDK for apps)
      @enbox/dwn-sql-store (SQL-backed DWN storage)
        @enbox/dwn-server  (HTTP/WS DWN server)
    @enbox/browser     (browser-specific DID tools)
```

Build from the bottom up. If you change `dwn-sdk-js`, rebuild it before building `agent`:

```bash
bun run --filter @enbox/dwn-sdk-js build
bun run --filter @enbox/agent build
```

### Key Directories

| Path | Purpose |
|---|---|
| `packages/agent/src/` | Agent framework source |
| `packages/agent/tests/` | Agent tests (bun:test + Sinon) |
| `packages/agent/src/store-data.ts` | Base `DwnDataStore` class (protocol-backed storage with encryption) |
| `packages/agent/src/store-key.ts` | `DwnKeyStore` — encrypted private key storage |
| `packages/agent/src/store-data-protocols.ts` | Protocol definitions (`JwkProtocolDefinition`, `IdentityProtocolDefinition`, `KeyDeliveryProtocolDefinition`) |
| `packages/agent/src/dwn-api.ts` | `AgentDwnApi` — DWN operations, encryption callbacks, participant detection |
| `packages/agent/src/hd-identity-vault.ts` | `HdIdentityVault` — seed phrase / password vault for agent DID |
| `packages/agent/src/test-harness.ts` | `PlatformAgentTestHarness` — test infrastructure (exported as public API) |
| `packages/dwn-sdk-js/src/` | DWN SDK source (gold-standard for style) |
| `packages/dwn-sdk-js/json-schemas/` | JSON Schema definitions for DWN messages |

## Pre-Push Requirements

Before any commits get pushed and PRs opened, ALL of the following MUST pass:

1. **Lint** — `bun run lint` (use `bun run lint:fix` to auto-fix issues)
2. **Build** — `bun run --filter @enbox/agent build` (rebuild `dwn-sdk-js` first if changed)
3. **Tests** — `export DID_DHT_GATEWAY_URI=http://localhost:7527 && bun run test:node` from `packages/agent/`

Do not push or open a PR until all three checks pass locally. See [Local Test Infrastructure](#local-test-infrastructure) for required services.

### Running Tests

All packages use **`bun test`** (Bun's native test runner).

#### Test framework by package

| Package | Runner | Command (from package dir) |
|---|---|---|
| `@enbox/agent` | `bun test` | `bun run test:node` |
| `@enbox/api` | `bun test` | `bun run test:node` |
| `@enbox/dwn-sdk-js` | `bun test` | `bun run test:node` |
| `@enbox/dwn-server` | `bun test` | `bun run test` |
| `@enbox/dwn-sql-store` | `bun test` | `bun run test` |
| `@enbox/common` | `bun test` | `bun run test:node` |
| `@enbox/crypto` | `bun test` | `bun run test:node` |
| `@enbox/dids` | `bun test` | `bun run test:node` |

#### Agent / API tests (bun:test)

**Important:** Always set `DID_DHT_GATEWAY_URI` before running agent or API tests. Without it, ~115 agent tests and ~23 API tests will fail with Pkarr errors.

```bash
export DID_DHT_GATEWAY_URI=http://localhost:7527

# Full agent test suite (from packages/agent/):
bun run test:node

# Single test file (from packages/agent/):
bun test tests/store-key.spec.ts
```

#### DWN SDK / other packages (bun test)

```bash
# Full DWN SDK test suite (from packages/dwn-sdk-js/):
bun run test:node

# DWN SDK tests with name filter:
GREP="ProtocolsConfigure" bun run test:node-grep
# Which runs: bun test .spec.ts -t $GREP

# Run all tests across the monorepo (from repo root):
bun run test:node

# Lint all packages (from repo root):
bun run lint
```

## Local Test Infrastructure

Several packages (`dids`, `agent`, `api`, `dwn-server`, `dwn-sql-store`) require external services to run their full test suites. **Always start test infrastructure before running tests.**

### Quick start

```bash
# Start all test services (Pkarr relay, Postgres, MySQL):
docker compose -f docker-compose.test.yaml up -d --wait

# Set the Pkarr gateway env var (REQUIRED for did:dht tests):
export DID_DHT_GATEWAY_URI=http://localhost:7527
```

Without `DID_DHT_GATEWAY_URI`, tests in `agent` (~115 tests), `api` (~23 tests), and `dids` (~1 test) will fail with `DidError: internalError: Failed to put Pkarr record`. These are NOT real test failures — the tests are correct, they just need the gateway.

### Services provided by `docker-compose.test.yaml`

| Service | Container | Port | Used by |
|---|---|---|---|
| Pkarr relay | `enbox-test-pkarr` | `localhost:7527` | `dids`, `agent`, `api` (did:dht publishing) |
| PostgreSQL 15 | `enbox-test-postgres` | `localhost:5433` | `dwn-server`, `dwn-sql-store` |
| PostgreSQL 13 | `enbox-test-postgres-sdk` | `localhost:5432` | `dwn-sql-store` (SDK test suite) |
| MySQL 8 | `enbox-test-mysql` | `localhost:3306` | `dwn-sql-store` |

### DWN server

A local DWN server on `localhost:3000` is required for `agent` and `api` tests. Check if it's running:

```bash
curl -sf http://localhost:3000/info && echo "DWN server is running"
```

If not running, start it (requires built packages):

```bash
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DS_PORT=3000
export DWN_BASE_URL=http://localhost:3000
export DWN_TTL_CACHE_URL="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_MESSAGES="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_DATA="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_STATE_INDEX="postgres://dwn_user:dwn_password@localhost:5433/dwn"
export DWN_STORAGE_RESUMABLE_TASKS="postgres://dwn_user:dwn_password@localhost:5433/dwn"
bun packages/dwn-server/dist/esm/src/main.js &
```

### Running tests with full infrastructure

```bash
# Ensure services are up:
docker compose -f docker-compose.test.yaml up -d --wait
export DID_DHT_GATEWAY_URI=http://localhost:7527

# Now run tests — these will all pass:
bun run --filter @enbox/agent test:node       # 748 pass, 0 fail
bun run --filter @enbox/api test:node         # all pass
bun run --filter @enbox/dids test:node        # all pass
bun run --filter @enbox/dwn-sdk-js test:node  # 978 pass, 0 fail
```

### CI coverage thresholds (for reference)

All packages are above 90% line coverage in CI. If local coverage numbers look low, verify the test infrastructure is running.

| Package | CI Coverage |
|---|---|
| `agent` | 90.3% |
| `api` | 99.8% |
| `common` | 95.7% |
| `crypto` | 98.6% |
| `dids` | 99.2% |
| `dwn-sdk-js` | 98.9% |
| `dwn-server` | 97.3% |
| `dwn-sql-store` | 96.9% |

## Coding Style

Style is derived from `dwn-sdk-js` (gold standard). ESLint enforces most rules.

### Imports

Type imports first (grouped), then value imports. Both groups alphabetically sorted. All relative imports use `.js` extension.

```typescript
import type { Filter } from '../types/query-types.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
```

### Object Property Alignment

Align colons when an object literal has multiple keys. This is enforced by ESLint `key-spacing` with `align.on: 'colon'`.

```typescript
const result = await agent.dwn.processRequest({
  author        : tenantDid,
  target        : tenantDid,
  messageType   : DwnInterface.RecordsWrite,
  messageParams : { ...this._recordProperties },
});
```

### Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Classes | PascalCase | `DwnKeyStore`, `AgentDwnApi`, `ProtocolsConfigure` |
| Methods/functions | camelCase | `processRequest()`, `getEncryptionKeyDeriver()` |
| Private fields | `_` prefix | `private _agent`, `private _cache` |
| Boolean getters | `is` prefix | `get isLocked()`, `get isSignedByAuthorDelegate()` |
| Enum members | PascalCase | `ProtocolAction.Create`, `DwnInterface.RecordsWrite` |
| Files | kebab-case | `store-data.ts`, `dwn-api.ts`, `local-key-manager.ts` |
| Test files | kebab-case + `.spec.ts` | `store-key.spec.ts`, `dwn-api.spec.ts` |

### Types, Interfaces, Enums

- **`type`** for data shapes (DTOs, messages, options, descriptors, results)
- **`interface`** for service contracts (stores, signers, handlers — things with implementations)
- **`enum`** for finite domain-specific value sets
- Intersection types (`&`) for extending message types

```typescript
// type — data shape
export type DataStoreGetParams = DataStoreTenantParams & { id: string; useCache?: boolean; };

// interface — service contract
export interface AgentDataStore<TStoreObject> {
  delete(params: DataStoreDeleteParams): Promise<boolean>;
  get(params: DataStoreGetParams): Promise<TStoreObject | undefined>;
}

// enum — finite set
export enum DwnInterface { RecordsWrite = 'RecordsWrite', RecordsRead = 'RecordsRead' }
```

### Functions and Methods

- Explicit return types on ALL functions and methods
- Explicit `public`/`private`/`protected` on all class members
- Static factory pattern preferred over public constructors (`static async create()`)
- Curly braces required for all control flow: `if (x) { return y; }`
- `prefer-const` for all non-reassigned variables
- `undefined` checks use strict equality: `if (schema !== undefined)`
- Early-return guard clauses for preconditions

### Error Handling

In `dwn-sdk-js`: use `DwnError` with typed `DwnErrorCode` enum and lowercase message:
```typescript
throw new DwnError(DwnErrorCode.ProtocolAuthorizationProtocolNotFound, `unable to find protocol definition for ${protocolUri}`);
```

In `agent`: use standard `Error` with descriptive class-prefixed messages:
```typescript
throw new Error(`AgentDwnApi: DID '${didUri}' does not have a keyAgreement verification method.`);
```

### JSDoc

Brief JSDoc on public methods and complex private methods. Use `@param`, `@returns`, `@throws` where appropriate.

```typescript
/**
 * Install the protocol for the given tenant using a `ProtocolsConfigure` message.
 * When any type in the protocol definition has `encryptionRequired: true`,
 * `$encryption` keys are derived and injected into the protocol definition.
 */
private async installProtocol(tenant: string, agent: Web5PlatformAgent): Promise<void> {
```

### ESLint Rules Summary

- Imports alphabetically sorted, type imports grouped first
- Arrow functions in callbacks need explicit return types
- Single-line if statements need curly braces
- Object properties align colons when multiple keys
- Max line length: 150 characters (strings exempted)
- Semicolons required, single quotes, trailing commas in multi-line
- `TODO` comments must reference a GitHub issue (enforced in `dwn-sdk-js` and `dwn-server` via `eslint-plugin-todo-plz`)

## Test Style

### Frameworks

All packages use **`bun test`** (`import { describe, expect, it } from 'bun:test'`). Assertions use `expect(...).toBe(...)`, `expect(...).toThrow(...)`, etc. Sinon is used for mocks/stubs in `agent` and `api` packages.

Files use `.spec.ts` suffix in all packages.

### Test Structure

`describe` blocks match class/module names. Nested `describe` for method or feature groups. Test descriptions start with `should` or use short verb-phrases.

```typescript
describe('DwnKeyStore', () => {
  describe('encryption at rest', () => {
    it('should encrypt key records in the DWN and decrypts them on read', async () => { ... });
  });

  describe('encryption required — Ed25519-only agent DID rejection', () => {
    it('should throw when generating a key with an Ed25519-only agent DID', async () => { ... });
  });
});
```

### bun:test Patterns (dwn-sdk-js, common, crypto, dids, etc.)

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import sinon from 'sinon';

describe('ComponentName', () => {
  beforeEach(() => { /* setup */ });
  afterAll(() => { /* cleanup */ });

  it('should do something', async () => {
    expect(result).toBe(expected);
  });

  it('should throw on invalid input', () => {
    expect(() => doSomething()).toThrow(DwnErrorCode.SomeErrorCode);
  });

  it('should reject async errors', async () => {
    await expect(asyncOperation()).rejects.toThrow('error message');
  });
});
```

### Agent Test Harness Pattern (agent/api)

Agent tests use `PlatformAgentTestHarness` with `TestAgent`:

```typescript
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

describe('ComponentName', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',  // 'memory' for fast tests, 'dwn' for integration
      testDataLocation : '__TESTDATA__/unique-name'  // avoid LevelDB conflicts
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();  // creates secp256k1 did:jwk
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('should do something', async () => {
    const result = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
    expect(result).toBeDefined();
  });
});
```

For full agent lifecycle tests (vault + DWN stores), use `Web5UserAgent` instead of `TestAgent`:

```typescript
import { Web5UserAgent } from '../src/web5-user-agent.js';

const harness = await PlatformAgentTestHarness.setup({
  agentClass  : Web5UserAgent,
  agentStores : 'dwn',
});
await harness.agent.initialize({ password: 'test' });
await harness.agent.start({ password: 'test' });
```

### Error Assertions

**bun:test** (all packages):
```typescript
expect(() => syncOperation()).toThrow(DwnErrorCode.SomeErrorCode);
await expect(asyncOperation()).rejects.toThrow('error message');
```

### Test Isolation

- Use unique `testDataLocation` per describe block to avoid LevelDB lock conflicts
- Clean up in `afterEach`/`afterAll` hooks — always close LevelDB handles
- Test data via helper functions and inline construction, not fixture files

## Architecture Notes

### Two-Layer Encryption

1. **Layer 1 — Vault** (`HdIdentityVault`): 12-word BIP-39 seed phrase derives HD keys. Password encrypts the agent's `PortableDid` as CompactJWE (AES-256-GCM via PBKDF2). Stored in `VAULT_STORE` LevelDB.

2. **Layer 2 — DWN record-level** (`DwnKeyStore`): Records with `encryptionRequired: true` in their protocol type definition are encrypted using ECIES-ES256K with the tenant's secp256k1 `#enc` key. The `$encryption` block is derived and injected into the protocol definition at install time.

Recovery path: seed phrase -> agent DID (deterministic) -> `#enc` key -> decrypt DWN key records.

### Store Inheritance

```
AgentDataStore<T> (interface)
  DwnDataStore<T>       (base — protocol-backed DWN storage with encryption support)
    DwnKeyStore         (Jwk, JwkProtocolDefinition, encryptionRequired: true)
    DwnDidStore         (PortableDid, IdentityProtocolDefinition)
    DwnIdentityStore    (IdentityMetadata, IdentityProtocolDefinition)
  InMemoryDataStore<T>  (base — Map-backed)
    InMemoryKeyStore
    InMemoryDidStore
    InMemoryIdentityStore
```

Subclasses override: `name`, `_recordProtocolDefinition`, `_recordProperties`, `getAllRecords()`.

### Agent DID vs Tenant DID

The **agent DID** (`agent.agentDid`) is the agent's own identity. The **tenant DID** is the context for store operations. Multi-tenancy is resolved via `getDataStoreTenant()` with priority: explicit tenant > agent DID > DID URI parameter. Store keys use `TENANT_SEPARATOR` (`^`).

### DWN Encryption

Strictly secp256k1. The entire pipeline (ECIES, HdKey derivation, protocol key injection) is hardcoded to secp256k1. In production, `HdIdentityVault.initialize()` always creates the agent DID as `did:dht` with both Ed25519 (`#sig`) and secp256k1 (`#enc`).

Encryption is declared in the protocol definition via `ProtocolType.encryptionRequired: true`. When set, `DwnDataStore.installProtocol()` derives and injects `$encryption` keys. If the tenant DID lacks a secp256k1 keyAgreement key, installation fails — no plaintext fallback.
