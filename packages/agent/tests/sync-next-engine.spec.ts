import type { GenericMessage, ProgressToken } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { FollowedSyncSourceStore } from '../src/followed-sync-source.js';
import type { SyncEngineNextTargetPlanner } from '../src/sync-next/engine.js';
import type { SyncNextPullPageResult } from '../src/sync-next/pull-page.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { SyncIdentityStore, SyncIdentityStoreEntry } from '../src/sync-identity-store.js';
import type { SyncNextRunResult, SyncNextTargetRunResult } from '../src/sync-next/runner.js';

import { Level } from 'level';
import { Message } from '@enbox/dwn-sdk-js';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineNext } from '../src/sync-next/engine.js';
import { syncNextLinkIdentity } from '../src/sync-next/progress-key.js';
import { SyncNextProgressStore } from '../src/sync-next/progress-store.js';
import { SyncNextRunner } from '../src/sync-next/runner.js';
import { SyncTargetPlanner } from '../src/sync-target-planner.js';

const progressStorePath = '__TESTDATA__/sync-next-engine-spec';

function target({
  did = 'did:example:alice',
  endpoint = 'https://dwn.example.com',
  epoch = 'owner-epoch',
  projectionId = 'projection',
}: {
  did?: string;
  endpoint?: string;
  epoch?: string;
  projectionId?: string;
} = {}): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : epoch,
    did,
    dwnUrl             : endpoint,
    projectionId,
    scope              : { kind: 'full' },
  };
}

function roleTarget({
  endpoint = 'https://role.example.com',
  projectionId = 'role-projection',
}: {
  endpoint?: string;
  projectionId?: string;
} = {}): SyncTarget {
  return {
    authorization: {
      actorDid     : 'did:example:member',
      kind         : 'role',
      protocolRole : 'thread/member',
      roleRecordId : 'role-record',
    },
    authorizationEpoch : 'role-epoch',
    delegateDid        : 'did:example:delegate',
    did                : 'did:example:owner',
    dwnUrl             : endpoint,
    projectionId,
    scope              : {
      contextId     : projectionId,
      kind          : 'context',
      protocol      : 'https://example.com/threads',
      protocolPaths : ['thread'],
    },
  };
}

type RunResultOptions = Omit<Partial<SyncNextRunResult>, 'targetResults'> & {
  feedAttempted?: boolean;
  syncTargets?: readonly SyncTarget[];
  targetResults?: SyncNextTargetRunResult[];
};

function runResult({
  feedAttempted = true,
  syncTargets = [target()],
  targetResults,
  ...overrides
}: RunResultOptions = {}): SyncNextRunResult {
  const feedCovered = overrides.feedCovered ?? true;
  const workRemaining = overrides.workRemaining ?? false;
  return {
    blockedEndpoints : [],
    failures         : [],
    feedCovered,
    madeProgress     : false,
    remoteRequests   : 1,
    targetResults    : targetResults ?? syncTargets.map(syncTarget => ({
      feedAttempted,
      feedCovered,
      identity: syncNextLinkIdentity(syncTarget),
      workRemaining,
    })),
    workRemaining,
    ...overrides,
  };
}

function token(position: number): ProgressToken {
  return { epoch: 'epoch', position: String(position), streamId: 'stream' };
}

class TestTargetPlanner implements SyncEngineNextTargetPlanner {
  public lastResolutionComplete = true;
  public topologyGeneration = 0;

  public constructor(public targets: SyncTarget[]) {}

  public async getTargets(): Promise<SyncTarget[]> {
    return this.targets;
  }

  public async withCurrentRoleGrant(target: SyncTarget): Promise<SyncTarget> {
    return target;
  }
}

