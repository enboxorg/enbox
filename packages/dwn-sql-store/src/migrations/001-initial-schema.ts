import type { Dialect } from '../dialect/dialect.js';
import type { DwnMigrationFactory } from '../migration-provider.js';
import type { Kysely, Migration, RawBuilder } from 'kysely';

import { sql } from 'kysely';

function hierarchicalColumnTypes(dialect: Dialect): {
  modulePathType: 'varchar(200)' | RawBuilder<unknown>;
  contextIdType: 'varchar(600)' | RawBuilder<unknown>;
} {
  if (dialect.name === 'SQLite') {
    // SQLite text columns use the byte-stable BINARY collation by default.
    return {
      modulePathType : 'varchar(200)',
      contextIdType  : 'varchar(600)',
    };
  }

  if (dialect.name === 'MySQL') {
    return {
      modulePathType : sql`varchar(200) character set utf8mb4 collate utf8mb4_0900_bin`,
      contextIdType  : sql`varchar(600) character set ascii collate ascii_bin`,
    };
  }

  return {
    modulePathType : sql`varchar(200) collate "C"`,
    contextIdType  : sql`varchar(600) collate "C"`,
  };
}

/**
 * Canonical baseline schema for DWN SQL stores.
 *
 * Creates the message store (with embedded replication log columns and
 * byte-stable hierarchical path collations), record tag index table,
 * content-addressed data store (`dataRefs` + `dataBlocks`), resumable task
 * store, and replication state tables (`replicationCounters`,
 * `replicationFingerprints`, `replicationMeta`).
 */
