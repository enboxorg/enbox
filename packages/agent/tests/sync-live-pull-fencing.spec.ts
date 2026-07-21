import type { SinonStub } from 'sinon';

import type { ProgressToken } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { Level } from 'level';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { SyncLinkController } from '../src/sync-link-controller.js';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

import { deferred } from './utils/deferred.js';

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example.com';
const LINK_KEY = `${DID}^${REMOTE}^projection-id^owner-epoch`;

type EngineFixture = {
  controller: SyncLinkController;
  engine: SyncEngineLevel;
  handlers: Array<(message: unknown) => Promise<void>>;
  processRequest: SinonStub;
  resume: SinonStub;
  repairing: SinonStub;
  sendDwnRequest: SinonStub;
  target: Record<string, unknown>;
};

function tokenIn(streamId: string, epoch: string, position: string): ProgressToken {
  return { epoch, messageCid: `cid-${position}`, position, streamId };
}

function createEngineFixture(db: Level<string, string>): EngineFixture {
  const engine = new SyncEngineLevel({ db });
  const controller: SyncLinkController = (engine as any).activateLink(LINK_KEY, {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'online',
    projectionId       : 'projection-id',
    pull               : {},
    push               : {},
    remoteEndpoint     : REMOTE,
    scope              : { kind: 'full' },
    status             : 'live',
    tenantDid          : DID,
  });
  const handlers: Array<(message: unknown) => Promise<void>> = [];
  const processRequest = sinon.stub().resolves({ message: {} });
  const sendDwnRequest = sinon.stub().callsFake(async (request: any) => {
    handlers.push(request.subscription.handler);
    return { status: { code: 200 }, subscription: { close: sinon.stub().resolves() } };
  });
  (engine as any)._agent = { dwn: { processRequest }, rpc: { sendDwnRequest } };
  const resume = sinon.stub((engine as any)._linkRecoveryCoordinator, 'resume').resolves();
  const repairing = sinon.stub((engine as any)._linkRecoveryCoordinator, 'transitionToRepairing').resolves();
  const target = {
    authorization      : { kind: 'owner' as const },
    authorizationEpoch : 'owner-epoch',
    did                : DID,
    dwnUrl             : REMOTE,
    linkKey            : LINK_KEY,
    projectionId       : 'projection-id',
    scope              : { kind: 'full' as const },
  };
  return { controller, engine, handlers, processRequest, repairing, resume, sendDwnRequest, target };
}

function openSubscription(fixture: EngineFixture): Promise<boolean> {
  return (fixture.engine as any).openLivePullSubscription(fixture.target, fixture.controller);
}

