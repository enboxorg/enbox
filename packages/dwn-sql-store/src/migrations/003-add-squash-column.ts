import type { DwnMigrationFactory } from '../migration-provider.js';
import type { Kysely, Migration } from 'kysely';

/**
 * Migration 003: Add `squash` boolean column to `messageStoreMessages`.
 *
 * The `squash` column is an index for the `$squash` protocol directive
 * introduced in the DWN spec. It follows the same pattern as `published`
 * and `prune` — a nullable boolean column used for query filtering.
 */
export const migration003AddSquashColumn: DwnMigrationFactory = (): Migration => ({

  async up(db: Kysely<any>): Promise<void> {
    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('squash', 'boolean')
      .execute();
  },
});
