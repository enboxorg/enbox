import type { AbstractLevel } from 'abstract-level';
import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState } from '../src/types/sync.js';

import { SyncReplicationLinkStoreLevel } from '../src/sync-replication-link-store-level.js';

import { deferred as createDeferred } from './utils/deferred.js';

const ownerAuthorization = {
  authorization      : { kind: 'owner' as const },
  authorizationEpoch : 'owner-epoch',
};

function token(position: number, domain = 'one'): ProgressToken {
  return {
    epoch      : `epoch-${domain}`,
    messageCid : `cid-${position}`,
    position   : String(position),
    streamId   : `stream-${domain}`,
  };
}

function makeLink(): ReplicationLinkState {
  return {
    authorization      : ownerAuthorization.authorization,
    authorizationEpoch : ownerAuthorization.authorizationEpoch,
    connectivity       : 'unknown',
    projectionId       : 'projection-id',
    pull               : {},
    push               : {},
    remoteEndpoint     : 'https://dwn.example.com',
    scope              : { kind: 'full' },
    status             : 'initializing',
    tenantDid          : 'did:example:alice',
  };
}

describe('SyncReplicationLinkStoreLevel', () => {
  let db: Level<string, string>;
  let store: SyncReplicationLinkStoreLevel;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-replication-link-store-level-spec');
    store = new SyncReplicationLinkStoreLevel(db);
  });

  afterEach(async () => {
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should preserve the existing compound key and JSON representation', async () => {
    const link = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });

    const raw = await db.sublevel('replicationLinks').get(
      `${link.tenantDid}^${link.remoteEndpoint}^${link.projectionId}^${link.authorizationEpoch}`,
    );

    expect(JSON.parse(raw)).toEqual(link);
  });

  it('should preserve pull and push progress from concurrent stale snapshots', async () => {
    const pullLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    const pushLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    pullLink.pull = { contiguousAppliedToken: token(10) };
    pushLink.push = { contiguousAppliedToken: token(20) };

    await Promise.all([
      store.persistCheckpoint(pullLink, 'pull'),
      store.persistCheckpoint(pushLink, 'push'),
    ]);

    const [persisted] = await store.getAllLinks();
    expect(persisted.pull).toEqual(pullLink.pull);
    expect(persisted.push).toEqual(pushLink.push);
  });

  it('should preserve a concurrent status transition and checkpoint update', async () => {
    const statusLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    const checkpointLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    statusLink.connectivity = 'offline';
    checkpointLink.push = { contiguousAppliedToken: token(30) };

    await Promise.all([
      store.setStatus(statusLink, 'repairing'),
      store.persistCheckpoint(checkpointLink, 'push'),
    ]);

    const [persisted] = await store.getAllLinks();
    expect(persisted.status).toBe('repairing');
    expect(persisted.connectivity).toBe('offline');
    expect(persisted.push).toEqual(checkpointLink.push);
  });

  it('should serialize same-link read-merge-write operations', async () => {
    const pullLink = makeLink();
    const pushLink = makeLink();
    pullLink.pull = { contiguousAppliedToken: token(1) };
    pushLink.push = { contiguousAppliedToken: token(2) };
    let storedValue = JSON.stringify(makeLink());
    let putCallCount = 0;
    const firstPutStarted = createDeferred();
    const releaseFirstPut = createDeferred();
    const links = {
      get : async (): Promise<string> => storedValue,
      put : async (_key: string, value: string): Promise<void> => {
        putCallCount++;
        if (putCallCount === 1) {
          firstPutStarted.resolve();
          await releaseFirstPut.promise;
        }
        storedValue = value;
      },
    };
    const fakeDb = {
      sublevel: (): typeof links => links,
    } as unknown as AbstractLevel<string | Buffer | Uint8Array>;
    const serializedStore = new SyncReplicationLinkStoreLevel(fakeDb);

    const pullPersistence = serializedStore.persistCheckpoint(pullLink, 'pull');
    await firstPutStarted.promise;
    const pushPersistence = serializedStore.persistCheckpoint(pushLink, 'push');
    await Promise.resolve();

    expect(putCallCount).toBe(1);

    releaseFirstPut.resolve();
    await Promise.all([pullPersistence, pushPersistence]);

    const persisted = JSON.parse(storedValue) as ReplicationLinkState;
    expect(persisted.pull).toEqual(pullLink.pull);
    expect(persisted.push).toEqual(pushLink.push);
  });

  it('should allow different-link mutations to proceed independently', async () => {
    const firstLink = makeLink();
    const secondLink = { ...makeLink(), remoteEndpoint: 'https://other-dwn.example.com' };
    firstLink.pull = { contiguousAppliedToken: token(1) };
    secondLink.push = { contiguousAppliedToken: token(2) };
    const firstKey = `${firstLink.tenantDid}^${firstLink.remoteEndpoint}^${firstLink.projectionId}^${firstLink.authorizationEpoch}`;
    const secondKey = `${secondLink.tenantDid}^${secondLink.remoteEndpoint}^${secondLink.projectionId}^${secondLink.authorizationEpoch}`;
    const storedValues = new Map<string, string>([
      [firstKey, JSON.stringify(makeLink())],
      [secondKey, JSON.stringify({ ...makeLink(), remoteEndpoint: secondLink.remoteEndpoint })],
    ]);
    const firstPutStarted = createDeferred();
    const releaseFirstPut = createDeferred();
    let firstPutCompleted = false;
    const links = {
      get: async (key: string): Promise<string> => {
        const value = storedValues.get(key);
        if (value === undefined) {
          throw new Error(`Unexpected key: ${key}`);
        }
        return value;
      },
      put: async (key: string, value: string): Promise<void> => {
        if (key === firstKey) {
          firstPutStarted.resolve();
          await releaseFirstPut.promise;
          firstPutCompleted = true;
        }
        storedValues.set(key, value);
      },
    };
    const fakeDb = {
      sublevel: (): typeof links => links,
    } as unknown as AbstractLevel<string | Buffer | Uint8Array>;
    const independentStore = new SyncReplicationLinkStoreLevel(fakeDb);

    const firstPersistence = independentStore.persistCheckpoint(firstLink, 'pull');
    await firstPutStarted.promise;

    try {
      await independentStore.persistCheckpoint(secondLink, 'push');
      expect(firstPutCompleted).toBe(false);
      const storedSecondLink = storedValues.get(secondKey);
      if (storedSecondLink === undefined) {
        throw new Error('The independent mutation did not persist its link.');
      }
      expect(JSON.parse(storedSecondLink)).toMatchObject({ push: secondLink.push });
    } finally {
      releaseFirstPut.resolve();
      await firstPersistence;
    }
  });

  it('should surface a failed mutation without poisoning later same-link work', async () => {
    const expectedError = new Error('write failed');
    const link = makeLink();
    let storedValue = JSON.stringify(link);
    let failNextPut = true;
    const links = {
      get : async (): Promise<string> => storedValue,
      put : async (_key: string, value: string): Promise<void> => {
        if (failNextPut) {
          failNextPut = false;
          throw expectedError;
        }
        storedValue = value;
      },
    };
    const fakeDb = {
      sublevel: (): typeof links => links,
    } as unknown as AbstractLevel<string | Buffer | Uint8Array>;
    const recoveringStore = new SyncReplicationLinkStoreLevel(fakeDb);

    link.pull = { contiguousAppliedToken: token(1) };
    await expect(recoveringStore.persistCheckpoint(link, 'pull')).rejects.toBe(expectedError);

    link.push = { contiguousAppliedToken: token(2) };
    await recoveringStore.persistCheckpoint(link, 'push');

    const persisted = JSON.parse(storedValue) as ReplicationLinkState;
    expect(persisted.pull).toEqual({});
    expect(persisted.push).toEqual(link.push);
  });

  it('should not resurrect a deleted link when a mutation races the prune', async () => {
    const link = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    await store.deleteLink(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch);

    link.pull = { contiguousAppliedToken: token(1) };
    await store.persistCheckpoint(link, 'pull');
    await store.setStatus(link, 'live');

    expect(await store.getAllLinks()).toEqual([]);
  });

  it('should keep a deleted link absent when the deletion and a checkpoint persist genuinely overlap', async () => {
    // Ordering 1: the deletion starts first and the checkpoint persist joins
    // mid-flight. The store serializes per link key, so starting both promises
    // before awaiting either drives a genuine overlap.
    const deleteFirstLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    deleteFirstLink.pull = { contiguousAppliedToken: token(1) };

    const deletion = store.deleteLink(
      deleteFirstLink.tenantDid,
      deleteFirstLink.remoteEndpoint,
      deleteFirstLink.projectionId,
      deleteFirstLink.authorizationEpoch,
    );
    const overlappingPersist = store.persistCheckpoint(deleteFirstLink, 'pull');
    await Promise.all([deletion, overlappingPersist]);

    expect(await store.getAllLinks()).toEqual([]);

    // Ordering 2: the checkpoint persist starts first and the deletion joins
    // mid-flight. The delete must win: the update must not resurrect the link.
    const updateFirstLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    updateFirstLink.pull = { contiguousAppliedToken: token(2) };

    const leadingPersist = store.persistCheckpoint(updateFirstLink, 'pull');
    const overlappingDeletion = store.deleteLink(
      updateFirstLink.tenantDid,
      updateFirstLink.remoteEndpoint,
      updateFirstLink.projectionId,
      updateFirstLink.authorizationEpoch,
    );
    await Promise.all([leadingPersist, overlappingDeletion]);

    expect(await store.getAllLinks()).toEqual([]);
  });

  it('should reset one direction while retaining the other checkpoint', async () => {
    const link = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    link.pull = { contiguousAppliedToken: token(10) };
    link.push = { contiguousAppliedToken: token(20) };
    await store.persistCheckpoint(link, 'pull');
    await store.persistCheckpoint(link, 'push');

    const linkToReset = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    await store.resetCheckpoint(linkToReset, 'pull');

    const [persisted] = await store.getAllLinks();
    expect(persisted.pull).toEqual({});
    expect(persisted.push).toEqual(link.push);
  });

  it('should reset both checkpoints without replacing current link status', async () => {
    const link = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    link.pull = { contiguousAppliedToken: token(10) };
    link.push = { contiguousAppliedToken: token(20) };
    await store.persistCheckpoint(link, 'pull');
    await store.persistCheckpoint(link, 'push');

    const statusLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    statusLink.connectivity = 'offline';
    await store.setStatus(statusLink, 'repairing');

    await store.resetCheckpoints(link);

    expect(link.pull).toEqual({});
    expect(link.push).toEqual({});
    const [persisted] = await store.getAllLinks();
    expect(persisted.pull).toEqual({});
    expect(persisted.push).toEqual({});
    expect(persisted.status).toBe('repairing');
    expect(persisted.connectivity).toBe('offline');
  });

  it('should reload both directional checkpoints after storage restart', async () => {
    const dataPath = `__TESTDATA__/sync-replication-link-store-restart/${crypto.randomUUID()}`;
    const firstDb = new Level<string, string>(dataPath);
    let link: ReplicationLinkState;
    try {
      const firstStore = new SyncReplicationLinkStoreLevel(firstDb);
      link = await firstStore.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });
      link.pull = { contiguousAppliedToken: token(40) };
      link.push = { contiguousAppliedToken: token(50) };
      link.connectivity = 'online';
      await firstStore.persistCheckpoint(link, 'pull');
      await firstStore.persistCheckpoint(link, 'push');
      await firstStore.setStatus(link, 'live');
    } finally {
      await firstDb.close();
    }

    const secondDb = new Level<string, string>(dataPath);
    try {
      const secondStore = new SyncReplicationLinkStoreLevel(secondDb);
      const reloaded = await secondStore.getOrCreateLink({
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      expect(reloaded.pull).toEqual(link.pull);
      expect(reloaded.push).toEqual(link.push);
      expect(reloaded.status).toBe('live');
      expect(reloaded.connectivity).toBe('unknown');
    } finally {
      await secondDb.clear();
      await secondDb.close();
    }
  });

  it('should reload a persisted repairing link as initializing while paused stays durable', async () => {
    const params = {
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' } as const,
      ...ownerAuthorization,
    };
    const link = await store.getOrCreateLink(params);

    // 'repairing' is runtime state: an interrupted repair must not disable
    // live replication for the link in the next session.
    await store.setStatus(link, 'repairing');
    const reloadedRepairing = await store.getOrCreateLink(params);
    expect(reloadedRepairing.status).toBe('initializing');
    expect(reloadedRepairing.connectivity).toBe('unknown');

    // 'paused' is a durable decision and must survive reload.
    await store.setStatus(link, 'paused');
    const reloadedPaused = await store.getOrCreateLink(params);
    expect(reloadedPaused.status).toBe('paused');

    await store.setStatus(link, 'live');
    const reloadedLive = await store.getOrCreateLink(params);
    expect(reloadedLive.status).toBe('live');
  });

  it('should clear only replication-link records', async () => {
    await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    await db.sublevel('syncMetadata').put('futureMetadataKey', 'preserve me');

    await store.clear();

    expect(await store.getAllLinks()).toHaveLength(0);
    expect(await db.sublevel('syncMetadata').get('futureMetadataKey')).toBe('preserve me');
  });

  it('should not regress a same-domain checkpoint persisted from a stale link instance', async () => {
    const staleLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    const freshLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });

    // The reconciler's freshly loaded instance advances the pull checkpoint...
    freshLink.pull = { contiguousAppliedToken: token(50) };
    await store.persistCheckpoint(freshLink, 'pull');

    // ...then a live handler persists the same direction from the stale
    // controller instance that never saw that advance.
    staleLink.pull = { contiguousAppliedToken: token(10) };
    await store.persistCheckpoint(staleLink, 'pull');

    const [persisted] = await store.getAllLinks();
    expect(persisted.pull.contiguousAppliedToken).toEqual(token(50));
  });

  it('should not clear a persisted checkpoint when a stale instance has none', async () => {
    const staleLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    const freshLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    freshLink.pull = { contiguousAppliedToken: token(50) };
    await store.persistCheckpoint(freshLink, 'pull');

    await store.persistCheckpoint(staleLink, 'pull');

    const [persisted] = await store.getAllLinks();
    expect(persisted.pull.contiguousAppliedToken).toEqual(token(50));
  });

  it('should replace the checkpoint wholesale when the token domain changes', async () => {
    const link = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    link.pull = { contiguousAppliedToken: token(50, 'one') };
    await store.persistCheckpoint(link, 'pull');

    // A stream/epoch change is a deliberate feed reset: a lower position in
    // the new domain must replace the old domain's checkpoint entirely.
    link.pull = { contiguousAppliedToken: token(3, 'two') };
    await store.persistCheckpoint(link, 'pull');

    const [persisted] = await store.getAllLinks();
    expect(persisted.pull.contiguousAppliedToken).toEqual(token(3, 'two'));
  });

  it('should still clear a checkpoint through an explicit reset after a newer persist', async () => {
    const staleLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    const freshLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    freshLink.pull = { contiguousAppliedToken: token(50) };
    await store.persistCheckpoint(freshLink, 'pull');

    await store.resetCheckpoint(staleLink, 'pull');

    const [persisted] = await store.getAllLinks();
    expect(persisted.pull).toEqual({});
  });
});
