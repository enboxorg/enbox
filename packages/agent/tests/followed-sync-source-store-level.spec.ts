import type { FollowedSyncSource } from '../src/followed-sync-source.js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { FollowedSyncSourceStoreLevel } from '../src/followed-sync-source-store-level.js';

describe('FollowedSyncSourceStoreLevel', () => {
  let db: Level<string, string>;
  let store: FollowedSyncSourceStoreLevel;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/followed-sync-source-store-level-spec');
    store = new FollowedSyncSourceStoreLevel(db);
  });

  afterEach(async () => {
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should persist a source under its role record ID with canonical paths', async () => {
    const source = followedSource({
      protocolPaths: ['notebook/page/delta', 'notebook/page', 'notebook/page'] as [string, ...string[]],
    });

    await store.set(source);

    expect(await store.get(source.id)).toEqual({
      ...source,
      protocolPaths: ['notebook/page', 'notebook/page/delta'],
    });
    expect((await store.list())[0]).toEqual({
      status : 'valid',
      source : { ...source, protocolPaths: ['notebook/page', 'notebook/page/delta'] },
    });
  });

  it('should reject an empty path set', async () => {
    await expect(store.set(followedSource({ protocolPaths: [] as unknown as [string, ...string[]] })))
      .rejects.toThrow('\'protocolPaths\' must contain non-empty paths');
  });

  it('should return undefined for a missing source and delete one source', async () => {
    const source = followedSource();

    expect(await store.get(source.id)).toBeUndefined();
    await store.set(source);
    await store.delete(source.id);
    expect(await store.get(source.id)).toBeUndefined();
  });

  it('should isolate a corrupt source without hiding valid sources', async () => {
    const sources = db.sublevel('followedSyncSources');
    const source = followedSource({ id: 'role-b' });
    await sources.put('role-a', '{');
    await store.set(source);

    const entries = await store.list();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ status: 'corrupt', id: 'role-a' });
    expect(entries[1]).toEqual({ status: 'valid', source });
  });

  it('should replace corrupt stored data when the same role is followed again', async () => {
    const sources = db.sublevel('followedSyncSources');
    await sources.put('role-a', JSON.stringify(followedSource({ id: 'role-b' })));

    expect(await store.get('role-a')).toBeUndefined();
    await store.set(followedSource());
    expect(await store.get('role-a')).toEqual(followedSource());
  });
});

function followedSource(overrides: Partial<FollowedSyncSource> = {}): FollowedSyncSource {
  return {
    id            : 'role-a',
    sourceDid     : 'did:example:owner',
    actorDid      : 'did:example:member',
    protocol      : 'https://example.com/notebooks',
    contextId     : 'notebook-a',
    protocolRole  : 'notebook/viewer',
    protocolPaths : ['notebook/page'],
    ...overrides,
  };
}
