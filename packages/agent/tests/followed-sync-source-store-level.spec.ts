import type { FollowedModuleScope, FollowedSyncSource } from '../src/followed-sync-source.js';

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
    const source = followedSource({}, {
      modulePaths: ['notebook/page/delta', 'notebook', 'notebook/page'] as [string, ...string[]],
    });

    await store.replace(source);

    expect(await store.get(source.id)).toEqual({
      ...source,
      modules: { [source.rootModule]: { ...source.modules[source.rootModule]!, modulePaths: ['notebook', 'notebook/page', 'notebook/page/delta'] } },
    });
    expect((await store.list())[0]).toEqual({
      status : 'valid',
      source : {
        ...source,
        modules: { [source.rootModule]: { ...source.modules[source.rootModule]!, modulePaths: ['notebook', 'notebook/page', 'notebook/page/delta'] } },
      },
    });
  });

  it('should reject an empty path set', async () => {
    await expect(store.replace(followedSource({}, {
      modulePaths: [] as unknown as [string, ...string[]],
    })))
      .rejects.toThrow('requires at least one readable path');
  });

  it('should reject empty or duplicate role candidates', async () => {
    await expect(store.replace(followedSource({
      roles: [] as unknown as FollowedSyncSource['roles'],
    }))).rejects.toThrow('roles must contain at least one candidate');
    await expect(store.replace(followedSource({
      roles: [
        'notebook/viewer',
        'notebook/viewer',
      ],
    }))).rejects.toThrow('roles must not contain duplicates');
  });

  it('should preserve declared role preference and require the active role among the candidates', async () => {
    const source = followedSource();

    await store.replace(source);

    expect((await store.get(source.id))?.roles).toEqual([
      'notebook/collaborator',
      'notebook/viewer',
    ]);
    await expect(store.replace(followedSource({}, {
      modulePaths : ['notebook'],
      moduleRole  : 'notebook/outsider',
    }))).rejects.toThrow('rootModule must have a verified scope');
  });

  it('requires a verified root and retains explicit unavailable module selections', async () => {
    const source = followedSource();
    await expect(store.replace({ ...source, modules: {} })).rejects.toThrow('rootModule must have a verified scope');
    await expect(store.replace({ ...source, modules: { [source.rootModule]: null } }))
      .rejects.toThrow('rootModule must have a verified scope');
    const selected = { ...source, modules: { ...source.modules, 'https://example.com/realtime': null } };
    await store.replace(selected);
    expect(await store.get(source.id)).toEqual(selected);
  });

  it('does not synthesize the former root scope when reading old rows', async () => {
    const source = followedSource();
    const { modules, rootModule, ...authority } = source;
    const oldRow = { ...authority, module: rootModule, ...modules[rootModule] };
    await db.sublevel('followedSyncSources').put(source.id, JSON.stringify(oldRow));
    expect(await store.get(source.id)).toBeUndefined();
    expect((await store.list())[0]).toMatchObject({ status: 'corrupt', id: source.id });
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
    const replacement = followedSource({ id: 'role-b' }, { moduleRole: 'notebook/collaborator' });
    await store.replace(former);

    await store.replace(replacement, [former.id]);

    expect(await store.get(former.id)).toBeUndefined();
    expect(await store.list()).toEqual([{ status: 'valid', source: replacement }]);
  });
});

function followedSource(overrides: Partial<FollowedSyncSource> = {}, scopeOverrides: Partial<FollowedModuleScope> = {}): FollowedSyncSource {
  const rootModule = 'https://example.com/notebooks';
  const moduleRole = scopeOverrides.moduleRole ?? 'notebook/viewer';
  const modulePaths: [string, ...string[]] = moduleRole === 'notebook/collaborator'
    ? ['notebook', 'notebook/page', 'notebook/page/delta'] : ['notebook', 'notebook/page'];
  return {
    acceptanceId   : 'acceptance-a', id             : 'role-a', sourceDid      : 'did:example:owner',
    remoteEndpoint : 'https://owner.example/dwn', actorDid       : 'did:example:member', rootModule,
    contextId      : 'notebook-a', roles          : ['notebook/collaborator', 'notebook/viewer'],
    modules        : { [rootModule]: { contextPath: 'notebook', moduleRole, modulePaths, ...scopeOverrides } },
    ...overrides,
  };
}
