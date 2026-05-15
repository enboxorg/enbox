# SQL schema migrations

Reference for SQL schema changes in the Enbox monorepo. Read this when:

- You're adding, modifying, or reviewing files in `packages/dwn-sql-store/src/migrations/` or `packages/dwn-server/src/migrations/`.
- You're touching `packages/dwn-server/src/storage.ts` or any store `open()` / `initialize()` method.
- You're debugging a startup error like "table does not exist" or "migration lock not released".
- You need to understand the dialect-sharing rules (shared in-memory SQLite, Postgres pool caching).

All SQL schema changes use **Kysely's native `Migrator`**. DDL is never inline in store code — stores do a health check (`SELECT 1 FROM <table> LIMIT 0`) on `open()` and throw if the schema is missing.

## Two migration domains

The monorepo has two independent migration sets that may target the **same** database:

| Domain | Package | Tables | Tracking table | Runner |
|---|---|---|---|---|
| **DWN stores** | `@enbox/dwn-sql-store` | `messageStoreMessages`, `dataRefs`, `dataBlocks`, `stateIndexMessages`, `resumableTaskMessages` | `kysely_migration` (default) | `runDwnStoreMigrations(db, dialect)` |
| **Server stores** | `@enbox/dwn-server` | `registeredTenants`, `tenantQuotas`, `adminAuditLog`, `adminWebhooks`, `adminPasskeys`, `cacheEntries` | `dwn_server_migration` (custom) | `runServerMigrations(db, dialect)` |

Server migrations use custom table names (`dwn_server_migration`, `dwn_server_migration_lock`) to avoid collisions when both domains share a database.

## Key files

| File | Purpose |
|---|---|
| `packages/dwn-sql-store/src/migration-provider.ts` | `DwnMigrationProvider` — Kysely `MigrationProvider` with closure pattern |
| `packages/dwn-sql-store/src/migration-runner.ts` | `runDwnStoreMigrations()` — convenience entry point |
| `packages/dwn-sql-store/src/migrations/index.ts` | `allDwnMigrations` — ordered `[name, factory]` tuple array |
| `packages/dwn-sql-store/src/migrations/*.ts` | Individual DWN migration files |
| `packages/dwn-server/src/server-migration-runner.ts` | `runServerMigrations()` — server migration entry point |
| `packages/dwn-server/src/migrations/index.ts` | `allServerMigrations` — ordered `[name, factory]` tuple array |
| `packages/dwn-server/src/migrations/*.ts` | Individual server migration files |
| `packages/dwn-server/src/storage.ts` | `runServerMigrationsIfNeeded()`, `runSqlMigrationsIfNeeded()`, `getDialectFromUrl()` |

## DWN store migrations (closure/factory pattern)

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

## Server migrations (factory pattern)

Server migrations also use the factory/closure pattern (receiving the `Dialect`) because tables like `adminAuditLog` need `dialect.addAutoIncrementingColumn()` for cross-database auto-increment support:

```typescript
import type { Dialect } from '@enbox/dwn-sql-store';
import type { Kysely, Migration } from 'kysely';
import type { ServerMigrationFactory } from './001-initial-server-schema.js';

export const migration002MyServerChange: ServerMigrationFactory = (dialect): Migration => ({
  async up(db: Kysely<any>): Promise<void> {
    let table = db.schema
      .createTable('newTable')
      .ifNotExists()
      .addColumn('name', 'text', (col) => col.notNull());

    // Use dialect helper for portable auto-incrementing primary key
    table = dialect.addAutoIncrementingColumn(table, 'id', (col) => col.primaryKey());
    await table.execute();
  },
});
```

Register in `packages/dwn-server/src/migrations/index.ts`:

```typescript
export const allServerMigrations: ReadonlyArray<readonly [name: string, factory: ServerMigrationFactory]> = [
  ['001-initial-server-schema', migration001InitialServerSchema],
  ['002-my-server-change', migration002MyServerChange],
];
```

## Migration conventions

1. **Naming**: `NNN-kebab-case-description.ts` (e.g., `003-add-squash-column.ts`). Zero-padded 3-digit prefix for sort order.
2. **Forward-only**: Migrations have `up()` only — no `down()`. Rollback is done by deploying a new forward migration.
3. **Idempotent DDL**: Use `ifNotExists()` for `createTable` and `createIndex`. Wrap `alterTable` in try/catch when the column might already exist.
4. **No data migrations**: Migration files are for DDL only. Data migrations belong in application code.
5. **No inline DDL in stores**: Store `open()` / `initialize()` methods must NOT create or alter tables. They perform a `SELECT 1 FROM <table> LIMIT 0` health check and throw if the table is missing.
6. **Run before stores**: Migrations must run before any store `open()` call. In `dwn-server`, `runServerMigrationsIfNeeded()` is called first in `DwnServer.#setupServer()`, before `RegistrationManager.create()` or any admin store creation.

## Startup order (`DwnServer`)

```
1. runServerMigrationsIfNeeded(config)  → returns serverDialect
2. RegistrationManager.create()         → health-checks registeredTenants
3. getDwnConfig(config)                 → runs DWN migrations, then opens stores
4. HttpApi.create(config, dwn, ...)     → creates ConnectServer with TTL cache
5. AdminApi / audit-log / webhooks      → all use serverDialect
```

## Dialect sharing

- **`getDialectFromUrl(url)`** — Public. Returns a `Dialect` for the given connection URL. Caches in-memory SQLite (`sqlite://`) in a process-level singleton with a non-closeable wrapper (so no individual consumer can destroy the shared database). File-based SQLite is NOT cached.
- **`getOrCreateDialect(url, config)`** — Private. For DWN stores. Delegates to `getDialectFromUrl` for non-Postgres; maintains a separate `postgresDialectCache` for Postgres with configurable pool sizing.
- **Shared in-memory SQLite**: The cached `sqlite://` dialect wraps `close()` as a no-op, so `DwnServer.stop()` → `Dwn.close()` → store `.close()` cannot destroy the shared database.

## Testing with migrations

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
