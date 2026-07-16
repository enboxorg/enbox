import type { AbstractLevel } from 'abstract-level';
import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState } from '../src/types/sync.js';

import { SyncReplicationLinkStoreLevel } from '../src/sync-replication-link-store-level.js';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const ownerAuthorization = {
  authorization      : { kind: 'owner' as const },
  authorizationEpoch : 'owner-epoch',
};

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
    pullLink.pull = { contiguousAppliedToken: token(10), receivedToken: token(12) };
    pushLink.push = { contiguousAppliedToken: token(20), receivedToken: token(21) };

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
    checkpointLink.push = { contiguousAppliedToken: token(30), receivedToken: token(30) };

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
    pullLink.pull = { contiguousAppliedToken: token(1), receivedToken: token(1) };
    pushLink.push = { contiguousAppliedToken: token(2), receivedToken: token(2) };
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

    link.pull = { contiguousAppliedToken: token(1), receivedToken: token(1) };
    await expect(recoveringStore.persistCheckpoint(link, 'pull')).rejects.toBe(expectedError);

    link.push = { contiguousAppliedToken: token(2), receivedToken: token(2) };
    await recoveringStore.persistCheckpoint(link, 'push');

    const persisted = JSON.parse(storedValue) as ReplicationLinkState;
    expect(persisted.pull).toEqual({});
    expect(persisted.push).toEqual(link.push);
  });

  it('should reset one direction without replacing the other direction', async () => {
    const link = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    link.pull = { contiguousAppliedToken: token(10), receivedToken: token(11) };
    link.push = { contiguousAppliedToken: token(20), receivedToken: token(21) };
    await store.persistCheckpoint(link, 'pull');
    await store.persistCheckpoint(link, 'push');

    const staleLink = await store.getOrCreateLink({
      tenantDid      : 'did:example:alice',
      remoteEndpoint : 'https://dwn.example.com',
      scope          : { kind: 'full' },
      ...ownerAuthorization,
    });
    await store.resetCheckpoint(staleLink, 'pull');

    const [persisted] = await store.getAllLinks();
    expect(persisted.pull).toEqual({});
    expect(persisted.push).toEqual(link.push);
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
      link.pull = { contiguousAppliedToken: token(40), receivedToken: token(41) };
      link.push = { contiguousAppliedToken: token(50), receivedToken: token(51) };
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
});
