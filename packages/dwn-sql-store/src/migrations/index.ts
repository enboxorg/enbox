import type { Migration } from '../migration-runner.js';

import { migration001InitialSchema } from './001-initial-schema.js';
import { migration002ContentAddressedDatastore } from './002-content-addressed-datastore.js';
import { migration003AddSquashColumn } from './003-add-squash-column.js';

/**
 * All migrations in sequential order. The MigrationRunner applies them
 * in array order, skipping any that have already been recorded.
 */
export const allMigrations: Migration[] = [
  migration001InitialSchema,
  migration002ContentAddressedDatastore,
  migration003AddSquashColumn,
];
