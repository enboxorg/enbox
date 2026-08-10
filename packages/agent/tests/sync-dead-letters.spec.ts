import type { MessagesQueryReplyEntry } from '@enbox/dwn-sdk-js';

import type { SyncIdentityOptions } from '../src/types/sync.js';
import type { SyncIdentityStore } from '../src/sync-identity-store.js';
import type { SyncReplicationLinkStore } from '../src/sync-replication-link-store.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { SyncDeferredPullState, SyncDeferredPullStore } from '../src/sync-deferred-pull-store.js';

import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

import { deferred } from './utils/deferred.js';

describe('SyncEngineLevel dead letter tracking', () => {
  let db: Level<string, string>;
  let syncEngine: SyncEngineLevel;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-dead-letters-spec');
    syncEngine = new SyncEngineLevel({ db });
  });

  afterEach(async () => {
    sinon.restore();
    await db.sublevel('deadLetters').clear();
    await db.sublevel('deferredPulls').clear();
    await db.sublevel('replicationLinks').clear();
    await db.sublevel('registeredIdentities').clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should return failed messages scoped by tenant', async () => {
    await recordDeadLetter({ messageCid: 'cid-1', tenantDid: 'did:example:alice' });
    await recordDeadLetter({ messageCid: 'cid-2', tenantDid: 'did:example:bob' });

    const aliceFailures = await syncEngine.getDeadLetters('did:example:alice');

    expect(aliceFailures).toHaveLength(1);
    expect(aliceFailures[0].messageCid).toBe('cid-1');
    expect(aliceFailures[0].tenantDid).toBe('did:example:alice');
  });

  it('should clear a failed message for one remote without affecting other remotes', async () => {
    await recordDeadLetter({ messageCid: 'cid-shared', remoteEndpoint: 'https://a.example', tenantDid: 'did:example:alice' });
    await recordDeadLetter({ messageCid: 'cid-shared', remoteEndpoint: 'https://b.example', tenantDid: 'did:example:alice' });

    const cleared = await syncEngine.clearDeadLetter('cid-shared', 'https://a.example');

    expect(cleared).toBe(true);
    expect(await syncEngine.getDeadLetters('did:example:alice')).toMatchObject([
      { messageCid: 'cid-shared', remoteEndpoint: 'https://b.example' },
    ]);
  });

  it('should clear an internally resolved failure without affecting another tenant', async () => {
    const remoteEndpoint = 'https://shared.example';
    await recordDeadLetter({ messageCid: 'cid-shared', remoteEndpoint, tenantDid: 'did:example:alice' });
    await recordDeadLetter({ messageCid: 'cid-shared', remoteEndpoint, tenantDid: 'did:example:bob' });

    const internal = syncEngine as unknown as {
      trackRemoteFeedAppliedCids(messageCids: string[], target: unknown): Promise<void>;
    };
    await internal.trackRemoteFeedAppliedCids(['cid-shared'], {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      did                : 'did:example:alice',
      dwnUrl             : remoteEndpoint,
      projectionId       : 'projection',
      scope              : { kind: 'full' },
    });

    expect(await syncEngine.getDeadLetters('did:example:alice')).toHaveLength(0);
    expect(await syncEngine.getDeadLetters('did:example:bob')).toMatchObject([
      { messageCid: 'cid-shared', remoteEndpoint },
    ]);
  });

  it('should suppress only the expected database-close race during internal deletion', async () => {
    const del = sinon.stub();
    const internal = new SyncEngineLevel({
      db: {
        sublevel: (): { del: typeof del } => ({ del }),
      } as never,
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
    const internal = new SyncEngineLevel({
      db: {
        sublevel: (): { put: typeof put } => ({ put }),
      } as never,
    });
    const params = {
      errorDetail    : 'test failure',
      messageCid     : 'cid',
      remoteEndpoint : 'https://dwn.example',
      tenantDid      : 'did:example:alice',
    };

    put.rejects(Object.assign(new Error('database closed'), { code: 'LEVEL_DATABASE_NOT_OPEN' }));
    await expect(internal.recordDeadLetter(params)).resolves.toBeUndefined();

    put.rejects(Object.assign(new Error('write failed'), { code: 'LEVEL_IO_ERROR' }));
    await expect(internal.recordDeadLetter(params)).rejects.toThrow('write failed');
  });

  it('should clear all failed messages for one tenant', async () => {
    await recordDeadLetter({ messageCid: 'cid-1', tenantDid: 'did:example:alice' });
    await recordDeadLetter({ messageCid: 'cid-2', tenantDid: 'did:example:bob' });

    await syncEngine.clearAllDeadLetters('did:example:alice');

    expect(await syncEngine.getDeadLetters('did:example:alice')).toHaveLength(0);
    expect(await syncEngine.getDeadLetters('did:example:bob')).toHaveLength(1);
  });

  it('should report unhealthy sync while failures are recorded', async () => {
    await recordDeadLetter({
      messageCid : 'cid-admit',
      tenantDid  : 'did:example:alice',
    });

    const health = await syncEngine.getSyncHealth();

    expect(health.failedMessageCount).toBe(1);
    expect(health.syncHealthy).toBe(false);
  });

  it('should promote an expired deferred pull to a dead letter and clear its retry state', async () => {
    const messageCid = 'cid-expired';
    const remoteEndpoint = 'https://dwn.example';
    const tenantDid = 'did:example:alice';
    await registerTenant(tenantDid);
    await deferredPullStoreOf(syncEngine).put(
      tenantDid,
      messageCid,
      remoteEndpoint,
      deferredState({ aged: true, detail: 'dependency unavailable' }),
    );

    const promoted = await expiryOf(syncEngine)(
      target(tenantDid),
      { messageCid, protocol: 'https://protocol.example' },
      'dependency unavailable',
    );

    expect(promoted).toBe(true);
    expect(await db.sublevel('deferredPulls').values().all()).toEqual([]);
    expect(await syncEngine.getDeadLetters(tenantDid)).toMatchObject([{
      errorCode: 'Deferred',
      messageCid,
      remoteEndpoint,
      tenantDid,
    }]);
  });

  it('should hold a second engine admission outside the expiry section of the lifecycle lock', async () => {
    const messageCid = 'cid-raced-admission';
    const tenantDid = 'did:example:alice';
    const remoteEndpoint = 'https://dwn.example';
    const admissionEngine = new SyncEngineLevel({ db });
    const store = deferredPullStoreOf(syncEngine);
    await registerTenant(tenantDid);
    await store.put(tenantDid, messageCid, remoteEndpoint, deferredState({ attempts: 3, aged: true }));

    // Gate the expiry section at its deferred-state read, which runs INSIDE
    // the per-tenant lifecycle lock: a concurrent admission from a second
    // engine must queue on that lock rather than interleave.
    const gate = gateStoreGet(store);

    const admissionInternal = admissionEngine as unknown as {
      trackRemoteFeedAppliedCids(messageCids: string[], target: SyncTarget): Promise<void>;
    };
    const expiry = expiryOf(syncEngine)(
      target(tenantDid),
      { messageCid },
      'dependency unavailable',
    );
    await gate.started;

    let admissionCompleted = false;
    const admission = admissionInternal.trackRemoteFeedAppliedCids([messageCid], target(tenantDid)).then((): void => {
      admissionCompleted = true;
    });
    await Promise.resolve();

    expect(admissionCompleted).toBe(false);

    gate.release();
    expect(await expiry).toBe(true);
    await admission;

    // The expiry promoted the aged deferral; the serialized admission then
    // cleaned both the retry state and the dead letter it had just written.
    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toBeUndefined();
    expect(await syncEngine.getDeadLetters(tenantDid)).toEqual([]);
  });

  it('should clear deferred-pull retry state when an identity is unregistered', async () => {
    const remoteEndpoint = 'https://dwn.example';
    const store = deferredPullStoreOf(syncEngine);
    await registerTenant('did:example:alice');
    await store.put('did:example:alice', 'cid-1', remoteEndpoint, deferredState());
    await store.put('did:example:bob', 'cid-2', remoteEndpoint, deferredState());

    await syncEngine.removeIdentity('did:example:alice');

    expect(await store.get('did:example:alice', 'cid-1', remoteEndpoint)).toBeUndefined();
    expect(await store.get('did:example:bob', 'cid-2', remoteEndpoint)).toBeDefined();
  });

  it('should serialize unregister after an in-flight deferred write from another engine', async () => {
    const messageCid = 'cid-raced-unregister';
    const remoteEndpoint = 'https://dwn.example';
    const tenantDid = 'did:example:alice';
    const expiryEngine = new SyncEngineLevel({ db });
    const unregisterEngine = new SyncEngineLevel({ db });
    const store = deferredPullStoreOf(expiryEngine);
    await registerTenant(tenantDid);
    await store.put(tenantDid, messageCid, remoteEndpoint, deferredState());

    const gate = gateStoreGet(store);

    const expiry = expiryOf(expiryEngine)(
      target(tenantDid),
      { messageCid },
      'dependency unavailable',
    );
    await gate.started;

    let unregisterCompleted = false;
    const unregister = unregisterEngine.removeIdentity(tenantDid).then((): void => {
      unregisterCompleted = true;
    });
    await Promise.resolve();

    expect(unregisterCompleted).toBe(false);

    gate.release();
    expect(await expiry).toBe(false);
    await unregister;

    expect(await unregisterEngine.getIdentityOptions(tenantDid)).toBeUndefined();
    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toBeUndefined();
    expect(await syncEngine.getDeadLetters(tenantDid)).toEqual([]);
  });

  it('should reject stale deferred work from another engine after unregister', async () => {
    const messageCid = 'cid-stale-after-unregister';
    const remoteEndpoint = 'https://dwn.example';
    const tenantDid = 'did:example:alice';
    const staleEngine = new SyncEngineLevel({ db });
    const unregisterEngine = new SyncEngineLevel({ db });
    const staleTarget = target(tenantDid);
    const store = deferredPullStoreOf(staleEngine);
    await registerTenant(tenantDid);

    await unregisterEngine.removeIdentity(tenantDid);

    const staleInternal = staleEngine as unknown as {
      tryRetireDeferredPull(
        target: SyncTarget,
        entry: MessagesQueryReplyEntry,
        detail: string | undefined,
      ): Promise<boolean>;
    };
    expect(await staleInternal.tryRetireDeferredPull(
      staleTarget,
      { messageCid },
      'dependency unavailable',
    )).toBe(true);

    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toBeUndefined();
    expect(await syncEngine.getDeadLetters(tenantDid)).toEqual([]);
    expect(await unregisterEngine.getIdentityOptions(tenantDid)).toBeUndefined();
  });

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

  async function recordDeadLetter(params: {
    messageCid: string;
    remoteEndpoint?: string;
    tenantDid: string;
  }): Promise<void> {
    await syncEngine.recordDeadLetter({
      errorCode      : 'test',
      errorDetail    : 'test failure',
      messageCid     : params.messageCid,
      remoteEndpoint : params.remoteEndpoint ?? 'https://dwn.example',
      tenantDid      : params.tenantDid,
    });
  }

  it('should serialize a re-registration behind another engine in-flight unregister', async () => {
    const tenantDid = 'did:example:alice';
    const unregisterEngine = new SyncEngineLevel({ db });
    const registerEngine = new SyncEngineLevel({ db });
    await registerTenant(tenantDid);

    // Gate the unregister INSIDE its identity-lifecycle lock (at the
    // deferred-pull sweep), then start a re-registration from a second
    // engine: it must queue on the lifecycle lock, so the resumed unregister
    // cannot observe — or prune — state the re-registration creates.
    const sweepStarted = deferred<void>();
    const releaseSweep = deferred<void>();
    const unregisterStore = deferredPullStoreOf(unregisterEngine);
    sinon.stub(unregisterStore, 'deleteForTenant').callsFake(async (): Promise<void> => {
      sweepStarted.resolve();
      await releaseSweep.promise;
    });

    // Deterministic operation-order signal: record marker mutations from
    // both engines and assert the unregister's delete strictly precedes the
    // re-registration's write.
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

    // Give the re-registration ample time to finish if it were NOT queued on
    // the lifecycle lock; a locked registration cannot complete until the
    // gated unregister releases. (The bound matters only for detecting the
    // unlocked failure mode — the locked pass direction is time-independent.)
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(registerCompleted).toBe(false);

    releaseSweep.resolve();
    await unregister;
    await register;

    // Serialized outcome: the unregister's marker deletion strictly precedes
    // the re-registration's marker write, and the identity ends registered.
    expect(markerEvents).toEqual(['unregister:marker-deleted', 'register:marker-set']);
    expect(await registerEngine.getIdentityOptions(tenantDid)).toBeDefined();
  });

  it('should keep the registration intact when durable-link pruning fails, then succeed on retry', async () => {
    const tenantDid = 'did:example:alice';
    await registerTenant(tenantDid);
    const replicationLinkStore = (
      syncEngine as unknown as { replicationLinkStore: SyncReplicationLinkStore }
    ).replicationLinkStore;
    const link = await replicationLinkStore.getOrCreateLink({
      tenantDid,
      remoteEndpoint     : 'https://dwn.example',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
    });
    await replicationLinkStore.setStatus(link, 'paused');

    const deleteLink = sinon.stub(replicationLinkStore, 'deleteLink').rejects(new Error('link delete failed'));

    await expect(syncEngine.removeIdentity(tenantDid)).rejects.toThrow('link delete failed');
    // Durable-link pruning precedes the identity-marker commit point: a
    // failed prune leaves the registration intact, so the paused link cannot
    // be orphaned onto a same-scope re-registration (where supersession
    // pruning would retain it and silently disable live replication).
    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeDefined();

    deleteLink.restore();
    await syncEngine.removeIdentity(tenantDid);

    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeUndefined();
    expect(await replicationLinkStore.getAllLinks()).toEqual([]);
  });

  it('should keep the registration intact when unregister deletion fails, then succeed on retry', async () => {
    const tenantDid = 'did:example:alice';
    const remoteEndpoint = 'https://dwn.example';
    const store = deferredPullStoreOf(syncEngine);
    await registerTenant(tenantDid);
    await store.put(tenantDid, 'cid-1', remoteEndpoint, deferredState({ attempts: 2, aged: true }));

    const deleteForTenant = sinon.stub(store, 'deleteForTenant').rejects(new Error('sweep failed'));

    await expect(syncEngine.removeIdentity(tenantDid)).rejects.toThrow('sweep failed');
    // The identity marker is the commit point: a failed tenant sweep leaves
    // the registration intact, so no re-registration can inherit the aged
    // deferral — the caller simply retries the unregister.
    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeDefined();

    deleteForTenant.restore();
    await syncEngine.removeIdentity(tenantDid);

    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeUndefined();
    expect(await store.get(tenantDid, 'cid-1', remoteEndpoint)).toBeUndefined();
  });

  function deferredPullStoreOf(engine: SyncEngineLevel): SyncDeferredPullStore {
    return (engine as unknown as { _deferredPullStore: SyncDeferredPullStore })._deferredPullStore;
  }

  function expiryOf(engine: SyncEngineLevel): (
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
    detail: string | undefined,
  ) => Promise<boolean> {
    const internal = engine as unknown as {
      tryRetireDeferredPull(
        target: SyncTarget,
        entry: MessagesQueryReplyEntry,
        detail: string | undefined,
      ): Promise<boolean>;
    };
    return internal.tryRetireDeferredPull.bind(internal);
  }

  function deferredState({ attempts = 1, aged = false, detail }: {
    attempts?: number;
    aged?: boolean;
    detail?: string;
  } = {}): SyncDeferredPullState {
    return {
      attempts,
      ...(detail === undefined ? {} : { detail }),
      firstDeferredAt: aged
        ? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
        : new Date().toISOString(),
      lastDeferredAt: new Date().toISOString(),
    };
  }

  /** Gate a store's get() so the caller can hold its locked section open. */
  function gateStoreGet(store: SyncDeferredPullStore): { started: Promise<void>; release: () => void } {
    const started = deferred<void>();
    const release = deferred<void>();
    const originalGet = store.get.bind(store);
    sinon.stub(store, 'get').callsFake(async (
      did: string,
      cid: string,
      endpoint: string,
    ): Promise<SyncDeferredPullState | undefined> => {
      const state = await originalGet(did, cid, endpoint);
      started.resolve();
      await release.promise;
      return state;
    });
    return { started: started.promise, release: (): void => { release.resolve(); } };
  }

  async function registerTenant(tenantDid: string): Promise<void> {
    await db.sublevel('registeredIdentities').put(tenantDid, JSON.stringify({ protocols: 'all' }));
  }

});