describe('SyncEngineLevel — replication generation fencing', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-live-pull-fencing-spec');
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should fence subscription callbacks issued before a replication-generation reset', async () => {
    const fixture = createEngineFixture(db);
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);
    const staleHandler = fixture.handlers[0];

    // A repair resets the replication generation and reopens the subscription.
    controller.resetReplicationGeneration();
    await controller.closeLiveSubscription();
    expect(await openSubscription(fixture)).toBe(true);
    controller.markReplicationReady();
    const freshHandler = fixture.handlers[1];

    await staleHandler({ type: 'event' });
    expect(fixture.repairing.notCalled).toBe(true);
    expect(fixture.resume.notCalled).toBe(true);

    // The replacement subscription's callbacks flow normally.
    await freshHandler({ type: 'event' });
    expect(fixture.resume.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.link.pull.contiguousAppliedToken).toBeUndefined();

    await controller.dispose();
  });

  it('should not install a subscription whose replication generation reset while the request was in flight', async () => {
    const fixture = createEngineFixture(db);
    const requestStarted = deferred();
    const releaseRequest = deferred();
    const close = sinon.stub().resolves();
    fixture.sendDwnRequest.callsFake(async (request: any) => {
      fixture.handlers.push(request.subscription.handler);
      requestStarted.resolve();
      await releaseRequest.promise;
      return { status: { code: 200 }, subscription: { close } };
    });

    const opening = openSubscription(fixture);
    await requestStarted.promise;
    // A repair or pause resets the replication generation while the subscribe RPC is
    // pending: the eventual subscription belongs to a superseded replication generation
    // and must be closed, not installed as a permanently fenced slot that
    // blocks the replacement.
    fixture.controller.resetReplicationGeneration();
    releaseRequest.resolve();

    expect(await opening).toBe(false);
    expect(close.calledOnce).toBe(true);
    expect(fixture.controller.hasLiveSubscription).toBe(false);

    await fixture.controller.dispose();
  });

  it('should leave a link paused when the pause lands while the local subscription is opening', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const subscribeStarted = deferred();
    const releaseSubscribe = deferred();
    const close = sinon.stub().resolves();
    fixture.processRequest.callsFake(async () => {
      subscribeStarted.resolve();
      await releaseSubscribe.promise;
      return { reply: { status: { code: 200 }, subscription: { close } } };
    });

    const opening = (engine as any).openLocalPushSubscription(fixture.target, controller);
    await subscribeStarted.promise;
    // A terminal authorization failure pauses the link while the local
    // subscribe is pending — the fail-safe must win over the installer.
    await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
    releaseSubscribe.resolve();

    expect(await opening).toBe(false);
    expect(close.calledOnce).toBe(true);
    expect(controller.hasLocalSubscription).toBe(false);
    expect(controller.link.status).toBe('paused');

    // Completing initialization afterwards must not override the pause.
    await (engine as any).markLinkLive(fixture.target, controller, controller.replicationGeneration);
    expect(controller.link.status).toBe('paused');

    await controller.dispose();
  });

  it('should not release replacement reconciliation when a pause lands during live-status persistence', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const livePersistenceStarted = deferred();
    const releaseLivePersistence = deferred();
    sinon.stub((engine as any).replicationLinkStore, 'setStatus').callsFake(async (link: any, status: string): Promise<void> => {
      link.status = status;
      if (status === 'live') {
        livePersistenceStarted.resolve();
        await releaseLivePersistence.promise;
      }
    });

    const openingGeneration = controller.replicationGeneration;
    const markingLive = (engine as any).markLinkLive(fixture.target, controller, openingGeneration);
    await livePersistenceStarted.promise;

    await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
    controller.executor.request('pull');
    releaseLivePersistence.resolve();
    await markingLive;

    expect(controller.link.status).toBe('paused');
    expect(controller.executor.hasPending('pull')).toBe(true);

    await controller.dispose();
    expect(controller.executor.hasPending('pull')).toBe(false);
  });

  it('should swallow a superseded attempt failure but propagate a current-replication-generation failure', async () => {
    const fixture = createEngineFixture(db);
    const requestStarted = deferred();
    const releaseRequest = deferred();
    fixture.sendDwnRequest.callsFake(async () => {
      requestStarted.resolve();
      await releaseRequest.promise;
      throw new Error('transport failed');
    });

    const opening = openSubscription(fixture);
    await requestStarted.promise;
    fixture.controller.resetReplicationGeneration();
    releaseRequest.resolve();
    // The superseded attempt's rejection retires that attempt; it is not this
    // link's failure.
    expect(await opening).toBe(false);

    // The same failure in the current replication generation still surfaces.
    fixture.sendDwnRequest.rejects(new Error('transport failed'));
    await expect(openSubscription(fixture)).rejects.toThrow('transport failed');

    await fixture.controller.dispose();
  });

  it('should not let a superseded attempt close the replacement subscription pair', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    const replacementClose = sinon.stub().resolves();
    sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (): Promise<boolean> => {
      // A repair supersedes the attempt and its replacement replication generation
      // attaches a fresh pair before the old attempt resumes.
      controller.resetReplicationGeneration();
      controller.setLiveSubscription({ close: replacementClose });
      controller.setLocalSubscription({ close: replacementClose });
      return false;
    });

    const result = await (engine as any).openLinkSubscriptions(fixture.target, controller, controller.replicationGeneration);

    expect(result).toBe('inactive');
    expect(replacementClose.notCalled).toBe(true);
    expect(controller.hasLiveSubscription).toBe(true);
    expect(controller.hasLocalSubscription).toBe(true);

    await controller.dispose();
  });

  it('should stop the pair when a pause lands between the pull and local halves', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const openReplicationGeneration = controller.replicationGeneration;
    sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (): Promise<boolean> => {
      // A terminal callback queued at attachment pauses the link before the
      // caller resumes — the pause bumps the replication generation and closes the pair.
      await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
      return true;
    });
    const localOpen = sinon.spy(engine as any, 'openLocalPushSubscription');

    const result = await (engine as any).openLinkSubscriptions(fixture.target, controller, openReplicationGeneration);

    expect(result).toBe('inactive');
    expect(localOpen.notCalled).toBe(true);
    expect(controller.hasLocalSubscription).toBe(false);
    expect(controller.link.status).toBe('paused');

    await controller.dispose();
  });

  it('should fence local subscription callbacks issued before a replication-generation reset', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    const localHandlers: Array<(message: unknown) => Promise<void>> = [];
    const close = sinon.stub().resolves();
    fixture.processRequest.callsFake(async (request: any) => {
      localHandlers.push(request.subscriptionHandler);
      return { reply: { status: { code: 200 }, subscription: { close } } };
    });

    expect(await (engine as any).openLocalPushSubscription(fixture.target, controller)).toBe(true);
    // A repair resets the replication generation and reopens the local subscription.
    controller.resetReplicationGeneration();
    await controller.closeLocalSubscription();
    expect(await (engine as any).openLocalPushSubscription(fixture.target, controller)).toBe(true);
    controller.markReplicationReady();

    const message = { type: 'event' };
    await localHandlers[0](message);
    await localHandlers[1](message);

    // The superseded callback cannot wake durable reconciliation. The replacement
    // replication generation contributes one coalesced push request.
    expect(fixture.resume.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.executor.hasPending('push')).toBe(true);

    await controller.dispose();
  });

  it('should refuse a local install that resolves while pause awaits a subscription close', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    const releaseLiveClose = deferred();
    controller.setLiveSubscription({ close: sinon.stub().callsFake(() => releaseLiveClose.promise) });
    const subscribeStarted = deferred();
    const releaseSubscribe = deferred();
    const localClose = sinon.stub().resolves();
    fixture.processRequest.callsFake(async () => {
      subscribeStarted.resolve();
      await releaseSubscribe.promise;
      return { reply: { status: { code: 200 }, subscription: { close: localClose } } };
    });

    const opening = (engine as any).openLocalPushSubscription(fixture.target, controller);
    await subscribeStarted.promise;
    const pausing = (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
    // The pause is blocked awaiting the pull subscription's close when the
    // pending local subscribe resolves: the attach must be refused by the
    // pause's already-published replication generation, not slip into the slot
    // the close operation has already inspected.
    releaseSubscribe.resolve();
    expect(await opening).toBe(false);
    expect(localClose.calledOnce).toBe(true);

    releaseLiveClose.resolve();
    await pausing;
    expect(controller.hasLocalSubscription).toBe(false);
    expect(controller.link.status).toBe('paused');

    await controller.dispose();
  });

  it('should keep a link paused during opening in the identity keep-set instead of failing it', async () => {
    const fixture = createEngineFixture(db);
    const { controller, engine } = fixture;
    controller.link.status = 'initializing';
    sinon.stub(engine as any, 'getOrCreateReplicationLink').resolves(controller.link);
    sinon.stub(engine as any, 'activateLink').returns(controller);
    // This test emulates the ORIGINAL initializing call, whose own
    // activateLink registers the controller; the fixture's pre-registration
    // would instead trip the owned-link idempotence guard and skip opening.
    (engine as any)._linkControllers.delete(LINK_KEY);
    sinon.stub(engine as any, 'openLinkSubscriptions').callsFake(async (): Promise<string> => {
      // A terminal callback pauses the link while the pair is opening.
      await (engine as any)._linkRecoveryCoordinator.transitionToPaused(LINK_KEY, controller.link);
      return 'inactive';
    });

    const result = await (engine as any).initializeLinkTarget({
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      did                : DID,
      dwnUrl             : REMOTE,
      scope              : { kind: 'full' },
    });

    // Failing the initialization would drop the paused link from the
    // identity's keep-set, and the superseded-link prune would then delete
    // the fail-safe pause's durable record.
    expect(result.status).toBe('active');
    expect(controller.link.status).toBe('paused');

    await controller.dispose();
  });

  it('should establish and re-establish the wake subscription without a replay cursor', async () => {
    const fixture = createEngineFixture(db);
    fixture.controller.link.pull.contiguousAppliedToken = tokenIn('durable-stream', 'durable-epoch', '9');

    expect(await openSubscription(fixture)).toBe(true);

    expect(fixture.processRequest.firstCall.args[0].messageParams.cursor).toBeUndefined();
    const factory = fixture.sendDwnRequest.firstCall.args[0].subscription.resubscribeFactory;
    await factory(tokenIn('transport-stream', 'transport-epoch', '99'));
    expect(fixture.processRequest.secondCall.args[0].messageParams.cursor).toBeUndefined();
    expect(fixture.controller.link.pull.contiguousAppliedToken).toEqual(
      tokenIn('durable-stream', 'durable-epoch', '9'),
    );

    await fixture.controller.dispose();
  });
});

