import type { DwnMigrationFactory } from '../migration-provider.js';

import { migration001InitialSchema } from './001-initial-schema.js';
import { migration002ContentAddressedDatastore } from './002-content-addressed-datastore.js';
import { migration003AddSquashColumn } from './003-add-squash-column.js';
import { migration004ReplicationLog } from './004-replication-log.js';
import { migration005AddControlProjectionColumns } from './005-add-control-projection-columns.js';

/**
 * All DWN store migrations in sequential order.
 *
 * Each entry is a `[name, factory]` tuple where the factory is a
 * {@link DwnMigrationFactory} that receives the dialect and returns a
 * standard Kysely `Migration`. The `DwnMigrationProvider` resolves these
 * into the `Record<string, Migration>` that Kysely's `Migrator` expects.
 *
 * **Ordering contract:** Entries MUST be sorted by name (lexicographic).
 * Kysely's `Migrator` sorts by key as well, but maintaining order here
 * makes the source of truth explicit and human-readable.
 */
export const allDwnMigrations: ReadonlyArray<readonly [name: string, factory: DwnMigrationFactory]> = [
  ['001-initial-schema', migration001InitialSchema],
  ['002-content-addressed-datastore', migration002ContentAddressedDatastore],
  ['003-add-squash-column', migration003AddSquashColumn],
  ['004-replication-log', migration004ReplicationLog],
  ['005-add-control-projection-columns', migration005AddControlProjectionColumns],
];
