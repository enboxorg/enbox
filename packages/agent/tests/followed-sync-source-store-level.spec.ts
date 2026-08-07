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
      protocolPaths: ['notebook/page/delta', 'notebook', 'notebook/page'] as [string, ...string[]],
    });

    await store.replace(source);

    expect(await store.get(source.id)).toEqual({
      ...source,
      protocolPaths: ['notebook', 'notebook/page', 'notebook/page/delta'],
    });
    expect((await store.list())[0]).toEqual({
      status : 'valid',
      source : {
        ...source,
        protocolPaths: ['notebook', 'notebook/page', 'notebook/page/delta'],
      },
    });
  });

  it('should reject an empty path set', async () => {
    await expect(store.replace(followedSource({
      protocolPaths: [] as unknown as [string, ...string[]],
    })))
      .rejects.toThrow('\'protocolPaths\' must contain non-empty paths');
  });

  it('should reject an empty or duplicate role group', async () => {
    await expect(store.replace(followedSource({
      roles: [] as unknown as FollowedSyncSource['roles'],
    }))).rejects.toThrow('\'roles\' must contain at least one role');
    await expect(store.replace(followedSource({
      roles: [
        'notebook/viewer',
        'notebook/viewer',
      ],
    }))).rejects.toThrow('\'roles\' must not contain duplicate roles');
  });

  it('should preserve role priority and require the active role to belong to the group', async () => {
    const source = followedSource();

    await store.replace(source);

    expect((await store.get(source.id))?.roles).toEqual([
      'notebook/collaborator',
      'notebook/viewer',
    ]);
    await expect(store.replace(followedSource({
      protocolPaths : ['notebook'],
      protocolRole  : 'notebook/outsider',
    }))).rejects.toThrow('active role must belong to \'roles\'');
  });

  it('should reject role candidates for different context roots', async () => {
    await expect(store.replace(followedSource({
      roles: [
        'notebook/viewer',
        'project/viewer',
      ],
    }))).rejects.toThrow('every role must authorize the same context root');
  });

  it('should return undefined for a missing source and delete one source', async () => {
    const source = followedSource();

    expect(await store.get(source.id)).toBeUndefined();
    await store.replace(source);
    await store.delete(source.id);
    expect(await store.get(source.id)).toBeUndefined();
  });

  it('should isolate a corrupt source without hiding valid sources', async () => {
    const sources = db.sublevel('followedSyncSources');
    const source = followedSource({ id: 'role-b' });
    await sources.put('role-a', '{');
    await store.replace(source);

    const entries = await store.list();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ status: 'corrupt', id: 'role-a' });
    expect(entries[1]).toEqual({ status: 'valid', source });
  });

  it('should replace corrupt stored data when the same role is followed again', async () => {
    const sources = db.sublevel('followedSyncSources');
    await sources.put('role-a', JSON.stringify(followedSource({ id: 'role-b' })));

    expect(await store.get('role-a')).toBeUndefined();
    await store.replace(followedSource());
    expect(await store.get('role-a')).toEqual(followedSource());
  });

  it('should atomically replace former followed sources', async () => {
    const former = followedSource();
    const replacement = followedSource({ id: 'role-b', protocolRole: 'notebook/collaborator' });
    await store.replace(former);

    await store.replace(replacement, [former.id]);

    expect(await store.get(former.id)).toBeUndefined();
    expect(await store.list()).toEqual([{ status: 'valid', source: replacement }]);
  });
});

function followedSource(overrides: Partial<FollowedSyncSource> = {}): FollowedSyncSource {
  const protocolRole = overrides.protocolRole ?? 'notebook/viewer';
  const protocolPaths = overrides.protocolPaths ?? (protocolRole === 'notebook/collaborator'
    ? ['notebook', 'notebook/page', 'notebook/page/delta']
    : ['notebook', 'notebook/page']);
  return {
    acceptanceId   : 'acceptance-a',
    id             : 'role-a',
    sourceDid      : 'did:example:owner',
    remoteEndpoint : 'https://owner.example/dwn',
    actorDid       : 'did:example:member',
    protocol       : 'https://example.com/notebooks',
    contextId      : 'notebook-a',
    protocolRole,
    protocolPaths,
    roles          : ['notebook/collaborator', 'notebook/viewer'],
    ...overrides,
  };
}