describe('SyncEngineNext', () => {
  let db: Level<string, string>;
  let progressStore: SyncNextProgressStore;

  beforeAll(() => {
    db = new Level<string, string>(progressStorePath);
    progressStore = new SyncNextProgressStore(db, 'sync-next-engine-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await progressStore.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('retires stale links only from a complete target plan', async () => {
    const stale = target({ epoch: 'old-epoch' });
    const current = target({ epoch: 'new-epoch' });
    await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(stale),
      authorization : stale.authorization,
      scope         : stale.scope,
    });
    const planner = new TestTargetPlanner([current]);
    const runner = { run: sinon.stub().resolves(runResult({ syncTargets: [current] })) };

    await new SyncEngineNext(planner, progressStore, runner).run('pull');

    expect(await progressStore.getLink(syncNextLinkIdentity(stale))).toBeUndefined();
    expect(await progressStore.getLink(syncNextLinkIdentity(current))).toBeDefined();

    const retained = target({ endpoint: 'https://retained.example.com' });
    await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(retained),
      authorization : retained.authorization,
      scope         : retained.scope,
    });
    planner.targets = [];
    planner.lastResolutionComplete = false;

    const result = await new SyncEngineNext(planner, progressStore, runner).run('pull');

    expect(await progressStore.getLink(syncNextLinkIdentity(retained))).toBeDefined();
    expect(result.targetsCurrent).toBe(false);
    expect(result.workRemaining).toBe(true);
  });

  it('reports quarantine retained after its last link retires', async () => {
    const stale = target();
    const link = await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(stale),
      authorization : stale.authorization,
      scope         : stale.scope,
    });
    const message = {
      descriptor: {
        definition       : { protocol: 'https://example.com/pending', published: true, structure: {}, types: {} },
        interface        : 'Protocols',
        messageTimestamp : '2026-10-09T00:00:00.000000Z',
        method           : 'Configure',
      },
    } as GenericMessage;
    const messageCid = await Message.getCid(message);
    const source = { ...token(1), messageCid };
    expect(await progressStore.commitPullPage(link, {
      checkpoint   : source,
      pageReceipts : [{ messageCid, source }],
      quarantine   : [{ entry: { isLatestBaseState: true, message, messageCid, seq: '1' }, messageCid, source }],
      settled      : [],
    })).toBe(true);

    const result = await new SyncEngineNext(
      new TestTargetPlanner([]), progressStore, { run: sinon.stub().resolves(runResult()) },
    ).run('pull');

    expect(await progressStore.getAllLinks()).toEqual([]);
    expect(await progressStore.hasPendingWork()).toEqual({ delivery: false, quarantine: true });
    expect(result).toMatchObject({ quarantinePending: true, targetCount: 0, targetsCurrent: true, workRemaining: true });
  });

  it('runs usable targets from an incomplete plan without retiring other links', async () => {
    const retained = target({ endpoint: 'https://retained.example.com' });
    const usable = target({ endpoint: 'https://usable.example.com' });
    await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(retained),
      authorization : retained.authorization,
      scope         : retained.scope,
    });
    const planner = new TestTargetPlanner([usable]);
    planner.lastResolutionComplete = false;
    const run = sinon.stub().resolves(runResult({ syncTargets: [usable] }));

    const result = await new SyncEngineNext(planner, progressStore, { run }).run('pull');

    expect(run.firstCall.args[0]).toEqual([usable]);
    expect(await progressStore.getLink(syncNextLinkIdentity(retained))).toBeDefined();
    expect(result).toMatchObject({ targetCount: 1, targetsCurrent: false, workRemaining: true });
  });

  it('does not execute a target invalidated during real target planning', async () => {
    const removedTarget = target();
    let registered = true;
    let releaseDiscovery!: () => void;
    let markDiscoveryStarted!: () => void;
    const discoveryPending = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    const discoveryStarted = new Promise<void>(resolve => { markDiscoveryStarted = resolve; });
    const identityStore = {
      clear   : sinon.stub().resolves(),
      delete  : sinon.stub().resolves(),
      entries : (): AsyncIterable<SyncIdentityStoreEntry> => ({
        async *[Symbol.asyncIterator](): AsyncIterator<SyncIdentityStoreEntry> {
          if (registered) {
            yield { status: 'valid' as const, did: removedTarget.did, options: { protocols: 'all' as const } };
          }
        },
      }),
      get : sinon.stub().resolves(undefined),
      set : sinon.stub().resolves(),
    } satisfies SyncIdentityStore;
    const sourceStore = {
      delete  : sinon.stub().resolves(),
      get     : sinon.stub().resolves(undefined),
      list    : sinon.stub().resolves([]),
      replace : sinon.stub().resolves(),
    } satisfies FollowedSyncSourceStore;
    const resolver = {
      buildTargetForSource    : sinon.stub(),
      buildTargetResolutions  : sinon.stub().resolves([]),
      buildTargetsForEndpoint : sinon.stub().resolves([removedTarget]),
      getEndpointUrls         : sinon.stub().callsFake(async (): Promise<string[]> => {
        markDiscoveryStarted();
        await discoveryPending;
        return [removedTarget.dwnUrl];
      }),
      withCurrentRoleGrant: sinon.stub().callsFake(async (syncTarget: SyncTarget): Promise<SyncTarget> => syncTarget),
    };
    const planner = new SyncTargetPlanner({
      getTargetResolver          : (): typeof resolver => resolver,
      handleAuthorizationFailure : sinon.stub().resolves(false),
      identityStore,
      isIdentityPaused           : sinon.stub().returns(false),
      sourceStore,
    });
    const run = sinon.stub().resolves(runResult({ syncTargets: [removedTarget] }));
    const running = new SyncEngineNext(planner, progressStore, { run }).run('pull');
    await discoveryStarted;

    registered = false;
    planner.invalidate();
    releaseDiscovery();
    const result = await running;

    expect(run.called).toBe(false);
    expect(await progressStore.getAllLinks()).toEqual([]);
    expect(result).toMatchObject({ targetCount: 0, targetsCurrent: false, workRemaining: true });
  });

  it('rotates past a no-progress target prefix across bounded calls and turns', async () => {
    const targets = Array.from({ length: 33 }, (_value, index) => roleTarget({ projectionId: `context-${index}` }));
    for (const syncTarget of targets.slice(0, 32)) {
      const link = await progressStore.getOrCreateLink({
        ...syncNextLinkIdentity(syncTarget),
        authorization : syncTarget.authorization,
        scope         : syncTarget.scope,
      });
      expect(await progressStore.commitPullPage(link, {
        checkpoint   : token(1),
        pageReceipts : [],
        quarantine   : [],
        settled      : [],
      })).toBe(true);
    }
    const queried: string[] = [];
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, {
      pullPage: async (syncTarget, _shouldContinue, runRemoteRequest): Promise<SyncNextPullPageResult> => {
        await runRemoteRequest(async () => { queried.push(syncTarget.projectionId); });
        return {
          checkpoint  : token(1),
          feedDrained : true,
          handledCids : [],
          kind        : 'committed',
          quarantined : 0,
        };
      },
    });

    const engine = new SyncEngineNext(new TestTargetPlanner(targets), progressStore, runner);
    const first = await engine.run('pull', { maxRemoteRequests: 32 });

    expect(queried).toHaveLength(32);
    expect(first).toMatchObject({ requestBudgetExhausted: true, workRemaining: true });

    const result = await engine.run('pull', { maxRemoteRequests: 512 });

    expect(new Set(queried).size).toBe(33);
    expect(queried[32]).toBe('context-32');
    expect(result).toMatchObject({
      pull           : { feedCovered: true, workRemaining: false },
      remoteRequests : 33,
      turns          : 2,
      workRemaining  : false,
    });
  });

  it('reports unrequested pending work without making that direction incomplete', async () => {
    const syncTarget = target();
    const link = await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    const source = { ...token(1), messageCid: 'pending-delivery' };
    expect(await progressStore.commitPushPage(link, {
      checkpoint : source,
      delivery   : [{
        messageCid         : source.messageCid,
        outcome            : { reason: 'transport' },
        source,
        wasLatestBaseState : false,
      }],
      handledWrites : [],
      pageReceipts  : [{ messageCid: source.messageCid, source }],
      settled       : [],
    })).toBe(true);
    const planner = new TestTargetPlanner([syncTarget]);
    const runner = { run: sinon.stub().resolves(runResult()) };
    const engine = new SyncEngineNext(planner, progressStore, runner);

    const pull = await engine.run('pull');
    const push = await engine.run('push');

    expect(pull).toMatchObject({ deliveryPending: true, workRemaining: false });
    expect(push).toMatchObject({ deliveryPending: true, workRemaining: true });
  });

  it('preserves an existing link and its checkpoints after restart', async () => {
    const syncTarget = target();
    const link = await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    expect(await progressStore.commitPullPage(link, {
      checkpoint   : token(4),
      pageReceipts : [],
      quarantine   : [],
      settled      : [],
    })).toBe(true);
    const planner = new TestTargetPlanner([syncTarget]);
    const runner = { run: sinon.stub().resolves(runResult()) };

    await new SyncEngineNext(planner, progressStore, runner).run('pull');
    await db.close();
    db = new Level<string, string>(progressStorePath);
    progressStore = new SyncNextProgressStore(db, 'sync-next-engine-spec');
    await new SyncEngineNext(planner, progressStore, runner).run('pull');

    expect(await progressStore.getLink(syncNextLinkIdentity(syncTarget))).toMatchObject({
      lifetimeId     : link.lifetimeId,
      pullCheckpoint : token(4),
    });
  });

  it('refreshes transient target authority before execution', async () => {
    const syncTarget = roleTarget();
    const refreshed = {
      ...syncTarget,
      authorDelegatedGrant: {} as NonNullable<SyncTarget['authorDelegatedGrant']>,
    };
    const planner = new TestTargetPlanner([syncTarget]);
    sinon.stub(planner, 'withCurrentRoleGrant').resolves(refreshed);
    const run = sinon.stub().resolves(runResult({ syncTargets: [syncTarget] }));

    await new SyncEngineNext(planner, progressStore, { run }).run('pull');

    expect(run.firstCall.args[0]).toEqual([refreshed]);
  });

  it('copies only transient grant material from refreshed authority', async () => {
    const syncTarget = roleTarget();
    const planner = new TestTargetPlanner([syncTarget]);
    sinon.stub(planner, 'withCurrentRoleGrant').resolves({
      ...syncTarget,
      authorizationEpoch   : 'different-epoch',
      authorDelegatedGrant : {} as NonNullable<SyncTarget['authorDelegatedGrant']>,
    });
    const run = sinon.stub().resolves(runResult({ syncTargets: [syncTarget] }));

    await new SyncEngineNext(planner, progressStore, { run }).run('pull');

    expect(run.firstCall.args[0][0]).toMatchObject({
      authorizationEpoch   : syncTarget.authorizationEpoch,
      authorDelegatedGrant : {},
    });
  });

  it('rejects when cancellation lands during authority refresh', async () => {
    const syncTarget = roleTarget();
    const planner = new TestTargetPlanner([syncTarget]);
    const controller = new AbortController();
    sinon.stub(planner, 'withCurrentRoleGrant').callsFake(async (): Promise<SyncTarget> => {
      controller.abort();
      return syncTarget;
    });
    const run = sinon.stub().resolves(runResult({ syncTargets: [syncTarget] }));

    await expect(new SyncEngineNext(planner, progressStore, { run }).run('pull', { signal: controller.signal }))
      .rejects.toThrow('Sync work stopped before the active root could be classified');
    expect(await progressStore.getLink(syncNextLinkIdentity(syncTarget))).toBeDefined();
    expect(run.called).toBe(false);
  });

  it('stops creating links after cancellation', async () => {
    const first = target({ endpoint: 'https://first.example.com', projectionId: 'first' });
    const second = target({ endpoint: 'https://second.example.com', projectionId: 'second' });
    const controller = new AbortController();
    const getOrCreateLink = progressStore.getOrCreateLink.bind(progressStore);
    const create = sinon.stub(progressStore, 'getOrCreateLink').callsFake(async definition => {
      const link = await getOrCreateLink(definition);
      controller.abort();
      return link;
    });
    const run = sinon.stub().resolves(runResult({ syncTargets: [first, second] }));

    await expect(new SyncEngineNext(new TestTargetPlanner([first, second]), progressStore, { run })
      .run('pull', { signal: controller.signal }))
      .rejects.toThrow('Sync work stopped before the active root could be classified');

    expect(create.calledOnce).toBe(true);
    expect(await progressStore.getLink(syncNextLinkIdentity(first))).toBeDefined();
    expect(await progressStore.getLink(syncNextLinkIdentity(second))).toBeUndefined();
    expect(run.called).toBe(false);
  });

  it('isolates an unavailable role grant while healthy targets continue', async () => {
    const healthy = target();
    const unavailable = roleTarget();
    const planner = new TestTargetPlanner([healthy, unavailable]);
    sinon.stub(planner, 'withCurrentRoleGrant').rejects(new Error('role grant unavailable'));
    const run = sinon.stub().resolves(runResult({ syncTargets: [healthy] }));

    const result = await new SyncEngineNext(planner, progressStore, { run }).run('pull');

    expect(run.firstCall.args[0]).toEqual([healthy]);
    expect(await progressStore.getLink(syncNextLinkIdentity(unavailable))).toBeDefined();
    expect(result.failures).toEqual([{
      message : 'role grant unavailable',
      target  : syncNextLinkIdentity(unavailable),
      work    : 'authorityRefresh',
    }]);
    expect(result).toMatchObject({
      pull           : { feedCovered: false, workRemaining: true },
      targetsCurrent : true,
      workRemaining  : true,
    });
  });

  it('coalesces equivalent role-grant refreshes within one run', async () => {
    const first = roleTarget({ endpoint: 'https://first.example.com', projectionId: 'first' });
    const second = roleTarget({ endpoint: 'https://second.example.com', projectionId: 'second' });
    const planner = new TestTargetPlanner([first, second]);
    const withCurrentRoleGrant = sinon.spy(planner, 'withCurrentRoleGrant');
    const run = sinon.stub().resolves(runResult({ syncTargets: [first, second] }));

    await new SyncEngineNext(planner, progressStore, { run }).run('pull');

    expect(withCurrentRoleGrant.calledOnce).toBe(true);
    expect(run.firstCall.args[0]).toHaveLength(2);
  });

  it('does not refresh role grants for push-only work', async () => {
    const planner = new TestTargetPlanner([roleTarget()]);
    const withCurrentRoleGrant = sinon.spy(planner, 'withCurrentRoleGrant');
    const run = sinon.stub().resolves(runResult());

    const result = await new SyncEngineNext(planner, progressStore, { run }).run('push');

    expect(withCurrentRoleGrant.called).toBe(false);
    expect(run.called).toBe(false);
    expect(result.push).toMatchObject({ feedCovered: true, workRemaining: false });
  });

  it('stops retiring links when the target plan changes', async () => {
    const current = target({ epoch: 'current' });
    for (const stale of [target({ epoch: 'stale-a' }), target({ epoch: 'stale-b' })]) {
      await progressStore.getOrCreateLink({
        ...syncNextLinkIdentity(stale),
        authorization : stale.authorization,
        scope         : stale.scope,
      });
    }
    const planner = new TestTargetPlanner([current]);
    const originalRetire = progressStore.retireLink.bind(progressStore);
    const retire = sinon.stub(progressStore, 'retireLink').callsFake(async link => {
      await originalRetire(link);
      planner.topologyGeneration++;
      planner.lastResolutionComplete = false;
    });
    const run = sinon.stub().resolves(runResult({ syncTargets: [current] }));

    const result = await new SyncEngineNext(planner, progressStore, { run }).run('pull');

    expect(retire.calledOnce).toBe(true);
    expect(await progressStore.getAllLinks()).toHaveLength(2);
    expect(run.called).toBe(false);
    expect(result.targetsCurrent).toBe(false);
  });

  it('alternates directions until both feeds remain covered', async () => {
    const planner = new TestTargetPlanner([target()]);
    const directions: string[] = [];
    const runner = {
      run: sinon.stub().callsFake(async (_targets, direction): Promise<SyncNextRunResult> => {
        directions.push(direction);
        return directions.length < 3
          ? runResult({ madeProgress: true })
          : runResult();
      }),
    };

    const result = await new SyncEngineNext(planner, progressStore, runner).run();

    expect(directions).toEqual(['pull', 'push', 'pull']);
    expect(result).toMatchObject({
      requestBudgetExhausted : false,
      pull                   : { feedCovered: true, requested: true, workRemaining: false },
      push                   : { feedCovered: true, requested: true, workRemaining: false },
      workRemaining          : false,
    });
  });

  it('stops a direction after no progress while allowing the other direction to run', async () => {
    const planner = new TestTargetPlanner([target()]);
    const directions: string[] = [];
    const runner = {
      run: sinon.stub().callsFake(async (_targets, direction): Promise<SyncNextRunResult> => {
        directions.push(direction);
        return direction === 'pull'
          ? runResult({ workRemaining: true })
          : runResult();
      }),
    };

    const result = await new SyncEngineNext(planner, progressStore, runner).run();

    expect(directions).toEqual(['pull', 'push']);
    expect(result.requestBudgetExhausted).toBe(false);
    expect(result.pull).toMatchObject({ feedCovered: true, workRemaining: true });
    expect(result.push).toMatchObject({ feedCovered: true, workRemaining: false });
    expect(result.workRemaining).toBe(true);
  });

  it('parks a failed target while another target continues', async () => {
    const failing = target({ endpoint: 'https://failing.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    const calls: string[][] = [];
    const runner = {
      run: sinon.stub().callsFake(async (targets): Promise<SyncNextRunResult> => {
        calls.push(targets.map(candidate => candidate.dwnUrl));
        return calls.length === 1
          ? runResult({
            failures: [{
              message : 'local progress-store failure',
              target  : syncNextLinkIdentity(failing),
              work    : 'pullPage',
            }],
            feedCovered   : false,
            madeProgress  : true,
            syncTargets   : targets,
            workRemaining : true,
          })
          : runResult({ syncTargets: targets });
      }),
    };

    const result = await new SyncEngineNext(
      new TestTargetPlanner([failing, healthy]), progressStore, runner,
    ).run('pull');

    expect(calls).toEqual([[failing.dwnUrl, healthy.dwnUrl], [healthy.dwnUrl]]);
    expect(result.failures).toHaveLength(1);
    expect(result.pull).toMatchObject({ feedCovered: false, workRemaining: true });
  });

  it('stops retrying a blocked endpoint while another endpoint finishes', async () => {
    const offline = target({ endpoint: 'https://offline.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    const calls: string[][] = [];
    const runner = {
      run: sinon.stub().callsFake(async (targets): Promise<SyncNextRunResult> => {
        calls.push(targets.map(candidate => candidate.dwnUrl));
        return calls.length === 1
          ? runResult({
            blockedEndpoints : [offline.dwnUrl],
            feedCovered      : false,
            madeProgress     : true,
            remoteRequests   : 2,
            syncTargets      : targets,
            workRemaining    : true,
          })
          : runResult({ syncTargets: targets });
      }),
    };

    const result = await new SyncEngineNext(
      new TestTargetPlanner([offline, healthy]), progressStore, runner,
    ).run('pull');

    expect(calls).toEqual([[offline.dwnUrl, healthy.dwnUrl], [healthy.dwnUrl]]);
    expect(result.blockedEndpoints).toEqual([offline.dwnUrl]);
    expect(result.pull).toMatchObject({ feedCovered: false, workRemaining: true });
  });

  it('does not re-enter an endpoint blocked after partial progress', async () => {
    const blocked = target({ endpoint: 'https://blocked.example.com' });
    const run = sinon.stub().resolves(runResult({
      blockedEndpoints : [blocked.dwnUrl],
      feedCovered      : false,
      madeProgress     : true,
      syncTargets      : [blocked],
      workRemaining    : true,
    }));

    const result = await new SyncEngineNext(
      new TestTargetPlanner([blocked]), progressStore, { run },
    ).run('pull');

    expect(run.calledOnce).toBe(true);
    expect(result).toMatchObject({
      blockedEndpoints : [blocked.dwnUrl],
      pull             : { feedCovered: false, workRemaining: true },
    });
  });

  it('shares one request budget across pull and push', async () => {
    const planner = new TestTargetPlanner([target()]);
    const budgets: number[] = [];
    const runner = {
      run: sinon.stub().callsFake(async (_targets, _direction, options): Promise<SyncNextRunResult> => {
        budgets.push(options.maxRemoteRequests);
        return runResult({ madeProgress: true, remoteRequests: options.maxRemoteRequests, workRemaining: true });
      }),
    };

    const result = await new SyncEngineNext(planner, progressStore, runner)
      .run('both', { maxRemoteRequests: 6 });

    expect(budgets).toEqual([3, 3]);
    expect(result).toMatchObject({ requestBudgetExhausted: true, remoteRequests: 6, workRemaining: true });
  });

  it('rejects a budget that cannot fund every requested direction', async () => {
    const syncTarget = target();
    const engine = new SyncEngineNext(
      new TestTargetPlanner([syncTarget]), progressStore, { run: sinon.stub().resolves(runResult()) },
    );

    expect(() => engine.run('both', { maxRemoteRequests: 5 }))
      .toThrow('request budget must be an integer of at least 6');
    expect(() => engine.run('both', { maxTurns: 1 }))
      .toThrow('turn limit must be an integer of at least 2');
    expect(await progressStore.getLink(syncNextLinkIdentity(syncTarget))).toBeUndefined();
  });

  it('bounds progress that consumes no remote requests', async () => {
    const run = sinon.stub().resolves(runResult({
      madeProgress   : true,
      remoteRequests : 0,
      workRemaining  : true,
    }));
    const engine = new SyncEngineNext(
      new TestTargetPlanner([target()]), progressStore, { run },
    );

    const result = await engine.run('pull', { maxTurns: 2 });

    expect(run.callCount).toBe(2);
    expect(result).toMatchObject({
      requestBudgetExhausted : false,
      remoteRequests         : 0,
      turnLimitReached       : true,
      turns                  : 2,
      workRemaining          : true,
    });
  });

  it('serializes concurrent runs', async () => {
    const planner = new TestTargetPlanner([target()]);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let calls = 0;
    const runner = {
      run: sinon.stub().callsFake(async (): Promise<SyncNextRunResult> => {
        calls++;
        if (calls === 1) {
          markFirstStarted();
          await firstPending;
        }
        return runResult();
      }),
    };
    const engine = new SyncEngineNext(planner, progressStore, runner);

    const first = engine.run('pull');
    await firstStarted;
    const second = engine.run('pull');
    expect(calls).toBe(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });

  it('stops additional turns when the target plan changes', async () => {
    const planner = new TestTargetPlanner([target()]);
    const runner = {
      run: sinon.stub().callsFake(async (): Promise<SyncNextRunResult> => {
        planner.topologyGeneration++;
        planner.lastResolutionComplete = false;
        return runResult({ madeProgress: true, workRemaining: true });
      }),
    };

    const result = await new SyncEngineNext(planner, progressStore, runner).run('pull');

    expect(runner.run.calledOnce).toBe(true);
    expect(result.targetsCurrent).toBe(false);
    expect(result.pull.feedCovered).toBe(false);
    expect(result.workRemaining).toBe(true);
  });

  it('does not report current targets when the plan changes during final status collection', async () => {
    const planner = new TestTargetPlanner([target()]);
    sinon.stub(progressStore, 'hasPendingWork').callsFake(async () => {
      planner.topologyGeneration++;
      planner.lastResolutionComplete = false;
      return { delivery: false, quarantine: false };
    });
    const runner = { run: sinon.stub().resolves(runResult()) };

    const result = await new SyncEngineNext(planner, progressStore, runner).run('pull');

    expect(result).toMatchObject({
      pull           : { feedCovered: false, workRemaining: true },
      targetsCurrent : false,
      workRemaining  : true,
    });
  });

  it('rejects promptly when cancellation interrupts an active turn', async () => {
    const planner = new TestTargetPlanner([target()]);
    const controller = new AbortController();
    let releaseTurn!: () => void;
    let markTurnStarted!: () => void;
    const turnPending = new Promise<void>(resolve => { releaseTurn = resolve; });
    const turnStarted = new Promise<void>(resolve => { markTurnStarted = resolve; });
    const runner = {
      run: sinon.stub().callsFake(async (): Promise<SyncNextRunResult> => {
        markTurnStarted();
        await turnPending;
        return runResult();
      }),
    };
    const engine = new SyncEngineNext(planner, progressStore, runner);
    const running = engine.run('pull', { signal: controller.signal });
    await turnStarted;

    controller.abort();
    await expect(running).rejects.toThrow('Sync work stopped before the active root could be classified');
    expect(runner.run.calledOnce).toBe(true);

    releaseTurn();
    await engine.run('pull');
    expect(runner.run.calledTwice).toBe(true);
  });

  it('does not start a pre-cancelled run', async () => {
    const planner = new TestTargetPlanner([target()]);
    const getTargets = sinon.spy(planner, 'getTargets');
    const runner = { run: sinon.stub().resolves(runResult()) };
    const engine = new SyncEngineNext(planner, progressStore, runner);
    const controller = new AbortController();
    controller.abort();

    await expect(engine.run('pull', { signal: controller.signal }))
      .rejects.toThrow('Sync work stopped before the active root could be classified');
    await engine.run('pull', { signal: new AbortController().signal });

    expect(getTargets.calledOnce).toBe(true);
    expect(runner.run.calledOnce).toBe(true);
  });

  it('rejects a queued cancelled run without executing it later', async () => {
    const planner = new TestTargetPlanner([target()]);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let calls = 0;
    const runner = {
      run: sinon.stub().callsFake(async (): Promise<SyncNextRunResult> => {
        calls++;
        if (calls === 1) {
          markFirstStarted();
          await firstPending;
        }
        return runResult();
      }),
    };
    const engine = new SyncEngineNext(planner, progressStore, runner);
    const first = engine.run('pull');
    await firstStarted;
    const controller = new AbortController();
    const cancelled = engine.run('pull', { signal: controller.signal });

    controller.abort();
    await expect(cancelled).rejects.toThrow('Sync work stopped before the active root could be classified');
    expect(calls).toBe(1);

    const third = engine.run('pull');
    releaseFirst();
    await Promise.all([first, third]);
    expect(calls).toBe(2);
  });
});
