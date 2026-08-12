import type { ServerMigrationFactory } from './001-initial-server-schema.js';
import type { Kysely, Migration } from 'kysely';

import { sql } from 'kysely';

/** Allows MySQL relay cache entries to hold the maximum Connect frame size. */
export const migration002WidenCacheValues: ServerMigrationFactory = (dialect): Migration => ({
  async up(db: Kysely<any>): Promise<void> {
    if (dialect.name !== 'MySQL') {
      return;
    }

    await db.schema
      .alterTable('cacheEntries')
      .modifyColumn('value', sql`mediumtext`, (col) => col.notNull())
      .execute();
  },
});
