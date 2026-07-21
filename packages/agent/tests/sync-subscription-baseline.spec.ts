import type { SinonStub } from 'sinon';

import type { ProgressToken } from '@enbox/dwn-sdk-js';

import type { SyncFeedSnapshot, SyncLinkController } from '../src/sync-link-controller.js';

import sinon from 'sinon';

import { Level } from 'level';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { ReplicationLinkState } from '../src/types/sync.js';

import { deferred as createDeferred } from './utils/deferred.js';
import { SyncCheckpoint } from '../src/sync-checkpoint.js';
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
  const persistCheckpoints = sinon.stub((engine as any).ledger, 'persistCheckpoints').resolves();
  const reconcile = sinon.stub((engine as any)._durableFeedReconciler, 'reconcile').resolves({ converged: true });
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
  const generation = controller.replicationGeneration;
  expect(controller.setLiveSubscription(
    { close: async (): Promise<void> => {} },
    generation,
    pullSnapshot,
  )).toBe(true);
  expect(controller.setLocalSubscription(
    { close: async (): Promise<void> => {} },
    generation,
    pushSnapshot,
  )).toBe(true);
}

function establishBaseline(fixture: BaselineFixture, generation = fixture.controller.replicationGeneration): Promise<unknown> {
  return (fixture.engine as any).establishLinkBaseline(fixture.target, fixture.controller, generation);
}