describe('SyncEngineLevel — transport lifecycle connectivity', () => {
  let db: Level<string, string>;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-transport-attachment-spec');
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should report the link offline while the socket is down and online after verified resubscription', async () => {
    const fixture = createEngineFixture(db);
    const { controller } = fixture;
    controller.setLocalSubscription({ close: async (): Promise<void> => {} });

    expect(await openSubscription(fixture)).toBe(true);
    controller.markReplicationReady();
    const handler = fixture.handlers[0];

    // The transport lost its socket: report this exact link offline even
    // though its logical subscription handle remains.
    await handler({ type: 'disconnected' });
    expect(controller.hasLiveSubscription).toBe(true);
    expect(controller.link.connectivity).toBe('offline');

    await handler({ type: 'reconnecting', attempt: 1 });

    // The transport reports reconnected only after verified resubscription.
    await handler({ type: 'reconnected' });
    expect(controller.link.connectivity).toBe('online');
    expect(fixture.resume.calledOnceWithExactly(controller)).toBe(true);
    expect(controller.executor.hasPending('pull')).toBe(true);
    expect(controller.executor.hasPending('push')).toBe(true);

    await controller.dispose();
  });

  it('should ignore transport lifecycle events from a superseded subscription', async () => {
    const fixture = createEngineFixture(db);
    const { controller } = fixture;

    expect(await openSubscription(fixture)).toBe(true);
    const staleHandler = fixture.handlers[0];

    // A repair resets the replication generation and reopens the subscription.
    controller.resetReplicationGeneration();
    await controller.closeLiveSubscription();
    expect(await openSubscription(fixture)).toBe(true);
    expect(controller.link.connectivity).toBe('online');

    // A late disconnect from the superseded subscription must not mark the
    // replacement replication generation offline.
    await staleHandler({ type: 'disconnected' });
    expect(controller.link.connectivity).toBe('online');

    await controller.dispose();
  });

  it('should ignore EOSE cursors because durable queries own pull progress', async () => {
    const fixture = createEngineFixture(db);
    fixture.controller.link.pull.contiguousAppliedToken = tokenIn('durable-stream', 'durable-epoch', '4');

    expect(await openSubscription(fixture)).toBe(true);
    fixture.controller.markReplicationReady();
    await fixture.handlers[0]({ type: 'eose', cursor: tokenIn('event-stream', 'event-epoch', '20') });

    expect(fixture.resume.notCalled).toBe(true);
    expect(fixture.controller.link.pull.contiguousAppliedToken).toEqual(
      tokenIn('durable-stream', 'durable-epoch', '4'),
    );
    await fixture.controller.dispose();
  });

  it('should pause terminal subscription authorization failures', async () => {
    const fixture = createEngineFixture(db);
    expect(await openSubscription(fixture)).toBe(true);

    await fixture.handlers[0]({
      type  : 'error',
      error : { code: 'GrantAuthorizationGrantRevoked' },
    });

    expect(fixture.controller.link.status).toBe('paused');
    expect(fixture.repairing.notCalled).toBe(true);
    await fixture.controller.dispose();
  });

  it('should repair retryable subscription failures', async () => {
    const fixture = createEngineFixture(db);
    expect(await openSubscription(fixture)).toBe(true);
    await fixture.handlers[0]({
      type  : 'error',
      error : { code: 'SubscriptionRecoveryFailed' },
    });

    expect(fixture.repairing.calledOnceWithExactly(fixture.controller)).toBe(true);
    await fixture.controller.dispose();
  });

});
