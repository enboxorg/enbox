import type { AbstractLevel } from 'abstract-level';

import { runWithCrossContextLock } from '@enbox/common';

export const SYNC_STORE_FORMAT_KEY = 'enbox:sync-store-format';
export const SYNC_STORE_FORMAT = 'modules-v1';

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
      if ((error as { code?: string }).code !== 'LEVEL_NOT_FOUND') {
        throw error;
      }
    }

    if (format === SYNC_STORE_FORMAT) {
      return;
    }
    if (format !== undefined) {
      throw incompatibleSyncStore();
    }

    const existingKeys = await db.keys({ limit: 1 }).all();
    if (existingKeys.length > 0) {
      throw incompatibleSyncStore();
    }
    await db.put(SYNC_STORE_FORMAT_KEY, SYNC_STORE_FORMAT);
  });
}

function incompatibleSyncStore(): Error {
  return new Error('SyncEngineLevel: incompatible persisted sync format; reinitialize the sync store before using modules.');
}
