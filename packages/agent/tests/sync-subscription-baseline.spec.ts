import type { SinonStub } from 'sinon';

import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncFeedSnapshot, SyncLinkController } from '../src/sync-link-controller.js';

import sinon from 'sinon';

import { Level } from 'level';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState, SyncEvent } from '../src/types/sync.js';

import { deferred as createDeferred } from './utils/deferred.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example.com';
const LINK_KEY = `${DID}^${REMOTE}^projection-id^owner-epoch`;

type BaselineFixture = {
  controller: SyncLinkController;
  engine: SyncEngineLevel;
  persistCheckpoints: SinonStub;
  reconcile: SinonStub;
  target: Record<string, unknown>;
};

type CapturedSubscribeRequest = {
  messageParams: {
    cursor?: ProgressToken;
  };
  subscriptionHandler?: unknown;
};

function tokenIn(streamId: string, epoch: string, position: string): ProgressToken {
  return { epoch, messageCid: `cid-${position}`, position, streamId };
}

function createLink(): ReplicationLinkState {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'online',
    projectionId       : 'projection-id',
    pull               : {},
    push               : {},
    remoteEndpoint     : REMOTE,
    scope              : { kind: 'full' },
    status             : 'initializing',
    tenantDid          : DID,
  };
}

function createBaselineFixture(db: Level<string, string>): BaselineFixture {
  const engine = new SyncEngineLevel({ db });
  const controller: SyncLinkController = (engine as any).activateLink(LINK_KEY, createLink());
  const persistCheckpoints = sinon.stub((engine as any).replicationLinkStore, 'persistCheckpoints').resolves();
  const reconcile = sinon.stub((engine as any)._durableFeedReconciler, 'reconcile').resolves({
    converged   : true,
    pullDrained : true,
  });
  const target = {
    authorization      : { kind: 'owner' as const },
    authorizationEpoch : 'owner-epoch',
    did                : DID,
    dwnUrl             : REMOTE,
    linkKey            : LINK_KEY,
    projectionId       : 'projection-id',
    scope              : { kind: 'full' as const },
  };
  return { controller, engine, persistCheckpoints, reconcile, target };
}

function attachSubscriptionSnapshots(
  controller: SyncLinkController,
  pullSnapshot?: SyncFeedSnapshot,
  pushSnapshot?: SyncFeedSnapshot,
): void {
  const replicationGeneration = controller.replicationGeneration;
  expect(controller.setLiveSubscription(
    { close: async (): Promise<void> => {} },
    replicationGeneration,
    pullSnapshot,
  )).toBe(true);
  expect(controller.setLocalSubscription(
    { close: async (): Promise<void> => {} },
    replicationGeneration,
    pushSnapshot,
  )).toBe(true);
}

function establishBaseline(
  fixture: BaselineFixture,
  replicationGeneration = fixture.controller.replicationGeneration,
): Promise<unknown> {
  return (fixture.engine as any).establishLinkBaseline(
    fixture.target,
    fixture.controller,
    replicationGeneration,
  );
}

