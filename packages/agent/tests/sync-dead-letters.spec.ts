import type { MessagesQueryReplyEntry } from '@enbox/dwn-sdk-js';

import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { SyncDeferredPullState, SyncDeferredPullStore } from '../src/sync-deferred-pull-store.js';

import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
};

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

    const aliceFailures = await syncEngine.getFailedMessages('did:example:alice');

    expect(aliceFailures).toHaveLength(1);
    expect(aliceFailures[0].messageCid).toBe('cid-1');
    expect(aliceFailures[0].tenantDid).toBe('did:example:alice');
  });

  it('should clear a failed message for one remote without affecting other remotes', async () => {
    await recordDeadLetter({ messageCid: 'cid-shared', remoteEndpoint: 'https://a.example', tenantDid: 'did:example:alice' });
    await recordDeadLetter({ messageCid: 'cid-shared', remoteEndpoint: 'https://b.example', tenantDid: 'did:example:alice' });

    const cleared = await syncEngine.clearFailedMessage('cid-shared', 'https://a.example');

    expect(cleared).toBe(true);
    expect(await syncEngine.getFailedMessages('did:example:alice')).toMatchObject([
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

    expect(await syncEngine.getFailedMessages('did:example:alice')).toHaveLength(0);
    expect(await syncEngine.getFailedMessages('did:example:bob')).toMatchObject([
      { messageCid: 'cid-shared', remoteEndpoint },
    ]);
  });

  it('should suppress only the expected database-close race during internal cleanup', async () => {
    const del = sinon.stub();
    const internal = new SyncEngineLevel({
      db: {
        sublevel: (): { del: typeof del } => ({ del }),
      } as never,
    }) as unknown as {
      clearFailedMessageForTenant(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<void>;
    };

    del.rejects(Object.assign(new Error('database closed'), { code: 'LEVEL_DATABASE_NOT_OPEN' }));
    await expect(internal.clearFailedMessageForTenant('did:example:alice', 'cid', 'https://dwn.example')).resolves.toBeUndefined();

    del.rejects(Object.assign(new Error('write failed'), { code: 'LEVEL_IO_ERROR' }));
    await expect(internal.clearFailedMessageForTenant('did:example:alice', 'cid', 'https://dwn.example')).rejects.toThrow('write failed');
  });

  it('should suppress only the expected database-close race while recording a failure', async () => {
    const put = sinon.stub();
    const internal = new SyncEngineLevel({
      db: {
        sublevel: (): { put: typeof put } => ({ put }),
      } as never,
    });
    const params = {
      category    : 'admit-failed' as const,
      errorDetail : 'test failure',
      messageCid  : 'cid',
      tenantDid   : 'did:example:alice',
    };

    put.rejects(Object.assign(new Error('database closed'), { code: 'LEVEL_DATABASE_NOT_OPEN' }));
    await expect(internal.recordDeadLetter(params)).resolves.toBeUndefined();

    put.rejects(Object.assign(new Error('write failed'), { code: 'LEVEL_IO_ERROR' }));
    await expect(internal.recordDeadLetter(params)).rejects.toThrow('write failed');
  });

  it('should clear all failed messages for one tenant', async () => {
    await recordDeadLetter({ messageCid: 'cid-1', tenantDid: 'did:example:alice' });
    await recordDeadLetter({ messageCid: 'cid-2', tenantDid: 'did:example:bob' });

    await syncEngine.clearAllFailedMessages('did:example:alice');

    expect(await syncEngine.getFailedMessages('did:example:alice')).toHaveLength(0);
    expect(await syncEngine.getFailedMessages('did:example:bob')).toHaveLength(1);
  });

  it('should report unhealthy sync while failures are recorded', async () => {
    await recordDeadLetter({
      category   : 'admit-failed',
      messageCid : 'cid-admit',
      tenantDid  : 'did:example:alice',
    });

    const health = await syncEngine.getSyncHealth();

    expect(health.failedMessageCount).toBe(1);
    expect(health.admissionFailureCount).toBe(1);
    expect(health.syncHealthy).toBe(false);
  });

  it('should promote an expired deferred pull to a dead letter and clear its retry state', async () => {
    const messageCid = 'cid-expired';
    const remoteEndpoint = 'https://dwn.example';
    const tenantDid = 'did:example:alice';
    const key = `${tenantDid}|${messageCid}|${remoteEndpoint}`;
    const deferredState: SyncDeferredPullState = {
      attempts        : 1,
      detail          : 'dependency unavailable',
      firstDeferredAt : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      lastDeferredAt  : new Date().toISOString(),
    };
    await registerTenant(tenantDid);
    await db.sublevel('deferredPulls').put(key, JSON.stringify(deferredState));

    const target: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      did                : tenantDid,
      dwnUrl             : remoteEndpoint,
      projectionId       : 'projection',
      scope              : { kind: 'full' },
    };
    const internal = syncEngine as unknown as {
      deadLetterExpiredDeferredPull(
        target: SyncTarget,
        entry: MessagesQueryReplyEntry,
        detail: string | undefined,
      ): Promise<boolean>;
    };

    const promoted = await internal.deadLetterExpiredDeferredPull(
      target,
      { messageCid, protocol: 'https://protocol.example' },
      'dependency unavailable',
    );

    expect(promoted).toBe(true);
    expect(await db.sublevel('deferredPulls').values().all()).toEqual([]);
    expect(await syncEngine.getFailedMessages(tenantDid)).toMatchObject([{
      category  : 'admit-failed',
      errorCode : 'Deferred',
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
    const store = (syncEngine as unknown as { _deferredPullStore: SyncDeferredPullStore })._deferredPullStore;
    const aged: SyncDeferredPullState = {
      attempts        : 3,
      firstDeferredAt : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      lastDeferredAt  : new Date().toISOString(),
    };
    await registerTenant(tenantDid);
    await store.put(tenantDid, messageCid, remoteEndpoint, aged);

    // Gate the expiry section at its deferred-state read, which runs INSIDE
    // the per-tenant lifecycle lock: a concurrent admission from a second
    // engine must queue on that lock rather than interleave.
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const originalGet = store.get.bind(store);
    sinon.stub(store, 'get').callsFake(async (
      did: string,
      cid: string,
      endpoint: string,
    ): Promise<SyncDeferredPullState | undefined> => {
      const state = await originalGet(did, cid, endpoint);
      readStarted.resolve();
      await releaseRead.promise;
      return state;
    });

    const expiryInternal = syncEngine as unknown as {
      deadLetterExpiredDeferredPull(
        target: SyncTarget,
        entry: MessagesQueryReplyEntry,
        detail: string | undefined,
      ): Promise<boolean>;
    };
    const admissionInternal = admissionEngine as unknown as {
      trackRemoteFeedAppliedCids(messageCids: string[], target: SyncTarget): Promise<void>;
    };
    const expiry = expiryInternal.deadLetterExpiredDeferredPull(
      target(tenantDid),
      { messageCid },
      'dependency unavailable',
    );
    await readStarted.promise;

    let admissionCompleted = false;
    const admission = admissionInternal.trackRemoteFeedAppliedCids([messageCid], target(tenantDid)).then((): void => {
      admissionCompleted = true;
    });
    await Promise.resolve();

    expect(admissionCompleted).toBe(false);

    releaseRead.resolve();
    expect(await expiry).toBe(true);
    await admission;

    // The expiry promoted the aged deferral; the serialized admission then
    // cleaned both the retry state and the dead letter it had just written.
    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toBeUndefined();
    expect(await syncEngine.getFailedMessages(tenantDid)).toEqual([]);
  });

  it('should clear deferred-pull retry state when an identity is unregistered', async () => {
    const remoteEndpoint = 'https://dwn.example';
    const store = (syncEngine as unknown as { _deferredPullStore: SyncDeferredPullStore })._deferredPullStore;
    await db.sublevel('registeredIdentities').put('did:example:alice', JSON.stringify({ protocols: 'all' }));
    await store.put('did:example:alice', 'cid-1', remoteEndpoint, {
      attempts        : 1,
      firstDeferredAt : new Date().toISOString(),
      lastDeferredAt  : new Date().toISOString(),
    });
    await store.put('did:example:bob', 'cid-2', remoteEndpoint, {
      attempts        : 1,
      firstDeferredAt : new Date().toISOString(),
      lastDeferredAt  : new Date().toISOString(),
    });

    await syncEngine.unregisterIdentity('did:example:alice');

    expect(await store.get('did:example:alice', 'cid-1', remoteEndpoint)).toBeUndefined();
    expect(await store.get('did:example:bob', 'cid-2', remoteEndpoint)).toBeDefined();
  });

  it('should serialize unregister after an in-flight deferred write from another engine', async () => {
    const messageCid = 'cid-raced-unregister';
    const remoteEndpoint = 'https://dwn.example';
    const tenantDid = 'did:example:alice';
    const expiryEngine = new SyncEngineLevel({ db });
    const unregisterEngine = new SyncEngineLevel({ db });
    const store = (expiryEngine as unknown as { _deferredPullStore: SyncDeferredPullStore })._deferredPullStore;
    const state: SyncDeferredPullState = {
      attempts        : 1,
      firstDeferredAt : new Date().toISOString(),
      lastDeferredAt  : new Date().toISOString(),
    };
    await registerTenant(tenantDid);
    await store.put(tenantDid, messageCid, remoteEndpoint, state);

    const finalReadCompleted = deferred<void>();
    const releaseFinalRead = deferred<void>();
    const originalGet = store.get.bind(store);
    sinon.stub(store, 'get').callsFake(async (
      did: string,
      cid: string,
      endpoint: string,
    ): Promise<SyncDeferredPullState | undefined> => {
      const current = await originalGet(did, cid, endpoint);
      finalReadCompleted.resolve();
      await releaseFinalRead.promise;
      return current;
    });

    const expiryInternal = expiryEngine as unknown as {
      deadLetterExpiredDeferredPull(
        target: SyncTarget,
        entry: MessagesQueryReplyEntry,
        detail: string | undefined,
      ): Promise<boolean>;
    };
    const expiry = expiryInternal.deadLetterExpiredDeferredPull(
      target(tenantDid),
      { messageCid },
      'dependency unavailable',
    );
    await finalReadCompleted.promise;

    let unregisterCompleted = false;
    const unregister = unregisterEngine.unregisterIdentity(tenantDid).then((): void => {
      unregisterCompleted = true;
    });
    await Promise.resolve();

    expect(unregisterCompleted).toBe(false);

    releaseFinalRead.resolve();
    expect(await expiry).toBe(false);
    await unregister;

    expect(await unregisterEngine.getIdentityOptions(tenantDid)).toBeUndefined();
    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toBeUndefined();
    expect(await syncEngine.getFailedMessages(tenantDid)).toEqual([]);
  });

  it('should reject stale deferred work from another engine after unregister', async () => {
    const messageCid = 'cid-stale-after-unregister';
    const remoteEndpoint = 'https://dwn.example';
    const tenantDid = 'did:example:alice';
    const staleEngine = new SyncEngineLevel({ db });
    const unregisterEngine = new SyncEngineLevel({ db });
    const staleTarget = target(tenantDid);
    const store = (staleEngine as unknown as { _deferredPullStore: SyncDeferredPullStore })._deferredPullStore;
    await registerTenant(tenantDid);

    await unregisterEngine.unregisterIdentity(tenantDid);

    const staleInternal = staleEngine as unknown as {
      deadLetterExpiredDeferredPull(
        target: SyncTarget,
        entry: MessagesQueryReplyEntry,
        detail: string | undefined,
      ): Promise<boolean>;
    };
    expect(await staleInternal.deadLetterExpiredDeferredPull(
      staleTarget,
      { messageCid },
      'dependency unavailable',
    )).toBe(true);

    expect(await store.get(tenantDid, messageCid, remoteEndpoint)).toBeUndefined();
    expect(await syncEngine.getFailedMessages(tenantDid)).toEqual([]);
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
    category?: 'admit-failed';
    messageCid: string;
    remoteEndpoint?: string;
    tenantDid: string;
  }): Promise<void> {
    await syncEngine.recordDeadLetter({
      category       : params.category ?? 'admit-failed',
      errorCode      : 'test',
      errorDetail    : 'test failure',
      messageCid     : params.messageCid,
      remoteEndpoint : params.remoteEndpoint,
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
    const unregisterStore = (unregisterEngine as unknown as { _deferredPullStore: SyncDeferredPullStore })._deferredPullStore;
    sinon.stub(unregisterStore, 'deleteTenant').callsFake(async (): Promise<void> => {
      sweepStarted.resolve();
      await releaseSweep.promise;
    });

    const unregister = unregisterEngine.unregisterIdentity(tenantDid);
    await sweepStarted.promise;

    let registerCompleted = false;
    const register = registerEngine.registerIdentity({ did: tenantDid, options: { protocols: 'all' } })
      .then((): void => { registerCompleted = true; });

    // Give the re-registration ample time to finish if it were NOT queued on
    // the lifecycle lock; a locked registration cannot complete until the
    // gated unregister releases.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(registerCompleted).toBe(false);

    releaseSweep.resolve();
    await unregister;
    await register;

    // Serialized outcome: the re-registration ran wholly after the
    // unregister completed, so the identity ends registered.
    expect(await registerEngine.getIdentityOptions(tenantDid)).toBeDefined();
  });

  it('should keep the registration intact when unregister cleanup fails, then succeed on retry', async () => {
    const tenantDid = 'did:example:alice';
    const remoteEndpoint = 'https://dwn.example';
    const store = (syncEngine as unknown as { _deferredPullStore: SyncDeferredPullStore })._deferredPullStore;
    await registerTenant(tenantDid);
    await store.put(tenantDid, 'cid-1', remoteEndpoint, {
      attempts        : 2,
      firstDeferredAt : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      lastDeferredAt  : new Date().toISOString(),
    });

    const deleteTenant = sinon.stub(store, 'deleteTenant').rejects(new Error('sweep failed'));

    await expect(syncEngine.unregisterIdentity(tenantDid)).rejects.toThrow('sweep failed');
    // The identity marker is the commit point: a failed tenant sweep leaves
    // the registration intact, so no re-registration can inherit the aged
    // deferral — the caller simply retries the unregister.
    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeDefined();

    deleteTenant.restore();
    await syncEngine.unregisterIdentity(tenantDid);

    expect(await syncEngine.getIdentityOptions(tenantDid)).toBeUndefined();
    expect(await store.get(tenantDid, 'cid-1', remoteEndpoint)).toBeUndefined();
  });

  async function registerTenant(tenantDid: string): Promise<void> {
    await db.sublevel('registeredIdentities').put(tenantDid, JSON.stringify({ protocols: 'all' }));
  }

  function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    const promise = new Promise<Value>((promiseResolve) => {
      resolve = promiseResolve;
    });
    return { promise, resolve };
  }
});
