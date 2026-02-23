import type { Dialect } from '../dialect/dialect.js';
import type { Kysely } from 'kysely';
import type { Migration } from '../migration-runner.js';

/**
 * Migration 003: Add `squash` boolean column to `messageStoreMessages`.
 *
 * The `squash` column is an index for the `$squash` protocol directive
 * introduced in the DWN spec. It follows the same pattern as `published`
 * and `prune` — a nullable boolean column used for query filtering.
 */
export const migration003AddSquashColumn: Migration = {
  name: '003-add-squash-column',

  async up(db: Kysely<any>, _dialect: Dialect): Promise<void> {
    await db.schema
      .alterTable('messageStoreMessages')
      .addColumn('squash', 'boolean')
      .execute();
  },
};