describe('SyncEngineLevel — dual-subscription wake baseline', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-subscription-baseline-spec');
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should atomically adopt both heads when fresh subscription fingerprints match', async () => {
    const fixture = createBaselineFixture(db);
    const pullHead = tokenIn('remote-stream', 'remote-epoch', '7');
    const pushHead = tokenIn('local-stream', 'local-epoch', '11');
    attachSubscriptionSnapshots(
      fixture.controller,
      { fingerprint: 'same-feed', head: pullHead },
      { fingerprint: 'same-feed', head: pushHead },
    );
    const work: string[] = [];
    const events: SyncEvent[] = [];
    const unsubscribe = fixture.engine.on((event): void => { events.push(event); });
    fixture.controller.executor.request('pull');
    fixture.controller.executor.request('push');

    const result = await establishBaseline(fixture);

    expect(result).toEqual({ converged: true });
    expect(fixture.controller.link.pull.contiguousAppliedToken).toEqual(pullHead);
    expect(fixture.controller.link.push.contiguousAppliedToken).toEqual(pushHead);
    expect(fixture.persistCheckpoints.calledOnceWithExactly(fixture.controller.link)).toBe(true);
    expect(fixture.reconcile.notCalled).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ type: 'checkpoint:pull-advance', position: '7' }),
      expect.objectContaining({ type: 'checkpoint:push-advance', position: '11' }),
    ]);
    expect(fixture.controller.isPullCurrent).toBe(false);
    expect(fixture.controller.executor.hasPending('pull')).toBe(true);
    expect(fixture.controller.executor.hasPending('push')).toBe(true);

    fixture.controller.markReplicationReady();
    await fixture.controller.executor.drain(async (kind): Promise<void> => { work.push(kind); });
    expect(work).toEqual(['pull', 'push']);

    unsubscribe();
    await fixture.controller.dispose();
  });

  const reconciliationCases: Array<{
    name: string;
    pullSnapshot?: SyncFeedSnapshot;
    pushSnapshot?: SyncFeedSnapshot;
  }> = [
    {
      name         : 'differing fingerprints',
      pullSnapshot : { fingerprint: 'remote-feed', head: tokenIn('remote-stream', 'epoch', '7') },
      pushSnapshot : { fingerprint: 'local-feed', head: tokenIn('local-stream', 'epoch', '9') },
    },
    {
      name         : 'missing snapshot fields',
      pullSnapshot : {},
      pushSnapshot : { fingerprint: 'feed', head: tokenIn('local-stream', 'epoch', '9') },
    },
    {
      name         : 'an invalid snapshot head',
      pullSnapshot : { fingerprint: 'feed', head: tokenIn('', '', '') },
      pushSnapshot : { fingerprint: 'feed', head: tokenIn('local-stream', 'epoch', '9') },
    },
  ];

  for (const reconciliationCase of reconciliationCases) {
    it(`should reconcile once for ${reconciliationCase.name} while callbacks wait for readiness`, async () => {
      const fixture = createBaselineFixture(db);
      attachSubscriptionSnapshots(
        fixture.controller,
        reconciliationCase.pullSnapshot,
        reconciliationCase.pushSnapshot,
      );
      const reconcileStarted = createDeferred();
      const releaseReconcile = createDeferred();
      fixture.reconcile.callsFake(async (): Promise<Record<string, unknown>> => {
        reconcileStarted.resolve();
        await releaseReconcile.promise;
        return { converged: true, pullDrained: true };
      });
      const work: string[] = [];
      fixture.controller.executor.request('pull');
      fixture.controller.executor.request('push');

      const baseline = establishBaseline(fixture);
      await reconcileStarted.promise;

      expect(fixture.controller.executor.hasPending('pull')).toBe(true);
      expect(fixture.controller.executor.hasPending('push')).toBe(true);
      expect(fixture.persistCheckpoints.notCalled).toBe(true);

      releaseReconcile.resolve();
      expect(await baseline).toEqual({ converged: true, pullDrained: true });
      expect(fixture.reconcile.calledOnce).toBe(true);
      expect(fixture.reconcile.firstCall.args[0]).toBe(fixture.target);
      expect(fixture.reconcile.firstCall.args[1]).toBe(fixture.controller.link);
      expect(fixture.controller.executor.hasPending('pull')).toBe(true);
      expect(fixture.controller.executor.hasPending('push')).toBe(true);

      fixture.controller.markReplicationReady();
      await fixture.controller.executor.drain(async (kind): Promise<void> => { work.push(kind); });
      expect(work).toEqual(['pull', 'push']);

      await fixture.controller.dispose();
    });
  }

  it('should restore pull currentness after a successful baseline with no pending pull wake', async () => {
    const fixture = createBaselineFixture(db);
    attachSubscriptionSnapshots(
      fixture.controller,
      { fingerprint: 'remote-feed', head: tokenIn('remote-stream', 'epoch', '7') },
      { fingerprint: 'local-feed', head: tokenIn('local-stream', 'epoch', '9') },
    );
    const transitions: boolean[] = [];
    const unsubscribe = fixture.engine.on((event): void => {
      if (event.type === 'pull:currentness-change') {
        transitions.push(event.to);
      }
    });

    expect(fixture.controller.executor.hasPending('pull')).toBe(false);
    expect(fixture.controller.isPullCurrent).toBe(false);

    expect(await establishBaseline(fixture)).toEqual({ converged: true, pullDrained: true });

    expect(fixture.reconcile.calledOnce).toBe(true);
    expect(fixture.controller.executor.hasPending('pull')).toBe(false);
    expect(fixture.controller.isPullCurrent).toBe(true);
    expect(transitions).toEqual([true]);

    unsubscribe();
    await fixture.controller.dispose();
  });

  it('should open wake subscriptions at the live head and advance an existing checkpoint pair from matching snapshots', async () => {
    const fixture = createBaselineFixture(db);
    const pullCursor = tokenIn('remote-stream', 'remote-epoch', '17');
    const pushCursor = tokenIn('local-stream', 'local-epoch', '23');
    const pullHead = tokenIn('remote-stream', 'remote-epoch', '31');
    const pushHead = tokenIn('local-stream', 'local-epoch', '37');
    fixture.controller.link.pull.contiguousAppliedToken = pullCursor;
    fixture.controller.link.push.contiguousAppliedToken = pushCursor;
    const requests: CapturedSubscribeRequest[] = [];
    const processRequest = sinon.stub().callsFake(async (request: CapturedSubscribeRequest) => {
      requests.push(request);
      if (request.subscriptionHandler !== undefined) {
        return {
          reply: {
            fingerprint  : 'same-feed',
            head         : pushHead,
            status       : { code: 200, detail: 'OK' },
            subscription : { close: sinon.stub().resolves() },
          },
        };
      }
      return { message: {} };
    });
    const sendDwnRequest = sinon.stub().resolves({
      fingerprint  : 'same-feed',
      head         : pullHead,
      status       : { code: 200, detail: 'OK' },
      subscription : { close: sinon.stub().resolves() },
    });
    (fixture.engine as any)._agent = { dwn: { processRequest }, rpc: { sendDwnRequest } };

    expect(await (fixture.engine as any).openLivePullSubscription(
      fixture.target,
      fixture.controller,
      fixture.controller.replicationGeneration,
    )).toBe(true);
    expect(await (fixture.engine as any).openLocalPushSubscription(
      fixture.target,
      fixture.controller,
      fixture.controller.replicationGeneration,
    )).toBe(true);

    expect(requests).toHaveLength(2);
    expect(requests[0].messageParams.cursor).toBeUndefined();
    expect(requests[1].messageParams.cursor).toBeUndefined();
    expect(await establishBaseline(fixture)).toEqual({ converged: true });
    expect(fixture.reconcile.notCalled).toBe(true);
    expect(fixture.persistCheckpoints.calledOnceWithExactly(fixture.controller.link)).toBe(true);
    expect(fixture.controller.link.pull.contiguousAppliedToken).toEqual(pullHead);
    expect(fixture.controller.link.push.contiguousAppliedToken).toEqual(pushHead);
    expect(fixture.controller.isPullCurrent).toBe(true);

    await fixture.controller.dispose();
  });

  it('should reconcile before releasing wakes when only one durable cursor exists', async () => {
    const fixture = createBaselineFixture(db);
    fixture.controller.link.pull.contiguousAppliedToken = tokenIn('remote-stream', 'remote-epoch', '17');
    attachSubscriptionSnapshots(
      fixture.controller,
      { fingerprint: 'remote-feed', head: tokenIn('remote-stream', 'remote-epoch', '19') },
      { fingerprint: 'local-feed', head: tokenIn('local-stream', 'local-epoch', '23') },
    );

    expect(await establishBaseline(fixture)).toEqual({ converged: true, pullDrained: true });
    expect(fixture.reconcile.calledOnce).toBe(true);
    expect(fixture.persistCheckpoints.notCalled).toBe(true);

    await fixture.controller.dispose();
  });

  it('should abort a superseded baseline replication generation without committing checkpoints', async () => {
    const fixture = createBaselineFixture(db);
    const replicationGeneration = fixture.controller.replicationGeneration;
    attachSubscriptionSnapshots(
      fixture.controller,
      { fingerprint: 'same-feed', head: tokenIn('remote-stream', 'remote-epoch', '7') },
      { fingerprint: 'same-feed', head: tokenIn('local-stream', 'local-epoch', '11') },
    );
    fixture.reconcile.resolves({ aborted: true });

    fixture.controller.resetReplicationGeneration();
    const result = await establishBaseline(fixture, replicationGeneration);

    expect(result).toEqual({ aborted: true });
    expect(fixture.controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.controller.link.push.contiguousAppliedToken).toBeUndefined();
    expect(fixture.persistCheckpoints.notCalled).toBe(true);

    await fixture.controller.dispose();
  });
});
