import type { AbstractLevel } from 'abstract-level';

import { isSyncMessageStoreLevelNotFound } from './sync-message-store-level.js';
import { runWithCrossContextLock } from '@enbox/common';

export const SYNC_STORE_FORMAT_KEY = 'enbox:sync-store-format';
export const SYNC_STORE_FORMAT = 'modules-v2';

/** Require a fresh module-format sync store before reading or changing durable state. */
export async function ensureSyncStoreFormat(
  db: AbstractLevel<string | Buffer | Uint8Array>,
  namespace: string,
): Promise<void> {
  await runWithCrossContextLock(`enbox:sync-store-format:${namespace}`, async (): Promise<void> => {
    let format: string | undefined;
    try {
      format = await db.get(SYNC_STORE_FORMAT_KEY);
    } catch (error: unknown) {
      if (!isSyncMessageStoreLevelNotFound(error)) {
        throw error;
      }
    }

    if (format === SYNC_STORE_FORMAT) {
      return;
    }
    if (format !== undefined || (await db.keys({ limit: 1 }).all()).length > 0) {
      throw incompatibleSyncStore();
    }
    await db.put(SYNC_STORE_FORMAT_KEY, SYNC_STORE_FORMAT);
  });
}

function incompatibleSyncStore(): Error {
  return new Error('SyncEngineLevel: incompatible persisted sync format; reinitialize the sync store before using the current sync model.');
}
