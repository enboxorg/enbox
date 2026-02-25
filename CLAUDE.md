# Project Instructions

## Inviolable Rules

### Never modify production code to satisfy tests

Production code must NEVER be weakened, loosened, or given special-case handling to make a test pass. This includes adding defensive null/undefined checks, try/catch blocks, early returns, or any other logic whose sole purpose is to handle conditions that only arise in stubbed/mocked test environments. This is how security vulnerabilities are born.

If a test fails because new production code interacts badly with a stubbed environment, the fix belongs **entirely in the test**: update the stubs to properly simulate reality, or stub the new production method directly on the handler/class instance. The production code path must remain exactly as strict as the real-world scenario demands.

## Monorepo Overview

Bun workspace monorepo for decentralized web infrastructure. Runtime is **Bun** (>=1.0.0).

### Package Dependency Graph (build order)

```
@enbox/common          (shared utilities, TtlCache, LevelStore)
  @enbox/crypto        (Ed25519, X25519, secp256k1, AES, JWE)
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

### GitHub CLI (`gh`) — use REST API for mutations

`gh pr edit --body` silently fails due to a GraphQL Projects Classic deprecation issue. When updating PR bodies (or any mutation that fails silently), use the REST API instead:

```bash
# Write body to a temp file, then:
gh api repos/enboxorg/enbox/pulls/<PR_NUMBER> -X PATCH -F body=@pr-body.md
```

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
# Start all test services (Pkarr relay, Postgres, MySQL, NATS):
docker compose -f docker-compose.test.yaml up -d --wait

# Set the Pkarr gateway env var (REQUIRED for did:dht tests):
export DID_DHT_GATEWAY_URI=http://localhost:7527

# Set the NATS URL (REQUIRED for dwn-server NatsEventLog tests):
export NATS_URL=nats://localhost:4222
```

Without `DID_DHT_GATEWAY_URI`, tests in `agent` (~115 tests), `api` (~23 tests), and `dids` (~1 test) will fail with `DidError: internalError: Failed to put Pkarr record`. These are NOT real test failures — the tests are correct, they just need the gateway.

### Services provided by `docker-compose.test.yaml`

| Service | Container | Port | Used by |
|---|---|---|---|
| Pkarr relay | `enbox-test-pkarr` | `localhost:7527` | `dids`, `agent`, `api` (did:dht publishing) |
| PostgreSQL 15 | `enbox-test-postgres` | `localhost:5433` | `dwn-server`, `dwn-sql-store` |
| PostgreSQL 13 | `enbox-test-postgres-sdk` | `localhost:5432` | `dwn-sql-store` (SDK test suite) |
| MySQL 8 | `enbox-test-mysql` | `localhost:3306` | `dwn-sql-store` |
| NATS JetStream | `enbox-test-nats` | `localhost:4222` | `dwn-server` (NatsEventLog plugin tests) |

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

Alternatively, `./scripts/test-with-server.sh` automates the full cycle (start containers, build, run tests, tear down). If `did:dht` tests fail with `Failed to put Pkarr record`, the relay is not running.

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

## Releasing & Publishing Packages

Packages are published to npm via **Changesets** and CI. **NEVER bump versions manually in `package.json`** — use the changeset workflow instead.

### How it works

1. **Create a changeset** describing the changes and the semver bump type:
   ```bash
   bun changeset
   ```
   This interactively creates a `.changeset/<random-name>.md` file. Select which packages are affected and whether the bump is `patch`, `minor`, or `major`.

2. **Commit and push** the changeset file(s) to `main` (directly or via PR).

3. **CI creates a "Version Packages" PR** — the `release.yml` workflow detects pending changesets and opens a PR that bumps all `package.json` versions, updates changelogs, and regenerates the lockfile.

4. **Merge the Version Packages PR** — CI then runs `scripts/publish.sh` which resolves `workspace:*` deps to real versions, packs each package with `bun pm pack`, and publishes tarballs via `npm publish`.

### Key details

- **Changeset config** is in `.changeset/config.json`.
- **`@enbox/dwn-relay`** has been moved to its own repository at https://github.com/enboxorg/dwn-relay.
- **`updateInternalDependencies: "patch"`** — when a dependency gets bumped, its dependents automatically get a patch bump too. For example, bumping `@enbox/dwn-sdk-js` as `minor` will auto-bump `@enbox/agent`, `@enbox/api`, `@enbox/protocols`, `@enbox/crypto`, etc. as `patch`.
- **`scripts/publish.sh`** handles the Bun `workspace:*` → real version resolution that changesets' built-in publish cannot do.
- The publish script **skips already-published versions** (idempotent).
- Git tags are created automatically in the format `@enbox/<package>@<version>`.
- npm auth is handled via `NPM_TOKEN` secret in CI.

