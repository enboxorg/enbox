import type { ServerMigrationFactory } from './001-initial-server-schema.js';

import { migration001InitialServerSchema } from './001-initial-server-schema.js';
import { migration002WidenCacheValues } from './002-widen-cache-values.js';

/**
 * All DWN server migrations in sequential order.
 *
 * Each entry is a `[name, factory]` tuple where the factory receives the
 * `Dialect` and returns a standard Kysely `Migration`. This mirrors the
 * pattern used by DWN store migrations in `@enbox/dwn-sql-store`.
 *
 * **Ordering contract:** Entries MUST be sorted by name (lexicographic).
 */
export type { ServerMigrationFactory };

export const allServerMigrations: ReadonlyArray<readonly [name: string, factory: ServerMigrationFactory]> = [
  ['001-initial-server-schema', migration001InitialServerSchema],
  ['002-widen-cache-values', migration002WidenCacheValues],
];
