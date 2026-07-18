import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { PushResult, SyncEvent } from '../src/types/sync.js';

import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { buildLinkId } from '../src/sync-link-id.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncQuotaManager } from '../src/sync-quota-manager.js';
import {
  computeAuthorizationEpoch,
  computeProjectionId,
  isQuotaBlockedPushFailure,
  pushBatchReconcileReason,
} from '../src/types/sync.js';

describe('quota-block push-failure classification', () => {
  it('isQuotaBlockedPushFailure keys on the quotaBlocked flag', () => {
    expect(isQuotaBlockedPushFailure({ cid: 'c', quotaBlocked: true })).toBe(true);
    expect(isQuotaBlockedPushFailure({ cid: 'c' })).toBe(false);
    expect(isQuotaBlockedPushFailure({ cid: 'c', tenantInactive: true })).toBe(false);
  });

  it('pushBatchReconcileReason surfaces push-quota-blocked, but Incomplete still outranks it', () => {
    expect(pushBatchReconcileReason([{ lastFailure: { cid: 'c', quotaBlocked: true } }]))
      .toBe('push-quota-blocked');
    expect(pushBatchReconcileReason([
      { lastFailure: { cid: 'c', quotaBlocked: true } },
      { lastFailure: { cid: 'd', kind: 'Incomplete' } },
    ])).toBe('push-incomplete');
    expect(pushBatchReconcileReason([{ lastFailure: { cid: 'c' } }])).toBeUndefined();
  });
});

