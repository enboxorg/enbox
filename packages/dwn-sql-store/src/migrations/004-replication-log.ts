import type { Dialect } from '../dialect/dialect.js';
import type { DwnMigrationFactory } from '../migration-provider.js';
import type { Kysely, Migration } from 'kysely';

/**
 * Migration 004: durable replication log substrate for SQL stores.
 *
 * The log is represented by `messageStoreMessages` itself: each live row gets an original `seq`,
 * optional completion `redeliverSeq`, and persisted fingerprint-domain membership. Fresh stores
 * fill these columns for every write; existing pre-substrate rows are intentionally not backfilled.
 */
export const migration004ReplicationLog: DwnMigrationFactory = (dialect: Dialect): Migration => ({

  async up(db: Kysely<any>): Promise<void> {
    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('seq', 'bigint')
      .execute();

    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('redeliverSeq', 'bigint')
      .execute();

    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('fingerprintScopes', 'text')
      .execute();

    await db.schema.createIndex('index_messageStoreMessages_tenant_seq')
      .on('messageStoreMessages')
      .columns(['tenant', 'seq'])
      .unique()
      .execute();

    await db.schema.createIndex('index_messageStoreMessages_tenant_redeliverSeq')
      .on('messageStoreMessages')
      .columns(['tenant', 'redeliverSeq'])
      .unique()
      .execute();

    await db.schema.createIndex('index_messageStoreMessages_tenant_protocol_seq')
      .on('messageStoreMessages')
      .columns(['tenant', 'protocol', 'seq'])
      .execute();

    if (!(await dialect.hasTable(db, 'replicationCounters'))) {
      await db.schema
        .createTable('replicationCounters')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.primaryKey())
        .addColumn('seq', 'bigint', (col) => col.notNull())
        .execute();
    }

    if (!(await dialect.hasTable(db, 'replicationFingerprints'))) {
      await db.schema
        .createTable('replicationFingerprints')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('scope', 'varchar(512)', (col) => col.notNull())
        .addColumn('fingerprint', 'varchar(64)', (col) => col.notNull())
        .execute();

      await db.schema.createIndex('index_replicationFingerprints_tenant_scope')
        .on('replicationFingerprints')
        .columns(['tenant', 'scope'])
        .unique()
        .execute();
    }

    if (!(await dialect.hasTable(db, 'replicationMeta'))) {
      await db.schema
        .createTable('replicationMeta')
        .ifNotExists()
        .addColumn('key', 'varchar(100)', (col) => col.primaryKey())
        .addColumn('value', 'text', (col) => col.notNull())
        .execute();
    }
  },
});