### IMPORTANT: Do NOT run `changeset version` locally

**Never run `bunx changeset version` locally.** This command consumes the changeset files, bumps `package.json` versions, and updates changelogs — that is CI's job. If you accidentally run it, revert with `git checkout -- packages/ .changeset/`.

The correct local workflow is:
1. Create the `.changeset/<name>.md` file (manually or via `bun changeset`)
2. Commit the changeset file
3. Push to `main`
4. CI handles the rest

### Agent-friendly changeset creation

Since `bun changeset` is interactive (not supported in agents), create the changeset file directly:

```bash
cat > .changeset/my-changeset.md << 'EOF'
---
"@enbox/dwn-sdk-js": minor
"@enbox/agent": patch
---

feat: add new protocol feature and update agent to use it
EOF
```

Use `bunx changeset status` to verify the changeset is valid before committing.

### Semver guidelines for this project

| Change type | Bump | Examples |
|---|---|---|
| New feature / new API | `minor` | New protocol directive, new sync engine, new public method |
| Bug fix / security fix | `patch` | SSRF protection, escape LIKE wildcards, crash fix |
| Breaking change | `major` | Removed public API, changed wire format, renamed exports |
| Test-only changes | No bump needed | Don't include test-only packages in the changeset |

### Example changeset file

```markdown
---
"@enbox/dwn-clients": patch
"@enbox/api": patch
---

feat: add provider-auth-v0 client methods and Web5.connect() integration
```

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
    await testHarness.createAgentDid();  // creates did:jwk with Ed25519 + X25519
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