describe('SyncEngineLevel quota-block observability and lifecycle', () => {
  const TENANT = 'did:example:alice';
  const OTHER_TENANT = 'did:example:bob';
  const REMOTE = 'https://dwn.example.com';
  let db: Level<string, string>;
  let projectionId: string;
  let syncEngine: SyncEngineLevel;

  async function seedQuotaBlock({
    authorizationEpoch = 'owner',
    blockedCid,
    cid,
    detail,
    lastBlockedAt = new Date(0).toISOString(),
    nextProbeAt,
    remote = REMOTE,
    source = 'feed',
    supersededAt,
    tenant = TENANT,
  }: {
    authorizationEpoch?: string;
    blockedCid?: string;
    cid: string;
    detail?: string;
    lastBlockedAt?: string;
    nextProbeAt: string;
    remote?: string;
    source?: 'feed' | 'permission-grant';
    supersededAt?: string;
    tenant?: string;
  }): Promise<void> {
    const stamp = new Date(0).toISOString();
    const projectionId = await computeProjectionId(tenant, { kind: 'full' });
    const linkKey = buildLinkId(tenant, remote, projectionId, authorizationEpoch);
    await db.sublevel('quotaBlocks').put(
      `${tenant}|${cid}|${encodeURIComponent(linkKey)}`,
      JSON.stringify({
        attempts       : 1,
        authorizationEpoch,
        blockedCid,
        detail,
        firstBlockedAt : stamp,
        lastBlockedAt,
        linkKey,
        messageCid     : cid,
        nextProbeAt,
        projectionId,
        remoteEndpoint : remote,
        source,
        supersededAt,
        tenantDid      : tenant,
      }),
    );
  }

  async function seedCurrentLink(params: {
    connectivity: 'offline' | 'online' | 'unknown';
    lastActivityAt?: string;
  }): Promise<void> {
    const scope = { kind: 'full' as const };
    const projectionId = await computeProjectionId(TENANT, scope);
    const authorizationEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
    await db.sublevel('registeredIdentities').put(TENANT, JSON.stringify({ protocols: 'all' }));
    await db.sublevel('replicationLinks').put(
      buildLinkId(TENANT, REMOTE, projectionId, authorizationEpoch),
      JSON.stringify({
        tenantDid      : TENANT,
        remoteEndpoint : REMOTE,
        projectionId,
        authorizationEpoch,
        scope,
        authorization  : { kind: 'owner' },
        status         : 'polling',
        connectivity   : params.connectivity,
        pull           : {},
        push           : {},
        ...(params.lastActivityAt === undefined ? {} : { lastActivityAt: params.lastActivityAt }),
      }),
    );
  }

  beforeAll(async () => {
    projectionId = await computeProjectionId(TENANT, { kind: 'full' });
    db = new Level<string, string>('__TESTDATA__/sync-quota-block-spec');
    syncEngine = new SyncEngineLevel({ db });
  });

  afterEach(async () => {
    sinon.restore();
    (syncEngine as any)._targetPlanner.invalidate();
    if ((syncEngine as any)._lifecycle.isSyncInProgress) {
      (syncEngine as any)._lifecycle.releaseSync();
    }
    await db.sublevel('quotaBlocks').clear();
    await db.sublevel('deadLetters').clear();
    await db.sublevel('replicationLinks').clear();
    await db.sublevel('registeredIdentities').clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('counts quota blocks as unhealthy without misclassifying them as dead letters', async () => {
    await seedQuotaBlock({
      cid         : 'cid-1',
      detail      : 'over quota',
      nextProbeAt : new Date(Date.now() + 60_000).toISOString(),
    });

    const health = await syncEngine.getSyncHealth();

    expect(health).toMatchObject({
      quotaBlockedMessageCount : 1,
      failedMessageCount       : 0,
      syncHealthy              : false,
    });
  });

  it('reports a per-remote quota-blocked status with the soonest probe and latest detail', async () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 300_000).toISOString();
    await seedQuotaBlock({ cid: 'cid-1', detail: 'first', lastBlockedAt: new Date(1).toISOString(), nextProbeAt: later });
    await seedQuotaBlock({ cid: 'cid-2', detail: 'second', lastBlockedAt: new Date(2).toISOString(), nextProbeAt: soon });

    const statuses = await syncEngine.getRemoteSyncStatus(TENANT);

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      tenantDid                : TENANT,
      remoteEndpoint           : REMOTE,
      state                    : 'quota-blocked',
      quotaBlockedMessageCount : 2,
      failedMessageCount       : 0,
      lastError                : 'second',
      nextProbeAt              : soon,
    });
  });

  it('scopes status by tenant', async () => {
    await seedQuotaBlock({ cid: 'cid-1', nextProbeAt: new Date(Date.now() + 60_000).toISOString() });

    expect(await syncEngine.getRemoteSyncStatus(OTHER_TENANT)).toHaveLength(0);
    expect(await syncEngine.getRemoteSyncStatus(TENANT)).toHaveLength(1);
  });

  it('reports terminal-only remote failures as degraded with their error', async () => {
    await syncEngine.recordDeadLetter({
      category       : 'admit-failed',
      errorCode      : 'Invalid',
      errorDetail    : 'terminal rejection',
      messageCid     : 'dl-1',
      remoteEndpoint : REMOTE,
      tenantDid      : TENANT,
    });

    const [status] = await syncEngine.getRemoteSyncStatus(TENANT);

    expect(status).toMatchObject({
      remoteEndpoint           : REMOTE,
      state                    : 'degraded',
      failedMessageCount       : 1,
      quotaBlockedMessageCount : 0,
      lastError                : 'terminal rejection',
    });
  });

  it('keeps offline precedence while retaining quota details and last activity', async () => {
    const lastActivityAt = new Date(Date.now() - 1_000).toISOString();
    await seedCurrentLink({ connectivity: 'offline', lastActivityAt });
    await seedQuotaBlock({ cid: 'cid-1', nextProbeAt: new Date(Date.now() + 60_000).toISOString() });

    const [status] = await syncEngine.getRemoteSyncStatus(TENANT);

    expect(status).toMatchObject({
      state                    : 'offline',
      connectivity             : 'offline',
      quotaBlockedMessageCount : 1,
      lastActivityAt,
    });
  });

  it('unregistering an identity removes only that tenant\'s quota state', async () => {
    const nextProbeAt = new Date(Date.now() + 60_000).toISOString();
    await db.sublevel('registeredIdentities').put(TENANT, JSON.stringify({ protocols: 'all' }));
    await seedQuotaBlock({ cid: 'alice-cid', nextProbeAt });
    await seedQuotaBlock({ cid: 'bob-cid', nextProbeAt, tenant: OTHER_TENANT });

    await syncEngine.unregisterIdentity(TENANT);

    expect(await syncEngine.getRemoteSyncStatus(TENANT)).toHaveLength(0);
    expect((await syncEngine.getRemoteSyncStatus(OTHER_TENANT))[0].quotaBlockedMessageCount).toBe(1);
  });

  it('replacement identity options do not inherit quota state from the old link', async () => {
    await db.sublevel('registeredIdentities').put(TENANT, JSON.stringify({ protocols: 'all' }));
    await seedQuotaBlock({ cid: 'old-link-cid', nextProbeAt: new Date(Date.now() + 60_000).toISOString() });

    await syncEngine.updateIdentityOptions({ did: TENANT, options: { protocols: 'all' } });

    expect(await syncEngine.getRemoteSyncStatus(TENANT)).toHaveLength(0);
  });

  it('prunes a superseded authorization epoch without clearing the replacement link', async () => {
    const nextProbeAt = new Date(Date.now() + 60_000).toISOString();
    await seedQuotaBlock({ authorizationEpoch: 'old-epoch', cid: 'old-cid', nextProbeAt });
    await seedQuotaBlock({ authorizationEpoch: 'new-epoch', cid: 'new-cid', nextProbeAt });
    const internal = syncEngine as unknown as {
      pruneQuotaBlocksForCurrentTargets(targets: unknown[], expectedGeneration: number): Promise<void>;
    };

    await internal.pruneQuotaBlocksForCurrentTargets([{
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'new-epoch',
      projectionId,
    }], (syncEngine as any)._targetPlanner.generation);

    const [status] = await syncEngine.getRemoteSyncStatus(TENANT);
    expect(status.quotaBlockedMessageCount).toBe(1);
    const remaining = [...await db.sublevel('quotaBlocks').values().all()]
      .map((value) => ({ messageCid: (JSON.parse(value) as { messageCid: string }).messageCid }));
    expect(remaining).toEqual([{ messageCid: 'new-cid' }]);
  });

  it('filters stale endpoint and authorization quota rows from health after a complete target refresh', async () => {
    const currentRemote = 'https://current-dwn.example.com';
    const currentEpoch = 'current-epoch';
    const nextProbeAt = new Date(Date.now() + 60_000).toISOString();
    await db.sublevel('registeredIdentities').put(TENANT, JSON.stringify({ protocols: 'all' }));
    await seedQuotaBlock({ authorizationEpoch: 'old-epoch', cid: 'old-epoch-cid', nextProbeAt });
    await seedQuotaBlock({ authorizationEpoch: currentEpoch, cid: 'old-endpoint-cid', nextProbeAt });
    await seedQuotaBlock({
      authorizationEpoch : currentEpoch,
      cid                : 'current-cid',
      nextProbeAt,
      remote             : currentRemote,
    });

    const internal = syncEngine as any;
    sinon.stub(internal.targetResolver, 'getEndpointUrls').resolves([currentRemote]);
    sinon.stub(internal.targetResolver, 'buildTargetResolutions').resolves([{
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : currentEpoch,
    }]);

    const health = await syncEngine.getSyncHealth();
    const statuses = await syncEngine.getRemoteSyncStatus(TENANT);

    expect(health.quotaBlockedMessageCount).toBe(1);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      remoteEndpoint           : currentRemote,
      quotaBlockedMessageCount : 1,
      state                    : 'quota-blocked',
    });
    const remaining = [...await db.sublevel('quotaBlocks').values().all()]
      .map((value) => (JSON.parse(value) as { messageCid: string }).messageCid);
    expect(remaining).toEqual(['current-cid']);
  });

  it('schedules a permission-grant bundle only when its latest blocked grant is due', async () => {
    const early = new Date(Date.now() + 30_000).toISOString();
    const late = new Date(Date.now() + 300_000).toISOString();
    await seedQuotaBlock({ cid: 'grant-a', nextProbeAt: early, source: 'permission-grant' });
    await seedQuotaBlock({ cid: 'grant-b', nextProbeAt: late, source: 'permission-grant' });
    const internal = syncEngine as unknown as {
      getNextQuotaProbeAtForTarget(target: unknown): Promise<string | undefined>;
    };

    const nextProbeAt = await internal.getNextQuotaProbeAtForTarget({
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    });

    expect(nextProbeAt).toBe(late);
  });

  it('automatically probes only due feed blocks and backs off a repeated quota rejection', async () => {
    const future = new Date(Date.now() + 300_000).toISOString();
    await seedQuotaBlock({ cid: 'due-cid', nextProbeAt: new Date(0).toISOString() });
    await seedQuotaBlock({ cid: 'future-cid', nextProbeAt: future });
    const internal = syncEngine as unknown as {
      getLocalMessageForTarget(): Promise<undefined>;
      probeQuotaBlocksForTarget(target: unknown): Promise<void>;
      pushMessages(params: { messageCids: string[] }): Promise<PushResult>;
    };
    sinon.stub(internal, 'getLocalMessageForTarget').resolves(undefined);
    const pushStub = sinon.stub(internal, 'pushMessages').callsFake(async ({ messageCids }): Promise<PushResult> => ({
      succeeded : [],
      failed    : [{
        cid          : messageCids[0],
        kind         : 'Deferred',
        reason       : 'storage',
        quotaBlocked : true,
        detail       : 'still over quota',
      }],
    }));
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' as const },
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner',
      projectionId,
    };

    await internal.probeQuotaBlocksForTarget(target);
    await internal.probeQuotaBlocksForTarget(target);

    expect(pushStub.calledOnce).toBe(true);
    expect(pushStub.firstCall.args[0].messageCids).toEqual(['due-cid']);
    const states = [...await db.sublevel('quotaBlocks').values().all()]
      .map((value) => JSON.parse(value) as { attempts: number; messageCid: string; nextProbeAt: string });
    expect(states.find(({ messageCid }) => messageCid === 'due-cid')).toMatchObject({ attempts: 2 });
    expect(states.find(({ messageCid }) => messageCid === 'future-cid')).toMatchObject({ attempts: 1, nextProbeAt: future });
  });

  it('does not directly stage a positive-size RecordsWrite after its local data was superseded', async () => {
    await seedQuotaBlock({ cid: 'dataless-cid', nextProbeAt: new Date(0).toISOString() });
    const internal = syncEngine as any;
    sinon.stub(internal, 'getLocalMessageForTarget').resolves({
      message: {
        recordId   : 'record-1',
        descriptor : {
          interface        : 'Records',
          method           : 'Write',
          dataCid          : 'data-cid',
          dataSize         : 10,
          messageTimestamp : '2026-01-01T00:00:00.000000Z',
        },
      },
    });
    const pushMessagesStub = sinon.stub(internal, 'pushMessages');
    const pushEntriesStub = sinon.stub(internal, 'pushMessageEntries');
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    };

    await internal.probeQuotaBlocksForTarget(target, true);

    expect(pushMessagesStub.called).toBe(false);
    expect(pushEntriesStub.called).toBe(false);
    const [stateValue] = await db.sublevel('quotaBlocks').values().all();
    const state = JSON.parse(stateValue) as { attempts: number; nextProbeAt: string };
    expect(state.attempts).toBe(1);
    expect(Date.parse(state.nextProbeAt)).toBeGreaterThan(Date.now());
  });

  it('waits to preserve Retry now while another operation owns the sync lock', async () => {
    const internal = syncEngine as any;
    const targets = sinon.stub(internal, 'getSyncTargets').resolves([]);
    expect(internal._lifecycle.tryAcquireSync()).toBe(true);

    const retry = syncEngine.retryRemoteNow(TENANT, REMOTE);
    await Promise.resolve();

    expect(targets.called).toBe(false);
    internal._lifecycle.releaseSync();
    await retry;

    expect(targets.calledOnce).toBe(true);
  });

  it('retries a quota-blocked permission grant only through forced reconciliation', async () => {
    await seedQuotaBlock({
      cid         : 'grant-cid',
      nextProbeAt : new Date(0).toISOString(),
      source      : 'permission-grant',
    });
    const internal = syncEngine as any;
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      permissionGrantIds : ['grant-cid'],
      projectionId,
    };
    sinon.stub(internal, 'getSyncTargets').resolves([target]);
    const bootstrap = sinon.stub(internal, 'bootstrapRemotePermissionGrants').resolves({
      kind               : 'processed',
      failures           : [],
      hasActionableDiffs : true,
      quotaBlocked       : false,
    });
    const reconcile = sinon.stub(internal, 'syncTargetWithDurableFeeds')
      .callsFake(async (reconcileTarget: unknown, options: { forceQuotaProbe?: boolean }): Promise<unknown> => {
        await bootstrap(reconcileTarget, undefined, options.forceQuotaProbe);
        return {};
      });

    await syncEngine.retryRemoteNow(TENANT, REMOTE);

    expect(reconcile.calledOnceWith(
      target,
      { direction: 'push', forceQuotaProbe: true },
      sinon.match.func,
    )).toBe(true);
    expect(bootstrap.calledOnceWith(target, undefined, true)).toBe(true);
  });

  it('aborts an exact-target retry when registration topology changes in flight', async () => {
    const internal = syncEngine as any;
    const transitionFence = internal.captureTransitionFence() as () => boolean;
    const topologyGeneration = internal._targetPlanner.generation as number;
    sinon.stub(internal, 'getQuotaBlocksForTarget').callsFake(async () => {
      internal._targetPlanner.invalidate();
      return [{
        messageCid : 'blocked-cid',
        state      : { source: 'feed' },
      }];
    });
    const reconcile = sinon.stub(internal, 'syncTargetWithDurableFeeds');

    await internal.retryQuotaBlocksForTarget({
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    }, transitionFence, topologyGeneration);

    expect(reconcile.called).toBe(false);
  });

  it('composes a runtime-transition fence into every quota probe from any runtime state', async () => {
    const internal = syncEngine as any;
    const fences: Array<() => boolean> = [];
    sinon.stub(internal._quotaManager, 'probeBlocksForTarget').callsFake(
      async (_target: unknown, _force: unknown, _cids: unknown, shouldContinue: () => boolean): Promise<void> => {
        fences.push(shouldContinue);
      },
    );
    const probeTarget = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    };

    // Active runtime: the fence holds until a transition disposes the scope.
    await internal.probeQuotaBlocksForTarget(probeTarget);
    expect(fences[0]()).toBe(true);
    internal.prepareForSyncRuntimeTransition();
    expect(fences[0]()).toBe(false);

    // Stopped state (scope already disposed at capture): the fence holds —
    // a stopped-state retryRemoteNow must still probe — until a new runtime
    // replaces the captured one.
    await internal.probeQuotaBlocksForTarget(probeTarget);
    expect(fences[1]()).toBe(true);
    internal._runtime = new (internal._runtime.constructor)();
    expect(fences[1]()).toBe(false);

    // A caller-supplied fence composes with the transition fence.
    await internal.probeQuotaBlocksForTarget(probeTarget, false, undefined, (): boolean => false);
    expect(fences[2]()).toBe(false);
  });

  it('does not let one quota omission mask an unrelated exact feed divergence', async () => {
    await seedQuotaBlock({
      cid         : 'blocked-cid',
      nextProbeAt : new Date(Date.now() + 60_000).toISOString(),
    });
    const internal = syncEngine as unknown as {
      collectLocalFeedCids(target: unknown): Promise<Set<string> | undefined>;
      collectRemoteFeedCids(target: unknown): Promise<Set<string> | undefined>;
      isFeedDivergenceExplainedByQuotaBlocks(target: unknown, result: unknown): Promise<boolean>;
    };
    sinon.stub(internal, 'collectLocalFeedCids').resolves(new Set(['blocked-cid', 'unrelated-cid']));
    sinon.stub(internal, 'collectRemoteFeedCids').resolves(new Set());

    const explained = await internal.isFeedDivergenceExplainedByQuotaBlocks({
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    }, {
      localFingerprint  : 'local',
      remoteFingerprint : 'remote',
    });

    expect(explained).toBe(false);
  });

  it('does not let one quota omission mask a remote-only feed divergence', async () => {
    await seedQuotaBlock({
      cid         : 'blocked-cid',
      nextProbeAt : new Date(Date.now() + 60_000).toISOString(),
    });
    const internal = syncEngine as unknown as {
      collectLocalFeedCids(target: unknown): Promise<Set<string> | undefined>;
      collectRemoteFeedCids(target: unknown): Promise<Set<string> | undefined>;
      isFeedDivergenceExplainedByQuotaBlocks(target: unknown, result: unknown): Promise<boolean>;
    };
    sinon.stub(internal, 'collectLocalFeedCids').resolves(new Set(['blocked-cid']));
    sinon.stub(internal, 'collectRemoteFeedCids').resolves(new Set(['remote-only-cid']));

    const explained = await internal.isFeedDivergenceExplainedByQuotaBlocks({
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    }, {
      localFingerprint  : 'local',
      remoteFingerprint : 'remote',
    });

    expect(explained).toBe(false);
  });

  it('retains a resolved dependency omission until every explained CID is accounted for', async () => {
    const supersededAt = new Date().toISOString();
    await seedQuotaBlock({
      blockedCid  : 'initial-cid',
      cid         : 'update-cid',
      nextProbeAt : new Date(Date.now() + 60_000).toISOString(),
      supersededAt,
    });
    let localCids = new Set(['initial-cid', 'update-cid']);
    let remoteCids = new Set(['update-cid']);
    const internal = syncEngine as unknown as {
      collectLocalFeedCids(target: unknown): Promise<Set<string> | undefined>;
      collectRemoteFeedCids(target: unknown): Promise<Set<string> | undefined>;
      getQuotaStatesForTarget(target: unknown): Promise<Array<{ messageCid: string; state: { supersededAt?: string } }>>;
      isFeedDivergenceExplainedByQuotaBlocks(target: unknown, result: unknown): Promise<boolean>;
    };
    sinon.stub(internal, 'collectLocalFeedCids').callsFake(async () => localCids);
    sinon.stub(internal, 'collectRemoteFeedCids').callsFake(async () => remoteCids);
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    };

    expect(await internal.isFeedDivergenceExplainedByQuotaBlocks(target, {})).toBe(true);
    expect(await internal.getQuotaStatesForTarget(target)).toEqual([
      expect.objectContaining({
        messageCid : 'update-cid',
        state      : expect.objectContaining({ supersededAt }),
      }),
    ]);

    // Compaction can retire the root before the dependency. The row must still
    // explain the remaining local-only initial CID instead of being collected
    // solely because its key CID left the local feed.
    localCids = new Set(['initial-cid']);
    remoteCids = new Set();
    expect(await internal.isFeedDivergenceExplainedByQuotaBlocks(target, {})).toBe(true);
    expect(await internal.getQuotaStatesForTarget(target)).toHaveLength(1);

    // Once the remote accounts for both the root and its attributed dependency,
    // the explanatory row is no longer needed.
    localCids = new Set(['initial-cid', 'update-cid']);
    remoteCids = new Set(['initial-cid', 'update-cid']);
    await internal.isFeedDivergenceExplainedByQuotaBlocks(target, {});
    expect(await internal.getQuotaStatesForTarget(target)).toHaveLength(0);
  });

  it('uses delete-wins and strict same-record ordering when resolving blocked writes', async () => {
    const blocked = {
      recordId   : 'record-a',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        dateCreated      : '2026-01-01T00:00:00.000000Z',
        messageTimestamp : '2026-01-03T00:00:00.000000Z',
      },
    } as GenericMessage;
    const olderDelete = {
      descriptor: {
        interface        : 'Records',
        method           : 'Delete',
        messageTimestamp : '2026-01-01T00:00:00.000000Z',
        recordId         : 'record-a',
      },
    } as GenericMessage;
    const olderUpdate = {
      recordId   : 'record-a',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        dateCreated      : '2026-01-01T00:00:00.000000Z',
        messageTimestamp : '2026-01-02T00:00:00.000000Z',
      },
    } as GenericMessage;
    const unrelatedNewerUpdate = {
      recordId   : 'record-b',
      descriptor : {
        interface        : 'Records',
        method           : 'Write',
        dateCreated      : '2026-01-01T00:00:00.000000Z',
        messageTimestamp : '2026-01-04T00:00:00.000000Z',
      },
    } as GenericMessage;
    const quotaPolicy = SyncQuotaManager as unknown as {
      acknowledgementSupersedesBlockedWrite(
        acknowledgement: GenericMessage,
        blocked: GenericMessage,
      ): Promise<boolean>;
    };

    expect(await quotaPolicy.acknowledgementSupersedesBlockedWrite(olderDelete, blocked)).toBe(true);
    expect(await quotaPolicy.acknowledgementSupersedesBlockedWrite(olderUpdate, blocked)).toBe(false);
    expect(await quotaPolicy.acknowledgementSupersedesBlockedWrite(unrelatedNewerUpdate, blocked)).toBe(false);
  });

  it('terminal reclassification removes stale quota state without emitting a recovery event', async () => {
    await seedQuotaBlock({ cid: 'cid-1', nextProbeAt: new Date(0).toISOString() });
    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on((event) => events.push(event));
    const internal = syncEngine as unknown as {
      transitionPushResult(target: unknown, result: PushResult): Promise<unknown>;
    };

    await internal.transitionPushResult({
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    }, {
      succeeded : [],
      failed    : [{ cid: 'cid-1', kind: 'Invalid', terminal: true, detail: 'terminal now' }],
    });
    unsubscribe();

    const [status] = await syncEngine.getRemoteSyncStatus(TENANT);
    expect(status).toMatchObject({ state: 'degraded', quotaBlockedMessageCount: 0, failedMessageCount: 1 });
    expect(events.some((event) => event.type === 'push:quota-cleared')).toBe(false);
  });

  it('does not recreate quota state when the same result also acknowledges the CID', async () => {
    await seedQuotaBlock({ cid: 'cid-1', nextProbeAt: new Date(0).toISOString() });
    const internal = syncEngine as unknown as {
      transitionPushResult(target: unknown, result: PushResult): Promise<{ quotaBlocked: boolean }>;
      getQuotaStatesForTarget(target: unknown): Promise<unknown[]>;
    };
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    };

    const transition = await internal.transitionPushResult(target, {
      succeeded    : ['cid-1'],
      acknowledged : [{ cid: 'cid-1', resolution: 'applied' }],
      failed       : [{
        cid          : 'cid-1',
        detail       : 'stale over-quota result',
        kind         : 'Deferred',
        quotaBlocked : true,
        reason       : 'storage',
      }],
    });

    expect(transition.quotaBlocked).toBe(false);
    expect(await internal.getQuotaStatesForTarget(target)).toHaveLength(0);
    expect(await db.sublevel('quotaBlocks').values().all()).toHaveLength(0);
  });

  it('keeps an exact Superseded acknowledgement as a resolved omission that stale quota cannot resurrect', async () => {
    await seedQuotaBlock({ cid: 'cid-1', nextProbeAt: new Date(0).toISOString() });
    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on((event) => events.push(event));
    const internal = syncEngine as unknown as {
      transitionPushResult(target: unknown, result: PushResult): Promise<unknown>;
      getQuotaBlocksForTarget(target: unknown): Promise<unknown[]>;
      getQuotaStatesForTarget(target: unknown): Promise<Array<{ state: { attempts: number; supersededAt?: string } }>>;
    };
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    };

    await internal.transitionPushResult(target, {
      succeeded    : ['cid-1'],
      acknowledged : [{ cid: 'cid-1', resolution: 'superseded' }],
      failed       : [],
    });

    const [resolved] = await internal.getQuotaStatesForTarget(target);
    expect(resolved.state).toMatchObject({ attempts: 1, supersededAt: expect.any(String) });
    expect(await internal.getQuotaBlocksForTarget(target)).toHaveLength(0);

    await internal.transitionPushResult(target, {
      succeeded : [],
      failed    : [{
        cid          : 'cid-1',
        detail       : 'stale over-quota result',
        kind         : 'Deferred',
        quotaBlocked : true,
        reason       : 'storage',
      }],
    });
    await internal.transitionPushResult(target, {
      succeeded : [],
      failed    : [{ cid: 'cid-1', kind: 'Invalid', terminal: true, detail: 'stale terminal result' }],
    });
    unsubscribe();

    expect(events).toContainEqual(expect.objectContaining({
      type       : 'push:quota-cleared',
      messageCid : 'cid-1',
      resolution : 'superseded',
    }));
    expect(events.some((event) => event.type === 'push:quota-blocked')).toBe(false);
    expect(await syncEngine.getFailedMessages(TENANT)).toHaveLength(0);
    expect(await internal.getQuotaStatesForTarget(target)).toEqual([
      expect.objectContaining({
        state: expect.objectContaining({
          attempts     : 1,
          supersededAt : resolved.state.supersededAt,
        }),
      }),
    ]);
    expect(await syncEngine.getRemoteSyncStatus(TENANT)).toHaveLength(0);
  });

  it('deletes an exact quota row after an Applied acknowledgement', async () => {
    await seedQuotaBlock({ cid: 'cid-1', nextProbeAt: new Date(0).toISOString() });
    const internal = syncEngine as unknown as {
      transitionPushResult(target: unknown, result: PushResult): Promise<unknown>;
      getQuotaStatesForTarget(target: unknown): Promise<unknown[]>;
    };
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    };

    await internal.transitionPushResult(target, {
      succeeded    : ['cid-1'],
      acknowledged : [{ cid: 'cid-1', resolution: 'applied' }],
      failed       : [],
    });

    expect(await internal.getQuotaStatesForTarget(target)).toHaveLength(0);
    expect(await db.sublevel('quotaBlocks').values().all()).toHaveLength(0);
  });

  it('emits push:quota-blocked with the CID, detail, and next probe time on a fresh block', async () => {
    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on((event) => events.push(event));
    const internal = syncEngine as unknown as {
      transitionPushResult(target: unknown, result: PushResult): Promise<{ quotaBlocked: boolean; nextQuotaProbeAt?: string }>;
    };
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    };

    const before = Date.now();
    const transition = await internal.transitionPushResult(target, {
      succeeded : [],
      failed    : [{
        cid          : 'cid-1',
        detail       : 'tenant over storage quota',
        kind         : 'Deferred',
        quotaBlocked : true,
        reason       : 'storage',
      }],
    });
    unsubscribe();

    expect(transition.quotaBlocked).toBe(true);
    const blocked = events.filter(
      (event): event is Extract<SyncEvent, { type: 'push:quota-blocked' }> => event.type === 'push:quota-blocked',
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      type           : 'push:quota-blocked',
      tenantDid      : TENANT,
      remoteEndpoint : REMOTE,
      messageCid     : 'cid-1',
      detail         : 'tenant over storage quota',
    });
    // The first block schedules the soonest (30s) re-probe, and the event
    // carries the same durable nextProbeAt the transition reports to the caller.
    const probeDelay = Date.parse(blocked[0].nextProbeAt) - before;
    expect(probeDelay).toBeGreaterThanOrEqual(30_000);
    expect(probeDelay).toBeLessThan(60_000);
    expect(transition.nextQuotaProbeAt).toBe(blocked[0].nextProbeAt);
  });

  it('extends the re-probe backoff along the 30s/1m/5m/15m/30m ladder and clamps at 30m', async () => {
    const internal = syncEngine as unknown as {
      transitionPushResult(target: unknown, result: PushResult): Promise<unknown>;
      getQuotaStatesForTarget(target: unknown): Promise<Array<{ state: { lastBlockedAt: string; nextProbeAt: string } }>>;
    };
    const target = {
      did                : TENANT,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner',
      projectionId,
    };

    const ladder = [30_000, 60_000, 300_000, 900_000, 1_800_000];
    const observed: number[] = [];
    // One extra block past the ladder must clamp at the final 30m rung.
    for (let attempt = 0; attempt < ladder.length + 1; attempt++) {
      await internal.transitionPushResult(target, {
        succeeded : [],
        failed    : [{
          cid          : 'cid-1',
          detail       : 'still over quota',
          kind         : 'Deferred',
          quotaBlocked : true,
          reason       : 'storage',
        }],
      });
      const [{ state }] = await internal.getQuotaStatesForTarget(target);
      // nextProbeAt and lastBlockedAt derive from the same instant, so their
      // delta is exactly the backoff delay recorded for that attempt.
      observed.push(Date.parse(state.nextProbeAt) - Date.parse(state.lastBlockedAt));
    }

    expect(observed).toEqual([...ladder, 1_800_000]);
  });
});
