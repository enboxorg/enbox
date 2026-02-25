import type { Kysely, Migration } from 'kysely';

/**
 * Baseline server migration: creates all DWN server admin and cache tables.
 *
 * Tables:
 * - `registeredTenants`: tenant registration data
 * - `tenantQuotas`: per-tenant storage quotas
 * - `adminAuditLog`: append-only admin event log
 * - `adminWebhooks`: webhook registrations
 * - `adminPasskeys`: WebAuthn admin passkeys
 * - `cacheEntries`: TTL-based key/value cache (Web5 Connect state, etc.)
 */
export const migration001InitialServerSchema: Migration = {

  async up(db: Kysely<any>): Promise<void> {

    // ─── registeredTenants ────────────────────────────────────────────
    await db.schema
      .createTable('registeredTenants')
      .ifNotExists()
      .addColumn('did', 'text', (col) => col.primaryKey())
      .addColumn('termsOfServiceHash', 'text')
      .addColumn('suspended', 'integer', (col) => col.defaultTo(0))
      .addColumn('accountId', 'text')
      .addColumn('registrationType', 'text')
      .addColumn('registeredAt', 'text')
      .addColumn('metadata', 'text')
      .execute();

    // ─── tenantQuotas ─────────────────────────────────────────────────
    await db.schema
      .createTable('tenantQuotas')
      .ifNotExists()
      .addColumn('did', 'text', (col) => col.primaryKey())
      .addColumn('maxMessages', 'integer', (col) => col.defaultTo(0))
      .addColumn('maxStorageBytes', 'bigint', (col) => col.defaultTo(0))
      .execute();

    // ─── adminAuditLog ────────────────────────────────────────────────
    await db.schema
      .createTable('adminAuditLog')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('timestamp', 'text', (col) => col.notNull())
      .addColumn('actor', 'text', (col) => col.notNull())
      .addColumn('action', 'text', (col) => col.notNull())
      .addColumn('target', 'text')
      .addColumn('detail', 'text')
      .execute();

    try {
      await db.schema.createIndex('index_audit_timestamp')
        .ifNotExists().on('adminAuditLog').column('timestamp').execute();
    } catch { /* index already exists */ }

    try {
      await db.schema.createIndex('index_audit_target')
        .ifNotExists().on('adminAuditLog').column('target').execute();
    } catch { /* index already exists */ }

    try {
      await db.schema.createIndex('index_audit_action')
        .ifNotExists().on('adminAuditLog').column('action').execute();
    } catch { /* index already exists */ }

    // ─── adminWebhooks ────────────────────────────────────────────────
    await db.schema
      .createTable('adminWebhooks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('url', 'text', (col) => col.notNull())
      .addColumn('events', 'text', (col) => col.notNull())
      .addColumn('secret', 'text')
      .addColumn('createdAt', 'text', (col) => col.notNull())
      .execute();

    // ─── adminPasskeys ────────────────────────────────────────────────
    await db.schema
      .createTable('adminPasskeys')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('publicKey', 'text', (col) => col.notNull())
      .addColumn('counter', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('transports', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('createdAt', 'text', (col) => col.notNull())
      .addColumn('lastUsedAt', 'text')
      .execute();

    // ─── cacheEntries (TTL cache) ─────────────────────────────────────
    await db.schema
      .createTable('cacheEntries')
      .ifNotExists()
      .addColumn('key', 'varchar(512)', (col) => col.primaryKey())
      .addColumn('value', 'text', (col) => col.notNull())
      .addColumn('expiry', 'bigint', (col) => col.notNull())
      .execute();

    try {
      await db.schema.createIndex('index_expiry')
        .ifNotExists().on('cacheEntries').column('expiry').execute();
    } catch { /* index already exists */ }
  },
};
