import type { DwnMigrationFactory } from '../migration-provider.js';

import { migration001InitialSchema } from './001-initial-schema.js';

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
];