export const migration001InitialSchema: DwnMigrationFactory = (dialect: Dialect): Migration => ({

  async up(db: Kysely<any>): Promise<void> {
    const { modulePathType, contextIdType } = hierarchicalColumnTypes(dialect);

    // messageStoreMessages
    if (!(await dialect.hasTable(db, 'messageStoreMessages'))) {
      let table = db.schema
        .createTable('messageStoreMessages')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('messageCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('seq', 'bigint', (col) => col.notNull())
        .addColumn('fingerprintScopes', 'text', (col) => col.notNull())
        .addColumn('interface', 'varchar(20)')
        .addColumn('method', 'varchar(20)')
        .addColumn('recordId', 'varchar(60)')
        .addColumn('entryId', 'varchar(60)')
        .addColumn('parentId', 'varchar(60)')
        .addColumn('module', 'varchar(200)')
        .addColumn('modulePath', modulePathType)
        .addColumn('contextId', contextIdType)
        .addColumn('schema', 'varchar(200)')
        .addColumn('author', 'varchar(255)')
        .addColumn('recipient', 'varchar(255)')
        .addColumn('messageTimestamp', 'varchar(30)')
        .addColumn('dateCreated', 'varchar(30)')
        .addColumn('datePublished', 'varchar(30)')
        .addColumn('isLatestBaseState', 'boolean')
        .addColumn('published', 'boolean')
        .addColumn('prune', 'boolean')
        .addColumn('squash', 'boolean')
        .addColumn('dataFormat', 'varchar(30)')
        .addColumn('dataCid', 'varchar(60)')
        .addColumn('dataSize', 'integer')
        .addColumn('encodedData', 'text')
        .addColumn('attester', 'text')
        .addColumn('permissionGrantId', 'varchar(60)');

      table = dialect.addAutoIncrementingColumn(table, 'id', (col) => col.primaryKey());
      table = dialect.addBlobColumn(table, 'encodedMessageBytes', (col) => col.notNull());
      await table.execute();

      await db.schema.createIndex('index_tenant_messageCid')
        .on('messageStoreMessages').columns(['tenant', 'messageCid']).unique().execute();

      await db.schema.createIndex('index_messageStoreMessages_tenant_seq')
        .on('messageStoreMessages').columns(['tenant', 'seq']).unique().execute();

      await db.schema.createIndex('index_messageStoreMessages_tenant_module_seq')
        .on('messageStoreMessages').columns(['tenant', 'module', 'seq']).execute();

      const indexes = [
        ['tenant', 'recordId'],
        ['tenant', 'entryId'],
        ['tenant', 'parentId'],
        ['tenant', 'module', 'published', 'messageTimestamp'],
        ['tenant', 'interface'],
        ['tenant', 'permissionGrantId'],
        ['tenant', 'dateCreated'],
        ['tenant', 'datePublished'],
        ['tenant', 'contextId', 'messageTimestamp'],
      ];

      for (const cols of indexes) {
        await db.schema.createIndex('index_' + cols.join('_'))
          .on('messageStoreMessages').columns(cols).execute();
      }
    }

    // messageStoreRecordsTags
    if (!(await dialect.hasTable(db, 'messageStoreRecordsTags'))) {
      let table = db.schema
        .createTable('messageStoreRecordsTags')
        .ifNotExists()
        .addColumn('tag', 'varchar(30)', (col) => col.notNull())
        .addColumn('valueString', 'varchar(200)')
        .addColumn('valueNumber', 'decimal');

      table = dialect.addAutoIncrementingColumn(table, 'id', (col) => col.primaryKey());
      table = dialect.addReferencedColumn(
        table, 'messageStoreRecordsTags', 'messageInsertId', 'integer',
        'messageStoreMessages', 'id', 'cascade'
      );
      await table.execute();

      const tagIndexes = [
        ['messageInsertId'],
        ['tag', 'valueString'],
        ['tag', 'valueNumber'],
      ];
      for (const cols of tagIndexes) {
        await db.schema.createIndex('index_' + cols.join('_'))
          .on('messageStoreRecordsTags').columns(cols).execute();
      }
    }

    // dataRefs
    if (!(await dialect.hasTable(db, 'dataRefs'))) {
      await db.schema
        .createTable('dataRefs')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('recordId', 'varchar(60)', (col) => col.notNull())
        .addColumn('dataCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('dataSize', 'bigint', (col) => col.notNull())
        .execute();

      await db.schema.createIndex('index_dataRefs_tenant_recordId_dataCid')
        .on('dataRefs').columns(['tenant', 'recordId', 'dataCid']).unique().execute();

      await db.schema.createIndex('index_dataRefs_dataCid')
        .on('dataRefs').column('dataCid').execute();

      await db.schema.createIndex('index_dataRefs_tenant')
        .on('dataRefs').column('tenant').execute();
    }

    // dataBlocks
    if (!(await dialect.hasTable(db, 'dataBlocks'))) {
      let table = db.schema
        .createTable('dataBlocks')
        .ifNotExists()
        .addColumn('rootDataCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('blockCid', 'varchar(60)', (col) => col.notNull());

      table = dialect.addBlobColumn(table, 'data', (col) => col.notNull());
      await table.execute();

      await db.schema.createIndex('index_dataBlocks_rootDataCid_blockCid')
        .on('dataBlocks').columns(['rootDataCid', 'blockCid']).unique().execute();
    }

    // resumableTasks
    if (!(await dialect.hasTable(db, 'resumableTasks'))) {
      await db.schema
        .createTable('resumableTasks')
        .ifNotExists()
        .addColumn('id', 'varchar(255)', (col) => col.primaryKey())
        .addColumn('task', 'text')
        .addColumn('timeout', 'bigint')
        .addColumn('retryCount', 'integer')
        .execute();

      await db.schema.createIndex('index_timeout')
        .on('resumableTasks').column('timeout').execute();
    }

    // replicationCounters
    if (!(await dialect.hasTable(db, 'replicationCounters'))) {
      await db.schema
        .createTable('replicationCounters')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.primaryKey())
        .addColumn('seq', 'bigint', (col) => col.notNull())
        .execute();
    }

    // replicationFingerprints
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

    // replicationMeta
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
