import type { Migration } from 'kysely';

import { migration001InitialServerSchema } from './001-initial-server-schema.js';

/**
 * All DWN server migrations in sequential order.
 *
 * These migrations manage tables owned by `@enbox/dwn-server` (admin stores,
 * registration, TTL cache, etc.). They are separate from the DWN store
 * migrations in `@enbox/dwn-sql-store` which manage core DWN tables.
 *
 * Server migrations use plain Kysely `Migration` objects (no dialect closure
 * needed) because server tables use only standard SQL types.
 */
export const allServerMigrations: Record<string, Migration> = {
  '001-initial-server-schema': migration001InitialServerSchema,
};
