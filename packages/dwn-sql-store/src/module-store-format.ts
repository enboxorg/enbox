import type { Kysely } from 'kysely';

import { DwnError, DwnErrorCode } from '@enbox/dwn-sdk-js';

/** Reject the removed wire/storage format before running migrations or opening a store. */
export async function assertModuleStoreFormat(db: Kysely<any>): Promise<void> {
  const tables = await db.introspection.getTables();
  const messages = tables.find(table => table.name === 'messageStoreMessages');
  if (messages === undefined) {
    return;
  }

  const columns = new Set(messages.columns.map(column => column.name));
  if (!columns.has('module') || !columns.has('modulePath') || columns.has('protocol') || columns.has('protocolPath')) {
    throw new DwnError(
      DwnErrorCode.MessageStoreIncompatibleFormat,
      'SQL message store uses an incompatible format; reinitialize the database before opening stores'
    );
  }
}