describe('SyncEngineLevel — dual-subscription replay baseline', () => {
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
    const pullCallback = sinon.stub().resolves();
    const pushCallback = sinon.stub().resolves();
    const pullDelivery = fixture.controller.enqueueDirection('pull', (): Promise<void> => pullCallback());
    const pushDelivery = fixture.controller.enqueueDirection('push', (): Promise<void> => pushCallback());

    const result = await establishBaseline(fixture);

    expect(result).toEqual({ converged: true });
    expect(fixture.controller.link.pull.contiguousAppliedToken).toEqual(pullHead);
    expect(fixture.controller.link.push.contiguousAppliedToken).toEqual(pushHead);
    expect(fixture.persistCheckpoints.calledOnceWithExactly(fixture.controller.link)).toBe(true);
    expect(fixture.reconcile.notCalled).toBe(true);
    expect(pullCallback.notCalled).toBe(true);
    expect(pushCallback.notCalled).toBe(true);

    fixture.controller.markReplicationReady();
    await Promise.all([pullDelivery, pushDelivery]);
    expect(pullCallback.calledOnce).toBe(true);
    expect(pushCallback.calledOnce).toBe(true);

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
        return { converged: true };
      });
      const pullCallback = sinon.stub().resolves();
      const pushCallback = sinon.stub().resolves();
      const pullDelivery = fixture.controller.enqueueDirection('pull', (): Promise<void> => pullCallback());
      const pushDelivery = fixture.controller.enqueueDirection('push', (): Promise<void> => pushCallback());

      const baseline = establishBaseline(fixture);
      await reconcileStarted.promise;

      expect(pullCallback.notCalled).toBe(true);
      expect(pushCallback.notCalled).toBe(true);
      expect(fixture.persistCheckpoints.notCalled).toBe(true);

      releaseReconcile.resolve();
      expect(await baseline).toEqual({ converged: true });
      expect(fixture.reconcile.calledOnce).toBe(true);
      expect(fixture.reconcile.firstCall.args[0]).toBe(fixture.target);
      expect(fixture.reconcile.firstCall.args[1]).toBe(fixture.controller.link);
      expect(pullCallback.notCalled).toBe(true);
      expect(pushCallback.notCalled).toBe(true);

      fixture.controller.markReplicationReady();
      await Promise.all([pullDelivery, pushDelivery]);
      expect(pullCallback.calledOnce).toBe(true);
      expect(pushCallback.calledOnce).toBe(true);

      await fixture.controller.dispose();
    });
  }

  it('should reuse an existing cursor pair for both subscriptions and skip baseline reconciliation', async () => {
    const fixture = createBaselineFixture(db);
    const pullCursor = tokenIn('remote-stream', 'remote-epoch', '17');
    const pushCursor = tokenIn('local-stream', 'local-epoch', '23');
    fixture.controller.link.pull.contiguousAppliedToken = pullCursor;
    fixture.controller.link.push.contiguousAppliedToken = pushCursor;
    const requests: CapturedSubscribeRequest[] = [];
    const processRequest = sinon.stub().callsFake(async (request: CapturedSubscribeRequest) => {
      requests.push(request);
      if (request.subscriptionHandler !== undefined) {
        return {
          reply: {
            fingerprint  : 'local-feed',
            head         : pushCursor,
            status       : { code: 200, detail: 'OK' },
            subscription : { close: sinon.stub().resolves() },
          },
        };
      }
      return { message: {} };
    });
    const sendDwnRequest = sinon.stub().resolves({
      fingerprint  : 'remote-feed',
      head         : pullCursor,
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
    expect(requests[0].messageParams.cursor).toEqual(pullCursor);
    expect(requests[1].messageParams.cursor).toEqual(pushCursor);
    expect(await establishBaseline(fixture)).toBeUndefined();
    expect(fixture.reconcile.notCalled).toBe(true);
    expect(fixture.persistCheckpoints.notCalled).toBe(true);

    await fixture.controller.dispose();
  });

  it('should reset an expired local push cursor once and reopen from the beginning', async () => {
    const fixture = createBaselineFixture(db);
    const pushCursor = tokenIn('local-stream', 'local-epoch', '23');
    fixture.controller.link.push.contiguousAppliedToken = pushCursor;
    const requestedCursors: Array<ProgressToken | undefined> = [];
    const processRequest = sinon.stub().callsFake(async (request: CapturedSubscribeRequest) => {
      requestedCursors.push(request.messageParams.cursor);
      if (requestedCursors.length === 1) {
        return { reply: { status: { code: 410, detail: 'ProgressGap' } } };
      }
      return {
        reply: {
          fingerprint  : 'local-feed',
          head         : tokenIn('local-stream', 'local-epoch', '31'),
          status       : { code: 200, detail: 'OK' },
          subscription : { close: sinon.stub().resolves() },
        },
      };
    });
    (fixture.engine as any)._agent = { dwn: { processRequest }, rpc: {} };
    const resetCheckpoint = sinon.stub((fixture.engine as any).ledger, 'resetCheckpoint').callsFake(async (
      link: ReplicationLinkState,
      direction: 'pull' | 'push',
    ): Promise<void> => {
      SyncCheckpoint.reset(link[direction]);
    });

    expect(await (fixture.engine as any).openLocalPushSubscription(
      fixture.target,
      fixture.controller,
      fixture.controller.replicationGeneration,
    )).toBe(true);

    expect(requestedCursors).toEqual([pushCursor, undefined]);
    expect(resetCheckpoint.calledOnceWithExactly(fixture.controller.link, 'push')).toBe(true);
    expect(fixture.controller.hasLocalSubscription).toBe(true);

    await fixture.controller.dispose();
  });

  it('should abort a superseded baseline generation without committing checkpoints', async () => {
    const fixture = createBaselineFixture(db);
    const generation = fixture.controller.replicationGeneration;
    attachSubscriptionSnapshots(
      fixture.controller,
      { fingerprint: 'same-feed', head: tokenIn('remote-stream', 'remote-epoch', '7') },
      { fingerprint: 'same-feed', head: tokenIn('local-stream', 'local-epoch', '11') },
    );
    fixture.reconcile.resolves({ aborted: true });

    fixture.controller.resetReplicationGeneration();
    const result = await establishBaseline(fixture, generation);

    expect(result).toEqual({ aborted: true });
    expect(fixture.controller.link.pull.contiguousAppliedToken).toBeUndefined();
    expect(fixture.controller.link.push.contiguousAppliedToken).toBeUndefined();
    expect(fixture.persistCheckpoints.notCalled).toBe(true);

    await fixture.controller.dispose();
  });
});
