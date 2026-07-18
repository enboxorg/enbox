import type { MessagesQueryReplyEntry } from '@enbox/dwn-sdk-js';

import type { SyncDeferredPullState } from '../src/sync-deferred-pull-store.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

describe('SyncEngineLevel dead letter tracking', () => {
  let db: Level<string, string>;
  let syncEngine: SyncEngineLevel;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-dead-letters-spec');
    syncEngine = new SyncEngineLevel({ db });
  });

  afterEach(async () => {
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

  it('should not resurrect a deferral cleared by a concurrent admission mid-record', async () => {
    const messageCid = 'cid-raced-record';
    const tenantDid = 'did:example:alice';
    const store = (syncEngine as any)._deferredPullStore;
    const aged: SyncDeferredPullState = {
      attempts        : 3,
      firstDeferredAt : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      lastDeferredAt  : new Date().toISOString(),
    };
    const get = sinon.stub(store, 'get');
    get.onFirstCall().resolves(aged);
    // The concurrent admission cleared the row between the merge read and
    // the write-back: the merge must not resurrect it.
    get.onSecondCall().resolves(undefined);
    const put = sinon.stub(store, 'put').resolves();

    const internal = syncEngine as unknown as {
      deadLetterExpiredDeferredPull(
        target: SyncTarget,
        entry: MessagesQueryReplyEntry,
        detail: string | undefined,
      ): Promise<boolean>;
    };
    const promoted = await internal.deadLetterExpiredDeferredPull(
      target('did:example:alice'),
      { messageCid },
      'dependency unavailable',
    );

    expect(promoted).toBe(true);
    expect(put.notCalled).toBe(true);
    expect(await syncEngine.getFailedMessages(tenantDid)).toEqual([]);
    sinon.restore();
  });

  it('should not dead-letter a deferral cleared between the age check and the write', async () => {
    const messageCid = 'cid-raced-expiry';
    const tenantDid = 'did:example:alice';
    const store = (syncEngine as any)._deferredPullStore;
    const aged: SyncDeferredPullState = {
      attempts        : 3,
      firstDeferredAt : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      lastDeferredAt  : new Date().toISOString(),
    };
    const get = sinon.stub(store, 'get');
    get.onFirstCall().resolves(aged);
    get.onSecondCall().resolves(aged);
    // The admission's clear landed after the merge write but before the
    // dead-letter decision: the expiry path must yield, not dead-letter an
    // already-admitted message.
    get.onThirdCall().resolves(undefined);
    sinon.stub(store, 'put').resolves();

    const internal = syncEngine as unknown as {
      deadLetterExpiredDeferredPull(
        target: SyncTarget,
        entry: MessagesQueryReplyEntry,
        detail: string | undefined,
      ): Promise<boolean>;
    };
    const promoted = await internal.deadLetterExpiredDeferredPull(
      target('did:example:alice'),
      { messageCid },
      'dependency unavailable',
    );

    expect(promoted).toBe(true);
    expect(await syncEngine.getFailedMessages(tenantDid)).toEqual([]);
    sinon.restore();
  });

  it('should clear deferred-pull retry state when an identity is unregistered', async () => {
    const remoteEndpoint = 'https://dwn.example';
    const store = (syncEngine as any)._deferredPullStore;
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
});
