import type { DwnMigrationFactory } from '../migration-provider.js';
import type { Kysely, Migration } from 'kysely';

/**
 * Migration 005: Add source-protocol encryption control projection columns.
 *
 * These columns are store-managed indexes for control-record visibility and
 * sync projection. They are intentionally not record tags.
 */
export const migration005AddControlProjectionColumns: DwnMigrationFactory = (): Migration => ({

  async up(db: Kysely<any>): Promise<void> {
    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('controlClass', 'varchar(20)')
      .execute();

    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('roleAudienceHash', 'varchar(43)')
      .execute();

    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('recipientHash', 'varchar(43)')
      .execute();

    await db.schema.createIndex('index_messageStoreMessages_tenant_protocol_controlClass')
      .on('messageStoreMessages')
      .columns(['tenant', 'protocol', 'controlClass'])
      .execute();

    await db.schema.createIndex('index_messageStoreMessages_tenant_control_roleAudienceHash')
      .on('messageStoreMessages')
      .columns(['tenant', 'controlClass', 'roleAudienceHash'])
      .execute();

    await db.schema.createIndex('index_messageStoreMessages_tenant_control_recipientHash')
      .on('messageStoreMessages')
      .columns(['tenant', 'controlClass', 'recipientHash'])
      .execute();
  },
});
