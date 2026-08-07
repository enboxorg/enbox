import type { AbstractLevel } from 'abstract-level';

import type {
  FollowedSyncSource,
  FollowedSyncSourceStore,
  FollowedSyncSourceStoreEntry,
} from './followed-sync-source.js';

import { normalizeFollowedSyncSource } from './followed-sync-source.js';

type LevelKey = string | Buffer | Uint8Array;

/** Level-backed persistence for accepted foreign context sources. */
export class FollowedSyncSourceStoreLevel implements FollowedSyncSourceStore {
  private readonly _db: AbstractLevel<LevelKey>;

  public constructor(db: AbstractLevel<LevelKey>) {
    this._db = db;
  }

  private get sources(): AbstractLevel<LevelKey, string, string> {
    return this._db.sublevel('followedSyncSources');
  }

  public async delete(id: string): Promise<void> {
    await this.sources.del(id);
  }

  public async get(id: string): Promise<FollowedSyncSource | undefined> {
    let value: string;
    try {
      value = await this.sources.get(id);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }

    try {
      return FollowedSyncSourceStoreLevel.parse(id, value);
    } catch {
      return undefined;
    }
  }

  public async list(): Promise<FollowedSyncSourceStoreEntry[]> {
    const entries: FollowedSyncSourceStoreEntry[] = [];
    for await (const [id, value] of this.sources.iterator()) {
      try {
        entries.push({ status: 'valid', source: FollowedSyncSourceStoreLevel.parse(id, value) });
      } catch (error: unknown) {
        entries.push({ status: 'corrupt', id, error });
      }
    }
    return entries;
  }

  public async replace(source: FollowedSyncSource, replacedIds: readonly string[] = []): Promise<void> {
    const normalized = normalizeFollowedSyncSource(source);
    const batch = this.sources.batch().put(normalized.id, JSON.stringify(normalized));
    for (const id of new Set(replacedIds)) {
      if (id !== normalized.id) {
        batch.del(id);
      }
    }
    await batch.write();
  }

  private static parse(id: string, value: string): FollowedSyncSource {
    const source = normalizeFollowedSyncSource(JSON.parse(value) as FollowedSyncSource);
    if (source.id !== id) {
      throw new TypeError(`FollowedSyncSourceStoreLevel: source '${id}' contains role record ID '${source.id}'.`);
    }
    return source;
  }
}