2. **Layer 2 — DWN record-level** (`DwnKeyStore`): Records with `encryptionRequired: true` in their protocol type definition are encrypted using JWE (ECDH-ES+A256KW key agreement with the tenant's X25519 `#enc` key, AES-256-GCM or XChaCha20-Poly1305 content encryption). The `$encryption` block is derived and injected into the protocol definition at install time.

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

Uses X25519 for key agreement (ECDH-ES+A256KW) with AEAD content encryption (AES-256-GCM or XChaCha20-Poly1305). The JWE General JSON Serialization format stores recipients, IV, and authentication tag alongside the encrypted data. In production, `HdIdentityVault.initialize()` always creates the agent DID as `did:dht` with both Ed25519 (`#sig`) and X25519 (`#enc`).

Encryption is declared in the protocol definition via `ProtocolType.encryptionRequired: true`. When set, `DwnDataStore.installProtocol()` derives and injects `$encryption` keys. If the tenant DID lacks an X25519 keyAgreement key, installation fails — no plaintext fallback.

## SQL Schema Migrations

All SQL schema changes use **Kysely's native `Migrator`**. DDL is never inline in store code — stores do a health check (`SELECT 1 FROM <table> LIMIT 0`) on `open()` and throw if the schema is missing.

### Two Migration Domains

The monorepo has two independent migration sets that may target the **same** database:

| Domain | Package | Tables | Tracking table | Runner |
|---|---|---|---|---|
| **DWN stores** | `@enbox/dwn-sql-store` | `messageStoreMessages`, `dataRefs`, `dataBlocks`, `stateIndexMessages`, `resumableTaskMessages` | `kysely_migration` (default) | `runDwnStoreMigrations(db, dialect)` |
| **Server stores** | `@enbox/dwn-server` | `registeredTenants`, `tenantQuotas`, `adminAuditLog`, `adminWebhooks`, `adminPasskeys`, `cacheEntries` | `dwn_server_migration` (custom) | `runServerMigrations(db)` |

Server migrations use custom table names (`dwn_server_migration`, `dwn_server_migration_lock`) to avoid collisions when both domains share a database.

### Key Files

| File | Purpose |
|---|---|
| `packages/dwn-sql-store/src/migration-provider.ts` | `DwnMigrationProvider` — Kysely `MigrationProvider` with closure pattern |
| `packages/dwn-sql-store/src/migration-runner.ts` | `runDwnStoreMigrations()` — convenience entry point |
| `packages/dwn-sql-store/src/migrations/index.ts` | `allDwnMigrations` — ordered `[name, factory]` tuple array |
| `packages/dwn-sql-store/src/migrations/*.ts` | Individual DWN migration files |
| `packages/dwn-server/src/server-migration-runner.ts` | `runServerMigrations()` — server migration entry point |
| `packages/dwn-server/src/migrations/index.ts` | `allServerMigrations` — `Record<string, Migration>` |
| `packages/dwn-server/src/migrations/*.ts` | Individual server migration files |
| `packages/dwn-server/src/storage.ts` | `runServerMigrationsIfNeeded()`, `runSqlMigrationsIfNeeded()`, `getDialectFromUrl()` |

### DWN Store Migrations (closure/factory pattern)

DWN migrations need dialect-specific DDL (e.g., `dialect.hasTable()`, blob column types). Each migration exports a `DwnMigrationFactory` — a function that receives the `Dialect` and returns a Kysely `Migration`:

```typescript
import type { DwnMigrationFactory } from '../migration-provider.js';
import type { Kysely, Migration } from 'kysely';

export const migration004MyChange: DwnMigrationFactory = (dialect): Migration => ({
  async up(db: Kysely<any>): Promise<void> {
    // Use `dialect` for dialect-specific DDL if needed
    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('newColumn', 'text')
      .execute();
  },
});
```

Register in `packages/dwn-sql-store/src/migrations/index.ts`:

```typescript
export const allDwnMigrations = [
  // ... existing migrations ...
  ['004-my-change', migration004MyChange],
] as const;
```

### Server Migrations (plain Kysely `Migration`)

Server tables use only standard SQL types, so no dialect closure is needed — migrations are plain Kysely `Migration` objects:

```typescript
import type { Kysely, Migration } from 'kysely';

export const migration002MyServerChange: Migration = {
  async up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('newTable')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();
  },
};
```

Register in `packages/dwn-server/src/migrations/index.ts`:

```typescript
export const allServerMigrations: Record<string, Migration> = {
  '001-initial-server-schema' : migration001InitialServerSchema,
  '002-my-server-change'      : migration002MyServerChange,
};
```

### Migration Conventions

1. **Naming**: `NNN-kebab-case-description.ts` (e.g., `003-add-squash-column.ts`). Zero-padded 3-digit prefix for sort order.
2. **Forward-only**: Migrations have `up()` only — no `down()`. Rollback is done by deploying a new forward migration.
3. **Idempotent DDL**: Use `ifNotExists()` for `createTable` and `createIndex`. Wrap `alterTable` in try/catch when the column might already exist.
4. **No data migrations**: Migration files are for DDL only. Data migrations belong in application code.
5. **No inline DDL in stores**: Store `open()` / `initialize()` methods must NOT create or alter tables. They perform a `SELECT 1 FROM <table> LIMIT 0` health check and throw if the table is missing.
6. **Run before stores**: Migrations must run before any store `open()` call. In `dwn-server`, `runServerMigrationsIfNeeded()` is called first in `DwnServer.#setupServer()`, before `RegistrationManager.create()` or any admin store creation.

### Startup Order (`DwnServer`)

```
1. runServerMigrationsIfNeeded(config)  → returns serverDialect
2. RegistrationManager.create()         → health-checks registeredTenants
3. getDwnConfig(config)                 → runs DWN migrations, then opens stores
4. HttpApi.create(config, dwn, ...)     → creates Web5ConnectServer with TTL cache
5. AdminApi / audit-log / webhooks      → all use serverDialect
```

### Dialect Sharing

- **`getDialectFromUrl(url)`** — Public. Returns a `Dialect` for the given connection URL. Caches in-memory SQLite (`sqlite://`) in a process-level singleton with a non-closeable wrapper (so no individual consumer can destroy the shared database). File-based SQLite is NOT cached.
- **`getOrCreateDialect(url, config)`** — Private. For DWN stores. Delegates to `getDialectFromUrl` for non-Postgres; maintains a separate `postgresDialectCache` for Postgres with configurable pool sizing.
- **Shared in-memory SQLite**: The cached `sqlite://` dialect wraps `close()` as a no-op, so `DwnServer.stop()` → `Dwn.close()` → store `.close()` cannot destroy the shared database.

### Testing with Migrations

**DWN store tests** (`dwn-sql-store`):
```typescript
const dialect = new SqliteDialect({ database: async () => createBunSqliteDatabase(':memory:') });
const db = new Kysely<any>({ dialect });
await runDwnStoreMigrations(db, dialect);
const store = new MessageStoreSql(dialect);
await store.open();
```

**Server store tests** (`dwn-server`):
```typescript
import { createMigratedInMemoryDialect, createMigratedFileDialect } from './utils.js';

// In-memory (fast, no cleanup):
const dialect = await createMigratedInMemoryDialect();

// File-based (isolated per test file):
const dialect = await createMigratedFileDialect(tmpDir, 'test.db');
```

## AWS Infrastructure & Deployment

### Overview

The `infra/` directory contains Terraform configurations for the AWS deployment. The architecture doc is at `infra/architecture.md`.

| Directory | Purpose |
|---|---|
| `infra/bootstrap/` | One-time Terraform state backend (S3 bucket + DynamoDB lock table) |
| `infra/environments/dev/` | Dev environment Terraform config |
| `infra/environments/prod/` | Prod environment Terraform config |
| `infra/modules/` | Reusable Terraform modules (alb, aurora, ecs-cluster, ecs-service, monitoring, nats, s3-data, vpc) |

### Dev Environment Architecture

| Component | Details |
|---|---|
| **URL** | `https://dev.aws.dwn.enbox.id` |
| **AWS Account** | `387235730938` |
| **Region** | `us-east-1` |
| **ECS Cluster** | `dwn-dev` |
| **ECS Services** | `dwn-dev-http` (HTTP API), `dwn-dev-ws` (WebSocket), `dwn-dev-nats-0` (NATS JetStream) |
| **ECR Repo** | `387235730938.dkr.ecr.us-east-1.amazonaws.com/dwn-server` |
| **ALB** | Internet-facing, TLS 1.3, WebSocket routing via `Upgrade` header |
| **Aurora** | PostgreSQL 15, `db.t4g.medium`, encrypted |
| **S3** | `dwn-dev-store-us-east-1` (data storage) |
| **Secrets** | `dwn/dev/database-url`, `dwn/dev/admin-token`, `dwn/dev/provider-auth-jwt-secret` (Secrets Manager) |
| **Monitoring** | CloudWatch alarms for ALB 5xx, latency P95, ECS CPU/memory, Aurora CPU |

### CI/CD Pipeline

The `.github/workflows/deploy.yml` workflow is triggered on push to `main` when `dwn-server` or its dependencies change. It:
1. Runs the full CI suite
2. Builds a Docker image and pushes to ECR (tagged `sha-<short>`)
3. Force-deploys to the dev ECS cluster
4. (Prod requires manual approval via GitHub Environment protection rules)

**Note:** The deploy workflow requires GitHub repo variables (`AWS_ECR_ROLE_ARN`, `AWS_TERRAFORM_ROLE_ARN`, `ECS_CLUSTER_DEV`, `ECS_SERVICES_DEV`, etc.) to be configured. If these are not set, the workflow will `startup_failure`.

### Manual Deployment

When the CI deploy pipeline is unavailable, deploy manually:

```bash
# 1. Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 387235730938.dkr.ecr.us-east-1.amazonaws.com

# 2. Build and tag the image (from repo root)
SHA_SHORT=$(git rev-parse --short=7 HEAD)
docker build -t 387235730938.dkr.ecr.us-east-1.amazonaws.com/dwn-server:sha-${SHA_SHORT} .

# 3. Push to ECR
docker push 387235730938.dkr.ecr.us-east-1.amazonaws.com/dwn-server:sha-${SHA_SHORT}

# 4. Register new task definitions with the updated image
#    (get current task def, update image, register new revision)
for svc in dwn-dev-http dwn-dev-ws; do
  CURRENT=$(aws ecs describe-services --cluster dwn-dev --services $svc --region us-east-1 --query 'services[0].taskDefinition' --output text)
  aws ecs describe-task-definition --task-definition $CURRENT --region us-east-1 --query 'taskDefinition' | \
    jq "del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy) | .containerDefinitions[0].image = \"387235730938.dkr.ecr.us-east-1.amazonaws.com/dwn-server:sha-${SHA_SHORT}\"" > /tmp/${svc}-task-def.json
  aws ecs register-task-definition --cli-input-json file:///tmp/${svc}-task-def.json --region us-east-1
done

# 5. Update services with new task definitions and force deploy
aws ecs update-service --cluster dwn-dev --service dwn-dev-http --task-definition dwn-dev-http --force-new-deployment --region us-east-1
aws ecs update-service --cluster dwn-dev --service dwn-dev-ws --task-definition dwn-dev-ws --force-new-deployment --region us-east-1

# 6. Wait for services to stabilize
aws ecs wait services-stable --cluster dwn-dev --services dwn-dev-http dwn-dev-ws --region us-east-1
echo "Deployment complete!"

# 7. Verify
curl -sf https://dev.aws.dwn.enbox.id/health && echo " OK"
```

### Dockerfile

The production Dockerfile is at the repo root (`Dockerfile`). It's a 3-stage build (deps -> build -> runtime) using `oven/bun:1-alpine`. When adding new workspace packages, remember to add a `COPY packages/<name>/package.json packages/<name>/` line in both the "deps" and "build" stages so bun workspace resolution succeeds.

### Terraform Operations

```bash
# Plan changes (from infra/environments/dev/):
terraform plan -var certificate_arn="..." -var dwn_image="..."

# Apply changes:
terraform apply -var certificate_arn="..." -var dwn_image="..."
```

State is stored in S3 (`enbox-terraform-state` bucket, `env/dev/terraform.tfstate` key) with DynamoDB locking (`enbox-terraform-locks` table).
