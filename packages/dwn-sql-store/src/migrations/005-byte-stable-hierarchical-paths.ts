import type { Dialect } from '../dialect/dialect.js';
import type { DwnMigrationFactory } from '../migration-provider.js';
import type { Kysely, Migration } from 'kysely';

import { sql } from 'kysely';

const CONTEXT_INDEX_NAME = 'index_tenant_contextId_messageTimestamp';

/**
 * Gives hierarchical message columns byte-stable ordering so their subtree
 * predicates can use ordinary indexed equality and range comparisons.
 */
export const migration005ByteStableHierarchicalPaths: DwnMigrationFactory = (dialect: Dialect): Migration => ({

  async up(db: Kysely<any>): Promise<void> {
    if (dialect.name === 'SQLite') {
      // SQLite text columns use the byte-stable BINARY collation unless another
      // collation is declared, which the baseline schema does not do.
      await db.schema.createIndex(CONTEXT_INDEX_NAME)
        .ifNotExists()
        .on('messageStoreMessages')
        .columns(['tenant', 'contextId', 'messageTimestamp'])
        .execute();
      return;
    }

    if (dialect.name === 'MySQL') {
      const indexCountResult = await sql<{ indexCount: string }>`
        SELECT COUNT(*) AS indexCount
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'messageStoreMessages'
          AND index_name = ${CONTEXT_INDEX_NAME}
      `.execute(db);
      const dropContextIndex = Number(indexCountResult.rows[0].indexCount) > 0
        ? sql`DROP INDEX ${sql.id(CONTEXT_INDEX_NAME)},`
        : sql``;

      // MySQL DDL implicitly commits. Keep the index replacement and column
      // changes in one atomic MySQL 8 ALTER so a failed migration is retryable.
      await sql`
        ALTER TABLE ${sql.table('messageStoreMessages')}
          ${dropContextIndex}
          MODIFY COLUMN ${sql.ref('protocolPath')} VARCHAR(200)
            CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
          MODIFY COLUMN ${sql.ref('contextId')} VARCHAR(600)
            CHARACTER SET ascii COLLATE ascii_bin NULL,
          ADD INDEX ${sql.id(CONTEXT_INDEX_NAME)} (
            ${sql.ref('tenant')},
            ${sql.ref('contextId')},
            ${sql.ref('messageTimestamp')}
          )
      `.execute(db);
      return;
    }

    await db.schema.dropIndex(CONTEXT_INDEX_NAME).ifExists().execute();
    await sql`
      ALTER TABLE ${sql.table('messageStoreMessages')}
        ALTER COLUMN ${sql.ref('protocolPath')} TYPE VARCHAR(200) COLLATE "C",
        ALTER COLUMN ${sql.ref('contextId')} TYPE VARCHAR(600) COLLATE "C"
    `.execute(db);
    await db.schema.createIndex(CONTEXT_INDEX_NAME)
      .ifNotExists()
      .on('messageStoreMessages')
      .columns(['tenant', 'contextId', 'messageTimestamp'])
      .execute();
  },
});
