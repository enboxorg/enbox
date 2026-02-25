import type { Dialect } from '../dialect/dialect.js';
import type { Kysely } from 'kysely';
import type { Migration } from '../migration-runner.js';

import { sql } from 'kysely';

/**
 * Baseline migration: captures the schema as of the pre-migration era.
 *
 * For existing databases that already have these tables, this migration is
 * detected as "already applied" during the adoption bootstrap (see MigrationRunner).
 * For new databases, this creates the full initial schema.
 */
export const migration001InitialSchema: Migration = {
  name: '001-initial-schema',

  async up(db: Kysely<any>, dialect: Dialect): Promise<void> {

    // ─── messageStoreMessages ───────────────────────────────────────────
    if (!(await dialect.hasTable(db, 'messageStoreMessages'))) {
      let table = db.schema
        .createTable('messageStoreMessages')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('messageCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('interface', 'varchar(20)')
        .addColumn('method', 'varchar(20)')
        .addColumn('recordId', 'varchar(60)')
        .addColumn('entryId', 'varchar(60)')
        .addColumn('parentId', 'varchar(60)')
        .addColumn('protocol', 'varchar(200)')
        .addColumn('protocolPath', 'varchar(200)')
        .addColumn('contextId', 'varchar(600)')
        .addColumn('schema', 'varchar(200)')
        .addColumn('author', 'varchar(255)')
        .addColumn('recipient', 'varchar(255)')
        .addColumn('messageTimestamp', 'varchar(30)')
        .addColumn('dateCreated', 'varchar(30)')
        .addColumn('datePublished', 'varchar(30)')
        .addColumn('isLatestBaseState', 'boolean')
        .addColumn('published', 'boolean')
        .addColumn('prune', 'boolean')
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

      const indexes = [
        ['tenant', 'recordId'],
        ['tenant', 'entryId'],
        ['tenant', 'parentId'],
        ['tenant', 'protocol', 'published', 'messageTimestamp'],
        ['tenant', 'interface'],
        ['tenant', 'permissionGrantId'],
        ['tenant', 'dateCreated'],
        ['tenant', 'datePublished'],
      ];

      for (const cols of indexes) {
        await db.schema.createIndex('index_' + cols.join('_'))
          .on('messageStoreMessages').columns(cols).execute();
      }

      // MySQL needs prefix length for contextId
      if (dialect.name === 'MySQL') {
        await sql`CREATE INDEX index_tenant_contextId_messageTimestamp
          ON ${sql.table('messageStoreMessages')} (tenant, contextId(480), messageTimestamp)`
          .execute(db);
      } else {
        await db.schema.createIndex('index_tenant_contextId_messageTimestamp')
          .on('messageStoreMessages').columns(['tenant', 'contextId', 'messageTimestamp']).execute();
      }
    }

    // ─── messageStoreRecordsTags ─────────────────────────────────────────
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

    // ─── dataStore ──────────────────────────────────────────────────────
    if (!(await dialect.hasTable(db, 'dataStore'))) {
      let table = db.schema
        .createTable('dataStore')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('recordId', 'varchar(60)', (col) => col.notNull())
        .addColumn('dataCid', 'varchar(60)', (col) => col.notNull());

      table = dialect.addAutoIncrementingColumn(table, 'id', (col) => col.primaryKey());
      table = dialect.addBlobColumn(table, 'data', (col) => col.notNull());
      await table.execute();

      await db.schema.createIndex('tenant_recordId_dataCid')
        .on('dataStore').columns(['tenant', 'recordId', 'dataCid']).unique().execute();
    }

    // ─── resumableTasks ─────────────────────────────────────────────────
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

    // ─── stateIndexNodes ────────────────────────────────────────────────
    if (!(await dialect.hasTable(db, 'stateIndexNodes'))) {
      await db.schema
        .createTable('stateIndexNodes')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('scope', 'varchar(200)', (col) => col.notNull())
        .addColumn('nodeHash', 'varchar(64)', (col) => col.notNull())
        .addColumn('nodeType', 'varchar(10)', (col) => col.notNull())
        .addColumn('leftHash', 'varchar(64)')
        .addColumn('rightHash', 'varchar(64)')
        .addColumn('leafKeyHash', 'varchar(64)')
        .addColumn('leafValueCid', 'varchar(60)')
        .execute();

      await db.schema.createIndex('index_stateIndexNodes_tenant_scope_nodeHash')
        .on('stateIndexNodes').columns(['tenant', 'scope', 'nodeHash']).execute();
    }

    // ─── stateIndexRoots ────────────────────────────────────────────────
    if (!(await dialect.hasTable(db, 'stateIndexRoots'))) {
      await db.schema
        .createTable('stateIndexRoots')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('scope', 'varchar(200)', (col) => col.notNull())
        .addColumn('rootHash', 'varchar(64)', (col) => col.notNull())
        .execute();

      await db.schema.createIndex('index_stateIndexRoots_tenant_scope')
        .on('stateIndexRoots').columns(['tenant', 'scope']).execute();
    }

    // ─── stateIndexMeta ─────────────────────────────────────────────────
    if (!(await dialect.hasTable(db, 'stateIndexMeta'))) {
      await db.schema
        .createTable('stateIndexMeta')
        .ifNotExists()
        .addColumn('tenant', 'varchar(255)', (col) => col.notNull())
        .addColumn('messageCid', 'varchar(60)', (col) => col.notNull())
        .addColumn('protocol', 'varchar(200)')
        .execute();

      await db.schema.createIndex('index_stateIndexMeta_tenant_messageCid')
        .on('stateIndexMeta').columns(['tenant', 'messageCid']).execute();
    }
  },
};
