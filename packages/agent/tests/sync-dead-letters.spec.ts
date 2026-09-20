import type { SyncDeadLetterStoreLevel } from '../src/sync-dead-letter-store-level.js';
import type { SyncIdentityStore } from '../src/sync-identity-store.js';
import type { SyncReplicationLinkStoreLevel } from '../src/sync-replication-link-store-level.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { PushFailure, ReplicationLinkState, SyncIdentityOptions } from '../src/types/sync.js';

import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

import { deferred } from './utils/deferred.js';

describe('SyncEngineLevel dead letter and pending-pull tracking', () => {
  let db: Level<string, string>;
  let syncEngine: SyncEngineLevel;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-dead-letters-spec');
    syncEngine = new SyncEngineLevel({ db });
  });

  afterEach(async () => {
    sinon.restore();
    for (const sublevel of ['deadLetters', 'deadLettersV2', 'deferredPulls', 'pendingPullsV2', 'replicationLinks', 'registeredIdentities']) {
      await db.sublevel(sublevel).clear();
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it('should return failed messages scoped by tenant', async () => {
    await recordDeadLetter({ messageCid: 'cid-1', tenantDid: 'did:example:alice' });
    await recordDeadLetter({ messageCid: 'cid-2', tenantDid: 'did:example:bob' });

    const aliceFailures = await syncEngine.getDeadLetters('did:example:alice');

    expect(aliceFailures).toHaveLength(1);
    expect(aliceFailures[0]).toMatchObject({ messageCid: 'cid-1', tenantDid: 'did:example:alice' });
  });

  it('should preserve ambiguous legacy dead letters only until a precise pull outcome', async () => {
    const tenantDid = 'did:example:alice';
    await recordDeadLetter({ messageCid: 'legacy-cid', tenantDid });
    const store = replicationLinkStoreOf(syncEngine);
    const link = await store.getOrCreateLink({
      tenantDid,
      remoteEndpoint     : 'https://dwn.example',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
    });
    await store.commitPullPage(link, {
      checkpoint         : { epoch: 'epoch', messageCid: 'legacy-cid', position: '1', streamId: 'stream' },
      deadLetters        : [],
      pending            : [],
      settledMessageCids : ['legacy-cid'],
    });

    expect(await syncEngine.getDeadLetters(tenantDid)).toEqual([]);
  });

  it('should suppress only the expected database-close race during legacy deletion', async () => {
    const del = sinon.stub();
    const get = sinon.stub().resolves(JSON.stringify({
      errorDetail    : 'failure',
      failedAt       : new Date().toISOString(),
      messageCid     : 'cid',
      remoteEndpoint : 'https://dwn.example',
      tenantDid      : 'did:example:alice',
    }));
    const internal = new SyncEngineLevel({
      db: { sublevel: (): { del: typeof del; get: typeof get } => ({ del, get }) } as never,
    }) as unknown as {
      clearDeadLetterForTenant(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<void>;
    };

    del.rejects(Object.assign(new Error('database closed'), { code: 'LEVEL_DATABASE_NOT_OPEN' }));
    await expect(internal.clearDeadLetterForTenant('did:example:alice', 'cid', 'https://dwn.example')).resolves.toBeUndefined();

    del.rejects(Object.assign(new Error('write failed'), { code: 'LEVEL_IO_ERROR' }));
    await expect(internal.clearDeadLetterForTenant('did:example:alice', 'cid', 'https://dwn.example')).rejects.toThrow('write failed');
  });

  it('should suppress only the expected database-close race while recording a failure', async () => {
    const put = sinon.stub();
    const engine = new SyncEngineLevel({
      db: { sublevel: (): { put: typeof put } => ({ put }) } as never,
    });
    const params = {
      errorDetail    : 'test failure',
      messageCid     : 'cid',
      remoteEndpoint : 'https://dwn.example',
      tenantDid      : 'did:example:alice',
    };

    put.rejects(Object.assign(new Error('database closed'), { code: 'LEVEL_DATABASE_NOT_OPEN' }));
    await expect(engine.recordDeadLetter(params)).resolves.toBeUndefined();

    put.rejects(Object.assign(new Error('write failed'), { code: 'LEVEL_IO_ERROR' }));
    await expect(engine.recordDeadLetter(params)).rejects.toThrow('write failed');
  });

  it('should report unhealthy sync while failures are recorded', async () => {
    await recordDeadLetter({ messageCid: 'cid-admit', tenantDid: 'did:example:alice' });

    const health = await syncEngine.getSyncHealth();

    expect(health.failedMessageCount).toBe(1);
    expect(health.syncHealthy).toBe(false);
  });

  it('should report a terminal push failure only when its dead letter is first recorded', async () => {
    const did = 'did:example:alice';
    const failure: PushFailure = {
      cid      : 'cid-terminal',
      detail   : 'bad signature',
      kind     : 'Invalid',
      terminal : true,
    };
    const internal = syncEngine as unknown as {
      recordTerminalPushFailure(syncTarget: SyncTarget, pushFailure: PushFailure): Promise<void>;
    };
    const report = sinon.stub(console, 'error');

    await internal.recordTerminalPushFailure(target(did), failure);
    await internal.recordTerminalPushFailure(target(did), failure);

    expect(report.calledOnce).toBe(true);
    expect(await syncEngine.getDeadLetters(did)).toHaveLength(1);
  });

  it('should clear pending pull rows only when their owning identity is explicitly removed', async () => {
    const tenantDid = 'did:example:alice';
    await registerTenant(tenantDid);
    const { link, store } = await createPendingPull(tenantDid, 'pending-cid');

    await syncEngine.removeIdentity(tenantDid);

    expect(await store.getPendingPullsForLink(link)).toEqual([]);
  });

  it('should serialize re-registration behind another engine pending-row sweep', async () => {
    const tenantDid = 'did:example:alice';
    const unregisterEngine = new SyncEngineLevel({ db });
    const registerEngine = new SyncEngineLevel({ db });
    await registerTenant(tenantDid);
    const replicationStore = replicationLinkStoreOf(unregisterEngine);
    const sweepStarted = deferred<void>();
    const releaseSweep = deferred<void>();
    sinon.stub(replicationStore, 'deleteOwnedPendingPullsForTenant').callsFake(async (): Promise<void> => {
      sweepStarted.resolve();
      await releaseSweep.promise;
    });

    const markerEvents: string[] = [];
    const unregisterIdentityStore = (unregisterEngine as unknown as { _identityStore: SyncIdentityStore })._identityStore;
    const registerIdentityStore = (registerEngine as unknown as { _identityStore: SyncIdentityStore })._identityStore;
    const originalDelete = unregisterIdentityStore.delete.bind(unregisterIdentityStore);
    sinon.stub(unregisterIdentityStore, 'delete').callsFake(async (did: string): Promise<void> => {
      markerEvents.push('unregister:marker-deleted');
      await originalDelete(did);
    });
    const originalSet = registerIdentityStore.set.bind(registerIdentityStore);
    sinon.stub(registerIdentityStore, 'set').callsFake(async (did: string, options: SyncIdentityOptions): Promise<void> => {
      markerEvents.push('register:marker-set');
      await originalSet(did, options);
    });

    const unregister = unregisterEngine.removeIdentity(tenantDid);
    await sweepStarted.promise;
    let registerCompleted = false;
    const register = registerEngine.setIdentityOptions({ did: tenantDid, options: { protocols: 'all' } })
      .then((): void => { registerCompleted = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(registerCompleted).toBe(false);

    releaseSweep.resolve();
    await unregister;
    await register;

    expect(markerEvents).toEqual(['unregister:marker-deleted', 'register:marker-set']);
    expect(await registerEngine.getIdentityOptions(tenantDid)).toBeDefined();
  });

  it('should keep registration intact when durable-link pruning fails, then succeed on retry', async () => {
    const tenantDid = 'did:example:alice';
    await registerTenant(tenantDid);
    const store = replicationLinkStoreOf(syncEngine);
    const link = await store.getOrCreateLink({
      tenantDid,
      remoteEndpoint     : 'https://dwn.example',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
    });
    await store.setStatus(link, 'paused');
    const deleteLink = sinon.stub(store, 'deleteLink').rejects(new Error('link delete failed'));

    await expect(syncEngine.removeIdentity(tenantDid)).rejects.toThrow('link delete failed');
    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeDefined();

    deleteLink.restore();
    await syncEngine.removeIdentity(tenantDid);
    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeUndefined();
  });

  it('should keep registration intact when dead-letter cleanup fails, then clear only that tenant on retry', async () => {
    const tenantDid = 'did:example:alice';
    const otherTenantDid = 'did:example:bob';
    const store = deadLetterStoreOf(syncEngine);
    await registerTenant(tenantDid);
    await recordDeadLetter({ messageCid: 'alice-cid', tenantDid });
    await recordDeadLetter({ messageCid: 'bob-cid', tenantDid: otherTenantDid });
    const deleteForTenant = sinon.stub(store, 'deleteForTenant').rejects(new Error('dead-letter sweep failed'));

    await expect(syncEngine.removeIdentity(tenantDid)).rejects.toThrow('dead-letter sweep failed');
    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeDefined();

    deleteForTenant.restore();
    await syncEngine.removeIdentity(tenantDid);
    expect(await syncEngine.getDeadLetters(tenantDid)).toEqual([]);
    expect(await syncEngine.getDeadLetters(otherTenantDid)).toMatchObject([{ messageCid: 'bob-cid' }]);
  });

  it('should keep registration intact when pending-row cleanup fails, then succeed on retry', async () => {
    const tenantDid = 'did:example:alice';
    await registerTenant(tenantDid);
    const { link, store } = await createPendingPull(tenantDid, 'pending-cid');
    const deleteForTenant = sinon.stub(store, 'deleteOwnedPendingPullsForTenant').rejects(new Error('pending sweep failed'));

    await expect(syncEngine.removeIdentity(tenantDid)).rejects.toThrow('pending sweep failed');
    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeDefined();

    deleteForTenant.restore();
    await syncEngine.removeIdentity(tenantDid);
    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeUndefined();
    expect(await store.getPendingPullsForLink(link)).toEqual([]);
  });

  async function createPendingPull(
    tenantDid: string,
    messageCid: string,
  ): Promise<{ link: ReplicationLinkState; store: SyncReplicationLinkStoreLevel }> {
    const store = replicationLinkStoreOf(syncEngine);
    const link = await store.getOrCreateLink({
      tenantDid,
      remoteEndpoint     : 'https://dwn.example',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
    });
    await store.commitPullPage(link, {
      checkpoint  : { epoch: 'epoch', messageCid, position: '1', streamId: 'stream' },
      deadLetters : [],
      pending     : [{
        entry   : { isLatestBaseState: false, messageCid, seq: '1' },
        outcome : { kind: 'Deferred', reason: 'dependency' },
        source  : { epoch: 'epoch', messageCid, position: '1', streamId: 'stream' },
      }],
      settledMessageCids: [],
    });
    return { link, store };
  }

  function deadLetterStoreOf(engine: SyncEngineLevel): SyncDeadLetterStoreLevel {
    return (engine as unknown as { _deadLetterStore: SyncDeadLetterStoreLevel })._deadLetterStore;
  }

  function replicationLinkStoreOf(engine: SyncEngineLevel): SyncReplicationLinkStoreLevel {
    return (engine as unknown as { replicationLinkStore: SyncReplicationLinkStoreLevel }).replicationLinkStore;
  }

  async function recordDeadLetter({ messageCid, tenantDid, remoteEndpoint = 'https://dwn.example' }: {
    messageCid: string;
    tenantDid: string;
    remoteEndpoint?: string;
  }): Promise<void> {
    await syncEngine.recordDeadLetter({
      errorDetail: 'test failure',
      messageCid,
      remoteEndpoint,
      tenantDid,
    });
  }

  async function registerTenant(tenantDid: string): Promise<void> {
    await db.sublevel('registeredIdentities').put(tenantDid, JSON.stringify({ protocols: 'all' }));
  }

  function target(did: string): SyncTarget {
    return {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      did,
      dwnUrl             : 'https://dwn.example',
      projectionId       : 'projection',
      scope              : { kind: 'full' },
    };
  }
});
